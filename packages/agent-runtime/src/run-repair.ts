/** ADR-0004 single-run maintenance. Preview is pure; write requires a nominal
 * trusted host capability and never replays a task or repairs legacy guesses. */
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder, types as utilTypes } from 'node:util';
import { scanValue } from '@openslack/collaboration';
import { decodeRunState, HARNESS_TRANSCRIPT_MAX_BYTES, readRunStateSnapshot } from './run-store.js';
import type { AgentRunState, AgentRunEvent } from './types.js';
import { captureRunDirectories, captureStorageDirectories, inspectRunDirectories, readRunBytes, RUN_MAINTENANCE_BARRIER, RUN_SNAPSHOT_MAX_BYTES,
  RUN_TRANSACTION_LOCK, runBase, runDirectory, runEntryExists, runSha256, writeRunExclusive } from './run-files.js';
import type { RunStorageIntent, RunOwnershipRecord } from './run-ownership.js';
import { observeRunWriter, ownRunWriterWitness } from './run-process-witness.js';
import { isCode } from './io-errors.js';
import { validateRunId } from './run-id.js';

const UUID = /^[a-f0-9-]{36}$/, SHA = /^[a-f0-9]{64}$/;
const INTENT = /^run\.intent\.([a-f0-9-]{36})\.json$/;
const TEMP = /^(run|metadata)\.json\.[a-f0-9-]{36}\.tmp$/;
const RECEIPT = /^run\.repair\.[a-f0-9]{64}\.json$/;
const MAX_FILES = 4096, MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const inspections = new WeakMap<RunRepairInspection, InspectionSource>();
const ports = new WeakMap<RunRepairAuthorityPort, (scope: Readonly<RunRepairScope>) => boolean>();
const capabilities = new WeakMap<RunRepairCapability, { inspection: RunRepairInspection; port: RunRepairAuthorityPort; consumed: boolean }>();
declare const repairPortBrand: unique symbol, repairCapabilityBrand: unique symbol;
export interface RunRepairAuthorityPort { readonly [repairPortBrand]: true }
export interface RunRepairCapability { readonly [repairCapabilityBrand]: true }
export interface RunRepairScope { readonly runId: string; readonly workspaceIdentity: string; readonly inspectionSha256: string }
export interface RunRepairFile { readonly name: string; readonly bytes: number; readonly sha256: string; readonly identity: string }
export interface RunRepairInspection {
  readonly schema: 'openslack.run_repair_inspection.v1'; readonly runId: string; readonly workspaceIdentity: string;
  readonly inspectionSha256: string; readonly plan: 'preserve_committed' | 'fail_incomplete' | 'not_needed' | 'unavailable';
  readonly reason: string; readonly files: readonly Readonly<RunRepairFile>[];
}
export interface RunRepairReceipt {
  readonly schema: 'openslack.run_repair_receipt.v1'; readonly runId: string; readonly inspectionSha256: string;
  readonly outcome: 'preserved_commit' | 'indeterminate'; readonly archivePath: string; readonly archiveManifestSha256: string;
  readonly resources: 'unknown'; readonly requiresReconciliation: true;
}
export class RunRepairError extends Error {
  constructor(readonly code: 'RUN_REPAIR_UNAVAILABLE' | 'RUN_REPAIR_NOT_AUTHORIZED' | 'RUN_REPAIR_INSPECTION_CHANGED' | 'RUN_REPAIR_INDETERMINATE') {
    super(code); this.name = 'RunRepairError';
  }
}
interface InspectionSource {
  root: string; runId: string; directory: string; files: Map<string, Buffer>; manifest: RunRepairFile[];
  workspaceIdentity: string; lock?: RunOwnershipRecord; intent?: RunStorageIntent; state?: AgentRunState;
  baseState?: AgentRunState; metadata?: Buffer; transcript: Buffer; intents: Map<string, RunStorageIntent>;
  verifyDirectories: () => void;
}
const jsonBytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2));
function parse(bytes: Buffer): unknown { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
function inertObject(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function safe(value: unknown): void { if (scanValue(value, 'run repair').found) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE'); }

function identity(path: string): string {
  const s = lstatSync(path, { bigint: true });
  return [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeNs, s.ctimeNs].join(':');
}

/** Bounded protected membership. Two links are accepted only as a bound canonical
 * publication pair, never as an external hardlink or general link-policy escape. */
function collect(root: string, runId: string, ignore: readonly string[] = []): InspectionSource {
  if (!inspectRunDirectories(root, runId)) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  const verifyDirectories = captureRunDirectories(root, runId), directory = runDirectory(runId, root);
  const names = readdirSync(directory).filter(name => !ignore.includes(name)).sort();
  if (names.length > MAX_FILES) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  const files = new Map<string, Buffer>(), manifest: RunRepairFile[] = [], pairs = new Map<string, string[]>();
  const stats = new Map(names.map(name => [name, lstatSync(join(directory, name), { bigint: true })]));
  let total = 0;
  for (const name of names) {
    const s = stats.get(name)!;
    if (!s.isFile() || s.isSymbolicLink() || s.nlink < 1n || s.nlink > 2n ||
      !(['run.json', 'metadata.json', 'transcript.jsonl', RUN_TRANSACTION_LOCK, RUN_MAINTENANCE_BARRIER].includes(name) || INTENT.test(name) || TEMP.test(name) || RECEIPT.test(name))) {
      throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
    }
    const limit = name === 'transcript.jsonl' ? HARNESS_TRANSCRIPT_MAX_BYTES : INTENT.test(name) || name === RUN_TRANSACTION_LOCK || name === RUN_MAINTENANCE_BARRIER ? 16 * 1024 : RUN_SNAPSHOT_MAX_BYTES;
    if (s.size > BigInt(limit) || (total += Number(s.size)) > MAX_TOTAL_BYTES) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
    const key = `${s.dev}:${s.ino}`; const linked = pairs.get(key) ?? []; linked.push(name); pairs.set(key, linked);
    const bytes = readRunBytes(join(directory, name), limit, runId, Number(s.nlink));
    files.set(name, bytes); manifest.push({ name, bytes: bytes.length, sha256: runSha256(bytes), identity: identity(join(directory, name)) });
  }
  for (const linked of pairs.values()) {
    const nlink = stats.get(linked[0]!)!.nlink;
    if (nlink === 2n && (linked.length !== 2 || !['run.json', 'metadata.json'].some(name => linked.includes(name) && linked.some(other => other.startsWith(`${name}.`) && TEMP.test(other))))) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  }
  verifyDirectories();
  const rootStamp = lstatSync(root, { bigint: true });
  return { root, runId, directory, files, manifest, verifyDirectories, intents: new Map(), transcript: files.get('transcript.jsonl') ?? Buffer.alloc(0),
    workspaceIdentity: runSha256(JSON.stringify([realpathSync.native(root), String(rootStamp.dev), String(rootStamp.ino), String(rootStamp.uid), String(rootStamp.gid)])) };
}

function intentValue(value: unknown, runId: string): RunStorageIntent {
  if (!inertObject(value) || value.schema !== 'openslack.run_intent.v2' || value.runId !== runId ||
    typeof value.transactionId !== 'string' || !UUID.test(value.transactionId) || typeof value.ownerGeneration !== 'string' || !UUID.test(value.ownerGeneration) ||
    typeof value.ownershipSha256 !== 'string' || !SHA.test(value.ownershipSha256) || typeof value.creationId !== 'string' || !UUID.test(value.creationId) ||
    !['create', 'update', 'append', 'recovery'].includes(String(value.operation)) || !inertObject(value.base) || !inertObject(value.target) || !inertObject(value.append) ||
    ![value.base.transcriptBytes, value.target.transcriptBytes, value.append.bytes].every(n => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= HARNESS_TRANSCRIPT_MAX_BYTES) ||
    Number(value.base.transcriptBytes) + Number(value.append.bytes) !== value.target.transcriptBytes || typeof value.append.sha256 !== 'string' || !SHA.test(value.append.sha256) ||
    (value.base.revision !== null && (!Number.isSafeInteger(value.base.revision) || Number(value.base.revision) < 0)) ||
    !Number.isSafeInteger(value.target.revision) || Number(value.target.revision) < 0 ||
    (value.base.transactionId !== null && (typeof value.base.transactionId !== 'string' || !UUID.test(value.base.transactionId))) ||
    (value.base.stateSha256 !== null && (typeof value.base.stateSha256 !== 'string' || !SHA.test(value.base.stateSha256))) ||
    typeof value.target.stateSha256 !== 'string' || !SHA.test(value.target.stateSha256) || typeof value.metadataSha256 !== 'string' || !SHA.test(value.metadataSha256) ||
    (value.target.stateFile !== undefined && value.target.stateFile !== `run.json.${value.transactionId}.tmp`) ||
    (value.target.metadataFile !== undefined && value.target.metadataFile !== `metadata.json.${value.transactionId}.tmp`)) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  return value as unknown as RunStorageIntent;
}

/** Prove the whole committed prefix from immutable intent ranges. This reads no
 * task source, does not require a lease and never treats hashes as authority. */
function transcriptProof(source: InspectionSource, first: RunStorageIntent, end = first.target.transcriptBytes): void {
  const seen = new Set<string>(); let current = first, expected = end;
  while (true) {
    if (seen.has(current.transactionId) || seen.size >= MAX_FILES || current.target.transcriptBytes !== expected ||
      current.creationId !== first.creationId || current.metadataSha256 !== first.metadataSha256) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
    seen.add(current.transactionId);
    const start = current.base.transcriptBytes;
    if (current.target.transcriptBytes > source.transcript.length || runSha256(source.transcript.subarray(start, current.target.transcriptBytes)) !== current.append.sha256) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
    if (current.base.transactionId === null) {
      if (!current.base.legacyPrefixSha256 || runSha256(source.transcript.subarray(0, start)) !== current.base.legacyPrefixSha256) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
      return;
    }
    const previous = source.intents.get(current.base.transactionId);
    if (!previous || previous.target.stateSha256 !== current.base.stateSha256 || previous.target.revision !== current.base.revision || previous.target.transcriptBytes !== start) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
    expected = start; current = previous;
  }
}

function strictTranscript(bytes: Buffer): void {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text && !text.endsWith('\n')) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  let offset = 0;
  while (offset < text.length) {
    const end = text.indexOf('\n', offset), line = text.slice(offset, end); offset = end + 1;
    if (!line || Buffer.byteLength(line) > 16 * 1024 * 1024) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
    const event: unknown = JSON.parse(line);
    if (!inertObject(event) || !['start', 'progress', 'tool_call', 'tool_result', 'complete', 'fail', 'cancel'].includes(String(event.type)) ||
      !inertObject(event.data) || typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp))) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
    safe(event);
  }
}

