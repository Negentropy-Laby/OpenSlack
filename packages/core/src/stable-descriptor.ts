import { fstatSync, lstatSync, readSync, type BigIntStats, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';

/** File-byte identity, separate from inode ownership used for cleanup. */
export function stableFileIdentity(s: Stats): string {
  return [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
}
export class StableDescriptorError extends Error {
  constructor(public readonly code: 'NOT_REGULAR' | 'SIZE_INVALID' | 'IDENTITY_CHANGED') {
    super(code);
  }
}

function readDescriptorRange(fd: number, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  let count = 0;
  while (count < bytes.length) {
    const n = readSync(fd, bytes, count, bytes.length - count, count);
    if (!n) break;
    count += n;
  }
  return bytes.subarray(0, count);
}

/** Internal mechanics for an owner that already sampled this FD itself. Never
 * accept a caller's serialized stat as authority. The owner still checks its
 * pathname, ancestors, permissions and links, including after this returns. */
export function readObservedDescriptorBytes(fd: number, maxBytes: number, before: BigIntStats,
  allowEmpty = true): { bytes: Buffer; after: BigIntStats } {
  if (!before.isFile()) throw new StableDescriptorError('NOT_REGULAR');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || before.size < 0n || before.size > BigInt(maxBytes) ||
    (!allowEmpty && before.size === 0n)) throw new StableDescriptorError('SIZE_INVALID');
  const bytes = readDescriptorRange(fd, Number(before.size) + 1);
  const after = fstatSync(fd, { bigint: true });
  // Preserve the bounded extra-byte/EOF observation as well as full identity:
  // nanosecond fields do not imply unique timestamps on every filesystem.
  if (bytes.length !== Number(before.size) || !after.isFile() || before.dev !== after.dev || before.ino !== after.ino ||
    before.mode !== after.mode || before.uid !== after.uid || before.gid !== after.gid || before.nlink !== after.nlink ||
    before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new StableDescriptorError('IDENTITY_CHANGED');
  }
  return { bytes, after };
}

/** Caller owns the FD and all path, permission, link and text policies. */
export function readStableDescriptor(fd: number, maxBytes: number, allowEmpty = true): Buffer {
  const before = fstatSync(fd);
  if (!before.isFile()) throw new StableDescriptorError('NOT_REGULAR');
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    before.size > maxBytes ||
    before.size < 0 ||
    (!allowEmpty && !before.size)
  )
    throw new StableDescriptorError('SIZE_INVALID');
  const bytes = readDescriptorRange(fd, before.size + 1);
  if (bytes.length !== before.size || stableFileIdentity(fstatSync(fd)) !== stableFileIdentity(before))
    throw new StableDescriptorError('IDENTITY_CHANGED');
  return bytes;
}

/** Streaming byte proof for caller-owned descriptors; no pathname or trust policy. */
export function digestStableDescriptor(
  fd: number,
  maxBytes: number,
  allowEmpty = true,
): { sha256: string; bytes: number } {
  const before = fstatSync(fd);
  if (!before.isFile()) throw new StableDescriptorError('NOT_REGULAR');
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    before.size > maxBytes ||
    before.size < 0 ||
    (!allowEmpty && before.size === 0)
  )
    throw new StableDescriptorError('SIZE_INVALID');
  const digest = createHash('sha256');
  const block = Buffer.alloc(Math.min(1024 * 1024, before.size + 1));
  let count = 0;
  while (count <= before.size) {
    const n = readSync(fd, block, 0, Math.min(block.length, before.size + 1 - count), count);
    if (!n) break;
    digest.update(block.subarray(0, n));
    count += n;
  }
  if (count !== before.size || stableFileIdentity(fstatSync(fd)) !== stableFileIdentity(before))
    throw new StableDescriptorError('IDENTITY_CHANGED');
  return { sha256: digest.digest('hex'), bytes: count };
}

/** Local portable-fixture identity checks. This is not a Linux descriptor anchor
 * and must never authorize record publication or formal runtime evidence. */
export function capturePortableDirectoryChain(path: string): { verify(): void } {
  const captured: Array<{ path: string; dev: number; ino: number }> = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    const stamp = lstatSync(current);
    if (!stamp.isDirectory() || stamp.isSymbolicLink())
      throw new StableDescriptorError('NOT_REGULAR');
    captured.push({ path: current, dev: stamp.dev, ino: stamp.ino });
    if (dirname(current) === current) break;
  }
  return {
    verify() {
      for (const item of captured) {
        const stamp = lstatSync(item.path);
        if (
          !stamp.isDirectory() ||
          stamp.isSymbolicLink() ||
          stamp.dev !== item.dev ||
          stamp.ino !== item.ino
        )
          throw new StableDescriptorError('IDENTITY_CHANGED');
      }
    },
  };
}
