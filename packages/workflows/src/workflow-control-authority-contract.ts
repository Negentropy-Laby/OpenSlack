import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalWorkflowEffectJson, parseWorkflowEffectJson } from './workflow-effect-json.js';
import {
  WORKFLOW_RUNNER_CONTRACT_LIMITS,
  WORKFLOW_RUNNER_PROTOCOL_VERSION,
  validateWorkflowRunnerMessage,
} from './workflow-runner-contract.js';

export const WORKFLOW_CONTROL_AUTHORITY_CONTRACT_VERSION = 'v2' as const;
export const WORKFLOW_CONTROL_AUTHORITY_STATE_SCHEMA =
  'openslack.workflow_control_authority_state.v2' as const;
export const WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA =
  'openslack.workflow_control_authority_message.v2' as const;
export const WORKFLOW_CONTROL_AUTHORITY_PREPARED_SCHEMA =
  'openslack.workflow_control_authority_prepared_message.v2' as const;
export const WORKFLOW_CONTROL_AUTHORITY_RECEIPT_SCHEMA =
  'openslack.workflow_control_authority_receipt.v2' as const;
export const WORKFLOW_CONTROL_AUTHORITY_FINGERPRINT_SCHEMA =
  'openslack.workflow_control_authority_request_fingerprint.v2' as const;
export const WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION = 'openslack.workflow_runner.v2' as const;
export const WORKFLOW_CONTROL_AUTHORITY = 'typescript' as const;
export const WORKFLOW_CONTROL_AUTHORITY_GO_ROLE = 'validator-only' as const;
export const WORKFLOW_CONTROL_AUTHORITY_CLAIM = 'NO_AUTHORITY' as const;
export const WORKFLOW_CONTROL_AUTHORITY_IDEMPOTENCY_PREFIX =
  'openslack.workflow-control-authority.v2.' as const;
export const WORKFLOW_CONTROL_AUTHORITY_MONEY_UNIT = 'nano_usd' as const;
export const WORKFLOW_CONTROL_AUTHORITY_MONEY_SCALE = 9 as const;
export const WORKFLOW_CONTROL_AUTHORITY_ROUNDING = 'half_up_nonnegative' as const;
export const WORKFLOW_CONTROL_AUTHORITY_MAX_INT64 = '9223372036854775807' as const;

export const WORKFLOW_CONTROL_AUTHORITY_RUN_STATES = Object.freeze([
  'created',
  'previewed',
  'confirmed',
  'running',
  'paused',
  'paused_waiting_approval',
  'resuming',
  'completed',
  'failed',
  'cancelled',
  'reconciliation_required',
] as const);
export type WorkflowControlAuthorityRunState =
  (typeof WORKFLOW_CONTROL_AUTHORITY_RUN_STATES)[number];

export const WORKFLOW_CONTROL_AUTHORITY_TRANSITIONS = Object.freeze({
  created: Object.freeze(['previewed', 'confirmed', 'running', 'cancelled'] as const),
  previewed: Object.freeze(['confirmed', 'running', 'cancelled'] as const),
  confirmed: Object.freeze(['running', 'cancelled'] as const),
  running: Object.freeze([
    'paused',
    'paused_waiting_approval',
    'resuming',
    'completed',
    'failed',
    'cancelled',
    'reconciliation_required',
  ] as const),
  paused: Object.freeze(['running', 'resuming', 'cancelled', 'reconciliation_required'] as const),
  paused_waiting_approval: Object.freeze([
    'resuming',
    'cancelled',
    'reconciliation_required',
  ] as const),
  resuming: Object.freeze(['running', 'failed', 'cancelled', 'reconciliation_required'] as const),
  completed: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
  reconciliation_required: Object.freeze([] as const),
} satisfies Readonly<
  Record<WorkflowControlAuthorityRunState, readonly WorkflowControlAuthorityRunState[]>
>);

export const WORKFLOW_CONTROL_AUTHORITY_APPROVAL_PLANES = Object.freeze([
  'legacy_run_gate',
  'workflow_effect_v2',
] as const);
export const WORKFLOW_CONTROL_AUTHORITY_APPROVAL_STATUSES = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'expired',
] as const);
export const WORKFLOW_CONTROL_AUTHORITY_RECEIPT_OPERATIONS = Object.freeze([
  'run_transition',
  'checkpoint_commit',
  'budget_reserve',
  'budget_settle',
  'effect_authorize',
  'resume_advance',
] as const);
export const WORKFLOW_CONTROL_AUTHORITY_RECEIPT_STATUSES = Object.freeze([
  'accepted',
  'duplicate',
  'reconciliation_required',
] as const);

const RETAINED_V1_KINDS = Object.freeze([
  'hello',
  'hello_ack',
  'lease_offer',
  'lease_accept',
  'lease_reject',
  'heartbeat',
  'effect_intent',
  'effect_outcome',
  'cancel_request',
  'cancel_ack',
  'terminal',
  'event_receipt',
] as const);
export const WORKFLOW_CONTROL_AUTHORITY_ADDED_MESSAGE_KINDS = Object.freeze([
  'checkpoint_commit',
  'budget_reserve_request',
  'budget_usage_report',
  'budget_authorization',
  'effect_authorization',
  'resume_offer',
] as const);
export const WORKFLOW_CONTROL_AUTHORITY_MESSAGE_KINDS = Object.freeze([
  ...RETAINED_V1_KINDS,
  ...WORKFLOW_CONTROL_AUTHORITY_ADDED_MESSAGE_KINDS,
] as const);
export type WorkflowControlAuthorityMessageKind =
  (typeof WORKFLOW_CONTROL_AUTHORITY_MESSAGE_KINDS)[number];

export const WORKFLOW_CONTROL_AUTHORITY_RECEIPTABLE_KINDS = Object.freeze([
  'lease_accept',
  'lease_reject',
  'heartbeat',
  'effect_intent',
  'effect_outcome',
  'cancel_ack',
  'terminal',
  'checkpoint_commit',
  'budget_reserve_request',
  'budget_usage_report',
] as const);

export const WORKFLOW_CONTROL_AUTHORITY_DIRECTIONS = Object.freeze({
  runnerToControl: Object.freeze([
    'hello',
    'lease_accept',
    'lease_reject',
    'heartbeat',
    'effect_intent',
    'effect_outcome',
    'cancel_ack',
    'terminal',
    'checkpoint_commit',
    'budget_reserve_request',
    'budget_usage_report',
  ] as const),
  controlToRunner: Object.freeze([
    'hello_ack',
    'lease_offer',
    'cancel_request',
    'event_receipt',
    'budget_authorization',
    'effect_authorization',
    'resume_offer',
  ] as const),
});
export type WorkflowControlAuthorityDirection = 'runner-to-control' | 'control-to-runner';

