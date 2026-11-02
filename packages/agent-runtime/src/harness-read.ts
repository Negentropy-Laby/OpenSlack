import { lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { withOwnedFileDescriptor, readOwnedFile } from '@openslack/core/internal/owned-file';

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
  return withOwnedFileDescriptor(path, maxBytes, { artifactLinks: options.trustedArtifact, allowEmpty: options.allowEmpty }, read);
}

/** Stable descriptor bytes; no portable-fixture helper is used as runtime authority. */
export function readHarnessFile(path: string, maxBytes: number,
  options: { trustedArtifact?: boolean; allowEmpty?: boolean } = {}): Buffer {
  return readOwnedFile(path, maxBytes, { artifactLinks: options.trustedArtifact, allowEmpty: options.allowEmpty });
}
