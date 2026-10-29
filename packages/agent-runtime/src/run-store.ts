import {
  existsSync, readdirSync, lstatSync, fstatSync, fsyncSync, openSync, closeSync,
  renameSync, statSync, unlinkSync, writeFileSync, linkSync, constants,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder, types as utilTypes } from 'node:util';
import { performance } from 'node:perf_hooks';
import { scanValue } from '@openslack/collaboration';
import type { AgentRunFailureCode, AgentRunRequest, AgentRunState, AgentRunStatus, AgentRunEvent } from './types.js';
import { RUN_ID_RE, validateRunId } from './run-id.js';
import { readRunBytes, runSha256, inspectRunDirectories, captureRunDirectories, runEntryExists, RUN_TRANSACTION_LOCK, RUN_MAINTENANCE_BARRIER,
  RunStateSnapshotChangedError, RunStateInvalidError, RunPersistenceError, writeRunExclusive } from './run-files.js';
import { withRunOwnership, type RunOwnership } from './run-ownership.js';
import { isCode } from './io-errors.js';
import { digestStableDescriptor } from '@openslack/core';

export { RunStateSnapshotChangedError, RunStateInvalidError, RunPersistenceError } from './run-files.js';

export { RUN_ID_RE, validateRunId } from './run-id.js';
export const HARNESS_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
export const HARNESS_TERMINAL_RESERVE_BYTES = 64 * 1024;
const RUNS_DIR_NAME = 'agents/runs';
const ORPHAN_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const RUN_TEMP_FILE_RE = /^(?:run|metadata)\.json\..+\.tmp$/;
const DEFAULT_RUN_SNAPSHOT_MAX_BYTES = 512 * 1024;
const TRANSACTION_LOCK = RUN_TRANSACTION_LOCK;

function getRunsBaseDir(root?: string): string { return join(root ?? process.cwd(), '.openslack.local', RUNS_DIR_NAME); }
function getRunDir(id: string, root?: string): string { return join(getRunsBaseDir(root), id); }
function getRunMetaPath(id: string, root?: string): string { return join(getRunDir(id, root), 'run.json'); }

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
  /** Internal shared owner used by the existing public transcript function. */
  appendEvent(runId: string, event: AgentRunEvent): void;
  /** Strict current state. Unavailable evidence is never downgraded to creation/execution permission. */
  readRun(runId: string): AgentRunState | null;
  observeRun(runId: string): RunObservation;
  listRunObservations(options?: { agentId?: string; status?: AgentRunStatus }): RunListing;
  /** Compatibility observation only. Use readRun/transactions for execution decisions. */
  getRun(runId: string): AgentRunState | null;
  listRuns(options?: { agentId?: string; status?: AgentRunStatus }): AgentRunState[];
}
export interface SweepOrphanRunTempOptions { olderThanMs?: number; nowMs?: number }
export interface ReadRunStateSnapshotOptions { maxBytes?: number }
export type RunUnavailableReason = 'locked' | 'creation-incomplete' | 'corrupt' | 'unsafe' | 'persistence-unconfirmed';
export type RunObservation = Readonly<{ kind: 'ready'; runId: string; state: AgentRunState } |
  { kind: 'missing'; runId: string } | { kind: 'unavailable'; runId: string; reason: RunUnavailableReason }>;
