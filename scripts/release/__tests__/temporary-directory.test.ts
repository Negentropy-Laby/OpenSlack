import type * as FileSystem from 'node:fs';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  removeReleaseTemporaryDirectory,
  withReleaseTemporaryDirectory,
} from '../temporary-directory.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

const remove = vi.mocked(rmSync);
const leftovers: string[] = [];
afterEach(() => {
  remove.mockReset();
  for (const directory of leftovers.splice(0)) rmSync(directory, { recursive: true, force: true });
  remove.mockClear();
});

it('cleans its owned directory and preserves the operation result', () => {
  let owned = '';
  const result = withReleaseTemporaryDirectory('release-cleanup-test-', (directory) => {
    owned = directory;
    writeFileSync(join(directory, 'artifact'), 'fixture');
    return 'verified';
  });
  expect(result).toBe('verified');
  expect(existsSync(owned)).toBe(false);
  expect(remove).toHaveBeenCalledExactlyOnceWith(owned, {
    recursive: true,
    force: true,
  });
});

it('preserves the original verification failure when cleanup succeeds', () => {
  const failure = new Error('verification rejected');
  expect(() =>
    withReleaseTemporaryDirectory('release-cleanup-test-', () => {
      throw failure;
    }),
  ).toThrow(failure);
});

it('fails successful verification if cleanup exhausts its budget', () => {
  const busy = Object.assign(new Error('cleanup busy'), { code: 'EBUSY' });
  remove.mockImplementation(() => {
    throw busy;
  });
  expect(() =>
    withReleaseTemporaryDirectory('release-cleanup-test-', (directory) => {
      leftovers.push(directory);
      return 'verified';
    }),
  ).toThrow(busy);
});

it('reports both failures with the verification failure as the cause', () => {
  const primary = new Error('signature rejected');
  const secondary = Object.assign(new Error('cleanup busy'), { code: 'EBUSY' });
  remove.mockImplementation(() => {
    throw secondary;
  });
  let observed: unknown;
  try {
    withReleaseTemporaryDirectory('release-cleanup-test-', (directory) => {
      leftovers.push(directory);
      throw primary;
    });
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(AggregateError);
  expect((observed as AggregateError).errors).toEqual([primary, secondary]);
  expect((observed as AggregateError).cause).toBe(primary);
});

// Fault injection is at the filesystem boundary, not at the retry helper.
it('recovers a Windows transient deletion conflict without retrying unknown errors', () => {
  const busy = Object.assign(new Error('held executable'), { code: 'EBUSY' });
  remove.mockImplementationOnce(() => {
    throw busy;
  });
  if (process.platform === 'win32') {
    expect(() => removeReleaseTemporaryDirectory('nonexistent-release-fixture')).not.toThrow();
    expect(remove).toHaveBeenCalledTimes(2);
  } else {
    expect(() => removeReleaseTemporaryDirectory('nonexistent-release-fixture')).toThrow(busy);
    expect(remove).toHaveBeenCalledTimes(1);
  }
  remove.mockClear();
  const unknown = Object.assign(new Error('invalid cleanup'), { code: 'EINVAL' });
  remove.mockImplementationOnce(() => {
    throw unknown;
  });
  expect(() => removeReleaseTemporaryDirectory('nonexistent-release-fixture')).toThrow(unknown);
  expect(remove).toHaveBeenCalledTimes(1);
});
