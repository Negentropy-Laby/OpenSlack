import { types as nodeTypes } from 'node:util';
import {
  WORKFLOW_EFFECT_CONTROL_IDEMPOTENCY_PREFIX,
  WORKFLOW_EFFECT_CONTROL_OBSERVER_OPERATIONS,
  WORKFLOW_EFFECT_CONTROL_ROUTE,
  canonicalWorkflowEffectControlJson,
  prepareWorkflowEffectControlEnvelope,
  validateWorkflowEffectControlEnvelope,
  type WorkflowEffectControlEnvelope,
  type WorkflowEffectControlObserverOperation,
} from './workflow-effect-control-contract.js';

export const WORKFLOW_EFFECT_SHADOW_RECEIPT_SCHEMA =
  'openslack.workflow_effect_shadow_receipt.v1' as const;
export const WORKFLOW_EFFECT_SHADOW_HEAD_SCHEMA =
  'openslack.workflow_effect_shadow_head.v1' as const;
export const WORKFLOW_EFFECT_SHADOW_ERROR_SCHEMA =
  'openslack.workflow_effect_shadow_error.v1' as const;
export const WORKFLOW_EFFECT_SHADOW_ROUTE = WORKFLOW_EFFECT_CONTROL_ROUTE;
export const WORKFLOW_EFFECT_SHADOW_RECONCILIATION_RESOLVE_ROUTE_PREFIX =
  '/v1/shadow/workflow-control/effect-reconciliations/' as const;
export const WORKFLOW_EFFECT_SHADOW_RECONCILIATION_RESOLVE_ROUTE_SUFFIX = '/resolve' as const;
export const WORKFLOW_EFFECT_SHADOW_IDEMPOTENCY_PREFIX = WORKFLOW_EFFECT_CONTROL_IDEMPOTENCY_PREFIX;
export const WORKFLOW_EFFECT_SHADOW_MAX_RECEIPT_BYTES = 64 * 1024;
export const WORKFLOW_EFFECT_SHADOW_MAX_ERROR_BYTES = 16 * 1024;

export const WORKFLOW_EFFECT_SHADOW_ERROR_CODES = Object.freeze([
  'WORKFLOW_EFFECT_SHADOW_INPUT_INVALID',
  'WORKFLOW_EFFECT_SHADOW_CONTENT_INVALID',
  'WORKFLOW_EFFECT_SHADOW_CONFLICT',
  'WORKFLOW_EFFECT_SHADOW_IDEMPOTENCY_CONFLICT',
  'WORKFLOW_EFFECT_SHADOW_COMMIT_OUTCOME_UNKNOWN',
  'WORKFLOW_EFFECT_SHADOW_NOT_FOUND',
  'WORKFLOW_EFFECT_SHADOW_INTEGRITY_ERROR',
  'WORKFLOW_EFFECT_SHADOW_DATABASE_ERROR',
  'WORKFLOW_EFFECT_SHADOW_UNAUTHORIZED',
  'WORKFLOW_EFFECT_SHADOW_CONTENT_TYPE',
  'WORKFLOW_EFFECT_SHADOW_REQUEST_TIMEOUT',
  'WORKFLOW_EFFECT_SHADOW_REQUEST_READ_FAILED',
  'WORKFLOW_EFFECT_SHADOW_NOT_READY',
  'WORKFLOW_EFFECT_SHADOW_METRICS_UNAVAILABLE',
  'WORKFLOW_EFFECT_SHADOW_INTERNAL',
] as const);
export type WorkflowEffectShadowErrorCode = (typeof WORKFLOW_EFFECT_SHADOW_ERROR_CODES)[number];

export interface WorkflowEffectShadowReceipt {
  readonly schema: typeof WORKFLOW_EFFECT_SHADOW_RECEIPT_SCHEMA;
  /** Exact replay returns the original accepted bytes; replay is HTTP metadata only. */
  readonly status: 'accepted' | 'reconciliation_required';
  readonly idempotencyKey: string;
  readonly receiptId: string;
  readonly observationId: string | null;
  readonly workspaceId: string;
  readonly runId: string;
  readonly occurrenceId: string;
  readonly approvalId: string;
  readonly sourceSequence: number;
  readonly operation: WorkflowEffectControlObserverOperation;
  readonly parity: 'matched' | 'mismatched' | 'unknown';
  readonly mismatchCode: string | null;
  readonly reconciliationToken: string | null;
  readonly envelopeHash: string;
  readonly observationHash: string;
  readonly serviceBuildHash: string;
  readonly committedAt: string | null;
}

