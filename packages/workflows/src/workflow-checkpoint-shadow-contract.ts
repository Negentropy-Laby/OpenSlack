import { createHash } from 'node:crypto';
import { canonicalJson } from './internal/canonical-json.js';
import {
  canonicalUtcTimestamp,
  closedDataRecord,
  immutableContractValue,
  ownDataField,
  type ContractDataRecord,
} from './internal/contract-validation.js';

export const WORKFLOW_CHECKPOINT_SHADOW_SCHEMA =
  'openslack.workflow_checkpoint_shadow_observation.v1' as const;
export const WORKFLOW_CHECKPOINT_CONTROL_SCHEMA =
  'openslack.workflow_checkpoint_control.v1' as const;
export const WORKFLOW_CHECKPOINT_SHADOW_ENVELOPE_SCHEMA =
  'openslack.workflow_checkpoint_shadow_envelope.v1' as const;
export const WORKFLOW_CHECKPOINT_SHADOW_RECEIPT_SCHEMA =
  'openslack.workflow_checkpoint_shadow_receipt.v1' as const;
export const WORKFLOW_CHECKPOINT_SHADOW_ROUTE = '/v1/shadow/workflow-control/checkpoints' as const;
export const WORKFLOW_CHECKPOINT_SHADOW_IDEMPOTENCY_PREFIX =
  'openslack.workflow-checkpoint-shadow.v1.' as const;
export const WORKFLOW_CHECKPOINT_MAX_SOURCE_SEQUENCE = 9_007_199_254_740_990;
const WORKFLOW_CHECKPOINT_CANONICAL_MAX_DEPTH = 64;

export type WorkflowCheckpointErrorCode =
  | 'WORKFLOW_CHECKPOINT_ARTIFACT_INVALID'
  | 'WORKFLOW_CHECKPOINT_ARTIFACT_MISSING'
  | 'WORKFLOW_CHECKPOINT_ARTIFACT_TAMPERED'
  | 'WORKFLOW_CHECKPOINT_BINDING_INVALID'
  | 'WORKFLOW_CHECKPOINT_BINDING_STALE'
  | 'WORKFLOW_CHECKPOINT_COMMIT_INVALID'
  | 'WORKFLOW_CHECKPOINT_CONTRACT_INVALID'
  | 'WORKFLOW_CHECKPOINT_CONTROL_CORRUPT'
  | 'WORKFLOW_CHECKPOINT_CONTROL_MISSING'
  | 'WORKFLOW_CHECKPOINT_JOURNAL_CAPACITY'
  | 'WORKFLOW_CHECKPOINT_JOURNAL_INVALID'
  | 'WORKFLOW_CHECKPOINT_OBSERVER_CONFIG_INVALID'
  | 'WORKFLOW_CHECKPOINT_RECONCILIATION_REQUIRED'
  | 'WORKFLOW_CHECKPOINT_RESUME_INVALID'
  | 'WORKFLOW_CHECKPOINT_TRANSPORT_INVALID';

export class WorkflowCheckpointError extends Error {
  constructor(
    readonly code: WorkflowCheckpointErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'WorkflowCheckpointError';
  }
}

export function workflowCheckpointError(
  code: WorkflowCheckpointErrorCode,
  message: string,
  cause?: unknown,
): WorkflowCheckpointError {
  return new WorkflowCheckpointError(code, message, cause === undefined ? undefined : { cause });
}

export interface WorkflowCheckpointExecutionBinding {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly workflowRunId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly correlationId: string;
  readonly runnerBuildHash: string;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
  readonly inputHash: string;
}

export interface WorkflowCheckpointRecord {
  readonly checkpointId: string;
  readonly phaseId: string;
  readonly phaseIndex: number;
  readonly commitPoint: 'after_phase_work';
  readonly artifactRef: string;
  readonly artifactHash: string;
  readonly resultHash: string | null;
  readonly cacheKeyHash: string | null;
  readonly committedRevision: number;
  readonly resumeGeneration: number;
  readonly committedAt: string;
}

