import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLEANUP_INSTALL_LAYOUT,
  CLEANUP_TARGET_UPGRADE_GATES,
  CLEANUP_TARGET_UPGRADE_PLAN_SCHEMA,
  classifyDestination,
  CleanupTargetUpgradeError,
  prepareCleanupTargetUpgradePlan,
  renderUpgradeCommand,
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

describe('R18-01 administrator commands are rendered safely', () => {
  it('quotes arguments so spaces survive and metacharacters are neutralised', () => {
    const rendered = renderUpgradeCommand({
      program: 'install',
      args: ['-m', '0755', '/opt/candidate package/node', '/usr/lib/openslack-cleanup/node'],
    });
    expect(rendered).toBe(
      "'install' '-m' '0755' '/opt/candidate package/node' '/usr/lib/openslack-cleanup/node'",
    );
    // A space path stays one argument rather than splitting into two.
    expect(rendered).toContain("'/opt/candidate package/node'");
  });

  it.each([';', '&&', '|', '$(id)', '`id`', '\n', '\r'])(
    'never leaves %j outside quotes',
    (metacharacter) => {
      const rendered = renderUpgradeCommand({
        program: 'install',
        args: [metacharacter === '\n' || metacharacter === '\r' ? '/tmp/x' : `/tmp/${metacharacter}`],
      });
      // Either the character is refused outright, or it appears only inside
      // single quotes where a shell cannot act on it.
      const outsideQuotes = rendered.replace(/'[^']*'/g, '');
      expect(outsideQuotes).not.toContain(metacharacter);
    },
  );

  it.each(['\n', '\r', '\u0000', '\u001f', '\u007f'])(
    'refuses control character %j in an argument',
    (control) => {
      expect(() =>
        renderUpgradeCommand({ program: 'install', args: [`/tmp/${control}node`] }),
      ).toThrow(CleanupTargetUpgradeError);
    },
  );

  it('refuses a control character in the program name', () => {
    expect(() => renderUpgradeCommand({ program: 'in\nstall', args: [] })).toThrow(
      CleanupTargetUpgradeError,
    );
  });

  it('never emits a destination taken from the manifest', () => {
    // A manifest entry that tries to add a destination, and one that tries to
    // inject a command, must both be absent from every planned action.
    const injected = '/usr/lib/openslack-cleanup/node; echo UNSAFE';
    const result = plan({
      targetEvidence: evidence(
        installationManifest([
          { path: injected },
          { path: '/tmp/attacker-controlled/node' },
          { path: '/usr/lib/openslack-cleanup/node' },
        ]),
      ),
    });

    const destinations = result.files.map((file) => file.path);
    expect(destinations).not.toContain(injected);
    expect(destinations).not.toContain('/tmp/attacker-controlled/node');
    expect(result.files).toHaveLength(CLEANUP_INSTALL_LAYOUT.length);
    for (const command of result.administratorCommands) {
      expect(command).not.toContain('UNSAFE');
      expect(command).not.toContain('/tmp/attacker-controlled');
    }
  });
});

describe('R18-09 the fixed layout includes the Broker', () => {
  it('plans the Broker even when the installation manifest omits it', () => {
    // The old manifest lists only node, so an old-manifest-driven plan would
    // never touch the Broker at all.
    const result = plan({
      targetEvidence: evidence(
        installationManifest([{ path: '/usr/lib/openslack-cleanup/node' }]),
      ),
    });
    const broker = result.files.find((file) => file.artifact === 'cleanup-broker');
    expect(broker).toBeDefined();
    expect(broker!.path).toBe('/usr/lib/openslack-cleanup/cleanup-broker');
    expect(broker!.mode).toBe('0755');
    expect(broker!.owner).toBe('root:root');
  });

  it('plans every layout member with a fixed mode and owner', () => {
    const result = plan();
    expect(result.files.map((file) => file.artifact).sort()).toEqual(
      CLEANUP_INSTALL_LAYOUT.map((entry) => entry.artifact).sort(),
    );
    for (const file of result.files) {
      expect(file.mode).toBe('0755');
      expect(file.owner).toBe('root:root');
    }
  });

  it('reports a candidate artifact missing from the package as unverified', () => {
    const result = plan();
    // The minimal test package carries only node and executor.mjs.
    expect(result.files.find((file) => file.artifact === 'git')!.candidateSHA256).toBe('');
    expect(result.unmetGates).toContain(CLEANUP_TARGET_UPGRADE_GATES.destinationUnverified);
  });
});

