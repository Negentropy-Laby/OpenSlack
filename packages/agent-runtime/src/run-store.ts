import {
  existsSync, readdirSync, lstatSync, fstatSync, fsyncSync, openSync, closeSync,
  renameSync, statSync, unlinkSync, writeFileSync, linkSync, constants,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { types as utilTypes } from 'node:util';
import { scanValue } from '@openslack/collaboration';
import type { AgentRunFailureCode, AgentRunRequest, AgentRunState, AgentRunStatus, AgentRunEvent } from './types.js';
import { RUN_ID_RE, validateRunId } from './run-id.js';
import { readRunBytes, runSha256, inspectRunDirectories, captureRunDirectories, runEntryExists, RUN_TRANSACTION_LOCK, RUN_MAINTENANCE_BARRIER,
  RunStateSnapshotChangedError, RunStateInvalidError, RunPersistenceError, writeRunExclusive, runBase, runDirectory } from './run-files.js';
import { withRunOwnership, isRunPreAcquisitionContention, type RunOwnership } from './run-ownership.js';
import { isCode } from './io-errors.js';
import { digestStableDescriptor, decodeStrictJSON } from '@openslack/core';
import { RUN_INTENT_MAX_BYTES } from './run-capacity.js';
import { waitForRunObservation } from './run-wait.js';
import { parseDurableTranscriptLine, RUN_TRANSCRIPT_EVENT_MAX_BYTES } from './transcript-contract.js';
import { assertHarnessAcceptanceReceipt } from './harness-task-contracts.js';
import type { RuntimeRunUnavailableReason } from '@openslack/core/internal/runtime-contracts';
import { runPublicationEncodingBound } from './run-recovery-state.js';

export { RunStateSnapshotChangedError, RunStateInvalidError, RunPersistenceError } from './run-files.js';

export { RUN_ID_RE, validateRunId } from './run-id.js';
export const HARNESS_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
export const HARNESS_TERMINAL_RESERVE_BYTES = 64 * 1024;
// Separate maintenance tail: even an interrupted terminal append must remain
// recoverable within the unchanged 64 MiB transcript reader bound.
const RUN_TRANSCRIPT_WRITE_MAX_BYTES = HARNESS_TRANSCRIPT_MAX_BYTES - 64 * 1024;
const ORPHAN_TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const RUN_TEMP_FILE_RE = /^(?:run|metadata)\.json\..+\.tmp$/;
const DEFAULT_RUN_SNAPSHOT_MAX_BYTES = 512 * 1024;
const TRANSACTION_LOCK = RUN_TRANSACTION_LOCK;

function getRunMetaPath(id: string, root?: string): string { return join(runDirectory(id, root), 'run.json'); }

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
export type RunUnavailableReason = RuntimeRunUnavailableReason;
export type RunObservation = Readonly<{ kind: 'ready'; runId: string; state: AgentRunState } |
  { kind: 'missing'; runId: string } | { kind: 'unavailable'; runId: string; reason: RunUnavailableReason }>;
export interface RunListing { runs: AgentRunState[]; unavailable: Array<Extract<RunObservation, { kind: 'unavailable' }>>; storageIssue?: 'unreadable' | 'unsafe' }
export interface WaitRunSnapshotOptions { waitMs?: number; signal?: AbortSignal; utcDeadline?: number; monotonicDeadline?: number }
interface AcceptancePublication { bytes: Buffer }
const acceptancePublishers = new WeakMap<AgentRunStore, (runId: string, publication: AcceptancePublication,
  guard: (state: Readonly<AgentRunState>) => RunTransactionUpdate) => AgentRunState>();

/** Internal host evidence publication, under the same immutable intent and
 * ownership as its canonical watermark. No serialized value grants authority. */
export async function publishRunAcceptanceEvidence(store: AgentRunStore, runId: string, bytes: Uint8Array,
  guard: (state: Readonly<AgentRunState>) => void, options: WaitRunSnapshotOptions = {}): Promise<void> {
  const publish = acceptancePublishers.get(store), owned = Buffer.from(bytes);
  if (!publish || owned.length > DEFAULT_RUN_SNAPSHOT_MAX_BYTES) throw new RunPersistenceError('RUN_STORAGE_LIMIT', 'Acceptance evidence exceeds its canonical publication bound.');
  const value = decodeStrictJSON(owned, DEFAULT_RUN_SNAPSHOT_MAX_BYTES);
  scanned(value, 'Acceptance evidence');
  let callbackStarted = false;
  await waitForRunObservation(() => publish(runId, { bytes: owned }, state => {
    callbackStarted = true; guard(state); assertHarnessAcceptanceReceipt(value, runId, state.harnessExecution);
    return { beforePublish: () => { guard(state); assertHarnessAcceptanceReceipt(value, runId, state.harnessExecution); } };
  }),
    error => !callbackStarted && isRunPreAcquisitionContention(error), options);
}

function transcriptLength(runId: string, root?: string): number {
  const path = join(runDirectory(runId, root), 'transcript.jsonl');
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw new Error('Run transcript is not an owned regular file.');
    return entry.size;
  } catch (error) { if (isCode(error, 'ENOENT')) return 0; throw error; }
}