function classify(source: InspectionSource): Pick<RunRepairInspection, 'plan' | 'reason'> {
  if (source.files.has(RUN_MAINTENANCE_BARRIER)) return { plan: 'unavailable', reason: 'maintenance_unresolved' };
  const lockBytes = source.files.get(RUN_TRANSACTION_LOCK);
  if (!lockBytes) return readRunStateSnapshot(source.runId, source.root)
    ? { plan: 'not_needed', reason: 'no_abandoned_ownership' } : { plan: 'unavailable', reason: 'no_owned_recovery_intent' };
  const lock: unknown = parse(lockBytes);
  if (!inertObject(lock) || lock.schema !== 'openslack.run_transaction.v2' || lock.runId !== source.runId || typeof lock.transactionId !== 'string' ||
    !UUID.test(lock.transactionId) || typeof lock.ownerGeneration !== 'string' || !UUID.test(lock.ownerGeneration) || !inertObject(lock.writer)) return { plan: 'unavailable', reason: 'legacy_or_unavailable_writer_witness' };
  source.lock = lock as unknown as RunOwnershipRecord;
  for (const [name, bytes] of source.files) if (name !== 'transcript.jsonl') safe(parse(bytes));
  for (const [name, bytes] of source.files) if (INTENT.test(name)) {
    const intent = intentValue(parse(bytes), source.runId);
    if (name !== `run.intent.${intent.transactionId}.json`) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
    source.intents.set(intent.transactionId, intent);
  }
  const intent = source.intents.get(lock.transactionId);
  if (!intent || intent.ownerGeneration !== lock.ownerGeneration || intent.operation !== lock.operation || intent.ownershipSha256 !== runSha256(lockBytes)) return { plan: 'unavailable', reason: 'ownership_intent_mismatch' };
  source.intent = intent;
  const metadata = source.files.get('metadata.json') ?? (intent.target.metadataFile ? source.files.get(intent.target.metadataFile) : undefined);
  if (!metadata || runSha256(metadata) !== intent.metadataSha256) return { plan: 'unavailable', reason: 'metadata_unproven' };
  const metadataValue = parse(metadata); safe(metadataValue);
  if (!inertObject(metadataValue) || metadataValue.runId !== source.runId) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  source.metadata = metadata;
  for (const name of ['run.json', 'metadata.json']) {
    if (!source.files.has(name)) continue;
    const s = lstatSync(join(source.directory, name));
    if (s.nlink === 2) {
      const declared = name === 'run.json' ? intent.target.stateFile : intent.target.metadataFile;
      if (!declared || !source.files.has(declared) || identity(join(source.directory, declared)).split(':').slice(0, 2).join(':') !== identity(join(source.directory, name)).split(':').slice(0, 2).join(':')) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
    }
  }
  strictTranscript(source.transcript);
  if (source.transcript.length !== intent.target.transcriptBytes && source.transcript.length !== intent.base.transcriptBytes) return { plan: 'unavailable', reason: 'partial_transcript_range' };
  if (source.transcript.length === intent.target.transcriptBytes) transcriptProof(source, intent);
  else if (intent.base.transactionId) {
    const previous = source.intents.get(intent.base.transactionId);
    if (!previous || previous.target.stateSha256 !== intent.base.stateSha256 || previous.target.revision !== intent.base.revision ||
      previous.target.transcriptBytes !== intent.base.transcriptBytes || previous.creationId !== intent.creationId ||
      previous.metadataSha256 !== intent.metadataSha256) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
    transcriptProof(source, previous);
  } else if (runSha256(source.transcript) !== intent.base.legacyPrefixSha256) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  const canonical = source.files.get('run.json'), temporary = intent.target.stateFile ? source.files.get(intent.target.stateFile) : undefined;
  if (canonical && runSha256(canonical) === intent.target.stateSha256 && source.transcript.length === intent.target.transcriptBytes) {
    source.state = decodeRunState(canonical, source.runId);
    if (source.state.persistence?.schemaVersion !== 2 || source.state.persistence.creationId !== intent.creationId || source.state.persistence.transactionId !== intent.transactionId ||
      source.state.persistence.metadataSha256 !== intent.metadataSha256 || source.state.persistence.revision !== intent.target.revision ||
      source.state.persistence.transcriptBytes !== source.transcript.length) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
    safe(source.state);
    if (source.state.status === 'completed' && source.state.harnessExecution && source.state.harnessExecution.acceptance !== 'verified') throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
    if (['completed', 'failed', 'cancelled'].includes(source.state.status)) return { plan: 'preserve_committed', reason: 'terminal_commit_proven' };
    source.baseState = source.state;
    return { plan: 'fail_incomplete', reason: 'nonterminal_owner_abandoned' };
  }
  if (canonical) {
    if (runSha256(canonical) !== intent.base.stateSha256) return { plan: 'unavailable', reason: 'canonical_range_unproven' };
    source.baseState = decodeRunState(canonical, source.runId); source.state = source.baseState;
    if (source.baseState.persistence?.schemaVersion !== 2 || source.baseState.persistence.transactionId !== intent.base.transactionId ||
      source.baseState.persistence.revision !== intent.base.revision || source.baseState.persistence.transcriptBytes !== intent.base.transcriptBytes ||
      source.baseState.persistence.creationId !== intent.creationId || source.baseState.persistence.metadataSha256 !== intent.metadataSha256) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  } else if (intent.operation !== 'create' || intent.base.stateSha256 !== null) return { plan: 'unavailable', reason: 'canonical_missing' };
  if (temporary && runSha256(temporary) === intent.target.stateSha256) {
    source.state = decodeRunState(temporary, source.runId);
    if (source.state.persistence?.transactionId !== intent.transactionId || source.state.persistence.revision !== intent.target.revision ||
      source.state.persistence.transcriptBytes !== intent.target.transcriptBytes) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  }
  if (!source.state || source.state.persistence?.schemaVersion !== 2 || source.state.persistence.creationId !== intent.creationId || source.state.persistence.metadataSha256 !== intent.metadataSha256) return { plan: 'unavailable', reason: 'legacy_or_unproven_target' };
  safe(source.state);
  return { plan: 'fail_incomplete', reason: 'partial_publication_proven' };
}

