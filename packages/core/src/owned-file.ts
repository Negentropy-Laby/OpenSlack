import { closeSync, constants, fstatSync, lstatSync, openSync, type BigIntStats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readStableDescriptor } from './stable-descriptor.js';

const identity = (value: BigIntStats): string => [value.dev, value.ino, value.mode, value.uid, value.gid,
  value.nlink, value.size, value.mtimeNs, value.ctimeNs].join(':');
export interface OwnedFileReadOptions { allowEmpty?: boolean; artifactLinks?: boolean; links?: 1 | 2 }

/** Filesystem mechanics only. Callers retain containment, purpose, authorization
 * and artifact-vs-runtime trust decisions. No portable check grants an action. */
export function withOwnedFileDescriptor<T>(path: string, maxBytes: number, options: OwnedFileReadOptions,
  consume: (descriptor: number) => T): T {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('Invalid owned-file byte bound');
  const parents: Array<{ path: string; stamp: BigIntStats }> = [];
  for (let parent = dirname(resolve(path));; parent = dirname(parent)) {
    const stamp = lstatSync(parent, { bigint: true });
    if (!stamp.isDirectory() || stamp.isSymbolicLink()) throw new Error('Owned file traverses a directory link');
    parents.push({ path: parent, stamp });
    if (parent === dirname(parent)) break;
  }
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink < 1n ||
    (!options.artifactLinks && entry.nlink !== BigInt(options.links ?? 1)) || entry.size > BigInt(maxBytes) ||
    (options.allowEmpty === false && entry.size === 0n)) throw new Error('Owned file is not an owned regular file within its bound');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (identity(before) !== identity(entry)) throw new Error('Owned file identity changed before read');
    const result = consume(fd);
    if (identity(fstatSync(fd, { bigint: true })) !== identity(before) || identity(lstatSync(path, { bigint: true })) !== identity(before)) throw new Error('Owned file identity changed during read');
    for (const parent of parents) {
      const now = lstatSync(parent.path, { bigint: true }), original = parent.stamp;
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== original.dev || now.ino !== original.ino ||
        now.mode !== original.mode || now.uid !== original.uid || now.gid !== original.gid) throw new Error('Owned file directory identity changed');
    }
    return result;
  } finally { closeSync(fd); }
}

export function readOwnedFile(path: string, maxBytes: number, options: OwnedFileReadOptions = {}): Buffer {
  return withOwnedFileDescriptor(path, maxBytes, options, fd => readStableDescriptor(fd, maxBytes, options.allowEmpty !== false));
}
