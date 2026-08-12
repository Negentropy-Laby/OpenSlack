import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalWorkflowEffectJson, parseWorkflowEffectJson } from './workflow-effect-json.js';
import {
  prepareWorkflowRunnerMessage,
  validateWorkflowRunnerEventReceipt,
  validateWorkflowRunnerMessage,
  type WorkflowRunnerEventReceiptMessage,
  type WorkflowRunnerEffectIntentMessage,
  type WorkflowRunnerPreparedMessage,
} from './workflow-runner-contract.js';
import { hashWorkflowRunnerDomain } from './workflow-runner-descriptor.js';
import {
  validateWorkflowEffectApproval,
  workflowEffectApprovalAuditEventId,
  workflowEffectApprovalBytes,
  type WorkflowEffectApprovalRecord,
} from './workflow-effect-approval.js';

export const WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION = 'v1' as const;
export const WORKFLOW_EFFECT_CONTROL_ARTIFACT_SCHEMA =
  'openslack.workflow_effect_control_artifact.v1' as const;
export const WORKFLOW_EFFECT_CONTROL_OBSERVATION_SCHEMA =
  'openslack.workflow_effect_control_observation.v1' as const;
export const WORKFLOW_EFFECT_CONTROL_ENVELOPE_SCHEMA =
  'openslack.workflow_effect_control_envelope.v1' as const;
export const WORKFLOW_EFFECT_CONTROL_HUMAN_DECISION_SCHEMA =
  'openslack.workflow_effect_human_decision_projection.v1' as const;
export const WORKFLOW_EFFECT_CONTROL_AUTHORITY = 'typescript' as const;
export const WORKFLOW_EFFECT_CONTROL_GO_ROLE = 'observer_only' as const;
export const WORKFLOW_EFFECT_CONTROL_AUTHORITY_CLAIM = 'NO_AUTHORITY' as const;
export const WORKFLOW_EFFECT_CONTROL_NON_AUTHORIZING_OBSERVATION = true as const;
export const WORKFLOW_EFFECT_CONTROL_ROUTE = '/v1/shadow/workflow-control/effect-events' as const;
export const WORKFLOW_EFFECT_CONTROL_IDEMPOTENCY_PREFIX =
  'openslack.workflow-effect-control-shadow.v1.' as const;
export const WORKFLOW_EFFECT_CONTROL_RUNNER_V1_MANIFEST_SHA256 =
  '908ff368f35033206b975a0421396f49e588098f040aecef2fdd18cd8b67ece6' as const;
export const WORKFLOW_EFFECT_CONTROL_RUNNER_V1_GOLDEN_SHA256 =
  'b4569ca9e9e3f9b027c1bf3d531760ca9fbf87ecd3f7818204eca367a7fce844' as const;
export const WORKFLOW_EFFECT_CONTROL_AUTHORITY_V2_MANIFEST_SHA256 =
  '62ae5761447347dd5b6a8c408f5d453a4043f02226163bb5671c552cb8f556f1' as const;
export const WORKFLOW_EFFECT_CONTROL_AUTHORITY_V2_GOLDEN_SHA256 =
  '4e969ba38dbc5f73ff500244e76769d40a771171e830031d0300629a99fee3fe' as const;
export const WORKFLOW_EFFECT_CONTROL_CHECKPOINT_MANIFEST_SHA256 =
  'e6b4edefc887f17a83237471e168f4c0819b7848ad6a63d2446fc572bdcff000' as const;
export const WORKFLOW_EFFECT_CONTROL_CHECKPOINT_GOLDEN_SHA256 =
  '65bd0ea771fb0984fd97b6a97306953953686f2a381a12b4adb3a8765c1c42c7' as const;
export const WORKFLOW_EFFECT_CONTROL_MAX_SOURCE_SEQUENCE = 3;

export const WORKFLOW_EFFECT_CONTROL_ARTIFACT_KINDS = Object.freeze([
  'effect_intent',
  'effect_approval_pending',
  'effect_decision_committed',
  'effect_audit_recorded',
  'effect_execution_claim',
  'legacy_run_gate_observation',
] as const);
export type WorkflowEffectControlArtifactKind =
  (typeof WORKFLOW_EFFECT_CONTROL_ARTIFACT_KINDS)[number];

export const WORKFLOW_EFFECT_CONTROL_OBSERVER_OPERATIONS = Object.freeze([
  'approval_created',
  'approval_decided',
  'audit_recorded',
] as const);
export type WorkflowEffectControlObserverOperation =
  (typeof WORKFLOW_EFFECT_CONTROL_OBSERVER_OPERATIONS)[number];

export const WORKFLOW_EFFECT_CONTROL_ERROR_CODES = Object.freeze([
  'WORKFLOW_EFFECT_CONTROL_INVALID',
  'WORKFLOW_EFFECT_CONTROL_UNKNOWN_FIELD',
  'WORKFLOW_EFFECT_CONTROL_LIMIT_EXCEEDED',
  'WORKFLOW_EFFECT_CONTROL_HASH_MISMATCH',
  'WORKFLOW_EFFECT_CONTROL_IDENTITY_MISMATCH',
  'WORKFLOW_EFFECT_CONTROL_APPROVAL_PLANE_MISMATCH',
  'WORKFLOW_EFFECT_CONTROL_STALE_REVISION',
] as const);
export type WorkflowEffectControlErrorCode = (typeof WORKFLOW_EFFECT_CONTROL_ERROR_CODES)[number];

export const WORKFLOW_EFFECT_CONTROL_LIMITS = Object.freeze({
  maxArtifactBytes: 512 * 1024,
  maxObservationBytes: 256 * 1024,
  maxEnvelopeBytes: 512 * 1024,
  maxJsonDepth: 24,
  maxJsonNodes: 8_192,
  maxSourceSequence: WORKFLOW_EFFECT_CONTROL_MAX_SOURCE_SEQUENCE,
} as const);

export class WorkflowEffectControlContractError extends Error {
  constructor(
    readonly code: WorkflowEffectControlErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowEffectControlContractError';
  }
}

export interface WorkflowEffectOccurrenceBinding {
  readonly runId: string;
  readonly occurrenceIndex: number;
  readonly occurrenceId: string;
}

export interface WorkflowEffectControlHumanDecisionProjection {
  readonly schema: typeof WORKFLOW_EFFECT_CONTROL_HUMAN_DECISION_SCHEMA;
  readonly channel: 'local_human_attestation_tty_v1';
  readonly principalId: string;
  readonly workspaceId: string;
  readonly capability: string;
  readonly runId: string;
  readonly approvalId: string;
  readonly correlationId: string;
  readonly decision: 'approved' | 'rejected';
  readonly reasonHash: string;
  readonly approvalExpiresAt: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly bindingHash: string;
  readonly attestationHash: string;
  readonly decidedAt: string;
}

interface ArtifactBase {
  readonly schema: typeof WORKFLOW_EFFECT_CONTROL_ARTIFACT_SCHEMA;
  readonly contractVersion: typeof WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION;
  readonly authority: typeof WORKFLOW_EFFECT_CONTROL_AUTHORITY;
  readonly writer: '@openslack/workflows';
  readonly goRole: 'validator_only';
  readonly goAuthorityClaim: 'NO_AUTHORITY';
  readonly goAuthorityEligible: false;
  readonly workspaceId: string;
  readonly runId: string;
  readonly occurrenceIndex: number;
  readonly occurrenceId: string;
}

export interface WorkflowEffectIntentArtifact extends ArtifactBase {
  readonly kind: 'effect_intent';
  readonly runnerV1Message: WorkflowRunnerEffectIntentMessage;
  readonly runnerV1Prepared: WorkflowRunnerPreparedMessage;
  readonly runnerV1Receipt: WorkflowRunnerEventReceiptMessage;
}