/** Pure bounded inspection. Even unavailable input is rendered without raw errors,
 * transcripts, prompts or guessed status. It does not probe another process. */
export function inspectRunRepair(root: string, runId: string): RunRepairInspection {
  validateRunId(runId); root = resolve(root);
  let source: InspectionSource | undefined, plan: Pick<RunRepairInspection, 'plan' | 'reason'>;
  try { source = collect(root, runId); plan = classify(source); }
  catch { plan = { plan: 'unavailable', reason: 'storage_or_proof_unavailable' }; }
  const data = { schema: 'openslack.run_repair_inspection.v1' as const, runId, workspaceIdentity: source?.workspaceIdentity ?? runSha256(root),
    ...plan, files: Object.freeze((source?.manifest ?? []).map(file => Object.freeze({ ...file }))) };
  const inspection = Object.freeze({ ...data, inspectionSha256: runSha256(JSON.stringify(data)) });
  if (source) inspections.set(inspection, source);
  return inspection;
}

/** Explicit trusted-host injection, not a serialized approval or new policy. The
 * stock CLI never constructs this port. Test ports are synthetic fixture authority. */
export function createRunRepairAuthorityPort(authorize: (scope: Readonly<RunRepairScope>) => boolean): RunRepairAuthorityPort {
  if (typeof authorize !== 'function' || utilTypes.isAsyncFunction(authorize) || utilTypes.isProxy(authorize)) throw new TypeError('Run maintenance requires a synchronous trusted host authorizer.');
  const port = Object.freeze({}) as RunRepairAuthorityPort; ports.set(port, authorize); return port;
}
function scopeFor(inspection: RunRepairInspection): Readonly<RunRepairScope> {
  return Object.freeze({ runId: inspection.runId, workspaceIdentity: inspection.workspaceIdentity, inspectionSha256: inspection.inspectionSha256 });
}
function assertAuthority(inspection: RunRepairInspection, port: RunRepairAuthorityPort): void {
  const authorize = ports.get(port);
  if (!authorize || authorize(scopeFor(inspection)) !== true) throw new RunRepairError('RUN_REPAIR_NOT_AUTHORIZED');
}
export function authorizeRunRepair(inspection: RunRepairInspection, port: RunRepairAuthorityPort): RunRepairCapability {
  if (!inspections.has(inspection)) throw new RunRepairError('RUN_REPAIR_INSPECTION_CHANGED');
  assertAuthority(inspection, port);
  const capability = Object.freeze({}) as RunRepairCapability;
  capabilities.set(capability, { inspection, port, consumed: false }); return capability;
}

