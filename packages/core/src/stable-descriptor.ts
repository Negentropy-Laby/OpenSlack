import { fstatSync, readSync, type Stats } from 'node:fs';

/** File-byte identity, separate from inode ownership used for cleanup. */
export function stableFileIdentity(s: Stats): string {
  return [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
}
export class StableDescriptorError extends Error {
  constructor(public readonly code: 'NOT_REGULAR' | 'SIZE_INVALID' | 'IDENTITY_CHANGED') {
    super(code);
  }
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
  const bytes = Buffer.alloc(before.size + 1);
  let count = 0;
  while (count < bytes.length) {
    const n = readSync(fd, bytes, count, bytes.length - count, count);
    if (!n) break;
    count += n;
  }
  if (count !== before.size || stableFileIdentity(fstatSync(fd)) !== stableFileIdentity(before))
    throw new StableDescriptorError('IDENTITY_CHANGED');
  return bytes.subarray(0, count);
}
