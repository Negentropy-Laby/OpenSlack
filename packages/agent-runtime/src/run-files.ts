import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, fsyncSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readStableDescriptor, StableDescriptorError } from '@openslack/core';
import { validateRunId } from './run-id.js';
import { isCode } from './io-errors.js';

export const RUN_SNAPSHOT_MAX_BYTES = 512 * 1024;
export const RUN_TRANSACTION_LOCK = 'run.transaction.lock';
export const RUN_MAINTENANCE_BARRIER = 'run.maintenance.json';
export const runBase = (root?: string): string => join(root ?? process.cwd(), '.openslack.local', 'agents', 'runs');
export function runDirectory(runId: string, root?: string): string { validateRunId(runId); return join(runBase(root), runId); }
export const runSha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

export class RunStateSnapshotChangedError extends Error {
  readonly code = 'RUN_STATE_SNAPSHOT_CHANGED';
  constructor(readonly runId: string) { super(`Run metadata for ${runId} changed during read.`); this.name = 'RunStateSnapshotChangedError'; }
}
export class RunStateInvalidError extends Error {
  readonly code = 'RUN_STATE_INVALID';
  constructor(readonly runId: string, reason: string) {
    super(`Corrupted run metadata for ${runId}: ${reason}`); this.name = 'RunStateInvalidError';
  }
}
export class RunPersistenceError extends Error {
  constructor(readonly code: 'RUN_STATE_BUSY' | 'RUN_TRANSACTION_REENTRY' | 'RUN_PERSISTENCE_INDETERMINATE' |
    'RUN_INITIALIZATION_INCOMPLETE' | 'RUN_MAINTENANCE_REQUIRED' | 'RUN_TRANSCRIPT_LIMIT', message: string) {
    super(message); this.name = 'RunPersistenceError';
  }
}

/** The caller's trusted root may have platform aliases above it. Its protected
 * descendants may not be links. This is intentionally not Harness root policy. */
export function inspectRunDirectories(root: string | undefined, runId?: string, create = false): boolean {
  if (runId !== undefined) validateRunId(runId);
  let current = resolve(root ?? process.cwd());
  if (create && !runEntryExists(current)) mkdirSync(current, { recursive: true, mode: 0o700 });
  for (const part of ['', '.openslack.local', 'agents', 'runs', ...(runId ? [runId] : [])]) {
    if (part) current = join(current, part);
    try {
      if (create && part) { try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if (!isCode(error, 'EEXIST')) throw error; } }
      const entry = lstatSync(current);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Run storage is not an owned directory.');
    } catch (error) { if (!create && isCode(error, 'ENOENT')) return false; throw error; }
  }
  return true;
}

/** Bind protected directory identities, not only their current pathname types. */
export function captureRunDirectories(root: string | undefined, runId: string): () => void {
  validateRunId(runId);
  return captureStorageDirectories(root, ['.openslack.local', 'agents', 'runs', runId], runId);
}

/** Caller chooses the protected subtree; no path/link policy is inferred from a byte reader. */
export function captureStorageDirectories(root: string | undefined, parts: readonly string[], runId: string): () => void {
  if (parts.some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) throw new TypeError('Invalid storage path component.');
  let path = resolve(root ?? process.cwd());
  const captured: Array<{ path: string; dev: bigint; ino: bigint; mode: bigint; uid: bigint; gid: bigint }> = [];
  for (const part of ['', ...parts]) {
    if (part) path = join(path, part);
    const stamp = lstatSync(path, { bigint: true });
    if (!stamp.isDirectory() || stamp.isSymbolicLink()) throw new Error('Run storage is not an owned directory.');
    captured.push({ path, dev: stamp.dev, ino: stamp.ino, mode: stamp.mode, uid: stamp.uid, gid: stamp.gid });
  }
  return () => {
    for (const before of captured) {
      const now = lstatSync(before.path, { bigint: true });
      if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== before.dev || now.ino !== before.ino ||
        now.mode !== before.mode || now.uid !== before.uid || now.gid !== before.gid) throw new RunStateSnapshotChangedError(runId);
    }
  };
}

/** Absence only means an actual ENOENT, never permission failure or unsafe data. */
export function runEntryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if (isCode(error, 'ENOENT')) return false; throw error; }
}

/** Reuse Core's size-proportional byte reader, retaining this owner's bigint
 * nanosecond and pathname/FD/link checks around it. No millisecond downgrade. */
export function readRunBytes(path: string, maxBytes: number, runId: string, expectedLinks = 1): Buffer {
  if (!Number.isSafeInteger(expectedLinks) || expectedLinks < 1 || expectedLinks > 2) throw new TypeError('Invalid owned file link count.');
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== BigInt(expectedLinks)) throw new Error('Run file is not an owned regular file.');
  if (entry.size > BigInt(maxBytes)) throw new Error(`Run metadata for ${runId} exceeds the read bound.`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (entry.dev !== before.dev || entry.ino !== before.ino || entry.mode !== before.mode || entry.size !== before.size ||
      entry.nlink !== before.nlink || entry.mtimeNs !== before.mtimeNs || entry.ctimeNs !== before.ctimeNs) throw new RunStateSnapshotChangedError(runId);
    let bytes: Buffer;
    try { bytes = readStableDescriptor(fd, maxBytes); }
    catch (error) { if (error instanceof StableDescriptorError) throw new RunStateSnapshotChangedError(runId); throw error; }
    const after = fstatSync(fd, { bigint: true });
    const now = lstatSync(path, { bigint: true });
    for (const stamp of [after, now]) {
      if (!stamp.isFile() || stamp.isSymbolicLink() || stamp.nlink !== BigInt(expectedLinks) || before.dev !== stamp.dev || before.ino !== stamp.ino ||
        before.mode !== stamp.mode || before.size !== stamp.size || before.mtimeNs !== stamp.mtimeNs || before.ctimeNs !== stamp.ctimeNs) {
        throw new RunStateSnapshotChangedError(runId);
      }
    }
    return bytes;
  } finally { closeSync(fd); }
}

export function writeRunExclusive(path: string, bytes: Uint8Array | string): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
