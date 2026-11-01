import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, closeSync, fstatSync, mkdtempSync, openSync, writeFileSync, rmSync, linkSync, renameSync, readSync, truncateSync } from 'node:fs';
import type * as FsModule from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readObservedDescriptorBytes, readOwnedFile, withOwnedFileDescriptor } from '../owned-file.js';
vi.mock('node:fs', async load => {
  const actual = await load<typeof FsModule>();
  return { ...actual, fstatSync: vi.fn(actual.fstatSync), readSync: vi.fn(actual.readSync) };
});
const observedStat = vi.mocked(fstatSync), nativeStat = observedStat.getMockImplementation()!;
const observedRead = vi.mocked(readSync), nativeRead = observedRead.getMockImplementation()!;
const roots: string[] = [];
afterEach(() => {
  observedStat.mockReset().mockImplementation(nativeStat); observedRead.mockReset().mockImplementation(nativeRead);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() { const root = mkdtempSync(join(tmpdir(), 'owned-file-')); roots.push(root); const path = join(root, 'value'); writeFileSync(path, 'bound'); return { root, path }; }

describe('shared owned descriptor mechanics', () => {
  it('retains the extra-byte refusal when a filesystem reports the same coarse identity after growth and restoration', () => {
    const { path } = fixture(), fd = openSync(path, 'r'), before = fstatSync(fd, { bigint: true });
    let appended = false, observedBeyondSize = false;
    observedRead.mockImplementation((...args) => {
      const count = Reflect.apply(nativeRead, undefined, args);
      if (args[0] === fd && count) {
        if (!appended) { appendFileSync(path, 'x'); appended = true; }
        else { observedBeyondSize = true; truncateSync(path, 5); }
      }
      return count;
    });
    observedStat.mockImplementation((value, ...args) => {
      if (value === fd) { truncateSync(path, 5); return before; }
      return Reflect.apply(nativeStat, undefined, [value, ...args]);
    });
    try {
      expect(() => readObservedDescriptorBytes(fd, 5, before)).toThrow('IDENTITY_CHANGED');
      expect(observedBeyondSize).toBe(true);
    } finally { closeSync(fd); }
  });
  it('reuses the owner FD observation while proving exact size, empty policy and nanosecond identity', () => {
    const { root, path } = fixture(), fd = openSync(path, 'r');
    try {
      const before = fstatSync(fd, { bigint: true });
      expect(readObservedDescriptorBytes(fd, 5, before).bytes.toString()).toBe('bound');
      expect(() => readObservedDescriptorBytes(fd, 4, before)).toThrow('SIZE_INVALID');
      const empty = join(root, 'empty'); writeFileSync(empty, ''); const emptyFD = openSync(empty, 'r');
      try {
        const stamp = fstatSync(emptyFD, { bigint: true });
        expect(readObservedDescriptorBytes(emptyFD, 0, stamp).bytes.length).toBe(0);
        expect(() => readObservedDescriptorBytes(emptyFD, 0, stamp, false)).toThrow('SIZE_INVALID');
      } finally { closeSync(emptyFD); }
    } finally { closeSync(fd); }
  });
  it.each(['short', 'grown', 'same-length'] as const)('rejects %s bytes against the actual owner observation', kind => {
    const { path } = fixture(), fd = openSync(path, 'r');
    try {
      const before = fstatSync(fd, { bigint: true });
      writeFileSync(path, kind === 'short' ? 'b' : kind === 'grown' ? 'bounded' : 'other');
      expect(() => readObservedDescriptorBytes(fd, 5, before)).toThrow('IDENTITY_CHANGED');
    } finally { closeSync(fd); }
  });
  it('reads exact bounded bytes and keeps artifact hardlinks an explicit caller choice', () => {
    const { root, path } = fixture();
    expect(readOwnedFile(path, 5).toString()).toBe('bound');
    expect(() => readOwnedFile(path, 4)).toThrow();
    linkSync(path, join(root, 'alias'));
    expect(() => readOwnedFile(path, 5)).toThrow();
    expect(readOwnedFile(path, 5, { artifactLinks: true }).toString()).toBe('bound');
  });
  it('rejects a same-content replacement during consumption and closes the descriptor', () => {
    const { root, path } = fixture(), replacement = join(root, 'replacement');
    writeFileSync(replacement, 'bound');
    let descriptor: number | undefined;
    expect(() => withOwnedFileDescriptor(path, 5, {}, fd => {
      descriptor = fd; renameSync(path, join(root, 'retained')); renameSync(replacement, path); return 'not authority';
    })).toThrow('identity changed');
    expect(() => readSync(descriptor!, Buffer.alloc(1), 0, 1, 0)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });
  it('closes the descriptor when the consumer throws while preserving the consumer error', () => {
    const { path } = fixture(), error = new Error('fixture consumer failure'); let descriptor: number | undefined;
    expect(() => withOwnedFileDescriptor(path, 5, {}, fd => { descriptor = fd; throw error; })).toThrow(error);
    expect(() => readSync(descriptor!, Buffer.alloc(1), 0, 1, 0)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });
});
