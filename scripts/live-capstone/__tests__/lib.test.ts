import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LIVE_CAPSTONE_STEPS,
  assertNoSensitiveData,
  createLiveCapstonePlan,
  recordLiveCapstoneStep,
  verifyLiveCapstone,
} from '../lib.js';

const roots: string[] = [];
const COMMIT = 'a'.repeat(40);
const NOW = new Date('2026-07-17T12:00:00.000Z');
const CORRELATION = 'CAP-20260717-ABCDEF12';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-capstone-'));
  roots.push(root);
  return root;
}

function plan(root: string): void {
  createLiveCapstonePlan({
    workspaceRoot: root,
    testedCommit: COMMIT,
    correlationId: CORRELATION,
    credentialReference: 'keychain:openslack/test-provider',
    now: () => NOW,
  });
}

function recordAll(root: string, now = NOW): void {
  for (const platform of ['windows-x64', 'linux-x64'] as const) {
    for (const step of LIVE_CAPSTONE_STEPS) {
      recordLiveCapstoneStep({
        workspaceRoot: root,
        correlationId: CORRELATION,
        testedCommit: COMMIT,
        platform,
        step,
        status: 'PASS',
        evidenceRefs: [`run:${platform}/${step}`],
        now: () => now,
      });
    }
  }
}

describe('live capstone harness', () => {
  it('verifies a complete fresh dual-platform run', () => {
    const root = workspace();
    plan(root);
    recordAll(root);
    const result = verifyLiveCapstone({
      workspaceRoot: root,
      correlationId: CORRELATION,
      testedCommit: COMMIT,
      now: () => NOW,
    });
    expect(result.valid).toBe(true);
    expect(result.platforms).toEqual({
      'windows-x64': { complete: true, passed: true },
      'linux-x64': { complete: true, passed: true },
    });
    expect(result.runManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('locks every record to the tested commit', () => {
    const root = workspace();
    plan(root);
    expect(() =>
      recordLiveCapstoneStep({
        workspaceRoot: root,
        correlationId: CORRELATION,
        testedCommit: 'b'.repeat(40),
        platform: 'windows-x64',
        step: 'release_artifacts',
        status: 'PASS',
      }),
    ).toThrow(/immutable/);
  });

  it('does not remove a lock owned by another recorder', () => {
    const root = workspace();
    plan(root);
    const lock = join(root, '.openslack.local', 'capstone', CORRELATION, 'record.lock');
    writeFileSync(lock, 'other-recorder\n', { encoding: 'utf8', flag: 'wx' });

    expect(() =>
      recordLiveCapstoneStep({
        workspaceRoot: root,
        correlationId: CORRELATION,
        testedCommit: COMMIT,
        platform: 'windows-x64',
        step: 'release_artifacts',
        status: 'PASS',
      }),
    ).toThrow();
    expect(existsSync(lock)).toBe(true);
  });

  it('rejects raw secrets and credential URLs before persistence', () => {
    const root = workspace();
    plan(root);
    expect(() =>
      recordLiveCapstoneStep({
        workspaceRoot: root,
        correlationId: CORRELATION,
        testedCommit: COMMIT,
        platform: 'windows-x64',
        step: 'release_artifacts',
        status: 'PASS',
        evidenceRefs: ['run:Authorization'],
      }),
    ).toThrow(/redacted reference/);
    expect(() =>
      assertNoSensitiveData({ value: 'https://user:password@example.test/path' }),
    ).toThrow(/secret material/);
    expect(() =>
      createLiveCapstonePlan({
        workspaceRoot: workspace(),
        testedCommit: COMMIT,
        credentialReference: 'https://user:password@example.test',
      }),
    ).toThrow(/opaque credential reference/);
  });

  it('fails incomplete and failed platform evidence', () => {
    const root = workspace();
    plan(root);
    recordLiveCapstoneStep({
      workspaceRoot: root,
      correlationId: CORRELATION,
      testedCommit: COMMIT,
      platform: 'windows-x64',
      step: 'release_artifacts',
      status: 'FAIL',
      now: () => NOW,
    });
    const result = verifyLiveCapstone({
      workspaceRoot: root,
      correlationId: CORRELATION,
      testedCommit: COMMIT,
      now: () => NOW,
    });
    expect(result.valid).toBe(false);
    expect(result.failures).toContain('STEP_FAILED:windows-x64:release_artifacts');
    expect(result.failures).toContain('PLATFORM_MISSING:linux-x64');
  });

  it('rejects evidence older than thirty days', () => {
    const root = workspace();
    plan(root);
    recordAll(root);
    const result = verifyLiveCapstone({
      workspaceRoot: root,
      correlationId: CORRELATION,
      testedCommit: COMMIT,
      now: () => new Date('2026-08-17T12:00:01.000Z'),
    });
    expect(result.valid).toBe(false);
    expect(result.failures.some((failure) => failure.startsWith('STEP_STALE:'))).toBe(true);
  });

  it('stores only artifact hashes and redacted evidence references', () => {
    const root = workspace();
    plan(root);
    const artifact = join(root, 'signed.release-manifest.json');
    writeFileSync(artifact, '{"signed":true}\n', 'utf8');
    const run = recordLiveCapstoneStep({
      workspaceRoot: root,
      correlationId: CORRELATION,
      testedCommit: COMMIT,
      platform: 'windows-x64',
      step: 'release_artifacts',
      status: 'PASS',
      artifactPaths: [artifact],
      evidenceRefs: ['artifact:release/windows-x64'],
      now: () => NOW,
    });
    const result = run.runs['windows-x64']?.steps.release_artifacts;
    expect(result?.artifactHashes[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(run)).not.toContain(artifact);
    expect(JSON.stringify(run)).not.toContain('credential');
  });

  it('rejects unknown fields added to a persisted run manifest', () => {
    const root = workspace();
    plan(root);
    const path = join(root, '.openslack.local', 'capstone', CORRELATION, 'run.json');
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    value.rawProviderResponse = { safeLookingButNotAllowed: true };
    writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');

    expect(() =>
      verifyLiveCapstone({
        workspaceRoot: root,
        correlationId: CORRELATION,
        testedCommit: COMMIT,
        now: () => NOW,
      }),
    ).toThrow(/Unexpected capstone manifest field/);
  });
});
