import { readStableDescriptor, stableFileIdentity, StableDescriptorError } from '@openslack/core';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';

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

export function readStableLocalUtf8(path: string, options: StableLocalUtf8Options): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    const before = fstatSync(descriptor);
    const bytes = readStableDescriptor(descriptor, options.maxBytes, options.allowEmpty ?? false);
    const after = fstatSync(descriptor);
    const pathIdentity = lstatSync(path);
    if (
      pathIdentity.isSymbolicLink() ||
      stableFileIdentity(before) !== stableFileIdentity(after) ||
      stableFileIdentity(after) !== stableFileIdentity(pathIdentity)
    )
      throw new StableLocalFileError('IDENTITY_CHANGED');

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
    if (error instanceof StableDescriptorError) throw new StableLocalFileError(error.code);
    if (error instanceof StableLocalFileError) throw error;
    throw new StableLocalFileError('READ_FAILED');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