/** Only the owning transaction may read past its own acquired lock. */
interface CapturedRunSnapshot { state: AgentRunState; stateSha256: string; metadataSha256?: string }
const snapshotReasons = new WeakMap<Error, RunUnavailableReason>();
function unavailableSnapshot(runId: string, reason: RunUnavailableReason): never {
  const error = new RunStateSnapshotChangedError(runId); snapshotReasons.set(error, reason); throw error;
}
function readSnapshot(runId: string, root: string | undefined, maxBytes: number, owned = false): CapturedRunSnapshot | null {
  if (!inspectRunDirectories(root, runId)) return null;
  const verifyDirectories = captureRunDirectories(root, runId);
  const lock = join(runDirectory(runId, root), TRANSACTION_LOCK);
  const barrier = join(runDirectory(runId, root), RUN_MAINTENANCE_BARRIER);
  if (runEntryExists(barrier)) unavailableSnapshot(runId, 'persistence-unconfirmed');
  if (!owned && runEntryExists(lock)) unavailableSnapshot(runId, 'locked');
  const path = getRunMetaPath(runId, root);
  if (!runEntryExists(path)) {
    const incomplete = runEntryExists(join(runDirectory(runId, root), 'metadata.json')) ||
      (!owned && readdirSync(runDirectory(runId, root)).length > 0);
    verifyDirectories();
    // The first absence probe can precede a healthy creator's lock and durable
    // publication. Re-observe that phase before classifying preserved leftovers
    // as an orphan. This never creates, repairs or grants execution authority.
    if (runEntryExists(barrier) || (!owned && runEntryExists(lock)) || runEntryExists(path)) {
      throw new RunStateSnapshotChangedError(runId);
    }
    if (incomplete) throw new RunPersistenceError('RUN_INITIALIZATION_INCOMPLETE', 'Run creation is incomplete; inspect without replay.');
    return null;
  }
  const stateBytes = readRunBytes(path, maxBytes, runId), state = decodeRunState(stateBytes, runId);
  if (state.persistence && transcriptLength(runId, root) !== state.persistence.transcriptBytes) throw new RunStateSnapshotChangedError(runId);
  let metadataSha256: string | undefined;
  if (state.persistence?.metadataSha256) {
    metadataSha256 = runSha256(readRunBytes(join(runDirectory(runId, root), 'metadata.json'), maxBytes, runId));
    if (metadataSha256 !== state.persistence.metadataSha256) throw new RunStateSnapshotChangedError(runId);
  }
  verifyDirectories();
  if (runEntryExists(barrier) || (!owned && runEntryExists(lock))) throw new RunStateSnapshotChangedError(runId);
  return { state, stateSha256: runSha256(stateBytes), metadataSha256 };
}