export interface WorkflowCheckpointControlState {
  readonly schema: typeof WORKFLOW_CHECKPOINT_CONTROL_SCHEMA;
  readonly runId: string;
  readonly revision: number;
  readonly resumeGeneration: number;
  readonly sourceSequence: number;
  readonly shadowEnabled: boolean;
  readonly shadowOverflowed: boolean;
  readonly activeBinding: WorkflowCheckpointExecutionBinding;
  /** Hash-only lineage rejects stale attempts while keeping runner identities out of history. */
  readonly seenBindingHashes: readonly string[];
  readonly checkpoints: readonly WorkflowCheckpointRecord[];
  readonly pendingObservations: readonly WorkflowCheckpointPendingObservation[];
  readonly updatedAt: string;
}

export interface WorkflowCheckpointPendingObservation {
  readonly sourceSequence: number;
  readonly operation: 'checkpoint_commit' | 'resume_advance';
  readonly observation: WorkflowCheckpointShadowObservation;
}

export interface WorkflowCheckpointShadowObservation {
  readonly schema: typeof WORKFLOW_CHECKPOINT_SHADOW_SCHEMA;
  readonly authority: 'typescript';
  readonly goRole: 'observer_only';
  readonly runId: string;
  readonly revision: number;
  readonly resumeGeneration: number;
  readonly checkpoint: WorkflowCheckpointRecord | null;
  readonly priorCheckpoint: WorkflowCheckpointRecord | null;
  readonly nextPhaseId: string | null;
  readonly nextPhaseIndex: number | null;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
  readonly inputHash: string;
  readonly runner: {
    readonly workspaceId: string;
    readonly jobId: string;
    readonly attemptId: string;
    readonly leaseId: string;
    readonly fencingToken: number;
    readonly correlationId: string;
    readonly runnerBuildHash: string;
  };
}

export interface WorkflowCheckpointShadowEnvelope {
  readonly schema: typeof WORKFLOW_CHECKPOINT_SHADOW_ENVELOPE_SCHEMA;
  readonly goRole: 'observer_only';
  readonly sourceSequence: number;
  readonly operation: 'checkpoint_commit' | 'resume_advance';
  readonly observation: WorkflowCheckpointShadowObservation;
  readonly observationHash: string;
}

export interface WorkflowCheckpointShadowReceipt {
  readonly schema: typeof WORKFLOW_CHECKPOINT_SHADOW_RECEIPT_SCHEMA;
  /** Replay returns these exact accepted bytes; duplicate is transport metadata only. */
  readonly status: 'accepted' | 'reconciliation_required';
  readonly idempotencyKey: string;
  readonly receiptId: string;
  readonly observationId: string | null;
  readonly workspaceId: string;
  readonly runId: string;
  readonly sourceSequence: number;
  readonly operation: 'checkpoint_commit' | 'resume_advance';
  readonly parity: 'matched' | 'mismatched' | 'unknown';
  readonly mismatchCode: string | null;
  readonly reconciliationToken: string | null;
  readonly envelopeHash: string;
  readonly observationHash: string;
  readonly serviceBuildHash: string;
  readonly committedAt: string | null;
}

export class WorkflowCheckpointContractError extends WorkflowCheckpointError {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super('WORKFLOW_CHECKPOINT_CONTRACT_INVALID', message);
    this.name = 'WorkflowCheckpointContractError';
  }
}

type DataRecord = ContractDataRecord;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const IDEMPOTENCY = /^openslack\.workflow-checkpoint-shadow\.v1\.[0-9a-f]{64}$/u;

function fail(path: string, message: string): never {
  throw new WorkflowCheckpointContractError(path, message);
}

function record(value: unknown, fields: readonly string[], path: string): DataRecord {
  return closedDataRecord(value, fields, path, {
    inert: (recordPath) => fail(recordPath, `${recordPath} must be an inert object.`),
    missing: (recordPath) => fail(recordPath, `${recordPath} has missing or unknown fields.`),
    unknown: (recordPath) => fail(recordPath, `${recordPath} has missing or unknown fields.`),
    dataField: (recordPath, key) =>
      fail(`${recordPath}/${String(key)}`, 'Only enumerable data fields are allowed.'),
  });
}

function own(value: DataRecord, key: string): unknown {
  return ownDataField(value, key);
}

function text(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) return fail(path, `${path} is invalid.`);
  return value;
}

function id(value: unknown, path: string): string {
  return text(value, path, SAFE_ID);
}

