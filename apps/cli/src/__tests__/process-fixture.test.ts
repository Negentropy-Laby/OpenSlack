import type * as ChildProcess from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  testBash,
  testExecutable,
  testProcessEnvironment,
  testTemporaryDirectory,
  testPowerShells,
} from '../../../../scripts/testing/process-fixture.mjs';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

it('distinguishes an absent optional PowerShell from failed executable discovery', () => {
  const result = { pid: 0, output: [], stdout: '', stderr: '', signal: null };
  for (const status of [0, 1]) {
    vi.mocked(spawnSync).mockReturnValueOnce({ ...result, status });
    expect(testPowerShells({})).toEqual(status === 0 ? ['powershell', 'pwsh'] : ['powershell']);
  }
  for (const failure of [
    { status: null, error: Object.assign(new Error('timeout fixture'), { code: 'ETIMEDOUT' }) },
    { status: null, error: Object.assign(new Error('missing tool fixture'), { code: 'ENOENT' }) },
    { status: null, signal: 'SIGTERM' as const },
    { status: 2 },
  ]) {
    vi.mocked(spawnSync).mockReturnValueOnce({ ...result, ...failure });
    expect(() => testPowerShells({})).toThrow('TEST_PWSH_DISCOVERY_FAILED');
  }
});

it('returns a native canonical temporary directory when its parent is an alias', () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'openslack-temp-parent-'));
  const alias = join(root, 'alias');
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    const directory = testTemporaryDirectory('fixture ', alias);
    expect(directory).toBe(realpathSync.native(directory));
    expect(dirname(directory)).toBe(realpathSync.native(root));
  } finally {
    rmSync(alias, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

describe('test process environment', () => {
  it.each([{}, { Path: 'preferred path', PATH: 'duplicate', PathExt: '.BROKEN' }])(
    'normalizes incomplete or ambiguous Windows environment %j',
    (parent) => {
      const env = testProcessEnvironment(parent, 'win32');
      expect(Object.keys(env).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH']);
      expect(Object.keys(env).filter((key) => key.toLowerCase() === 'pathext')).toEqual([
        'PATHEXT',
      ]);
      expect(env.PATHEXT).toContain('.EXE');
      expect(env.PATH).toBe(parent.Path ?? '');
    },
  );
  it('uses the running Node independently of a missing PATH', () => {
    expect(testExecutable('node', testProcessEnvironment({}))).toBeTruthy();
  });
  it('diagnoses an unavailable Bun without searching ambient PATH', () => {
    expect(() => testExecutable('bun', testProcessEnvironment({}))).toThrow(
      'TEST_EXECUTABLE_UNAVAILABLE',
    );
  });
  it('rejects a non-shell executable instead of treating it as Bash', () => {
    expect(() => testBash(testProcessEnvironment(), [process.execPath])).toThrow(
      'TEST_BASH_UNAVAILABLE',
    );
  });
});

it('accepts a lowercase Windows path and leaves POSIX environment semantics intact', () => {
  expect(testProcessEnvironment({ path: 'lowercase' }, 'win32').PATH).toBe('lowercase');
  const posix = { PATH: '/bin', Path: '/different' };
  expect(testProcessEnvironment(posix, 'linux')).toEqual(posix);
  expect(testProcessEnvironment(posix, 'linux')).not.toHaveProperty('PATHEXT');
});

it('caches repeated Git Bash path conversions within one fixture', () => {
  const shell = testBash();
  vi.mocked(spawnSync).mockClear();
  const first = shell.path(process.cwd());
  expect(shell.path(process.cwd())).toBe(first);
  const conversions = vi
    .mocked(spawnSync)
    .mock.calls.filter((call) => JSON.stringify(call[1]).includes('cygpath'));
  expect(conversions).toHaveLength(process.platform === 'win32' ? 1 : 0);
});
