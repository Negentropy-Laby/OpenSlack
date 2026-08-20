import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  canonicalUtcTimestamp,
  closedDataRecord,
  immutableContractValue,
  ownDataField,
  type ContractDataRecord,
} from './internal/contract-validation.js';
import { canonicalWorkflowEffectJson, parseWorkflowEffectJson } from './workflow-effect-json.js';

export const WORKFLOW_RUNNER_PROTOCOL_VERSION = 'openslack.workflow_runner.v1' as const;
export const WORKFLOW_RUNNER_RUNTIME_NAME = 'node' as const;
export const WORKFLOW_RUNNER_RUNTIME_VERSION_PATTERN =
  '^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$' as const;
export const WORKFLOW_RUNNER_MESSAGE_SCHEMA = 'openslack.workflow_runner_message.v1' as const;
export const WORKFLOW_RUNNER_PREPARED_SCHEMA =
  'openslack.workflow_runner_prepared_message.v1' as const;
export const WORKFLOW_RUNNER_FINGERPRINT_SCHEMA =
  'openslack.workflow_runner_request_fingerprint.v1' as const;
export const WORKFLOW_RUNNER_RECEIPT_IDENTITY_SCHEMA =
  'openslack.workflow_runner_receipt_identity.v1' as const;
export const WORKFLOW_RUNNER_IDEMPOTENCY_PREFIX = 'openslack.workflow-runner.v1.' as const;

export const WORKFLOW_RUNNER_MESSAGE_KINDS = Object.freeze([
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
export type WorkflowRunnerMessageKind = (typeof WORKFLOW_RUNNER_MESSAGE_KINDS)[number];

export const WORKFLOW_RUNNER_HANDSHAKE_KINDS = Object.freeze(['hello', 'hello_ack'] as const);
export const WORKFLOW_RUNNER_RECEIPTABLE_KINDS = Object.freeze([
  'lease_accept',
  'lease_reject',
  'heartbeat',
  'effect_intent',
  'effect_outcome',
  'cancel_ack',
  'terminal',
] as const);
export type WorkflowRunnerReceiptableKind = (typeof WORKFLOW_RUNNER_RECEIPTABLE_KINDS)[number];

export const WORKFLOW_RUNNER_DIRECTIONS = Object.freeze({
  runnerToControl: Object.freeze([
    'hello',
    'lease_accept',
    'lease_reject',
    'heartbeat',
    'effect_intent',
    'effect_outcome',
    'cancel_ack',
    'terminal',
  ] as const),
  controlToRunner: Object.freeze([
    'hello_ack',
    'lease_offer',
    'cancel_request',
    'event_receipt',
  ] as const),
});
export type WorkflowRunnerDirection = 'runner-to-control' | 'control-to-runner';

export function workflowRunnerDirectionForKind(
  kind: WorkflowRunnerMessageKind,
): WorkflowRunnerDirection {
  if (!WORKFLOW_RUNNER_MESSAGE_KINDS.includes(kind)) {
    throw new WorkflowRunnerContractError(
      'WORKFLOW_RUNNER_INVALID_MESSAGE',
      '$/kind',
      '$/kind is outside the closed vocabulary.',
    );
  }
  return WORKFLOW_RUNNER_DIRECTIONS.runnerToControl.includes(
    kind as (typeof WORKFLOW_RUNNER_DIRECTIONS.runnerToControl)[number],
  )
    ? 'runner-to-control'
    : 'control-to-runner';
}

export const WORKFLOW_RUNNER_CAPABILITIES = Object.freeze([
  'cancel_ack',
  'effect_receipts',
  'lease_heartbeat',
] as const);

export function isWorkflowRunnerCapabilitySet(
  value: unknown,
): value is readonly (typeof WORKFLOW_RUNNER_CAPABILITIES)[number][] {
  return (
    Array.isArray(value) &&
    value.length === WORKFLOW_RUNNER_CAPABILITIES.length &&
    value.every((entry, index) => entry === WORKFLOW_RUNNER_CAPABILITIES[index])
  );
}
export const WORKFLOW_RUNNER_LEASE_REJECT_REASONS = Object.freeze([
  'busy',
  'unsupported',
  'stale',
  'shutting_down',
] as const);
export const WORKFLOW_RUNNER_HEARTBEAT_STATES = Object.freeze([
  'running',
  'waiting_effect',
  'cancelling',
] as const);
export const WORKFLOW_RUNNER_EFFECT_OUTCOMES = Object.freeze([
  'rejected',
  'executed',
  'failed',
  'reconciliation_required',
] as const);
export const WORKFLOW_RUNNER_CANCEL_REASONS = Object.freeze([
  'operator',
  'lease_expired',
  'shutdown',
  'superseded',
  'timeout',
] as const);
export const WORKFLOW_RUNNER_CANCEL_ACK_STATES = Object.freeze([
  'cancelling',
  'cancelled',
  'already_terminal',
] as const);
export const WORKFLOW_RUNNER_TERMINAL_STATES = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'reconciliation_required',
] as const);
export const WORKFLOW_RUNNER_TERMINAL_REASONS = Object.freeze([
  'workflow_failed',
  'process_crash',
  'cancelled_by_control',
  'timeout',
  'commit_outcome_unknown',
] as const);
export const WORKFLOW_RUNNER_RECEIPT_STATUSES = Object.freeze([
  'accepted',
  'duplicate',
  'reconciliation_required',
] as const);
export const WORKFLOW_RUNNER_RECEIPT_ERROR_CODES = Object.freeze([
  'WORKFLOW_RUNNER_COMMIT_OUTCOME_UNKNOWN',
  'WORKFLOW_RUNNER_RECONCILIATION_REQUIRED',
] as const);
export const WORKFLOW_RUNNER_ADVANCEMENT_RULES = Object.freeze({
  helloRequires: 'hello_ack',
  leaseOfferRequiresOneOf: Object.freeze(['lease_accept', 'lease_reject'] as const),
  receiptRequiredFor: WORKFLOW_RUNNER_RECEIPTABLE_KINDS,
  advancingReceiptStatuses: Object.freeze(['accepted', 'duplicate'] as const),
  stoppingReceiptStatus: 'reconciliation_required',
  receiptIsReceiptable: false,
  oneOutstandingWorkerEvent: true,
  leaseAcceptReceiptBeforeJavascriptExecution: true,
  terminalReceiptBeforeSuccessfulRunnerExit: true,
  cancelRequestPreemptsReceiptWait: true,
  cancelAckQueuedBehindOutstandingWorkerEvent: true,
  cancelValidityEvaluatedAtRunnerReceipt: true,
  appliedCancelAckMayFollowExpiry: true,
} as const);