function assertCurrent(inspection: RunRepairInspection, source: InspectionSource, extra: readonly string[] = []): void {
  source.verifyDirectories();
  const current = collect(source.root, source.runId, extra);
  if (current.workspaceIdentity !== inspection.workspaceIdentity || JSON.stringify(current.manifest) !== JSON.stringify(source.manifest)) throw new RunRepairError('RUN_REPAIR_INSPECTION_CHANGED');
}
function archive(source: InspectionSource, inspection: RunRepairInspection): { path: string; manifestSha256: string; verify(): void } {
  let parent = runBase(source.root);
  for (const part of ['.recovery', source.runId]) {
    parent = join(parent, part);
    try { mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (!isCode(error, 'EEXIST')) throw error; }
    const s = lstatSync(parent); if (!s.isDirectory() || s.isSymbolicLink()) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  }
  const leaf = `${inspection.inspectionSha256}-${randomUUID()}`, path = join(parent, leaf); mkdirSync(path, { mode: 0o700 });
  const verifyDirectories = captureStorageDirectories(source.root, ['.openslack.local', 'agents', 'runs', '.recovery', source.runId, leaf], source.runId);
  for (const [name, bytes] of source.files) {
    verifyDirectories();
    writeRunExclusive(join(path, name), bytes);
    if (runSha256(readRunBytes(join(path, name), bytes.length, source.runId)) !== runSha256(bytes)) throw new RunRepairError('RUN_REPAIR_INDETERMINATE');
    verifyDirectories();
  }
  const bytes = jsonBytes({ schema: 'openslack.run_repair_archive.v1', runId: source.runId, inspectionSha256: inspection.inspectionSha256,
    workspaceIdentity: inspection.workspaceIdentity, files: source.manifest });
  writeRunExclusive(join(path, 'before-manifest.json'), bytes);
  const verify = () => {
    verifyDirectories();
    const names = readdirSync(path).sort(), expected = [...source.files.keys(), 'before-manifest.json'].sort();
    if (JSON.stringify(names) !== JSON.stringify(expected) || runSha256(readRunBytes(join(path, 'before-manifest.json'), bytes.length, source.runId)) !== runSha256(bytes)) throw new RunRepairError('RUN_REPAIR_INDETERMINATE');
    for (const [name, original] of source.files) if (runSha256(readRunBytes(join(path, name), original.length, source.runId)) !== runSha256(original)) throw new RunRepairError('RUN_REPAIR_INDETERMINATE');
    verifyDirectories();
  };
  verify();
  return { path, manifestSha256: runSha256(bytes), verify };
}