function hash(value: unknown, path: string): string {
  return text(value, path, HASH);
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail(path, `${path} must be a safe integer >= ${minimum}.`);
  }
  return value as number;
}

function timestamp(value: unknown, path: string): string {
  return canonicalUtcTimestamp(
    value,
    path,
    (input, inputPath) => text(input, inputPath, TIMESTAMP),
    (inputPath) => fail(inputPath, `${inputPath} is not canonical UTC.`),
  );
}

function immutable<T>(value: T): T {
  return immutableContractValue(value);
}

export function validateWorkflowCheckpointExecutionBinding(
  value: unknown,
): WorkflowCheckpointExecutionBinding {
  const fields = [
    'workspaceId',
    'jobId',
    'workflowRunId',
    'attemptId',
    'leaseId',
    'fencingToken',
    'correlationId',
    'runnerBuildHash',
    'workflowSourceHash',
    'manifestHash',
    'inputHash',
  ] as const;
  const item = record(value, fields, '$/binding');
  return immutable({
    workspaceId: id(own(item, 'workspaceId'), '$/binding/workspaceId'),
    jobId: id(own(item, 'jobId'), '$/binding/jobId'),
    workflowRunId: id(own(item, 'workflowRunId'), '$/binding/workflowRunId'),
    attemptId: id(own(item, 'attemptId'), '$/binding/attemptId'),
    leaseId: id(own(item, 'leaseId'), '$/binding/leaseId'),
    fencingToken: integer(own(item, 'fencingToken'), '$/binding/fencingToken', 1),
    correlationId: id(own(item, 'correlationId'), '$/binding/correlationId'),
    runnerBuildHash: hash(own(item, 'runnerBuildHash'), '$/binding/runnerBuildHash'),
    workflowSourceHash: hash(own(item, 'workflowSourceHash'), '$/binding/workflowSourceHash'),
    manifestHash: hash(own(item, 'manifestHash'), '$/binding/manifestHash'),
    inputHash: hash(own(item, 'inputHash'), '$/binding/inputHash'),
  });
}

export function validateWorkflowCheckpointRecord(
  value: unknown,
  path = '$/checkpoint',
): WorkflowCheckpointRecord {
  const item = record(
    value,
    [
      'checkpointId',
      'phaseId',
      'phaseIndex',
      'commitPoint',
      'artifactRef',
      'artifactHash',
      'resultHash',
      'cacheKeyHash',
      'committedRevision',
      'resumeGeneration',
      'committedAt',
    ],
    path,
  );
  if (own(item, 'commitPoint') !== 'after_phase_work') {
    return fail(`${path}/commitPoint`, 'Checkpoint commit point must be after_phase_work.');
  }
  const nullableHash = (key: 'resultHash' | 'cacheKeyHash') =>
    own(item, key) === null ? null : hash(own(item, key), `${path}/${key}`);
  const phaseId = id(own(item, 'phaseId'), `${path}/phaseId`);
  const phaseIndex = integer(own(item, 'phaseIndex'), `${path}/phaseIndex`);
  if (phaseId !== `phase-${phaseIndex}`) {
    fail(`${path}/phaseId`, 'Checkpoint phase identity is invalid.');
  }
  return immutable({
    checkpointId: id(own(item, 'checkpointId'), `${path}/checkpointId`),
    phaseId,
    phaseIndex,
    commitPoint: 'after_phase_work' as const,
    artifactRef: text(own(item, 'artifactRef'), `${path}/artifactRef`, SAFE_REF),
    artifactHash: hash(own(item, 'artifactHash'), `${path}/artifactHash`),
    resultHash: nullableHash('resultHash'),
    cacheKeyHash: nullableHash('cacheKeyHash'),
    committedRevision: integer(own(item, 'committedRevision'), `${path}/committedRevision`, 1),
    resumeGeneration: integer(own(item, 'resumeGeneration'), `${path}/resumeGeneration`),
    committedAt: timestamp(own(item, 'committedAt'), `${path}/committedAt`),
  });
}