export const WORKFLOW_RUNNER_CONTRACT_LIMITS = Object.freeze({
  maxMessageBytes: 256 * 1024,
  maxJsonDepth: 12,
  maxJsonNodes: 2_048,
  maxStringBytes: 2_048,
  maxIdentifierBytes: 256,
  maxEffectKindBytes: 128,
  maxCapabilities: 64,
  maxProtocolVersions: 4,
  maxConcurrentJobs: 1_024,
  minHeartbeatIntervalMs: 250,
  maxHeartbeatIntervalMs: 300_000,
  maxLeaseDurationMs: 86_400_000,
  maxSafeInteger: Number.MAX_SAFE_INTEGER,
} as const);

export const WORKFLOW_RUNNER_CONTRACT_ERROR_CODES = Object.freeze([
  'WORKFLOW_RUNNER_UNSUPPORTED_VERSION',
  'WORKFLOW_RUNNER_INVALID_MESSAGE',
  'WORKFLOW_RUNNER_UNKNOWN_FIELD',
  'WORKFLOW_RUNNER_LIMIT_EXCEEDED',
  'WORKFLOW_RUNNER_IDENTITY_MISMATCH',
  'WORKFLOW_RUNNER_HASH_MISMATCH',
  'WORKFLOW_RUNNER_IDEMPOTENCY_CONFLICT',
  'WORKFLOW_RUNNER_SEQUENCE_CONFLICT',
  'WORKFLOW_RUNNER_LEASE_EXPIRED',
  'WORKFLOW_RUNNER_STALE_FENCE',
  'WORKFLOW_RUNNER_CONTROL_EXPIRED',
  'WORKFLOW_RUNNER_PROCESS_CRASH',
  'WORKFLOW_RUNNER_TIMEOUT',
  'WORKFLOW_RUNNER_COMMIT_OUTCOME_UNKNOWN',
  'WORKFLOW_RUNNER_RECONCILIATION_REQUIRED',
] as const);
export type WorkflowRunnerContractErrorCode = (typeof WORKFLOW_RUNNER_CONTRACT_ERROR_CODES)[number];

export class WorkflowRunnerContractError extends Error {
  constructor(
    readonly code: WorkflowRunnerContractErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowRunnerContractError';
  }
}

interface WorkflowRunnerEnvelopeFields {
  readonly protocolVersion: typeof WORKFLOW_RUNNER_PROTOCOL_VERSION;
  readonly kind: WorkflowRunnerMessageKind;
  readonly workspaceId: string;
  readonly jobId: string | null;
  readonly workflowRunId: string | null;
  readonly attemptId: string | null;
  readonly leaseId: string | null;
  readonly fencingToken: number | null;
  readonly sequence: number | null;
  readonly eventId: string;
  readonly correlationId: string;
  readonly sentAt: string;
  readonly payload: unknown;
}

interface WorkflowRunnerHandshakeIdentity {
  readonly jobId: null;
  readonly workflowRunId: null;
  readonly attemptId: null;
  readonly leaseId: null;
  readonly fencingToken: null;
  readonly sequence: null;
}

interface WorkflowRunnerLeaseIdentity {
  readonly jobId: string;
  readonly workflowRunId: string;
  readonly attemptId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly sequence: number;
}

export interface WorkflowRunnerHelloPayload {
  readonly runtimeName: typeof WORKFLOW_RUNNER_RUNTIME_NAME;
  readonly runtimeVersion: string;
  readonly runnerBuildHash: string;
  readonly supportedProtocolVersions: readonly [typeof WORKFLOW_RUNNER_PROTOCOL_VERSION];
  readonly capabilities: readonly (typeof WORKFLOW_RUNNER_CAPABILITIES)[number][];
  readonly maxConcurrentJobs: number;
}

export interface WorkflowRunnerHelloAckPayload {
  readonly controlBuildHash: string;
  readonly selectedProtocolVersion: typeof WORKFLOW_RUNNER_PROTOCOL_VERSION;
  readonly heartbeatIntervalMs: number;
  readonly leaseOfferTimeoutMs: number;
}

export interface WorkflowRunnerLeaseOfferPayload {
  readonly executionDescriptorRef: string;
  readonly executionDescriptorHash: string;
  readonly jobSpecHash: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowSourceHash: string;
  readonly manifestHash: string;
  readonly inputHash: string;
  readonly offeredAt: string;
  readonly expiresAt: string;
}

export interface WorkflowRunnerLeaseAcceptPayload {
  readonly acceptedAt: string;
  readonly leaseExpiresAt: string;
}

export interface WorkflowRunnerLeaseRejectPayload {
  readonly rejectedAt: string;
  readonly reason: (typeof WORKFLOW_RUNNER_LEASE_REJECT_REASONS)[number];
}

export interface WorkflowRunnerHeartbeatPayload {
  readonly observedAt: string;
  readonly leaseExpiresAt: string;
  readonly state: (typeof WORKFLOW_RUNNER_HEARTBEAT_STATES)[number];
  readonly lastReceiptSequence: number;
}

export interface WorkflowRunnerEffectIntentPayload {
  readonly effectId: string;
  readonly effectKind: string;
  readonly effectHash: string;
  readonly capabilityHash: string;
  readonly requiresHumanDecision: boolean;
}

export interface WorkflowRunnerEffectOutcomePayload {
  readonly effectId: string;
  readonly status: (typeof WORKFLOW_RUNNER_EFFECT_OUTCOMES)[number];
  readonly outcomeHash: string;
}

