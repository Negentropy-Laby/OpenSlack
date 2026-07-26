import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';

export const MCP_MAX_LOCAL_FILE_BYTES = 2 * 1024 * 1024;
export const MCP_MAX_LOCAL_DIRECTORY_ITEMS = 1_000;
export const MCP_MAX_LOCAL_JSONL_LINES = 10_000;

export class LocalReadBoundError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'LocalReadBoundError';
  }
}

export function readBoundedTextFileSync(path: string, maxBytes = MCP_MAX_LOCAL_FILE_BYTES): string {
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new LocalReadBoundError('LOCAL_INPUT_NOT_REGULAR_FILE');
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== entry.dev ||
      before.ino !== entry.ino ||
      before.mode !== entry.mode ||
      before.size > BigInt(maxBytes)
    ) {
      throw new LocalReadBoundError('LOCAL_INPUT_IDENTITY_CHANGED');
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > maxBytes) throw new LocalReadBoundError('LOCAL_INPUT_TOO_LARGE');
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      BigInt(bytesRead) !== after.size
    ) {
      throw new LocalReadBoundError('LOCAL_INPUT_CHANGED_DURING_READ');
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new LocalReadBoundError('LOCAL_INPUT_INVALID_UTF8');
    }
  } finally {
    closeSync(descriptor);
  }
}

export function readBoundedJsonFileSync<T>(path: string, maxBytes = MCP_MAX_LOCAL_FILE_BYTES): T {
  return JSON.parse(readBoundedTextFileSync(path, maxBytes)) as T;
}

export function readBoundedJsonlFileSync<T>(
  path: string,
  options: {
    maxBytes?: number;
    maxLines?: number;
    maxItems?: number;
    accept?: (value: T) => boolean;
  } = {},
): T[] {
  const raw = readBoundedTextFileSync(path, options.maxBytes);
  const lines = raw.split('\n');
  const maxLines = options.maxLines ?? MCP_MAX_LOCAL_JSONL_LINES;
  const maxItems = options.maxItems ?? MCP_MAX_LOCAL_JSONL_LINES;
  if (lines.length > maxLines) throw new LocalReadBoundError('LOCAL_INPUT_TOO_MANY_LINES');
  const values: T[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: T;
    try {
      parsed = JSON.parse(line) as T;
    } catch {
      throw new LocalReadBoundError('LOCAL_INPUT_INVALID_JSONL');
    }
    if (options.accept && !options.accept(parsed)) {
      throw new LocalReadBoundError('LOCAL_INPUT_INVALID_ITEM');
    }
    values.push(parsed);
    if (values.length > maxItems) {
      throw new LocalReadBoundError('LOCAL_INPUT_TOO_MANY_ITEMS');
    }
  }
  return values;
}

export interface BoundedDirectoryFile {
  readonly name: string;
  readonly text: string;
}

export function readBoundedDirectoryFilesSync(
  directory: string,
  options: {
    extensions?: readonly string[];
    maxItems?: number;
    maxFileBytes?: number;
  } = {},
): readonly BoundedDirectoryFile[] {
  let before: BigIntStats;
  try {
    before = lstatSync(directory, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new LocalReadBoundError('LOCAL_INPUT_NOT_REGULAR_DIRECTORY');
  }
  let handle: ReturnType<typeof opendirSync>;
  try {
    handle = opendirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const maxItems = options.maxItems ?? MCP_MAX_LOCAL_DIRECTORY_ITEMS;
  const matchesExtension = (name: string) =>
    !options.extensions || options.extensions.some((extension) => name.endsWith(extension));
  const files: BoundedDirectoryFile[] = [];
  let seen = 0;
  try {
    for (;;) {
      const item = handle.readSync();
      if (!item) break;
      seen += 1;
      if (seen > maxItems) throw new LocalReadBoundError('LOCAL_INPUT_TOO_MANY_ITEMS');
      if (!matchesExtension(item.name)) continue;
      if (!item.isFile() || item.isSymbolicLink()) {
        throw new LocalReadBoundError('LOCAL_INPUT_NOT_REGULAR_FILE');
      }
      files.push({
        name: item.name,
        text: readBoundedTextFileSync(
          join(directory, item.name),
          options.maxFileBytes ?? MCP_MAX_LOCAL_FILE_BYTES,
        ),
      });
    }
  } finally {
    handle.closeSync();
  }
  let after: BigIntStats;
  try {
    after = lstatSync(directory, { bigint: true });
  } catch {
    throw new LocalReadBoundError('LOCAL_INPUT_CHANGED_DURING_READ');
  }
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new LocalReadBoundError('LOCAL_INPUT_CHANGED_DURING_READ');
  }
  return files;
}

export function preflightBoundedDirectorySync(
  directory: string,
  options: {
    extensions?: readonly string[];
    maxItems?: number;
    maxFileBytes?: number;
  } = {},
): readonly string[] {
  return readBoundedDirectoryFilesSync(directory, options).map((item) => item.name);
}