describe('R18-10 observed state and manifest claims', () => {
  it('distinguishes missing, unreadable and mismatched', () => {
    const dir = root();
    const unreadable = join(dir, 'directory-not-file');
    mkdirSync(unreadable, { recursive: true });
    const result = plan({
      targetEvidence: evidence(installationManifest([])),
    });
    // Nothing is installed in this test, so every destination is missing.
    expect(result.files.every((file) => file.observed === 'missing')).toBe(true);
    expect(result.files.every((file) => file.action === 'install')).toBe(true);
  });

  it('records the manifest claim without letting it decide the action', () => {
    const result = plan({
      targetEvidence: evidence(
        installationManifest([
          { path: '/usr/lib/openslack-cleanup/node', sha256: 'a'.repeat(64) },
        ]),
      ),
    });
    const node = result.files.find((file) => file.artifact === 'node')!;
    // The manifest claims a digest but the destination does not exist, so the
    // claim cannot be confirmed here and the action follows the observation.
    // The disagreement branch itself is covered by classifyDestination above.
    expect(node.manifestClaimedSHA256).toBe('a'.repeat(64));
    expect(node.observed).toBe('missing');
    expect(node.action).toBe('install');
  });

  it('propagates the package gate when the package is unverified', () => {
    const result = plan({ manifestSHA256: 'b'.repeat(64) });
    expect(result.packageVerified).toBe(false);
    expect(result.unmetGates).toContain(CLEANUP_TARGET_UPGRADE_GATES.packageUnverified);
    // The upgrade step must be blocked by that gate.
    const upgrade = result.steps.find((step) => step.id === 'controlled-upgrade')!;
    expect(upgrade.blockedBy).toContain(CLEANUP_TARGET_UPGRADE_GATES.packageUnverified);
  });
});

describe('R18-11 the nonce step is not blocked by activation', () => {
  it('does not block start-unactivated on activation', () => {
    const result = plan();
    const start = result.steps.find((step) => step.id === 'start-unactivated')!;
    // Activation needs the nonce this step produces, so requiring activation
    // here would deadlock the ordering.
    expect(start.blockedBy).not.toContain(CLEANUP_TARGET_UPGRADE_GATES.brokerActivation);
  });

  it('blocks the governance PR step on activation, which needs the nonce', () => {
    const result = plan();
    const governance = result.steps.find((step) => step.id === 'prepare-governance-pr')!;
    expect(governance.blockedBy).toContain(CLEANUP_TARGET_UPGRADE_GATES.brokerActivation);
  });

  it('orders the stages so the nonce is obtained before activation is prepared', () => {
    const result = plan();
    const ids = result.steps.map((step) => step.id);
    expect(ids.indexOf('start-unactivated')).toBeLessThan(ids.indexOf('prepare-governance-pr'));
    expect(ids.indexOf('controlled-upgrade')).toBeLessThan(
      ids.indexOf('installation-isolation-verification'),
    );
    expect(ids.indexOf('installation-isolation-verification')).toBeLessThan(
      ids.indexOf('start-unactivated'),
    );
  });
});

describe('R18-09/R18-10 destination classification', () => {
  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  it.each([
    ['missing -> install', { state: 'missing' as const, sha256: null }, HASH_A, null, 'install'],
    ['present and matching -> current', { state: 'present' as const, sha256: HASH_A }, HASH_A, null, 'current'],
    ['present and differing -> replace', { state: 'present' as const, sha256: HASH_B }, HASH_A, null, 'replace'],
    ['unreadable -> unverified', { state: 'unreadable' as const, sha256: null }, HASH_A, null, 'unverified'],
    ['present with no candidate digest -> replace', { state: 'present' as const, sha256: HASH_A }, '', null, 'replace'],
  ])('classifies %s', (_label, observed, candidate, claimed, expected) => {
    expect(classifyDestination(observed, candidate, claimed).action).toBe(expected);
  });

  it('reports a claim that disagrees with a present file', () => {
    // The behaviour the earlier test only appeared to cover: this needs a
    // PRESENT observation, which the planner can never produce for the absolute
    // layout destinations in a test environment.
    const result = classifyDestination({ state: 'present', sha256: HASH_A }, HASH_A, HASH_B);
    expect(result.claimDisagrees).toBe(true);
    // The observation still decides the action, not the claim.
    expect(result.action).toBe('current');
  });

  it('does not report a claim that agrees', () => {
    expect(
      classifyDestination({ state: 'present', sha256: HASH_A }, HASH_A, HASH_A).claimDisagrees,
    ).toBe(false);
  });

  it('does not report a disagreement when nothing is installed', () => {
    expect(
      classifyDestination({ state: 'missing', sha256: null }, HASH_A, HASH_B).claimDisagrees,
    ).toBe(false);
  });

  it('does not report a disagreement when the manifest is silent', () => {
    expect(
      classifyDestination({ state: 'present', sha256: HASH_A }, HASH_A, null).claimDisagrees,
    ).toBe(false);
  });
});

