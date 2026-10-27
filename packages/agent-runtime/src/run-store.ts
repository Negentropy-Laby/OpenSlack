import {
  existsSync, mkdirSync, readdirSync, lstatSync, fstatSync, fsyncSync, openSync, closeSync,
  readSync, renameSync, statSync, unlinkSync, writeFileSync, linkSync, constants,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder, types as utilTypes } from 'node:util';
import { performance } from 'node:perf_hooks';
import { scanValue } from '@openslack/collaboration';
import type { AgentRunFailureCode, AgentRunRequest, AgentRunState, AgentRunStatus, AgentRunEvent } from './types.js';
import { RUN_ID_RE, validateRunId } from './run-id.js';

export { RUN_ID_RE, validateRunId } from './run-id.js';
export const HARNESS_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
export const HARNESS_TERMINAL_RESERVE_BYTES = 64 * 1024;
const RUNS_DIR_NAME = 'agents/runs';
const ORPHAN_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const RUN_TEMP_FILE_RE = /^(?:run|metadata)\.json\..+\.tmp$/;
const DEFAULT_RUN_SNAPSHOT_MAX_BYTES = 512 * 1024;
const TRANSACTION_LOCK = 'run.transaction.lock';
const activeTransactions = new Set<string>();

function getRunsBaseDir(root?: string): string { return join(root ?? process.cwd(), '.openslack.local', RUNS_DIR_NAME); }
function getRunDir(id: string, root?: string): string { return join(getRunsBaseDir(root), id); }
function getRunMetaPath(id: string, root?: string): string { return join(getRunDir(id, root), 'run.json'); }
function ensureDir(dir: string): void { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }

export function generateRunId(): string {
  return `RUN-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

export interface RunTransactionUpdate {
  patch?: Partial<AgentRunState>; events?: readonly AgentRunEvent[];
  /** Trusted synchronous restriction, rechecked after scanning/encoding and before any append/publication. */
  beforePublish?(): void;
}
export interface AgentRunStore {
  createRun(request: AgentRunRequest): AgentRunState;
  createFailedRun(request: AgentRunRequest, failure: { failureCode: AgentRunFailureCode; errorSummary: string }): AgentRunState;
  updateRun(runId: string, patch: Partial<AgentRunState>): AgentRunState;
  /** No async/reentry. State-derived patches and intended events are computed under one owned lock. */
  withRunTransaction(runId: string, update: (current: Readonly<AgentRunState>) => RunTransactionUpdate): AgentRunState;
  getRun(runId: string): AgentRunState | null;
  listRuns(options?: { agentId?: string; status?: AgentRunStatus }): AgentRunState[];
}
export interface SweepOrphanRunTempOptions { olderThanMs?: number; nowMs?: number }
export interface ReadRunStateSnapshotOptions { maxBytes?: number }

/** A rejected snapshot, never partial data; observation performs no repair. */
export class RunStateSnapshotChangedError extends Error {
  readonly code = 'RUN_STATE_SNAPSHOT_CHANGED';
  constructor(readonly runId: string) { super(`Run metadata for ${runId} changed during read.`); this.name = 'RunStateSnapshotChangedError'; }
}
export class RunPersistenceError extends Error {
  constructor(readonly code: 'RUN_STATE_BUSY' | 'RUN_TRANSACTION_REENTRY' | 'RUN_PERSISTENCE_INDETERMINATE' | 'RUN_TRANSCRIPT_LIMIT', message: string) {
    super(message); this.name = 'RunPersistenceError';
  }
}

function transcriptLength(runId: string, root?: string): number {
  const path = join(getRunDir(runId, root), 'transcript.jsonl');
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('Run transcript is not an owned regular file.');
    return entry.size;
  } catch (error) { if (isCode(error, 'ENOENT')) return 0; throw error; }
}

/** Only the owning transaction may read past its own acquired lock. */
function readSnapshot(runId: string, root: string | undefined, maxBytes: number, owned = false): AgentRunState | null {
  const lock = join(getRunDir(runId, root), TRANSACTION_LOCK);
  if (!owned && existsSync(lock)) throw new RunStateSnapshotChangedError(runId);
  const path = getRunMetaPath(runId, root);
  if (!existsSync(path)) return null;
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Run metadata for ${runId} is not a regular file.`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (before.size > BigInt(maxBytes)) throw new Error(`Run metadata for ${runId} exceeds the read bound.`);
    if (before.dev !== entry.dev || before.ino !== entry.ino || before.mode !== entry.mode) throw new RunStateSnapshotChangedError(runId);
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
    if (count > maxBytes) throw new Error(`Run metadata for ${runId} exceeds the read bound.`);
    const after = fstatSync(fd, { bigint: true });
    const currentEntry = lstatSync(path, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
      before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.nlink !== after.nlink ||
      BigInt(count) !== after.size || currentEntry.dev !== before.dev || currentEntry.ino !== before.ino || currentEntry.mode !== before.mode) {
      throw new RunStateSnapshotChangedError(runId);
    }
    let state: AgentRunState;
    try { state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))) as AgentRunState; }
    catch { throw new Error(`Corrupted run metadata for ${runId}: failed to parse run.json`); }
    if (state.runId !== runId) throw new Error(`Corrupted run metadata for ${runId}: run ID does not match the file path`);
    if (state.persistence && (!Number.isSafeInteger(state.persistence.revision) || state.persistence.revision < 0 ||
      !Number.isSafeInteger(state.persistence.transcriptBytes) || state.persistence.transcriptBytes < 0 ||
      transcriptLength(runId, root) !== state.persistence.transcriptBytes)) throw new RunStateSnapshotChangedError(runId);
    if (!owned && existsSync(lock)) throw new RunStateSnapshotChangedError(runId);
    return state;
  } finally { closeSync(fd); }
}

