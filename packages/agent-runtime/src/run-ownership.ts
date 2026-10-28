import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types as utilTypes } from 'node:util';
import { isCode } from './io-errors.js';
import { inspectRunDirectories, captureRunDirectories, RUN_MAINTENANCE_BARRIER, RUN_TRANSACTION_LOCK, runDirectory, runEntryExists,
  RunPersistenceError, writeRunExclusive, runSha256 } from './run-files.js';
import { ownRunWriterWitness, type RunWriterWitness } from './run-process-witness.js';

export interface RunStorageIntent {
  schema: 'openslack.run_intent.v2'; runId: string; transactionId: string; ownerGeneration: string; ownershipSha256: string;
  creationId?: string;
  operation: 'create' | 'update' | 'append' | 'recovery';
  base: { stateSha256: string | null; transactionId: string | null; revision: number | null;
    transcriptBytes: number; legacyPrefixSha256?: string };
  target: { stateSha256: string | null; revision: number | null; transcriptBytes: number; stateFile?: string; metadataFile?: string };
  metadataSha256: string | null;
  append: { bytes: number; sha256: string };
}
export interface RunOwnership {
  transactionId: string; ownerGeneration: string; directory: string;
  beforeWrite(): void;
  touch(): void;
  publishIntent(intent: Omit<RunStorageIntent, 'schema' | 'runId' | 'transactionId' | 'ownerGeneration' | 'operation' | 'ownershipSha256'>): void;
}
export interface RunOwnershipRecord {
  schema: 'openslack.run_transaction.v2'; runId: string; transactionId: string; ownerGeneration: string;
  operation: RunStorageIntent['operation']; writer?: RunWriterWitness;
}
const active = new Set<string>();

export function assertNoRunMaintenance(directory: string): void {
  if (runEntryExists(join(directory, RUN_MAINTENANCE_BARRIER))) {
    throw new RunPersistenceError('RUN_MAINTENANCE_REQUIRED', 'Run maintenance is unresolved; preserve and inspect without replay.');
  }
}

/** A single synchronous owner for create, standalone append and updates. No stale
 * lock removal, promise callbacks, recursive ownership or implicit maintenance. */
export function withRunOwnership<T>(root: string | undefined, runId: string, operation: RunStorageIntent['operation'],
  createDirectory: boolean, action: (owner: RunOwnership) => T): T {
  if (typeof action !== 'function' || utilTypes.isAsyncFunction(action)) throw new TypeError('Run ownership must be synchronous.');
  if (!inspectRunDirectories(root, runId, createDirectory)) throw new Error(`Run not found: ${runId}`);
  const verifyDirectories = captureRunDirectories(root, runId);
  const directory = runDirectory(runId, root), lockPath = join(directory, RUN_TRANSACTION_LOCK), key = resolve(lockPath);
  if (active.has(key)) throw new RunPersistenceError('RUN_TRANSACTION_REENTRY', 'Run transaction reentry is forbidden.');
  // A Windows CIM startup is bounded, cached and never paid while holding the run lock.
  const writer = ownRunWriterWitness();
  const until = performance.now() + 1000;
  let fd: number;
  while (true) {
    try { fd = openSync(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      if (performance.now() >= until) throw new RunPersistenceError('RUN_STATE_BUSY', 'Run transaction is busy; preserve and query without replay.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  active.add(key);
  let touched = false, succeeded = false;
  const record: RunOwnershipRecord = { schema: 'openslack.run_transaction.v2', runId, transactionId: randomUUID(),
    ownerGeneration: randomUUID(), operation, ...(writer ? { writer } : {}) };
  const lockBytes = JSON.stringify(record);
  let primaryFailed = false;
  let primaryError: unknown;
  const secondaryFailure = () => {
    if (primaryError && typeof primaryError === 'object') {
      try { Object.defineProperty(primaryError, 'persistenceDiagnostic', { value: 'RUN_OWNERSHIP_RETIREMENT_UNCONFIRMED', configurable: true }); }
      catch { /* A frozen primary error still wins. The owned lock remains evidence. */ }
    }
  };
  const verify = () => {
    verifyDirectories();
    const owned = fstatSync(fd, { bigint: true }), entry = lstatSync(lockPath, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || owned.dev !== entry.dev || owned.ino !== entry.ino || owned.mode !== entry.mode) {
      throw new RunPersistenceError('RUN_PERSISTENCE_INDETERMINATE', 'Run lock identity changed; preserve all evidence.');
    }
  };
  try {
    verify();
    assertNoRunMaintenance(directory);
    writeFileSync(fd, lockBytes); fsyncSync(fd);
    const owner: RunOwnership = { directory, transactionId: record.transactionId, ownerGeneration: record.ownerGeneration,
      beforeWrite() { verify(); assertNoRunMaintenance(directory); },
      touch() { touched = true; },
      publishIntent(intent) {
        this.beforeWrite(); touched = true;
        writeRunExclusive(join(directory, `run.intent.${record.transactionId}.json`), JSON.stringify({ ...intent,
          schema: 'openslack.run_intent.v2', runId, transactionId: record.transactionId, ownerGeneration: record.ownerGeneration,
          ownershipSha256: runSha256(lockBytes), operation }));
      },
    };
    const value = action(owner);
    if (value && typeof value === 'object' && 'then' in value) throw new TypeError('Run ownership callbacks cannot return a Promise.');
    succeeded = true;
    return value;
  } catch (error) {
    primaryFailed = true;
    primaryError = touched ? new RunPersistenceError(operation === 'create' ? 'RUN_INITIALIZATION_INCOMPLETE' : 'RUN_PERSISTENCE_INDETERMINATE',
      'Run publication is unconfirmed; preserve lock, intent, transcript and temporary evidence.') : error;
    throw primaryError;
  } finally {
    try {
      if (succeeded || !touched) {
        try { verify(); unlinkSync(lockPath); }
        catch {
          if (primaryFailed) secondaryFailure();
          else throw new RunPersistenceError('RUN_PERSISTENCE_INDETERMINATE', 'Run ownership retirement is unconfirmed; preserve and inspect.');
        }
      }
    } finally {
      try { closeSync(fd); }
      catch { if (primaryFailed) secondaryFailure(); else throw new RunPersistenceError('RUN_PERSISTENCE_INDETERMINATE', 'Run descriptor close is unconfirmed; preserve and inspect.'); }
      finally { active.delete(key); }
    }
  }
}
