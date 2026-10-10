import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLEANUP_HANDOFF_PROFILES } from '../cleanup-handoff.js';

/**
 * Source invariants for the shipped Broker-only client.
 *
 * These assert properties the package contract depends on and that a future
 * edit could silently break: the client must go through the governed broker,
 * and it must not carry the human direct-deletion fallback that the repository
 * CLI path has.
 */
const REPO = join(__dirname, '..', '..', '..', '..');
const CLIENT = join(REPO, 'scripts', 'cleanup-broker', 'client.ts');
const source = readFileSync(CLIENT, 'utf8');

describe('broker-only client source invariants', () => {
  it('reuses the production broker command path', () => {
    expect(source).toContain("from '../../packages/pr/src/cleanup-broker-client.js'");
    expect(source).toContain('sendCleanupBrokerRequest');
    expect(source).toContain('readCleanupOperationRecord');
  });

  it('does not import or reference the direct branch-deletion path', () => {
    // cleanup-branch.ts is where the human-cli direct deletion lives; the
    // shipped client must never reach it.
    expect(source).not.toContain('cleanup-branch.js');
    expect(source).not.toContain('cleanupPRBranch');
    expect(source).not.toContain('deleteRemoteBranch');
    expect(source).not.toContain('deleteRemoteBranchIfAt');
  });

  it('does not shell out to Git or spawn a deletion of its own', () => {
    expect(source).not.toContain('node:child_process');
    expect(source).not.toContain('execFile');
    expect(source).not.toContain('spawn');
    expect(source).not.toContain('simple-git');
  });

  it('publishes the query record before sending an execute', () => {
    // R18-05: the record must exist before the request leaves, through the same
    // authorized durable path the CLI uses. Scoped to the execute path, because
    // the record status branch legitimately sends earlier in the file.
    const executeAt = source.indexOf("if (mode === 'execute')");
    expect(executeAt).toBeGreaterThan(-1);
    const publishAt = source.indexOf('saveCleanupOperationRecord(', executeAt);
    const sendAt = source.indexOf('await sendCleanupBrokerRequest(', executeAt);
    expect(publishAt).toBeGreaterThan(executeAt);
    expect(sendAt).toBeGreaterThan(publishAt);
    expect(source).toContain('buildCleanupOperationRecord');
  });

  it('resolves identity from an explicit workspace and never bootstraps one', () => {
    expect(source).toContain("'--workspace'");
    expect(source).toContain('resolveAgentPrincipal');
    // The fixed identity is the only source; claims are checked, not trusted.
    expect(source).toContain('does not match the fixed workspace identity');
    expect(source).not.toContain('hireAgent');
    expect(source).not.toContain('createRuntimeIdentity');
  });

  it('imports only the identity resolver from runtime, not the whole surface', () => {
    // Keeps the bundle free of process execution: the narrowed import was
    // measured to produce a bundle with zero child_process references.
    expect(source).toContain("packages/runtime/src/identity.js");
    expect(source).not.toContain("packages/runtime/src/index.js");
  });

  it('shares the production result evaluator rather than a private exit-code table', () => {
    // R18-06: both entries must agree on accepted-but-running = 0 and
    // refused/failed/unknown/reconciliation = 1.
    expect(source).toContain('evaluateCleanupBrokerResult');
    expect(source).not.toContain('OPERATION_IN_PROGRESS');
  });

  it('refuses to use a published record in place of identity authorization', () => {
    // The record is evidence of a past request, so it is readable only in
    // status mode and can never admit a preview or execute.
    expect(source).toContain("if (mode !== 'status') usage('--operation-record is only valid with --mode status')");
  });
});

describe('administrator upgrade tooling source invariants', () => {
  const adminSource = readFileSync(join(REPO, 'scripts', 'cleanup-broker', 'admin-upgrade.ts'), 'utf8');

  it('reuses the production upgrade-plan path', () => {
    expect(adminSource).toContain("from '../../packages/pr/src/cleanup-target-upgrade.js'");
    expect(adminSource).toContain('prepareCleanupTargetUpgradePlan');
  });

  it('installs nothing: it writes no file and starts no process', () => {
    // Planning must be side-effect free; the administrator performs the steps.
    for (const forbidden of [
      'writeFileSync',
      'mkdirSync',
      'cpSync',
      'renameSync',
      'rmSync',
      'node:child_process',
      'execFile',
      'spawn',
      'execSync',
    ]) {
      expect(adminSource).not.toContain(forbidden);
    }
  });

  it('does not reach the direct branch-deletion path either', () => {
    expect(adminSource).not.toContain('cleanup-branch.js');
    expect(adminSource).not.toContain('cleanupPRBranch');
    expect(adminSource).not.toContain('deleteRemoteBranch');
  });
});

describe('artifact profiles', () => {
  it('keeps the original profile intact and extends it in v2', () => {
    const v1 = [...CLEANUP_HANDOFF_PROFILES.v1];
    const v2 = [...CLEANUP_HANDOFF_PROFILES.v2];

    // v1 is unchanged, so a package built before v2 existed still verifies.
    expect(v1).toContain('tools/verify-handoff.mjs');
    expect(v1).toContain('artifacts/cleanup-broker');
    expect(v1).not.toContain('tools/cleanup-client.mjs');

    // v2 is a strict superset: no v1 path was removed or renamed.
    for (const path of v1) expect(v2).toContain(path);
    expect(v2).toContain('tools/cleanup-client.mjs');
    expect(v2).toContain('tools/admin-upgrade.mjs');
    expect(v2).toContain('docs/client.md');
    expect(v2.length).toBeGreaterThan(v1.length);
  });

  it('declares each profile in a deterministic sorted order', () => {
    for (const profile of [CLEANUP_HANDOFF_PROFILES.v1, CLEANUP_HANDOFF_PROFILES.v2]) {
      expect([...profile]).toEqual([...profile].sort());
      expect(new Set(profile).size).toBe(profile.length);
    }
  });
});
