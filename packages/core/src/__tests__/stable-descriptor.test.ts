import { createHash } from 'node:crypto';
import {
  closeSync,
  mkdtempSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  capturePortableDirectoryChain,
  digestStableDescriptor,
  readStableDescriptor,
  StableDescriptorError,
} from '../stable-descriptor.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function file(raw: Buffer) {
  // Canonical fixture provenance; supplied input links still refuse.
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'stable-descriptor-'));
  roots.push(root);
  const path = join(root, 'owned.bin');
  writeFileSync(path, raw);
  return { root, path };
}
it('streaming digest agrees with owned bytes and bounds allocation independently of file size', () => {
  const raw = Buffer.alloc(3 * 1024 * 1024 + 9, 0x61),
    { path } = file(raw),
    fd = openSync(path, 'r');
  const allocate = vi.spyOn(Buffer, 'alloc');
  try {
    expect(digestStableDescriptor(fd, raw.length)).toEqual({
      bytes: raw.length,
      sha256: createHash('sha256').update(raw).digest('hex'),
    });
    expect(allocate.mock.calls.every(([size]) => size <= 1024 * 1024)).toBe(true);
    expect(readStableDescriptor(fd, raw.length).equals(raw)).toBe(true);
  } finally {
    closeSync(fd);
  }
});
it.each([0, 2])('rejects a nonempty descriptor above bound %i before reading', (bound) => {
  const { path } = file(Buffer.from('abcd')),
    fd = openSync(path, 'r');
  try {
    expect(() => digestStableDescriptor(fd, bound)).toThrow(StableDescriptorError);
  } finally {
    closeSync(fd);
  }
});
it('makes empty byte acceptance explicit', () => {
  const { path } = file(Buffer.alloc(0)),
    fd = openSync(path, 'r');
  try {
    expect(digestStableDescriptor(fd, 10).bytes).toBe(0);
    expect(() => digestStableDescriptor(fd, 10, false)).toThrow('SIZE_INVALID');
  } finally {
    closeSync(fd);
  }
});
it('portable directory identity rejects replacement and confers no FD capability', () => {
  const { root } = file(Buffer.from('owned')),
    captured = capturePortableDirectoryChain(root);
  expect(Object.keys(captured)).toEqual(['verify']);
  captured.verify();
  const old = root + '.preserved';
  renameSync(root, old);
  roots.push(old);
  writeFileSync(root, 'replacement regular file');
  expect(() => captured.verify()).toThrow(StableDescriptorError);
});