function guardOwnedFile(path: string, bytes: Buffer, runId: string): { retire(): void; verify(): void; close(): void } {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), before = fstatSync(fd, { bigint: true });
  try {
    const actual = readRunBytes(path, bytes.length, runId);
    if (runSha256(actual) !== runSha256(bytes)) throw new RunRepairError('RUN_REPAIR_INSPECTION_CHANGED');
  } catch (error) { closeSync(fd); throw error; }
  let closed = false;
  const close = () => { if (!closed) { closed = true; closeSync(fd); } };
  const verify = () => {
    if (closed) throw new RunRepairError('RUN_REPAIR_INDETERMINATE');
    const now = lstatSync(path, { bigint: true }), held = fstatSync(fd, { bigint: true });
    if (!now.isFile() || now.isSymbolicLink() || now.nlink !== 1n || now.dev !== before.dev || now.ino !== before.ino || now.mode !== before.mode ||
      held.dev !== before.dev || held.ino !== before.ino || runSha256(readRunBytes(path, bytes.length, runId)) !== runSha256(bytes)) throw new RunRepairError('RUN_REPAIR_INSPECTION_CHANGED');
  };
  return { close, verify, retire() {
    try {
      verify();
      unlinkSync(path);
    } finally { close(); }
  } };
}

/** Explicit single-use maintenance. All uncertainty preserves the barrier; there
 * is no rollback, automatic retry, admission deletion or task execution. */
