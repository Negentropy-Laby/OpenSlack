import { declareLinuxCleanupTests } from './helpers/cleanup-platform-qualification.js';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Fs from 'node:fs';
import { testTemporaryDirectory } from '../../../../scripts/testing/process-fixture.mjs';
import {
  readCleanupBoundedFile,
  CleanupDirectoryAnchor,
  withCleanupFile,
} from '../internal/cleanup-file-boundary.js';

const fault = vi.hoisted(() => ({
  opened: new Set<number>(),
  observed: new Set<number>(),
  newDescriptors: 0,
  failOnNew: Infinity,
}));
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof Fs>();
  return {
    ...actual,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      const fd = actual.openSync(...args);
      fault.opened.add(fd);
      return fd;
    }) as typeof actual.openSync,
    closeSync: (fd: number) => {
      actual.closeSync(fd);
      fault.opened.delete(fd);
      fault.observed.delete(fd);
    },
    fstatSync: ((fd: number, options?: { bigint?: boolean }) => {
      if (!fault.observed.has(fd)) {
        fault.observed.add(fd);
        fault.newDescriptors++;
        if (fault.newDescriptors === fault.failOnNew)
          throw Object.assign(new Error('injected fstat failure'), { code: 'EIO' });
      }
      return actual.fstatSync(fd, options);
    }) as typeof actual.fstatSync,
  };
});
beforeEach(() => {
  fault.newDescriptors = 0;
  fault.failOnNew = Infinity;
});

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const fd of fault.opened) closeSync(fd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = testTemporaryDirectory('cleanup-read-boundary-');
  roots.push(root);
  const path = join(root, 'record.json');
  writeFileSync(path, '{}', { mode: 0o600 });
  return { root, path };
}
describe('bounded descriptor input contract', () => {
  if (declareLinuxCleanupTests) {
    it.each([1, 2, 3])(
      'closes every acquired directory FD when new-descriptor fstat %s fails',
      (count) => {
        const { root } = fixture();
        fault.newDescriptors = 0;
        fault.failOnNew = count;
        expect(() => CleanupDirectoryAnchor.open(root)).toThrow('injected fstat failure');
        expect(fault.opened.size).toBe(0);
      },
    );
    it('lets root inspect an existing agent-owned historical file without changing its owner', () => {
      const { path } = fixture();
      vi.stubGlobal('process', { ...process, getuid: () => 0 });
      expect(withCleanupFile(path, 32, (bytes) => bytes, 'historical-record').toString()).toBe(
        '{}',
      );
    });
  }
  it('reads an ordinary file on Linux and refuses other platforms', () => {
    const { path } = fixture();
    if (process.platform === 'linux')
      expect(readCleanupBoundedFile(path, 32).toString()).toBe('{}');
    else
      expect(() => readCleanupBoundedFile(path, 32)).toThrowError(
        expect.objectContaining({ code: 'UNSUPPORTED_PLATFORM' }),
      );
  });
  if (declareLinuxCleanupTests) {
    it.each(['hardlink', 'writable', 'fifo', 'oversize', 'parent-link'])(
      'refuses %s without accepting unsafe bytes',
      (kind) => {
        const { root, path } = fixture();
        let input = path;
        if (kind === 'hardlink') linkSync(path, join(root, 'second.json'));
        if (kind === 'writable') chmodSync(path, 0o666);
        if (kind === 'fifo') {
          rmSync(path);
          execFileSync('mkfifo', [path]);
        }
        if (kind === 'oversize') writeFileSync(path, Buffer.alloc(33));
        if (kind === 'parent-link') {
          const external = join(root, 'external');
          mkdirSync(external);
          writeFileSync(join(external, 'record.json'), '{}');
          symlinkSync(external, join(root, 'alias'));
          input = join(root, 'alias', 'record.json');
        }
        expect(() => readCleanupBoundedFile(input, 32)).toThrowError(
          expect.objectContaining({
            code:
              kind === 'parent-link'
                ? 'SYMLINK_REJECTED'
                : kind === 'oversize'
                  ? 'TOO_LARGE'
                  : 'UNSAFE_FILE',
          }),
        );
      },
    );
  }
  it.each(['win32', 'darwin'])('refuses %s before filesystem access', (platform) => {
    const { path } = fixture(),
      bytes = readFileSync(path);
    vi.stubGlobal('process', { ...process, platform });
    expect(() => readCleanupBoundedFile(path, 32)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_PLATFORM' }),
    );
    vi.unstubAllGlobals();
    expect(readFileSync(path)).toEqual(bytes);
  });
});