interface ApprovalArtifactBase extends ArtifactBase {
  readonly intentArtifact: WorkflowEffectIntentArtifact;
  readonly intentBindingHash: string;
  readonly intentEffectId: string;
  readonly intentEffectHash: string;
  readonly correlationId: string;
  readonly approval: WorkflowEffectApprovalRecord;
  readonly approvalRecordHash: string;
  readonly approvalDecisionHash: string | null;
}

export interface WorkflowEffectApprovalPendingArtifact extends ApprovalArtifactBase {
  readonly kind: 'effect_approval_pending';
}

export interface WorkflowEffectDecisionCommittedArtifact extends ApprovalArtifactBase {
  readonly kind: 'effect_decision_committed';
  readonly humanDecision: WorkflowEffectControlHumanDecisionProjection;
}

export interface WorkflowEffectAuditRecordedArtifact extends ApprovalArtifactBase {
  readonly kind: 'effect_audit_recorded';
  readonly humanDecision: WorkflowEffectControlHumanDecisionProjection;
}

export interface WorkflowEffectExecutionClaimArtifact extends ApprovalArtifactBase {
  readonly kind: 'effect_execution_claim';
  readonly executionId: string;
  readonly consumedApprovalRecordHash: string;
  readonly consumedApprovalRevision: 1 | 2;
  readonly approvalDecisionHash: string;
  readonly claimRevision: 0 | 1;
  readonly claimStatus: 'claimed' | 'executed' | 'reconciliation_required';
  readonly claimedAt: string;
  readonly outcomeHash: string | null;
  readonly committedAt: string | null;
  readonly reconciliationToken: string | null;
}

export interface WorkflowLegacyRunGateObservationArtifact extends ArtifactBase {
  readonly kind: 'legacy_run_gate_observation';
  readonly workspaceId: string;
  readonly plane: 'legacy_run_gate';
  readonly semantics: 'run_gate_only';
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired';
  readonly revision: number;
  readonly legacyProjectionHash: string;
  readonly observedAt: string;
  readonly effectDecisionAuthority: false;
  readonly effectExecutionAuthority: false;
}

export type WorkflowEffectControlArtifact =
  | WorkflowEffectIntentArtifact
  | WorkflowEffectApprovalPendingArtifact
  | WorkflowEffectDecisionCommittedArtifact
  | WorkflowEffectAuditRecordedArtifact
  | WorkflowEffectExecutionClaimArtifact
  | WorkflowLegacyRunGateObservationArtifact;

export interface WorkflowEffectControlObservation {
  readonly schema: typeof WORKFLOW_EFFECT_CONTROL_OBSERVATION_SCHEMA;
  readonly contractVersion: typeof WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION;
  readonly authority: typeof WORKFLOW_EFFECT_CONTROL_AUTHORITY;
  readonly goRole: typeof WORKFLOW_EFFECT_CONTROL_GO_ROLE;
  readonly authorityClaim: typeof WORKFLOW_EFFECT_CONTROL_AUTHORITY_CLAIM;
  readonly nonAuthorizingObservation: typeof WORKFLOW_EFFECT_CONTROL_NON_AUTHORIZING_OBSERVATION;
  readonly goEffectDecisionAuthority: false;
  readonly goEffectExecutionAuthority: false;
  readonly operation: WorkflowEffectControlObserverOperation;
  readonly workspaceId: string;
  readonly runId: string;
  readonly occurrenceId: string;
  readonly approvalId: string;
  readonly approvalRevision: 0 | 1 | 2;
  readonly approvalStatus: 'pending' | 'approved' | 'rejected';
  readonly approvalHash: string;
  readonly approvalDecisionHash: string | null;
  readonly effectId: string;
  readonly effectHash: string;
  readonly correlationId: string;
  readonly requiredCapabilityHash: string;
  readonly humanDecision: Omit<WorkflowEffectControlHumanDecisionProjection, 'nonce'> | null;
  readonly bindingHash: string | null;
  readonly decision: 'approved' | 'rejected' | null;
  readonly auditEventId: string | null;
  readonly auditStatus: 'pending' | 'recorded' | null;
  readonly observedAt: string;
}

export interface WorkflowEffectControlEnvelope {
  readonly schema: typeof WORKFLOW_EFFECT_CONTROL_ENVELOPE_SCHEMA;
  readonly contractVersion: typeof WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION;
  readonly authority: typeof WORKFLOW_EFFECT_CONTROL_AUTHORITY;
  readonly goRole: typeof WORKFLOW_EFFECT_CONTROL_GO_ROLE;
  readonly authorityClaim: typeof WORKFLOW_EFFECT_CONTROL_AUTHORITY_CLAIM;
  readonly nonAuthorizingObservation: typeof WORKFLOW_EFFECT_CONTROL_NON_AUTHORIZING_OBSERVATION;
  readonly sourceSequence: number;
  readonly operation: WorkflowEffectControlObserverOperation;
  readonly observation: WorkflowEffectControlObservation;
  readonly observationHash: string;
}

export interface WorkflowEffectControlPreparedEnvelope {
  readonly envelope: WorkflowEffectControlEnvelope;
  readonly body: string;
  readonly bodyHash: string;
  readonly idempotencyKey: string;
}