export interface WorkflowEffectShadowHead {
  readonly schema: typeof WORKFLOW_EFFECT_SHADOW_HEAD_SCHEMA;
  readonly workspaceId: string;
  readonly runId: string;
  readonly occurrenceId: string;
  readonly approvalId: string;
  readonly lastSourceSequence: number;
  readonly lastOperation: WorkflowEffectControlObserverOperation;
  readonly lastObservationHash: string;
  readonly matchedSourceSequence: number | null;
  readonly matchedOperation: WorkflowEffectControlObserverOperation | null;
  readonly matchedObservationHash: string | null;
  readonly mismatchLatched: boolean;
  readonly mismatchCode: string | null;
  readonly serviceBuildHash: string;
  readonly updatedAt: string;
}

export interface WorkflowEffectShadowError {
  readonly schema: typeof WORKFLOW_EFFECT_SHADOW_ERROR_SCHEMA;
  readonly code: WorkflowEffectShadowErrorCode;
  readonly message: string;
}

type JsonRecord = Readonly<Record<string, unknown>>;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OCCURRENCE = /^WFOCCURRENCE-[0-9a-f]{64}$/u;
const IDEMPOTENCY = /^openslack\.workflow-effect-control-shadow\.v1\.[0-9a-f]{64}$/u;

export class WorkflowEffectShadowContractError extends Error {
  constructor(
    readonly code: 'WORKFLOW_EFFECT_SHADOW_CONTRACT_INVALID',
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowEffectShadowContractError';
  }
}

function fail(path: string, message: string): never {
  throw new WorkflowEffectShadowContractError(
    'WORKFLOW_EFFECT_SHADOW_CONTRACT_INVALID',
    path,
    message,
  );
}

