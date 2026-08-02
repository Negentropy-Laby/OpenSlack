import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder, types as utilTypes } from 'node:util';
import {
  canonicalGovernedJson,
  canonicalizeGovernedJson,
  GOVERNED_PLAN_CONTRACT_LIMITS,
  GOVERNED_PLAN_STATES,
  validateGovernedPlanRecord,
  type GovernedJsonValue,
  type GovernedPlanRecord,
} from './governed-plan.js';
import type { GovernedPlanAuditEvent } from './governed-plan-service.js';

export const GOVERNANCE_SHADOW_OBSERVATION_SCHEMA =
  'openslack.governance_shadow_observation.v1' as const;
export const GOVERNANCE_SHADOW_RECEIPT_SCHEMA = 'openslack.governance_shadow_receipt.v1' as const;

export const GOVERNANCE_SHADOW_OBSERVATION_KINDS = Object.freeze([
  'record',
  'confirmation',
  'audit',
] as const);
export type GovernanceShadowObservationKind = (typeof GOVERNANCE_SHADOW_OBSERVATION_KINDS)[number];

export const GOVERNANCE_SHADOW_CONFIRMATION_OUTCOMES = Object.freeze([
  'claim_eligible',
  'confirmation_rejected',
  'binding_changed',
  'expired',
  'state_invalid',
  'execution_active',
  'aborted_before_claim',
] as const);
export type GovernanceShadowConfirmationOutcome =
  (typeof GOVERNANCE_SHADOW_CONFIRMATION_OUTCOMES)[number];

export const GOVERNANCE_SHADOW_AUDIT_EVENT_TYPES = Object.freeze([
  'plan.previewed',
  'plan.confirmed',
  'plan.confirmation_rejected',
  'plan.cancelled',
  'plan.expired',
  'plan.execution_started',
  'plan.execution_completed',
  'plan.execution_blocked',
  'plan.execution_failed',
  'plan.reconciliation_required',
  'workflow.approval_decided',
] as const);

export const GOVERNANCE_SHADOW_POLICY = Object.freeze({
  maxEnvelopeBytes: 2 * 1024 * 1024,
  maxReceiptBytes: 64 * 1024,
  defaultTimeoutMs: 2_000,
  maxTimeoutMs: 30_000,
  orderingRetryAttempts: 16,
  defaultOrderingRetryDelayMs: 25,
  maxOrderingRetryDelayMs: 1_000,
  maxJournalEntries: 16_384,
  maxJournalBytes: 512 * 1024 * 1024,
  maxJournalFileBytes: 2 * 1024 * 1024,
  maxDiagnosticMessageBytes: 1_024,
} as const);

export interface GovernanceShadowSource {
  readonly workspaceId: string;
  readonly planId: string;
  readonly sourceSequence: number;
}

export interface GovernanceShadowCurrentBindings {
  readonly sourceVersionHash: string;
  readonly permissionSnapshotHash: string;
  readonly actionCatalogHash: string;
  readonly executorBindingHash: string;
  readonly buildNonceHash: string;
  readonly processNonceHash: string;
}

export interface GovernanceShadowRecordObservation {
  readonly kind: 'record';
  readonly expectedRevision: number;
  readonly record: GovernedPlanRecord;
}

export interface GovernanceShadowConfirmationObservation {
  readonly kind: 'confirmation';
  readonly attemptId: string;
  readonly recordRevision: number;
  readonly attemptedAt: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly presentedTokenHash: string;
  readonly currentBindings?: GovernanceShadowCurrentBindings;
  readonly authorityOutcome: GovernanceShadowConfirmationOutcome;
}

export interface GovernanceShadowAuditObservation {
  readonly kind: 'audit';
  readonly recordRevision: number;
  readonly recordHash: string;
  readonly event: GovernedPlanAuditEvent;
}

export type GovernanceShadowObservation =
  | GovernanceShadowRecordObservation
  | GovernanceShadowConfirmationObservation
  | GovernanceShadowAuditObservation;

export interface GovernanceShadowEnvelope {
  readonly schema: typeof GOVERNANCE_SHADOW_OBSERVATION_SCHEMA;
  readonly authority: 'typescript';
  readonly source: GovernanceShadowSource;
  readonly observation: GovernanceShadowObservation;
}

export interface GovernanceShadowReceipt {
  readonly schema: typeof GOVERNANCE_SHADOW_RECEIPT_SCHEMA;
  readonly operation: 'observation_ingest';
  readonly status: 'accepted' | 'duplicate' | 'reconciliation_required';
  readonly parity: 'matched' | 'mismatched' | 'unknown';
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly workspaceId: string;
  readonly planId: string;
  readonly sourceSequence: number;
  readonly observationKind: GovernanceShadowObservationKind;
  readonly observationDigest: string;
  readonly mismatchCode?: string;
  readonly committedAt?: string;
  readonly reconciliationToken?: string;
}