export function validateWorkflowCheckpointControlState(
  value: unknown,
  expectedRunId?: string,
): WorkflowCheckpointControlState {
  const item = record(
    value,
    [
      'schema',
      'runId',
      'revision',
      'resumeGeneration',
      'sourceSequence',
      'shadowEnabled',
      'shadowOverflowed',
      'activeBinding',
      'seenBindingHashes',
      'checkpoints',
      'pendingObservations',
      'updatedAt',
    ],
    '$',
  );
  if (own(item, 'schema') !== WORKFLOW_CHECKPOINT_CONTROL_SCHEMA)
    fail('$/schema', 'Schema is invalid.');
  const runId = id(own(item, 'runId'), '$/runId');
  if (expectedRunId !== undefined && runId !== expectedRunId)
    fail('$/runId', 'Run path is mismatched.');
  const revision = integer(own(item, 'revision'), '$/revision', 1);
  const resumeGeneration = integer(own(item, 'resumeGeneration'), '$/resumeGeneration');
  const sourceSequence = integer(own(item, 'sourceSequence'), '$/sourceSequence');
  if (sourceSequence > WORKFLOW_CHECKPOINT_MAX_SOURCE_SEQUENCE) {
    fail('$/sourceSequence', 'Source sequence exceeds the safe revision boundary.');
  }
  const shadowEnabled = own(item, 'shadowEnabled');
  if (typeof shadowEnabled !== 'boolean')
    fail('$/shadowEnabled', 'Shadow enabled flag is invalid.');
  const shadowOverflowed = own(item, 'shadowOverflowed');
  if (typeof shadowOverflowed !== 'boolean')
    fail('$/shadowOverflowed', 'Overflow flag is invalid.');
  const activeBinding = validateWorkflowCheckpointExecutionBinding(own(item, 'activeBinding'));
  if (activeBinding.workflowRunId !== runId)
    fail('$/activeBinding/workflowRunId', 'Binding run is mismatched.');
  const hashes = own(item, 'seenBindingHashes');
  if (!Array.isArray(hashes) || hashes.length !== resumeGeneration + 1 || hashes.length > 1024) {
    fail('$/seenBindingHashes', 'Binding lineage is invalid.');
  }
  const seenBindingHashes = hashes.map((entry, index) =>
    hash(entry, `$/seenBindingHashes/${index}`),
  );
  if (
    new Set(seenBindingHashes).size !== seenBindingHashes.length ||
    seenBindingHashes.at(-1) !== workflowCheckpointHash(activeBinding)
  ) {
    fail('$/seenBindingHashes', 'Binding lineage does not match the active binding.');
  }
  const values = own(item, 'checkpoints');
  if (!Array.isArray(values) || values.length > 1024)
    fail('$/checkpoints', 'Checkpoint list is invalid.');
  const checkpoints = values.map((entry, index) =>
    validateWorkflowCheckpointRecord(entry, `$/checkpoints/${index}`),
  );
  checkpoints.forEach((entry, index) => {
    if (
      entry.phaseIndex !== index ||
      entry.committedRevision !== index + entry.resumeGeneration + 2 ||
      entry.committedRevision > revision ||
      entry.resumeGeneration > resumeGeneration
    ) {
      fail(`$/checkpoints/${index}`, 'Checkpoint order or revision is invalid.');
    }
  });
  if (revision !== checkpoints.length + resumeGeneration + 1) {
    fail('$/revision', 'Control revision does not match checkpoint and resume history.');
  }
  const pendingValues = own(item, 'pendingObservations');
  if (!Array.isArray(pendingValues) || pendingValues.length > 1024) {
    fail('$/pendingObservations', 'Pending observation list is invalid.');
  }
  const pendingObservations = pendingValues.map((entry, index) => {
    const pending = record(
      entry,
      ['sourceSequence', 'operation', 'observation'],
      `$/pendingObservations/${index}`,
    );
    const pendingSequence = integer(
      own(pending, 'sourceSequence'),
      `$/pendingObservations/${index}/sourceSequence`,
      1,
    );
    if (pendingSequence > WORKFLOW_CHECKPOINT_MAX_SOURCE_SEQUENCE) {
      fail(`$/pendingObservations/${index}/sourceSequence`, 'Pending sequence is too large.');
    }
    const observation = validateWorkflowCheckpointShadowObservation(own(pending, 'observation'));
    const pendingOperation = own(pending, 'operation');
    if (pendingOperation !== 'checkpoint_commit' && pendingOperation !== 'resume_advance') {
      fail(`$/pendingObservations/${index}/operation`, 'Pending operation is invalid.');
    }
    const operation: WorkflowCheckpointPendingObservation['operation'] = pendingOperation;
    if (pendingSequence > sourceSequence || observation.runId !== runId) {
      fail(`$/pendingObservations/${index}`, 'Pending observation head is invalid.');
    }
    if (
      observation.revision !== pendingSequence + 1 ||
      (pendingOperation === 'checkpoint_commit') !== (observation.checkpoint !== null)
    ) {
      fail(`$/pendingObservations/${index}`, 'Pending observation sequence is invalid.');
    }
    return immutable({
      sourceSequence: pendingSequence,
      operation,
      observation,
    });
  });
  if (
    new Set(pendingObservations.map((entry) => entry.sourceSequence)).size !==
    pendingObservations.length
  ) {
    fail('$/pendingObservations', 'Pending observation sequence is duplicated.');
  }
  if (
    pendingObservations.some(
      (entry, index) =>
        index > 0 && entry.sourceSequence <= pendingObservations[index - 1]!.sourceSequence,
    )
  ) {
    fail('$/pendingObservations', 'Pending observations are not ordered.');
  }
  if (
    (!shadowEnabled &&
      (sourceSequence !== 0 || shadowOverflowed || pendingObservations.length > 0)) ||
    (shadowEnabled && !shadowOverflowed && revision !== sourceSequence + 1)
  ) {
    fail('$/sourceSequence', 'Shadow sequence is inconsistent with the control revision.');
  }
  return immutable({
    schema: WORKFLOW_CHECKPOINT_CONTROL_SCHEMA,
    runId,
    revision,
    resumeGeneration,
    sourceSequence,
    shadowEnabled,
    shadowOverflowed,
    activeBinding,
    seenBindingHashes,
    checkpoints,
    pendingObservations,
    updatedAt: timestamp(own(item, 'updatedAt'), '$/updatedAt'),
  });
}