export function applyRunRepair(inspection: RunRepairInspection, capability: RunRepairCapability): RunRepairReceipt {
  const permission = capabilities.get(capability), source = inspections.get(inspection);
  if (!permission || permission.consumed || permission.inspection !== inspection) throw new RunRepairError('RUN_REPAIR_NOT_AUTHORIZED');
  permission.consumed = true;
  if (!source || !source.lock || !source.intent || !source.state || !source.metadata || !['preserve_committed', 'fail_incomplete'].includes(inspection.plan)) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  assertAuthority(inspection, permission.port); assertCurrent(inspection, source);
  // An early positive check avoids fencing a known live/unknown writer. Repeat
  // after the barrier/CAS; the first check is not permission to retire a lock.
  if (observeRunWriter(source.lock.writer) !== 'exited') throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  const maintenance = { schema: 'openslack.run_maintenance.v1', runId: source.runId, transactionId: randomUUID(), ownerGeneration: randomUUID(),
    inspectionSha256: inspection.inspectionSha256, writer: ownRunWriterWitness() };
  const barrier = join(source.directory, RUN_MAINTENANCE_BARRIER), barrierBytes = jsonBytes(maintenance);
  assertAuthority(inspection, permission.port);
  try { writeRunExclusive(barrier, barrierBytes); }
  catch { throw new RunRepairError('RUN_REPAIR_INDETERMINATE'); }
  const held: Array<{ close(): void }> = [];
  try {
    assertCurrent(inspection, source, [RUN_MAINTENANCE_BARRIER]);
    if (observeRunWriter(source.lock.writer) !== 'exited') throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
    assertCurrent(inspection, source, [RUN_MAINTENANCE_BARRIER]);
    assertAuthority(inspection, permission.port);
    const before = archive(source, inspection);
    assertCurrent(inspection, source, [RUN_MAINTENANCE_BARRIER]); assertAuthority(inspection, permission.port);
    const retireLock = guardOwnedFile(join(source.directory, RUN_TRANSACTION_LOCK), source.files.get(RUN_TRANSACTION_LOCK)!, source.runId);
    held.push(retireLock);
    const retireBarrier = guardOwnedFile(barrier, barrierBytes, source.runId);
    held.push(retireBarrier);
    const receipt: RunRepairReceipt = Object.freeze({ schema: 'openslack.run_repair_receipt.v1', runId: source.runId,
      inspectionSha256: inspection.inspectionSha256, outcome: inspection.plan === 'preserve_committed' ? 'preserved_commit' : 'indeterminate',
      archivePath: before.path, archiveManifestSha256: before.manifestSha256, resources: 'unknown', requiresReconciliation: true });
    const published = inspection.plan === 'fail_incomplete' ? publishFailedRecovery(source, inspection, maintenance, barrierBytes,
      () => { source.verifyDirectories(); retireLock.verify(); retireBarrier.verify(); }) : source.intent;
    // Remove only the archived, bound temporary aliases that prevent a canonical
    // file from satisfying its one-link policy. Other evidence remains in place.
    for (const [canonical, temporary] of [['metadata.json', source.intent.target.metadataFile], ['run.json', source.intent.target.stateFile]] as const) {
      if (!temporary || !source.files.has(temporary) || !runEntryExists(join(source.directory, canonical))) continue;
      const a = lstatSync(join(source.directory, canonical)), b = lstatSync(join(source.directory, temporary));
      if (a.dev === b.dev && a.ino === b.ino && a.nlink === 2 && b.nlink === 2) unlinkSync(join(source.directory, temporary));
    }
    writeRunExclusive(join(source.directory, `run.repair.${inspection.inspectionSha256}.json`), jsonBytes(receipt));
    before.verify(); source.verifyDirectories(); assertAuthority(inspection, permission.port);
    retireLock.verify(); retireBarrier.verify(); verifyPublishedRecovery(source, published);
    retireLock.retire(); retireBarrier.retire();
    return receipt;
  } catch (error) {
    if (error instanceof RunRepairError) throw error;
    throw new RunRepairError('RUN_REPAIR_INDETERMINATE');
  } finally {
    for (const file of held) { try { file.close(); } catch { /* A failed stop never becomes a business success. */ } }
  }
}