/** Structural current-state validation is shared with pure maintenance inspection. */
export function decodeRunState(bytes: Uint8Array, runId: string): AgentRunState {
  let value: unknown;
  try { value = decodeStrictJSON(bytes, 2 * 1024 * 1024); }
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
  return readSnapshot(runId, root, max)?.state ?? null;
}

/** Yield for a bounded legitimate writer, without repairing an orphan lock or accepting damaged bytes. */
export async function readRunStateSnapshotWhenAvailable(runId: string, root: string,
  options: WaitRunSnapshotOptions = {}): Promise<AgentRunState | null> {
  return waitForRunObservation(() => readRunStateSnapshot(runId, root),
    error => error instanceof RunStateSnapshotChangedError && error.runId === runId, options);
}

/** Internal async host boundary. Only a refused pre-acquisition open can retry;
 * callbacks, intents and publication failures are never replayed. */
export async function withRunTransactionWhenAvailable(store: AgentRunStore, runId: string,
  update: Parameters<AgentRunStore['withRunTransaction']>[1], options: WaitRunSnapshotOptions = {}): Promise<AgentRunState> {
  let callbackStarted = false;
  return waitForRunObservation(() => store.withRunTransaction(runId, state => { callbackStarted = true; return update(state); }),
    error => !callbackStarted && isRunPreAcquisitionContention(error), options);
}