export function validateWorkflowCheckpointShadowObservation(
  value: unknown,
): WorkflowCheckpointShadowObservation {
  const item = record(
    value,
    [
      'schema',
      'authority',
      'goRole',
      'runId',
      'revision',
      'resumeGeneration',
      'workflowSourceHash',
      'manifestHash',
      'inputHash',
      'runner',
      'checkpoint',
      'priorCheckpoint',
      'nextPhaseId',
      'nextPhaseIndex',
    ],
    '$',
  );
  if (
    own(item, 'schema') !== WORKFLOW_CHECKPOINT_SHADOW_SCHEMA ||
    own(item, 'authority') !== 'typescript' ||
    own(item, 'goRole') !== 'observer_only'
  ) {
    fail('$/schema', 'Observation identity is invalid.');
  }
  const runId = id(own(item, 'runId'), '$/runId');
  const revision = integer(own(item, 'revision'), '$/revision', 1);
  const resumeGeneration = integer(own(item, 'resumeGeneration'), '$/resumeGeneration');
  const checkpoint =
    own(item, 'checkpoint') === null
      ? null
      : validateWorkflowCheckpointRecord(own(item, 'checkpoint'));
  const priorCheckpoint =
    own(item, 'priorCheckpoint') === null
      ? null
      : validateWorkflowCheckpointRecord(own(item, 'priorCheckpoint'), '$/priorCheckpoint');
  const nextPhaseId =
    own(item, 'nextPhaseId') === null ? null : id(own(item, 'nextPhaseId'), '$/nextPhaseId');
  const nextPhaseIndex =
    own(item, 'nextPhaseIndex') === null
      ? null
      : integer(own(item, 'nextPhaseIndex'), '$/nextPhaseIndex');
  if (
    nextPhaseId !== null &&
    nextPhaseIndex !== null &&
    nextPhaseId !== `phase-${nextPhaseIndex}`
  ) {
    fail('$/nextPhaseId', 'Resume phase identity is invalid.');
  }
  const runnerValue = record(
    own(item, 'runner'),
    [
      'workspaceId',
      'jobId',
      'attemptId',
      'leaseId',
      'fencingToken',
      'correlationId',
      'runnerBuildHash',
    ],
    '$/runner',
  );
  const checkpointVariant =
    checkpoint !== null &&
    priorCheckpoint === null &&
    nextPhaseId === null &&
    nextPhaseIndex === null &&
    checkpoint.committedRevision === revision &&
    checkpoint.resumeGeneration === resumeGeneration;
  const initialResumeVariant =
    checkpoint === null &&
    priorCheckpoint === null &&
    nextPhaseId === 'phase-0' &&
    nextPhaseIndex === 0 &&
    revision > 1 &&
    resumeGeneration > 0;
  const checkpointResumeVariant =
    checkpoint === null &&
    priorCheckpoint !== null &&
    nextPhaseId !== null &&
    nextPhaseIndex === priorCheckpoint.phaseIndex + 1 &&
    revision > priorCheckpoint.committedRevision &&
    resumeGeneration > priorCheckpoint.resumeGeneration;
  const resumeVariant = initialResumeVariant || checkpointResumeVariant;
  if (checkpointVariant === resumeVariant) {
    fail('$/checkpoint', 'Observation variant is invalid.');
  }
  return immutable({
    schema: WORKFLOW_CHECKPOINT_SHADOW_SCHEMA,
    authority: 'typescript' as const,
    goRole: 'observer_only' as const,
    runId,
    revision,
    resumeGeneration,
    checkpoint,
    priorCheckpoint,
    nextPhaseId,
    nextPhaseIndex,
    workflowSourceHash: hash(own(item, 'workflowSourceHash'), '$/workflowSourceHash'),
    manifestHash: hash(own(item, 'manifestHash'), '$/manifestHash'),
    inputHash: hash(own(item, 'inputHash'), '$/inputHash'),
    runner: immutable({
      workspaceId: id(own(runnerValue, 'workspaceId'), '$/runner/workspaceId'),
      jobId: id(own(runnerValue, 'jobId'), '$/runner/jobId'),
      attemptId: id(own(runnerValue, 'attemptId'), '$/runner/attemptId'),
      leaseId: id(own(runnerValue, 'leaseId'), '$/runner/leaseId'),
      fencingToken: integer(own(runnerValue, 'fencingToken'), '$/runner/fencingToken', 1),
      correlationId: id(own(runnerValue, 'correlationId'), '$/runner/correlationId'),
      runnerBuildHash: hash(own(runnerValue, 'runnerBuildHash'), '$/runner/runnerBuildHash'),
    }),
  });
}