function publishFailedRecovery(source: InspectionSource, inspection: RunRepairInspection,
  maintenance: { transactionId: string; ownerGeneration: string }, barrierBytes: Buffer, verifyOwner: () => void): RunStorageIntent {
  const original = source.state!, previous = source.baseState;
  const now = new Date().toISOString(), summary = 'Storage publication was incomplete; preserve evidence and reconcile without replay.';
  const failure: AgentRunEvent = { timestamp: now, type: 'fail', data: { failureCode: 'EXECUTION_FAILED', errorSummary: summary, storageRecovery: inspection.inspectionSha256 } };
  const appended = Buffer.from(JSON.stringify(failure) + '\n');
  if (source.transcript.length + appended.length > HARNESS_TRANSCRIPT_MAX_BYTES) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  const state: AgentRunState = { ...original, status: 'failed', completedAt: now, failureCode: 'EXECUTION_FAILED', errorSummary: summary, error: summary,
    ...(original.harnessExecution ? { harnessExecution: { ...original.harnessExecution, acceptance: 'indeterminate', summary,
      stopRequestedAt: now, lifecycle: original.harnessExecution.lifecycle ? { ...original.harnessExecution.lifecycle, phase: 'indeterminate' } : undefined } } : {}),
    persistence: { ...original.persistence!, transactionId: maintenance.transactionId, revision: (previous?.persistence?.revision ?? -1) + 1,
      transcriptBytes: source.transcript.length + appended.length, recovery: { inspectionSha256: inspection.inspectionSha256,
        previousTransactionId: source.lock!.transactionId, outcome: 'indeterminate' } } };
  safe(state); safe(failure);
  const bytes = jsonBytes(state), stateFile = `run.json.${maintenance.transactionId}.tmp`;
  if (bytes.length > RUN_SNAPSHOT_MAX_BYTES) throw new RunRepairError('RUN_REPAIR_UNAVAILABLE');
  decodeRunState(bytes, source.runId);
  const baseBytes = source.files.get('run.json'), baseCount = previous?.persistence?.transcriptBytes ?? 0;
  const uncommitted = source.transcript.subarray(baseCount), range = Buffer.concat([uncommitted, appended]);
  const intent: RunStorageIntent = { schema: 'openslack.run_intent.v2', runId: source.runId, transactionId: maintenance.transactionId,
    ownerGeneration: maintenance.ownerGeneration, ownershipSha256: runSha256(barrierBytes), operation: 'recovery', creationId: original.persistence!.creationId,
    metadataSha256: source.intent!.metadataSha256, base: { stateSha256: baseBytes ? runSha256(baseBytes) : null,
      transactionId: previous?.persistence?.transactionId ?? null, revision: previous?.persistence?.revision ?? null, transcriptBytes: baseCount,
      ...(!previous?.persistence?.transactionId ? { legacyPrefixSha256: runSha256(source.transcript.subarray(0, baseCount)) } : {}) },
    target: { stateSha256: runSha256(bytes), stateFile, transcriptBytes: state.persistence!.transcriptBytes, revision: state.persistence!.revision },
    append: { bytes: range.length, sha256: runSha256(range) } };
  verifyOwner(); writeRunExclusive(join(source.directory, `run.intent.${maintenance.transactionId}.json`), jsonBytes(intent));
  const transcriptPath = join(source.directory, 'transcript.jsonl');
  if (runEntryExists(transcriptPath) && runSha256(readRunBytes(transcriptPath, HARNESS_TRANSCRIPT_MAX_BYTES, source.runId)) !== runSha256(source.transcript)) throw new RunRepairError('RUN_REPAIR_INSPECTION_CHANGED');
  const fd = openSync(transcriptPath, constants.O_WRONLY | constants.O_APPEND | (runEntryExists(transcriptPath) ? 0 : constants.O_CREAT | constants.O_EXCL) | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = fstatSync(fd, { bigint: true }), entry = lstatSync(transcriptPath, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(source.transcript.length) || stat.dev !== entry.dev || stat.ino !== entry.ino ||
      stat.mode !== entry.mode || stat.mtimeNs !== entry.mtimeNs || stat.ctimeNs !== entry.ctimeNs) throw new RunRepairError('RUN_REPAIR_INSPECTION_CHANGED');
    // Required publication uses the same explicit append/fsync ordering.
    verifyOwner(); writeRunExclusive(join(source.directory, stateFile), bytes);
    // Importing these public fs functions here avoids a second storage writer.
    appendRecoveryBytes(fd, appended);
    const after = fstatSync(fd, { bigint: true }), current = lstatSync(transcriptPath, { bigint: true });
    if (after.size !== BigInt(source.transcript.length + appended.length) || after.dev !== stat.dev || after.ino !== stat.ino || after.mode !== stat.mode ||
      after.nlink !== 1n || current.dev !== after.dev || current.ino !== after.ino || current.mode !== after.mode || current.nlink !== 1n ||
      current.mtimeNs !== after.mtimeNs || current.ctimeNs !== after.ctimeNs) throw new RunRepairError('RUN_REPAIR_INSPECTION_CHANGED');
  } finally { closeSync(fd); }
  if (!source.files.has('metadata.json')) {
    const metadataFile = `metadata.json.${maintenance.transactionId}.tmp`;
    writeRunExclusive(join(source.directory, metadataFile), source.metadata!);
    linkSync(join(source.directory, metadataFile), join(source.directory, 'metadata.json')); unlinkSync(join(source.directory, metadataFile));
  }
  verifyOwner(); renameSync(join(source.directory, stateFile), join(source.directory, 'run.json'));
  return intent;
}