/** Never sweep temporary evidence belonging to an unresolved transaction. */
export function sweepOrphanRunTempFiles(root?: string, options: SweepOrphanRunTempOptions = {}): number {
  const base = runBase(root);
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
  const path = join(runDirectory(runId, root), 'transcript.jsonl');
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
  if (previous + bytes.length > HARNESS_TRANSCRIPT_MAX_BYTES) throw new RunPersistenceError('RUN_TRANSCRIPT_LIMIT', 'Run transcript exceeds its repair bound.');
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
      transcriptPath: join(runDirectory(runId, root), 'transcript.jsonl'),
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
      if (stateBytes.length > DEFAULT_RUN_SNAPSHOT_MAX_BYTES || runPublicationEncodingBound(state) > DEFAULT_RUN_SNAPSHOT_MAX_BYTES) {
        throw new RunPersistenceError('RUN_STORAGE_LIMIT', 'Reserve snapshot recovery capacity before publication.');
      }
      decodeRunState(stateBytes, runId);
      const metadataFile = `metadata.json.${owner.transactionId}.tmp`, stateFile = `run.json.${owner.transactionId}.tmp`;
      owner.reserveCapacity({ [metadataFile]: metadataBytes.length, [stateFile]: stateBytes.length,
        'metadata.json': metadataBytes.length, 'run.json': stateBytes.length });
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

  const updateOwned = (runId: string, update: Parameters<AgentRunStore['withRunTransaction']>[1], owner: RunOwnership,
    acceptance?: AcceptancePublication): AgentRunState => {
      const directory = owner.directory;
      const captured = readSnapshot(runId, root, DEFAULT_RUN_SNAPSHOT_MAX_BYTES, true);
      if (!captured) throw new Error(`Run not found: ${runId}`);
      const current = captured.state;
      const change = update(structuredClone(current));
      if (!change || typeof change !== 'object' || 'then' in change) throw new TypeError('Run transactions cannot return a Promise.');
      if (change.beforePublish && (typeof change.beforePublish !== 'function' || utilTypes.isAsyncFunction(change.beforePublish))) throw new TypeError('Run publication guards must be synchronous.');
      const checkPublication = () => {
        const result: unknown = change.beforePublish?.();
        if (result && typeof result === 'object' && 'then' in result) throw new TypeError('Run publication guards cannot return a Promise.');
      };
      const events = change.events ?? [];
      if (!acceptance && !events.length && stableJson({ ...current, ...change.patch }) === stableJson(current)) { checkPublication(); return current; }
      for (const event of events) {
        scanned(event, 'Transcript event');
        const line = JSON.stringify(event);
        if (Buffer.byteLength(line) > RUN_TRANSCRIPT_EVENT_MAX_BYTES) throw new RunPersistenceError('RUN_TRANSCRIPT_LIMIT', 'Transcript event exceeds its repair bound.');
        parseDurableTranscriptLine(line);
      }
      const bytes = Buffer.from(events.map(event => JSON.stringify(event) + '\n').join(''), 'utf8');
      const length = transcriptLength(runId, root) + bytes.length;
      if (length > RUN_TRANSCRIPT_WRITE_MAX_BYTES) throw new RunPersistenceError('RUN_TRANSCRIPT_LIMIT', 'Reserve transcript recovery capacity before publication.');
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
          !Number.isSafeInteger(evidence.reservedBytes) || evidence.reservedBytes < 0 ||
          length + evidence.reservedBytes > RUN_TRANSCRIPT_WRITE_MAX_BYTES - HARNESS_TERMINAL_RESERVE_BYTES + terminalBytes) {
          throw new RunPersistenceError('RUN_TRANSCRIPT_LIMIT', 'Harness evidence capacity must be reserved before effects.');
        }
        updated.harnessExecution = { ...updated.harnessExecution, evidence: { ...evidence, terminalBytes } };
      }
      scanned(updated, 'Run state update');
      const stateBytes = Buffer.from(stableJson(updated));
      const snapshotBound = runPublicationEncodingBound(updated);
      if (stateBytes.length > DEFAULT_RUN_SNAPSHOT_MAX_BYTES || snapshotBound > DEFAULT_RUN_SNAPSHOT_MAX_BYTES) {
        throw new RunPersistenceError('RUN_STORAGE_LIMIT', 'Reserve snapshot recovery capacity before publication.');
      }
      decodeRunState(stateBytes, runId);
      const baseBytes = readRunBytes(getRunMetaPath(runId, root), DEFAULT_RUN_SNAPSHOT_MAX_BYTES, runId);
      const baseSha256 = runSha256(baseBytes);
      if (baseSha256 !== captured.stateSha256) throw new RunStateSnapshotChangedError(runId);
      const stateFile = `run.json.${owner.transactionId}.tmp`;
      const metadataPath = join(directory, 'metadata.json');
      const metadataSha256 = runEntryExists(metadataPath) ? runSha256(readRunBytes(metadataPath, DEFAULT_RUN_SNAPSHOT_MAX_BYTES, runId)) : null;
      if (captured.metadataSha256 !== undefined && metadataSha256 !== captured.metadataSha256) throw new RunStateSnapshotChangedError(runId);
      const evidence = updated.harnessExecution?.evidence;
      const pending = Object.values(evidence?.calls ?? {}).filter(call => !call.resultDigest && call.phase !== 'not_dispatched').length;
      const finalization = !['completed', 'failed', 'cancelled'].includes(current.status) && ['completed', 'failed', 'cancelled'].includes(updated.status) &&
        events.length > 0 && events.every(event => ['complete', 'fail', 'cancel'].includes(event.type));
      const acceptancePending = !['completed', 'failed', 'cancelled'].includes(updated.status) &&
        (acceptance !== undefined || runEntryExists(join(directory, 'acceptance.json')));
      owner.reserveCapacity({ [stateFile]: stateBytes.length, 'run.json': stateBytes.length, 'transcript.jsonl': length,
        ...(acceptance ? { 'acceptance.json': acceptance.bytes.length } : {}) },
        { finalization, reservedBytes: (evidence?.reservedBytes ?? 0) + pending * 3 * RUN_INTENT_MAX_BYTES +
          (pending ? 2 * Math.max(0, snapshotBound - stateBytes.length) : 0) +
          (acceptancePending ? RUN_TRANSCRIPT_EVENT_MAX_BYTES + 2 * DEFAULT_RUN_SNAPSHOT_MAX_BYTES + RUN_INTENT_MAX_BYTES : 0) });
      checkPublication();
      owner.publishIntent({ creationId: current.persistence?.creationId, base: { stateSha256: baseSha256, transactionId: current.persistence?.transactionId ?? null,
        revision: current.persistence?.revision ?? null, transcriptBytes: length - bytes.length,
        ...(!current.persistence?.transactionId ? { legacyPrefixSha256: legacyTranscriptDigest(runId, root) } : {}) },
        target: { stateSha256: runSha256(stateBytes), revision: updated.persistence!.revision, transcriptBytes: length, stateFile },
        metadataSha256, append: { bytes: bytes.length, sha256: runSha256(bytes) } });
      appendOwnedBytes(owner, runId, root, bytes, length - bytes.length);
      if (acceptance) {
        owner.beforeWrite(); owner.touch();
        writeRunExclusive(join(directory, 'acceptance.json'), acceptance.bytes);
      }
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
    const line = JSON.stringify(event);
    if (Buffer.byteLength(line) > RUN_TRANSCRIPT_EVENT_MAX_BYTES) throw new RunPersistenceError('RUN_TRANSCRIPT_LIMIT', 'Transcript event exceeds its repair bound.');
    parseDurableTranscriptLine(line);
    withRunOwnership(root, runId, 'append', true, owner => {
      // Decide only after ownership. create cannot publish between this branch
      // and the append, and canonical writes always advance their watermark.
      if (readSnapshot(runId, root, DEFAULT_RUN_SNAPSHOT_MAX_BYTES, true)) {
        updateOwned(runId, () => ({ events: [event] }), owner);
        return;
      }
      const bytes = Buffer.from(line + '\n'), previous = transcriptLength(runId, root);
      if (previous + bytes.length > RUN_TRANSCRIPT_WRITE_MAX_BYTES) throw new RunPersistenceError('RUN_TRANSCRIPT_LIMIT', 'Reserve transcript recovery capacity before publication.');
      owner.reserveCapacity({ 'transcript.jsonl': previous + bytes.length });
      owner.publishIntent({ base: { stateSha256: null, transactionId: null, revision: null, transcriptBytes: previous,
        legacyPrefixSha256: legacyTranscriptDigest(runId, root) },
        target: { stateSha256: null, revision: null, transcriptBytes: previous + bytes.length }, metadataSha256: null,
        append: { bytes: bytes.length, sha256: runSha256(bytes) } });
      appendOwnedBytes(owner, runId, root, bytes, previous);
    });
  };

  const store: AgentRunStore = {
    createRun: request => create(request), createFailedRun: (request, failure) => create(request, failure), withRunTransaction, appendEvent,
    updateRun: (runId, patch) => withRunTransaction(runId, () => ({ patch })),
    readRun: runId => readRunStateSnapshot(runId, root),
    observeRun: runId => observeRun(runId, root),
    listRunObservations: filter => listRunObservations(root, filter),
    getRun: runId => { const value = observeRun(runId, root); return value.kind === 'ready' ? value.state : null; },
    listRuns: filter => listRunObservations(root, filter).runs,
  };
  acceptancePublishers.set(store, (runId, publication, guard) => withRunOwnership(root, runId, 'update', false,
    owner => updateOwned(runId, guard, owner, publication)));
  return store;
}

/** Read availability without creating directories, sweeping, repairing or accepting
 * an old snapshot. Its discriminant is not execution authority. */
export function observeRun(runId: string, root?: string): RunObservation {
  validateRunId(runId);
  try {
    const captured = readSnapshot(runId, root, DEFAULT_RUN_SNAPSHOT_MAX_BYTES);
    return captured ? { kind: 'ready', runId, state: captured.state } : { kind: 'missing', runId };
  } catch (error) {
    const reason: RunUnavailableReason = error instanceof RunStateSnapshotChangedError ? snapshotReasons.get(error) ?? 'persistence-unconfirmed' :
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
    for (const entry of readdirSync(runBase(root), { withFileTypes: true })) {
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
