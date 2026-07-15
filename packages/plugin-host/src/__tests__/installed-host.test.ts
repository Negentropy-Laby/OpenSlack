import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { HostPlanStep, HostPolicyPort, PluginAuditEvent } from '@openslack/plugin-api';

import { PluginHost, PluginHostError } from '../index.js';
import type { PluginManifestLoadError } from '../index.js';
import { serializePluginLock } from '../lock.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const policy: HostPolicyPort<HostPlanStep> = {
  authorizeActivation: () => ({
    outcome: 'deny',
    code: 'TEST_NOT_REACHED',
    reason: 'Registration tests do not authorize activation.',
    evidenceRefs: [],
  }),
  authorizeAction: () => ({
    outcome: 'deny',
    code: 'TEST_NOT_REACHED',
    reason: 'Registration tests do not authorize actions.',
    evidenceRefs: [],
  }),
  validatePlanStep: () => ({
    outcome: 'deny',
    code: 'TEST_NOT_REACHED',
    reason: 'Registration tests do not validate plans.',
    evidenceRefs: [],
  }),
  recordAuditEvent: (_event: PluginAuditEvent) => undefined,
};

function installedHost(): PluginHost {
  return new PluginHost({
    policy,
    binding: {
      compositionId: 'openslack.installed-test',
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
}

async function installedFixture(id: string, manifest: unknown) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'openslack-installed-host-workspace-'));
  const installedRoot = await mkdtemp(join(tmpdir(), 'openslack-installed-host-package-'));
  roots.push(workspaceRoot, installedRoot);
  const openslackRoot = join(workspaceRoot, '.openslack');
  await mkdir(openslackRoot, { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(installedRoot, 'plugin.json'), bytes);
  const sourceRef = `installed/${id}/plugin.json`;
  await writeFile(
    join(openslackRoot, 'plugins.lock'),
    serializePluginLock({
      schema: 'openslack.plugins_lock.v1',
      plugins: [
        {
          id,
          version: '1.0.0',
          providerKind: 'plugin',
          sourceRef,
          manifestSha256: createHash('sha256').update(bytes).digest('hex'),
          requestedGateMode: 'ENFORCE',
        },
      ],
    }),
  );
  return { workspaceRoot, installedRoot, sourceRef };
}

function manifest(id: string, contribution: unknown) {
  return {
    schema: 'openslack.plugin.v1',
    id,
    version: '1.0.0',
    name: `${id} fixture`,
    requires: { openslack: '>=0.1.0 <1.0.0' },
    gate: { mode: 'ENFORCE', gateId: 'host.read-only' },
    capabilities: ['host.actions.read'],
    contributes: [contribution],
  };
}

describe('installed manifest host boundary', () => {
  it('rejects an installed mutating alias without partial registration', async () => {
    const id = 'installed-mutator';
    const fixture = await installedFixture(
      id,
      manifest(id, {
        kind: 'action_alias',
        id: 'write',
        target: { kind: 'host_action', id: 'repository.write' },
      }),
    );
    const host = installedHost();

    await expect(host.loadInstalledPlugin({ ...fixture, pluginId: id })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PluginHostError &&
        error.findings.some((finding) => finding.code === 'PLUGIN_ALIAS_TARGET_UNSAFE'),
    );
    expect(host.snapshot()).toMatchObject({ registryRevision: 0, plugins: [], actionIds: [] });
  });

  it('rejects an installed PRMS evaluator before the validator or registry can grant authority', async () => {
    const id = 'installed-evaluator';
    const fixture = await installedFixture(
      id,
      manifest(id, {
        kind: 'prms_blocker',
        id: 'approve',
        evaluate: 'return PASS',
      }),
    );
    const host = installedHost();

    await expect(host.loadInstalledPlugin({ ...fixture, pluginId: id })).rejects.toMatchObject({
      code: 'PLUGIN_MANIFEST_HARD_POLICY_DENIED',
    } satisfies Partial<PluginManifestLoadError>);
    expect(host.snapshot()).toMatchObject({
      registryRevision: 0,
      plugins: [],
      prmsBlockerIds: [],
    });
  });
});