export function validateWorkflowCheckpointShadowEnvelope(
  value: unknown,
): WorkflowCheckpointShadowEnvelope {
  const item = record(
    value,
    ['schema', 'goRole', 'sourceSequence', 'operation', 'observation', 'observationHash'],
    '$',
  );
  if (own(item, 'schema') !== WORKFLOW_CHECKPOINT_SHADOW_ENVELOPE_SCHEMA)
    fail('$/schema', 'Envelope schema is invalid.');
  if (own(item, 'goRole') !== 'observer_only') fail('$/goRole', 'Go role is invalid.');
  const operation = own(item, 'operation');
  if (operation !== 'checkpoint_commit' && operation !== 'resume_advance') {
    fail('$/operation', 'Envelope operation is invalid.');
  }
  const observation = validateWorkflowCheckpointShadowObservation(own(item, 'observation'));
  const sourceSequence = integer(own(item, 'sourceSequence'), '$/sourceSequence', 1);
  if (sourceSequence > WORKFLOW_CHECKPOINT_MAX_SOURCE_SEQUENCE) {
    fail('$/sourceSequence', 'Envelope sequence is too large.');
  }
  if (observation.revision !== sourceSequence + 1) {
    fail('$/sourceSequence', 'Envelope sequence does not match observation revision.');
  }
  if ((operation === 'checkpoint_commit') !== (observation.checkpoint !== null)) {
    fail('$/operation', 'Envelope operation does not match observation variant.');
  }
  const observationHash = hash(own(item, 'observationHash'), '$/observationHash');
  if (workflowCheckpointHash(observation) !== observationHash)
    fail('$/observationHash', 'Observation hash is mismatched.');
  return immutable({
    schema: WORKFLOW_CHECKPOINT_SHADOW_ENVELOPE_SCHEMA,
    goRole: 'observer_only' as const,
    sourceSequence,
    operation,
    observation,
    observationHash,
  });
}