export function readRunStateSnapshot(runId: string, root?: string, options: ReadRunStateSnapshotOptions = {}): AgentRunState | null {
  validateRunId(runId);
  const max = options.maxBytes ?? DEFAULT_RUN_SNAPSHOT_MAX_BYTES;
  if (!Number.isSafeInteger(max) || max < 1 || max > 2 * 1024 * 1024) throw new TypeError('maxBytes must be an integer between 1 and 2097152.');
  return readSnapshot(runId, root, max);
}

/** Yield for a bounded legitimate writer, without repairing an orphan lock or accepting damaged bytes. */
export async function readRunStateSnapshotWhenAvailable(runId: string, root: string,
  deadlineAt = Date.now() + 1000): Promise<AgentRunState | null> {
  const until = Math.min(Date.now() + 1000, deadlineAt);
  while (true) {
    try { return readRunStateSnapshot(runId, root); }
    catch (error) {
      if (!(error instanceof RunStateSnapshotChangedError) || error.runId !== runId || Date.now() >= until) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
  }
}

/** Never sweep temporary evidence belonging to an unresolved transaction. */
export function sweepOrphanRunTempFiles(root?: string, options: SweepOrphanRunTempOptions = {}): number {
  const base = getRunsBaseDir(root);
  if (!existsSync(base)) return 0;
  const cutoff = (options.nowMs ?? Date.now()) - (options.olderThanMs ?? ORPHAN_TEMP_MAX_AGE_MS);
  let removed = 0;
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue;
    const directory = join(base, entry.name);
    if (existsSync(join(directory, TRANSACTION_LOCK))) continue;
    let files;
    try { files = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !RUN_TEMP_FILE_RE.test(file.name)) continue;
      try { if (statSync(join(directory, file.name)).mtimeMs > cutoff) continue; unlinkSync(join(directory, file.name)); removed++; } catch { /* A concurrent owner may hold it. */ }
    }
  }
  return removed;
}

function scanned(value: unknown, label: string): void {
  const result = scanValue(value, label);
  if (result.found) throw new Error(`${label} contains ${result.name} at ${result.path}. Refusing to persist.`);
}
function stableJson(value: unknown): string { return JSON.stringify(value, null, 2); }
function isCode(value: unknown, code: string): boolean { return !!value && typeof value === 'object' && 'code' in value && value.code === code; }

