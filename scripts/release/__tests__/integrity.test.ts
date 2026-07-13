import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertImmutableAssetSetsMatch } from '../immutable-assets.js';
import { getGitContentState } from '../lib.js';
import { consumeReleaseSigningEnvironment } from '../signature.js';

describe('release signing environment isolation', () => {
  it('consumes signing material before a child can inherit it', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      OPENSLACK_RELEASE_SIGNING_PRIVATE_KEY: 'fixture-private-key',
      OPENSLACK_RELEASE_TRUSTED_PUBLIC_KEY: 'fixture-public-key',
    };
    const signing = consumeReleaseSigningEnvironment(env);
    expect(signing).toEqual({
      privateKey: 'fixture-private-key',
      trustedPublicKey: 'fixture-public-key',
    });
    expect(env).not.toHaveProperty('OPENSLACK_RELEASE_SIGNING_PRIVATE_KEY');
    expect(env).not.toHaveProperty('OPENSLACK_RELEASE_TRUSTED_PUBLIC_KEY');

    const child = spawnSync(
      process.execPath,
      [
        '-e',
        'console.log(Boolean(process.env.OPENSLACK_RELEASE_SIGNING_PRIVATE_KEY || process.env.OPENSLACK_RELEASE_TRUSTED_PUBLIC_KEY))',
      ],
      { env, encoding: 'utf-8' },
    );
    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe('false');
  });
});

describe('release content state', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openslack-release-content-'));
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'release-test@openslack.invalid']);
    git(root, ['config', 'user.name', 'OpenSlack Release Test']);
    writeFileSync(join(root, '.gitignore'), 'ignored.txt\n', 'utf-8');
    writeFileSync(join(root, 'tracked.txt'), 'tracked\n', 'utf-8');
    git(root, ['add', '.gitignore', 'tracked.txt']);
    git(root, ['commit', '-qm', 'fixture']);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('ignores stat-only changes and ignored files', () => {
    const tracked = join(root, 'tracked.txt');
    const now = new Date();
    utimesSync(tracked, now, new Date(now.getTime() + 2_000));
    writeFileSync(join(root, 'ignored.txt'), 'ignored\n', 'utf-8');
    expect(getGitContentState(root)).toEqual({
      dirty: false,
      staged: false,
      unstaged: false,
      untracked: [],
    });
  });

  it('detects staged, unstaged, and untracked release content', () => {
    writeFileSync(join(root, 'tracked.txt'), 'unstaged\n', 'utf-8');
    expect(getGitContentState(root)).toMatchObject({ dirty: true, unstaged: true });

    git(root, ['add', 'tracked.txt']);
    expect(getGitContentState(root)).toMatchObject({ dirty: true, staged: true });

    git(root, ['commit', '-qm', 'staged']);
    writeFileSync(join(root, 'untracked.txt'), 'untracked\n', 'utf-8');
    expect(getGitContentState(root)).toEqual({
      dirty: true,
      staged: false,
      unstaged: false,
      untracked: ['untracked.txt'],
    });
  });
});

describe('immutable release asset comparison', () => {
  let root: string;
  let expected: string;
  let actual: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openslack-release-assets-'));
    expected = join(root, 'expected');
    actual = join(root, 'actual');
    mkdirSync(expected);
    mkdirSync(actual);
    for (const directory of [expected, actual]) {
      writeFileSync(join(directory, 'archive.zip'), 'archive', 'utf-8');
      writeFileSync(join(directory, 'manifest.json'), 'manifest', 'utf-8');
    }
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('allows an exact byte-identical no-op', () => {
    expect(() => assertImmutableAssetSetsMatch(expected, actual)).not.toThrow();
  });

  it('fails closed when an existing asset has different content', () => {
    writeFileSync(join(actual, 'archive.zip'), 'replacement', 'utf-8');
    expect(() => assertImmutableAssetSetsMatch(expected, actual)).toThrow(
      'Published release asset differs',
    );
  });

  it('fails closed when either asset set has an extra or missing file', () => {
    writeFileSync(join(actual, 'extra.txt'), 'extra', 'utf-8');
    expect(() => assertImmutableAssetSetsMatch(expected, actual)).toThrow('asset set differs');
  });
});

function git(root: string, args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}