function record(value: unknown, fields: readonly string[], path = '$'): JsonRecord {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail(path, `${path} must be an inert object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field)) ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) {
    return fail(path, `${path} has missing or unknown fields.`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return fail(`${path}/${String(key)}`, 'Only enumerable data fields are allowed.');
    }
  }
  return value as JsonRecord;
}

function own(value: JsonRecord, field: string): unknown {
  return value[field];
}

function text(value: unknown, path: string, pattern = SAFE_ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) return fail(path, `${path} is invalid.`);
  return value;
}

function integer(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail(path, `${path} is outside its integer bounds.`);
  }
  return value as number;
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path, TIMESTAMP);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(Date.parse(result)).toISOString() !== result
  ) {
    return fail(path, `${path} must be canonical UTC.`);
  }
  return result;
}

function operation(value: unknown, path: string): WorkflowEffectControlObserverOperation {
  if (!WORKFLOW_EFFECT_CONTROL_OBSERVER_OPERATIONS.includes(value as never)) {
    return fail(path, `${path} is not an observer operation.`);
  }
  return value as WorkflowEffectControlObserverOperation;
}

function immutable<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(immutable);
  else if (value !== null && typeof value === 'object') Object.values(value).forEach(immutable);
  return Object.freeze(value);
}

export function validateWorkflowEffectShadowReceipt(
  value: unknown,
  envelopeValue: WorkflowEffectControlEnvelope,
): WorkflowEffectShadowReceipt {
  const envelope = validateWorkflowEffectControlEnvelope(envelopeValue);
  const prepared = prepareWorkflowEffectControlEnvelope(envelope);
  const item = record(value, [
    'schema',
    'status',
    'idempotencyKey',
    'receiptId',
    'observationId',
    'workspaceId',
    'runId',
    'occurrenceId',
    'approvalId',
    'sourceSequence',
    'operation',
    'parity',
    'mismatchCode',
    'reconciliationToken',
    'envelopeHash',
    'observationHash',
    'serviceBuildHash',
    'committedAt',
  ]);
  const status = own(item, 'status');
  const parity = own(item, 'parity');
  const mismatchCode = own(item, 'mismatchCode');
  const reconciliationToken = own(item, 'reconciliationToken');
  const observationId = own(item, 'observationId');
  const committedAt = own(item, 'committedAt');
  if (
    own(item, 'schema') !== WORKFLOW_EFFECT_SHADOW_RECEIPT_SCHEMA ||
    !['accepted', 'reconciliation_required'].includes(status as string) ||
    !['matched', 'mismatched', 'unknown'].includes(parity as string) ||
    own(item, 'idempotencyKey') !== prepared.idempotencyKey ||
    own(item, 'workspaceId') !== envelope.observation.workspaceId ||
    own(item, 'runId') !== envelope.observation.runId ||
    own(item, 'occurrenceId') !== envelope.observation.occurrenceId ||
    own(item, 'approvalId') !== envelope.observation.approvalId ||
    own(item, 'sourceSequence') !== envelope.sourceSequence ||
    own(item, 'operation') !== envelope.operation ||
    own(item, 'observationHash') !== envelope.observationHash ||
    own(item, 'envelopeHash') !== prepared.bodyHash
  ) {
    return fail('$', 'Receipt does not bind the exact envelope.');
  }
  if (
    status === 'accepted'
      ? (parity !== 'matched' && parity !== 'mismatched') ||
        typeof observationId !== 'string' ||
        !SAFE_ID.test(observationId) ||
        reconciliationToken !== null ||
        committedAt === null ||
        (parity === 'matched' ? mismatchCode !== null : typeof mismatchCode !== 'string')
      : parity !== 'unknown' ||
        observationId !== null ||
        mismatchCode !== null ||
        typeof reconciliationToken !== 'string' ||
        !SAFE_ID.test(reconciliationToken) ||
        committedAt !== null
  ) {
    return fail('$', 'Receipt state is inconsistent.');
  }
  return immutable({
    schema: WORKFLOW_EFFECT_SHADOW_RECEIPT_SCHEMA,
    status: status as WorkflowEffectShadowReceipt['status'],
    idempotencyKey: text(own(item, 'idempotencyKey'), '$/idempotencyKey', IDEMPOTENCY),
    receiptId: text(own(item, 'receiptId'), '$/receiptId'),
    observationId: observationId as string | null,
    workspaceId: text(own(item, 'workspaceId'), '$/workspaceId'),
    runId: text(own(item, 'runId'), '$/runId'),
    occurrenceId: text(own(item, 'occurrenceId'), '$/occurrenceId', OCCURRENCE),
    approvalId: text(own(item, 'approvalId'), '$/approvalId'),
    sourceSequence: integer(own(item, 'sourceSequence'), '$/sourceSequence', 1, 3),
    operation: operation(own(item, 'operation'), '$/operation'),
    parity: parity as WorkflowEffectShadowReceipt['parity'],
    mismatchCode: mismatchCode === null ? null : text(mismatchCode, '$/mismatchCode', SAFE_CODE),
    reconciliationToken:
      reconciliationToken === null ? null : text(reconciliationToken, '$/reconciliationToken'),
    envelopeHash: text(own(item, 'envelopeHash'), '$/envelopeHash', HASH),
    observationHash: text(own(item, 'observationHash'), '$/observationHash', HASH),
    serviceBuildHash: text(own(item, 'serviceBuildHash'), '$/serviceBuildHash', HASH),
    committedAt: committedAt === null ? null : timestamp(committedAt, '$/committedAt'),
  });
}

export function validateWorkflowEffectShadowHead(value: unknown): WorkflowEffectShadowHead {
  const item = record(value, [
    'schema',
    'workspaceId',
    'runId',
    'occurrenceId',
    'approvalId',
    'lastSourceSequence',
    'lastOperation',
    'lastObservationHash',
    'matchedSourceSequence',
    'matchedOperation',
    'matchedObservationHash',
    'mismatchLatched',
    'mismatchCode',
    'serviceBuildHash',
    'updatedAt',
  ]);
  const lastSourceSequence = integer(own(item, 'lastSourceSequence'), '$/lastSourceSequence', 1, 3);
  const matchedSourceSequenceValue = own(item, 'matchedSourceSequence');
  const matchedOperationValue = own(item, 'matchedOperation');
  const matchedObservationHashValue = own(item, 'matchedObservationHash');
  const mismatchLatched = own(item, 'mismatchLatched');
  const mismatchCode = own(item, 'mismatchCode');
  const lastOperation = operation(own(item, 'lastOperation'), '$/lastOperation');
  if (
    own(item, 'schema') !== WORKFLOW_EFFECT_SHADOW_HEAD_SCHEMA ||
    typeof mismatchLatched !== 'boolean' ||
    (mismatchLatched ? typeof mismatchCode !== 'string' : mismatchCode !== null) ||
    (!mismatchLatched && matchedSourceSequenceValue === null) ||
    (matchedSourceSequenceValue === null) !== (matchedOperationValue === null) ||
    (matchedSourceSequenceValue === null) !== (matchedObservationHashValue === null) ||
    (lastSourceSequence === 1 && lastOperation !== 'approval_created') ||
    (lastSourceSequence === 2 && lastOperation !== 'approval_decided') ||
    (lastSourceSequence === 3 && lastOperation !== 'audit_recorded')
  ) {
    return fail('$', 'Shadow head state is inconsistent.');
  }
  const matchedSourceSequence =
    matchedSourceSequenceValue === null
      ? null
      : integer(matchedSourceSequenceValue, '$/matchedSourceSequence', 1, lastSourceSequence);
  const matchedOperation =
    matchedOperationValue === null ? null : operation(matchedOperationValue, '$/matchedOperation');
  const lastObservationHash = text(own(item, 'lastObservationHash'), '$/lastObservationHash', HASH);
  const matchedObservationHash =
    matchedObservationHashValue === null
      ? null
      : text(matchedObservationHashValue, '$/matchedObservationHash', HASH);
  if (
    matchedSourceSequence !== null &&
    ((matchedSourceSequence === 1 && matchedOperation !== 'approval_created') ||
      (matchedSourceSequence === 2 && matchedOperation !== 'approval_decided') ||
      (matchedSourceSequence === 3 && matchedOperation !== 'audit_recorded'))
  ) {
    return fail('$', 'Matched shadow head sequence and operation disagree.');
  }
  if (
    !mismatchLatched &&
    (matchedSourceSequence !== lastSourceSequence ||
      matchedOperation !== lastOperation ||
      matchedObservationHash !== lastObservationHash)
  ) {
    return fail('$', 'Live shadow head does not equal its matched prefix.');
  }
  return immutable({
    schema: WORKFLOW_EFFECT_SHADOW_HEAD_SCHEMA,
    workspaceId: text(own(item, 'workspaceId'), '$/workspaceId'),
    runId: text(own(item, 'runId'), '$/runId'),
    occurrenceId: text(own(item, 'occurrenceId'), '$/occurrenceId', OCCURRENCE),
    approvalId: text(own(item, 'approvalId'), '$/approvalId'),
    lastSourceSequence,
    lastOperation,
    lastObservationHash,
    matchedSourceSequence,
    matchedOperation,
    matchedObservationHash,
    mismatchLatched,
    mismatchCode: mismatchCode === null ? null : text(mismatchCode, '$/mismatchCode', SAFE_CODE),
    serviceBuildHash: text(own(item, 'serviceBuildHash'), '$/serviceBuildHash', HASH),
    updatedAt: timestamp(own(item, 'updatedAt'), '$/updatedAt'),
  });
}

export function validateWorkflowEffectShadowError(value: unknown): WorkflowEffectShadowError {
  const item = record(value, ['schema', 'code', 'message']);
  const code = own(item, 'code');
  const message = own(item, 'message');
  if (
    own(item, 'schema') !== WORKFLOW_EFFECT_SHADOW_ERROR_SCHEMA ||
    !WORKFLOW_EFFECT_SHADOW_ERROR_CODES.includes(code as never) ||
    typeof message !== 'string' ||
    message.length < 1 ||
    Buffer.byteLength(message, 'utf8') > 1024 ||
    /[\r\n\0]/u.test(message)
  ) {
    return fail('$', 'Shadow error is invalid.');
  }
  return immutable({
    schema: WORKFLOW_EFFECT_SHADOW_ERROR_SCHEMA,
    code: code as WorkflowEffectShadowErrorCode,
    message,
  });
}

export function workflowEffectShadowCanonicalJson(value: unknown): string {
  return canonicalWorkflowEffectControlJson(value);
}