export interface RunListing { runs: AgentRunState[]; unavailable: Array<Extract<RunObservation, { kind: 'unavailable' }>>; storageIssue?: 'unreadable' | 'unsafe' }
export interface WaitRunSnapshotOptions { waitMs?: number; signal?: AbortSignal }

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
  if (!inspectRunDirectories(root, runId)) return null;
  const verifyDirectories = captureRunDirectories(root, runId);
  const lock = join(getRunDir(runId, root), TRANSACTION_LOCK);
  const barrier = join(getRunDir(runId, root), RUN_MAINTENANCE_BARRIER);
  if (runEntryExists(barrier) || (!owned && runEntryExists(lock))) throw new RunStateSnapshotChangedError(runId);
  const path = getRunMetaPath(runId, root);
  if (!runEntryExists(path)) {
    if (runEntryExists(join(getRunDir(runId, root), 'metadata.json')) ||
      (!owned && readdirSync(getRunDir(runId, root)).length > 0)) throw new RunPersistenceError('RUN_INITIALIZATION_INCOMPLETE', 'Run creation is incomplete; inspect without replay.');
    verifyDirectories();
    return null;
  }
  const state = decodeRunState(readRunBytes(path, maxBytes, runId), runId);
  if (state.persistence && transcriptLength(runId, root) !== state.persistence.transcriptBytes) throw new RunStateSnapshotChangedError(runId);
  if (state.persistence?.metadataSha256) {
    if (runSha256(readRunBytes(join(getRunDir(runId, root), 'metadata.json'), maxBytes, runId)) !== state.persistence.metadataSha256) throw new RunStateSnapshotChangedError(runId);
  }
  verifyDirectories();
  if (runEntryExists(barrier) || (!owned && runEntryExists(lock))) throw new RunStateSnapshotChangedError(runId);
  return state;
}

/** Structural current-state validation is shared with pure maintenance inspection. */
export function decodeRunState(bytes: Uint8Array, runId: string): AgentRunState {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RunStateInvalidError(runId, 'failed to parse run.json'); }
  if (!value || typeof value !== 'object' || !('runId' in value) || value.runId !== runId) throw new RunStateInvalidError(runId, 'run ID does not match the file path');
  const state = value as AgentRunState;
  if (state.persistence !== undefined && (!state.persistence || typeof state.persistence !== 'object' || Array.isArray(state.persistence) ||
    (state.persistence.schemaVersion !== undefined && state.persistence.schemaVersion !== 2))) throw new RunStateInvalidError(runId, 'unsupported persistence format');
  if (!['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'].includes(state.status) ||
    typeof state.agentId !== 'string' || !state.agentId || typeof state.startedAt !== 'string' || !Number.isFinite(Date.parse(state.startedAt)) ||
    typeof state.transcriptPath !== 'string' || !Number.isSafeInteger(state.tokensUsed) || state.tokensUsed < 0 ||
    (state.tokensRemaining !== null && !Number.isSafeInteger(state.tokensRemaining)) || !Number.isSafeInteger(state.toolCalls) || state.toolCalls < 0 ||
    (state.completedAt !== undefined && (typeof state.completedAt !== 'string' || !Number.isFinite(Date.parse(state.completedAt)))) ||
    (state.persistence && (!Number.isSafeInteger(state.persistence.revision) || state.persistence.revision < 0 ||
      !Number.isSafeInteger(state.persistence.transcriptBytes) || state.persistence.transcriptBytes < 0))) throw new RunStateInvalidError(runId, 'invalid state fields');
  if (state.persistence?.schemaVersion === 2 && (typeof state.persistence.transactionId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(state.persistence.transactionId) || typeof state.persistence.creationId !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(state.persistence.creationId) || typeof state.persistence.metadataSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(state.persistence.metadataSha256))) {
    throw new RunStateInvalidError(runId, 'invalid persistence identity');
  }
  return state;
}

export function readRunStateSnapshot(runId: string, root?: string, options: ReadRunStateSnapshotOptions = {}): AgentRunState | null {
  validateRunId(runId);
  const max = options.maxBytes ?? DEFAULT_RUN_SNAPSHOT_MAX_BYTES;
  if (!Number.isSafeInteger(max) || max < 1 || max > 2 * 1024 * 1024) throw new TypeError('maxBytes must be an integer between 1 and 2097152.');
  return readSnapshot(runId, root, max);
}

/** Yield for a bounded legitimate writer, without repairing an orphan lock or accepting damaged bytes. */
export async function readRunStateSnapshotWhenAvailable(runId: string, root: string,
  options: WaitRunSnapshotOptions = {}): Promise<AgentRunState | null> {
  const waitMs = options.waitMs ?? 1000;
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 2_147_483_647) throw new TypeError('Run read wait must be a finite bounded duration.');
  const until = performance.now() + waitMs;
  while (true) {
    options.signal?.throwIfAborted();
    try { return readRunStateSnapshot(runId, root); }
    catch (error) {
      if (!(error instanceof RunStateSnapshotChangedError) || error.runId !== runId || performance.now() >= until) throw error;
      await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(options.signal?.reason); };
        const timer = setTimeout(finish, Math.max(1, Math.min(5, until - performance.now())));
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
      });
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
    if (existsSync(join(directory, TRANSACTION_LOCK)) || existsSync(join(directory, RUN_MAINTENANCE_BARRIER))) continue;
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

