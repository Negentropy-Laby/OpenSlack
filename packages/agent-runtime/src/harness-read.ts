import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readStableDescriptor, stableFileIdentity, StableDescriptorError } from '@openslack/core';

/** Safe startup diagnosis; never carries a configured path or raw OS error. */
export class HarnessRootUnsafeError extends Error {
  readonly code = 'HARNESS_ROOT_UNSAFE';
  constructor() { super('Harness root cannot traverse a directory link; select an approved physical path.'); this.name = 'HarnessRootUnsafeError'; }
}

/** Normalize trusted Windows spelling only after rejecting each lexical directory link. */
export function canonicalHarnessRoot(root: string): string {
  const path = resolve(root);
  for (let current = path;; current = dirname(current)) {
    const stamp = lstatSync(current);
    if (!stamp.isDirectory() || stamp.isSymbolicLink()) throw new HarnessRootUnsafeError();
    if (current === dirname(current)) break;
  }
  return process.platform === 'win32' ? realpathSync.native(path) : path;
}

/** Stable descriptor bytes; path/link policies remain local to the runtime owner. */
export function withHarnessDescriptor<T>(path: string, maxBytes: number,
  options: { trustedArtifact?: boolean; allowEmpty?: boolean }, read: (descriptor: number) => T): T {
  const parents: Array<{ path: string; dev: number; ino: number; mode: number }> = [];
  for (let parent = dirname(resolve(path));; parent = dirname(parent)) {
    const stamp = lstatSync(parent);
    if (!stamp.isDirectory() || stamp.isSymbolicLink()) throw new Error('Harness file traverses a directory link');
    parents.push({ path: parent, dev: stamp.dev, ino: stamp.ino, mode: stamp.mode });
    if (parent === dirname(parent)) break;
  }
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || (!options.trustedArtifact && entry.nlink !== 1)) {
    throw new Error('Harness file is not an owned regular file');
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (stableFileIdentity(entry) !== stableFileIdentity(before)) throw new StableDescriptorError('IDENTITY_CHANGED');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || before.size > maxBytes || (!before.size && options.allowEmpty === false)) {
      throw new StableDescriptorError('SIZE_INVALID');
    }
    const bytes = read(descriptor);
    if (stableFileIdentity(fstatSync(descriptor)) !== stableFileIdentity(before)) throw new StableDescriptorError('IDENTITY_CHANGED');
    if (stableFileIdentity(lstatSync(path)) !== stableFileIdentity(before)) throw new StableDescriptorError('IDENTITY_CHANGED');
    for (const parent of parents) {
      const now = lstatSync(parent.path);
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== parent.dev || now.ino !== parent.ino || now.mode !== parent.mode) {
        throw new StableDescriptorError('IDENTITY_CHANGED');
      }
    }
    return bytes;
  } finally { closeSync(descriptor); }
}

/** Stable descriptor bytes; no portable-fixture helper is used as runtime authority. */
export function readHarnessFile(path: string, maxBytes: number,
  options: { trustedArtifact?: boolean; allowEmpty?: boolean } = {}): Buffer {
  return withHarnessDescriptor(path, maxBytes, options, descriptor => readStableDescriptor(descriptor, maxBytes, options.allowEmpty !== false));
}
