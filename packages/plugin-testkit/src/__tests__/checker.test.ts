import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PLUGIN_DIAGNOSTIC_CODES,
  type HostPlanStep,
  type HostPolicyPort,
  type PluginAuditEvent,
} from '@openslack/plugin-api';
import { PluginHost, PluginHostError, serializePluginLock } from '@openslack/plugin-host';
import { afterEach, describe, expect, it } from 'vitest';

import { checkPlugin } from '../checker.js';
import { PLUGIN_CHECK_IDS } from '../checks.js';
import { renderPluginCheckPlain } from '../report.js';

const fixtures = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function options(workspaceRoot = fixtures) {
  return { workspaceRoot, openslackVersion: '0.1.1' } as const;
}

describe('plugin testkit', () => {
  it('reports the deterministic G1-G17 matrix and READY_TO_REGISTER for a valid fixture', async () => {
    const first = await checkPlugin(path.join(fixtures, 'valid'), options());
    const second = await checkPlugin(path.join(fixtures, 'valid'), options());

    expect(first.readiness).toBe('READY_TO_REGISTER');
    expect(first.checks.map((check) => check.id)).toEqual(PLUGIN_CHECK_IDS);
    expect(first.checks.find((check) => check.id === 'G17')?.state).toBe('SKIP');
    expect(first.authorizationNotice).toBe('HOST_REAUTHORIZATION_REQUIRED');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.parse(JSON.stringify(first))).toMatchObject({
      schema: 'openslack.plugin_check_report.v1',
      readiness: 'READY_TO_REGISTER',
    });
    expect(renderPluginCheckPlain(first)).toContain('Plugin check: READY_TO_REGISTER');
  });

  it.each([
    ['reserved-id', 'PLUGIN_MANIFEST_ID_RESERVED'],
    ['approval-capability', 'PLUGIN_MANIFEST_CAPABILITY_INVALID'],
    ['approve-action', 'PLUGIN_ALIAS_TARGET_FORBIDDEN'],
    ['direct-merge', 'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN'],
    ['risk-ceiling', 'PLUGIN_ALIAS_TARGET_FORBIDDEN'],
    ['executable-entry', 'PLUGIN_MANIFEST_EXECUTABLE_FIELD_FORBIDDEN'],
    ['version-mismatch', 'PLUGIN_HOST_VERSION_INCOMPATIBLE'],
  ])('blocks %s with stable code %s', async (fixture, code) => {
    const report = await checkPlugin(path.join(fixtures, fixture), options());
    expect(report.readiness).toBe('BLOCKED');
    expect(report.findings.map((finding) => finding.code)).toContain(code);
    expect(PLUGIN_DIAGNOSTIC_CODES).toContain(code);
  });

  it('rejects explicit traversal before reading a fixture outside the selected path', async () => {
    const report = await checkPlugin(
      `${path.join(fixtures, 'path-escape')}${path.sep}..${path.sep}valid`,
      options(),
    );
    expect(report.readiness).toBe('BLOCKED');
    expect(report.findings.map((finding) => finding.code)).toContain(
      'PLUGIN_MANIFEST_SOURCE_OUTSIDE_ROOT',
    );
    expect(report.checks.find((check) => check.id === 'G2')?.state).toBe('FAIL');
  });

  it('detects duplicate JSON keys with the same strict code used by the host', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'openslack-plugin-testkit-json-'));
    temporaryRoots.push(root);
    await writeFile(
      path.join(root, 'plugin.json'),
      '{"schema":"openslack.plugin.v1","id":"one","id":"two"}',
    );

    const report = await checkPlugin(root, options(root));
    expect(report.readiness).toBe('BLOCKED');
    expect(report.findings.map((finding) => finding.code)).toContain('STRICT_JSON_DUPLICATE_KEY');
    expect(report.checks.find((check) => check.id === 'G6')?.state).toBe('FAIL');
  });

  it.each([
    ['invalid UTF-8', Buffer.from([0xff]), 'STRICT_JSON_UTF8_INVALID', 'G5'],
    [
      'UTF-8 BOM',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]),
      'STRICT_JSON_BOM_FORBIDDEN',
      'G5',
    ],
  ])('rejects %s before manifest validation', async (_name, bytes, code, checkId) => {
    const root = await mkdtemp(path.join(tmpdir(), 'openslack-plugin-testkit-bytes-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'plugin.json'), bytes);

    const report = await checkPlugin(root, options(root));
    expect(report.readiness).toBe('BLOCKED');
    expect(report.findings.map((finding) => finding.code)).toContain(code);
    expect(report.checks.find((check) => check.id === checkId)?.state).toBe('FAIL');
  });

  it('rejects a manifest above the exact byte ceiling without parsing it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'openslack-plugin-testkit-large-'));
    temporaryRoots.push(root);
    await writeFile(path.join(root, 'plugin.json'), Buffer.alloc(256 * 1024 + 1, 0x20));

    const report = await checkPlugin(root, options(root));
    expect(report.findings.map((finding) => finding.code)).toEqual([
      'PLUGIN_MANIFEST_SIZE_EXCEEDED',
    ]);
    expect(report.checks.find((check) => check.id === 'G4')?.state).toBe('FAIL');
    expect(report.checks.find((check) => check.id === 'G5')?.state).toBe('SKIP');
  });

  it('verifies exact workspace bytes against the canonical lock and rejects mismatch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'openslack-plugin-testkit-lock-'));
    temporaryRoots.push(root);
    const pluginRoot = path.join(root, '.openslack', 'plugins', 'fixture');
    await mkdir(pluginRoot, { recursive: true });
    const bytes = await readFile(path.join(fixtures, 'valid', 'plugin.json'));
    await writeFile(path.join(pluginRoot, 'plugin.json'), bytes);
    const lockPath = path.join(root, '.openslack', 'plugins.lock');
    const entry = {
      id: 'fixture',
      version: '1.0.0',
      providerKind: 'workspace',
      sourceRef: '.openslack/plugins/fixture/plugin.json',
      manifestSha256: '0'.repeat(64),
      requestedGateMode: 'SHADOW',
    } as const;
    await writeFile(
      lockPath,
      `${JSON.stringify({ schema: 'openslack.plugins_lock.v1', plugins: [entry] }, null, 2)}\n`,
    );

    const mismatch = await checkPlugin(pluginRoot, {
      ...options(root),
      verifyIntegrity: true,
    });
    expect(mismatch.readiness).toBe('BLOCKED');
    expect(mismatch.findings.map((finding) => finding.code)).toContain(
      'PLUGIN_HOST_LOCK_HASH_MISMATCH',
    );

    await writeFile(
      lockPath,
      `${JSON.stringify(
        {
          schema: 'openslack.plugins_lock.v1',
          plugins: [
            {
              ...entry,
              manifestSha256: createHash('sha256').update(bytes).digest('hex'),
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    const verified = await checkPlugin(pluginRoot, {
      ...options(root),
      verifyIntegrity: true,
    });
    expect(verified.readiness).toBe('READY_TO_REGISTER');
    expect(verified.integrityVerified).toBe(true);
    expect(verified.checks.find((check) => check.id === 'G17')?.state).toBe('PASS');
  });
});

const hostPolicy: HostPolicyPort<HostPlanStep> = {
  authorizeActivation: () => ({
    outcome: 'deny',
    code: 'TEST_NOT_REACHED',
    reason: 'Test does not activate plugins.',
    evidenceRefs: [],
  }),
  authorizeAction: () => ({
    outcome: 'deny',
    code: 'TEST_NOT_REACHED',
    reason: 'Test does not execute actions.',
    evidenceRefs: [],
  }),
  validatePlanStep: () => ({
    outcome: 'deny',
    code: 'TEST_NOT_REACHED',
    reason: 'Test does not validate plans.',
    evidenceRefs: [],
  }),
  recordAuditEvent: (_event: PluginAuditEvent) => undefined,
};

describe('Red host remains the authorization boundary', () => {
  it('rejects a mutating installed alias even if an authoring tool claims readiness', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'openslack-testkit-host-workspace-'));
    const installedRoot = await mkdtemp(path.join(tmpdir(), 'openslack-testkit-host-installed-'));
    temporaryRoots.push(workspaceRoot, installedRoot);
    await mkdir(path.join(workspaceRoot, '.openslack'), { recursive: true });
    const manifest = {
      schema: 'openslack.plugin.v1',
      id: 'installed-mutator',
      version: '1.0.0',
      name: 'Installed mutator',
      requires: { openslack: '>=0.1.0 <1.0.0' },
      gate: { mode: 'ENFORCE', gateId: 'host.read-only' },
      capabilities: ['host.actions.read'],
      contributes: [
        {
          kind: 'action_alias',
          id: 'write',
          target: { kind: 'host_action', id: 'repository.write' },
        },
      ],
    };
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(path.join(installedRoot, 'plugin.json'), bytes);
    await writeFile(
      path.join(workspaceRoot, '.openslack', 'plugins.lock'),
      serializePluginLock({
        schema: 'openslack.plugins_lock.v1',
        plugins: [
          {
            id: 'installed-mutator',
            version: '1.0.0',
            providerKind: 'plugin',
            sourceRef: 'installed/installed-mutator/plugin.json',
            manifestSha256: createHash('sha256').update(bytes).digest('hex'),
            requestedGateMode: 'ENFORCE',
          },
        ],
      }),
    );
    const forgedAuthoringResult = { readiness: 'READY_TO_REGISTER' } as const;
    expect(forgedAuthoringResult.readiness).toBe('READY_TO_REGISTER');

    const host = new PluginHost({
      policy: hostPolicy,
      binding: {
        compositionId: 'openslack.testkit-host-proof',
        openslackVersion: '0.1.1',
        gateIds: ['host.read-only'],
        targets: {
          actions: [
            {
              kind: 'host_action',
              id: 'repository.write',
              exists: true,
              declarativeAliasAllowed: false,
              sideEffects: true,
              risk: 'high',
              confirmationRequired: true,
              exposesSecrets: false,
              exposesCredentials: false,
              exposesPaths: true,
              inputSchema: {},
              requiredCapability: 'github.issues.write',
            },
          ],
        },
      },
    });

    await expect(
      host.loadInstalledPlugin({
        workspaceRoot,
        installedRoot,
        pluginId: 'installed-mutator',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PluginHostError &&
        error.findings.some((finding) => finding.code === 'PLUGIN_ALIAS_TARGET_UNSAFE'),
    );
    expect(host.snapshot()).toMatchObject({ registryRevision: 0, plugins: [] });
  });
});