function legacyTranscriptDigest(runId: string, root?: string): string {
  const path = join(getRunDir(runId, root), 'transcript.jsonl');
  if (!runEntryExists(path)) return runSha256('');
  const entry = lstatSync(path, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) throw new Error('Run transcript is not an owned regular file.');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd, { bigint: true });
    if (entry.dev !== before.dev || entry.ino !== before.ino || entry.mtimeNs !== before.mtimeNs || entry.ctimeNs !== before.ctimeNs) throw new RunStateSnapshotChangedError(runId);
    const result = digestStableDescriptor(fd, HARNESS_TRANSCRIPT_MAX_BYTES);
    const after = lstatSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new RunStateSnapshotChangedError(runId);
    return result.sha256;
  } finally { closeSync(fd); }
}

function appendOwnedBytes(owner: RunOwnership, runId: string, root: string | undefined, bytes: Buffer, previous: number): void {
  if (!bytes.length) return;
  owner.beforeWrite();
  const path = join(owner.directory, 'transcript.jsonl');
  const exists = runEntryExists(path);
  if (exists) transcriptLength(runId, root);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | (exists ? 0 : constants.O_CREAT | constants.O_EXCL) | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const before = fstatSync(fd, { bigint: true });
    const entry = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(previous) || before.dev !== entry.dev || before.ino !== entry.ino) throw new RunStateSnapshotChangedError(runId);
    owner.touch(); writeFileSync(fd, bytes); fsyncSync(fd);
    const after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
    if (after.size !== BigInt(previous + bytes.length) || after.dev !== current.dev || after.ino !== current.ino || current.nlink !== 1n) throw new RunStateSnapshotChangedError(runId);
  } finally { closeSync(fd); }
}

