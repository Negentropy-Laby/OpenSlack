import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLEANUP_TARGET_UPGRADE_GATES,
  CLEANUP_TARGET_UPGRADE_PLAN_SCHEMA,
  CleanupTargetUpgradeError,
  prepareCleanupTargetUpgradePlan,
  type PrepareCleanupTargetUpgradePlanInput,
} from '../cleanup-target-upgrade.js';
import type { CleanupHandoffTargetEvidence } from '../cleanup-handoff.js';

const roots: string[] = [];
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const HEAD = 'a'.repeat(40);

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'cleanup-upgrade-'));
  roots.push(path);
  return path;
}

function write(path: string, bytes: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/**
 * A minimal package directory. It carries only the artifact digests the plan
 * reads, so it deliberately does not satisfy full package verification — which
 * lets the tests assert the plan reports that gate instead of throwing.
 */
function packageDirectory(files: Record<string, string>): { path: string; manifestSHA256: string } {
  const path = root();
  const sums = Object.entries(files)
    .map(([name, bytes]) => `${digest(bytes)}  ./artifacts/${name}`)
    .join('\n');
  const text = `${sums}\n`;
  writeFileSync(join(path, 'SHA256SUMS'), text);
  for (const [name, bytes] of Object.entries(files)) {
    write(join(path, 'artifacts', name), bytes);
  }
  return { path, manifestSHA256: digest(text) };
}

function installationManifest(
  entries: Array<{ path: string; sha256?: string | null }>,
): string {
  const path = join(root(), 'install-manifest.json');
  writeFileSync(
    path,
    JSON.stringify({
      schema: 'openslack.cleanup_installation.v1',
      network: { httpsProxy: '', noProxy: '' },
      files: entries.map((entry) => ({
        path: entry.path,
        ...(entry.sha256 === null ? {} : { sha256: entry.sha256 ?? 'f'.repeat(64) }),
      })),
    }),
  );
  return path;
}

function evidence(installationManifestPath: string): CleanupHandoffTargetEvidence {
  const dir = root();
  const put = (name: string) => write(join(dir, name), '{}\n');
  return {
    installationManifestPath,
    taskViewPath: put('task-view.json'),
    taskAttestationPath: put('task-attestation.json'),
    appScopePath: put('app-scope.json'),
    networkPath: put('network.json'),
    identityPath: put('identity.json'),
    dependencyInventoryPath: put('dependency-inventory.json'),
  };
}

function plan(overrides: Partial<PrepareCleanupTargetUpgradePlanInput> = {}) {
  const pkg = packageDirectory({ node: 'candidate node', 'executor.mjs': 'candidate executor' });
  const base: PrepareCleanupTargetUpgradePlanInput = {
    packageDirectory: pkg.path,
    candidateHead: HEAD,
    manifestSHA256: pkg.manifestSHA256,
    targetEvidence: evidence(
      installationManifest([
        { path: '/usr/lib/openslack-cleanup/node', sha256: digest('candidate node') },
        { path: '/usr/lib/openslack-cleanup/executor.mjs', sha256: digest('old executor') },
      ]),
    ),
    now: new Date('2026-09-21T00:00:00.000Z'),
  };
  return prepareCleanupTargetUpgradePlan({ ...base, ...overrides });
}

describe('cleanup target upgrade plan', () => {
  it('classifies installed files against the candidate artifacts', () => {
    const result = plan();
    const byArtifact = new Map(result.files.map((file) => [file.artifact, file.action]));

    // node already matches the candidate; executor.mjs differs and must be replaced.
    expect(byArtifact.get('node')).toBe('current');
    expect(byArtifact.get('executor.mjs')).toBe('replace');
    expect(result.schema).toBe(CLEANUP_TARGET_UPGRADE_PLAN_SCHEMA);
    expect(result.createdAt).toBe('2026-09-21T00:00:00.000Z');
  });

  it('classifies an installed file with no recorded digest as install', () => {
    const result = plan({
      targetEvidence: evidence(
        installationManifest([{ path: '/usr/lib/openslack-cleanup/node', sha256: null }]),
      ),
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.action).toBe('install');
    expect(result.files[0]!.installedSHA256).toBeNull();
  });

  it('reports the package gate instead of throwing when the package is unverified', () => {
    const result = plan();
    expect(result.packageVerified).toBe(false);
    expect(result.packageErrors.length).toBeGreaterThan(0);
    expect(result.unmetGates).toContain(CLEANUP_TARGET_UPGRADE_GATES.packageUnverified);
  });

  it('never claims to install, deploy or authorize', () => {
    const result = plan();
    expect(result.installationPerformed).toBe(false);
    expect(result.deploymentAuthorized).toBe(false);
    expect(result.executionAuthorized).toBe(false);
    expect(result.directHumanDeletionAvailable).toBe(false);
  });

  it('always leaves approval, targets, authority and activation outstanding', () => {
    const result = plan();
    expect(result.unmetGates).toEqual(
      expect.arrayContaining([
        CLEANUP_TARGET_UPGRADE_GATES.adminApproval,
        CLEANUP_TARGET_UPGRADE_GATES.qualificationTargets,
        CLEANUP_TARGET_UPGRADE_GATES.governanceAuthority,
        CLEANUP_TARGET_UPGRADE_GATES.brokerActivation,
      ]),
    );
  });

  it('names the administrator as the actor of every step', () => {
    const result = plan();
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.steps.every((step) => step.actor === 'administrator')).toBe(true);
    expect(result.administratorCommands).toEqual(result.steps.flatMap((s) => s.commands));
  });

  it('does not modify the installation it plans for', () => {
    const pkg = packageDirectory({ node: 'candidate node' });
    const manifestPath = installationManifest([
      { path: '/usr/lib/openslack-cleanup/node', sha256: digest('installed node') },
    ]);
    const before = readFileSync(manifestPath, 'utf8');

    prepareCleanupTargetUpgradePlan({
      packageDirectory: pkg.path,
      candidateHead: HEAD,
      manifestSHA256: pkg.manifestSHA256,
      targetEvidence: evidence(manifestPath),
      now: new Date('2026-09-21T00:00:00.000Z'),
    });

    expect(readFileSync(manifestPath, 'utf8')).toBe(before);
  });

  it('reports a missing installation manifest as a gate', () => {
    const pkg = packageDirectory({ node: 'candidate node' });
    const result = plan({
      packageDirectory: pkg.path,
      manifestSHA256: pkg.manifestSHA256,
      targetEvidence: evidence(join(root(), 'absent.json')),
    });
    expect(result.unmetGates).toContain(CLEANUP_TARGET_UPGRADE_GATES.installationMissing);
  });

  it('reports incomplete target evidence as a gate', () => {
    const pkg = packageDirectory({ node: 'candidate node' });
    const present = evidence(installationManifest([]));
    const result = plan({
      packageDirectory: pkg.path,
      manifestSHA256: pkg.manifestSHA256,
      targetEvidence: { ...present, networkPath: join(root(), 'absent-network.json') },
    });
    expect(result.unmetGates).toContain(CLEANUP_TARGET_UPGRADE_GATES.evidenceIncomplete);
  });

  it.each([
    { candidateHead: 'short' },
    { manifestSHA256: 'nothex' },
  ])('rejects invalid bindings %o', (patch) => {
    expect(() => plan(patch)).toThrowError(CleanupTargetUpgradeError);
  });

  it.each([
    { packageDirectory: '/tmp/root/secrets/pkg' },
    { packageDirectory: '/tmp/root/private.pem' },
  ])('rejects a sensitive package path %o', (patch) => {
    expect(() => plan(patch)).toThrowError(
      expect.objectContaining({ code: 'UPGRADE_PATH_SENSITIVE' }) as unknown as Error,
    );
  });

  it('rejects a sensitive evidence path', () => {
    const pkg = packageDirectory({ node: 'candidate node' });
    const present = evidence(installationManifest([]));
    expect(() =>
      plan({
        packageDirectory: pkg.path,
        manifestSHA256: pkg.manifestSHA256,
        targetEvidence: { ...present, identityPath: '/tmp/root/credentials/identity.json' },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'UPGRADE_PATH_SENSITIVE' }) as unknown as Error,
    );
  });

  it('rejects a relative package path', () => {
    expect(() => plan({ packageDirectory: 'relative/pkg' })).toThrowError(
      expect.objectContaining({ code: 'UPGRADE_INPUT_INVALID' }) as unknown as Error,
    );
  });
});