type DataRecord = Record<string, unknown>;
const HASH = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const CAPABILITY = /^[a-z][A-Za-z0-9_-]*(?:\.[a-z][A-Za-z0-9_-]*)+$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const OCCURRENCE_ID = /^WFOCCURRENCE-[0-9a-f]{64}$/u;
const EXECUTION_ID = /^WFEXECUTION-[0-9a-f]{64}$/u;
const APPROVAL_ID = /^WFAPPROVAL-[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function fail(code: WorkflowEffectControlErrorCode, path: string, message: string): never {
  throw new WorkflowEffectControlContractError(code, path, message);
}

function closedRecord(value: unknown, fields: readonly string[], path = '$'): DataRecord {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail('WORKFLOW_EFFECT_CONTROL_INVALID', path, `${path} must be an inert object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_UNKNOWN_FIELD',
      path,
      `${path} has missing or unknown fields.`,
    );
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return fail(
        'WORKFLOW_EFFECT_CONTROL_INVALID',
        `${path}/${String(key)}`,
        'Data field required.',
      );
    }
  }
  return value as DataRecord;
}

function own(record: DataRecord, field: string): unknown {
  return record[field];
}

function text(value: unknown, path: string, pattern = SAFE_ID): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    return fail('WORKFLOW_EFFECT_CONTROL_INVALID', path, `${path} is invalid.`);
  }
  return value;
}

function hash(value: unknown, path: string): string {
  return text(value, path, HASH);
}

function timestamp(value: unknown, path: string): string {
  if (
    typeof value !== 'string' ||
    !TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    return fail('WORKFLOW_EFFECT_CONTROL_INVALID', path, `${path} is not canonical time.`);
  }
  return value;
}

function integer(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    return fail('WORKFLOW_EFFECT_CONTROL_INVALID', path, `${path} is invalid.`);
  }
  return value as number;
}

function immutable<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(immutable);
  else if (value && typeof value === 'object' && !ArrayBuffer.isView(value))
    Object.values(value).forEach(immutable);
  return Object.freeze(value);
}

export function canonicalWorkflowEffectControlJson(value: unknown): string {
  return canonicalWorkflowEffectJson(value as Record<string, unknown>);
}

export function hashWorkflowEffectControlDomain(domain: string, value: unknown): string {
  const body = typeof value === 'string' ? value : canonicalWorkflowEffectControlJson(value);
  return createHash('sha256')
    .update(`openslack.workflow-effect-control.${domain}.v1\0`, 'utf8')
    .update(body, 'utf8')
    .digest('hex');
}

export function deriveWorkflowEffectOccurrenceId(
  runIdValue: string,
  occurrenceIndexValue: number,
): string {
  const runId = text(runIdValue, '$/runId');
  const occurrenceIndex = integer(occurrenceIndexValue, '$/occurrenceIndex', 1);
  return `WFOCCURRENCE-${hashWorkflowEffectControlDomain('occurrence-id', {
    occurrenceIndex,
    runId,
  })}`;
}

export function deriveWorkflowEffectApprovalId(
  occurrenceIdValue: string,
  intentBindingHashValue: string,
): string {
  const occurrenceId = text(occurrenceIdValue, '$/occurrenceId', OCCURRENCE_ID);
  const intentBindingHash = hash(intentBindingHashValue, '$/intentBindingHash');
  return `WFAPPROVAL-${hashWorkflowEffectControlDomain('approval-id', {
    intentBindingHash,
    occurrenceId,
  })}`;
}

function occurrence(record: DataRecord): WorkflowEffectOccurrenceBinding {
  const runId = text(own(record, 'runId'), '$/runId');
  const occurrenceIndex = integer(own(record, 'occurrenceIndex'), '$/occurrenceIndex', 1);
  const occurrenceId = text(own(record, 'occurrenceId'), '$/occurrenceId', OCCURRENCE_ID);
  if (occurrenceId !== deriveWorkflowEffectOccurrenceId(runId, occurrenceIndex)) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_HASH_MISMATCH',
      '$/occurrenceId',
      'Occurrence ID is not deterministic.',
    );
  }
  return immutable({ runId, occurrenceIndex, occurrenceId });
}

function artifactBase(record: DataRecord, kind: WorkflowEffectControlArtifactKind) {
  if (
    own(record, 'schema') !== WORKFLOW_EFFECT_CONTROL_ARTIFACT_SCHEMA ||
    own(record, 'contractVersion') !== WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION ||
    own(record, 'authority') !== WORKFLOW_EFFECT_CONTROL_AUTHORITY ||
    own(record, 'writer') !== '@openslack/workflows' ||
    own(record, 'goRole') !== 'validator_only' ||
    own(record, 'goAuthorityClaim') !== 'NO_AUTHORITY' ||
    own(record, 'goAuthorityEligible') !== false ||
    own(record, 'kind') !== kind
  ) {
    return fail('WORKFLOW_EFFECT_CONTROL_INVALID', '$', 'Artifact authority or kind is invalid.');
  }
  return immutable({
    schema: WORKFLOW_EFFECT_CONTROL_ARTIFACT_SCHEMA,
    contractVersion: WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION,
    authority: WORKFLOW_EFFECT_CONTROL_AUTHORITY,
    writer: '@openslack/workflows' as const,
    goRole: 'validator_only' as const,
    goAuthorityClaim: 'NO_AUTHORITY' as const,
    goAuthorityEligible: false as const,
    workspaceId: text(own(record, 'workspaceId'), '$/workspaceId'),
    ...occurrence(record),
  });
}

export function hashWorkflowEffectControlArtifact(value: WorkflowEffectControlArtifact): string {
  return hashWorkflowEffectControlDomain('artifact', validateWorkflowEffectControlArtifact(value));
}

export function hashWorkflowEffectIntentBinding(value: WorkflowEffectIntentArtifact): string {
  const artifact = validateWorkflowEffectControlArtifact(value);
  if (artifact.kind !== 'effect_intent') {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_APPROVAL_PLANE_MISMATCH',
      '$/kind',
      'Stable intent binding requires an effect_intent artifact.',
    );
  }
  return hashWorkflowEffectControlDomain('intent-binding', {
    occurrenceId: artifact.occurrenceId,
    occurrenceIndex: artifact.occurrenceIndex,
    runId: artifact.runId,
    workspaceId: artifact.workspaceId,
    runnerV1Message: artifact.runnerV1Message,
    runnerV1Prepared: artifact.runnerV1Prepared,
  });
}

export function hashWorkflowEffectApprovalRecord(record: WorkflowEffectApprovalRecord): string {
  const bytes = workflowEffectApprovalBytes(validateWorkflowEffectApproval(record));
  if (bytes.byteLength > 64 * 1024) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_LIMIT_EXCEEDED',
      '$/approval',
      'Approval exact bytes exceed 64 KiB.',
    );
  }
  return createHash('sha256').update(bytes).digest('hex');
}

export function hashWorkflowEffectApprovalDecision(
  recordValue: WorkflowEffectApprovalRecord,
  humanDecisionValue: WorkflowEffectControlHumanDecisionProjection,
): string {
  const record = validateWorkflowEffectApproval(recordValue);
  if (record.status === 'pending' || !record.decision || !record.auditProjection) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_STALE_REVISION',
      '$/approval',
      'Decision hash requires a terminal approval.',
    );
  }
  const humanDecision = validateWorkflowEffectControlHumanDecisionProjection(humanDecisionValue);
  assertHumanDecisionMatchesApproval(humanDecision, record);
  return hashWorkflowEffectControlDomain('approval-decision', {
    approvalId: record.approvalId,
    correlationId: record.correlationId,
    decision: record.decision,
    effectHash: record.effectHash,
    effectId: record.effectId,
    expiresAt: record.expiresAt,
    requiredCapability: record.requiredCapability,
    runId: record.runId,
    status: record.status,
    workflowHash: record.workflowHash,
    workflowId: record.workflowId,
    workflowVersion: record.workflowVersion,
    inputHash: record.inputHash,
    auditEventId: record.auditProjection.eventId,
    humanBindingHash: humanDecision.bindingHash,
  });
}

export function validateWorkflowEffectControlHumanDecisionProjection(
  value: unknown,
): WorkflowEffectControlHumanDecisionProjection {
  const record = closedRecord(value, [
    'schema',
    'channel',
    'principalId',
    'workspaceId',
    'capability',
    'runId',
    'approvalId',
    'correlationId',
    'decision',
    'reasonHash',
    'approvalExpiresAt',
    'issuedAt',
    'expiresAt',
    'nonce',
    'bindingHash',
    'attestationHash',
    'decidedAt',
  ]);
  if (own(record, 'schema') !== WORKFLOW_EFFECT_CONTROL_HUMAN_DECISION_SCHEMA) {
    return fail('WORKFLOW_EFFECT_CONTROL_INVALID', '$/schema', 'Decision schema is invalid.');
  }
  const channel = own(record, 'channel');
  const decision = own(record, 'decision');
  if (
    channel !== 'local_human_attestation_tty_v1' ||
    !['approved', 'rejected'].includes(decision as string)
  ) {
    return fail('WORKFLOW_EFFECT_CONTROL_INVALID', '$', 'Decision channel or status is invalid.');
  }
  const result = immutable({
    schema: WORKFLOW_EFFECT_CONTROL_HUMAN_DECISION_SCHEMA,
    channel: 'local_human_attestation_tty_v1' as const,
    principalId: text(own(record, 'principalId'), '$/principalId'),
    workspaceId: text(own(record, 'workspaceId'), '$/workspaceId'),
    capability: text(own(record, 'capability'), '$/capability', CAPABILITY),
    runId: text(own(record, 'runId'), '$/runId'),
    approvalId: text(own(record, 'approvalId'), '$/approvalId'),
    correlationId: text(own(record, 'correlationId'), '$/correlationId'),
    decision: decision as 'approved' | 'rejected',
    reasonHash: hash(own(record, 'reasonHash'), '$/reasonHash'),
    approvalExpiresAt: timestamp(own(record, 'approvalExpiresAt'), '$/approvalExpiresAt'),
    issuedAt: timestamp(own(record, 'issuedAt'), '$/issuedAt'),
    expiresAt: timestamp(own(record, 'expiresAt'), '$/expiresAt'),
    nonce: text(own(record, 'nonce'), '$/nonce', UUID_V4),
    bindingHash: hash(own(record, 'bindingHash'), '$/bindingHash'),
    attestationHash: hash(own(record, 'attestationHash'), '$/attestationHash'),
    decidedAt: timestamp(own(record, 'decidedAt'), '$/decidedAt'),
  });
  const bindingLifetime = Date.parse(result.expiresAt) - Date.parse(result.issuedAt);
  if (
    bindingLifetime <= 0 ||
    bindingLifetime > 60_000 ||
    Date.parse(result.issuedAt) > Date.parse(result.decidedAt) ||
    Date.parse(result.decidedAt) >= Date.parse(result.expiresAt) ||
    Date.parse(result.expiresAt) > Date.parse(result.approvalExpiresAt)
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_IDENTITY_MISMATCH',
      '$',
      'Decision time binding is invalid.',
    );
  }
  const bindingCore = {
    approvalExpiresAt: result.approvalExpiresAt,
    approvalId: result.approvalId,
    capability: result.capability,
    channel: result.channel,
    correlationId: result.correlationId,
    decision: result.decision,
    decidedAt: result.decidedAt,
    expiresAt: result.expiresAt,
    issuedAt: result.issuedAt,
    nonce: result.nonce,
    principalId: result.principalId,
    reasonHash: result.reasonHash,
    runId: result.runId,
    workspaceId: result.workspaceId,
  };
  if (
    result.bindingHash !== hashWorkflowEffectControlDomain('human-binding', bindingCore) ||
    result.attestationHash !==
      hashWorkflowEffectControlDomain('human-attestation', {
        bindingHash: result.bindingHash,
        channel: result.channel,
      })
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_HASH_MISMATCH',
      '$/bindingHash',
      'Human decision projection hash changed.',
    );
  }
  return result;
}

function assertHumanDecisionMatchesApproval(
  humanDecision: WorkflowEffectControlHumanDecisionProjection,
  approval: WorkflowEffectApprovalRecord,
): void {
  const decision = approval.decision;
  if (
    decision === null ||
    humanDecision.runId !== approval.runId ||
    humanDecision.approvalId !== approval.approvalId ||
    humanDecision.correlationId !== approval.correlationId ||
    humanDecision.decision !== approval.status ||
    humanDecision.approvalExpiresAt !== approval.expiresAt ||
    humanDecision.principalId !== decision.principalId ||
    humanDecision.workspaceId !== decision.workspaceId ||
    humanDecision.capability !== approval.requiredCapability ||
    humanDecision.capability !== decision.capability ||
    humanDecision.reasonHash !== decision.reasonHash ||
    humanDecision.nonce !== decision.attestationNonce ||
    humanDecision.decidedAt !== decision.decidedAt
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_IDENTITY_MISMATCH',
      '$/humanDecision',
      'Human decision does not exactly match the v2 approval.',
    );
  }
}

export function projectWorkflowEffectHumanDecision(input: {
  readonly approval: WorkflowEffectApprovalRecord;
  readonly issuedAt: string;
  readonly expiresAt: string;
}): WorkflowEffectControlHumanDecisionProjection {
  const approval = validateWorkflowEffectApproval(input.approval);
  if (approval.status === 'pending' || !approval.decision) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_STALE_REVISION',
      '$/approval',
      'Terminal approval required.',
    );
  }
  const bindingCore = {
    approvalExpiresAt: approval.expiresAt,
    approvalId: approval.approvalId,
    capability: approval.decision.capability,
    correlationId: approval.correlationId,
    decision: approval.status,
    decidedAt: approval.decision.decidedAt,
    expiresAt: timestamp(input.expiresAt, '$/expiresAt'),
    issuedAt: timestamp(input.issuedAt, '$/issuedAt'),
    nonce: approval.decision.attestationNonce,
    principalId: approval.decision.principalId,
    reasonHash: approval.decision.reasonHash,
    runId: approval.runId,
    workspaceId: approval.decision.workspaceId,
  };
  return validateWorkflowEffectControlHumanDecisionProjection({
    schema: WORKFLOW_EFFECT_CONTROL_HUMAN_DECISION_SCHEMA,
    channel: 'local_human_attestation_tty_v1',
    ...bindingCore,
    bindingHash: hashWorkflowEffectControlDomain('human-binding', {
      ...bindingCore,
      channel: 'local_human_attestation_tty_v1',
    }),
    attestationHash: hashWorkflowEffectControlDomain('human-attestation', {
      bindingHash: hashWorkflowEffectControlDomain('human-binding', {
        ...bindingCore,
        channel: 'local_human_attestation_tty_v1',
      }),
      channel: 'local_human_attestation_tty_v1',
    }),
  });
}

const BASE = [
  'schema',
  'contractVersion',
  'authority',
  'writer',
  'goRole',
  'goAuthorityClaim',
  'goAuthorityEligible',
  'kind',
  'workspaceId',
  'runId',
  'occurrenceIndex',
  'occurrenceId',
];

function validateWorkflowEffectControlArtifactInner(value: unknown): WorkflowEffectControlArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
    return fail('WORKFLOW_EFFECT_CONTROL_INVALID', '$', 'Artifact must be an object.');
  }
  const kind = (value as DataRecord).kind;
  if (!WORKFLOW_EFFECT_CONTROL_ARTIFACT_KINDS.includes(kind as WorkflowEffectControlArtifactKind)) {
    return fail('WORKFLOW_EFFECT_CONTROL_INVALID', '$/kind', 'Artifact kind is unsupported.');
  }
  const k = kind as WorkflowEffectControlArtifactKind;
  if (k === 'effect_intent') {
    const record = closedRecord(value, [
      ...BASE,
      'runnerV1Message',
      'runnerV1Prepared',
      'runnerV1Receipt',
    ]);
    const base = artifactBase(record, k);
    const message = validateWorkflowRunnerMessage(own(record, 'runnerV1Message'));
    if (message.kind !== 'effect_intent') {
      return fail(
        'WORKFLOW_EFFECT_CONTROL_IDENTITY_MISMATCH',
        '$/runnerV1Message/kind',
        'GS8 effect intent required.',
      );
    }
    const intentMessage = message as WorkflowRunnerEffectIntentMessage;
    if (
      intentMessage.workspaceId !== base.workspaceId ||
      intentMessage.workflowRunId !== base.runId ||
      intentMessage.sequence !== base.occurrenceIndex ||
      intentMessage.payload.requiresHumanDecision !== true ||
      intentMessage.payload.effectId !==
        `workflow-effect:sha256:${intentMessage.payload.effectHash}` ||
      intentMessage.payload.capabilityHash !==
        hashWorkflowRunnerDomain('effect-capability', intentMessage.payload.effectKind)
    ) {
      return fail(
        'WORKFLOW_EFFECT_CONTROL_IDENTITY_MISMATCH',
        '$/runnerV1Message',
        'GS8 intent binding is invalid.',
      );
    }
    const prepared = prepareWorkflowRunnerMessage(message);
    const suppliedPrepared = closedRecord(
      own(record, 'runnerV1Prepared'),
      ['schema', 'body', 'messageDigest', 'idempotencyKey', 'requestFingerprint'],
      '$/runnerV1Prepared',
    );
    if (
      canonicalWorkflowEffectControlJson(suppliedPrepared) !==
      canonicalWorkflowEffectControlJson(prepared)
    ) {
      return fail(
        'WORKFLOW_EFFECT_CONTROL_HASH_MISMATCH',
        '$/runnerV1Prepared',
        'GS8 prepared evidence changed.',
      );
    }
    let receipt: WorkflowRunnerEventReceiptMessage;
    try {
      const suppliedReceipt = validateWorkflowRunnerMessage(own(record, 'runnerV1Receipt'));
      if (suppliedReceipt.kind !== 'event_receipt') {
        return fail(
          'WORKFLOW_EFFECT_CONTROL_INVALID',
          '$/runnerV1Receipt/kind',
          'GS8 event receipt required.',
        );
      }
      receipt = validateWorkflowRunnerEventReceipt(
        suppliedReceipt,
        message,
        suppliedReceipt.payload.controlBuildHash,
      );
    } catch (error) {
      if (error instanceof WorkflowEffectControlContractError) throw error;
      return fail(
        'WORKFLOW_EFFECT_CONTROL_INVALID',
        '$/runnerV1Receipt',
        error instanceof Error ? error.message : 'GS8 receipt is invalid.',
      );
    }
    if (
      !['accepted', 'duplicate'].includes(receipt.payload.status) ||
      receipt.payload.receivedKind !== 'effect_intent'
    ) {
      return fail(
        'WORKFLOW_EFFECT_CONTROL_STALE_REVISION',
        '$/runnerV1Receipt',
        'Accepted GS8 effect intent receipt required.',
      );
    }
    return immutable({
      ...base,
      kind: k,
      runnerV1Message: message,
      runnerV1Prepared: prepared,
      runnerV1Receipt: receipt,
    });
  }
  if (k === 'legacy_run_gate_observation') {
    const record = closedRecord(value, [
      ...BASE,
      'plane',
      'semantics',
      'status',
      'revision',
      'legacyProjectionHash',
      'observedAt',
      'effectDecisionAuthority',
      'effectExecutionAuthority',
    ]);
    const base = artifactBase(record, k);
    const status = own(record, 'status');
    if (
      !['pending', 'approved', 'rejected', 'expired'].includes(status as string) ||
      own(record, 'effectDecisionAuthority') !== false ||
      own(record, 'effectExecutionAuthority') !== false
    ) {
      return fail(
        'WORKFLOW_EFFECT_CONTROL_APPROVAL_PLANE_MISMATCH',
        '$',
        'Legacy gate cannot grant an effect.',
      );
    }
    const workspaceId = text(own(record, 'workspaceId'), '$/workspaceId');
    const revision = integer(own(record, 'revision'), '$/revision', 0);
    if (
      own(record, 'plane') !== 'legacy_run_gate' ||
      own(record, 'semantics') !== 'run_gate_only'
    ) {
      return fail(
        'WORKFLOW_EFFECT_CONTROL_APPROVAL_PLANE_MISMATCH',
        '$/plane',
        'Legacy plane is invalid.',
      );
    }
    const legacyProjectionHash = hash(
      own(record, 'legacyProjectionHash'),
      '$/legacyProjectionHash',
    );
    const expectedProjectionHash = hashWorkflowEffectControlDomain('legacy-projection', {
      effectDecisionAuthority: false,
      plane: 'legacy_run_gate',
      revision,
      runId: base.runId,
      semantics: 'run_gate_only',
      status,
      workspaceId,
    });
    if (legacyProjectionHash !== expectedProjectionHash) {
      return fail(
        'WORKFLOW_EFFECT_CONTROL_HASH_MISMATCH',
        '$/legacyProjectionHash',
        'Legacy projection hash changed.',
      );
    }
    return immutable({
      ...base,
      kind: k,
      workspaceId,
      plane: 'legacy_run_gate' as const,
      semantics: 'run_gate_only' as const,
      status: status as 'pending' | 'approved' | 'rejected' | 'expired',
      revision,
      legacyProjectionHash,
      observedAt: timestamp(own(record, 'observedAt'), '$/observedAt'),
      effectDecisionAuthority: false as const,
      effectExecutionAuthority: false as const,
    });
  }
  const extra =
    k === 'effect_approval_pending'
      ? []
      : k === 'effect_execution_claim'
        ? [
            'humanDecision',
            'executionId',
            'consumedApprovalRecordHash',
            'consumedApprovalRevision',
            'claimRevision',
            'claimStatus',
            'claimedAt',
            'outcomeHash',
            'committedAt',
            'reconciliationToken',
          ]
        : ['humanDecision'];
  const record = closedRecord(value, [
    ...BASE,
    'intentArtifact',
    'intentBindingHash',
    'intentEffectId',
    'intentEffectHash',
    'correlationId',
    'approval',
    'approvalRecordHash',
    'approvalDecisionHash',
    ...extra,
  ]);
  const base = artifactBase(record, k);
  const intentArtifactValue = validateWorkflowEffectControlArtifact(own(record, 'intentArtifact'));
  if (intentArtifactValue.kind !== 'effect_intent') {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_APPROVAL_PLANE_MISMATCH',
      '$/intentArtifact',
      'Approval chain requires an accepted GS8 intent artifact.',
    );
  }
  const intentArtifact: WorkflowEffectIntentArtifact = intentArtifactValue;
  const intentBindingHash = hash(own(record, 'intentBindingHash'), '$/intentBindingHash');
  const expectedIntentBindingHash = hashWorkflowEffectIntentBinding(intentArtifact);
  const approval = validateWorkflowEffectApproval(own(record, 'approval'));
  const approvalRecordHash = hash(own(record, 'approvalRecordHash'), '$/approvalRecordHash');
  const intentEffectId = text(own(record, 'intentEffectId'), '$/intentEffectId');
  const intentEffectHash = hash(own(record, 'intentEffectHash'), '$/intentEffectHash');
  const correlationId = text(own(record, 'correlationId'), '$/correlationId');
  const intentPayload = intentArtifact.runnerV1Message.payload;
  if (
    intentBindingHash !== expectedIntentBindingHash ||
    intentArtifact.workspaceId !== base.workspaceId ||
    intentArtifact.runId !== base.runId ||
    intentArtifact.occurrenceIndex !== base.occurrenceIndex ||
    intentArtifact.occurrenceId !== base.occurrenceId ||
    approval.approvalId !== deriveWorkflowEffectApprovalId(base.occurrenceId, intentBindingHash) ||
    approval.runId !== base.runId ||
    approvalRecordHash !== hashWorkflowEffectApprovalRecord(approval) ||
    approval.effectId !== intentEffectId ||
    approval.effectHash !== intentEffectHash ||
    approval.correlationId !== correlationId ||
    intentPayload.effectId !== intentEffectId ||
    intentPayload.effectHash !== intentEffectHash ||
    intentArtifact.runnerV1Message.correlationId !== correlationId
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_HASH_MISMATCH',
      '$/approvalRecordHash',
      'Approval bytes or intent binding changed.',
    );
  }
  if (k === 'effect_approval_pending') {
    if (approval.status !== 'pending' || approval.revision !== 0) {
      return fail(
        'WORKFLOW_EFFECT_CONTROL_STALE_REVISION',
        '$/approval',
        'Pending artifact requires revision zero.',
      );
    }
    if (own(record, 'approvalDecisionHash') !== null)
      return fail(
        'WORKFLOW_EFFECT_CONTROL_STALE_REVISION',
        '$/approvalDecisionHash',
        'Pending approval has no decision hash.',
      );
    return immutable({
      ...base,
      kind: k,
      intentArtifact,
      intentBindingHash,
      intentEffectId,
      intentEffectHash,
      correlationId,
      approval,
      approvalRecordHash,
      approvalDecisionHash: null,
    });
  }
  const approvalDecisionHash = hash(own(record, 'approvalDecisionHash'), '$/approvalDecisionHash');
  const humanDecision = validateWorkflowEffectControlHumanDecisionProjection(
    own(record, 'humanDecision'),
  );
  assertHumanDecisionMatchesApproval(humanDecision, approval);
  if (approvalDecisionHash !== hashWorkflowEffectApprovalDecision(approval, humanDecision)) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_HASH_MISMATCH',
      '$/approvalDecisionHash',
      'Decision hash changed.',
    );
  }
  if (k === 'effect_decision_committed') {
    if (approval.revision !== 1 || approval.auditProjection?.status !== 'pending') {
      return fail(
        'WORKFLOW_EFFECT_CONTROL_STALE_REVISION',
        '$/approval',
        'Decision artifact requires revision one outbox.',
      );
    }
    return immutable({
      ...base,
      kind: k,
      intentArtifact,
      intentBindingHash,
      intentEffectId,
      intentEffectHash,
      correlationId,
      approval,
      approvalRecordHash,
      approvalDecisionHash,
      humanDecision,
    });
  }
  if (k === 'effect_audit_recorded') {
    if (approval.revision !== 2 || approval.auditProjection?.status !== 'recorded') {
      return fail(
        'WORKFLOW_EFFECT_CONTROL_STALE_REVISION',
        '$/approval',
        'Audit artifact requires revision two.',
      );
    }
    return immutable({
      ...base,
      kind: k,
      intentArtifact,
      intentBindingHash,
      intentEffectId,
      intentEffectHash,
      correlationId,
      approval,
      approvalRecordHash,
      approvalDecisionHash,
      humanDecision,
    });
  }
  if (approval.status !== 'approved' || ![1, 2].includes(approval.revision)) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_APPROVAL_PLANE_MISMATCH',
      '$/approval',
      'Only approved v2 decisions claim execution.',
    );
  }
  const expectedExecutionId = `WFEXECUTION-${hashWorkflowEffectControlDomain('execution-id', {
    approvalDecisionHash,
    occurrenceId: base.occurrenceId,
  })}`;
  const executionId = text(own(record, 'executionId'), '$/executionId', EXECUTION_ID);
  const claimRevision = integer(own(record, 'claimRevision'), '$/claimRevision', 0, 1) as 0 | 1;
  const claimStatus = own(record, 'claimStatus');
  const outcome = own(record, 'outcomeHash');
  const committed = own(record, 'committedAt');
  const reconciliationToken = own(record, 'reconciliationToken');
  const consumedApprovalRecordHash = hash(
    own(record, 'consumedApprovalRecordHash'),
    '$/consumedApprovalRecordHash',
  );
  const consumedApprovalRevision = integer(
    own(record, 'consumedApprovalRevision'),
    '$/consumedApprovalRevision',
    1,
    2,
  ) as 1 | 2;
  if (
    executionId !== expectedExecutionId ||
    consumedApprovalRecordHash !== approvalRecordHash ||
    consumedApprovalRevision !== approval.revision ||
    !['claimed', 'executed', 'reconciliation_required'].includes(claimStatus as string) ||
    (claimStatus === 'claimed' &&
      (claimRevision !== 0 ||
        outcome !== null ||
        committed !== null ||
        reconciliationToken !== null)) ||
    (claimStatus === 'executed' &&
      (claimRevision !== 1 ||
        outcome === null ||
        committed === null ||
        reconciliationToken !== null)) ||
    (claimStatus === 'reconciliation_required' &&
      (claimRevision !== 1 ||
        outcome !== null ||
        committed === null ||
        reconciliationToken === null))
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_STALE_REVISION',
      '$/claimStatus',
      'Execution claim transition is invalid.',
    );
  }
  const claimedAt = timestamp(own(record, 'claimedAt'), '$/claimedAt');
  const committedAt = committed === null ? null : timestamp(committed, '$/committedAt');
  if (
    !approval.decision ||
    Date.parse(claimedAt) < Date.parse(approval.decision.decidedAt) ||
    Date.parse(claimedAt) >= Date.parse(approval.expiresAt) ||
    (committedAt !== null && Date.parse(committedAt) < Date.parse(claimedAt))
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_STALE_REVISION',
      '$/claimedAt',
      'Execution claim is outside the active approved decision lifetime.',
    );
  }
  return immutable({
    ...base,
    kind: k,
    intentArtifact,
    intentBindingHash,
    approval,
    intentEffectId,
    intentEffectHash,
    correlationId,
    approvalRecordHash,
    approvalDecisionHash,
    humanDecision,
    executionId,
    consumedApprovalRecordHash,
    consumedApprovalRevision,
    claimRevision: claimRevision as 0 | 1,
    claimStatus: claimStatus as 'claimed' | 'executed' | 'reconciliation_required',
    claimedAt,
    outcomeHash: outcome === null ? null : hash(outcome, '$/outcomeHash'),
    committedAt,
    reconciliationToken:
      reconciliationToken === null ? null : text(reconciliationToken, '$/reconciliationToken'),
  });
}

export function validateWorkflowEffectControlArtifact(
  value: unknown,
): WorkflowEffectControlArtifact {
  const artifact = validateWorkflowEffectControlArtifactInner(value);
  if (
    Buffer.byteLength(canonicalWorkflowEffectControlJson(artifact), 'utf8') + 1 >
    WORKFLOW_EFFECT_CONTROL_LIMITS.maxArtifactBytes
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_LIMIT_EXCEEDED',
      '$',
      'Effect-control artifact exceeds its exact-byte limit.',
    );
  }
  return artifact;
}

export function validateWorkflowEffectControlObservation(
  value: unknown,
): WorkflowEffectControlObservation {
  const fields = [
    'schema',
    'contractVersion',
    'authority',
    'goRole',
    'authorityClaim',
    'nonAuthorizingObservation',
    'goEffectDecisionAuthority',
    'goEffectExecutionAuthority',
    'operation',
    'workspaceId',
    'runId',
    'occurrenceId',
    'approvalId',
    'approvalRevision',
    'approvalStatus',
    'approvalHash',
    'approvalDecisionHash',
    'effectId',
    'effectHash',
    'correlationId',
    'requiredCapabilityHash',
    'humanDecision',
    'bindingHash',
    'decision',
    'auditEventId',
    'auditStatus',
    'observedAt',
  ];
  const record = closedRecord(value, fields);
  if (
    own(record, 'schema') !== WORKFLOW_EFFECT_CONTROL_OBSERVATION_SCHEMA ||
    own(record, 'contractVersion') !== WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION ||
    own(record, 'authority') !== WORKFLOW_EFFECT_CONTROL_AUTHORITY ||
    own(record, 'goRole') !== WORKFLOW_EFFECT_CONTROL_GO_ROLE ||
    own(record, 'authorityClaim') !== WORKFLOW_EFFECT_CONTROL_AUTHORITY_CLAIM ||
    own(record, 'nonAuthorizingObservation') !== true ||
    own(record, 'goEffectDecisionAuthority') !== false ||
    own(record, 'goEffectExecutionAuthority') !== false
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_APPROVAL_PLANE_MISMATCH',
      '$',
      'Observer cannot claim authority.',
    );
  }
  const operation = own(record, 'operation');
  const revision = integer(own(record, 'approvalRevision'), '$/approvalRevision', 0, 2) as
    0 | 1 | 2;
  const status = own(record, 'approvalStatus');
  const decision = own(record, 'decision');
  const approvalDecisionHash = own(record, 'approvalDecisionHash');
  const bindingHash = own(record, 'bindingHash');
  const humanDecisionValue = own(record, 'humanDecision');
  const auditEventId = own(record, 'auditEventId');
  const auditStatus = own(record, 'auditStatus');
  if (
    !WORKFLOW_EFFECT_CONTROL_OBSERVER_OPERATIONS.includes(
      operation as WorkflowEffectControlObserverOperation,
    ) ||
    !['pending', 'approved', 'rejected'].includes(status as string) ||
    (operation === 'approval_created' &&
      (revision !== 0 ||
        status !== 'pending' ||
        approvalDecisionHash !== null ||
        humanDecisionValue !== null ||
        decision !== null ||
        bindingHash !== null ||
        auditEventId !== null ||
        auditStatus !== null)) ||
    (operation === 'approval_decided' &&
      (revision !== 1 ||
        !['approved', 'rejected'].includes(status as string) ||
        decision !== status ||
        approvalDecisionHash === null ||
        humanDecisionValue === null ||
        bindingHash === null ||
        auditEventId === null ||
        auditStatus !== 'pending')) ||
    (operation === 'audit_recorded' &&
      (revision !== 2 ||
        !['approved', 'rejected'].includes(status as string) ||
        decision !== status ||
        approvalDecisionHash === null ||
        humanDecisionValue === null ||
        bindingHash === null ||
        auditEventId === null ||
        auditStatus !== 'recorded'))
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_STALE_REVISION',
      '$',
      'Observer operation and approval state disagree.',
    );
  }
  const humanDecision =
    humanDecisionValue === null
      ? null
      : sanitizeWorkflowEffectHumanDecision(
          validateSanitizedWorkflowEffectHumanDecision(humanDecisionValue),
        );
  const result = immutable({
    schema: WORKFLOW_EFFECT_CONTROL_OBSERVATION_SCHEMA,
    contractVersion: WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION,
    authority: WORKFLOW_EFFECT_CONTROL_AUTHORITY,
    goRole: WORKFLOW_EFFECT_CONTROL_GO_ROLE,
    authorityClaim: WORKFLOW_EFFECT_CONTROL_AUTHORITY_CLAIM,
    nonAuthorizingObservation: true as const,
    goEffectDecisionAuthority: false as const,
    goEffectExecutionAuthority: false as const,
    operation: operation as WorkflowEffectControlObserverOperation,
    workspaceId: text(own(record, 'workspaceId'), '$/workspaceId'),
    runId: text(own(record, 'runId'), '$/runId'),
    occurrenceId: text(own(record, 'occurrenceId'), '$/occurrenceId', OCCURRENCE_ID),
    approvalId: text(own(record, 'approvalId'), '$/approvalId'),
    approvalRevision: revision,
    approvalStatus: status as 'pending' | 'approved' | 'rejected',
    approvalHash: hash(own(record, 'approvalHash'), '$/approvalHash'),
    approvalDecisionHash:
      approvalDecisionHash === null ? null : hash(approvalDecisionHash, '$/approvalDecisionHash'),
    effectId: text(own(record, 'effectId'), '$/effectId'),
    effectHash: hash(own(record, 'effectHash'), '$/effectHash'),
    correlationId: text(own(record, 'correlationId'), '$/correlationId'),
    requiredCapabilityHash: hash(own(record, 'requiredCapabilityHash'), '$/requiredCapabilityHash'),
    humanDecision,
    bindingHash: bindingHash === null ? null : hash(bindingHash, '$/bindingHash'),
    decision: decision as 'approved' | 'rejected' | null,
    auditEventId: auditEventId === null ? null : text(auditEventId, '$/auditEventId'),
    auditStatus: auditStatus as 'pending' | 'recorded' | null,
    observedAt: timestamp(own(record, 'observedAt'), '$/observedAt'),
  });
  if (
    result.humanDecision !== null &&
    (result.humanDecision.workspaceId !== result.workspaceId ||
      result.humanDecision.runId !== result.runId ||
      result.humanDecision.approvalId !== result.approvalId ||
      result.humanDecision.correlationId !== result.correlationId ||
      result.humanDecision.decision !== result.decision ||
      result.humanDecision.bindingHash !== result.bindingHash ||
      (result.operation === 'approval_decided' &&
        result.observedAt !== result.humanDecision.decidedAt))
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_IDENTITY_MISMATCH',
      '$/humanDecision',
      'Observer human decision projection drifted.',
    );
  }
  const expectedAuditEventId = workflowEffectApprovalAuditEventId(result.runId, result.approvalId);
  if (
    result.effectId !== `workflow-effect:sha256:${result.effectHash}` ||
    (result.auditEventId !== null && result.auditEventId !== expectedAuditEventId) ||
    (result.humanDecision !== null &&
      (result.requiredCapabilityHash !==
        hashWorkflowEffectControlDomain(
          'approval-required-capability',
          result.humanDecision.capability,
        ) ||
        result.humanDecision.attestationHash !==
          hashWorkflowEffectControlDomain('human-attestation', {
            bindingHash: result.humanDecision.bindingHash,
            channel: result.humanDecision.channel,
          }) ||
        Date.parse(result.humanDecision.issuedAt) > Date.parse(result.humanDecision.decidedAt) ||
        Date.parse(result.humanDecision.decidedAt) >= Date.parse(result.humanDecision.expiresAt) ||
        Date.parse(result.humanDecision.expiresAt) >
          Date.parse(result.humanDecision.approvalExpiresAt) ||
        Date.parse(result.humanDecision.expiresAt) - Date.parse(result.humanDecision.issuedAt) >
          60_000))
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_IDENTITY_MISMATCH',
      '$',
      'Observer derived identity or time binding drifted.',
    );
  }
  if (
    Buffer.byteLength(canonicalWorkflowEffectControlJson(result), 'utf8') + 1 >
    WORKFLOW_EFFECT_CONTROL_LIMITS.maxObservationBytes
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_LIMIT_EXCEEDED',
      '$',
      'Effect-control observation exceeds its exact-byte limit.',
    );
  }
  return result;
}

type SanitizedHumanDecision = Omit<WorkflowEffectControlHumanDecisionProjection, 'nonce'>;

function sanitizeWorkflowEffectHumanDecision(
  value: WorkflowEffectControlHumanDecisionProjection | SanitizedHumanDecision,
): SanitizedHumanDecision {
  const {
    schema,
    channel,
    principalId,
    workspaceId,
    capability,
    runId,
    approvalId,
    correlationId,
    decision,
    reasonHash,
    approvalExpiresAt,
    issuedAt,
    expiresAt,
    bindingHash,
    attestationHash,
    decidedAt,
  } = value;
  return immutable({
    schema,
    channel,
    principalId,
    workspaceId,
    capability,
    runId,
    approvalId,
    correlationId,
    decision,
    reasonHash,
    approvalExpiresAt,
    issuedAt,
    expiresAt,
    bindingHash,
    attestationHash,
    decidedAt,
  });
}

function validateSanitizedWorkflowEffectHumanDecision(value: unknown): SanitizedHumanDecision {
  const record = closedRecord(value, [
    'schema',
    'channel',
    'principalId',
    'workspaceId',
    'capability',
    'runId',
    'approvalId',
    'correlationId',
    'decision',
    'reasonHash',
    'approvalExpiresAt',
    'issuedAt',
    'expiresAt',
    'bindingHash',
    'attestationHash',
    'decidedAt',
  ]);
  if (
    own(record, 'schema') !== WORKFLOW_EFFECT_CONTROL_HUMAN_DECISION_SCHEMA ||
    own(record, 'channel') !== 'local_human_attestation_tty_v1' ||
    !['approved', 'rejected'].includes(own(record, 'decision') as string)
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_INVALID',
      '$/humanDecision',
      'Sanitized human decision is invalid.',
    );
  }
  return immutable({
    schema: WORKFLOW_EFFECT_CONTROL_HUMAN_DECISION_SCHEMA,
    channel: 'local_human_attestation_tty_v1' as const,
    principalId: text(own(record, 'principalId'), '$/humanDecision/principalId'),
    workspaceId: text(own(record, 'workspaceId'), '$/humanDecision/workspaceId'),
    capability: text(own(record, 'capability'), '$/humanDecision/capability', CAPABILITY),
    runId: text(own(record, 'runId'), '$/humanDecision/runId'),
    approvalId: text(own(record, 'approvalId'), '$/humanDecision/approvalId'),
    correlationId: text(own(record, 'correlationId'), '$/humanDecision/correlationId'),
    decision: own(record, 'decision') as 'approved' | 'rejected',
    reasonHash: hash(own(record, 'reasonHash'), '$/humanDecision/reasonHash'),
    approvalExpiresAt: timestamp(
      own(record, 'approvalExpiresAt'),
      '$/humanDecision/approvalExpiresAt',
    ),
    issuedAt: timestamp(own(record, 'issuedAt'), '$/humanDecision/issuedAt'),
    expiresAt: timestamp(own(record, 'expiresAt'), '$/humanDecision/expiresAt'),
    bindingHash: hash(own(record, 'bindingHash'), '$/humanDecision/bindingHash'),
    attestationHash: hash(own(record, 'attestationHash'), '$/humanDecision/attestationHash'),
    decidedAt: timestamp(own(record, 'decidedAt'), '$/humanDecision/decidedAt'),
  });
}

export function projectWorkflowEffectControlObservation(
  artifactValue:
    | WorkflowEffectApprovalPendingArtifact
    | WorkflowEffectDecisionCommittedArtifact
    | WorkflowEffectAuditRecordedArtifact,
): WorkflowEffectControlObservation {
  const artifact = validateWorkflowEffectControlArtifact(artifactValue);
  if (
    artifact.kind !== 'effect_approval_pending' &&
    artifact.kind !== 'effect_decision_committed' &&
    artifact.kind !== 'effect_audit_recorded'
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_APPROVAL_PLANE_MISMATCH',
      '$/kind',
      'Only v2 approval lifecycle artifacts have observer projections.',
    );
  }
  const approval = artifact.approval;
  const operation =
    artifact.kind === 'effect_approval_pending'
      ? 'approval_created'
      : artifact.kind === 'effect_decision_committed'
        ? 'approval_decided'
        : 'audit_recorded';
  const humanDecision =
    artifact.kind === 'effect_approval_pending'
      ? null
      : sanitizeWorkflowEffectHumanDecision(artifact.humanDecision);
  const observedAt =
    operation === 'approval_created'
      ? approval.createdAt
      : operation === 'approval_decided'
        ? approval.decision!.decidedAt
        : (approval.auditProjection as { readonly recordedAt: string }).recordedAt;
  return validateWorkflowEffectControlObservation({
    schema: WORKFLOW_EFFECT_CONTROL_OBSERVATION_SCHEMA,
    contractVersion: WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION,
    authority: WORKFLOW_EFFECT_CONTROL_AUTHORITY,
    goRole: WORKFLOW_EFFECT_CONTROL_GO_ROLE,
    authorityClaim: WORKFLOW_EFFECT_CONTROL_AUTHORITY_CLAIM,
    nonAuthorizingObservation: true,
    goEffectDecisionAuthority: false,
    goEffectExecutionAuthority: false,
    operation,
    workspaceId: artifact.workspaceId,
    runId: artifact.runId,
    occurrenceId: artifact.occurrenceId,
    approvalId: approval.approvalId,
    approvalRevision: approval.revision,
    approvalStatus: approval.status,
    approvalHash: artifact.approvalRecordHash,
    approvalDecisionHash: artifact.approvalDecisionHash,
    effectId: approval.effectId,
    effectHash: approval.effectHash,
    correlationId: approval.correlationId,
    requiredCapabilityHash: hashWorkflowEffectControlDomain(
      'approval-required-capability',
      approval.requiredCapability,
    ),
    humanDecision,
    bindingHash: humanDecision?.bindingHash ?? null,
    decision: approval.status === 'pending' ? null : approval.status,
    auditEventId: approval.auditProjection?.eventId ?? null,
    auditStatus: approval.auditProjection?.status ?? null,
    observedAt,
  });
}

export function hashWorkflowEffectControlObservation(
  value: WorkflowEffectControlObservation,
): string {
  return hashWorkflowEffectControlDomain(
    'observation',
    validateWorkflowEffectControlObservation(value),
  );
}

export function validateWorkflowEffectControlEnvelope(
  value: unknown,
): WorkflowEffectControlEnvelope {
  const record = closedRecord(value, [
    'schema',
    'contractVersion',
    'authority',
    'goRole',
    'authorityClaim',
    'nonAuthorizingObservation',
    'sourceSequence',
    'operation',
    'observation',
    'observationHash',
  ]);
  if (
    own(record, 'schema') !== WORKFLOW_EFFECT_CONTROL_ENVELOPE_SCHEMA ||
    own(record, 'contractVersion') !== WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION ||
    own(record, 'authority') !== WORKFLOW_EFFECT_CONTROL_AUTHORITY ||
    own(record, 'goRole') !== WORKFLOW_EFFECT_CONTROL_GO_ROLE ||
    own(record, 'authorityClaim') !== WORKFLOW_EFFECT_CONTROL_AUTHORITY_CLAIM ||
    own(record, 'nonAuthorizingObservation') !== true
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_APPROVAL_PLANE_MISMATCH',
      '$',
      'Envelope cannot claim authority.',
    );
  }
  const observation = validateWorkflowEffectControlObservation(own(record, 'observation'));
  if (own(record, 'operation') !== observation.operation) {
    return fail('WORKFLOW_EFFECT_CONTROL_IDENTITY_MISMATCH', '$/operation', 'Operation mismatch.');
  }
  const observationHash = hash(own(record, 'observationHash'), '$/observationHash');
  if (observationHash !== hashWorkflowEffectControlObservation(observation)) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_HASH_MISMATCH',
      '$/observationHash',
      'Observation hash mismatch.',
    );
  }
  const sourceSequence = integer(
    own(record, 'sourceSequence'),
    '$/sourceSequence',
    1,
    WORKFLOW_EFFECT_CONTROL_MAX_SOURCE_SEQUENCE,
  );
  if (sourceSequence !== observation.approvalRevision + 1) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_STALE_REVISION',
      '$/sourceSequence',
      'Observer source sequence must equal approval revision plus one.',
    );
  }
  const envelope = immutable({
    schema: WORKFLOW_EFFECT_CONTROL_ENVELOPE_SCHEMA,
    contractVersion: WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION,
    authority: WORKFLOW_EFFECT_CONTROL_AUTHORITY,
    goRole: WORKFLOW_EFFECT_CONTROL_GO_ROLE,
    authorityClaim: WORKFLOW_EFFECT_CONTROL_AUTHORITY_CLAIM,
    nonAuthorizingObservation: true as const,
    sourceSequence,
    operation: observation.operation,
    observation,
    observationHash,
  });
  if (
    Buffer.byteLength(canonicalWorkflowEffectControlJson(envelope), 'utf8') + 1 >
    WORKFLOW_EFFECT_CONTROL_LIMITS.maxEnvelopeBytes
  ) {
    return fail(
      'WORKFLOW_EFFECT_CONTROL_LIMIT_EXCEEDED',
      '$',
      'Effect-control envelope exceeds its exact-byte limit.',
    );
  }
  return envelope;
}

export function workflowEffectControlEnvelopeBytes(value: WorkflowEffectControlEnvelope): Buffer {
  return Buffer.from(
    `${canonicalWorkflowEffectControlJson(validateWorkflowEffectControlEnvelope(value))}\n`,
  );
}

export function prepareWorkflowEffectControlEnvelope(
  value: WorkflowEffectControlEnvelope,
): WorkflowEffectControlPreparedEnvelope {
  const envelope = validateWorkflowEffectControlEnvelope(value);
  const body = workflowEffectControlEnvelopeBytes(envelope).toString('utf8');
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  return immutable({
    envelope,
    body,
    bodyHash,
    idempotencyKey: `${WORKFLOW_EFFECT_CONTROL_IDEMPOTENCY_PREFIX}${bodyHash}`,
  });
}

export function parseWorkflowEffectControlEnvelopeBytes(
  bytes: Uint8Array,
): WorkflowEffectControlEnvelope {
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > WORKFLOW_EFFECT_CONTROL_LIMITS.maxEnvelopeBytes ||
    bytes.at(-1) !== 0x0a ||
    bytes.at(-2) === 0x0a ||
    bytes.includes(0x0d)
  ) {
    return fail('WORKFLOW_EFFECT_CONTROL_INVALID', '$', 'Envelope framing is invalid.');
  }
  let value: unknown;
  try {
    value = parseWorkflowEffectJson(Buffer.from(bytes.subarray(0, -1)), {
      maxDepth: WORKFLOW_EFFECT_CONTROL_LIMITS.maxJsonDepth,
      maxNodes: WORKFLOW_EFFECT_CONTROL_LIMITS.maxJsonNodes,
      maxStringLength: WORKFLOW_EFFECT_CONTROL_LIMITS.maxEnvelopeBytes,
    });
  } catch {
    return fail('WORKFLOW_EFFECT_CONTROL_INVALID', '$', 'Envelope JSON is invalid.');
  }
  const envelope = validateWorkflowEffectControlEnvelope(value);
  if (!workflowEffectControlEnvelopeBytes(envelope).equals(Buffer.from(bytes))) {
    return fail('WORKFLOW_EFFECT_CONTROL_INVALID', '$', 'Envelope bytes are noncanonical.');
  }
  return envelope;
}