export const WORKFLOW_CONTROL_AUTHORITY_ERROR_CODES = Object.freeze([
  'WORKFLOW_CONTROL_AUTHORITY_INVALID',
  'WORKFLOW_CONTROL_AUTHORITY_UNKNOWN_FIELD',
  'WORKFLOW_CONTROL_AUTHORITY_LIMIT_EXCEEDED',
  'WORKFLOW_CONTROL_AUTHORITY_UNSUPPORTED_VERSION',
  'WORKFLOW_CONTROL_AUTHORITY_INVALID_TRANSITION',
  'WORKFLOW_CONTROL_AUTHORITY_APPROVAL_PLANE_MISMATCH',
  'WORKFLOW_CONTROL_AUTHORITY_INVALID_DECIMAL',
  'WORKFLOW_CONTROL_AUTHORITY_DECIMAL_OVERFLOW',
  'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH',
  'WORKFLOW_CONTROL_AUTHORITY_HASH_MISMATCH',
  'WORKFLOW_CONTROL_AUTHORITY_IDEMPOTENCY_CONFLICT',
  'WORKFLOW_CONTROL_AUTHORITY_STALE_REVISION',
  'WORKFLOW_CONTROL_AUTHORITY_STALE_RESUME_GENERATION',
  'WORKFLOW_CONTROL_AUTHORITY_STALE_FENCE',
  'WORKFLOW_CONTROL_AUTHORITY_RECONCILIATION_REQUIRED',
] as const);
export type WorkflowControlAuthorityErrorCode =
  (typeof WORKFLOW_CONTROL_AUTHORITY_ERROR_CODES)[number];

export const WORKFLOW_CONTROL_AUTHORITY_LIMITS = Object.freeze({
  maxMessageBytes: 256 * 1024,
  maxReceiptBytes: 256 * 1024,
  maxStateBytes: 512 * 1024,
  maxJsonDepth: 16,
  maxJsonNodes: 4_096,
  maxStringBytes: 4_096,
  maxIdentifierBytes: 256,
  maxSafeInteger: Number.MAX_SAFE_INTEGER,
} as const);

export class WorkflowControlAuthorityContractError extends Error {
  constructor(
    readonly code: WorkflowControlAuthorityErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowControlAuthorityContractError';
  }
}

export interface WorkflowControlAuthorityRoute {
  readonly backend: 'ts-local' | 'go';
  readonly authority: 'typescript' | 'workflow-control';
  readonly routingEpoch: number;
  readonly authorityBuildHash: string;
}

export interface WorkflowControlAuthorityState {
  readonly schema: typeof WORKFLOW_CONTROL_AUTHORITY_STATE_SCHEMA;
  readonly contractVersion: typeof WORKFLOW_CONTROL_AUTHORITY_CONTRACT_VERSION;
  readonly contractAuthority: typeof WORKFLOW_CONTROL_AUTHORITY;
  readonly goRole: typeof WORKFLOW_CONTROL_AUTHORITY_GO_ROLE;
  readonly authorityClaim: typeof WORKFLOW_CONTROL_AUTHORITY_CLAIM;
  readonly workspaceId: string;
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
  readonly inputHash: string;
  readonly route: WorkflowControlAuthorityRoute;
  readonly state: WorkflowControlAuthorityRunState;
  readonly revision: number;
  readonly resumeGeneration: number;
  readonly currentPhaseId: string | null;
  readonly currentPhaseIndex: number | null;
  readonly checkpointHead: null | {
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
  };
  readonly approvals: {
    readonly legacyRunGate: {
      readonly plane: 'legacy_run_gate';
      readonly status: (typeof WORKFLOW_CONTROL_AUTHORITY_APPROVAL_STATUSES)[number];
      readonly revision: number;
      readonly effectDecisionAuthority: false;
    };
    readonly effectV2: {
      readonly plane: 'workflow_effect_v2';
      readonly schema: 'openslack.workflow_effect_approval.v2';
      readonly status: (typeof WORKFLOW_CONTROL_AUTHORITY_APPROVAL_STATUSES)[number];
      readonly revision: number;
      readonly approvalHash: string | null;
    };
  };
  readonly budget: {
    readonly policyHash: string;
    readonly tokenLimit: string;
    readonly costLimitNanoUsd: string;
    readonly callLimit: string;
    readonly reservedTokens: string;
    readonly settledTokens: string;
    readonly reservedCostNanoUsd: string;
    readonly settledCostNanoUsd: string;
    readonly reservedCalls: string;
    readonly settledCalls: string;
  };
  readonly reconciliationRequired: boolean;
  readonly updatedAt: string;
}