export interface GovernanceShadowPreparedRequest {
  readonly body: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface GovernanceShadowPublisherPort {
  publish(envelope: GovernanceShadowEnvelope): Promise<GovernanceShadowReceipt>;
}

export type GovernanceShadowDiagnosticOutcome =
  | 'accepted'
  | 'duplicate'
  | 'mismatched'
  | 'unavailable'
  | 'journal_incomplete'
  | 'journal_invalid';

export interface GovernanceShadowDiagnostic {
  readonly schema: 'openslack.governance_shadow_diagnostic.v1';
  readonly outcome: GovernanceShadowDiagnosticOutcome;
  readonly workspaceIdHash: string;
  readonly planIdHash: string;
  readonly sourceSequence?: number;
  readonly code?: string;
}

export type GovernanceShadowDiagnosticSink = (
  diagnostic: Readonly<GovernanceShadowDiagnostic>,
) => void | Promise<void>;

export interface GovernedPlanShadowObservationPort {
  observeRecord(record: GovernedPlanRecord): void;
  observeConfirmation(
    record: GovernedPlanRecord,
    observation: GovernanceShadowConfirmationObservation,
  ): void;
  observeAudit(record: GovernedPlanRecord, event: GovernedPlanAuditEvent): void;
  reconcile(records: readonly GovernedPlanRecord[]): void;
}

export interface CreateGovernedPlanShadowObservationPortOptions {
  readonly journalRoot: string;
  readonly publisher: GovernanceShadowPublisherPort;
  readonly diagnosticSink?: GovernanceShadowDiagnosticSink;
}

const HASH = /^[0-9a-f]{64}$/u;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$/u;
const PLAN_ID = /^GPLAN-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ATTEMPT_ID = /^GCONF-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ENTRY_NAME = /^([0-9a-f]{64})\.([0-9]{16})\.([0-9a-f]{64})\.json$/u;
const STATE_NAME = /^([0-9a-f]{64})\.json$/u;
const LOCK_NAME = /^([0-9a-f]{64})\.lock$/u;
const LOCK_NONCE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const JOURNAL_CAPACITY_LOCK_HASH = sha256('openslack.governance-shadow.journal-capacity.v1');
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
const PORTS = new WeakSet<object>();
const PUBLISHERS = new WeakSet<object>();
const streamTails = new Map<string, Promise<void>>();
const decoder = new TextDecoder('utf-8', { fatal: true });

interface JournalDirectories {
  readonly root: string;
  readonly entries: string;
  readonly states: string;
  readonly locks: string;
}

interface JournalState {
  readonly schema: 'openslack.governance_shadow_journal_state.v1';
  readonly workspaceId: string;
  readonly planId: string;
  readonly lastSequence: number;
  readonly ackedSequence: number;
  readonly lastRecordRevision: number;
  readonly incomplete: boolean;
}

interface PendingObservation {
  readonly workspaceId: string;
  readonly planId: string;
  readonly observation: GovernanceShadowObservation;
  readonly prerequisiteRecord?: GovernedPlanRecord;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function governanceShadowRecordHash(record: GovernedPlanRecord): string {
  return sha256(`${canonicalGovernedJson(validateGovernedPlanRecord(record))}\n`);
}

export function prepareGovernanceShadowRequest(
  envelopeValue: GovernanceShadowEnvelope,
): GovernanceShadowPreparedRequest {
  const envelope = validateGovernanceShadowEnvelope(envelopeValue);
  const body = `${canonicalGovernedJson(envelope)}\n`;
  if (Buffer.byteLength(body, 'utf8') > GOVERNANCE_SHADOW_POLICY.maxEnvelopeBytes) {
    throw new TypeError('Governance shadow envelope exceeds the byte limit.');
  }
  const digest = sha256(body);
  const binding = [
    envelope.authority,
    envelope.source.workspaceId,
    envelope.source.planId,
    String(envelope.source.sourceSequence),
  ].join('/');
  return Object.freeze({
    body,
    idempotencyKey: `openslack.governance-shadow.v1.${digest}`,
    requestFingerprint: `sha256:${sha256(
      `POST\n/v1/shadow/governance/observations\n${binding}\n${body}`,
    )}`,
  });
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function plainObject(value: unknown): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError('Governance shadow value must be an inert plain object.');
  }
  return value as Readonly<Record<string, unknown>>;
}

function identifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) {
    throw new TypeError(`${name} must be a bounded identifier.`);
  }
  return value;
}

function hash(value: unknown, name: string): string {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function timestamp(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !CANONICAL_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new TypeError(`${name} must be a canonical timestamp.`);
  }
  return value;
}