export function createRunStore(root?: string, options: { sweepOrphans?: boolean } = {}): AgentRunStore {
  const base = getRunsBaseDir(root);
  if (options.sweepOrphans !== false) sweepOrphanRunTempFiles(root);
  const create = (request: AgentRunRequest, failure?: { failureCode: AgentRunFailureCode; errorSummary: string }): AgentRunState => {
    const runId = request.runId || generateRunId();
    validateRunId(runId);
    const now = new Date().toISOString();
    const state: AgentRunState = { runId, status: failure ? 'failed' : 'pending', agentId: request.agentId, model: request.resolvedConfig.model,
      startedAt: now, tokensUsed: 0, tokensRemaining: request.budget?.tokens ?? null, toolCalls: 0, worktreePath: request.worktreePath,
      transcriptPath: join(getRunDir(runId, root), 'transcript.jsonl'), persistence: { revision: 0, transcriptBytes: 0 },
      ...(failure ? { ...failure, error: failure.errorSummary, completedAt: now } : {}),
    };
    const config = { ...request.resolvedConfig };
    delete config.prompt; delete config.initialPrompt; delete config.criticalSystemReminder;
    const metadata = { runId, agentId: request.agentId, resolvedConfig: config, permissionProfile: request.permissionProfile,
      budget: request.budget, correlationId: request.correlationId, threadId: request.threadId, worktreePath: request.worktreePath };
    scanned(state, 'Run state'); scanned(metadata, 'Run metadata');
    const directory = getRunDir(runId, root);
    ensureDir(directory);
    if (existsSync(join(directory, 'run.json')) || existsSync(join(directory, 'metadata.json')) || transcriptLength(runId, root) !== 0) throw new Error(`Run already exists: ${runId}`);
    const paths = [join(directory, 'metadata.json'), join(directory, 'run.json')];
    const values = [metadata, state];
    for (let i = 0; i < paths.length; i++) {
      const target = paths[i]!;
      const temporary = `${target}.${process.pid}-${randomUUID()}.tmp`;
      const file = openSync(temporary, 'wx', 0o600);
      try { writeFileSync(file, stableJson(values[i])); fsyncSync(file); } finally { closeSync(file); }
      linkSync(temporary, target); unlinkSync(temporary);
    }
    return state;
  };

  const withRunTransaction: AgentRunStore['withRunTransaction'] = (runId, update) => {
    validateRunId(runId);
    if (typeof update !== 'function' || utilTypes.isAsyncFunction(update)) throw new TypeError('Run transactions must be synchronous.');
    const directory = getRunDir(runId, root);
    const lockPath = join(directory, TRANSACTION_LOCK);
    const key = resolve(lockPath);
    if (activeTransactions.has(key)) throw new RunPersistenceError('RUN_TRANSACTION_REENTRY', 'Run transaction reentry is forbidden.');
    let lock: number;
    const until = performance.now() + 1000;
    while (true) {
      try { lock = openSync(lockPath, 'wx', 0o600); break; }
      catch (error) {
        if (!isCode(error, 'EEXIST')) throw error;
        if (performance.now() >= until) throw new RunPersistenceError('RUN_STATE_BUSY', 'Run transaction is busy; preserve and query without replay.');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    activeTransactions.add(key);
    let touched = false;
    let committed = false;
    try {
      writeFileSync(lock, JSON.stringify({ schema: 'openslack.run_transaction.v1', runId, transactionId: randomUUID(), ownerPid: process.pid }));
      fsyncSync(lock);
      const current = readSnapshot(runId, root, DEFAULT_RUN_SNAPSHOT_MAX_BYTES, true);
      if (!current) throw new Error(`Run not found: ${runId}`);
      const change = update(structuredClone(current));
      if (!change || typeof change !== 'object' || 'then' in change) throw new TypeError('Run transactions cannot return a Promise.');
      if (change.beforePublish && (typeof change.beforePublish !== 'function' || utilTypes.isAsyncFunction(change.beforePublish))) throw new TypeError('Run publication guards must be synchronous.');
      const checkPublication = () => {
        const result: unknown = change.beforePublish?.();
        if (result && typeof result === 'object' && 'then' in result) throw new TypeError('Run publication guards cannot return a Promise.');
      };
      const events = change.events ?? [];
      if (!change.patch && !events.length) { checkPublication(); committed = true; return current; }
      for (const event of events) scanned(event, 'Transcript event');
      const bytes = Buffer.from(events.map(event => JSON.stringify(event) + '\n').join(''), 'utf8');
      const length = transcriptLength(runId, root) + bytes.length;
      const updated: AgentRunState = { ...current, ...change.patch, persistence: {
        revision: (current.persistence?.revision ?? 0) + 1, transcriptBytes: length,
      } };
      if (updated.runId !== runId) throw new Error('Run transaction cannot change run identity.');
      if (updated.harnessExecution) {
        const terminal = events.length > 0 && events.every(event => ['fail', 'cancel', 'complete'].includes(event.type));
        const evidence = updated.harnessExecution.evidence ?? { reservedBytes: 0, calls: {} };
        const terminalBytes = (current.harnessExecution?.evidence?.terminalBytes ?? 0) + (terminal ? bytes.length : 0);
        if (!Number.isSafeInteger(terminalBytes) || terminalBytes > HARNESS_TERMINAL_RESERVE_BYTES ||
          !Number.isSafeInteger(evidence.reservedBytes) || evidence.reservedBytes < 0 || length > HARNESS_TRANSCRIPT_MAX_BYTES ||
          length + evidence.reservedBytes > HARNESS_TRANSCRIPT_MAX_BYTES - HARNESS_TERMINAL_RESERVE_BYTES + terminalBytes) {
          throw new RunPersistenceError('RUN_TRANSCRIPT_LIMIT', 'Harness evidence capacity must be reserved before effects.');
        }
        updated.harnessExecution = { ...updated.harnessExecution, evidence: { ...evidence, terminalBytes } };
      }
      scanned(updated, 'Run state update');
      const stateBytes = Buffer.from(stableJson(updated));
      if (stateBytes.length > DEFAULT_RUN_SNAPSHOT_MAX_BYTES) throw new Error('Run metadata exceeds the read bound.');
      checkPublication();
      if (bytes.length) {
        const transcript = join(directory, 'transcript.jsonl');
        if (existsSync(transcript)) transcriptLength(runId, root);
        const fd = openSync(transcript, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
        try { touched = true; writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      }
      const path = getRunMetaPath(runId, root);
      const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
      const file = openSync(temporary, 'wx', 0o600);
      try { touched = true; writeFileSync(file, stateBytes); fsyncSync(file); } finally { closeSync(file); }
      checkPublication();
      renameSync(temporary, path);
      committed = true;
      return updated;
    } catch (error) {
      if (touched) throw new RunPersistenceError('RUN_PERSISTENCE_INDETERMINATE', 'Run publication is unconfirmed; preserve lock, transcript and temporary evidence.');
      throw error;
    } finally {
      try {
        if (committed || !touched) {
          const owned = fstatSync(lock!);
          const entry = lstatSync(lockPath);
          if (!entry.isFile() || entry.isSymbolicLink() || owned.dev !== entry.dev || owned.ino !== entry.ino) throw new RunPersistenceError('RUN_PERSISTENCE_INDETERMINATE', 'Run transaction lock ownership changed; preserve evidence.');
          unlinkSync(lockPath);
        }
      } finally { closeSync(lock!); activeTransactions.delete(key); }
    }
  };

  return {
    createRun: request => create(request), createFailedRun: (request, failure) => create(request, failure), withRunTransaction,
    updateRun: (runId, patch) => withRunTransaction(runId, () => ({ patch })),
    getRun: runId => readRunStateSnapshot(runId, root),
    listRuns(filter) {
      if (!existsSync(base)) return [];
      const result: AgentRunState[] = [];
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue;
        const state = readRunStateSnapshot(entry.name, root);
        if (state && (!filter?.agentId || state.agentId === filter.agentId) && (!filter?.status || state.status === filter.status)) result.push(state);
      }
      return result.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },
  };
}