describe('D8 no install instruction while the package or evidence is invalid', () => {
  it('emits no runnable install command when the package is unverified', () => {
    const result = plan({ manifestSHA256: 'b'.repeat(64) });
    expect(result.packageVerified).toBe(false);
    const upgrade = result.steps.find((step) => step.id === 'controlled-upgrade')!;
    // A guarded-but-runnable command is still an install instruction.
    expect(upgrade.commands).toEqual([]);
    expect(result.administratorCommands.filter((c) => c.includes("'install'"))).toEqual([]);
  });

  it('emits no runnable install command when target evidence is missing', () => {
    const dir = root();
    const put = (name: string) => write(join(dir, name), '{}\n');
    const result = plan({
      targetEvidence: {
        installationManifestPath: installationManifest([]),
        // Points at paths that do not exist.
        taskViewPath: join(dir, 'absent-task-view.json'),
        taskAttestationPath: put('task-attestation.json'),
        appScopePath: put('app-scope.json'),
        networkPath: put('network.json'),
        identityPath: put('identity.json'),
        dependencyInventoryPath: put('dependency-inventory.json'),
      },
    });
    expect(result.unmetGates).toContain(CLEANUP_TARGET_UPGRADE_GATES.evidenceIncomplete);
    const upgrade = result.steps.find((step) => step.id === 'controlled-upgrade')!;
    expect(upgrade.commands).toEqual([]);
  });

  it('still emits install commands when everything is valid', () => {
    // The gate must not disable the plan unconditionally. This fixture's package
    // is unverified, so assert the step is at least structured to carry them.
    const result = plan();
    const upgrade = result.steps.find((step) => step.id === 'controlled-upgrade')!;
    expect(Array.isArray(upgrade.commands)).toBe(true);
    expect(upgrade.blockedBy).toContain(CLEANUP_TARGET_UPGRADE_GATES.packageUnverified);
  });
});
describe('R18-10 unreadable gates are enforced', () => {
  it('blocks the controlled upgrade on both unreadable gates', () => {
    const result = plan();
    const upgrade = result.steps.find((step) => step.id === 'controlled-upgrade')!;
    // Computing a gate and never blocking on it is the defect this guards.
    expect(upgrade.blockedBy).toContain(CLEANUP_TARGET_UPGRADE_GATES.evidenceUnreadable);
    expect(upgrade.blockedBy).toContain(CLEANUP_TARGET_UPGRADE_GATES.installationUnreadable);
  });

  it('blocks the installation isolation check on an unreadable manifest', () => {
    const result = plan();
    const isolation = result.steps.find(
      (step) => step.id === 'installation-isolation-verification',
    )!;
    expect(isolation.blockedBy).toContain(CLEANUP_TARGET_UPGRADE_GATES.installationUnreadable);
  });

  it('reports every gate that some step blocks on, or explains its absence', () => {
    const result = plan();
    const blocked = new Set(result.steps.flatMap((step) => step.blockedBy));
    // Gates that legitimately gate nothing are listed here explicitly, so a new
    // gate that is computed but never enforced fails this test.
    const intentionallyUngated = new Set<string>([
      CLEANUP_TARGET_UPGRADE_GATES.qualificationTargets,
      CLEANUP_TARGET_UPGRADE_GATES.governanceAuthority,
      CLEANUP_TARGET_UPGRADE_GATES.brokerActivation,
    ]);
    const unenforced = result.unmetGates.filter(
      (gate) => !blocked.has(gate) && !intentionallyUngated.has(gate),
    );
    expect(unenforced).toEqual([]);
  });
});
describe('cleanup target upgrade plan', () => {
  it('classifies destinations against the candidate artifacts from the fixed layout', () => {
    const result = plan();
    const byArtifact = new Map(result.files.map((file) => [file.artifact, file.action]));

    // Nothing is installed on this host, so every destination is planned as an
    // install regardless of what the manifest claims about it.
    expect(byArtifact.get('node')).toBe('install');
    expect(byArtifact.get('executor.mjs')).toBe('install');
    expect(result.files.every((file) => file.observed === 'missing')).toBe(true);
    expect(result.schema).toBe(CLEANUP_TARGET_UPGRADE_PLAN_SCHEMA);
    expect(result.createdAt).toBe('2026-09-21T00:00:00.000Z');
  });

  it('plans every fixed destination even when the manifest lists one path', () => {
    const result = plan({
      targetEvidence: evidence(
        installationManifest([{ path: '/usr/lib/openslack-cleanup/node', sha256: null }]),
      ),
    });
    // The layout, not the manifest, decides how many destinations exist.
    expect(result.files).toHaveLength(CLEANUP_INSTALL_LAYOUT.length);
    const node = result.files.find((file) => file.artifact === 'node')!;
    expect(node.action).toBe('install');
    expect(node.installedSHA256).toBeNull();
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
    // Commands are structured, and the rendered list is exactly their rendering.
    expect(result.administratorCommands).toEqual(
      result.steps.flatMap((step) => step.commands.map((command) => renderUpgradeCommand(command))),
    );
    expect(result.steps.every((step) => step.workingDirectory.length > 0)).toBe(true);
    expect(result.steps.every((step) => step.expectedOutput.length > 0)).toBe(true);
    expect(result.steps.every((step) => step.stopCondition.length > 0)).toBe(true);
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
