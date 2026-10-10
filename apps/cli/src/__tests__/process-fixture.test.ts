import type * as ChildProcess from 'node:child_process';
import type * as FileSystem from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  testBash,
  testExecutable,
  testProcessEnvironment,
  testTemporaryDirectory,
  testPowerShells,
  testPowerShellEnvironment,
} from '../../../../scripts/testing/process-fixture.mjs';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof FileSystem>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

it('discovers optional PowerShell from the shared PATH candidates without launching where', () => {
  const root = testTemporaryDirectory('openslack pwsh discovery ');
  const executable = join(root, 'pwsh.exe');
  writeFileSync(executable, 'non-executing shell path fixture');
  vi.mocked(spawnSync).mockClear();
  try {
    expect(testPowerShells({ Path: root, PATH: 'unusable-duplicate' })).toEqual([
      'powershell',
      realpathSync.native(executable),
    ]);
    expect(spawnSync).not.toHaveBeenCalled();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('distinguishes an absent optional PowerShell from failed executable discovery', () => {
  const root = testTemporaryDirectory('openslack-pwsh-errors-');
  try {
    expect(testPowerShells({ PATH: '' })).toEqual(['powershell']);
    for (const code of ['ENOENT', 'ENOTDIR']) {
      vi.mocked(statSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('missing fixture candidate'), { code });
      });
      expect(testPowerShells({ PATH: root })).toEqual(['powershell']);
    }
    for (const code of ['EACCES', 'EIO', 'ETIMEDOUT', 'EBADF']) {
      vi.mocked(statSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('inspection fixture failure'), { code });
      });
      expect(() => testPowerShells({ PATH: root })).toThrow('TEST_PWSH_DISCOVERY_FAILED');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('does not treat a directory named pwsh.exe as an optional shell', () => {
  const root = testTemporaryDirectory('openslack-pwsh-directory-');
  mkdirSync(join(root, 'pwsh.exe'));
  try {
    expect(testPowerShells({ PATH: root })).toEqual(['powershell']);
  } finally {
    rmSync(root, { recursive: true, force: true });
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

it.each(['PSModulePath', 'psmodulepath', 'PsModulePath'])(
  'isolates inherited %s only in PowerShell test children',
  (key) => {
    const parent = { PATH: 'tools', [key]: 'another shell edition', KEEP: 'yes' };
    const env = testPowerShellEnvironment(parent, 'win32');
    expect(Object.keys(env).some((name) => name.toLowerCase() === 'psmodulepath')).toBe(false);
    expect(parent[key]).toBe('another shell edition');
    expect(env.KEEP).toBe('yes');
    expect(testProcessEnvironment(parent, 'linux')[key]).toBe('another shell edition');
  },
);

it('PowerShell 5.1 resolves Get-FileHash with a poisoned parent module path', () => {
  if (process.platform !== 'win32') {
    expect(testPowerShellEnvironment({ PSModulePath: '/foreign/modules' })).toEqual({});
    return;
  }
  const env = testPowerShellEnvironment({
    ...process.env,
    PSModulePath: 'C:\\foreign-edition\\Modules',
  });
  for (const shell of testPowerShells(env)) {
    const result = spawnSync(
      shell,
      ['-NoProfile', '-Command', '(Get-Command Get-FileHash -ErrorAction Stop).Name'],
      { env, encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('Get-FileHash');
  }
});
