import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { prepareSdkFixture } from './fixtures/sdk-profile.ts';

describe('actual unmodified SDK cleanup never creates another executor', () => {
  it.each([['before-start', 0], ['initialize-failed', 1]] as const)('%s has exactly %i actual SDK spawns', (mode, expected) => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-sdk-no-replay-'));
    onTestFinished(({ task }) => { if (task.result?.state === 'pass') rmSync(root, { recursive: true, force: true }); });
    const fixture = prepareSdkFixture(root, []);
    const output = execFileSync(process.execPath, [fileURLToPath(new URL('./fixtures/owned-sdk-lifecycle.mjs', import.meta.url)),
      fixture.repository, fixture.home, fixture.workspace, fixture.patch, mode],
    { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 20_000 });
    expect(JSON.parse(output)).toMatchObject({ spawnCount: expected, rejected: true,
      receipt: { shutdownAcknowledged: false, resourcesStopped: false } });
    expect(existsSync(join(root, 'requests.jsonl'))).toBe(false);
    expect(existsSync(join(fixture.workspace, 'unapproved.txt'))).toBe(false);
  });
});
