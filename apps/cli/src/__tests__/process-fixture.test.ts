import type * as ChildProcess from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  testBash,
  testExecutable,
  testProcessEnvironment,
} from '../../../../scripts/testing/process-fixture.mjs';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
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
