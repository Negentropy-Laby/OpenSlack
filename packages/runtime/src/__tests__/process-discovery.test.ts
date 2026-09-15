import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  bashCandidates,
  createProcessResolver,
  executableCandidates,
  normalizeProcessEnvironment,
} from '@openslack/core';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: 'fixture 1', stderr: '' })),
}));
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shared process discovery', () => {
  it.each(['PATH', 'Path', 'path', 'pAtH'])(
    'normalizes Windows %s without losing its value',
    (key) => {
      const env = normalizeProcessEnvironment(
        { [key]: 'C:/fixture path', PaThExT: '.BROKEN' },
        'win32',
      );
      expect(Object.keys(env)).toEqual(['PATH', 'PATHEXT']);
      expect(env.PATH).toBe('C:/fixture path');
      expect(env.PATHEXT).toContain('.CMD');
      expect(executableCandidates('tool', env, 'win32')[0]).toBe(
        join('C:/fixture path', 'tool.exe'),
      );
    },
  );
  it('preserves POSIX key case and does not add Windows options', () => {
    expect(normalizeProcessEnvironment({ PATH: '/bin', path: '/other' }, 'linux')).toEqual({
      PATH: '/bin',
      path: '/other',
    });
  });
  it('caches verified successes per immutable fixture and re-probes replaced files', () => {
    const root = mkdtempSync(join(tmpdir(), 'process resolver space '));
    roots.push(root);
    const executable = join(root, process.platform === 'win32' ? 'fixture.exe' : 'fixture');
    writeFileSync(executable, 'v1');
    const parent = { PATH: root };
    const resolver = createProcessResolver(parent);
    const first = resolver.executable('fixture');
    parent.PATH = 'changed after creation';
    expect(resolver.executable('fixture')).toBe(first);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    writeFileSync(executable, 'changed size');
    expect(resolver.executable('fixture')).toBe(first);
    expect(spawnSync).toHaveBeenCalledTimes(2);
    createProcessResolver({ PATH: root }).executable('fixture');
    expect(spawnSync).toHaveBeenCalledTimes(3);
  });
  it('does not cache missing candidates and resolves relative directories against its own cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'process resolver cwd '));
    roots.push(root);
    mkdirSync(join(root, 'bin'));
    const resolver = createProcessResolver({ PATH: 'bin' }, root);
    expect(() => resolver.executable('fixture')).toThrow('TEST_EXECUTABLE_UNAVAILABLE');
    writeFileSync(
      join(root, 'bin', process.platform === 'win32' ? 'fixture.exe' : 'fixture'),
      'fixture',
    );
    expect(resolver.executable('fixture')).toContain(root);
    expect(spawnSync).toHaveBeenCalledOnce();
  });
});

it('invalidates a cached PATH candidate when its symlink target changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'resolver symlink '));
  roots.push(root);
  const a = join(root, 'first');
  const b = join(root, 'second');
  writeFileSync(a, 'first');
  writeFileSync(b, 'second');
  const candidate = join(root, process.platform === 'win32' ? 'fixture.exe' : 'fixture');
  symlinkSync(a, candidate, 'file');
  const resolver = createProcessResolver({ PATH: root });
  expect(resolver.executable('fixture')).toBe(a);
  rmSync(candidate);
  symlinkSync(b, candidate, 'file');
  expect(resolver.executable('fixture')).toBe(b);
  expect(spawnSync).toHaveBeenCalledTimes(2);
});

it('derives Git Bash candidates from discovered Git exec paths without requiring a standard install', () => {
  const root = mkdtempSync(join(tmpdir(), 'scoop Git fixture '));
  roots.push(root);
  mkdirSync(join(root, 'cmd'));
  writeFileSync(join(root, 'cmd', process.platform === 'win32' ? 'git.exe' : 'git'), 'fixture');
  vi.mocked(spawnSync).mockReturnValueOnce({
    status: 0,
    signal: null,
    pid: 1,
    output: [],
    stdout: join(root, 'mingw64', 'libexec', 'git-core'),
    stderr: '',
  });
  const candidates = bashCandidates({ PATH: join(root, 'cmd') });
  if (process.platform === 'win32') expect(candidates).toContain(join(root, 'bin', 'bash.exe'));
  else expect(candidates).toEqual([join(root, 'cmd', 'bash')]);
});
