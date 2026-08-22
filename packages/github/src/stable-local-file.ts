import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

export type StableLocalFileFailureCode =
  | 'MISSING'
  | 'NOT_REGULAR'
  | 'SIZE_INVALID'
  | 'IDENTITY_CHANGED'
  | 'INVALID_UTF8'
  | 'READ_FAILED';

export class StableLocalFileError extends Error {
  constructor(readonly code: StableLocalFileFailureCode) {
    super(code);
    this.name = 'StableLocalFileError';
  }
}

export interface StableLocalUtf8Options {
  maxBytes: number;
  required?: boolean;
  allowEmpty?: boolean;
}

function sameFileIdentity(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.ctimeMs === right.ctimeMs &&
    left.mtimeMs === right.mtimeMs
  );
}

export function readStableLocalUtf8(path: string, options: StableLocalUtf8Options): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new StableLocalFileError('NOT_REGULAR');
    if (
      before.size > options.maxBytes ||
      before.size < 0 ||
      (!options.allowEmpty && before.size === 0)
    ) {
      throw new StableLocalFileError('SIZE_INVALID');
    }

    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) break;
      offset += count;
    }

    const after = fstatSync(descriptor);
    const pathIdentity = lstatSync(path);
    if (
      offset !== bytes.byteLength ||
      pathIdentity.isSymbolicLink() ||
      !sameFileIdentity(before, after) ||
      !sameFileIdentity(after, pathIdentity)
    ) {
      throw new StableLocalFileError('IDENTITY_CHANGED');
    }

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new StableLocalFileError('INVALID_UTF8');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      if (!options.required) return null;
      throw new StableLocalFileError('MISSING');
    }
    if (error instanceof StableLocalFileError) throw error;
    throw new StableLocalFileError('READ_FAILED');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