export function validateWorkflowCheckpointShadowReceipt(
  value: unknown,
): WorkflowCheckpointShadowReceipt {
  const item = record(
    value,
    [
      'schema',
      'status',
      'idempotencyKey',
      'receiptId',
      'observationId',
      'workspaceId',
      'runId',
      'sourceSequence',
      'operation',
      'parity',
      'mismatchCode',
      'reconciliationToken',
      'envelopeHash',
      'observationHash',
      'serviceBuildHash',
      'committedAt',
    ],
    '$',
  );
  if (own(item, 'schema') !== WORKFLOW_CHECKPOINT_SHADOW_RECEIPT_SCHEMA)
    fail('$/schema', 'Receipt schema is invalid.');
  const status = own(item, 'status');
  if (status !== 'accepted' && status !== 'reconciliation_required') {
    fail('$/status', 'Receipt status is invalid.');
  }
  const operation = own(item, 'operation');
  if (operation !== 'checkpoint_commit' && operation !== 'resume_advance') {
    fail('$/operation', 'Receipt operation is invalid.');
  }
  const parity = own(item, 'parity');
  if (parity !== 'matched' && parity !== 'mismatched' && parity !== 'unknown') {
    fail('$/parity', 'Receipt parity is invalid.');
  }
  const mismatchCode =
    own(item, 'mismatchCode') === null ? null : id(own(item, 'mismatchCode'), '$/mismatchCode');
  const observationId =
    own(item, 'observationId') === null ? null : id(own(item, 'observationId'), '$/observationId');
  const reconciliationToken =
    own(item, 'reconciliationToken') === null
      ? null
      : id(own(item, 'reconciliationToken'), '$/reconciliationToken');
  const committedAt =
    own(item, 'committedAt') === null ? null : timestamp(own(item, 'committedAt'), '$/committedAt');
  const acceptedValid =
    status === 'accepted' &&
    (parity === 'matched' || parity === 'mismatched') &&
    observationId !== null &&
    committedAt !== null &&
    reconciliationToken === null &&
    (parity === 'matched') === (mismatchCode === null);
  const reconciliationValid =
    status === 'reconciliation_required' &&
    parity === 'unknown' &&
    observationId === null &&
    committedAt === null &&
    mismatchCode === null &&
    reconciliationToken !== null;
  if (!acceptedValid && !reconciliationValid) fail('$/status', 'Receipt variant is invalid.');
  return immutable({
    schema: WORKFLOW_CHECKPOINT_SHADOW_RECEIPT_SCHEMA,
    status: status as WorkflowCheckpointShadowReceipt['status'],
    idempotencyKey: text(own(item, 'idempotencyKey'), '$/idempotencyKey', IDEMPOTENCY),
    receiptId: id(own(item, 'receiptId'), '$/receiptId'),
    observationId,
    workspaceId: id(own(item, 'workspaceId'), '$/workspaceId'),
    runId: id(own(item, 'runId'), '$/runId'),
    sourceSequence: (() => {
      const result = integer(own(item, 'sourceSequence'), '$/sourceSequence', 1);
      if (result > WORKFLOW_CHECKPOINT_MAX_SOURCE_SEQUENCE) {
        fail('$/sourceSequence', 'Receipt sequence is too large.');
      }
      return result;
    })(),
    operation,
    parity,
    mismatchCode,
    reconciliationToken,
    envelopeHash: hash(own(item, 'envelopeHash'), '$/envelopeHash'),
    observationHash: hash(own(item, 'observationHash'), '$/observationHash'),
    serviceBuildHash: hash(own(item, 'serviceBuildHash'), '$/serviceBuildHash'),
    committedAt,
  });
}

export function workflowCheckpointCanonicalJson(value: unknown): string {
  return canonicalJson(value, { maxDepth: WORKFLOW_CHECKPOINT_CANONICAL_MAX_DEPTH });
}

export function workflowCheckpointHash(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value, { maxDepth: WORKFLOW_CHECKPOINT_CANONICAL_MAX_DEPTH }), 'utf8')
    .digest('hex');
}

export function workflowCheckpointBytesHash(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}