export interface WorkflowRunnerCancelRequestPayload {
  readonly cancelId: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly reason: (typeof WORKFLOW_RUNNER_CANCEL_REASONS)[number];
}

export interface WorkflowRunnerCancelAckPayload {
  readonly cancelId: string;
  readonly acknowledgedAt: string;
  readonly status: (typeof WORKFLOW_RUNNER_CANCEL_ACK_STATES)[number];
}

export interface WorkflowRunnerTerminalPayload {
  readonly status: (typeof WORKFLOW_RUNNER_TERMINAL_STATES)[number];
  readonly finishedAt: string;
  readonly resultHash: string | null;
  readonly terminalReason: (typeof WORKFLOW_RUNNER_TERMINAL_REASONS)[number] | null;
}

export interface WorkflowRunnerEventReceiptPayload {
  readonly receivedEventId: string;
  readonly receivedKind: WorkflowRunnerReceiptableKind;
  readonly receivedSequence: number;
  readonly receivedDigest: string;
  readonly receivedIdempotencyKey: string;
  readonly receivedFingerprint: string;
  readonly status: (typeof WORKFLOW_RUNNER_RECEIPT_STATUSES)[number];
  readonly controlBuildHash: string;
  readonly committedAt: string;
  readonly errorCode: (typeof WORKFLOW_RUNNER_RECEIPT_ERROR_CODES)[number] | null;
}

type HandshakeMessage<
  K extends 'hello' | 'hello_ack',
  P extends WorkflowRunnerHelloPayload | WorkflowRunnerHelloAckPayload,
> = Omit<WorkflowRunnerEnvelopeFields, keyof WorkflowRunnerHandshakeIdentity | 'kind' | 'payload'> &
  WorkflowRunnerHandshakeIdentity & { readonly kind: K; readonly payload: P };

type LeaseMessage<K extends Exclude<WorkflowRunnerMessageKind, 'hello' | 'hello_ack'>, P> = Omit<
  WorkflowRunnerEnvelopeFields,
  keyof WorkflowRunnerLeaseIdentity | 'kind' | 'payload'
> &
  WorkflowRunnerLeaseIdentity & { readonly kind: K; readonly payload: P };

export type WorkflowRunnerHelloMessage = HandshakeMessage<'hello', WorkflowRunnerHelloPayload>;
export type WorkflowRunnerHelloAckMessage = HandshakeMessage<
  'hello_ack',
  WorkflowRunnerHelloAckPayload
>;
export type WorkflowRunnerLeaseOfferMessage = LeaseMessage<
  'lease_offer',
  WorkflowRunnerLeaseOfferPayload
>;
export type WorkflowRunnerLeaseAcceptMessage = LeaseMessage<
  'lease_accept',
  WorkflowRunnerLeaseAcceptPayload
>;
export type WorkflowRunnerLeaseRejectMessage = LeaseMessage<
  'lease_reject',
  WorkflowRunnerLeaseRejectPayload
>;
export type WorkflowRunnerHeartbeatMessage = LeaseMessage<
  'heartbeat',
  WorkflowRunnerHeartbeatPayload
>;
export type WorkflowRunnerEffectIntentMessage = LeaseMessage<
  'effect_intent',
  WorkflowRunnerEffectIntentPayload
>;
export type WorkflowRunnerEffectOutcomeMessage = LeaseMessage<
  'effect_outcome',
  WorkflowRunnerEffectOutcomePayload
>;
export type WorkflowRunnerCancelRequestMessage = LeaseMessage<
  'cancel_request',
  WorkflowRunnerCancelRequestPayload
>;
export type WorkflowRunnerCancelAckMessage = LeaseMessage<
  'cancel_ack',
  WorkflowRunnerCancelAckPayload
>;
export type WorkflowRunnerTerminalMessage = LeaseMessage<'terminal', WorkflowRunnerTerminalPayload>;
export type WorkflowRunnerEventReceiptMessage = LeaseMessage<
  'event_receipt',
  WorkflowRunnerEventReceiptPayload
>;

export type WorkflowRunnerMessage =
  | WorkflowRunnerHelloMessage
  | WorkflowRunnerHelloAckMessage
  | WorkflowRunnerLeaseOfferMessage
  | WorkflowRunnerLeaseAcceptMessage
  | WorkflowRunnerLeaseRejectMessage
  | WorkflowRunnerHeartbeatMessage
  | WorkflowRunnerEffectIntentMessage
  | WorkflowRunnerEffectOutcomeMessage
  | WorkflowRunnerCancelRequestMessage
  | WorkflowRunnerCancelAckMessage
  | WorkflowRunnerTerminalMessage
  | WorkflowRunnerEventReceiptMessage;

export interface WorkflowRunnerPreparedMessage {
  readonly schema: typeof WORKFLOW_RUNNER_PREPARED_SCHEMA;
  readonly body: string;
  readonly messageDigest: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface CreateWorkflowRunnerEventReceiptInput {
  readonly sequence: number;
  readonly sentAt: string;
  readonly status: (typeof WORKFLOW_RUNNER_RECEIPT_STATUSES)[number];
  readonly controlBuildHash: string;
  readonly errorCode: (typeof WORKFLOW_RUNNER_RECEIPT_ERROR_CODES)[number] | null;
}

type DataRecord = ContractDataRecord;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const CODE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const IDEMPOTENCY_KEY = /^openslack\.workflow-runner\.v1\.[0-9a-f]{64}$/u;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const SEMVER = new RegExp(WORKFLOW_RUNNER_RUNTIME_VERSION_PATTERN, 'u');
const ENVELOPE_FIELDS = Object.freeze([
  'protocolVersion',
  'kind',
  'workspaceId',
  'jobId',
  'workflowRunId',
  'attemptId',
  'leaseId',
  'fencingToken',
  'sequence',
  'eventId',
  'correlationId',
  'sentAt',
  'payload',
] as const);

function fail(code: WorkflowRunnerContractErrorCode, path: string, message: string): never {
  throw new WorkflowRunnerContractError(code, path, message);
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
  return closedDataRecord(value, fields, path, {
    inert: (recordPath) =>
      fail('WORKFLOW_RUNNER_INVALID_MESSAGE', recordPath, `${recordPath} must be an inert object.`),
    missing: (recordPath, field) =>
      fail(
        'WORKFLOW_RUNNER_INVALID_MESSAGE',
        `${recordPath}/${field}`,
        `Required field ${field} is missing.`,
      ),
    unknown: (recordPath, key) =>
      fail('WORKFLOW_RUNNER_UNKNOWN_FIELD', `${recordPath}/${String(key)}`, 'Unknown field.'),
    dataField: (recordPath, key) =>
      fail(
        'WORKFLOW_RUNNER_INVALID_MESSAGE',
        `${recordPath}/${String(key)}`,
        'Only enumerable data fields are allowed.',
      ),
  });
}

function own(record: DataRecord, key: string): unknown {
  return ownDataField(record, key);
}

function text(value: unknown, path: string, maximum: number, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !validUnicodeScalarSequence(value) ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    return fail('WORKFLOW_RUNNER_INVALID_MESSAGE', path, `${path} is invalid.`);
  }
  return value;
}