/** No barrier is retired until a fresh descriptor proof matches the actual
 * published state, metadata, entire committed prefix and appended range. */
function verifyPublishedRecovery(source: InspectionSource, expected: RunStorageIntent): void {
  const actual = collect(source.root, source.runId), canonical = actual.files.get('run.json'), metadata = actual.files.get('metadata.json');
  if (!canonical || !metadata || runSha256(canonical) !== expected.target.stateSha256 || runSha256(metadata) !== expected.metadataSha256 ||
    actual.transcript.length !== expected.target.transcriptBytes || lstatSync(join(source.directory, 'run.json')).nlink !== 1 ||
    lstatSync(join(source.directory, 'metadata.json')).nlink !== 1) throw new RunRepairError('RUN_REPAIR_INDETERMINATE');
  const state = decodeRunState(canonical, source.runId);
  if (state.persistence?.schemaVersion !== 2 || state.persistence.transactionId !== expected.transactionId || state.persistence.creationId !== expected.creationId ||
    state.persistence.metadataSha256 !== expected.metadataSha256 || state.persistence.revision !== expected.target.revision ||
    state.persistence.transcriptBytes !== actual.transcript.length) throw new RunRepairError('RUN_REPAIR_INDETERMINATE');
  for (const [name, bytes] of actual.files) if (INTENT.test(name)) { const intent = intentValue(parse(bytes), source.runId); actual.intents.set(intent.transactionId, intent); }
  const retained = actual.intents.get(expected.transactionId);
  if (!retained || JSON.stringify(retained) !== JSON.stringify(expected)) throw new RunRepairError('RUN_REPAIR_INDETERMINATE');
  strictTranscript(actual.transcript); transcriptProof(actual, expected); actual.verifyDirectories();
}

function appendRecoveryBytes(fd: number, bytes: Buffer): void { writeFileSync(fd, bytes); fsyncSync(fd); }