export interface WorkflowControlAuthorityMessage {
  readonly schema: typeof WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA;
  readonly protocolVersion: typeof WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION;
  readonly kind: WorkflowControlAuthorityMessageKind;
  readonly workspaceId: string;
  readonly jobId: string | null;
  readonly workflowRunId: string | null;
  readonly attemptId: string | null;
  readonly leaseId: string | null;
  readonly fencingToken: number | null;
  readonly sequence: number | null;
  readonly authorityBackend: 'ts-local' | 'go' | null;
  readonly authority: 'typescript' | 'workflow-control' | null;
  readonly routingEpoch: number | null;
  readonly authorityBuildHash: string | null;
  readonly runRevision: number | null;
  readonly resumeGeneration: number | null;
  readonly eventId: string;
  readonly correlationId: string;
  readonly sentAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface WorkflowControlAuthorityPreparedMessage {
  readonly schema: typeof WORKFLOW_CONTROL_AUTHORITY_PREPARED_SCHEMA;
  readonly direction: WorkflowControlAuthorityDirection;
  readonly body: string;
  readonly messageDigest: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface WorkflowControlAuthorityReceipt {
  readonly schema: typeof WORKFLOW_CONTROL_AUTHORITY_RECEIPT_SCHEMA;
  readonly operation: (typeof WORKFLOW_CONTROL_AUTHORITY_RECEIPT_OPERATIONS)[number];
  readonly status: (typeof WORKFLOW_CONTROL_AUTHORITY_RECEIPT_STATUSES)[number];
  readonly workspaceId: string;
  readonly runId: string;
  readonly expectedRevision: number;
  readonly acceptedRevision: number | null;
  readonly resumeGeneration: number;
  readonly route: WorkflowControlAuthorityRoute;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly requestHash: string;
  readonly recordHash: string | null;
  readonly correlationId: string;
  readonly serviceBuildHash: string;
  readonly committedAt: string | null;
  readonly reconciliationToken: string | null;
}

type DataRecord = Record<string, unknown>;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DECIMAL_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const DECIMAL_USD = /^(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$/u;
const IDEMPOTENCY = /^openslack\.workflow-control-authority\.v2\.[0-9a-f]{64}$/u;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const SEMVER =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const V2_CAPABILITIES = new Set(['cancel_ack', 'effect_receipts', 'lease_heartbeat']);
const MAX_INT64 = BigInt(WORKFLOW_CONTROL_AUTHORITY_MAX_INT64);
const HANDSHAKE_KINDS = new Set<WorkflowControlAuthorityMessageKind>(['hello', 'hello_ack']);

function fail(code: WorkflowControlAuthorityErrorCode, path: string, message: string): never {
  throw new WorkflowControlAuthorityContractError(code, path, message);
}

function assertInert(value: unknown, path: string): void {
  if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
    if (nodeTypes.isProxy(value)) {
      fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', path, `${path} cannot be a Proxy.`);
    }
  }
}

function validUnicodeScalarSequence(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function closedRecord(value: unknown, fields: readonly string[], path: string): DataRecord {
  assertInert(value, path);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', path, `${path} must be an object.`);
  }
  const result: DataRecord = {};
  const expected = new Set(fields);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !validUnicodeScalarSequence(key)) {
      fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', path, `${path} has an invalid field name.`);
    }
    if (!expected.has(key)) {
      fail('WORKFLOW_CONTROL_AUTHORITY_UNKNOWN_FIELD', `${path}/${key}`, `Unknown field ${key}.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', `${path}/${key}`, 'Accessors are forbidden.');
    }
    result[key] = descriptor.value;
  }
  for (const field of fields) {
    if (!Object.hasOwn(result, field)) {
      fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', `${path}/${field}`, `Missing field ${field}.`);
    }
  }
  return result;
}

function own(record: DataRecord, field: string): unknown {
  return record[field];
}

function text(
  value: unknown,
  path: string,
  pattern: RegExp,
  maxBytes: number = WORKFLOW_CONTROL_AUTHORITY_LIMITS.maxStringBytes,
): string {
  if (
    typeof value !== 'string' ||
    !validUnicodeScalarSequence(value) ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    !pattern.test(value)
  ) {
    return fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', path, `${path} is invalid.`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  return text(value, path, SAFE_ID, WORKFLOW_CONTROL_AUTHORITY_LIMITS.maxIdentifierBytes);
}

function reference(value: unknown, path: string): string {
  return text(value, path, SAFE_REF, 512);
}

function hash(value: unknown, path: string): string {
  return text(value, path, HASH, 64);
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path, TIMESTAMP, 24);
  const parsed = new Date(result);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) {
    return fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', path, `${path} is not a valid timestamp.`);
  }
  return result;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_INVALID',
      path,
      `${path} must be a safe integer >= ${minimum}.`,
    );
  }
  return value as number;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') {
    return fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', path, `${path} must be boolean.`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_INVALID',
      path,
      `${path} is outside the closed vocabulary.`,
    );
  }
  return value as T[number];
}

function nullable<T>(value: unknown, validate: (entry: unknown) => T): T | null {
  return value === null ? null : validate(value);
}

function immutable<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const item of Object.values(value as Record<string, unknown>)) immutable(item);
  return Object.freeze(value);
}

export function validateWorkflowControlAuthorityDecimal(value: unknown, path = '$'): string {
  if (typeof value !== 'string' || !DECIMAL_INTEGER.test(value)) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_INVALID_DECIMAL',
      path,
      `${path} must be a canonical non-negative decimal integer string.`,
    );
  }
  const parsed = BigInt(value);
  if (parsed > MAX_INT64) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_DECIMAL_OVERFLOW',
      path,
      `${path} exceeds signed 64-bit BIGINT.`,
    );
  }
  return value;
}

export function workflowControlAuthorityUsdToNanoUsd(value: unknown): string {
  if (typeof value !== 'string') {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_INVALID_DECIMAL',
      '$',
      'USD value must be a canonical non-negative decimal string.',
    );
  }
  const match = DECIMAL_USD.exec(value);
  if (!match) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_INVALID_DECIMAL',
      '$',
      'USD value must be a canonical non-negative decimal string.',
    );
  }
  const [whole, fraction = ''] = value.split('.');
  const kept = fraction.slice(0, WORKFLOW_CONTROL_AUTHORITY_MONEY_SCALE).padEnd(9, '0');
  let nano = BigInt(whole) * 1_000_000_000n + BigInt(kept);
  if ((fraction[WORKFLOW_CONTROL_AUTHORITY_MONEY_SCALE] ?? '0') >= '5') nano += 1n;
  if (nano > MAX_INT64) {
    return fail(
      'WORKFLOW_CONTROL_AUTHORITY_DECIMAL_OVERFLOW',
      '$',
      'Rounded nano_usd value exceeds signed 64-bit BIGINT.',
    );
  }
  return nano.toString(10);
}

export function validateWorkflowControlAuthorityTransition(
  from: WorkflowControlAuthorityRunState,
  to: WorkflowControlAuthorityRunState,
): void {
  if (!WORKFLOW_CONTROL_AUTHORITY_RUN_STATES.includes(from)) {
    fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', '$/from', 'Unknown source run state.');
  }
  if (!WORKFLOW_CONTROL_AUTHORITY_RUN_STATES.includes(to)) {
    fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', '$/to', 'Unknown target run state.');
  }
  if (!(WORKFLOW_CONTROL_AUTHORITY_TRANSITIONS[from] as readonly string[]).includes(to)) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_INVALID_TRANSITION',
      '$/to',
      `Transition ${from} -> ${to} is not allowed.`,
    );
  }
}

function validateRoute(value: unknown, path: string): WorkflowControlAuthorityRoute {
  const record = closedRecord(
    value,
    ['backend', 'authority', 'routingEpoch', 'authorityBuildHash'],
    path,
  );
  const backend = enumValue(own(record, 'backend'), ['ts-local', 'go'] as const, `${path}/backend`);
  const authority = enumValue(
    own(record, 'authority'),
    ['typescript', 'workflow-control'] as const,
    `${path}/authority`,
  );
  if (
    (backend === 'ts-local' && authority !== 'typescript') ||
    (backend === 'go' && authority !== 'workflow-control')
  ) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH',
      `${path}/authority`,
      'Route backend and authority do not match.',
    );
  }
  return immutable({
    backend,
    authority,
    routingEpoch: integer(own(record, 'routingEpoch'), `${path}/routingEpoch`, 1),
    authorityBuildHash: hash(own(record, 'authorityBuildHash'), `${path}/authorityBuildHash`),
  });
}

/** Validate the frozen authority-route vocabulary for adjacent runner contracts. */
export function validateWorkflowControlAuthorityRoute(
  value: unknown,
  path: string,
): WorkflowControlAuthorityRoute {
  return validateRoute(value, path);
}

function validateBudget(value: unknown, path: string): WorkflowControlAuthorityState['budget'] {
  const fields = [
    'policyHash',
    'tokenLimit',
    'costLimitNanoUsd',
    'callLimit',
    'reservedTokens',
    'settledTokens',
    'reservedCostNanoUsd',
    'settledCostNanoUsd',
    'reservedCalls',
    'settledCalls',
  ] as const;
  const record = closedRecord(value, fields, path);
  const result = immutable({
    policyHash: hash(own(record, 'policyHash'), `${path}/policyHash`),
    tokenLimit: validateWorkflowControlAuthorityDecimal(
      own(record, 'tokenLimit'),
      `${path}/tokenLimit`,
    ),
    costLimitNanoUsd: validateWorkflowControlAuthorityDecimal(
      own(record, 'costLimitNanoUsd'),
      `${path}/costLimitNanoUsd`,
    ),
    callLimit: validateWorkflowControlAuthorityDecimal(
      own(record, 'callLimit'),
      `${path}/callLimit`,
    ),
    reservedTokens: validateWorkflowControlAuthorityDecimal(
      own(record, 'reservedTokens'),
      `${path}/reservedTokens`,
    ),
    settledTokens: validateWorkflowControlAuthorityDecimal(
      own(record, 'settledTokens'),
      `${path}/settledTokens`,
    ),
    reservedCostNanoUsd: validateWorkflowControlAuthorityDecimal(
      own(record, 'reservedCostNanoUsd'),
      `${path}/reservedCostNanoUsd`,
    ),
    settledCostNanoUsd: validateWorkflowControlAuthorityDecimal(
      own(record, 'settledCostNanoUsd'),
      `${path}/settledCostNanoUsd`,
    ),
    reservedCalls: validateWorkflowControlAuthorityDecimal(
      own(record, 'reservedCalls'),
      `${path}/reservedCalls`,
    ),
    settledCalls: validateWorkflowControlAuthorityDecimal(
      own(record, 'settledCalls'),
      `${path}/settledCalls`,
    ),
  });
  const pairs = [
    [result.reservedTokens, result.tokenLimit, `${path}/reservedTokens`],
    [result.settledTokens, result.reservedTokens, `${path}/settledTokens`],
    [result.reservedCostNanoUsd, result.costLimitNanoUsd, `${path}/reservedCostNanoUsd`],
    [result.settledCostNanoUsd, result.reservedCostNanoUsd, `${path}/settledCostNanoUsd`],
    [result.reservedCalls, result.callLimit, `${path}/reservedCalls`],
    [result.settledCalls, result.reservedCalls, `${path}/settledCalls`],
  ] as const;
  for (const [left, right, pairPath] of pairs) {
    if (BigInt(left) > BigInt(right)) {
      fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', pairPath, `${pairPath} exceeds its bound.`);
    }
  }
  return result;
}

export function validateWorkflowControlAuthorityState(
  value: unknown,
): WorkflowControlAuthorityState {
  const fields = [
    'schema',
    'contractVersion',
    'contractAuthority',
    'goRole',
    'authorityClaim',
    'workspaceId',
    'runId',
    'workflowId',
    'workflowVersion',
    'workflowSourceHash',
    'manifestHash',
    'inputHash',
    'route',
    'state',
    'revision',
    'resumeGeneration',
    'currentPhaseId',
    'currentPhaseIndex',
    'checkpointHead',
    'approvals',
    'budget',
    'reconciliationRequired',
    'updatedAt',
  ] as const;
  const root = closedRecord(value, fields, '$');
  if (own(root, 'schema') !== WORKFLOW_CONTROL_AUTHORITY_STATE_SCHEMA)
    fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', '$/schema', 'State schema is invalid.');
  if (own(root, 'contractVersion') !== WORKFLOW_CONTROL_AUTHORITY_CONTRACT_VERSION)
    fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', '$/contractVersion', 'Contract version is invalid.');
  if (own(root, 'contractAuthority') !== WORKFLOW_CONTROL_AUTHORITY)
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_INVALID',
      '$/contractAuthority',
      'Contract authority is invalid.',
    );
  if (own(root, 'goRole') !== WORKFLOW_CONTROL_AUTHORITY_GO_ROLE)
    fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', '$/goRole', 'Go role is invalid.');
  if (own(root, 'authorityClaim') !== WORKFLOW_CONTROL_AUTHORITY_CLAIM)
    fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', '$/authorityClaim', 'Authority claim is invalid.');
  const revision = integer(own(root, 'revision'), '$/revision', 1);
  const resumeGeneration = integer(own(root, 'resumeGeneration'), '$/resumeGeneration', 0);
  const currentPhaseId = nullable(own(root, 'currentPhaseId'), (entry) =>
    identifier(entry, '$/currentPhaseId'),
  );
  const currentPhaseIndex = nullable(own(root, 'currentPhaseIndex'), (entry) =>
    integer(entry, '$/currentPhaseIndex', 0),
  );
  if ((currentPhaseId === null) !== (currentPhaseIndex === null)) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH',
      '$/currentPhaseIndex',
      'Current phase id and index must both be null or both be present.',
    );
  }
  const checkpointHead = nullable(own(root, 'checkpointHead'), (entry) => {
    const path = '$/checkpointHead';
    const record = closedRecord(
      entry,
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
      ],
      path,
    );
    if (own(record, 'commitPoint') !== 'after_phase_work') {
      fail(
        'WORKFLOW_CONTROL_AUTHORITY_INVALID',
        `${path}/commitPoint`,
        'Checkpoint commit point is invalid.',
      );
    }
    const committedRevision = integer(
      own(record, 'committedRevision'),
      `${path}/committedRevision`,
      1,
    );
    const checkpointGeneration = integer(
      own(record, 'resumeGeneration'),
      `${path}/resumeGeneration`,
      0,
    );
    if (committedRevision > revision || checkpointGeneration > resumeGeneration) {
      fail(
        'WORKFLOW_CONTROL_AUTHORITY_STALE_REVISION',
        path,
        'Checkpoint head cannot come from a future run revision or resume generation.',
      );
    }
    return immutable({
      checkpointId: identifier(own(record, 'checkpointId'), `${path}/checkpointId`),
      phaseId: identifier(own(record, 'phaseId'), `${path}/phaseId`),
      phaseIndex: integer(own(record, 'phaseIndex'), `${path}/phaseIndex`, 0),
      commitPoint: 'after_phase_work' as const,
      artifactRef: reference(own(record, 'artifactRef'), `${path}/artifactRef`),
      artifactHash: hash(own(record, 'artifactHash'), `${path}/artifactHash`),
      resultHash: nullable(own(record, 'resultHash'), (item) => hash(item, `${path}/resultHash`)),
      cacheKeyHash: nullable(own(record, 'cacheKeyHash'), (item) =>
        hash(item, `${path}/cacheKeyHash`),
      ),
      committedRevision,
      resumeGeneration: checkpointGeneration,
    });
  });
  const approvalsRecord = closedRecord(
    own(root, 'approvals'),
    ['legacyRunGate', 'effectV2'],
    '$/approvals',
  );
  const legacy = closedRecord(
    own(approvalsRecord, 'legacyRunGate'),
    ['plane', 'status', 'revision', 'effectDecisionAuthority'],
    '$/approvals/legacyRunGate',
  );
  if (
    own(legacy, 'plane') !== 'legacy_run_gate' ||
    own(legacy, 'effectDecisionAuthority') !== false
  ) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_APPROVAL_PLANE_MISMATCH',
      '$/approvals/legacyRunGate',
      'Legacy run gate cannot authorize an effect.',
    );
  }
  const effect = closedRecord(
    own(approvalsRecord, 'effectV2'),
    ['plane', 'schema', 'status', 'revision', 'approvalHash'],
    '$/approvals/effectV2',
  );
  if (
    own(effect, 'plane') !== 'workflow_effect_v2' ||
    own(effect, 'schema') !== 'openslack.workflow_effect_approval.v2'
  ) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_APPROVAL_PLANE_MISMATCH',
      '$/approvals/effectV2',
      'Workflow effect approval plane is invalid.',
    );
  }
  const state = enumValue(own(root, 'state'), WORKFLOW_CONTROL_AUTHORITY_RUN_STATES, '$/state');
  const reconciliationRequired = booleanValue(
    own(root, 'reconciliationRequired'),
    '$/reconciliationRequired',
  );
  if ((state === 'reconciliation_required') !== reconciliationRequired) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_RECONCILIATION_REQUIRED',
      '$/reconciliationRequired',
      'Reconciliation flag must match the run state.',
    );
  }
  const result = immutable({
    schema: WORKFLOW_CONTROL_AUTHORITY_STATE_SCHEMA,
    contractVersion: WORKFLOW_CONTROL_AUTHORITY_CONTRACT_VERSION,
    contractAuthority: WORKFLOW_CONTROL_AUTHORITY,
    goRole: WORKFLOW_CONTROL_AUTHORITY_GO_ROLE,
    authorityClaim: WORKFLOW_CONTROL_AUTHORITY_CLAIM,
    workspaceId: identifier(own(root, 'workspaceId'), '$/workspaceId'),
    runId: identifier(own(root, 'runId'), '$/runId'),
    workflowId: identifier(own(root, 'workflowId'), '$/workflowId'),
    workflowVersion: identifier(own(root, 'workflowVersion'), '$/workflowVersion'),
    workflowSourceHash: hash(own(root, 'workflowSourceHash'), '$/workflowSourceHash'),
    manifestHash: hash(own(root, 'manifestHash'), '$/manifestHash'),
    inputHash: hash(own(root, 'inputHash'), '$/inputHash'),
    route: validateRoute(own(root, 'route'), '$/route'),
    state,
    revision,
    resumeGeneration,
    currentPhaseId,
    currentPhaseIndex,
    checkpointHead,
    approvals: immutable({
      legacyRunGate: immutable({
        plane: 'legacy_run_gate' as const,
        status: enumValue(
          own(legacy, 'status'),
          WORKFLOW_CONTROL_AUTHORITY_APPROVAL_STATUSES,
          '$/approvals/legacyRunGate/status',
        ),
        revision: integer(own(legacy, 'revision'), '$/approvals/legacyRunGate/revision', 0),
        effectDecisionAuthority: false as const,
      }),
      effectV2: immutable({
        plane: 'workflow_effect_v2' as const,
        schema: 'openslack.workflow_effect_approval.v2' as const,
        status: enumValue(
          own(effect, 'status'),
          WORKFLOW_CONTROL_AUTHORITY_APPROVAL_STATUSES,
          '$/approvals/effectV2/status',
        ),
        revision: integer(own(effect, 'revision'), '$/approvals/effectV2/revision', 0),
        approvalHash: nullable(own(effect, 'approvalHash'), (item) =>
          hash(item, '$/approvals/effectV2/approvalHash'),
        ),
      }),
    }),
    budget: validateBudget(own(root, 'budget'), '$/budget'),
    reconciliationRequired,
    updatedAt: timestamp(own(root, 'updatedAt'), '$/updatedAt'),
  } satisfies WorkflowControlAuthorityState);
  assertExactBytes(result, WORKFLOW_CONTROL_AUTHORITY_LIMITS.maxStateBytes, '$');
  return result;
}

function assertExactBytes(value: unknown, limit: number, path: string): void {
  if (Buffer.byteLength(canonicalWorkflowEffectJson(value), 'utf8') + 1 > limit) {
    fail('WORKFLOW_CONTROL_AUTHORITY_LIMIT_EXCEEDED', path, `${path} exceeds its byte limit.`);
  }
}

function v2HelloPayload(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const record = closedRecord(
    value,
    [
      'runtimeName',
      'runtimeVersion',
      'runnerBuildHash',
      'supportedProtocolVersions',
      'capabilities',
      'maxConcurrentJobs',
    ],
    path,
  );
  const versions = own(record, 'supportedProtocolVersions');
  if (
    !Array.isArray(versions) ||
    versions.length !== 2 ||
    versions[0] !== WORKFLOW_RUNNER_PROTOCOL_VERSION ||
    versions[1] !== WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION
  ) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_UNSUPPORTED_VERSION',
      `${path}/supportedProtocolVersions`,
      'A v2 runner must advertise the exact ordered v1,v2 versions.',
    );
  }
  const capabilities = own(record, 'capabilities');
  if (
    !Array.isArray(capabilities) ||
    capabilities.length > WORKFLOW_RUNNER_CONTRACT_LIMITS.maxCapabilities ||
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some((entry) => typeof entry !== 'string' || !V2_CAPABILITIES.has(entry))
  ) {
    fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', `${path}/capabilities`, 'Capabilities are invalid.');
  }
  return immutable({
    runtimeName:
      own(record, 'runtimeName') === 'node'
        ? 'node'
        : fail(
            'WORKFLOW_CONTROL_AUTHORITY_INVALID',
            `${path}/runtimeName`,
            'Runtime must be node.',
          ),
    runtimeVersion: text(own(record, 'runtimeVersion'), `${path}/runtimeVersion`, SEMVER, 64),
    runnerBuildHash: hash(own(record, 'runnerBuildHash'), `${path}/runnerBuildHash`),
    supportedProtocolVersions: Object.freeze([...versions]),
    capabilities: Object.freeze([...capabilities]),
    maxConcurrentJobs: (() => {
      const count = integer(own(record, 'maxConcurrentJobs'), `${path}/maxConcurrentJobs`, 1);
      if (count > WORKFLOW_RUNNER_CONTRACT_LIMITS.maxConcurrentJobs) {
        fail(
          'WORKFLOW_CONTROL_AUTHORITY_LIMIT_EXCEEDED',
          `${path}/maxConcurrentJobs`,
          'Concurrency exceeds its limit.',
        );
      }
      return count;
    })(),
  });
}

function v2HelloAckPayload(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const record = closedRecord(
    value,
    ['controlBuildHash', 'selectedProtocolVersion', 'heartbeatIntervalMs', 'leaseOfferTimeoutMs'],
    path,
  );
  if (own(record, 'selectedProtocolVersion') !== WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_UNSUPPORTED_VERSION',
      `${path}/selectedProtocolVersion`,
      'A v2-required run must select v2 without downgrade.',
    );
  }
  const heartbeatIntervalMs = integer(
    own(record, 'heartbeatIntervalMs'),
    `${path}/heartbeatIntervalMs`,
    WORKFLOW_RUNNER_CONTRACT_LIMITS.minHeartbeatIntervalMs,
  );
  const leaseOfferTimeoutMs = integer(
    own(record, 'leaseOfferTimeoutMs'),
    `${path}/leaseOfferTimeoutMs`,
    1,
  );
  if (
    heartbeatIntervalMs > WORKFLOW_RUNNER_CONTRACT_LIMITS.maxHeartbeatIntervalMs ||
    leaseOfferTimeoutMs > WORKFLOW_RUNNER_CONTRACT_LIMITS.maxLeaseDurationMs
  ) {
    fail('WORKFLOW_CONTROL_AUTHORITY_LIMIT_EXCEEDED', path, 'Handshake timing exceeds its limit.');
  }
  return immutable({
    controlBuildHash: hash(own(record, 'controlBuildHash'), `${path}/controlBuildHash`),
    selectedProtocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
    heartbeatIntervalMs,
    leaseOfferTimeoutMs,
  });
}

function validateV2EventReceipt(value: unknown, path: string): Readonly<Record<string, unknown>> {
  const fields = [
    'receivedEventId',
    'receivedKind',
    'receivedSequence',
    'receivedDigest',
    'receivedIdempotencyKey',
    'receivedFingerprint',
    'status',
    'controlBuildHash',
    'committedAt',
    'errorCode',
  ] as const;
  const record = closedRecord(value, fields, path);
  const status = enumValue(
    own(record, 'status'),
    WORKFLOW_CONTROL_AUTHORITY_RECEIPT_STATUSES,
    `${path}/status`,
  );
  const errorCode = nullable(own(record, 'errorCode'), (entry) =>
    enumValue(
      entry,
      [
        'WORKFLOW_CONTROL_AUTHORITY_RECONCILIATION_REQUIRED',
        'WORKFLOW_CONTROL_AUTHORITY_STALE_REVISION',
        'WORKFLOW_CONTROL_AUTHORITY_STALE_RESUME_GENERATION',
        'WORKFLOW_CONTROL_AUTHORITY_STALE_FENCE',
      ] as const,
      `${path}/errorCode`,
    ),
  );
  if ((status === 'reconciliation_required') !== (errorCode !== null)) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_INVALID',
      `${path}/errorCode`,
      'Receipt errorCode does not match status.',
    );
  }
  return immutable({
    receivedEventId: identifier(own(record, 'receivedEventId'), `${path}/receivedEventId`),
    receivedKind: enumValue(
      own(record, 'receivedKind'),
      WORKFLOW_CONTROL_AUTHORITY_RECEIPTABLE_KINDS,
      `${path}/receivedKind`,
    ),
    receivedSequence: integer(own(record, 'receivedSequence'), `${path}/receivedSequence`, 1),
    receivedDigest: hash(own(record, 'receivedDigest'), `${path}/receivedDigest`),
    receivedIdempotencyKey: text(
      own(record, 'receivedIdempotencyKey'),
      `${path}/receivedIdempotencyKey`,
      IDEMPOTENCY,
      128,
    ),
    receivedFingerprint: text(
      own(record, 'receivedFingerprint'),
      `${path}/receivedFingerprint`,
      FINGERPRINT,
      71,
    ),
    status,
    controlBuildHash: hash(own(record, 'controlBuildHash'), `${path}/controlBuildHash`),
    committedAt: timestamp(own(record, 'committedAt'), `${path}/committedAt`),
    errorCode,
  });
}

function decimalPayload(
  record: DataRecord,
  fields: readonly string[],
  path: string,
): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => [
      field,
      validateWorkflowControlAuthorityDecimal(own(record, field), `${path}/${field}`),
    ]),
  );
}

function validateAddedPayload(
  kind: (typeof WORKFLOW_CONTROL_AUTHORITY_ADDED_MESSAGE_KINDS)[number],
  value: unknown,
  path: string,
): Readonly<Record<string, unknown>> {
  switch (kind) {
    case 'checkpoint_commit': {
      const fields = [
        'checkpointId',
        'phaseId',
        'phaseIndex',
        'commitPoint',
        'artifactRef',
        'artifactHash',
        'resultHash',
        'cacheKeyHash',
        'workflowSourceHash',
        'manifestHash',
        'inputHash',
      ] as const;
      const record = closedRecord(value, fields, path);
      if (own(record, 'commitPoint') !== 'after_phase_work')
        fail(
          'WORKFLOW_CONTROL_AUTHORITY_INVALID',
          `${path}/commitPoint`,
          'Checkpoint is not after phase work.',
        );
      return immutable({
        checkpointId: identifier(own(record, 'checkpointId'), `${path}/checkpointId`),
        phaseId: identifier(own(record, 'phaseId'), `${path}/phaseId`),
        phaseIndex: integer(own(record, 'phaseIndex'), `${path}/phaseIndex`, 0),
        commitPoint: 'after_phase_work',
        artifactRef: reference(own(record, 'artifactRef'), `${path}/artifactRef`),
        artifactHash: hash(own(record, 'artifactHash'), `${path}/artifactHash`),
        resultHash: nullable(own(record, 'resultHash'), (entry) =>
          hash(entry, `${path}/resultHash`),
        ),
        cacheKeyHash: nullable(own(record, 'cacheKeyHash'), (entry) =>
          hash(entry, `${path}/cacheKeyHash`),
        ),
        workflowSourceHash: hash(own(record, 'workflowSourceHash'), `${path}/workflowSourceHash`),
        manifestHash: hash(own(record, 'manifestHash'), `${path}/manifestHash`),
        inputHash: hash(own(record, 'inputHash'), `${path}/inputHash`),
      });
    }
    case 'budget_reserve_request': {
      const fields = [
        'reservationId',
        'callId',
        'policyHash',
        'requestedTokens',
        'requestedCostNanoUsd',
        'requestedCalls',
      ] as const;
      const record = closedRecord(value, fields, path);
      return immutable({
        reservationId: identifier(own(record, 'reservationId'), `${path}/reservationId`),
        callId: identifier(own(record, 'callId'), `${path}/callId`),
        policyHash: hash(own(record, 'policyHash'), `${path}/policyHash`),
        ...decimalPayload(
          record,
          ['requestedTokens', 'requestedCostNanoUsd', 'requestedCalls'],
          path,
        ),
      });
    }
    case 'budget_usage_report': {
      const fields = [
        'reservationId',
        'callId',
        'providerReceiptHash',
        'actualTokens',
        'actualCostNanoUsd',
        'actualCalls',
        'settlementStatus',
      ] as const;
      const record = closedRecord(value, fields, path);
      return immutable({
        reservationId: identifier(own(record, 'reservationId'), `${path}/reservationId`),
        callId: identifier(own(record, 'callId'), `${path}/callId`),
        providerReceiptHash: hash(
          own(record, 'providerReceiptHash'),
          `${path}/providerReceiptHash`,
        ),
        ...decimalPayload(record, ['actualTokens', 'actualCostNanoUsd', 'actualCalls'], path),
        settlementStatus: enumValue(
          own(record, 'settlementStatus'),
          ['settled', 'reconciliation_required'] as const,
          `${path}/settlementStatus`,
        ),
      });
    }
    case 'budget_authorization': {
      const fields = [
        'reservationId',
        'status',
        'authorizedTokens',
        'authorizedCostNanoUsd',
        'authorizedCalls',
        'authorityReceiptHash',
        'committedRunRevision',
      ] as const;
      const record = closedRecord(value, fields, path);
      const status = enumValue(
        own(record, 'status'),
        ['reserved', 'rejected', 'reconciliation_required'] as const,
        `${path}/status`,
      );
      const authorized = decimalPayload(
        record,
        ['authorizedTokens', 'authorizedCostNanoUsd', 'authorizedCalls'],
        path,
      );
      if (status !== 'reserved' && Object.values(authorized).some((amount) => amount !== '0')) {
        fail(
          'WORKFLOW_CONTROL_AUTHORITY_INVALID',
          path,
          'A non-reserved budget decision cannot authorize spend.',
        );
      }
      return immutable({
        reservationId: identifier(own(record, 'reservationId'), `${path}/reservationId`),
        status,
        ...authorized,
        authorityReceiptHash: hash(
          own(record, 'authorityReceiptHash'),
          `${path}/authorityReceiptHash`,
        ),
        committedRunRevision: integer(
          own(record, 'committedRunRevision'),
          `${path}/committedRunRevision`,
          1,
        ),
      });
    }
    case 'effect_authorization': {
      const fields = [
        'effectId',
        'effectHash',
        'approvalId',
        'approvalStatus',
        'decisionRevision',
        'grantHash',
        'authorityReceiptHash',
        'expiresAt',
      ] as const;
      const record = closedRecord(value, fields, path);
      const approvalStatus = enumValue(
        own(record, 'approvalStatus'),
        ['approved', 'rejected', 'expired'] as const,
        `${path}/approvalStatus`,
      );
      const grantHash = nullable(own(record, 'grantHash'), (entry) =>
        hash(entry, `${path}/grantHash`),
      );
      if ((approvalStatus === 'approved') !== (grantHash !== null)) {
        fail(
          'WORKFLOW_CONTROL_AUTHORITY_APPROVAL_PLANE_MISMATCH',
          `${path}/grantHash`,
          'Only an exact approved effect-v2 decision can yield a grant hash.',
        );
      }
      return immutable({
        effectId: identifier(own(record, 'effectId'), `${path}/effectId`),
        effectHash: hash(own(record, 'effectHash'), `${path}/effectHash`),
        approvalId: identifier(own(record, 'approvalId'), `${path}/approvalId`),
        approvalStatus,
        decisionRevision: integer(own(record, 'decisionRevision'), `${path}/decisionRevision`, 1),
        grantHash,
        authorityReceiptHash: hash(
          own(record, 'authorityReceiptHash'),
          `${path}/authorityReceiptHash`,
        ),
        expiresAt: timestamp(own(record, 'expiresAt'), `${path}/expiresAt`),
      });
    }
    case 'resume_offer': {
      const fields = [
        'checkpointId',
        'checkpointHash',
        'nextPhaseId',
        'nextPhaseIndex',
        'newResumeGeneration',
        'newAttemptId',
        'authorityReceiptHash',
        'expiresAt',
      ] as const;
      const record = closedRecord(value, fields, path);
      return immutable({
        checkpointId: identifier(own(record, 'checkpointId'), `${path}/checkpointId`),
        checkpointHash: hash(own(record, 'checkpointHash'), `${path}/checkpointHash`),
        nextPhaseId: identifier(own(record, 'nextPhaseId'), `${path}/nextPhaseId`),
        nextPhaseIndex: integer(own(record, 'nextPhaseIndex'), `${path}/nextPhaseIndex`, 0),
        newResumeGeneration: integer(
          own(record, 'newResumeGeneration'),
          `${path}/newResumeGeneration`,
          1,
        ),
        newAttemptId: identifier(own(record, 'newAttemptId'), `${path}/newAttemptId`),
        authorityReceiptHash: hash(
          own(record, 'authorityReceiptHash'),
          `${path}/authorityReceiptHash`,
        ),
        expiresAt: timestamp(own(record, 'expiresAt'), `${path}/expiresAt`),
      });
    }
  }
}

function validateRetainedPayload(
  kind: (typeof RETAINED_V1_KINDS)[number],
  root: DataRecord,
  payload: unknown,
): Readonly<Record<string, unknown>> {
  if (kind === 'hello') return v2HelloPayload(payload, '$/payload');
  if (kind === 'hello_ack') return v2HelloAckPayload(payload, '$/payload');
  if (kind === 'event_receipt') return validateV2EventReceipt(payload, '$/payload');
  const v1 = validateWorkflowRunnerMessage({
    protocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
    kind,
    workspaceId: own(root, 'workspaceId'),
    jobId: own(root, 'jobId'),
    workflowRunId: own(root, 'workflowRunId'),
    attemptId: own(root, 'attemptId'),
    leaseId: own(root, 'leaseId'),
    fencingToken: own(root, 'fencingToken'),
    sequence: own(root, 'sequence'),
    eventId: own(root, 'eventId'),
    correlationId: own(root, 'correlationId'),
    sentAt: own(root, 'sentAt'),
    payload,
  });
  return v1.payload as unknown as Readonly<Record<string, unknown>>;
}

export function workflowControlAuthorityDirectionForKind(
  kind: WorkflowControlAuthorityMessageKind,
): WorkflowControlAuthorityDirection {
  if (!WORKFLOW_CONTROL_AUTHORITY_MESSAGE_KINDS.includes(kind)) {
    return fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', '$/kind', 'Unknown message kind.');
  }
  return WORKFLOW_CONTROL_AUTHORITY_DIRECTIONS.runnerToControl.includes(
    kind as (typeof WORKFLOW_CONTROL_AUTHORITY_DIRECTIONS.runnerToControl)[number],
  )
    ? 'runner-to-control'
    : 'control-to-runner';
}

export function validateWorkflowControlAuthorityMessage(
  value: unknown,
): WorkflowControlAuthorityMessage {
  const fields = [
    'schema',
    'protocolVersion',
    'kind',
    'workspaceId',
    'jobId',
    'workflowRunId',
    'attemptId',
    'leaseId',
    'fencingToken',
    'sequence',
    'authorityBackend',
    'authority',
    'routingEpoch',
    'authorityBuildHash',
    'runRevision',
    'resumeGeneration',
    'eventId',
    'correlationId',
    'sentAt',
    'payload',
  ] as const;
  const root = closedRecord(value, fields, '$');
  if (own(root, 'schema') !== WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA)
    fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', '$/schema', 'Message schema is invalid.');
  if (own(root, 'protocolVersion') !== WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION)
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_UNSUPPORTED_VERSION',
      '$/protocolVersion',
      'Protocol v2 is required.',
    );
  const kind = enumValue(own(root, 'kind'), WORKFLOW_CONTROL_AUTHORITY_MESSAGE_KINDS, '$/kind');
  const handshake = HANDSHAKE_KINDS.has(kind);
  const leasedStringFields = ['jobId', 'workflowRunId', 'attemptId', 'leaseId'] as const;
  const leasedStrings = Object.fromEntries(
    leasedStringFields.map((field) => [
      field,
      handshake
        ? own(root, field) === null
          ? null
          : fail(
              'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH',
              `$/${field}`,
              `${field} must be null during handshake.`,
            )
        : identifier(own(root, field), `$/${field}`),
    ]),
  ) as Record<(typeof leasedStringFields)[number], string | null>;
  const nullableInteger = (field: string, minimum: number) =>
    handshake
      ? own(root, field) === null
        ? null
        : fail(
            'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH',
            `$/${field}`,
            `${field} must be null during handshake.`,
          )
      : integer(own(root, field), `$/${field}`, minimum);
  const authorityBackend = handshake
    ? own(root, 'authorityBackend') === null
      ? null
      : fail(
          'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH',
          '$/authorityBackend',
          'authorityBackend must be null during handshake.',
        )
    : enumValue(own(root, 'authorityBackend'), ['ts-local', 'go'] as const, '$/authorityBackend');
  const authority = handshake
    ? own(root, 'authority') === null
      ? null
      : fail(
          'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH',
          '$/authority',
          'authority must be null during handshake.',
        )
    : enumValue(own(root, 'authority'), ['typescript', 'workflow-control'] as const, '$/authority');
  if (
    !handshake &&
    ((authorityBackend === 'ts-local' && authority !== 'typescript') ||
      (authorityBackend === 'go' && authority !== 'workflow-control'))
  ) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH',
      '$/authority',
      'Authority route is inconsistent.',
    );
  }
  const authorityBuildHash = handshake
    ? own(root, 'authorityBuildHash') === null
      ? null
      : fail(
          'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH',
          '$/authorityBuildHash',
          'authorityBuildHash must be null during handshake.',
        )
    : hash(own(root, 'authorityBuildHash'), '$/authorityBuildHash');
  const fencingToken = nullableInteger('fencingToken', 1);
  const sequence = nullableInteger('sequence', 1);
  const routingEpoch = nullableInteger('routingEpoch', 1);
  const runRevision = nullableInteger('runRevision', 1);
  const resumeGeneration = nullableInteger('resumeGeneration', 0);
  const sentAt = timestamp(own(root, 'sentAt'), '$/sentAt');
  const payload = WORKFLOW_CONTROL_AUTHORITY_ADDED_MESSAGE_KINDS.includes(
    kind as (typeof WORKFLOW_CONTROL_AUTHORITY_ADDED_MESSAGE_KINDS)[number],
  )
    ? validateAddedPayload(
        kind as (typeof WORKFLOW_CONTROL_AUTHORITY_ADDED_MESSAGE_KINDS)[number],
        own(root, 'payload'),
        '$/payload',
      )
    : validateRetainedPayload(
        kind as (typeof RETAINED_V1_KINDS)[number],
        root,
        own(root, 'payload'),
      );
  if (kind === 'event_receipt' && payload.committedAt !== sentAt) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH',
      '$/payload/committedAt',
      'Receipt committedAt must equal envelope sentAt.',
    );
  }
  if (
    (kind === 'effect_authorization' || kind === 'resume_offer') &&
    typeof payload.expiresAt === 'string' &&
    Date.parse(payload.expiresAt) <= Date.parse(sentAt)
  ) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_INVALID',
      '$/payload/expiresAt',
      'Authorization or resume offer must expire after sentAt.',
    );
  }
  if (
    kind === 'resume_offer' &&
    typeof payload.newResumeGeneration === 'number' &&
    resumeGeneration !== null &&
    payload.newResumeGeneration !== resumeGeneration + 1
  ) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_STALE_RESUME_GENERATION',
      '$/payload/newResumeGeneration',
      'Resume offer must advance the exact bound generation once.',
    );
  }
  if (kind === 'resume_offer' && payload.newAttemptId === leasedStrings.attemptId) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH',
      '$/payload/newAttemptId',
      'Resume offer must mint a new workflow resume identity.',
    );
  }
  const result = immutable({
    schema: WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
    protocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
    kind,
    workspaceId: identifier(own(root, 'workspaceId'), '$/workspaceId'),
    jobId: leasedStrings.jobId,
    workflowRunId: leasedStrings.workflowRunId,
    attemptId: leasedStrings.attemptId,
    leaseId: leasedStrings.leaseId,
    fencingToken,
    sequence,
    authorityBackend,
    authority,
    routingEpoch,
    authorityBuildHash,
    runRevision,
    resumeGeneration,
    eventId: identifier(own(root, 'eventId'), '$/eventId'),
    correlationId: identifier(own(root, 'correlationId'), '$/correlationId'),
    sentAt,
    payload,
  } satisfies WorkflowControlAuthorityMessage);
  assertExactBytes(result, WORKFLOW_CONTROL_AUTHORITY_LIMITS.maxMessageBytes, '$');
  return result;
}

export function parseWorkflowControlAuthorityMessageBytes(
  bytes: Uint8Array,
): WorkflowControlAuthorityMessage {
  if (bytes.byteLength > WORKFLOW_CONTROL_AUTHORITY_LIMITS.maxMessageBytes) {
    fail('WORKFLOW_CONTROL_AUTHORITY_LIMIT_EXCEEDED', '$', 'Message exceeds its byte limit.');
  }
  return validateWorkflowControlAuthorityMessage(parseWorkflowEffectJson(Buffer.from(bytes)));
}

export function canonicalWorkflowControlAuthorityJson(value: unknown): string {
  return canonicalWorkflowEffectJson(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashWorkflowControlAuthorityValue(value: unknown): string {
  return sha256(canonicalWorkflowEffectJson(value));
}

export function prepareWorkflowControlAuthorityMessage(
  value: unknown,
): WorkflowControlAuthorityPreparedMessage {
  const message = validateWorkflowControlAuthorityMessage(value);
  const direction = workflowControlAuthorityDirectionForKind(message.kind);
  const body = `${canonicalWorkflowEffectJson(message)}\n`;
  const messageDigest = sha256(body);
  const idempotencyKey = `${WORKFLOW_CONTROL_AUTHORITY_IDEMPOTENCY_PREFIX}${messageDigest}`;
  const requestFingerprint = `sha256:${sha256(
    canonicalWorkflowEffectJson({
      schema: WORKFLOW_CONTROL_AUTHORITY_FINGERPRINT_SCHEMA,
      direction,
      kind: message.kind,
      protocolVersion: message.protocolVersion,
      workspaceId: message.workspaceId,
      jobId: message.jobId,
      workflowRunId: message.workflowRunId,
      attemptId: message.attemptId,
      leaseId: message.leaseId,
      fencingToken: message.fencingToken,
      sequence: message.sequence,
      authorityBackend: message.authorityBackend,
      authority: message.authority,
      routingEpoch: message.routingEpoch,
      authorityBuildHash: message.authorityBuildHash,
      runRevision: message.runRevision,
      resumeGeneration: message.resumeGeneration,
      bodyHash: messageDigest,
    }),
  )}`;
  return immutable({
    schema: WORKFLOW_CONTROL_AUTHORITY_PREPARED_SCHEMA,
    direction,
    body,
    messageDigest,
    idempotencyKey,
    requestFingerprint,
  });
}

export function validateWorkflowControlAuthorityReceipt(
  value: unknown,
): WorkflowControlAuthorityReceipt {
  const fields = [
    'schema',
    'operation',
    'status',
    'workspaceId',
    'runId',
    'expectedRevision',
    'acceptedRevision',
    'resumeGeneration',
    'route',
    'idempotencyKey',
    'requestFingerprint',
    'requestHash',
    'recordHash',
    'correlationId',
    'serviceBuildHash',
    'committedAt',
    'reconciliationToken',
  ] as const;
  const root = closedRecord(value, fields, '$');
  if (own(root, 'schema') !== WORKFLOW_CONTROL_AUTHORITY_RECEIPT_SCHEMA)
    fail('WORKFLOW_CONTROL_AUTHORITY_INVALID', '$/schema', 'Receipt schema is invalid.');
  const status = enumValue(
    own(root, 'status'),
    WORKFLOW_CONTROL_AUTHORITY_RECEIPT_STATUSES,
    '$/status',
  );
  const expectedRevision = integer(own(root, 'expectedRevision'), '$/expectedRevision', 0);
  const acceptedRevision = nullable(own(root, 'acceptedRevision'), (entry) =>
    integer(entry, '$/acceptedRevision', 1),
  );
  const committedAt = nullable(own(root, 'committedAt'), (entry) =>
    timestamp(entry, '$/committedAt'),
  );
  const reconciliationToken = nullable(own(root, 'reconciliationToken'), (entry) =>
    reference(entry, '$/reconciliationToken'),
  );
  const recordHash = nullable(own(root, 'recordHash'), (entry) => hash(entry, '$/recordHash'));
  if (status === 'reconciliation_required') {
    if (
      acceptedRevision !== null ||
      committedAt !== null ||
      recordHash !== null ||
      reconciliationToken === null
    ) {
      fail(
        'WORKFLOW_CONTROL_AUTHORITY_RECONCILIATION_REQUIRED',
        '$',
        'Reconciliation receipt must not claim a committed record.',
      );
    }
  } else if (
    acceptedRevision !== expectedRevision + 1 ||
    committedAt === null ||
    recordHash === null ||
    reconciliationToken !== null
  ) {
    fail(
      'WORKFLOW_CONTROL_AUTHORITY_STALE_REVISION',
      '$/acceptedRevision',
      'Committed receipt revision is invalid.',
    );
  }
  const result = immutable({
    schema: WORKFLOW_CONTROL_AUTHORITY_RECEIPT_SCHEMA,
    operation: enumValue(
      own(root, 'operation'),
      WORKFLOW_CONTROL_AUTHORITY_RECEIPT_OPERATIONS,
      '$/operation',
    ),
    status,
    workspaceId: identifier(own(root, 'workspaceId'), '$/workspaceId'),
    runId: identifier(own(root, 'runId'), '$/runId'),
    expectedRevision,
    acceptedRevision,
    resumeGeneration: integer(own(root, 'resumeGeneration'), '$/resumeGeneration', 0),
    route: validateRoute(own(root, 'route'), '$/route'),
    idempotencyKey: text(own(root, 'idempotencyKey'), '$/idempotencyKey', IDEMPOTENCY, 128),
    requestFingerprint: text(
      own(root, 'requestFingerprint'),
      '$/requestFingerprint',
      FINGERPRINT,
      71,
    ),
    requestHash: hash(own(root, 'requestHash'), '$/requestHash'),
    recordHash,
    correlationId: identifier(own(root, 'correlationId'), '$/correlationId'),
    serviceBuildHash: hash(own(root, 'serviceBuildHash'), '$/serviceBuildHash'),
    committedAt,
    reconciliationToken,
  } satisfies WorkflowControlAuthorityReceipt);
  assertExactBytes(result, WORKFLOW_CONTROL_AUTHORITY_LIMITS.maxReceiptBytes, '$');
  return result;
}
