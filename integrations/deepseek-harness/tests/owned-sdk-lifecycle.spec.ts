import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { prepareSdkFixture } from './fixtures/sdk-profile.ts';

describe('actual unmodified SDK cleanup never creates another executor', () => {
  it.each([['before-start', 0], ['initialize-failed', 1], ['close-during-start', 1]] as const)('%s has exactly %i actual SDK spawns', (mode, expected) => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-sdk-no-replay-'));
    onTestFinished(({ task }) => { if (task.result?.state === 'pass') rmSync(root, { recursive: true, force: true }); });
    const fixture = prepareSdkFixture(root, []);
    const output = execFileSync(process.execPath, [fileURLToPath(new URL('./fixtures/owned-sdk-lifecycle.mjs', import.meta.url)),
      fixture.repository, fixture.home, fixture.workspace, fixture.patch, mode],
    { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 20_000 });
    const result = JSON.parse(output);
    expect(result).toMatchObject({ spawnCount: expected, rejected: true,
      receipt: { shutdownAcknowledged: false, resourcesStopped: false } });
    if (expected) {
      expect(result.receipt.pid).toBeGreaterThan(0);
      expect(result.receipt.code !== null || result.receipt.signal !== null).toBe(true);
    } else expect(result.receipt.pid).toBe(-1);
    expect(existsSync(join(root, 'requests.jsonl'))).toBe(false);
    expect(existsSync(join(fixture.workspace, 'unapproved.txt'))).toBe(false);
  });
  it('rejects the first prompt after real SDK initialize crosses the known lease, while still proving clean SDK cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-sdk-lease-after-initialize-'));
    onTestFinished(({ task }) => { if (task.result?.state === 'pass') rmSync(root, { recursive: true, force: true }); });
    const fixture = prepareSdkFixture(root, []);
    const output = execFileSync(process.execPath, [fileURLToPath(new URL('./fixtures/owned-sdk-lifecycle.mjs', import.meta.url)),
      fixture.repository, fixture.home, fixture.workspace, fixture.patch, 'expired-after-initialize'],
    { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 20_000 });
    const result = JSON.parse(output);
    console.info(JSON.stringify({ scope: 'keyless actual SDK initialize cutoff; test-only public subclass advances parent clock after super.start()', ...result }));
    expect(result).toMatchObject({ spawnCount: 1, rejected: true, failure: expect.stringMatching(/lease expired/),
      receipt: { shutdownAcknowledged: true, resourcesStopped: true, code: 0, signal: null, terminationRequested: false } });
    expect(existsSync(join(root, 'requests.jsonl'))).toBe(false);
    expect(existsSync(join(fixture.workspace, 'unapproved.txt'))).toBe(false);
  });
});