export function createRunStore(root?: string, options: { sweepOrphans?: boolean } = {}): AgentRunStore {
  if (options.sweepOrphans !== false) sweepOrphanRunTempFiles(root);
  const create = (request: AgentRunRequest, failure?: { failureCode: AgentRunFailureCode; errorSummary: string }): AgentRunState => {
    const runId = request.runId || generateRunId();
    validateRunId(runId);
    const now = new Date().toISOString();
    const state: AgentRunState = { runId, status: failure ? 'failed' : 'pending', agentId: request.agentId, model: request.resolvedConfig.model,
      startedAt: now, tokensUsed: 0, tokensRemaining: request.budget?.tokens ?? null, toolCalls: 0, worktreePath: request.worktreePath,
      transcriptPath: join(getRunDir(runId, root), 'transcript.jsonl'),
      ...(failure ? { ...failure, error: failure.errorSummary, completedAt: now } : {}),
    };
    const config = { ...request.resolvedConfig };
    delete config.prompt; delete config.initialPrompt; delete config.criticalSystemReminder;
    const metadata = { runId, agentId: request.agentId, resolvedConfig: config, permissionProfile: request.permissionProfile,
      budget: request.budget, correlationId: request.correlationId, threadId: request.threadId, worktreePath: request.worktreePath };
    scanned(state, 'Run state'); scanned(metadata, 'Run metadata');
    const metadataBytes = Buffer.from(stableJson(metadata)), metadataSha256 = runSha256(metadataBytes);
    if (metadataBytes.length > DEFAULT_RUN_SNAPSHOT_MAX_BYTES) throw new Error('Run metadata exceeds the read bound.');
    return withRunOwnership(root, runId, 'create', true, owner => {
      if (readdirSync(owner.directory).some(name => name !== TRANSACTION_LOCK)) throw new Error(`Run already exists: ${runId}`);
      state.persistence = { schemaVersion: 2, creationId: randomUUID(), transactionId: owner.transactionId,
        metadataSha256, revision: 0, transcriptBytes: 0 };
      const stateBytes = Buffer.from(stableJson(state));
      if (stateBytes.length > DEFAULT_RUN_SNAPSHOT_MAX_BYTES) throw new Error('Run metadata exceeds the read bound.');
      decodeRunState(stateBytes, runId);
      const metadataFile = `metadata.json.${owner.transactionId}.tmp`, stateFile = `run.json.${owner.transactionId}.tmp`;
      owner.beforeWrite(); owner.touch();
      writeRunExclusive(join(owner.directory, metadataFile), metadataBytes);
      writeRunExclusive(join(owner.directory, stateFile), stateBytes);
      owner.publishIntent({ creationId: state.persistence.creationId, base: { stateSha256: null, transactionId: null, revision: null, transcriptBytes: 0, legacyPrefixSha256: runSha256('') },
        target: { stateSha256: runSha256(stateBytes), revision: 0, transcriptBytes: 0, metadataFile, stateFile }, metadataSha256,
        append: { bytes: 0, sha256: runSha256('') } });
      for (const [temporary, target] of [[metadataFile, 'metadata.json'], [stateFile, 'run.json']]) {
        owner.beforeWrite(); linkSync(join(owner.directory, temporary!), join(owner.directory, target!));
        unlinkSync(join(owner.directory, temporary!));
      }
      return state;
    });
  };

  const updateOwned = (runId: string, update: Parameters<AgentRunStore['withRunTransaction']>[1], owner: RunOwnership): AgentRunState => {
      const directory = owner.directory;
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
      if (!events.length && stableJson({ ...current, ...change.patch }) === stableJson(current)) { checkPublication(); return current; }
      for (const event of events) scanned(event, 'Transcript event');
      const bytes = Buffer.from(events.map(event => JSON.stringify(event) + '\n').join(''), 'utf8');
      const length = transcriptLength(runId, root) + bytes.length;
      const updated: AgentRunState = { ...current, ...change.patch, persistence: {
        ...current.persistence,
        ...(current.persistence?.schemaVersion === 2 ? { transactionId: owner.transactionId } : {}),
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
      decodeRunState(stateBytes, runId);
      const baseBytes = readRunBytes(getRunMetaPath(runId, root), DEFAULT_RUN_SNAPSHOT_MAX_BYTES, runId);
      if (stableJson(decodeRunState(baseBytes, runId)) !== stableJson(current)) throw new RunStateSnapshotChangedError(runId);
      const stateFile = `run.json.${owner.transactionId}.tmp`;
      const metadataPath = join(directory, 'metadata.json');
      const metadataSha256 = runEntryExists(metadataPath) ? runSha256(readRunBytes(metadataPath, DEFAULT_RUN_SNAPSHOT_MAX_BYTES, runId)) : null;
      checkPublication();
      owner.publishIntent({ creationId: current.persistence?.creationId, base: { stateSha256: runSha256(baseBytes), transactionId: current.persistence?.transactionId ?? null,
        revision: current.persistence?.revision ?? null, transcriptBytes: length - bytes.length,
        ...(!current.persistence?.transactionId ? { legacyPrefixSha256: legacyTranscriptDigest(runId, root) } : {}) },
        target: { stateSha256: runSha256(stateBytes), revision: updated.persistence!.revision, transcriptBytes: length, stateFile },
        metadataSha256, append: { bytes: bytes.length, sha256: runSha256(bytes) } });
      appendOwnedBytes(owner, runId, root, bytes, length - bytes.length);
      const path = getRunMetaPath(runId, root);
      const temporary = join(directory, stateFile);
      owner.beforeWrite(); owner.touch(); writeRunExclusive(temporary, stateBytes);
      checkPublication();
      owner.beforeWrite();
      renameSync(temporary, path);
      return updated;
  };
  const withRunTransaction: AgentRunStore['withRunTransaction'] = (runId, update) => {
    validateRunId(runId);
    if (typeof update !== 'function' || utilTypes.isAsyncFunction(update)) throw new TypeError('Run transactions must be synchronous.');
    return withRunOwnership(root, runId, 'update', false, owner => updateOwned(runId, update, owner));
  };
  const appendEvent = (runId: string, event: AgentRunEvent): void => {
    validateRunId(runId); scanned(event, 'Transcript event');
    withRunOwnership(root, runId, 'append', true, owner => {
      // Decide only after ownership. create cannot publish between this branch
      // and the append, and canonical writes always advance their watermark.
      if (readSnapshot(runId, root, DEFAULT_RUN_SNAPSHOT_MAX_BYTES, true)) {
        updateOwned(runId, () => ({ events: [event] }), owner);
        return;
      }
      const bytes = Buffer.from(JSON.stringify(event) + '\n'), previous = transcriptLength(runId, root);
      owner.publishIntent({ base: { stateSha256: null, transactionId: null, revision: null, transcriptBytes: previous,
        legacyPrefixSha256: legacyTranscriptDigest(runId, root) },
        target: { stateSha256: null, revision: null, transcriptBytes: previous + bytes.length }, metadataSha256: null,
        append: { bytes: bytes.length, sha256: runSha256(bytes) } });
      appendOwnedBytes(owner, runId, root, bytes, previous);
    });
  };

  return {
    createRun: request => create(request), createFailedRun: (request, failure) => create(request, failure), withRunTransaction, appendEvent,
    updateRun: (runId, patch) => withRunTransaction(runId, () => ({ patch })),
    readRun: runId => readRunStateSnapshot(runId, root),
    observeRun: runId => observeRun(runId, root),
    listRunObservations: filter => listRunObservations(root, filter),
    getRun: runId => { const value = observeRun(runId, root); return value.kind === 'ready' ? value.state : null; },
    listRuns: filter => listRunObservations(root, filter).runs,
  };
}

/** Read availability without creating directories, sweeping, repairing or accepting
 * an old snapshot. Its discriminant is not execution authority. */
export function observeRun(runId: string, root?: string): RunObservation {
  validateRunId(runId);
  try {
    if (!inspectRunDirectories(root, runId)) return { kind: 'missing', runId };
    const directory = getRunDir(runId, root);
    if (runEntryExists(join(directory, RUN_MAINTENANCE_BARRIER))) return { kind: 'unavailable', runId, reason: 'persistence-unconfirmed' };
    if (runEntryExists(join(directory, TRANSACTION_LOCK))) return { kind: 'unavailable', runId, reason: 'locked' };
    const state = readRunStateSnapshot(runId, root);
    if (state) return { kind: 'ready', runId, state };
    const anchored = readdirSync(directory).length > 0;
    return anchored ? { kind: 'unavailable', runId, reason: 'creation-incomplete' } : { kind: 'missing', runId };
  } catch (error) {
    const reason: RunUnavailableReason = error instanceof RunStateSnapshotChangedError ? 'persistence-unconfirmed' :
      error instanceof RunPersistenceError && error.code === 'RUN_INITIALIZATION_INCOMPLETE' ? 'creation-incomplete' :
        error instanceof Error && /owned (?:regular file|directory)/.test(error.message) ? 'unsafe' : 'corrupt';
    return { kind: 'unavailable', runId, reason };
  }
}

/** Unavailable entries survive filters: their agent/status fields cannot be trusted. */
export function listRunObservations(root?: string, filter?: { agentId?: string; status?: AgentRunStatus }): RunListing {
  const result: RunListing = { runs: [], unavailable: [] };
  try {
    if (!inspectRunDirectories(root)) return result;
    for (const entry of readdirSync(getRunsBaseDir(root), { withFileTypes: true })) {
      if (!RUN_ID_RE.test(entry.name)) continue;
      const value = observeRun(entry.name, root);
      if (value.kind === 'unavailable') result.unavailable.push(value);
      else if (value.kind === 'ready' && (!filter?.agentId || value.state.agentId === filter.agentId) &&
        (!filter?.status || value.state.status === filter.status)) result.runs.push(value.state);
    }
    result.runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    result.unavailable.sort((a, b) => a.runId.localeCompare(b.runId));
  } catch (error) { result.storageIssue = error instanceof Error && /owned directory/.test(error.message) ? 'unsafe' : 'unreadable'; }
  return result;
}