function identifier(value: unknown, path: string): string {
  return text(value, path, WORKFLOW_RUNNER_CONTRACT_LIMITS.maxIdentifierBytes, SAFE_ID);
}

function hash(value: unknown, path: string): string {
  return text(value, path, 64, HASH);
}

function timestamp(value: unknown, path: string): string {
  return canonicalUtcTimestamp(
    value,
    path,
    (input, inputPath) => text(input, inputPath, 24, TIMESTAMP),
    (inputPath) =>
      fail('WORKFLOW_RUNNER_INVALID_MESSAGE', inputPath, `${inputPath} must be canonical RFC3339.`),
  );
}

function integer(value: unknown, path: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail('WORKFLOW_RUNNER_INVALID_MESSAGE', path, `${path} must be a bounded safe integer.`);
  }
  return value as number;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    return fail(
      'WORKFLOW_RUNNER_INVALID_MESSAGE',
      path,
      `${path} is outside the closed vocabulary.`,
    );
  }
  return value as T;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean')
    return fail('WORKFLOW_RUNNER_INVALID_MESSAGE', path, `${path} is invalid.`);
  return value;
}

function nullable<T>(value: unknown, validate: (item: unknown) => T): T | null {
  return value === null ? null : validate(value);
}

function denseArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return fail('WORKFLOW_RUNNER_INVALID_MESSAGE', path, `${path} must be a dense array.`);
  }
  if (value.length > maximum) {
    return fail('WORKFLOW_RUNNER_LIMIT_EXCEEDED', path, `${path} exceeds its item limit.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return fail('WORKFLOW_RUNNER_INVALID_MESSAGE', `${path}/${index}`, `${path} must be dense.`);
    }
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    return fail('WORKFLOW_RUNNER_INVALID_MESSAGE', path, `${path} cannot contain named fields.`);
  }
  return value;
}

function immutable<T>(value: T): T {
  return immutableContractValue(value);
}

function assertIncreasing(start: string, end: string, path: string): void {
  if (Date.parse(end) <= Date.parse(start)) {
    fail(
      'WORKFLOW_RUNNER_INVALID_MESSAGE',
      path,
      `${path} must be later than its start timestamp.`,
    );
  }
  if (Date.parse(end) - Date.parse(start) > WORKFLOW_RUNNER_CONTRACT_LIMITS.maxLeaseDurationMs) {
    fail('WORKFLOW_RUNNER_LIMIT_EXCEEDED', path, `${path} exceeds the lease duration limit.`);
  }
}

function validatePayload(kind: WorkflowRunnerMessageKind, value: unknown, sentAt: string): unknown {
  const path = '$/payload';
  switch (kind) {
    case 'hello': {
      const item = closedRecord(
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
      const versions = denseArray(
        own(item, 'supportedProtocolVersions'),
        `${path}/supportedProtocolVersions`,
        WORKFLOW_RUNNER_CONTRACT_LIMITS.maxProtocolVersions,
      ).map((entry, index) =>
        enumValue(
          entry,
          [WORKFLOW_RUNNER_PROTOCOL_VERSION],
          `${path}/supportedProtocolVersions/${index}`,
        ),
      );
      if (versions.length !== 1 || versions[0] !== WORKFLOW_RUNNER_PROTOCOL_VERSION) {
        fail(
          'WORKFLOW_RUNNER_INVALID_MESSAGE',
          `${path}/supportedProtocolVersions`,
          'The frozen protocol version must be advertised exactly once.',
        );
      }
      const capabilities = denseArray(
        own(item, 'capabilities'),
        `${path}/capabilities`,
        WORKFLOW_RUNNER_CONTRACT_LIMITS.maxCapabilities,
      ).map((entry, index) =>
        enumValue(entry, WORKFLOW_RUNNER_CAPABILITIES, `${path}/capabilities/${index}`),
      );
      if (new Set(capabilities).size !== capabilities.length) {
        fail(
          'WORKFLOW_RUNNER_INVALID_MESSAGE',
          `${path}/capabilities`,
          'Capabilities must be unique and canonically ordered.',
        );
      }
      const orderedCapabilities = WORKFLOW_RUNNER_CAPABILITIES.filter((capability) =>
        capabilities.includes(capability),
      );
      if (JSON.stringify(capabilities) !== JSON.stringify(orderedCapabilities)) {
        fail(
          'WORKFLOW_RUNNER_INVALID_MESSAGE',
          `${path}/capabilities`,
          'Capabilities must follow the frozen capability order.',
        );
      }
      return immutable({
        runtimeName: enumValue(
          own(item, 'runtimeName'),
          [WORKFLOW_RUNNER_RUNTIME_NAME],
          `${path}/runtimeName`,
        ),
        runtimeVersion: text(own(item, 'runtimeVersion'), `${path}/runtimeVersion`, 64, SEMVER),
        runnerBuildHash: hash(own(item, 'runnerBuildHash'), `${path}/runnerBuildHash`),
        supportedProtocolVersions: Object.freeze([WORKFLOW_RUNNER_PROTOCOL_VERSION] as const),
        capabilities: immutable(capabilities),
        maxConcurrentJobs: integer(
          own(item, 'maxConcurrentJobs'),
          `${path}/maxConcurrentJobs`,
          1,
          WORKFLOW_RUNNER_CONTRACT_LIMITS.maxConcurrentJobs,
        ),
      });
    }
    case 'hello_ack': {
      const item = closedRecord(
        value,
        [
          'controlBuildHash',
          'selectedProtocolVersion',
          'heartbeatIntervalMs',
          'leaseOfferTimeoutMs',
        ],
        path,
      );
      return immutable({
        controlBuildHash: hash(own(item, 'controlBuildHash'), `${path}/controlBuildHash`),
        selectedProtocolVersion: enumValue(
          own(item, 'selectedProtocolVersion'),
          [WORKFLOW_RUNNER_PROTOCOL_VERSION],
          `${path}/selectedProtocolVersion`,
        ),
        heartbeatIntervalMs: integer(
          own(item, 'heartbeatIntervalMs'),
          `${path}/heartbeatIntervalMs`,
          WORKFLOW_RUNNER_CONTRACT_LIMITS.minHeartbeatIntervalMs,
          WORKFLOW_RUNNER_CONTRACT_LIMITS.maxHeartbeatIntervalMs,
        ),
        leaseOfferTimeoutMs: integer(
          own(item, 'leaseOfferTimeoutMs'),
          `${path}/leaseOfferTimeoutMs`,
          1,
          WORKFLOW_RUNNER_CONTRACT_LIMITS.maxLeaseDurationMs,
        ),
      });
    }
    case 'lease_offer': {
      const item = closedRecord(
        value,
        [
          'executionDescriptorRef',
          'executionDescriptorHash',
          'jobSpecHash',
          'workflowId',
          'workflowVersion',
          'workflowSourceHash',
          'manifestHash',
          'inputHash',
          'offeredAt',
          'expiresAt',
        ],
        path,
      );
      const offeredAt = timestamp(own(item, 'offeredAt'), `${path}/offeredAt`);
      const expiresAt = timestamp(own(item, 'expiresAt'), `${path}/expiresAt`);
      if (offeredAt !== sentAt) {
        fail(
          'WORKFLOW_RUNNER_INVALID_MESSAGE',
          `${path}/offeredAt`,
          'offeredAt must equal envelope sentAt.',
        );
      }
      assertIncreasing(offeredAt, expiresAt, `${path}/expiresAt`);
      return immutable({
        executionDescriptorRef: identifier(
          own(item, 'executionDescriptorRef'),
          `${path}/executionDescriptorRef`,
        ),
        executionDescriptorHash: hash(
          own(item, 'executionDescriptorHash'),
          `${path}/executionDescriptorHash`,
        ),
        jobSpecHash: hash(own(item, 'jobSpecHash'), `${path}/jobSpecHash`),
        workflowId: identifier(own(item, 'workflowId'), `${path}/workflowId`),
        workflowVersion: identifier(own(item, 'workflowVersion'), `${path}/workflowVersion`),
        workflowSourceHash: hash(own(item, 'workflowSourceHash'), `${path}/workflowSourceHash`),
        manifestHash: hash(own(item, 'manifestHash'), `${path}/manifestHash`),
        inputHash: hash(own(item, 'inputHash'), `${path}/inputHash`),
        offeredAt,
        expiresAt,
      });
    }
    case 'lease_accept': {
      const item = closedRecord(value, ['acceptedAt', 'leaseExpiresAt'], path);
      const acceptedAt = timestamp(own(item, 'acceptedAt'), `${path}/acceptedAt`);
      const leaseExpiresAt = timestamp(own(item, 'leaseExpiresAt'), `${path}/leaseExpiresAt`);
      if (acceptedAt !== sentAt) {
        fail(
          'WORKFLOW_RUNNER_INVALID_MESSAGE',
          `${path}/acceptedAt`,
          'acceptedAt must equal envelope sentAt.',
        );
      }
      assertIncreasing(acceptedAt, leaseExpiresAt, `${path}/leaseExpiresAt`);
      return immutable({ acceptedAt, leaseExpiresAt });
    }
    case 'lease_reject': {
      const item = closedRecord(value, ['rejectedAt', 'reason'], path);
      const rejectedAt = timestamp(own(item, 'rejectedAt'), `${path}/rejectedAt`);
      if (rejectedAt !== sentAt) {
        fail(
          'WORKFLOW_RUNNER_INVALID_MESSAGE',
          `${path}/rejectedAt`,
          'rejectedAt must equal envelope sentAt.',
        );
      }
      return immutable({
        rejectedAt,
        reason: enumValue(
          own(item, 'reason'),
          WORKFLOW_RUNNER_LEASE_REJECT_REASONS,
          `${path}/reason`,
        ),
      });
    }
    case 'heartbeat': {
      const item = closedRecord(
        value,
        ['observedAt', 'leaseExpiresAt', 'state', 'lastReceiptSequence'],
        path,
      );
      const observedAt = timestamp(own(item, 'observedAt'), `${path}/observedAt`);
      const leaseExpiresAt = timestamp(own(item, 'leaseExpiresAt'), `${path}/leaseExpiresAt`);
      if (observedAt !== sentAt) {
        fail(
          'WORKFLOW_RUNNER_INVALID_MESSAGE',
          `${path}/observedAt`,
          'observedAt must equal envelope sentAt.',
        );
      }
      assertIncreasing(observedAt, leaseExpiresAt, `${path}/leaseExpiresAt`);
      return immutable({
        observedAt,
        leaseExpiresAt,
        state: enumValue(own(item, 'state'), WORKFLOW_RUNNER_HEARTBEAT_STATES, `${path}/state`),
        lastReceiptSequence: integer(
          own(item, 'lastReceiptSequence'),
          `${path}/lastReceiptSequence`,
        ),
      });
    }
    case 'effect_intent': {
      const item = closedRecord(
        value,
        ['effectId', 'effectKind', 'effectHash', 'capabilityHash', 'requiresHumanDecision'],
        path,
      );
      return immutable({
        effectId: identifier(own(item, 'effectId'), `${path}/effectId`),
        effectKind: text(
          own(item, 'effectKind'),
          `${path}/effectKind`,
          WORKFLOW_RUNNER_CONTRACT_LIMITS.maxEffectKindBytes,
          CODE,
        ),
        effectHash: hash(own(item, 'effectHash'), `${path}/effectHash`),
        capabilityHash: hash(own(item, 'capabilityHash'), `${path}/capabilityHash`),
        requiresHumanDecision: booleanValue(
          own(item, 'requiresHumanDecision'),
          `${path}/requiresHumanDecision`,
        ),
      });
    }
    case 'effect_outcome': {
      const item = closedRecord(value, ['effectId', 'status', 'outcomeHash'], path);
      return immutable({
        effectId: identifier(own(item, 'effectId'), `${path}/effectId`),
        status: enumValue(own(item, 'status'), WORKFLOW_RUNNER_EFFECT_OUTCOMES, `${path}/status`),
        outcomeHash: hash(own(item, 'outcomeHash'), `${path}/outcomeHash`),
      });
    }
    case 'cancel_request': {
      const item = closedRecord(value, ['cancelId', 'requestedAt', 'expiresAt', 'reason'], path);
      const requestedAt = timestamp(own(item, 'requestedAt'), `${path}/requestedAt`);
      const expiresAt = timestamp(own(item, 'expiresAt'), `${path}/expiresAt`);
      if (requestedAt !== sentAt) {
        fail(
          'WORKFLOW_RUNNER_INVALID_MESSAGE',
          `${path}/requestedAt`,
          'requestedAt must equal envelope sentAt.',
        );
      }
      assertIncreasing(requestedAt, expiresAt, `${path}/expiresAt`);
      return immutable({
        cancelId: identifier(own(item, 'cancelId'), `${path}/cancelId`),
        requestedAt,
        expiresAt,
        reason: enumValue(own(item, 'reason'), WORKFLOW_RUNNER_CANCEL_REASONS, `${path}/reason`),
      });
    }
    case 'cancel_ack': {
      const item = closedRecord(value, ['cancelId', 'acknowledgedAt', 'status'], path);
      const acknowledgedAt = timestamp(own(item, 'acknowledgedAt'), `${path}/acknowledgedAt`);
      if (acknowledgedAt !== sentAt) {
        fail(
          'WORKFLOW_RUNNER_INVALID_MESSAGE',
          `${path}/acknowledgedAt`,
          'acknowledgedAt must equal envelope sentAt.',
        );
      }
      return immutable({
        cancelId: identifier(own(item, 'cancelId'), `${path}/cancelId`),
        acknowledgedAt,
        status: enumValue(own(item, 'status'), WORKFLOW_RUNNER_CANCEL_ACK_STATES, `${path}/status`),
      });
    }
    case 'terminal': {
      const item = closedRecord(
        value,
        ['status', 'finishedAt', 'resultHash', 'terminalReason'],
        path,
      );
      const status = enumValue(
        own(item, 'status'),
        WORKFLOW_RUNNER_TERMINAL_STATES,
        `${path}/status`,
      );
      const resultHash = nullable(own(item, 'resultHash'), (entry) =>
        hash(entry, `${path}/resultHash`),
      );
      const terminalReason = nullable(own(item, 'terminalReason'), (entry) =>
        enumValue(entry, WORKFLOW_RUNNER_TERMINAL_REASONS, `${path}/terminalReason`),
      );
      const expectedReasons = {
        failed: ['workflow_failed', 'process_crash'],
        cancelled: ['cancelled_by_control'],
        timed_out: ['timeout'],
        reconciliation_required: ['commit_outcome_unknown'],
      } as const;
      const evidenceMatches =
        status === 'completed'
          ? resultHash !== null && terminalReason === null
          : resultHash === null &&
            terminalReason !== null &&
            (expectedReasons[status] as readonly string[]).includes(terminalReason);
      if (!evidenceMatches) {
        fail(
          'WORKFLOW_RUNNER_INVALID_MESSAGE',
          path,
          'Terminal evidence does not match terminal status.',
        );
      }
      const finishedAt = timestamp(own(item, 'finishedAt'), `${path}/finishedAt`);
      if (finishedAt !== sentAt) {
        fail(
          'WORKFLOW_RUNNER_INVALID_MESSAGE',
          `${path}/finishedAt`,
          'finishedAt must equal envelope sentAt.',
        );
      }
      return immutable({
        status,
        finishedAt,
        resultHash,
        terminalReason,
      });
    }
    case 'event_receipt': {
      const item = closedRecord(
        value,
        [
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
        ],
        path,
      );
      const status = enumValue(
        own(item, 'status'),
        WORKFLOW_RUNNER_RECEIPT_STATUSES,
        `${path}/status`,
      );
      const errorCode = nullable(own(item, 'errorCode'), (entry) =>
        enumValue(entry, WORKFLOW_RUNNER_RECEIPT_ERROR_CODES, `${path}/errorCode`),
      );
      if ((status === 'reconciliation_required') !== (errorCode !== null)) {
        fail(
          'WORKFLOW_RUNNER_INVALID_MESSAGE',
          `${path}/errorCode`,
          'Receipt errorCode must match status.',
        );
      }
      const committedAt = timestamp(own(item, 'committedAt'), `${path}/committedAt`);
      if (committedAt !== sentAt) {
        fail(
          'WORKFLOW_RUNNER_INVALID_MESSAGE',
          `${path}/committedAt`,
          'committedAt must equal envelope sentAt.',
        );
      }
      return immutable({
        receivedEventId: identifier(own(item, 'receivedEventId'), `${path}/receivedEventId`),
        receivedKind: enumValue(
          own(item, 'receivedKind'),
          WORKFLOW_RUNNER_RECEIPTABLE_KINDS,
          `${path}/receivedKind`,
        ),
        receivedSequence: integer(own(item, 'receivedSequence'), `${path}/receivedSequence`, 1),
        receivedDigest: hash(own(item, 'receivedDigest'), `${path}/receivedDigest`),
        receivedIdempotencyKey: text(
          own(item, 'receivedIdempotencyKey'),
          `${path}/receivedIdempotencyKey`,
          101,
          IDEMPOTENCY_KEY,
        ),
        receivedFingerprint: text(
          own(item, 'receivedFingerprint'),
          `${path}/receivedFingerprint`,
          71,
          FINGERPRINT,
        ),
        status,
        controlBuildHash: hash(own(item, 'controlBuildHash'), `${path}/controlBuildHash`),
        committedAt,
        errorCode,
      });
    }
  }
}

export function validateWorkflowRunnerMessage(value: unknown): WorkflowRunnerMessage {
  const root = closedRecord(value, ENVELOPE_FIELDS, '$');
  if (own(root, 'protocolVersion') !== WORKFLOW_RUNNER_PROTOCOL_VERSION) {
    return fail(
      'WORKFLOW_RUNNER_UNSUPPORTED_VERSION',
      '$/protocolVersion',
      'Protocol version is unsupported.',
    );
  }
  const kind = enumValue(own(root, 'kind'), WORKFLOW_RUNNER_MESSAGE_KINDS, '$/kind');
  const handshake = WORKFLOW_RUNNER_HANDSHAKE_KINDS.includes(kind as 'hello');
  const identityFields = ['jobId', 'workflowRunId', 'attemptId', 'leaseId'] as const;
  const identity = Object.fromEntries(
    identityFields.map((field) => [
      field,
      handshake
        ? own(root, field) === null
          ? null
          : fail(
              'WORKFLOW_RUNNER_IDENTITY_MISMATCH',
              `$/${field}`,
              `${field} must be null during handshake.`,
            )
        : identifier(own(root, field), `$/${field}`),
    ]),
  ) as Record<(typeof identityFields)[number], string | null>;
  const fencingToken = handshake
    ? own(root, 'fencingToken') === null
      ? null
      : fail(
          'WORKFLOW_RUNNER_IDENTITY_MISMATCH',
          '$/fencingToken',
          'fencingToken must be null during handshake.',
        )
    : integer(own(root, 'fencingToken'), '$/fencingToken', 1);
  const sequence = handshake
    ? own(root, 'sequence') === null
      ? null
      : fail(
          'WORKFLOW_RUNNER_IDENTITY_MISMATCH',
          '$/sequence',
          'sequence must be null during handshake.',
        )
    : integer(own(root, 'sequence'), '$/sequence', 1);
  const sentAt = timestamp(own(root, 'sentAt'), '$/sentAt');
  const message = immutable({
    protocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
    kind,
    workspaceId: identifier(own(root, 'workspaceId'), '$/workspaceId'),
    jobId: identity.jobId,
    workflowRunId: identity.workflowRunId,
    attemptId: identity.attemptId,
    leaseId: identity.leaseId,
    fencingToken,
    sequence,
    eventId: identifier(own(root, 'eventId'), '$/eventId'),
    correlationId: identifier(own(root, 'correlationId'), '$/correlationId'),
    sentAt,
    payload: validatePayload(kind, own(root, 'payload'), sentAt),
  } as WorkflowRunnerMessage);
  const canonical = canonicalWorkflowEffectJson(message);
  if (Buffer.byteLength(canonical, 'utf8') + 1 > WORKFLOW_RUNNER_CONTRACT_LIMITS.maxMessageBytes) {
    return fail('WORKFLOW_RUNNER_LIMIT_EXCEEDED', '$', 'Message exceeds its exact-byte limit.');
  }
  return message;
}

export function canonicalWorkflowRunnerMessageJson(value: unknown): string {
  return canonicalWorkflowEffectJson(validateWorkflowRunnerMessage(value));
}

export function encodeWorkflowRunnerMessage(value: unknown): string {
  return `${canonicalWorkflowRunnerMessageJson(value)}\n`;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function prepareWorkflowRunnerMessage(value: unknown): WorkflowRunnerPreparedMessage {
  const message = validateWorkflowRunnerMessage(value);
  const body = `${canonicalWorkflowEffectJson(message)}\n`;
  const messageDigest = sha256(body);
  const idempotencyKey = `${WORKFLOW_RUNNER_IDEMPOTENCY_PREFIX}${messageDigest}`;
  const fingerprintPreimage = canonicalWorkflowEffectJson({
    schema: WORKFLOW_RUNNER_FINGERPRINT_SCHEMA,
    protocolVersion: message.protocolVersion,
    kind: message.kind,
    direction: workflowRunnerDirectionForKind(message.kind),
    workspaceId: message.workspaceId,
    jobId: message.jobId,
    workflowRunId: message.workflowRunId,
    attemptId: message.attemptId,
    leaseId: message.leaseId,
    fencingToken: message.fencingToken,
    sequence: message.sequence,
    eventId: message.eventId,
    correlationId: message.correlationId,
    messageDigest,
  });
  return immutable({
    schema: WORKFLOW_RUNNER_PREPARED_SCHEMA,
    body,
    messageDigest,
    idempotencyKey,
    requestFingerprint: `sha256:${sha256(fingerprintPreimage)}`,
  });
}

export function parseWorkflowRunnerMessageBytes(bytes: Buffer): WorkflowRunnerMessage {
  if (
    bytes.length === 0 ||
    bytes.length > WORKFLOW_RUNNER_CONTRACT_LIMITS.maxMessageBytes ||
    bytes[bytes.length - 1] !== 0x0a ||
    (bytes.length > 1 && bytes[bytes.length - 2] === 0x0a)
  ) {
    return fail(
      'WORKFLOW_RUNNER_INVALID_MESSAGE',
      '$',
      'Message bytes must end with exactly one LF within the byte limit.',
    );
  }
  let parsed: unknown;
  try {
    parsed = parseWorkflowEffectJson(bytes.subarray(0, -1), {
      maxDepth: WORKFLOW_RUNNER_CONTRACT_LIMITS.maxJsonDepth,
      maxNodes: WORKFLOW_RUNNER_CONTRACT_LIMITS.maxJsonNodes,
      maxStringLength: WORKFLOW_RUNNER_CONTRACT_LIMITS.maxStringBytes,
    });
  } catch (error) {
    return fail(
      'WORKFLOW_RUNNER_INVALID_MESSAGE',
      '$',
      error instanceof Error ? error.message : 'Message bytes are invalid JSON.',
    );
  }
  const message = validateWorkflowRunnerMessage(parsed);
  if (!Buffer.from(encodeWorkflowRunnerMessage(message), 'utf8').equals(bytes)) {
    return fail(
      'WORKFLOW_RUNNER_INVALID_MESSAGE',
      '$',
      'Message bytes are not the exact canonical JSON representation.',
    );
  }
  return message;
}

export function createWorkflowRunnerEventReceipt(
  receivedValue: unknown,
  input: CreateWorkflowRunnerEventReceiptInput,
): WorkflowRunnerEventReceiptMessage {
  const received = validateWorkflowRunnerMessage(receivedValue);
  if (!WORKFLOW_RUNNER_RECEIPTABLE_KINDS.includes(received.kind as WorkflowRunnerReceiptableKind)) {
    return fail('WORKFLOW_RUNNER_INVALID_MESSAGE', '$/kind', 'Message kind cannot be receipted.');
  }
  const bound = received as Exclude<
    WorkflowRunnerMessage,
    WorkflowRunnerHelloMessage | WorkflowRunnerHelloAckMessage | WorkflowRunnerEventReceiptMessage
  >;
  const status = enumValue(input.status, WORKFLOW_RUNNER_RECEIPT_STATUSES, '$/status');
  const errorCode = nullable(input.errorCode, (entry) =>
    enumValue(entry, WORKFLOW_RUNNER_RECEIPT_ERROR_CODES, '$/errorCode'),
  );
  if ((status === 'reconciliation_required') !== (errorCode !== null)) {
    return fail(
      'WORKFLOW_RUNNER_INVALID_MESSAGE',
      '$/errorCode',
      'Receipt errorCode must match status.',
    );
  }
  const sequence = integer(input.sequence, '$/sequence', 1);
  const sentAt = timestamp(input.sentAt, '$/sentAt');
  const controlBuildHash = hash(input.controlBuildHash, '$/controlBuildHash');
  const prepared = prepareWorkflowRunnerMessage(bound);
  const receiptIdentity = canonicalWorkflowEffectJson({
    schema: WORKFLOW_RUNNER_RECEIPT_IDENTITY_SCHEMA,
    workspaceId: bound.workspaceId,
    eventId: bound.eventId,
    messageDigest: prepared.messageDigest,
    status,
    controlBuildHash,
    committedAt: sentAt,
    errorCode,
  });
  return validateWorkflowRunnerMessage({
    protocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
    kind: 'event_receipt',
    workspaceId: bound.workspaceId,
    jobId: bound.jobId,
    workflowRunId: bound.workflowRunId,
    attemptId: bound.attemptId,
    leaseId: bound.leaseId,
    fencingToken: bound.fencingToken,
    sequence,
    eventId: `receipt.${sha256(receiptIdentity)}`,
    correlationId: bound.correlationId,
    sentAt,
    payload: {
      receivedEventId: bound.eventId,
      receivedKind: bound.kind,
      receivedSequence: bound.sequence,
      receivedDigest: prepared.messageDigest,
      receivedIdempotencyKey: prepared.idempotencyKey,
      receivedFingerprint: prepared.requestFingerprint,
      status,
      controlBuildHash,
      committedAt: sentAt,
      errorCode,
    },
  }) as WorkflowRunnerEventReceiptMessage;
}

export function validateWorkflowRunnerEventReceipt(
  receiptValue: unknown,
  receivedValue: unknown,
  expectedControlBuildHash: string,
): WorkflowRunnerEventReceiptMessage {
  const received = validateWorkflowRunnerMessage(receivedValue);
  const receipt = validateWorkflowRunnerMessage(receiptValue);
  if (receipt.kind !== 'event_receipt') {
    return fail('WORKFLOW_RUNNER_INVALID_MESSAGE', '$/kind', 'Expected event_receipt.');
  }
  if (!WORKFLOW_RUNNER_RECEIPTABLE_KINDS.includes(received.kind as WorkflowRunnerReceiptableKind)) {
    return fail(
      'WORKFLOW_RUNNER_INVALID_MESSAGE',
      '$/payload/receivedKind',
      'Message kind cannot be receipted.',
    );
  }
  const prepared = prepareWorkflowRunnerMessage(received);
  const controlBuildHash = hash(expectedControlBuildHash, '$/expectedControlBuildHash');
  const identityFields = [
    'workspaceId',
    'jobId',
    'workflowRunId',
    'attemptId',
    'leaseId',
    'fencingToken',
    'correlationId',
  ] as const;
  if (identityFields.some((field) => receipt[field] !== received[field])) {
    return fail(
      'WORKFLOW_RUNNER_IDENTITY_MISMATCH',
      '$',
      'Receipt identity does not match the received event.',
    );
  }
  const payload = receipt.payload;
  const receiptIdentity = canonicalWorkflowEffectJson({
    schema: WORKFLOW_RUNNER_RECEIPT_IDENTITY_SCHEMA,
    workspaceId: received.workspaceId,
    eventId: received.eventId,
    messageDigest: prepared.messageDigest,
    status: payload.status,
    controlBuildHash,
    committedAt: payload.committedAt,
    errorCode: payload.errorCode,
  });
  if (
    payload.receivedEventId !== received.eventId ||
    payload.receivedKind !== received.kind ||
    payload.receivedSequence !== received.sequence ||
    payload.receivedDigest !== prepared.messageDigest ||
    payload.receivedIdempotencyKey !== prepared.idempotencyKey ||
    payload.receivedFingerprint !== prepared.requestFingerprint ||
    payload.controlBuildHash !== controlBuildHash ||
    receipt.sentAt !== payload.committedAt ||
    receipt.eventId !== `receipt.${sha256(receiptIdentity)}`
  ) {
    return fail(
      'WORKFLOW_RUNNER_HASH_MISMATCH',
      '$/payload',
      'Receipt evidence does not match the received event.',
    );
  }
  return receipt;
}