function safeInteger(value: unknown, minimum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${name} must be a safe integer no smaller than ${minimum}.`);
  }
  return value as number;
}

function validateCurrentBindings(value: unknown): GovernanceShadowCurrentBindings {
  const object = plainObject(value);
  const keys = [
    'sourceVersionHash',
    'permissionSnapshotHash',
    'actionCatalogHash',
    'executorBindingHash',
    'buildNonceHash',
    'processNonceHash',
  ] as const;
  if (!exactKeys(object, keys)) {
    throw new TypeError('Governance shadow currentBindings must use the closed contract.');
  }
  return Object.freeze(
    Object.fromEntries(
      keys.map((key) => [key, hash(object[key], key)]),
    ) as unknown as GovernanceShadowCurrentBindings,
  );
}

function validateAuditEvent(value: unknown): GovernedPlanAuditEvent {
  const canonical = canonicalizeGovernedJson(value);
  const object = plainObject(canonical);
  const required = [
    'schema',
    'eventId',
    'type',
    'occurredAt',
    'planId',
    'kind',
    'actorId',
    'workspaceId',
    'correlationId',
    'state',
    'revision',
    'evidenceRefs',
  ];
  if (
    !exactKeys(object, required, ['details']) ||
    object.schema !== 'openslack.governed_plan_audit.v1'
  ) {
    throw new TypeError('Governance shadow audit event uses an invalid closed contract.');
  }
  identifier(object.eventId, 'eventId');
  identifier(object.planId, 'planId');
  identifier(object.kind, 'kind');
  identifier(object.actorId, 'actorId');
  identifier(object.workspaceId, 'workspaceId');
  identifier(object.correlationId, 'correlationId');
  timestamp(object.occurredAt, 'occurredAt');
  safeInteger(object.revision, 1, 'revision');
  if (!Array.isArray(object.evidenceRefs)) {
    throw new TypeError('Governance shadow audit evidenceRefs must be an array.');
  }
  if (
    !GOVERNANCE_SHADOW_AUDIT_EVENT_TYPES.includes(object.type as never) ||
    !GOVERNED_PLAN_STATES.includes(object.state as never) ||
    object.evidenceRefs.length > GOVERNED_PLAN_CONTRACT_LIMITS.maxContainerEntries ||
    object.evidenceRefs.some(
      (reference) =>
        typeof reference !== 'string' ||
        reference.length < 1 ||
        Buffer.byteLength(reference, 'utf8') > GOVERNED_PLAN_CONTRACT_LIMITS.maxEvidenceRefBytes,
    )
  ) {
    throw new TypeError('Governance shadow audit event values are outside the closed contract.');
  }
  return canonical as unknown as GovernedPlanAuditEvent;
}

export function validateGovernanceShadowEnvelope(value: unknown): GovernanceShadowEnvelope {
  const canonical = canonicalizeGovernedJson(value);
  const root = plainObject(canonical);
  if (
    !exactKeys(root, ['schema', 'authority', 'source', 'observation']) ||
    root.schema !== GOVERNANCE_SHADOW_OBSERVATION_SCHEMA ||
    root.authority !== 'typescript'
  ) {
    throw new TypeError('Governance shadow envelope uses an invalid closed contract.');
  }
  const sourceObject = plainObject(root.source);
  if (!exactKeys(sourceObject, ['workspaceId', 'planId', 'sourceSequence'])) {
    throw new TypeError('Governance shadow source uses an invalid closed contract.');
  }
  const source: GovernanceShadowSource = Object.freeze({
    workspaceId: identifier(sourceObject.workspaceId, 'source.workspaceId'),
    planId: identifier(sourceObject.planId, 'source.planId'),
    sourceSequence: safeInteger(sourceObject.sourceSequence, 1, 'source.sourceSequence'),
  });
  if (!PLAN_ID.test(source.planId)) {
    throw new TypeError('Governance shadow source planId is invalid.');
  }
  const observationObject = plainObject(root.observation);
  const kind = observationObject.kind;
  if (!GOVERNANCE_SHADOW_OBSERVATION_KINDS.includes(kind as never)) {
    throw new TypeError('Governance shadow observation kind is invalid.');
  }
  let observation: GovernanceShadowObservation;
  if (kind === 'record') {
    if (!exactKeys(observationObject, ['kind', 'expectedRevision', 'record'])) {
      throw new TypeError('Governance shadow record observation is not closed.');
    }
    const record = validateGovernedPlanRecord(observationObject.record);
    const expectedRevision = safeInteger(
      observationObject.expectedRevision,
      0,
      'observation.expectedRevision',
    );
    if (
      record.revision !== expectedRevision + 1 ||
      record.planId !== source.planId ||
      record.bindings.workspaceId !== source.workspaceId
    ) {
      throw new TypeError('Governance shadow record observation bindings do not match its source.');
    }
    observation = Object.freeze({ kind, expectedRevision, record });
  } else if (kind === 'confirmation') {
    if (
      !exactKeys(
        observationObject,
        [
          'kind',
          'attemptId',
          'recordRevision',
          'attemptedAt',
          'actorId',
          'workspaceId',
          'presentedTokenHash',
          'authorityOutcome',
        ],
        ['currentBindings'],
      ) ||
      typeof observationObject.attemptId !== 'string' ||
      !ATTEMPT_ID.test(observationObject.attemptId) ||
      !GOVERNANCE_SHADOW_CONFIRMATION_OUTCOMES.includes(observationObject.authorityOutcome as never)
    ) {
      throw new TypeError('Governance shadow confirmation observation is invalid.');
    }
    observation = Object.freeze({
      kind,
      attemptId: observationObject.attemptId,
      recordRevision: safeInteger(
        observationObject.recordRevision,
        1,
        'observation.recordRevision',
      ),
      attemptedAt: timestamp(observationObject.attemptedAt, 'observation.attemptedAt'),
      actorId: identifier(observationObject.actorId, 'observation.actorId'),
      workspaceId: identifier(observationObject.workspaceId, 'observation.workspaceId'),
      presentedTokenHash: hash(
        observationObject.presentedTokenHash,
        'observation.presentedTokenHash',
      ),
      ...(observationObject.currentBindings === undefined
        ? {}
        : { currentBindings: validateCurrentBindings(observationObject.currentBindings) }),
      authorityOutcome: observationObject.authorityOutcome as GovernanceShadowConfirmationOutcome,
    });
    const requiresCurrentBindings = [
      'claim_eligible',
      'binding_changed',
      'aborted_before_claim',
    ].includes(observation.authorityOutcome);
    if (requiresCurrentBindings !== (observation.currentBindings !== undefined)) {
      throw new TypeError(
        'Governance shadow confirmation currentBindings do not match its authority outcome.',
      );
    }
  } else {
    if (!exactKeys(observationObject, ['kind', 'recordRevision', 'recordHash', 'event'])) {
      throw new TypeError('Governance shadow audit observation is not closed.');
    }
    const event = validateAuditEvent(observationObject.event);
    const recordRevision = safeInteger(
      observationObject.recordRevision,
      1,
      'observation.recordRevision',
    );
    if (
      event.planId !== source.planId ||
      event.workspaceId !== source.workspaceId ||
      event.revision !== recordRevision
    ) {
      throw new TypeError('Governance shadow audit observation bindings do not match its source.');
    }
    observation = Object.freeze({
      kind: 'audit',
      recordRevision,
      recordHash: hash(observationObject.recordHash, 'observation.recordHash'),
      event,
    });
  }
  return Object.freeze({
    schema: GOVERNANCE_SHADOW_OBSERVATION_SCHEMA,
    authority: 'typescript',
    source,
    observation,
  });
}

export function createGovernanceShadowConfirmationObservation(input: {
  readonly recordRevision: number;
  readonly attemptedAt: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly presentedTokenHash: string;
  readonly currentBindings?: GovernanceShadowCurrentBindings;
  readonly authorityOutcome: GovernanceShadowConfirmationOutcome;
  readonly attemptId?: string;
}): GovernanceShadowConfirmationObservation {
  const candidate = {
    kind: 'confirmation',
    attemptId: input.attemptId ?? `GCONF-${randomUUID()}`,
    recordRevision: input.recordRevision,
    attemptedAt: input.attemptedAt,
    actorId: input.actorId,
    workspaceId: input.workspaceId,
    presentedTokenHash: input.presentedTokenHash,
    ...(input.currentBindings === undefined ? {} : { currentBindings: input.currentBindings }),
    authorityOutcome: input.authorityOutcome,
  } as const;
  const envelope = validateGovernanceShadowEnvelope({
    schema: GOVERNANCE_SHADOW_OBSERVATION_SCHEMA,
    authority: 'typescript',
    source: {
      workspaceId: input.workspaceId,
      planId: 'GPLAN-00000000-0000-4000-8000-000000000000',
      sourceSequence: 1,
    },
    observation: candidate,
  });
  return envelope.observation as GovernanceShadowConfirmationObservation;
}

function samePath(left: string, right: string): boolean {
  const normalize = (path: string) =>
    process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  return normalize(left) === normalize(right);
}

function contained(parent: string, child: string): boolean {
  const value = relative(parent, child);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

async function checkedDirectory(path: string): Promise<Stats> {
  const symbolic = await lstat(path);
  const target = await stat(path);
  if (
    symbolic.isSymbolicLink() ||
    !symbolic.isDirectory() ||
    !target.isDirectory() ||
    !samePath(path, await realpath(path)) ||
    (process.platform !== 'win32' && (target.mode & 0o077) !== 0)
  ) {
    throw new TypeError('Governance shadow journal directory must be canonical and owner-only.');
  }
  return target;
}

async function initializeJournal(rootValue: string): Promise<JournalDirectories> {
  if (
    typeof rootValue !== 'string' ||
    !isAbsolute(rootValue) ||
    resolve(rootValue) !== rootValue ||
    rootValue.includes('\0')
  ) {
    throw new TypeError('Governance shadow journal root must be absolute and normalized.');
  }
  const parent = dirname(rootValue);
  await checkedDirectory(parent);
  try {
    await mkdir(rootValue, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await checkedDirectory(rootValue);
  const directories = {
    root: rootValue,
    entries: join(rootValue, 'entries'),
    states: join(rootValue, 'states'),
    locks: join(rootValue, 'locks'),
  };
  for (const path of [directories.entries, directories.states, directories.locks]) {
    try {
      await mkdir(path, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    await checkedDirectory(path);
    if (!contained(rootValue, path)) {
      throw new TypeError('Governance shadow journal child escapes its root.');
    }
  }
  const rootEntries = (await readdir(rootValue)).sort();
  if (rootEntries.join('\0') !== ['entries', 'locks', 'states'].join('\0')) {
    throw new TypeError('Governance shadow journal root contains an unknown entry.');
  }
  await scanJournalBounds(directories);
  return Object.freeze(directories);
}

interface JournalBounds {
  readonly count: number;
  readonly bytes: number;
}

async function scanJournalBounds(directories: JournalDirectories): Promise<JournalBounds> {
  let count = 0;
  let bytes = 0;
  for (const [directory, pattern] of [
    [directories.entries, ENTRY_NAME],
    [directories.states, /^(?:[0-9a-f]{64}\.json|[0-9a-f]{64}\.json\.[0-9a-f-]{36}\.tmp)$/u],
    [directories.locks, LOCK_NAME],
  ] as const) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const file = await lstat(path);
      if (
        entry.isSymbolicLink() ||
        file.isSymbolicLink() ||
        !entry.isFile() ||
        !pattern.test(entry.name) ||
        file.size > GOVERNANCE_SHADOW_POLICY.maxJournalFileBytes ||
        (process.platform !== 'win32' && (file.mode & 0o077) !== 0)
      ) {
        throw new TypeError('Governance shadow journal contains an unsafe entry.');
      }
      count += 1;
      bytes += file.size;
    }
  }
  if (
    count > GOVERNANCE_SHADOW_POLICY.maxJournalEntries ||
    bytes > GOVERNANCE_SHADOW_POLICY.maxJournalBytes
  ) {
    throw new TypeError('Governance shadow journal exceeds its bounded capacity.');
  }
  return Object.freeze({ count, bytes });
}

function assertJournalAppendCapacity(
  bounds: JournalBounds,
  entryCount: number,
  entryBytes: number,
  stateBytes: number,
): void {
  // Account for the new entry and the atomic state temporary. Existing state
  // bytes remain live until the temporary is renamed over the state file.
  if (
    bounds.count + entryCount + 1 > GOVERNANCE_SHADOW_POLICY.maxJournalEntries ||
    bounds.bytes + entryBytes + stateBytes > GOVERNANCE_SHADOW_POLICY.maxJournalBytes
  ) {
    throw new TypeError('Governance shadow journal exceeds its bounded capacity.');
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform === 'win32' &&
      (code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP' || code === 'ENOSYS')
    ) {
      return;
    }
    throw error;
  } finally {
    await handle.close();
  }
}

async function writeExclusive(path: string, bytes: string): Promise<void> {
  if (Buffer.byteLength(bytes, 'utf8') > GOVERNANCE_SHADOW_POLICY.maxJournalFileBytes) {
    throw new TypeError('Governance shadow journal entry exceeds its byte limit.');
  }
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(path: string, bytes: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeExclusive(temporary, bytes);
    const current = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (current && (!current.isFile() || current.isSymbolicLink())) {
      throw new TypeError('Governance shadow journal state target is unsafe.');
    }
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readCanonical(path: string): Promise<unknown> {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 2 ||
    before.size > GOVERNANCE_SHADOW_POLICY.maxJournalFileBytes
  ) {
    throw new TypeError('Governance shadow journal file is unsafe.');
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes[bytes.length - 1] !== 0x0a
  ) {
    throw new TypeError('Governance shadow journal file changed during read.');
  }
  const text = decoder.decode(bytes);
  const parsed = JSON.parse(text) as unknown;
  if (`${canonicalGovernedJson(parsed as GovernedJsonValue)}\n` !== text) {
    throw new TypeError('Governance shadow journal bytes are not exact canonical JSON.');
  }
  return parsed;
}

function streamHash(workspaceId: string, planId: string): string {
  return sha256(`${workspaceId}\0${planId}`);
}

function defaultState(workspaceId: string, planId: string): JournalState {
  return Object.freeze({
    schema: 'openslack.governance_shadow_journal_state.v1',
    workspaceId,
    planId,
    lastSequence: 0,
    ackedSequence: 0,
    lastRecordRevision: 0,
    incomplete: false,
  });
}

function validateState(value: unknown, workspaceId: string, planId: string): JournalState {
  const object = plainObject(value);
  if (
    !exactKeys(object, [
      'schema',
      'workspaceId',
      'planId',
      'lastSequence',
      'ackedSequence',
      'lastRecordRevision',
      'incomplete',
    ]) ||
    object.schema !== 'openslack.governance_shadow_journal_state.v1' ||
    object.workspaceId !== workspaceId ||
    object.planId !== planId ||
    typeof object.incomplete !== 'boolean'
  ) {
    throw new TypeError('Governance shadow journal state is invalid.');
  }
  const lastSequence = safeInteger(object.lastSequence, 0, 'lastSequence');
  const ackedSequence = safeInteger(object.ackedSequence, 0, 'ackedSequence');
  const lastRecordRevision = safeInteger(object.lastRecordRevision, 0, 'lastRecordRevision');
  if (ackedSequence > lastSequence) {
    throw new TypeError('Governance shadow journal acknowledgement exceeds its sequence.');
  }
  return Object.freeze({
    schema: 'openslack.governance_shadow_journal_state.v1',
    workspaceId,
    planId,
    lastSequence,
    ackedSequence,
    lastRecordRevision,
    incomplete: object.incomplete,
  });
}

async function loadState(
  directories: JournalDirectories,
  workspaceId: string,
  planId: string,
): Promise<JournalState> {
  const path = join(directories.states, `${streamHash(workspaceId, planId)}.json`);
  try {
    return validateState(await readCanonical(path), workspaceId, planId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return defaultState(workspaceId, planId);
    throw error;
  }
}

async function persistState(directories: JournalDirectories, state: JournalState): Promise<void> {
  const path = join(directories.states, `${streamHash(state.workspaceId, state.planId)}.json`);
  await writeAtomic(path, `${canonicalGovernedJson(state)}\n`);
}

async function acquireStreamLock(
  directories: JournalDirectories,
  hashValue: string,
): Promise<() => Promise<void>> {
  const path = join(directories.locks, `${hashValue}.lock`);
  const deadline = Date.now() + GOVERNANCE_SHADOW_POLICY.maxTimeoutMs;
  while (Date.now() <= deadline) {
    try {
      await writeExclusive(
        path,
        `${canonicalGovernedJson({ pid: process.pid, nonce: randomUUID() })}\n`,
      );
      await syncDirectory(directories.locks);
      return async () => {
        await unlink(path);
        await syncDirectory(directories.locks);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const observed = await lstat(path).catch((readError: NodeJS.ErrnoException) => {
        if (readError.code === 'ENOENT') return undefined;
        throw readError;
      });
      if (!observed) continue;
      let owner: unknown;
      try {
        owner = await readCanonical(path);
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new TypeError('Governance shadow journal lock is invalid.');
      }
      const object = plainObject(owner);
      const pid = object.pid;
      if (
        !exactKeys(object, ['pid', 'nonce']) ||
        !Number.isSafeInteger(pid) ||
        (pid as number) < 1 ||
        typeof object.nonce !== 'string' ||
        !LOCK_NONCE.test(object.nonce)
      ) {
        throw new TypeError('Governance shadow journal lock has a live or invalid owner.');
      }
      let live = true;
      try {
        process.kill(pid as number, 0);
      } catch (probe) {
        const code = (probe as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') live = false;
        else if (code !== 'EPERM') throw probe;
      }
      if (live) {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, GOVERNANCE_SHADOW_POLICY.defaultOrderingRetryDelayMs),
        );
        continue;
      }
      const repeated = await lstat(path).catch((readError: NodeJS.ErrnoException) => {
        if (readError.code === 'ENOENT') return undefined;
        throw readError;
      });
      if (
        !repeated ||
        observed.dev !== repeated.dev ||
        observed.ino !== repeated.ino ||
        observed.size !== repeated.size ||
        observed.mtimeMs !== repeated.mtimeMs
      ) {
        continue;
      }
      await unlink(path).catch((unlinkError: NodeJS.ErrnoException) => {
        if (unlinkError.code !== 'ENOENT') throw unlinkError;
      });
      await syncDirectory(directories.locks);
    }
  }
  throw new TypeError('Governance shadow journal lock retry limit exceeded.');
}

function entryPrefix(hashValue: string): string {
  return `${hashValue}.`;
}

async function streamEntries(
  directories: JournalDirectories,
  hashValue: string,
): Promise<readonly { readonly path: string; readonly sequence: number }[]> {
  const result: { path: string; sequence: number }[] = [];
  for (const name of await readdir(directories.entries)) {
    if (!name.startsWith(entryPrefix(hashValue))) continue;
    const match = ENTRY_NAME.exec(name);
    if (!match || match[1] !== hashValue) {
      throw new TypeError('Governance shadow journal entry name is invalid.');
    }
    result.push({ path: join(directories.entries, name), sequence: Number(match[2]) });
  }
  return Object.freeze(result.sort((left, right) => left.sequence - right.sequence));
}

class GovernedPlanShadowObservationPortImpl implements GovernedPlanShadowObservationPort {
  readonly #directories: JournalDirectories;
  readonly #publisher: GovernanceShadowPublisherPort;
  readonly #diagnosticSink: GovernanceShadowDiagnosticSink | undefined;

  constructor(
    directories: JournalDirectories,
    publisher: GovernanceShadowPublisherPort,
    diagnosticSink: GovernanceShadowDiagnosticSink | undefined,
  ) {
    this.#directories = directories;
    this.#publisher = publisher;
    this.#diagnosticSink = diagnosticSink;
  }

  observeRecord(recordValue: GovernedPlanRecord): void {
    try {
      const record = validateGovernedPlanRecord(recordValue);
      this.#schedule({
        workspaceId: record.bindings.workspaceId,
        planId: record.planId,
        observation: Object.freeze({
          kind: 'record',
          expectedRevision: record.revision - 1,
          record,
        }),
      });
    } catch {
      // Observation failures cannot affect the TypeScript authority.
    }
  }

  observeConfirmation(
    recordValue: GovernedPlanRecord,
    observationValue: GovernanceShadowConfirmationObservation,
  ): void {
    try {
      const record = validateGovernedPlanRecord(recordValue);
      const envelope = validateGovernanceShadowEnvelope({
        schema: GOVERNANCE_SHADOW_OBSERVATION_SCHEMA,
        authority: 'typescript',
        source: {
          workspaceId: record.bindings.workspaceId,
          planId: record.planId,
          sourceSequence: 1,
        },
        observation: observationValue,
      });
      this.#schedule({
        workspaceId: record.bindings.workspaceId,
        planId: record.planId,
        observation: envelope.observation,
        prerequisiteRecord: record,
      });
    } catch {
      // Observation failures cannot affect the TypeScript authority.
    }
  }

  observeAudit(recordValue: GovernedPlanRecord, eventValue: GovernedPlanAuditEvent): void {
    try {
      const record = validateGovernedPlanRecord(recordValue);
      const event = validateAuditEvent(eventValue);
      if (
        event.planId !== record.planId ||
        event.workspaceId !== record.bindings.workspaceId ||
        event.correlationId !== record.bindings.correlationId ||
        event.revision !== record.revision ||
        event.state !== record.state
      ) {
        return;
      }
      this.#schedule({
        workspaceId: record.bindings.workspaceId,
        planId: record.planId,
        observation: Object.freeze({
          kind: 'audit',
          recordRevision: record.revision,
          recordHash: governanceShadowRecordHash(record),
          event,
        }),
        prerequisiteRecord: record,
      });
    } catch {
      // Observation failures cannot affect the TypeScript authority.
    }
  }

  reconcile(records: readonly GovernedPlanRecord[]): void {
    try {
      for (const value of records) {
        const record = validateGovernedPlanRecord(value);
        void this.#reconcileRecord(record).catch(() => undefined);
      }
    } catch {
      // Reconciliation is shadow-only and cannot affect the caller.
    }
  }

  replay(): Promise<void> {
    return this.#replayAll();
  }

  #schedule(pending: PendingObservation): void {
    const hashValue = streamHash(pending.workspaceId, pending.planId);
    void this.#enqueueStream(hashValue, async () => {
      await this.#append(pending, hashValue);
      await this.#drain(pending.workspaceId, pending.planId, hashValue);
    }).catch(() => {
      this.#diagnose('journal_invalid', pending.workspaceId, pending.planId, undefined, 'append');
    });
  }

  #enqueueStream(hashValue: string, operation: () => Promise<void>): Promise<void> {
    const key = `${this.#directories.root}\0${hashValue}`;
    const previous = streamTails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    streamTails.set(key, current);
    const cleanup = () => {
      if (streamTails.get(key) === current) streamTails.delete(key);
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  async #append(pending: PendingObservation, hashValue: string): Promise<void> {
    const releaseCapacity = await acquireStreamLock(this.#directories, JOURNAL_CAPACITY_LOCK_HASH);
    try {
      const releaseStream = await acquireStreamLock(this.#directories, hashValue);
      try {
        let state = await loadState(this.#directories, pending.workspaceId, pending.planId);
        const entries = await streamEntries(this.#directories, hashValue);
        const maximumEntry = entries.at(-1)?.sequence ?? 0;
        if (maximumEntry > state.lastSequence) {
          state = Object.freeze({ ...state, lastSequence: maximumEntry });
        }
        const observations: GovernanceShadowObservation[] = [];
        if (
          pending.prerequisiteRecord !== undefined &&
          pending.prerequisiteRecord.revision > state.lastRecordRevision
        ) {
          observations.push(
            Object.freeze({
              kind: 'record',
              expectedRevision: pending.prerequisiteRecord.revision - 1,
              record: pending.prerequisiteRecord,
            }),
          );
        }
        if (
          pending.observation.kind !== 'record' ||
          pending.observation.record.revision > state.lastRecordRevision
        ) {
          observations.push(pending.observation);
        }
        if (observations.length === 0) return;

        let nextState = state;
        const journalEntries: { readonly path: string; readonly body: string }[] = [];
        for (const observation of observations) {
          const sourceSequence = nextState.lastSequence + 1;
          const envelope = validateGovernanceShadowEnvelope({
            schema: GOVERNANCE_SHADOW_OBSERVATION_SCHEMA,
            authority: 'typescript',
            source: {
              workspaceId: pending.workspaceId,
              planId: pending.planId,
              sourceSequence,
            },
            observation,
          });
          const body = `${canonicalGovernedJson(envelope)}\n`;
          const digest = sha256(body);
          journalEntries.push(
            Object.freeze({
              path: join(
                this.#directories.entries,
                `${hashValue}.${String(sourceSequence).padStart(16, '0')}.${digest}.json`,
              ),
              body,
            }),
          );
          nextState = Object.freeze({
            ...nextState,
            lastSequence: sourceSequence,
            lastRecordRevision:
              observation.kind === 'record'
                ? Math.max(nextState.lastRecordRevision, observation.record.revision)
                : nextState.lastRecordRevision,
          });
        }
        const stateBody = `${canonicalGovernedJson(nextState)}\n`;
        assertJournalAppendCapacity(
          await scanJournalBounds(this.#directories),
          journalEntries.length,
          journalEntries.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.body, 'utf8'), 0),
          Buffer.byteLength(stateBody, 'utf8'),
        );
        for (const entry of journalEntries) {
          await writeExclusive(entry.path, entry.body);
        }
        await syncDirectory(this.#directories.entries);
        await persistState(this.#directories, nextState);
      } finally {
        await releaseStream();
      }
    } finally {
      await releaseCapacity();
    }
  }

  #scheduleDrain(workspaceId: string, planId: string, hashValue: string): void {
    void this.#enqueueStream(hashValue, () => this.#drain(workspaceId, planId, hashValue)).catch(
      () => undefined,
    );
  }

  async #drain(workspaceId: string, planId: string, hashValue: string): Promise<void> {
    let state = await loadState(this.#directories, workspaceId, planId);
    for (const entry of await streamEntries(this.#directories, hashValue)) {
      if (entry.sequence <= state.ackedSequence) {
        const release = await acquireStreamLock(this.#directories, hashValue);
        try {
          state = await loadState(this.#directories, workspaceId, planId);
          if (entry.sequence <= state.ackedSequence) {
            await rm(entry.path, { force: true });
            await syncDirectory(this.#directories.entries);
          }
        } finally {
          await release();
        }
        continue;
      }
      if (entry.sequence !== state.ackedSequence + 1) {
        await this.#markIncomplete(state, entry.sequence);
        return;
      }
      const envelope = validateGovernanceShadowEnvelope(await readCanonical(entry.path));
      if (
        envelope.source.workspaceId !== workspaceId ||
        envelope.source.planId !== planId ||
        envelope.source.sourceSequence !== entry.sequence
      ) {
        await this.#markIncomplete(state, entry.sequence);
        return;
      }
      let receipt: GovernanceShadowReceipt;
      try {
        receipt = await this.#publisher.publish(envelope);
      } catch {
        this.#diagnose('unavailable', workspaceId, planId, entry.sequence, 'publish');
        return;
      }
      if (
        receipt.workspaceId !== workspaceId ||
        receipt.planId !== planId ||
        receipt.sourceSequence !== entry.sequence ||
        receipt.status === 'reconciliation_required'
      ) {
        this.#diagnose('unavailable', workspaceId, planId, entry.sequence, 'receipt_binding');
        return;
      }
      const release = await acquireStreamLock(this.#directories, hashValue);
      try {
        state = await loadState(this.#directories, workspaceId, planId);
        if (state.ackedSequence + 1 !== entry.sequence) return;
        state = Object.freeze({ ...state, ackedSequence: entry.sequence });
        await persistState(this.#directories, state);
        await rm(entry.path, { force: true });
        await syncDirectory(this.#directories.entries);
      } finally {
        await release();
      }
      this.#diagnose(
        receipt.parity === 'mismatched' ? 'mismatched' : receipt.status,
        workspaceId,
        planId,
        entry.sequence,
        receipt.parity === 'mismatched' ? receipt.mismatchCode : undefined,
      );
    }
  }

  async #markIncomplete(state: JournalState, sequence: number): Promise<void> {
    const hashValue = streamHash(state.workspaceId, state.planId);
    const release = await acquireStreamLock(this.#directories, hashValue);
    try {
      const current = await loadState(this.#directories, state.workspaceId, state.planId);
      await persistState(this.#directories, { ...current, incomplete: true });
    } finally {
      await release();
    }
    this.#diagnose('journal_incomplete', state.workspaceId, state.planId, sequence, 'gap');
  }

  async #reconcileRecord(record: GovernedPlanRecord): Promise<void> {
    const state = await loadState(this.#directories, record.bindings.workspaceId, record.planId);
    if (record.revision > state.lastRecordRevision) {
      await this.#markIncomplete(state, state.lastSequence + 1);
      this.observeRecord(record);
    } else {
      this.#scheduleDrain(
        record.bindings.workspaceId,
        record.planId,
        streamHash(record.bindings.workspaceId, record.planId),
      );
    }
  }

  async #replayAll(): Promise<void> {
    const stateHashes = new Set<string>();
    for (const name of await readdir(this.#directories.states)) {
      const match = STATE_NAME.exec(name);
      if (!match) continue;
      const hashValue = match[1]!;
      stateHashes.add(hashValue);
      const value = plainObject(await readCanonical(join(this.#directories.states, name)));
      const workspaceId = identifier(value.workspaceId, 'state.workspaceId');
      const planId = identifier(value.planId, 'state.planId');
      if (streamHash(workspaceId, planId) !== hashValue) {
        throw new TypeError('Governance shadow journal state filename does not match its stream.');
      }
      let state = validateState(value, workspaceId, planId);
      const entries = await streamEntries(this.#directories, hashValue);
      const maximumEntry = entries.at(-1)?.sequence ?? 0;
      let lastRecordRevision = state.lastRecordRevision;
      let expected = state.ackedSequence + 1;
      for (const entry of entries) {
        const envelope = validateGovernanceShadowEnvelope(await readCanonical(entry.path));
        if (
          envelope.source.workspaceId !== workspaceId ||
          envelope.source.planId !== planId ||
          envelope.source.sourceSequence !== entry.sequence
        ) {
          throw new TypeError('Governance shadow journal entry bindings are inconsistent.');
        }
        if (envelope.observation.kind === 'record') {
          lastRecordRevision = Math.max(lastRecordRevision, envelope.observation.record.revision);
        }
        if (entry.sequence > state.ackedSequence) {
          if (entry.sequence !== expected) break;
          expected += 1;
        }
      }
      if (maximumEntry > state.lastSequence || lastRecordRevision > state.lastRecordRevision) {
        state = Object.freeze({
          ...state,
          lastSequence: Math.max(state.lastSequence, maximumEntry),
          lastRecordRevision,
        });
        await persistState(this.#directories, state);
      }
      if (expected <= state.lastSequence) {
        await this.#markIncomplete(state, expected);
        state = Object.freeze({ ...state, incomplete: true });
      }
      this.#scheduleDrain(workspaceId, planId, hashValue);
      if (state.incomplete) {
        this.#diagnose('journal_incomplete', workspaceId, planId, undefined, 'persisted_gap');
      }
    }

    const orphanHashes = new Set<string>();
    for (const name of await readdir(this.#directories.entries)) {
      const match = ENTRY_NAME.exec(name);
      if (match && !stateHashes.has(match[1]!)) orphanHashes.add(match[1]!);
    }
    for (const hashValue of orphanHashes) {
      const entries = await streamEntries(this.#directories, hashValue);
      const first = entries[0];
      if (!first) continue;
      const firstEnvelope = validateGovernanceShadowEnvelope(await readCanonical(first.path));
      const { workspaceId, planId } = firstEnvelope.source;
      if (streamHash(workspaceId, planId) !== hashValue) {
        throw new TypeError('Governance shadow orphan entry does not match its stream.');
      }
      let lastRecordRevision = 0;
      for (const entry of entries) {
        const envelope = validateGovernanceShadowEnvelope(await readCanonical(entry.path));
        if (
          envelope.source.workspaceId !== workspaceId ||
          envelope.source.planId !== planId ||
          envelope.source.sourceSequence !== entry.sequence
        ) {
          throw new TypeError('Governance shadow orphan entry bindings are inconsistent.');
        }
        if (envelope.observation.kind === 'record') {
          lastRecordRevision = Math.max(lastRecordRevision, envelope.observation.record.revision);
        }
      }
      let state = Object.freeze({
        ...defaultState(workspaceId, planId),
        lastSequence: entries.at(-1)!.sequence,
        lastRecordRevision,
        incomplete: first.sequence !== 1,
      });
      await persistState(this.#directories, state);
      if (state.incomplete) {
        await this.#markIncomplete(state, 1);
        state = Object.freeze({ ...state, incomplete: true });
      }
      this.#scheduleDrain(workspaceId, planId, hashValue);
    }
  }

  #diagnose(
    outcome: GovernanceShadowDiagnosticOutcome,
    workspaceId: string,
    planId: string,
    sourceSequence?: number,
    code?: string,
  ): void {
    if (!this.#diagnosticSink) return;
    const safeCode =
      code !== undefined &&
      /^[a-z0-9][a-z0-9._:-]{0,255}$/u.test(code) &&
      Buffer.byteLength(code, 'utf8') <= GOVERNANCE_SHADOW_POLICY.maxDiagnosticMessageBytes
        ? code
        : undefined;
    const diagnostic = Object.freeze({
      schema: 'openslack.governance_shadow_diagnostic.v1' as const,
      outcome,
      workspaceIdHash: sha256(workspaceId),
      planIdHash: sha256(planId),
      ...(sourceSequence === undefined ? {} : { sourceSequence }),
      ...(safeCode === undefined ? {} : { code: safeCode }),
    });
    try {
      void Promise.resolve(this.#diagnosticSink(diagnostic)).catch(() => undefined);
    } catch {
      // Diagnostics are shadow-only.
    }
  }
}

export async function createGovernedPlanShadowObservationPort(
  options: CreateGovernedPlanShadowObservationPortOptions,
): Promise<GovernedPlanShadowObservationPort> {
  const object = plainObject(options);
  if (!exactKeys(object, ['journalRoot', 'publisher'], ['diagnosticSink'])) {
    throw new TypeError('Governance shadow observation options use unknown fields.');
  }
  if (!isGovernanceShadowPublisherPort(object.publisher)) {
    throw new TypeError('Governance shadow publisher must be host-created.');
  }
  if (
    object.diagnosticSink !== undefined &&
    (typeof object.diagnosticSink !== 'function' || utilTypes.isProxy(object.diagnosticSink))
  ) {
    throw new TypeError('Governance shadow diagnostic sink must be an inert function.');
  }
  const directories = await initializeJournal(object.journalRoot as string);
  const port = Object.freeze(
    new GovernedPlanShadowObservationPortImpl(
      directories,
      object.publisher as GovernanceShadowPublisherPort,
      object.diagnosticSink as GovernanceShadowDiagnosticSink | undefined,
    ),
  );
  PORTS.add(port);
  await port.replay();
  return port;
}

export function isGovernedPlanShadowObservationPort(
  value: unknown,
): value is GovernedPlanShadowObservationPort {
  return Boolean(
    value && typeof value === 'object' && !utilTypes.isProxy(value) && PORTS.has(value),
  );
}

export function createGovernanceShadowPublisherPort(
  publish: GovernanceShadowPublisherPort['publish'],
): GovernanceShadowPublisherPort {
  if (typeof publish !== 'function' || utilTypes.isProxy(publish)) {
    throw new TypeError('Governance shadow publisher must be an inert host-owned function.');
  }
  const publisher = Object.freeze({ publish });
  PUBLISHERS.add(publisher);
  return publisher;
}

export function isGovernanceShadowPublisherPort(
  value: unknown,
): value is GovernanceShadowPublisherPort {
  return Boolean(
    value && typeof value === 'object' && !utilTypes.isProxy(value) && PUBLISHERS.has(value),
  );
}
