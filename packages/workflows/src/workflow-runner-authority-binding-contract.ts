import { createHash } from 'node:crypto';

import {
  WORKFLOW_CONTROL_AUTHORITY_PREPARED_SCHEMA,
  WorkflowControlAuthorityContractError,
  canonicalWorkflowControlAuthorityJson,
  parseWorkflowControlAuthorityMessageBytes,
  prepareWorkflowControlAuthorityMessage,
  validateWorkflowControlAuthorityMessage,
  validateWorkflowControlAuthorityRoute,
  type WorkflowControlAuthorityMessage,
  type WorkflowControlAuthorityMessageKind,
} from './workflow-control-authority-contract.js';
import {
  WorkflowBudgetAuthorityContractError,
  WORKFLOW_BUDGET_PREVIOUS_MANIFEST_SHA256,
  WORKFLOW_BUDGET_RESERVE_DECISION_SCHEMA,
  canonicalWorkflowBudgetAuthorityJson,
  hashWorkflowBudgetAuthorityValue,
  parseWorkflowBudgetAuthorityBytes,
  workflowBudgetAuthorityChargeNanoUsd,
  validateWorkflowBudgetPreparedRequest,
  validateWorkflowBudgetReceipt,
  validateWorkflowBudgetReceiptResult,
  validateWorkflowBudgetReserveRequest,
  validateWorkflowBudgetSettlementRequest,
  type WorkflowBudgetLedgerEntry,
  type WorkflowBudgetPreparedRequest,
  type WorkflowBudgetReceipt,
  type WorkflowBudgetReserveDecision,
  type WorkflowBudgetReserveRequest,
  type WorkflowBudgetSettlementRequest,
} from './workflow-budget-authority-contract.js';
import {
  WorkflowCheckpointContractError,
  validateWorkflowCheckpointShadowEnvelope,
  type WorkflowCheckpointShadowEnvelope,
} from './workflow-checkpoint-shadow-contract.js';
import {
  canonicalUtcTimestamp,
  closedDataRecord,
  immutableContractValue,
  ownDataField,
  type ContractDataRecord,
} from './internal/contract-validation.js';
import {
  observeWorkflowRunnerAuthorityBindingEncoding,
  observeWorkflowRunnerAuthorityBindingValidation,
} from './internal/workflow-runner-authority-binding-instrumentation.js';
import { parseWorkflowEffectJson, WorkflowEffectJsonError } from './workflow-effect-json.js';

export const WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION =
  'openslack.workflow_runner_authority_binding.v1' as const;
export const WORKFLOW_RUNNER_AUTHORITY_BINDING_STAGE_SCHEMA =
  'openslack.workflow_runner_authority_binding_stage.v1' as const;
export const WORKFLOW_RUNNER_AUTHORITY_BINDING_RESOLUTION_SCHEMA =
  'openslack.workflow_runner_authority_binding_resolution.v1' as const;
export const WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA =
  'openslack.workflow_runner_authority_binding_receipt.v1' as const;
export const WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_SCHEMA =
  'openslack.workflow_runner_authority_binding_error.v1' as const;
export const WORKFLOW_RUNNER_AUTHORITY_BINDING_PREPARED_SCHEMA =
  'openslack.workflow_runner_authority_binding_prepared.v1' as const;
export const WORKFLOW_RUNNER_BUDGET_SOURCE_RESULT_SCHEMA =
  'openslack.workflow_runner_budget_source_result.v1' as const;
export const WORKFLOW_RUNNER_BUDGET_DURABLE_RECEIPT_SCHEMA =
  'openslack.workflow_control_budget_durable_record.v1' as const;
export const WORKFLOW_RUNNER_AUTHORITY_BINDING_IDEMPOTENCY_PREFIX =
  'openslack.workflow-runner-authority-binding.v1.' as const;
export const WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE =
  'workflow-control-runner-v2-runtime-delivery-v1' as const;

export const WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS = Object.freeze([
  'checkpoint_commit',
  'effect_authorize',
  'effect_complete',
  'budget_reserve',
  'budget_settle',
  'resume_advance',
] as const);
export type WorkflowRunnerAuthorityBindingOperation =
  (typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS)[number];

export type WorkflowRunnerAuthorityReceiptHashAlgorithm =
  | 'binding_receipt_domain_sha256'
  | 'canonical_durable_receipt_sha256'
  | null;

export type WorkflowRunnerAuthorityCompletionControlKind =
  | 'event_receipt'
  | 'budget_authorization'
  | 'effect_authorization'
  | 'resume_offer';

export interface WorkflowRunnerAuthorityBindingOperationFact {
  readonly targetKind: WorkflowControlAuthorityMessageKind;
  readonly completionControlKind: WorkflowRunnerAuthorityCompletionControlKind;
  readonly runnerDelta: Readonly<{ revision: number; generation: number }>;
  readonly sourcePlane:
    | 'checkpoint_control'
    | 'effect_v2_sibling'
    | 'budget_account'
    | 'resume_control';
  readonly sourceEvidenceState: 'prepared' | 'committed';
  readonly sourceRevisionDelta: number;
  readonly sourceGenerationDelta: number;
  readonly sourceReceiptSchema: string | null;
  readonly authorityReceiptHashAlgorithm: WorkflowRunnerAuthorityReceiptHashAlgorithm;
}

export const WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS = immutableContractValue({
  checkpoint_commit: {
    targetKind: 'checkpoint_commit',
    completionControlKind: 'event_receipt',
    runnerDelta: { revision: 1, generation: 0 },
    sourcePlane: 'checkpoint_control',
    sourceEvidenceState: 'committed',
    sourceRevisionDelta: 1,
    sourceGenerationDelta: 0,
    sourceReceiptSchema: 'openslack.workflow_runner_checkpoint_authority_receipt.v1',
    authorityReceiptHashAlgorithm: null,
  },
  effect_authorize: {
    targetKind: 'effect_intent',
    completionControlKind: 'effect_authorization',
    runnerDelta: { revision: 1, generation: 0 },
    sourcePlane: 'effect_v2_sibling',
    sourceEvidenceState: 'committed',
    sourceRevisionDelta: 1,
    sourceGenerationDelta: 0,
    sourceReceiptSchema: 'openslack.workflow_runner_effect_authority_receipt.v1',
    authorityReceiptHashAlgorithm: 'binding_receipt_domain_sha256',
  },
  effect_complete: {
    targetKind: 'effect_outcome',
    completionControlKind: 'event_receipt',
    runnerDelta: { revision: 0, generation: 0 },
    sourcePlane: 'effect_v2_sibling',
    sourceEvidenceState: 'committed',
    sourceRevisionDelta: 1,
    sourceGenerationDelta: 0,
    sourceReceiptSchema: 'openslack.workflow_runner_effect_completion_receipt.v1',
    authorityReceiptHashAlgorithm: null,
  },
  budget_reserve: {
    targetKind: 'budget_reserve_request',
    completionControlKind: 'budget_authorization',
    runnerDelta: { revision: 1, generation: 0 },
    sourcePlane: 'budget_account',
    sourceEvidenceState: 'prepared',
    sourceRevisionDelta: 0,
    sourceGenerationDelta: 0,
    sourceReceiptSchema: null,
    authorityReceiptHashAlgorithm: 'canonical_durable_receipt_sha256',
  },
  budget_settle: {
    targetKind: 'budget_usage_report',
    completionControlKind: 'event_receipt',
    runnerDelta: { revision: 1, generation: 0 },
    sourcePlane: 'budget_account',
    sourceEvidenceState: 'prepared',
    sourceRevisionDelta: 0,
    sourceGenerationDelta: 0,
    sourceReceiptSchema: null,
    authorityReceiptHashAlgorithm: null,
  },
  resume_advance: {
    targetKind: 'lease_accept',
    completionControlKind: 'resume_offer',
    runnerDelta: { revision: 1, generation: 1 },
    sourcePlane: 'resume_control',
    sourceEvidenceState: 'committed',
    sourceRevisionDelta: 1,
    sourceGenerationDelta: 1,
    sourceReceiptSchema: 'openslack.workflow_runner_resume_authority_receipt.v1',
    authorityReceiptHashAlgorithm: 'binding_receipt_domain_sha256',
  },
} as const satisfies Record<
  WorkflowRunnerAuthorityBindingOperation,
  WorkflowRunnerAuthorityBindingOperationFact
>);

export const WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_RECEIPT_SCHEMAS = Object.freeze(
  Object.fromEntries(
    WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS.map((operation) => [
      operation,
      WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].sourceReceiptSchema,
    ]),
  ),
) as Readonly<Record<WorkflowRunnerAuthorityBindingOperation, string | null>>;

export const WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES = Object.freeze([
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_UNKNOWN_FIELD',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_HASH_MISMATCH',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_SEQUENCE_CONFLICT',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_REVISION_CONFLICT',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_RESUME_GENERATION_CONFLICT',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_STAGE_REQUIRED',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_FORBIDDEN_FIELD',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_RECONCILIATION_REQUIRED',
] as const);
export type WorkflowRunnerAuthorityBindingErrorCode =
  (typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES)[number];

export const WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS = Object.freeze({
  maxFrameBytes: 1_048_576,
  maxReceiptBytes: 65_536,
  maxErrorBytes: 16_384,
  maxEvidenceBytes: 786_432,
  maxDepth: 16,
  maxNodes: 8_192,
  maxStringBytes: 524_288,
  maxSafeInteger: 9_007_199_254_740_991,
  maxRateDecimalBytes: 64,
  maxRateFractionDigits: 18,
} as const);

export const WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS = Object.freeze({
  runnerV1Manifest: '908ff368f35033206b975a0421396f49e588098f040aecef2fdd18cd8b67ece6',
  authorityV2Manifest: '7994937f8b66c67ba4c90ce9018fcbde095ad34e6f377b3cd09959bb5c53d2ba',
  checkpointManifest: 'e6b4edefc887f17a83237471e168f4c0819b7848ad6a63d2446fc572bdcff000',
  effectControlManifest: '76929e860fc42573e87dfe09f106d15f4913b2da3da5f96e4a8c1d58d095d1c2',
  effectShadowManifest: '58208d1618b6a629e821dbb10d214a9a57eaf6b3771a1b61e1d2198c4038354a',
  budgetManifest: '83e5f88e01cbeb5e301004c34ed7cad446b98a59812771a9bf3be562a0509b3b',
  migration7Up: 'bc09194c0b9ec2d5880a17f71327d99cf5481d88d6dc0d737be099af7a8fd722',
  migration7Down: '251b99eb5e088a468ff524d81e59a98ab57543f2b917331b5ea1c239900947d7',
} as const);

export class WorkflowRunnerAuthorityBindingContractError extends TypeError {
  constructor(
    readonly code: WorkflowRunnerAuthorityBindingErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowRunnerAuthorityBindingContractError';
  }
}

export interface WorkflowRunnerAuthorityRouteBinding {
  readonly backend: 'ts-local' | 'go';
  readonly authority: 'typescript' | 'workflow-control';
  readonly routingEpoch: number;
  readonly authorityBuildHash: string;
}

export interface WorkflowRunnerAuthorityRunnerHead {
  readonly expectedGlobalRunRevision: number;
  readonly acceptedGlobalRunRevision: number;
  readonly expectedResumeGeneration: number;
  readonly acceptedResumeGeneration: number;
}

export interface WorkflowRunnerAuthorityTarget {
  readonly schema: typeof WORKFLOW_CONTROL_AUTHORITY_PREPARED_SCHEMA;
  readonly eventId: string;
  readonly kind: WorkflowControlAuthorityMessageKind;
  readonly sequence: number;
  readonly body: string;
  readonly messageDigest: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface WorkflowRunnerAuthorityBindingStage {
  readonly schema: typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_STAGE_SCHEMA;
  readonly contractVersion: typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION;
  readonly profile: typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE;
  readonly phase: 'stage_event';
  readonly direction: 'runner-to-control';
  readonly companionSequence: 1;
  readonly bindingId: string;
  readonly operation: WorkflowRunnerAuthorityBindingOperation;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly runnerAttemptId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly route: WorkflowRunnerAuthorityRouteBinding;
  readonly runnerAuthority: WorkflowRunnerAuthorityRunnerHead;
  readonly target: WorkflowRunnerAuthorityTarget;
  readonly correlationId: string;
  readonly sentAt: string;
}

export interface WorkflowRunnerSourceAuthority {
  readonly plane: 'checkpoint_control' | 'effect_v2_sibling' | 'budget_account' | 'resume_control';
  readonly evidenceState: 'prepared' | 'committed';
  readonly expectedRevision: number;
  readonly acceptedRevision: number | null;
  readonly expectedResumeGeneration: number;
  readonly acceptedResumeGeneration: number;
  readonly requestHash: string;
  readonly receiptSchema: string | null;
  readonly receiptHash: string | null;
  readonly recordHash: string | null;
  readonly authorityBuildHash: string;
}

export interface WorkflowRunnerCheckpointAuthorityEvidence {
  readonly schema: 'openslack.workflow_runner_checkpoint_authority_evidence.v1';
  readonly sourceAuthority: WorkflowRunnerSourceAuthority;
  readonly envelope: WorkflowCheckpointShadowEnvelope;
  readonly envelopeHash: string;
}

export interface WorkflowRunnerEffectAuthorityEvidence {
  readonly schema: 'openslack.workflow_runner_effect_authority_evidence.v1';
  readonly sourceAuthority: WorkflowRunnerSourceAuthority;
  readonly occurrenceId: string;
  readonly intentBindingHash: string;
  readonly effectId: string;
  readonly effectHash: string;
  readonly capabilityHash: string;
  readonly approvalId: string;
  readonly approvalStatus: 'approved' | 'rejected' | 'expired';
  readonly approvalRecordHash: string | null;
  readonly approvalDecisionHash: string | null;
  readonly decisionRevision: number;
  readonly humanBindingHash: string | null;
  readonly attestationHash: string | null;
  readonly executionId: string | null;
  readonly claimHash: string | null;
  readonly grantHash: string | null;
  readonly expiresAt: string;
}

export interface WorkflowRunnerEffectCompletionEvidence {
  readonly schema: 'openslack.workflow_runner_effect_completion_evidence.v1';
  readonly sourceAuthority: WorkflowRunnerSourceAuthority;
  readonly occurrenceId: string;
  readonly effectId: string;
  readonly effectHash: string;
  readonly executionId: string;
  readonly claimHash: string;
  readonly status: 'executed' | 'failed' | 'reconciliation_required';
  readonly outcomeHash: string;
  readonly reconciliationToken: string | null;
}

export interface WorkflowRunnerBudgetAuthorityEvidence {
  readonly schema: 'openslack.workflow_runner_budget_authority_evidence.v1';
  readonly sourceAuthority: WorkflowRunnerSourceAuthority;
  readonly preparedRequest: WorkflowBudgetPreparedRequest;
  readonly providerHash: string;
  readonly modelHash: string;
  readonly providerRunHash: string;
  readonly providerAttempt: string;
  readonly accountId: string;
  readonly policyHash: string;
  readonly rateNanoUsdPerToken: string;
  readonly providerUsageReceiptHash: string | null;
}

export interface WorkflowRunnerResumeAuthorityEvidence {
  readonly schema: 'openslack.workflow_runner_resume_authority_evidence.v1';
  readonly sourceAuthority: WorkflowRunnerSourceAuthority;
  readonly envelope: WorkflowCheckpointShadowEnvelope;
  readonly envelopeHash: string;
  readonly priorCheckpointId: string | null;
  readonly priorCheckpointHash: string | null;
  readonly nextPhaseId: string;
  readonly nextPhaseIndex: number;
  readonly logicalResumeAttemptId: string;
  readonly expiresAt: string;
}

export type WorkflowRunnerAuthorityEvidence =
  | WorkflowRunnerCheckpointAuthorityEvidence
  | WorkflowRunnerEffectAuthorityEvidence
  | WorkflowRunnerEffectCompletionEvidence
  | WorkflowRunnerBudgetAuthorityEvidence
  | WorkflowRunnerResumeAuthorityEvidence;

export interface WorkflowRunnerAuthorityBindingResolution {
  readonly schema: typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_RESOLUTION_SCHEMA;
  readonly contractVersion: typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION;
  readonly profile: typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE;
  readonly phase: 'commit_authority';
  readonly direction: 'runner-to-control';
  readonly companionSequence: 2;
  readonly bindingId: string;
  readonly operation: WorkflowRunnerAuthorityBindingOperation;
  readonly stageHash: string;
  readonly stageReceiptHash: string;
  readonly targetBodyHash: string;
  readonly evidence: WorkflowRunnerAuthorityEvidence;
  readonly evidenceHash: string;
  readonly sentAt: string;
}

interface WorkflowRunnerAuthorityReceiptBase {
  readonly schema: typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA;
  readonly contractVersion: typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION;
  readonly profile: typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE;
  readonly bindingId: string;
  readonly operation: WorkflowRunnerAuthorityBindingOperation;
  readonly status: 'accepted' | 'reconciliation_required';
  readonly controlBuildHash: string;
  readonly committedAt: string | null;
  readonly reconciliationToken: string | null;
}

export interface WorkflowRunnerAuthorityStageReceipt extends WorkflowRunnerAuthorityReceiptBase {
  readonly direction: 'control-to-runner';
  readonly phase: 'stage_event';
  readonly companionSequence: 1;
  readonly requestHash: string;
  readonly targetEventId: string;
  readonly targetBodyHash: string;
  readonly evidenceHash: null;
}

export interface WorkflowRunnerAuthorityResolutionReceipt extends WorkflowRunnerAuthorityReceiptBase {
  readonly direction: 'control-to-runner';
  readonly phase: 'commit_authority';
  readonly companionSequence: 2;
  readonly requestHash: string;
  readonly targetEventId: string;
  readonly targetBodyHash: string;
  readonly stageHash: string;
  readonly stageReceiptHash: string;
  readonly evidenceHash: string;
}

export type WorkflowRunnerAuthorityPhaseReceipt =
  | WorkflowRunnerAuthorityStageReceipt
  | WorkflowRunnerAuthorityResolutionReceipt;

export interface WorkflowRunnerAuthorityControlDeliveryReceipt extends WorkflowRunnerAuthorityReceiptBase {
  readonly direction: 'runner-to-control';
  readonly phase: 'control_delivery';
  readonly companionSequence: number;
  readonly controlEventId: string;
  readonly controlKind:
    | 'event_receipt'
    | 'budget_authorization'
    | 'effect_authorization'
    | 'resume_offer'
    | 'cancel_request';
  readonly controlSequence: number;
  readonly messageDigest: string;
  readonly runnerAttemptId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly processedAt: string;
  /** Delivery is durable even when local processing intentionally latches reconciliation. */
  readonly disposition: 'accepted' | 'reconciliation_required';
}

export interface WorkflowRunnerAuthorityPriorEventDelivery {
  readonly message: WorkflowControlAuthorityMessage;
  readonly receipt: WorkflowRunnerAuthorityControlDeliveryReceipt;
}

export interface WorkflowRunnerAuthorityControlDeliveryValidationContext {
  readonly stage: unknown;
  readonly resolution: unknown;
  readonly resolutionReceipt: unknown;
  readonly stageReceipt: unknown;
  readonly priorEventDelivery: unknown;
  readonly budgetSourceResult?: unknown;
}

/**
 * Post-event E1 authority result required before a budget decision may be
 * delivered. Database-unknown receipts are intentionally excluded because
 * they do not prove an accepted run revision and therefore cannot produce a
 * truthful `budget_authorization` control message.
 */
export interface WorkflowRunnerBudgetSourceResult {
  readonly schema: typeof WORKFLOW_RUNNER_BUDGET_SOURCE_RESULT_SCHEMA;
  readonly durableReceiptBytes: string;
  readonly decision: WorkflowBudgetReserveDecision;
  readonly ledgerEntry: WorkflowBudgetLedgerEntry;
}

export interface WorkflowRunnerBudgetDurableReceipt {
  readonly schema: typeof WORKFLOW_RUNNER_BUDGET_DURABLE_RECEIPT_SCHEMA;
  readonly authority: 'workflow-control';
  readonly writer: 'workflow-control/budget-authority-server';
  readonly authorityMode: 'local-qualification-v1';
  readonly productionAuthority: false;
  readonly contractManifestSha256: string;
  readonly authorityBuildHash: string;
  readonly recordKind: 'receipt';
  readonly operationalProjection: WorkflowBudgetReceipt;
  readonly operationalProjectionHash: string;
}

interface ValidatedBudgetPreparedRequest {
  readonly prepared: WorkflowBudgetPreparedRequest;
  readonly request: WorkflowBudgetReserveRequest | WorkflowBudgetSettlementRequest;
}

interface ValidatedBudgetDurableReceipt {
  readonly value: WorkflowRunnerBudgetDurableReceipt;
  readonly bytes: Buffer;
  readonly receiptHash: string;
}

interface ValidatedBudgetSourceResult {
  readonly value: WorkflowRunnerBudgetSourceResult;
  readonly durable: ValidatedBudgetDurableReceipt;
  readonly sourceReceipt: WorkflowBudgetReceipt;
  readonly request: WorkflowBudgetReserveRequest;
}

interface BindingValidationSession {
  readonly budgetPreparedByRequestHash: Map<string, ValidatedBudgetPreparedRequest>;
}

function newBindingValidationSession(): BindingValidationSession {
  return { budgetPreparedByRequestHash: new Map() };
}

export type WorkflowRunnerAuthorityBindingReceipt =
  | WorkflowRunnerAuthorityPhaseReceipt
  | WorkflowRunnerAuthorityControlDeliveryReceipt;

export interface WorkflowRunnerAuthorityBindingError {
  readonly schema: typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_SCHEMA;
  readonly code: WorkflowRunnerAuthorityBindingErrorCode;
  readonly message: string;
  readonly bindingId: string | null;
  readonly operation: WorkflowRunnerAuthorityBindingOperation | null;
  readonly reconciliationToken: string | null;
}

export interface WorkflowRunnerAuthorityBindingPrepared<T> {
  readonly schema: typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_PREPARED_SCHEMA;
  readonly body: string;
  readonly bodyHash: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly value: T;
}

const HASH = /^[0-9a-f]{64}$/u;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/u;
const RATE = /^(?:0|[1-9][0-9]*|(?:0|[1-9][0-9]*)\.([0-9]*[1-9]))$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const FORBIDDEN_KEYS = new Set([
  'provider',
  'prompt',
  'rawPrompt',
  'model',
  'response',
  'rawResponse',
  'result',
  'nonce',
  'detail',
  'credential',
  'credentials',
  'bearer',
  'bearerToken',
  'endpoint',
  'baseUrl',
  'attestationNonce',
  'providerId',
  'modelId',
]);

function fail(code: WorkflowRunnerAuthorityBindingErrorCode, path: string, message: string): never {
  throw new WorkflowRunnerAuthorityBindingContractError(code, path, message);
}

function nestedContractPath(prefix: string, path: string): string {
  if (path === '$') return prefix;
  return path.startsWith('$/') ? `${prefix}${path.slice(1)}` : prefix;
}

function validateCheckpointEnvelopeForBinding(
  value: unknown,
  path: string,
): WorkflowCheckpointShadowEnvelope {
  try {
    return validateWorkflowCheckpointShadowEnvelope(value);
  } catch (error) {
    if (error instanceof WorkflowCheckpointContractError) {
      fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
        nestedContractPath(path, error.path),
        'Embedded checkpoint evidence is invalid.',
      );
    }
    throw error;
  }
}

function validateBudgetContractForBinding<T>(path: string, validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof WorkflowBudgetAuthorityContractError) {
      fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
        nestedContractPath(path, error.path),
        'Embedded budget evidence is invalid.',
      );
    }
    throw error;
  }
}

function validateAuthorityContractForBinding<T>(path: string, validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof WorkflowControlAuthorityContractError) {
      if (error.code === 'WORKFLOW_CONTROL_AUTHORITY_IDENTITY_MISMATCH') {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
          path,
          'Authority route is inconsistent.',
        );
      }
      fail(
        error.code === 'WORKFLOW_CONTROL_AUTHORITY_UNKNOWN_FIELD'
          ? 'WORKFLOW_RUNNER_AUTHORITY_BINDING_UNKNOWN_FIELD'
          : error.code === 'WORKFLOW_CONTROL_AUTHORITY_LIMIT_EXCEEDED'
            ? 'WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED'
            : 'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
        nestedContractPath(path, error.path),
        'Embedded authority route is invalid.',
      );
    }
    throw error;
  }
}

function inertRecord(
  value: unknown,
  fields: readonly string[],
  path: string,
): Record<string, unknown> {
  return closedDataRecord(
    value,
    fields,
    path,
    {
      inert: (target) =>
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
          target,
          `${target} must be an inert object.`,
        ),
      missing: (target, field) =>
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_UNKNOWN_FIELD',
          `${target}/${field}`,
          'A required field is missing.',
        ),
      unknown: (target, key) =>
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_UNKNOWN_FIELD',
          `${target}/${String(key)}`,
          `${target} contains an unknown field.`,
        ),
      dataField: (target, key) =>
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
          `${target}/${String(key)}`,
          'Accessors are forbidden.',
        ),
    },
    { keyOrder: 'utf16' },
  );
}

function own(record: Record<string, unknown>, key: string): unknown {
  return ownDataField(record as ContractDataRecord, key);
}

function text(value: unknown, path: string, pattern: RegExp, maxBytes = 512): string {
  if (
    typeof value !== 'string' ||
    !pattern.test(value) ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    fail('WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID', path, `${path} is invalid.`);
  }
  return value;
}

function id(value: unknown, path: string): string {
  return text(value, path, SAFE_ID, 256);
}

function ref(value: unknown, path: string): string {
  return text(value, path, SAFE_REF, 512);
}

function hash(value: unknown, path: string): string {
  return text(value, path, HASH, 64);
}

function prefixedHash(value: unknown, path: string): string {
  return text(value, path, FINGERPRINT, 71);
}

function rate(value: unknown, path: string): string {
  const result = text(
    value,
    path,
    RATE,
    WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxRateDecimalBytes,
  );
  const fraction = result.split('.')[1] ?? '';
  if (fraction.length > WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxRateFractionDigits) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED',
      path,
      `${path} has too many fractional digits.`,
    );
  }
  return result;
}

function timestamp(value: unknown, path: string): string {
  return canonicalUtcTimestamp(
    value,
    path,
    (entry, target) => text(entry, target, TIMESTAMP, 24),
    (target) =>
      fail('WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID', target, `${target} is not canonical UTC.`),
  );
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxSafeInteger
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
      path,
      `${path} is not a bounded safe integer.`,
    );
  }
  return value as number;
}

function literal<T extends string | number>(value: unknown, expected: T, path: string): T {
  if (value !== expected) {
    fail('WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID', path, `${path} is invalid.`);
  }
  return expected;
}

function oneOf<T extends readonly string[]>(value: unknown, options: T, path: string): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) {
    fail('WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID', path, `${path} is invalid.`);
  }
  return value as T[number];
}

function nullable<T>(value: unknown, validate: (entry: unknown) => T): T | null {
  return value === null ? null : validate(value);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseStrictBindingJson(
  bytes: Buffer,
  path: string,
  invalidMessage: string,
  limitMessage: string,
): unknown {
  try {
    return parseWorkflowEffectJson(bytes, {
      maxDepth: WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxDepth,
      maxNodes: WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxNodes,
      maxStringLength: WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxStringBytes,
      maxStringBytes: WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxStringBytes,
      unicodeScalarsOnly: true,
      canonicalSafeIntegersOnly: true,
    });
  } catch (error) {
    if (error instanceof WorkflowEffectJsonError) {
      fail(
        error.code === 'WORKFLOW_EFFECT_JSON_LIMIT_EXCEEDED'
          ? 'WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED'
          : 'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
        path,
        error.code === 'WORKFLOW_EFFECT_JSON_LIMIT_EXCEEDED' ? limitMessage : invalidMessage,
      );
    }
    throw error;
  }
}

function parseBudgetDurableReceipt(value: unknown): ValidatedBudgetDurableReceipt {
  if (typeof value !== 'string') {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED',
      '$/budgetSourceResult/durableReceiptBytes',
      'Durable budget receipt bytes exceed their limit.',
    );
  }
  const bytes = Buffer.from(value, 'utf8');
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxStringBytes
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED',
      '$/budgetSourceResult/durableReceiptBytes',
      'Durable budget receipt bytes exceed their limit.',
    );
  }
  observeWorkflowRunnerAuthorityBindingValidation('budget_durable_parse');
  const parsed = parseStrictBindingJson(
    bytes,
    '$/budgetSourceResult/durableReceiptBytes',
    'Durable budget receipt bytes are not strict JSON.',
    'Durable budget receipt bytes are not strict JSON.',
  );
  const durableReceipt = validateWorkflowRunnerBudgetDurableReceipt(parsed);
  if (canonicalWorkflowBudgetAuthorityJson(durableReceipt) !== value) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
      '$/budgetSourceResult/durableReceiptBytes',
      'Durable budget receipt bytes are not exact canonical bytes.',
    );
  }
  return { value: durableReceipt, bytes, receiptHash: sha256(bytes) };
}

export function parseWorkflowRunnerBudgetDurableReceiptBytes(
  value: unknown,
): WorkflowRunnerBudgetDurableReceipt {
  return parseBudgetDurableReceipt(value).value;
}

export function hashWorkflowRunnerBudgetSourceReceipt(value: unknown): string {
  return parseBudgetDurableReceipt(value).receiptHash;
}

type WorkflowRunnerAuthorityBindingHashDomain = 'stage' | 'evidence' | 'resolution' | 'receipt';

const canonicalBindingValueCache = new WeakMap<object, string>();

function canonicalBindingValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const cached = canonicalBindingValueCache.get(value);
    if (cached !== undefined) return cached;
    observeWorkflowRunnerAuthorityBindingEncoding(value);
    const canonical = canonicalWorkflowControlAuthorityJson(value);
    canonicalBindingValueCache.set(value, canonical);
    return canonical;
  }
  return canonicalWorkflowControlAuthorityJson(value);
}

function hashValidatedBindingValue(
  domain: WorkflowRunnerAuthorityBindingHashDomain,
  value: unknown,
): string {
  return sha256(
    `openslack.workflow-runner-authority-binding.${domain}.v1\0${canonicalBindingValue(value)}`,
  );
}

function immutable<T>(value: T): T {
  return immutableContractValue(value);
}

function byteBound(value: unknown, limit: number, path: string): void {
  if (Buffer.byteLength(canonicalBindingValue(value), 'utf8') > limit) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED',
      path,
      `${path} exceeds its byte limit.`,
    );
  }
}

function framedByteBound(value: unknown, limit: number, path: string): void {
  if (Buffer.byteLength(canonicalBindingValue(value), 'utf8') + 1 > limit) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED',
      path,
      `${path} exceeds its byte limit.`,
    );
  }
}

function assertNoForbiddenKeys(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${path}/${index}`));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const key of Object.keys(value).sort()) {
    const entry = own(value as Record<string, unknown>, key);
    if (FORBIDDEN_KEYS.has(key)) {
      fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_FORBIDDEN_FIELD',
        `${path}/${key}`,
        'Raw provider, prompt, result, nonce, endpoint, token, or credential fields are forbidden.',
      );
    }
    assertNoForbiddenKeys(entry, `${path}/${key}`);
  }
}

export function workflowRunnerAuthorityBindingExpectedKind(
  operation: WorkflowRunnerAuthorityBindingOperation,
): WorkflowControlAuthorityMessageKind {
  return WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].targetKind;
}

export function workflowRunnerAuthorityBindingCompletionControlKind(
  operation: WorkflowRunnerAuthorityBindingOperation,
): WorkflowRunnerAuthorityCompletionControlKind {
  return WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].completionControlKind;
}

const WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_BY_KIND = immutableContractValue(
  Object.fromEntries(
    WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS.map((operation) => [
      WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].targetKind,
      operation,
    ]),
  ) as Partial<
    Record<WorkflowControlAuthorityMessageKind, WorkflowRunnerAuthorityBindingOperation>
  >,
);

export function workflowRunnerAuthorityBindingOperationForKind(
  kind: WorkflowControlAuthorityMessageKind,
): WorkflowRunnerAuthorityBindingOperation | undefined {
  return WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_BY_KIND[kind];
}

export function workflowRunnerAuthorityBindingRunnerDelta(
  operation: WorkflowRunnerAuthorityBindingOperation,
): Readonly<{ revision: number; generation: number }> {
  return WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].runnerDelta;
}

function validateRoute(value: unknown, path: string): WorkflowRunnerAuthorityRouteBinding {
  const route = validateAuthorityContractForBinding(path, () =>
    validateWorkflowControlAuthorityRoute(value, '$'),
  );
  return immutable({
    backend: route.backend,
    authority: route.authority,
    routingEpoch: route.routingEpoch,
    authorityBuildHash: route.authorityBuildHash,
  });
}

function validateRunnerHead(
  value: unknown,
  operation: WorkflowRunnerAuthorityBindingOperation,
  path: string,
): WorkflowRunnerAuthorityRunnerHead {
  const record = inertRecord(
    value,
    [
      'expectedGlobalRunRevision',
      'acceptedGlobalRunRevision',
      'expectedResumeGeneration',
      'acceptedResumeGeneration',
    ],
    path,
  );
  const expectedGlobalRunRevision = integer(
    own(record, 'expectedGlobalRunRevision'),
    `${path}/expectedGlobalRunRevision`,
    1,
  );
  const acceptedGlobalRunRevision = integer(
    own(record, 'acceptedGlobalRunRevision'),
    `${path}/acceptedGlobalRunRevision`,
    1,
  );
  const expectedResumeGeneration = integer(
    own(record, 'expectedResumeGeneration'),
    `${path}/expectedResumeGeneration`,
  );
  const acceptedResumeGeneration = integer(
    own(record, 'acceptedResumeGeneration'),
    `${path}/acceptedResumeGeneration`,
  );
  const delta = WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].runnerDelta;
  if (acceptedGlobalRunRevision !== expectedGlobalRunRevision + delta.revision) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_REVISION_CONFLICT',
      `${path}/acceptedGlobalRunRevision`,
      'Coordinator run revision delta is invalid.',
    );
  }
  if (acceptedResumeGeneration !== expectedResumeGeneration + delta.generation) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_RESUME_GENERATION_CONFLICT',
      `${path}/acceptedResumeGeneration`,
      'Coordinator resume-generation delta is invalid.',
    );
  }
  return immutable({
    expectedGlobalRunRevision,
    acceptedGlobalRunRevision,
    expectedResumeGeneration,
    acceptedResumeGeneration,
  });
}

function validateTarget(
  value: unknown,
  operation: WorkflowRunnerAuthorityBindingOperation,
  path: string,
): {
  readonly target: WorkflowRunnerAuthorityTarget;
  readonly message: WorkflowControlAuthorityMessage;
} {
  const record = inertRecord(
    value,
    [
      'schema',
      'eventId',
      'kind',
      'sequence',
      'body',
      'messageDigest',
      'idempotencyKey',
      'requestFingerprint',
    ],
    path,
  );
  const body = own(record, 'body');
  if (
    typeof body !== 'string' ||
    Buffer.byteLength(body, 'utf8') > 262_144 ||
    !body.endsWith('\n') ||
    body.endsWith('\n\n')
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
      `${path}/body`,
      'Target event body framing is invalid.',
    );
  }
  let message: WorkflowControlAuthorityMessage;
  try {
    message = parseWorkflowControlAuthorityMessageBytes(Buffer.from(body, 'utf8'));
  } catch (error) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
      `${path}/body`,
      `Target event body is invalid: ${error instanceof Error ? error.name : 'Error'}.`,
    );
  }
  const prepared = prepareWorkflowControlAuthorityMessage(message);
  if (
    prepared.body !== body ||
    prepared.messageDigest !== own(record, 'messageDigest') ||
    prepared.idempotencyKey !== own(record, 'idempotencyKey') ||
    prepared.requestFingerprint !== own(record, 'requestFingerprint')
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_HASH_MISMATCH',
      path,
      'Target prepared event binding drifted.',
    );
  }
  const expectedKind = WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].targetKind;
  if (message.kind !== expectedKind || own(record, 'kind') !== expectedKind) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      `${path}/kind`,
      'Target event kind does not match the binding operation.',
    );
  }
  if (
    message.eventId !== own(record, 'eventId') ||
    message.sequence !== own(record, 'sequence') ||
    message.sequence === null
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
      path,
      'Target event identity drifted.',
    );
  }
  return immutable({
    target: immutable({
      schema: literal(
        own(record, 'schema'),
        WORKFLOW_CONTROL_AUTHORITY_PREPARED_SCHEMA,
        `${path}/schema`,
      ),
      eventId: id(own(record, 'eventId'), `${path}/eventId`),
      kind: expectedKind,
      sequence: integer(own(record, 'sequence'), `${path}/sequence`, 1),
      body,
      messageDigest: hash(own(record, 'messageDigest'), `${path}/messageDigest`),
      idempotencyKey: text(
        own(record, 'idempotencyKey'),
        `${path}/idempotencyKey`,
        /^openslack\.workflow-control-authority\.v2\.[0-9a-f]{64}$/u,
        128,
      ),
      requestFingerprint: text(
        own(record, 'requestFingerprint'),
        `${path}/requestFingerprint`,
        FINGERPRINT,
        71,
      ),
    }),
    message,
  });
}

function stageIdentityPreimage(value: {
  operation: WorkflowRunnerAuthorityBindingOperation;
  workspaceId: string;
  jobId: string;
  runId: string;
  runnerAttemptId: string;
  leaseId: string;
  fencingToken: number;
  route: WorkflowRunnerAuthorityRouteBinding;
  runnerAuthority: WorkflowRunnerAuthorityRunnerHead;
  target: WorkflowRunnerAuthorityTarget;
}): Record<string, unknown> {
  return {
    schema: 'openslack.workflow_runner_authority_binding_identity.v1',
    operation: value.operation,
    workspaceId: value.workspaceId,
    jobId: value.jobId,
    runId: value.runId,
    runnerAttemptId: value.runnerAttemptId,
    leaseId: value.leaseId,
    fencingToken: value.fencingToken,
    route: value.route,
    runnerAuthority: value.runnerAuthority,
    targetBodyHash: value.target.messageDigest,
    targetEventId: value.target.eventId,
    targetIdempotencyKey: value.target.idempotencyKey,
    targetRequestFingerprint: value.target.requestFingerprint,
    targetSequence: value.target.sequence,
  };
}

export function deriveWorkflowRunnerAuthorityBindingId(
  value: Parameters<typeof stageIdentityPreimage>[0],
): string {
  return `WFRUNNER-BINDING-${sha256(
    `openslack.workflow-runner-authority-binding.identity.v1\0${canonicalWorkflowControlAuthorityJson(
      stageIdentityPreimage(value),
    )}`,
  )}`;
}

export function validateWorkflowRunnerAuthorityBindingStage(
  value: unknown,
): WorkflowRunnerAuthorityBindingStage {
  const fields = [
    'schema',
    'contractVersion',
    'profile',
    'phase',
    'direction',
    'companionSequence',
    'bindingId',
    'operation',
    'workspaceId',
    'jobId',
    'runId',
    'runnerAttemptId',
    'leaseId',
    'fencingToken',
    'route',
    'runnerAuthority',
    'target',
    'correlationId',
    'sentAt',
  ] as const;
  const record = inertRecord(value, fields, '$');
  const operation = oneOf(
    own(record, 'operation'),
    WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS,
    '$/operation',
  );
  const route = validateRoute(own(record, 'route'), '$/route');
  const runnerAuthority = validateRunnerHead(
    own(record, 'runnerAuthority'),
    operation,
    '$/runnerAuthority',
  );
  const { target, message } = validateTarget(own(record, 'target'), operation, '$/target');
  const workspaceId = id(own(record, 'workspaceId'), '$/workspaceId');
  const jobId = id(own(record, 'jobId'), '$/jobId');
  const runId = id(own(record, 'runId'), '$/runId');
  const runnerAttemptId = id(own(record, 'runnerAttemptId'), '$/runnerAttemptId');
  const leaseId = id(own(record, 'leaseId'), '$/leaseId');
  const fencingToken = integer(own(record, 'fencingToken'), '$/fencingToken', 1);
  if (
    message.workspaceId !== workspaceId ||
    message.jobId !== jobId ||
    message.workflowRunId !== runId ||
    message.attemptId !== runnerAttemptId ||
    message.leaseId !== leaseId ||
    message.fencingToken !== fencingToken ||
    message.authorityBackend !== route.backend ||
    message.authority !== route.authority ||
    message.routingEpoch !== route.routingEpoch ||
    message.authorityBuildHash !== route.authorityBuildHash ||
    message.runRevision !== runnerAuthority.expectedGlobalRunRevision ||
    message.resumeGeneration !== runnerAuthority.expectedResumeGeneration
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
      '$',
      'Stage identity does not match the exact future event.',
    );
  }
  const bindingId = id(own(record, 'bindingId'), '$/bindingId');
  const expectedBindingId = deriveWorkflowRunnerAuthorityBindingId({
    operation,
    workspaceId,
    jobId,
    runId,
    runnerAttemptId,
    leaseId,
    fencingToken,
    route,
    runnerAuthority,
    target,
  });
  if (bindingId !== expectedBindingId) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_HASH_MISMATCH',
      '$/bindingId',
      'Binding identity drifted.',
    );
  }
  const result = immutable({
    schema: literal(
      own(record, 'schema'),
      WORKFLOW_RUNNER_AUTHORITY_BINDING_STAGE_SCHEMA,
      '$/schema',
    ),
    contractVersion: literal(
      own(record, 'contractVersion'),
      WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
      '$/contractVersion',
    ),
    profile: literal(
      own(record, 'profile'),
      WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
      '$/profile',
    ),
    phase: literal(own(record, 'phase'), 'stage_event', '$/phase'),
    direction: literal(own(record, 'direction'), 'runner-to-control', '$/direction'),
    companionSequence: literal(own(record, 'companionSequence'), 1, '$/companionSequence'),
    bindingId,
    operation,
    workspaceId,
    jobId,
    runId,
    runnerAttemptId,
    leaseId,
    fencingToken,
    route,
    runnerAuthority,
    target,
    correlationId: id(own(record, 'correlationId'), '$/correlationId'),
    sentAt: timestamp(own(record, 'sentAt'), '$/sentAt'),
  } satisfies WorkflowRunnerAuthorityBindingStage);
  if (message.correlationId !== result.correlationId) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
      '$/correlationId',
      'Stage correlation differs from the target event.',
    );
  }
  framedByteBound(result, WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxFrameBytes, '$');
  return result;
}

function validateSourceAuthority(
  value: unknown,
  operation: WorkflowRunnerAuthorityBindingOperation,
  path: string,
): WorkflowRunnerSourceAuthority {
  const record = inertRecord(
    value,
    [
      'plane',
      'evidenceState',
      'expectedRevision',
      'acceptedRevision',
      'expectedResumeGeneration',
      'acceptedResumeGeneration',
      'requestHash',
      'receiptSchema',
      'receiptHash',
      'recordHash',
      'authorityBuildHash',
    ],
    path,
  );
  const fact = WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation];
  const plane = literal(own(record, 'plane'), fact.sourcePlane, `${path}/plane`);
  const expectedEvidenceState = fact.sourceEvidenceState;
  const evidenceState = literal(
    own(record, 'evidenceState'),
    expectedEvidenceState,
    `${path}/evidenceState`,
  );
  const expectedRevision = integer(own(record, 'expectedRevision'), `${path}/expectedRevision`);
  const acceptedRevision = nullable(own(record, 'acceptedRevision'), (entry) =>
    integer(entry, `${path}/acceptedRevision`, 1),
  );
  const expectedResumeGeneration = integer(
    own(record, 'expectedResumeGeneration'),
    `${path}/expectedResumeGeneration`,
  );
  const acceptedResumeGeneration = integer(
    own(record, 'acceptedResumeGeneration'),
    `${path}/acceptedResumeGeneration`,
  );
  const receiptSchema = nullable(own(record, 'receiptSchema'), (entry) =>
    ref(entry, `${path}/receiptSchema`),
  );
  const receiptHash = nullable(own(record, 'receiptHash'), (entry) =>
    hash(entry, `${path}/receiptHash`),
  );
  const recordHash = nullable(own(record, 'recordHash'), (entry) =>
    hash(entry, `${path}/recordHash`),
  );
  if (evidenceState === 'prepared') {
    if (
      acceptedRevision !== null ||
      receiptSchema !== null ||
      receiptHash !== null ||
      recordHash !== null ||
      acceptedResumeGeneration !== expectedResumeGeneration
    ) {
      fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
        path,
        'Prepared evidence cannot claim an authority mutation.',
      );
    }
  } else {
    if (
      acceptedRevision !== expectedRevision + fact.sourceRevisionDelta ||
      acceptedResumeGeneration !== expectedResumeGeneration + fact.sourceGenerationDelta ||
      receiptSchema === null ||
      receiptHash === null ||
      recordHash === null
    ) {
      fail(
        operation === 'resume_advance'
          ? 'WORKFLOW_RUNNER_AUTHORITY_BINDING_RESUME_GENERATION_CONFLICT'
          : 'WORKFLOW_RUNNER_AUTHORITY_BINDING_REVISION_CONFLICT',
        path,
        'Committed source-authority head is invalid.',
      );
    }
  }
  if (receiptSchema !== fact.sourceReceiptSchema) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      `${path}/receiptSchema`,
      'Source receipt schema is not the closed schema for this authority plane.',
    );
  }
  return immutable({
    plane,
    evidenceState,
    expectedRevision,
    acceptedRevision,
    expectedResumeGeneration,
    acceptedResumeGeneration,
    requestHash: hash(own(record, 'requestHash'), `${path}/requestHash`),
    receiptSchema,
    receiptHash,
    recordHash,
    authorityBuildHash: hash(own(record, 'authorityBuildHash'), `${path}/authorityBuildHash`),
  });
}

function checkpointEnvelopeHash(envelope: WorkflowCheckpointShadowEnvelope): string {
  return sha256(canonicalWorkflowControlAuthorityJson(envelope));
}

function validateCheckpointEvidence(
  value: unknown,
  operation: 'checkpoint_commit',
  path: string,
): WorkflowRunnerCheckpointAuthorityEvidence {
  const record = inertRecord(
    value,
    ['schema', 'sourceAuthority', 'envelope', 'envelopeHash'],
    path,
  );
  const envelope = validateCheckpointEnvelopeForBinding(
    own(record, 'envelope'),
    `${path}/envelope`,
  );
  const envelopeHash = hash(own(record, 'envelopeHash'), `${path}/envelopeHash`);
  if (
    envelope.operation !== 'checkpoint_commit' ||
    checkpointEnvelopeHash(envelope) !== envelopeHash
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_HASH_MISMATCH',
      `${path}/envelopeHash`,
      'Checkpoint envelope binding drifted.',
    );
  }
  const sourceAuthority = validateSourceAuthority(
    own(record, 'sourceAuthority'),
    operation,
    `${path}/sourceAuthority`,
  );
  if (
    sourceAuthority.acceptedRevision !== envelope.observation.revision ||
    sourceAuthority.acceptedResumeGeneration !== envelope.observation.resumeGeneration ||
    sourceAuthority.requestHash !== envelopeHash ||
    sourceAuthority.recordHash !== envelope.observationHash
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      path,
      'Checkpoint source receipt does not bind the exact envelope.',
    );
  }
  return immutable({
    schema: literal(
      own(record, 'schema'),
      'openslack.workflow_runner_checkpoint_authority_evidence.v1',
      `${path}/schema`,
    ),
    sourceAuthority,
    envelope,
    envelopeHash,
  });
}

function validateEffectEvidence(
  value: unknown,
  operation: 'effect_authorize',
  path: string,
): WorkflowRunnerEffectAuthorityEvidence {
  const record = inertRecord(
    value,
    [
      'schema',
      'sourceAuthority',
      'occurrenceId',
      'intentBindingHash',
      'effectId',
      'effectHash',
      'capabilityHash',
      'approvalId',
      'approvalStatus',
      'approvalRecordHash',
      'approvalDecisionHash',
      'decisionRevision',
      'humanBindingHash',
      'attestationHash',
      'executionId',
      'claimHash',
      'grantHash',
      'expiresAt',
    ],
    path,
  );
  const sourceAuthority = validateSourceAuthority(
    own(record, 'sourceAuthority'),
    operation,
    `${path}/sourceAuthority`,
  );
  const approvalStatus = oneOf(
    own(record, 'approvalStatus'),
    ['approved', 'rejected', 'expired'] as const,
    `${path}/approvalStatus`,
  );
  const approvalRecordHash = nullable(own(record, 'approvalRecordHash'), (entry) =>
    hash(entry, `${path}/approvalRecordHash`),
  );
  const approvalDecisionHash = nullable(own(record, 'approvalDecisionHash'), (entry) =>
    hash(entry, `${path}/approvalDecisionHash`),
  );
  const humanBindingHash = nullable(own(record, 'humanBindingHash'), (entry) =>
    hash(entry, `${path}/humanBindingHash`),
  );
  const attestationHash = nullable(own(record, 'attestationHash'), (entry) =>
    hash(entry, `${path}/attestationHash`),
  );
  const executionId = nullable(own(record, 'executionId'), (entry) =>
    id(entry, `${path}/executionId`),
  );
  const claimHash = nullable(own(record, 'claimHash'), (entry) => hash(entry, `${path}/claimHash`));
  const grantHash = nullable(own(record, 'grantHash'), (entry) => hash(entry, `${path}/grantHash`));
  const decisionRevision = integer(own(record, 'decisionRevision'), `${path}/decisionRevision`);
  const approved = approvalStatus === 'approved';
  const decided = approvalStatus !== 'expired';
  if (
    approved !==
      (executionId !== null &&
        claimHash !== null &&
        grantHash !== null &&
        claimHash === grantHash) ||
    decided !==
      (approvalRecordHash !== null &&
        approvalDecisionHash !== null &&
        humanBindingHash !== null &&
        attestationHash !== null) ||
    (approved && decisionRevision < 1) ||
    (!approved && (executionId !== null || claimHash !== null || grantHash !== null))
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      path,
      'Effect approval and one-time claim evidence are inconsistent.',
    );
  }
  return immutable({
    schema: literal(
      own(record, 'schema'),
      'openslack.workflow_runner_effect_authority_evidence.v1',
      `${path}/schema`,
    ),
    sourceAuthority,
    occurrenceId: id(own(record, 'occurrenceId'), `${path}/occurrenceId`),
    intentBindingHash: hash(own(record, 'intentBindingHash'), `${path}/intentBindingHash`),
    effectId: id(own(record, 'effectId'), `${path}/effectId`),
    effectHash: hash(own(record, 'effectHash'), `${path}/effectHash`),
    capabilityHash: hash(own(record, 'capabilityHash'), `${path}/capabilityHash`),
    approvalId: id(own(record, 'approvalId'), `${path}/approvalId`),
    approvalStatus,
    approvalRecordHash,
    approvalDecisionHash,
    decisionRevision,
    humanBindingHash,
    attestationHash,
    executionId,
    claimHash,
    grantHash,
    expiresAt: timestamp(own(record, 'expiresAt'), `${path}/expiresAt`),
  });
}

function validateEffectCompletionEvidence(
  value: unknown,
  operation: 'effect_complete',
  path: string,
): WorkflowRunnerEffectCompletionEvidence {
  const record = inertRecord(
    value,
    [
      'schema',
      'sourceAuthority',
      'occurrenceId',
      'effectId',
      'effectHash',
      'executionId',
      'claimHash',
      'status',
      'outcomeHash',
      'reconciliationToken',
    ],
    path,
  );
  const sourceAuthority = validateSourceAuthority(
    own(record, 'sourceAuthority'),
    operation,
    `${path}/sourceAuthority`,
  );
  const status = oneOf(
    own(record, 'status'),
    ['executed', 'failed', 'reconciliation_required'] as const,
    `${path}/status`,
  );
  const outcomeHash = hash(own(record, 'outcomeHash'), `${path}/outcomeHash`);
  const reconciliationToken = nullable(own(record, 'reconciliationToken'), (entry) =>
    ref(entry, `${path}/reconciliationToken`),
  );
  if (
    (status !== 'reconciliation_required' && reconciliationToken !== null) ||
    (status === 'reconciliation_required' && reconciliationToken === null)
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      path,
      'Effect completion state is invalid.',
    );
  }
  return immutable({
    schema: literal(
      own(record, 'schema'),
      'openslack.workflow_runner_effect_completion_evidence.v1',
      `${path}/schema`,
    ),
    sourceAuthority,
    occurrenceId: id(own(record, 'occurrenceId'), `${path}/occurrenceId`),
    effectId: id(own(record, 'effectId'), `${path}/effectId`),
    effectHash: hash(own(record, 'effectHash'), `${path}/effectHash`),
    executionId: id(own(record, 'executionId'), `${path}/executionId`),
    claimHash: hash(own(record, 'claimHash'), `${path}/claimHash`),
    status,
    outcomeHash,
    reconciliationToken,
  });
}

function parsedBudgetRequest(
  prepared: WorkflowBudgetPreparedRequest,
  path: string,
  session?: BindingValidationSession,
): WorkflowBudgetReserveRequest | WorkflowBudgetSettlementRequest {
  const cached = session?.budgetPreparedByRequestHash.get(prepared.requestHash);
  if (cached !== undefined) {
    if (
      cached.prepared.operation !== prepared.operation ||
      cached.prepared.body !== prepared.body
    ) {
      fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_HASH_MISMATCH',
        path,
        'Budget prepared request hash was reused for different exact bytes.',
      );
    }
    return cached.request;
  }
  observeWorkflowRunnerAuthorityBindingValidation('budget_prepared_parse');
  const request = validateBudgetContractForBinding(path, () => {
    const value = parseWorkflowBudgetAuthorityBytes(Buffer.from(prepared.body, 'utf8'));
    return prepared.operation === 'reserve'
      ? validateWorkflowBudgetReserveRequest(value)
      : validateWorkflowBudgetSettlementRequest(value);
  });
  session?.budgetPreparedByRequestHash.set(prepared.requestHash, { prepared, request });
  return request;
}

function validateBudgetEvidence(
  value: unknown,
  operation: 'budget_reserve' | 'budget_settle',
  path: string,
  session?: BindingValidationSession,
): WorkflowRunnerBudgetAuthorityEvidence {
  const record = inertRecord(
    value,
    [
      'schema',
      'sourceAuthority',
      'preparedRequest',
      'providerHash',
      'modelHash',
      'providerRunHash',
      'providerAttempt',
      'accountId',
      'policyHash',
      'rateNanoUsdPerToken',
      'providerUsageReceiptHash',
    ],
    path,
  );
  const sourceAuthority = validateSourceAuthority(
    own(record, 'sourceAuthority'),
    operation,
    `${path}/sourceAuthority`,
  );
  const preparedRequest = validateBudgetContractForBinding(`${path}/preparedRequest`, () =>
    validateWorkflowBudgetPreparedRequest(own(record, 'preparedRequest')),
  );
  const expectedOperation = operation === 'budget_reserve' ? 'reserve' : 'settle';
  if (preparedRequest.operation !== expectedOperation) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      `${path}/preparedRequest/operation`,
      'Budget prepared request operation drifted.',
    );
  }
  const request = parsedBudgetRequest(preparedRequest, `${path}/preparedRequest/body`, session);
  const providerUsageReceiptHash = nullable(own(record, 'providerUsageReceiptHash'), (entry) =>
    prefixedHash(entry, `${path}/providerUsageReceiptHash`),
  );
  const requestRecord = request as unknown as Record<string, unknown>;
  if (
    sourceAuthority.requestHash !== preparedRequest.requestHash ||
    own(record, 'accountId') !== request.accountId ||
    own(record, 'policyHash') !== request.policyHash ||
    own(record, 'providerAttempt') !== request.providerAttempt ||
    own(record, 'rateNanoUsdPerToken') !== request.rateNanoUsdPerToken ||
    own(record, 'providerHash') !== request.expectedProviderHash ||
    own(record, 'modelHash') !== request.expectedModelHash ||
    own(record, 'providerRunHash') !== request.expectedProviderRunHash ||
    (operation === 'budget_reserve' && providerUsageReceiptHash !== null) ||
    (operation === 'budget_settle' &&
      providerUsageReceiptHash !==
        ((requestRecord.providerUsage as Record<string, unknown> | null)?.receiptHash ??
          requestRecord.usageReceiptHash ??
          workflowRunnerAuthorityBindingMissingProviderUsageHash(preparedRequest.requestHash)))
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      path,
      'Budget runner identity differs from the exact E1 request.',
    );
  }
  return immutable({
    schema: literal(
      own(record, 'schema'),
      'openslack.workflow_runner_budget_authority_evidence.v1',
      `${path}/schema`,
    ),
    sourceAuthority,
    preparedRequest,
    providerHash: prefixedHash(own(record, 'providerHash'), `${path}/providerHash`),
    modelHash: prefixedHash(own(record, 'modelHash'), `${path}/modelHash`),
    providerRunHash: prefixedHash(own(record, 'providerRunHash'), `${path}/providerRunHash`),
    providerAttempt: text(
      own(record, 'providerAttempt'),
      `${path}/providerAttempt`,
      /^(?:[1-9][0-9]*)$/u,
      19,
    ),
    accountId: id(own(record, 'accountId'), `${path}/accountId`),
    policyHash: hash(own(record, 'policyHash'), `${path}/policyHash`),
    rateNanoUsdPerToken: rate(own(record, 'rateNanoUsdPerToken'), `${path}/rateNanoUsdPerToken`),
    providerUsageReceiptHash,
  });
}

export function validateWorkflowRunnerBudgetDurableReceipt(
  value: unknown,
): WorkflowRunnerBudgetDurableReceipt {
  const record = inertRecord(
    value,
    [
      'schema',
      'authority',
      'writer',
      'authorityMode',
      'productionAuthority',
      'contractManifestSha256',
      'authorityBuildHash',
      'recordKind',
      'operationalProjection',
      'operationalProjectionHash',
    ],
    '$/budgetSourceResult/durableReceipt',
  );
  const operationalProjection = validateBudgetContractForBinding(
    '$/budgetSourceResult/durableReceipt/operationalProjection',
    () => validateWorkflowBudgetReceipt(own(record, 'operationalProjection')),
  );
  const authorityBuildHash = hash(
    own(record, 'authorityBuildHash'),
    '$/budgetSourceResult/durableReceipt/authorityBuildHash',
  );
  if (
    own(record, 'productionAuthority') !== false ||
    authorityBuildHash !== operationalProjection.serviceBuildHash ||
    own(record, 'operationalProjectionHash') !==
      hashWorkflowBudgetAuthorityValue('receipt', operationalProjection)
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
      '$/budgetSourceResult/durableReceipt',
      'Durable budget receipt envelope does not bind its E1 projection.',
    );
  }
  return immutable({
    schema: literal(
      own(record, 'schema'),
      WORKFLOW_RUNNER_BUDGET_DURABLE_RECEIPT_SCHEMA,
      '$/budgetSourceResult/durableReceipt/schema',
    ),
    authority: literal(
      own(record, 'authority'),
      'workflow-control',
      '$/budgetSourceResult/durableReceipt/authority',
    ),
    writer: literal(
      own(record, 'writer'),
      'workflow-control/budget-authority-server',
      '$/budgetSourceResult/durableReceipt/writer',
    ),
    authorityMode: literal(
      own(record, 'authorityMode'),
      'local-qualification-v1',
      '$/budgetSourceResult/durableReceipt/authorityMode',
    ),
    productionAuthority: false as const,
    contractManifestSha256: oneOf(
      own(record, 'contractManifestSha256'),
      [
        WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS.budgetManifest,
        WORKFLOW_BUDGET_PREVIOUS_MANIFEST_SHA256,
      ],
      '$/budgetSourceResult/durableReceipt/contractManifestSha256',
    ),
    authorityBuildHash,
    recordKind: literal(
      own(record, 'recordKind'),
      'receipt',
      '$/budgetSourceResult/durableReceipt/recordKind',
    ),
    operationalProjection,
    operationalProjectionHash: hash(
      own(record, 'operationalProjectionHash'),
      '$/budgetSourceResult/durableReceipt/operationalProjectionHash',
    ),
  });
}

function validateBudgetSourceResultForPrepared(
  value: unknown,
  prepared: WorkflowBudgetPreparedRequest,
  request: WorkflowBudgetReserveRequest | WorkflowBudgetSettlementRequest,
): ValidatedBudgetSourceResult {
  const record = inertRecord(
    value,
    ['schema', 'durableReceiptBytes', 'decision', 'ledgerEntry'],
    '$/budgetSourceResult',
  );
  if (prepared.operation !== 'reserve') {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      '$/budgetSourceResult',
      'A budget authorization requires an exact reserve result.',
    );
  }
  const reserveRequest = request as WorkflowBudgetReserveRequest;
  const durableReceiptBytes = own(record, 'durableReceiptBytes');
  const durable = parseBudgetDurableReceipt(durableReceiptBytes);
  const durableReceipt = durable.value;
  const budgetResult = validateBudgetContractForBinding('$/budgetSourceResult/receipt', () =>
    validateWorkflowBudgetReceiptResult(
      durableReceipt.operationalProjection,
      prepared,
      own(record, 'decision'),
      own(record, 'ledgerEntry'),
      null,
    ),
  );
  const { receipt, ledger: ledgerEntry } = budgetResult;
  if (budgetResult.record.schema !== WORKFLOW_BUDGET_RESERVE_DECISION_SCHEMA) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      '$/budgetSourceResult/decision',
      'A budget authorization requires an exact reserve decision.',
    );
  }
  const decision = budgetResult.record;
  if (
    receipt.operation !== 'reserve' ||
    receipt.status !== 'accepted' ||
    receipt.acceptedRunRevision === null ||
    receipt.committedAt === null ||
    decision.request.route.backend !== 'go' ||
    decision.request.route.authority !== 'workflow-control'
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
      '$/budgetSourceResult',
      'Budget source result does not prove the exact accepted prepared reserve.',
    );
  }
  const result = immutable({
    schema: literal(
      own(record, 'schema'),
      WORKFLOW_RUNNER_BUDGET_SOURCE_RESULT_SCHEMA,
      '$/budgetSourceResult/schema',
    ),
    durableReceiptBytes: durableReceiptBytes as string,
    decision,
    ledgerEntry,
  });
  return { value: result, durable, sourceReceipt: receipt, request: reserveRequest };
}

export function validateWorkflowRunnerBudgetSourceResult(
  value: unknown,
  preparedValue: unknown,
): WorkflowRunnerBudgetSourceResult {
  const prepared = validateBudgetContractForBinding('$/budgetSourceResult/decision/request', () =>
    validateWorkflowBudgetPreparedRequest(preparedValue),
  );
  const request = parsedBudgetRequest(prepared, '$/budgetSourceResult/decision/request/body');
  return validateBudgetSourceResultForPrepared(value, prepared, request).value;
}

function validateResumeEvidence(
  value: unknown,
  operation: 'resume_advance',
  path: string,
): WorkflowRunnerResumeAuthorityEvidence {
  const record = inertRecord(
    value,
    [
      'schema',
      'sourceAuthority',
      'envelope',
      'envelopeHash',
      'priorCheckpointId',
      'priorCheckpointHash',
      'nextPhaseId',
      'nextPhaseIndex',
      'logicalResumeAttemptId',
      'expiresAt',
    ],
    path,
  );
  const sourceAuthority = validateSourceAuthority(
    own(record, 'sourceAuthority'),
    operation,
    `${path}/sourceAuthority`,
  );
  const envelope = validateCheckpointEnvelopeForBinding(
    own(record, 'envelope'),
    `${path}/envelope`,
  );
  const envelopeHash = hash(own(record, 'envelopeHash'), `${path}/envelopeHash`);
  const observation = envelope.observation;
  const priorCheckpointId = nullable(own(record, 'priorCheckpointId'), (entry) =>
    id(entry, `${path}/priorCheckpointId`),
  );
  const priorCheckpointHash = nullable(own(record, 'priorCheckpointHash'), (entry) =>
    hash(entry, `${path}/priorCheckpointHash`),
  );
  const priorHash =
    observation.priorCheckpoint === null
      ? null
      : sha256(canonicalWorkflowControlAuthorityJson(observation.priorCheckpoint));
  if (
    envelope.operation !== 'resume_advance' ||
    checkpointEnvelopeHash(envelope) !== envelopeHash ||
    observation.nextPhaseId !== own(record, 'nextPhaseId') ||
    observation.nextPhaseIndex !== own(record, 'nextPhaseIndex') ||
    (observation.priorCheckpoint?.checkpointId ?? null) !== priorCheckpointId ||
    priorHash !== priorCheckpointHash ||
    sourceAuthority.requestHash !== envelopeHash ||
    sourceAuthority.acceptedRevision !== observation.revision ||
    sourceAuthority.acceptedResumeGeneration !== observation.resumeGeneration ||
    sourceAuthority.recordHash !== envelope.observationHash
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      path,
      'Resume evidence differs from the exact checkpoint head transition.',
    );
  }
  return immutable({
    schema: literal(
      own(record, 'schema'),
      'openslack.workflow_runner_resume_authority_evidence.v1',
      `${path}/schema`,
    ),
    sourceAuthority,
    envelope,
    envelopeHash,
    priorCheckpointId,
    priorCheckpointHash,
    nextPhaseId: id(own(record, 'nextPhaseId'), `${path}/nextPhaseId`),
    nextPhaseIndex: integer(own(record, 'nextPhaseIndex'), `${path}/nextPhaseIndex`),
    logicalResumeAttemptId: id(
      own(record, 'logicalResumeAttemptId'),
      `${path}/logicalResumeAttemptId`,
    ),
    expiresAt: timestamp(own(record, 'expiresAt'), `${path}/expiresAt`),
  });
}

function validateEvidence(
  value: unknown,
  operation: WorkflowRunnerAuthorityBindingOperation,
  path: string,
  session?: BindingValidationSession,
): WorkflowRunnerAuthorityEvidence {
  assertNoForbiddenKeys(value, path);
  switch (operation) {
    case 'checkpoint_commit':
      return validateCheckpointEvidence(value, operation, path);
    case 'effect_authorize':
      return validateEffectEvidence(value, operation, path);
    case 'effect_complete':
      return validateEffectCompletionEvidence(value, operation, path);
    case 'budget_reserve':
    case 'budget_settle':
      return validateBudgetEvidence(value, operation, path, session);
    case 'resume_advance':
      return validateResumeEvidence(value, operation, path);
  }
}

export function hashWorkflowRunnerAuthorityBindingEvidence(
  value: unknown,
  operation: WorkflowRunnerAuthorityBindingOperation,
): string {
  const evidence = validateEvidence(value, operation, '$');
  return hashValidatedBindingValue('evidence', evidence);
}

export function workflowRunnerAuthorityBindingMissingProviderUsageHash(
  preparedRequestHash: string,
): string {
  const validated = hash(preparedRequestHash, '$/preparedRequestHash');
  return `sha256:${sha256(
    `openslack.workflow-runner-authority-binding.missing-provider-usage.v1\0${validated}`,
  )}`;
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return (
    canonicalWorkflowControlAuthorityJson(left) === canonicalWorkflowControlAuthorityJson(right)
  );
}

function targetMessage(
  stage: WorkflowRunnerAuthorityBindingStage,
): WorkflowControlAuthorityMessage {
  return parseWorkflowControlAuthorityMessageBytes(Buffer.from(stage.target.body, 'utf8'));
}

function assertEnvelopeRunnerBinding(
  envelope: WorkflowCheckpointShadowEnvelope,
  stage: WorkflowRunnerAuthorityBindingStage,
  path: string,
): void {
  const runner = envelope.observation.runner;
  if (
    runner.workspaceId !== stage.workspaceId ||
    envelope.observation.runId !== stage.runId ||
    runner.jobId !== stage.jobId ||
    runner.attemptId !== stage.runnerAttemptId ||
    runner.leaseId !== stage.leaseId ||
    runner.fencingToken !== stage.fencingToken ||
    runner.correlationId !== stage.correlationId
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
      path,
      'Checkpoint authority evidence is cross-spliced with another runner lease.',
    );
  }
}

function assertEvidenceForStage(
  evidence: WorkflowRunnerAuthorityEvidence,
  stage: WorkflowRunnerAuthorityBindingStage,
  resolutionSentAt: string,
  session: BindingValidationSession,
): void {
  const message = targetMessage(stage);
  const payload = message.payload;
  const source = evidence.sourceAuthority;
  if (
    source.expectedResumeGeneration !== stage.runnerAuthority.expectedResumeGeneration ||
    source.authorityBuildHash !== stage.route.authorityBuildHash
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      '$/evidence/sourceAuthority',
      'Source authority is not bound to the staged runner head and build.',
    );
  }

  switch (stage.operation) {
    case 'checkpoint_commit': {
      if (evidence.schema !== 'openslack.workflow_runner_checkpoint_authority_evidence.v1') {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
          '$/evidence/schema',
          'Checkpoint operation requires checkpoint authority evidence.',
        );
      }
      assertEnvelopeRunnerBinding(evidence.envelope, stage, '$/evidence/envelope');
      const observation = evidence.envelope.observation;
      const checkpoint = observation.checkpoint;
      if (
        checkpoint === null ||
        source.expectedRevision + 1 !== source.acceptedRevision ||
        source.acceptedResumeGeneration !== stage.runnerAuthority.expectedResumeGeneration ||
        checkpoint.checkpointId !== payload.checkpointId ||
        checkpoint.phaseId !== payload.phaseId ||
        checkpoint.phaseIndex !== payload.phaseIndex ||
        checkpoint.commitPoint !== payload.commitPoint ||
        checkpoint.artifactRef !== payload.artifactRef ||
        checkpoint.artifactHash !== payload.artifactHash ||
        checkpoint.resultHash !== payload.resultHash ||
        checkpoint.cacheKeyHash !== payload.cacheKeyHash ||
        checkpoint.committedRevision !== source.acceptedRevision ||
        checkpoint.resumeGeneration !== source.acceptedResumeGeneration ||
        observation.workflowSourceHash !== payload.workflowSourceHash ||
        observation.manifestHash !== payload.manifestHash ||
        observation.inputHash !== payload.inputHash
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
          '$/evidence',
          'Checkpoint evidence differs from the exact staged checkpoint event.',
        );
      }
      return;
    }
    case 'effect_authorize': {
      if (evidence.schema !== 'openslack.workflow_runner_effect_authority_evidence.v1') {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
          '$/evidence/schema',
          'Effect intent requires effect-v2 authority evidence.',
        );
      }
      if (
        evidence.effectId !== payload.effectId ||
        evidence.effectHash !== payload.effectHash ||
        evidence.capabilityHash !== payload.capabilityHash ||
        payload.requiresHumanDecision !== true ||
        source.requestHash !== evidence.intentBindingHash ||
        source.acceptedResumeGeneration !== stage.runnerAuthority.expectedResumeGeneration ||
        evidence.decisionRevision !== source.acceptedRevision ||
        ((evidence.approvalStatus === 'approved' || evidence.approvalStatus === 'rejected') &&
          evidence.expiresAt <= resolutionSentAt) ||
        (evidence.approvalStatus === 'expired' && evidence.expiresAt > resolutionSentAt)
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
          '$/evidence',
          'Effect approval or claim differs from the exact staged intent.',
        );
      }
      return;
    }
    case 'effect_complete': {
      if (evidence.schema !== 'openslack.workflow_runner_effect_completion_evidence.v1') {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
          '$/evidence/schema',
          'Effect outcome requires effect completion evidence.',
        );
      }
      if (
        evidence.effectId !== payload.effectId ||
        evidence.status !== payload.status ||
        evidence.outcomeHash !== payload.outcomeHash ||
        source.requestHash !== evidence.claimHash ||
        source.acceptedResumeGeneration !== stage.runnerAuthority.expectedResumeGeneration
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
          '$/evidence',
          'Effect completion differs from the exact staged outcome.',
        );
      }
      return;
    }
    case 'budget_reserve':
    case 'budget_settle': {
      if (evidence.schema !== 'openslack.workflow_runner_budget_authority_evidence.v1') {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
          '$/evidence/schema',
          'Budget operation requires an exact E1 prepared request.',
        );
      }
      const request = parsedBudgetRequest(
        evidence.preparedRequest,
        '$/evidence/preparedRequest/body',
        session,
      );
      if (
        request.workspaceId !== stage.workspaceId ||
        request.runId !== stage.runId ||
        request.correlationId !== stage.correlationId ||
        request.expectedAccountRevision !== source.expectedRevision ||
        source.acceptedRevision !== null ||
        source.acceptedResumeGeneration !== stage.runnerAuthority.expectedResumeGeneration ||
        !sameCanonical(request.route, stage.route) ||
        request.reservationId !== payload.reservationId ||
        request.callId !== payload.callId
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
          '$/evidence',
          'Budget request differs from the runner lease, route, or staged event.',
        );
      }
      if (stage.operation === 'budget_reserve') {
        const reserve = request as WorkflowBudgetReserveRequest;
        if (
          reserve.requested.tokens !== payload.requestedTokens ||
          reserve.requested.nanoUsd !== payload.requestedCostNanoUsd ||
          reserve.requested.calls !== payload.requestedCalls ||
          reserve.policyHash !== payload.policyHash
        ) {
          fail(
            'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
            '$/evidence/preparedRequest',
            'Budget reservation quantities differ from the staged event.',
          );
        }
        return;
      }
      const settlement = request as WorkflowBudgetSettlementRequest;
      const missingReceiptHash = workflowRunnerAuthorityBindingMissingProviderUsageHash(
        evidence.preparedRequest.requestHash,
      );
      const expectedReceiptHash = settlement.usageReceiptHash ?? missingReceiptHash;
      const trustedReported =
        settlement.usageEvidenceStatus === 'trusted' &&
        settlement.providerUsage?.status === 'reported';
      const expectedTokens = trustedReported ? settlement.providerUsage!.totalTokens! : '0';
      const expectedCost = trustedReported
        ? validateBudgetContractForBinding('$/evidence/preparedRequest/body', () =>
            workflowBudgetAuthorityChargeNanoUsd(expectedTokens, settlement.rateNanoUsdPerToken),
          )
        : '0';
      const expectedCalls = trustedReported ? settlement.providerUsage!.calls : '0';
      const expectedSettlementStatus = trustedReported ? 'settled' : 'reconciliation_required';
      if (
        evidence.providerUsageReceiptHash !== expectedReceiptHash ||
        payload.providerReceiptHash !== expectedReceiptHash.slice('sha256:'.length) ||
        payload.actualTokens !== expectedTokens ||
        payload.actualCostNanoUsd !== expectedCost ||
        payload.actualCalls !== expectedCalls ||
        payload.settlementStatus !== expectedSettlementStatus
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
          '$/evidence/preparedRequest',
          'Budget settlement usage evidence differs from the staged event.',
        );
      }
      return;
    }
    case 'resume_advance': {
      if (evidence.schema !== 'openslack.workflow_runner_resume_authority_evidence.v1') {
        return fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
          '$/evidence/schema',
          'Resume operation requires an exact TS resume authority record.',
        );
      }
      assertEnvelopeRunnerBinding(evidence.envelope, stage, '$/evidence/envelope');
      const observation = evidence.envelope.observation;
      if (
        ((evidence.priorCheckpointId === null || evidence.priorCheckpointHash === null) &&
          (evidence.nextPhaseId !== 'phase-0' || evidence.nextPhaseIndex !== 0)) ||
        evidence.logicalResumeAttemptId === stage.runnerAttemptId ||
        evidence.expiresAt !== payload.leaseExpiresAt ||
        payload.acceptedAt !== stage.sentAt ||
        source.expectedResumeGeneration !== stage.runnerAuthority.expectedResumeGeneration ||
        source.acceptedResumeGeneration !== stage.runnerAuthority.acceptedResumeGeneration ||
        observation.resumeGeneration !== stage.runnerAuthority.acceptedResumeGeneration ||
        observation.nextPhaseId !== evidence.nextPhaseId ||
        observation.nextPhaseIndex !== evidence.nextPhaseIndex
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_RESUME_GENERATION_CONFLICT',
          '$/evidence',
          'Resume evidence does not prove the exact contiguous generation transition.',
        );
      }
      return;
    }
  }
}

export function hashWorkflowRunnerAuthorityBindingStage(
  value: WorkflowRunnerAuthorityBindingStage,
): string {
  const validated = validateWorkflowRunnerAuthorityBindingStage(value);
  return hashValidatedBindingValue('stage', validated);
}

export function validateWorkflowRunnerAuthorityBindingResolution(
  value: unknown,
): WorkflowRunnerAuthorityBindingResolution {
  return validateWorkflowRunnerAuthorityBindingResolutionWithSession(
    value,
    newBindingValidationSession(),
  );
}

function validateWorkflowRunnerAuthorityBindingResolutionWithSession(
  value: unknown,
  session: BindingValidationSession,
): WorkflowRunnerAuthorityBindingResolution {
  const record = inertRecord(
    value,
    [
      'schema',
      'contractVersion',
      'profile',
      'phase',
      'direction',
      'companionSequence',
      'bindingId',
      'operation',
      'stageHash',
      'stageReceiptHash',
      'targetBodyHash',
      'evidence',
      'evidenceHash',
      'sentAt',
    ],
    '$',
  );
  const operation = oneOf(
    own(record, 'operation'),
    WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS,
    '$/operation',
  );
  const evidence = validateEvidence(own(record, 'evidence'), operation, '$/evidence', session);
  byteBound(evidence, WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxEvidenceBytes, '$/evidence');
  const evidenceHash = hash(own(record, 'evidenceHash'), '$/evidenceHash');
  if (evidenceHash !== hashValidatedBindingValue('evidence', evidence)) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_HASH_MISMATCH',
      '$/evidenceHash',
      'Authority evidence hash drifted.',
    );
  }
  const result = immutable({
    schema: literal(
      own(record, 'schema'),
      WORKFLOW_RUNNER_AUTHORITY_BINDING_RESOLUTION_SCHEMA,
      '$/schema',
    ),
    contractVersion: literal(
      own(record, 'contractVersion'),
      WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
      '$/contractVersion',
    ),
    profile: literal(
      own(record, 'profile'),
      WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
      '$/profile',
    ),
    phase: literal(own(record, 'phase'), 'commit_authority', '$/phase'),
    direction: literal(own(record, 'direction'), 'runner-to-control', '$/direction'),
    companionSequence: literal(own(record, 'companionSequence'), 2, '$/companionSequence'),
    bindingId: id(own(record, 'bindingId'), '$/bindingId'),
    operation,
    stageHash: hash(own(record, 'stageHash'), '$/stageHash'),
    stageReceiptHash: hash(own(record, 'stageReceiptHash'), '$/stageReceiptHash'),
    targetBodyHash: hash(own(record, 'targetBodyHash'), '$/targetBodyHash'),
    evidence,
    evidenceHash,
    sentAt: timestamp(own(record, 'sentAt'), '$/sentAt'),
  } satisfies WorkflowRunnerAuthorityBindingResolution);
  framedByteBound(result, WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxFrameBytes, '$');
  return result;
}

export function validateWorkflowRunnerAuthorityBindingResolutionForStage(
  value: unknown,
  stageValue: unknown,
  stageReceiptValue: unknown,
): WorkflowRunnerAuthorityBindingResolution {
  const stage = validateWorkflowRunnerAuthorityBindingStage(stageValue);
  const stageReceipt = validateStageReceiptForValidatedStage(stageReceiptValue, stage);
  return validateResolutionForValidatedStage(value, stage, stageReceipt);
}

function validateResolutionForValidatedStage(
  value: unknown,
  stage: WorkflowRunnerAuthorityBindingStage,
  stageReceipt: WorkflowRunnerAuthorityStageReceipt,
  session: BindingValidationSession = newBindingValidationSession(),
): WorkflowRunnerAuthorityBindingResolution {
  const resolution = validateWorkflowRunnerAuthorityBindingResolutionWithSession(value, session);
  if (
    stageReceipt.phase !== 'stage_event' ||
    stageReceipt.status !== 'accepted' ||
    resolution.bindingId !== stage.bindingId ||
    resolution.operation !== stage.operation ||
    resolution.stageHash !== hashValidatedBindingValue('stage', stage) ||
    resolution.stageReceiptHash !== hashValidatedBindingValue('receipt', stageReceipt) ||
    resolution.targetBodyHash !== stage.target.messageDigest ||
    resolution.stageReceiptHash === resolution.stageHash ||
    resolution.sentAt < stageReceipt.committedAt!
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_STAGE_REQUIRED',
      '$',
      'Authority resolution is not bound to an accepted durable stage.',
    );
  }
  assertEvidenceForStage(resolution.evidence, stage, resolution.sentAt, session);
  return resolution;
}

function validateReceiptBase(record: Record<string, unknown>): {
  bindingId: string;
  operation: WorkflowRunnerAuthorityBindingOperation;
  status: 'accepted' | 'reconciliation_required';
  controlBuildHash: string;
  committedAt: string | null;
  reconciliationToken: string | null;
} {
  const status = oneOf(
    own(record, 'status'),
    ['accepted', 'reconciliation_required'] as const,
    '$/status',
  );
  const committedAt = nullable(own(record, 'committedAt'), (entry) =>
    timestamp(entry, '$/committedAt'),
  );
  const reconciliationToken = nullable(own(record, 'reconciliationToken'), (entry) =>
    ref(entry, '$/reconciliationToken'),
  );
  if (
    (status === 'accepted' && (committedAt === null || reconciliationToken !== null)) ||
    (status === 'reconciliation_required' && (committedAt !== null || reconciliationToken === null))
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_RECONCILIATION_REQUIRED',
      '$',
      'Receipt status evidence is inconsistent.',
    );
  }
  return {
    bindingId: id(own(record, 'bindingId'), '$/bindingId'),
    operation: oneOf(
      own(record, 'operation'),
      WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS,
      '$/operation',
    ),
    status,
    controlBuildHash: hash(own(record, 'controlBuildHash'), '$/controlBuildHash'),
    committedAt,
    reconciliationToken,
  };
}

export function validateWorkflowRunnerAuthorityBindingReceipt(
  value: unknown,
): WorkflowRunnerAuthorityBindingReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
      '$',
      'Receipt must be an inert object.',
    );
  }
  const phase = (value as Record<string, unknown>).phase;
  const common = [
    'schema',
    'contractVersion',
    'profile',
    'direction',
    'phase',
    'companionSequence',
    'bindingId',
    'operation',
    'status',
    'controlBuildHash',
    'committedAt',
    'reconciliationToken',
  ] as const;
  if (phase === 'stage_event' || phase === 'commit_authority') {
    const record = inertRecord(
      value,
      [
        ...common,
        'requestHash',
        'targetEventId',
        'targetBodyHash',
        ...(phase === 'commit_authority' ? (['stageHash', 'stageReceiptHash'] as const) : []),
        'evidenceHash',
      ],
      '$',
    );
    const base = validateReceiptBase(record);
    const evidenceHash = nullable(own(record, 'evidenceHash'), (entry) =>
      hash(entry, '$/evidenceHash'),
    );
    const companionSequence = integer(own(record, 'companionSequence'), '$/companionSequence', 1);
    if (
      (phase === 'stage_event' && (companionSequence !== 1 || evidenceHash !== null)) ||
      (phase === 'commit_authority' && (companionSequence !== 2 || evidenceHash === null))
    ) {
      fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_SEQUENCE_CONFLICT',
        '$/companionSequence',
        'Phase receipt is in the wrong companion sequence domain.',
      );
    }
    const shared = {
      schema: literal(
        own(record, 'schema'),
        WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA,
        '$/schema',
      ),
      contractVersion: literal(
        own(record, 'contractVersion'),
        WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
        '$/contractVersion',
      ),
      profile: literal(
        own(record, 'profile'),
        WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
        '$/profile',
      ),
      direction: literal(own(record, 'direction'), 'control-to-runner', '$/direction'),
      ...base,
      requestHash: hash(own(record, 'requestHash'), '$/requestHash'),
      targetEventId: id(own(record, 'targetEventId'), '$/targetEventId'),
      targetBodyHash: hash(own(record, 'targetBodyHash'), '$/targetBodyHash'),
    } as const;
    const result =
      phase === 'stage_event'
        ? immutable({
            ...shared,
            phase: 'stage_event' as const,
            companionSequence: 1 as const,
            evidenceHash: null,
          } satisfies WorkflowRunnerAuthorityStageReceipt)
        : immutable({
            ...shared,
            phase: 'commit_authority' as const,
            companionSequence: 2 as const,
            stageHash: hash(own(record, 'stageHash'), '$/stageHash'),
            stageReceiptHash: hash(own(record, 'stageReceiptHash'), '$/stageReceiptHash'),
            evidenceHash: evidenceHash!,
          } satisfies WorkflowRunnerAuthorityResolutionReceipt);
    framedByteBound(result, WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxReceiptBytes, '$');
    return result;
  }
  if (phase === 'control_delivery') {
    const record = inertRecord(
      value,
      [
        ...common,
        'controlEventId',
        'controlKind',
        'controlSequence',
        'messageDigest',
        'runnerAttemptId',
        'leaseId',
        'fencingToken',
        'processedAt',
        'disposition',
      ],
      '$',
    );
    const base = validateReceiptBase(record);
    if (base.status !== 'accepted') {
      fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_RECONCILIATION_REQUIRED',
        '$/status',
        'A control delivery acknowledgement cannot claim reconciliation as delivery.',
      );
    }
    const result = immutable({
      schema: literal(
        own(record, 'schema'),
        WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA,
        '$/schema',
      ),
      contractVersion: literal(
        own(record, 'contractVersion'),
        WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
        '$/contractVersion',
      ),
      profile: literal(
        own(record, 'profile'),
        WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
        '$/profile',
      ),
      direction: literal(own(record, 'direction'), 'runner-to-control', '$/direction'),
      phase: literal(phase, 'control_delivery', '$/phase'),
      companionSequence: integer(own(record, 'companionSequence'), '$/companionSequence', 3),
      ...base,
      controlEventId: id(own(record, 'controlEventId'), '$/controlEventId'),
      controlKind: oneOf(
        own(record, 'controlKind'),
        [
          'event_receipt',
          'budget_authorization',
          'effect_authorization',
          'resume_offer',
          'cancel_request',
        ] as const,
        '$/controlKind',
      ),
      controlSequence: integer(own(record, 'controlSequence'), '$/controlSequence', 1),
      messageDigest: hash(own(record, 'messageDigest'), '$/messageDigest'),
      runnerAttemptId: id(own(record, 'runnerAttemptId'), '$/runnerAttemptId'),
      leaseId: id(own(record, 'leaseId'), '$/leaseId'),
      fencingToken: integer(own(record, 'fencingToken'), '$/fencingToken', 1),
      processedAt: timestamp(own(record, 'processedAt'), '$/processedAt'),
      disposition: oneOf(
        own(record, 'disposition'),
        ['accepted', 'reconciliation_required'] as const,
        '$/disposition',
      ),
    } satisfies WorkflowRunnerAuthorityControlDeliveryReceipt);
    if (result.processedAt !== result.committedAt) {
      fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
        '$/processedAt',
        'Control processing time must equal its durable acknowledgement time.',
      );
    }
    framedByteBound(result, WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxReceiptBytes, '$');
    return result;
  }
  return fail('WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID', '$/phase', 'Receipt phase is invalid.');
}

export function hashWorkflowRunnerAuthorityBindingResolution(
  value: WorkflowRunnerAuthorityBindingResolution,
): string {
  const validated = validateWorkflowRunnerAuthorityBindingResolution(value);
  return hashValidatedBindingValue('resolution', validated);
}

export function hashWorkflowRunnerAuthorityBindingReceipt(
  value: WorkflowRunnerAuthorityBindingReceipt,
): string {
  const validated = validateWorkflowRunnerAuthorityBindingReceipt(value);
  return hashValidatedBindingValue('receipt', validated);
}

export function validateWorkflowRunnerAuthorityBindingStageReceipt(
  value: unknown,
  stageValue: unknown,
): WorkflowRunnerAuthorityStageReceipt {
  const stage = validateWorkflowRunnerAuthorityBindingStage(stageValue);
  return validateStageReceiptForValidatedStage(value, stage);
}

function validateStageReceiptForValidatedStage(
  value: unknown,
  stage: WorkflowRunnerAuthorityBindingStage,
): WorkflowRunnerAuthorityStageReceipt {
  const receipt = validateWorkflowRunnerAuthorityBindingReceipt(value);
  if (
    receipt.phase !== 'stage_event' ||
    receipt.bindingId !== stage.bindingId ||
    receipt.operation !== stage.operation ||
    receipt.requestHash !== hashValidatedBindingValue('stage', stage) ||
    receipt.targetEventId !== stage.target.eventId ||
    receipt.targetBodyHash !== stage.target.messageDigest ||
    receipt.controlBuildHash !== stage.route.authorityBuildHash ||
    (receipt.committedAt !== null && receipt.committedAt < stage.sentAt)
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
      '$',
      'Stage receipt does not bind the exact durable stage.',
    );
  }
  return receipt;
}

export function validateWorkflowRunnerAuthorityBindingResolutionReceipt(
  value: unknown,
  resolutionValue: unknown,
  stageValue: unknown,
  stageReceiptValue: unknown,
): WorkflowRunnerAuthorityResolutionReceipt {
  const stage = validateWorkflowRunnerAuthorityBindingStage(stageValue);
  const stageReceipt = validateStageReceiptForValidatedStage(stageReceiptValue, stage);
  const resolution = validateResolutionForValidatedStage(resolutionValue, stage, stageReceipt);
  return validateResolutionReceiptForValidatedContext(value, resolution, stage, stageReceipt);
}

function validateResolutionReceiptForValidatedContext(
  value: unknown,
  resolution: WorkflowRunnerAuthorityBindingResolution,
  stage: WorkflowRunnerAuthorityBindingStage,
  stageReceipt: WorkflowRunnerAuthorityStageReceipt,
): WorkflowRunnerAuthorityResolutionReceipt {
  const receipt = validateWorkflowRunnerAuthorityBindingReceipt(value);
  if (
    receipt.phase !== 'commit_authority' ||
    receipt.bindingId !== resolution.bindingId ||
    receipt.operation !== resolution.operation ||
    receipt.requestHash !== hashValidatedBindingValue('resolution', resolution) ||
    receipt.targetEventId !== stage.target.eventId ||
    receipt.targetBodyHash !== resolution.targetBodyHash ||
    receipt.stageHash !== resolution.stageHash ||
    receipt.stageHash !== hashValidatedBindingValue('stage', stage) ||
    receipt.stageReceiptHash !== resolution.stageReceiptHash ||
    receipt.stageReceiptHash !== hashValidatedBindingValue('receipt', stageReceipt) ||
    receipt.evidenceHash !== resolution.evidenceHash ||
    receipt.controlBuildHash !== resolution.evidence.sourceAuthority.authorityBuildHash ||
    resolution.bindingId !== stage.bindingId ||
    resolution.operation !== stage.operation ||
    resolution.targetBodyHash !== stage.target.messageDigest ||
    (receipt.committedAt !== null && receipt.committedAt < resolution.sentAt)
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
      '$',
      'Resolution receipt does not bind the exact committed evidence.',
    );
  }
  return receipt;
}

export function validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
  value: unknown,
  messageValue: unknown,
  context: WorkflowRunnerAuthorityControlDeliveryValidationContext,
): WorkflowRunnerAuthorityControlDeliveryReceipt {
  const session = newBindingValidationSession();
  const stage = validateWorkflowRunnerAuthorityBindingStage(context.stage);
  const stageReceipt = validateStageReceiptForValidatedStage(context.stageReceipt, stage);
  const resolution = validateResolutionForValidatedStage(
    context.resolution,
    stage,
    stageReceipt,
    session,
  );
  const resolutionReceipt = validateResolutionReceiptForValidatedContext(
    context.resolutionReceipt,
    resolution,
    stage,
    stageReceipt,
  );
  return validateControlDeliveryForValidatedContext(
    value,
    messageValue,
    stage,
    resolution,
    resolutionReceipt,
    stageReceipt,
    context.priorEventDelivery,
    context.budgetSourceResult,
    session,
  );
}

function validateControlDeliveryForValidatedContext(
  value: unknown,
  messageValue: unknown,
  stage: WorkflowRunnerAuthorityBindingStage,
  resolution: WorkflowRunnerAuthorityBindingResolution,
  resolutionReceipt: WorkflowRunnerAuthorityResolutionReceipt,
  stageReceipt: WorkflowRunnerAuthorityStageReceipt,
  priorEventDeliveryValue: unknown,
  budgetSourceResultValue: unknown,
  session: BindingValidationSession,
): WorkflowRunnerAuthorityControlDeliveryReceipt {
  const receipt = validateWorkflowRunnerAuthorityBindingReceipt(value);
  if (receipt.phase !== 'control_delivery') {
    return fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
      '$/phase',
      'Expected a control delivery acknowledgement.',
    );
  }
  const control = validateAuthorityContractForBinding('$', () =>
    validateWorkflowControlAuthorityMessage(messageValue),
  );
  const hasBudgetSourceResult =
    budgetSourceResultValue !== undefined && budgetSourceResultValue !== null;
  if (control.kind === 'budget_authorization' && !hasBudgetSourceResult) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      '$/budgetSourceResult',
      'Budget authorization requires its exact durable source result.',
    );
  }
  if (control.kind !== 'budget_authorization' && hasBudgetSourceResult) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
      '$/budgetSourceResult',
      'Budget source result is valid only for a budget authorization.',
    );
  }
  const message = prepareWorkflowControlAuthorityMessage(control);
  const expectedHead =
    control.kind === 'resume_offer'
      ? {
          revision: stage.runnerAuthority.expectedGlobalRunRevision,
          generation: stage.runnerAuthority.expectedResumeGeneration,
        }
      : {
          revision: stage.runnerAuthority.acceptedGlobalRunRevision,
          generation: stage.runnerAuthority.acceptedResumeGeneration,
        };
  if (
    message.direction !== 'control-to-runner' ||
    resolutionReceipt.phase !== 'commit_authority' ||
    resolutionReceipt.status !== 'accepted' ||
    receipt.bindingId !== stage.bindingId ||
    receipt.operation !== stage.operation ||
    receipt.controlEventId !== control.eventId ||
    receipt.controlKind !== control.kind ||
    receipt.controlSequence !== control.sequence ||
    receipt.messageDigest !== message.messageDigest ||
    receipt.runnerAttemptId !== control.attemptId ||
    receipt.leaseId !== control.leaseId ||
    receipt.fencingToken !== control.fencingToken ||
    receipt.controlBuildHash !== stage.route.authorityBuildHash ||
    control.workspaceId !== stage.workspaceId ||
    control.jobId !== stage.jobId ||
    control.workflowRunId !== stage.runId ||
    control.attemptId !== stage.runnerAttemptId ||
    control.leaseId !== stage.leaseId ||
    control.fencingToken !== stage.fencingToken ||
    control.correlationId !== stage.correlationId ||
    control.authorityBackend !== stage.route.backend ||
    control.authority !== stage.route.authority ||
    control.routingEpoch !== stage.route.routingEpoch ||
    control.authorityBuildHash !== stage.route.authorityBuildHash ||
    control.runRevision !== expectedHead.revision ||
    control.resumeGeneration !== expectedHead.generation ||
    control.sequence === null ||
    control.sequence <= stage.target.sequence ||
    (control.kind === 'event_receipt' &&
      resolutionReceipt.committedAt !== null &&
      control.sentAt < resolutionReceipt.committedAt) ||
    receipt.committedAt! < control.sentAt ||
    receipt.companionSequence !== (control.kind === 'event_receipt' ? 3 : 4)
  ) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
      '$',
      'Control acknowledgement is cross-spliced with another exact control message.',
    );
  }
  const payload = control.payload;
  let budgetSourceResult: ValidatedBudgetSourceResult | null = null;
  switch (control.kind) {
    case 'event_receipt': {
      const target = targetMessage(stage);
      const reconciles = payload.status === 'reconciliation_required';
      if (
        payload.receivedEventId !== target.eventId ||
        payload.receivedKind !== target.kind ||
        payload.receivedSequence !== target.sequence ||
        payload.receivedDigest !== stage.target.messageDigest ||
        payload.receivedIdempotencyKey !== stage.target.idempotencyKey ||
        payload.receivedFingerprint !== stage.target.requestFingerprint ||
        payload.controlBuildHash !== stage.route.authorityBuildHash ||
        payload.committedAt !== control.sentAt ||
        reconciles !== (receipt.disposition === 'reconciliation_required')
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
          '$/payload',
          'Event receipt does not acknowledge the exact staged target.',
        );
      }
      break;
    }
    case 'budget_authorization': {
      if (
        stage.operation !== 'budget_reserve' ||
        resolution.evidence.schema !== 'openslack.workflow_runner_budget_authority_evidence.v1'
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
          '$/controlKind',
          'Budget authorization is not valid for this binding operation.',
        );
      }
      const request = parsedBudgetRequest(
        resolution.evidence.preparedRequest,
        '$/resolution/evidence/preparedRequest/body',
        session,
      ) as WorkflowBudgetReserveRequest;
      budgetSourceResult = validateBudgetSourceResultForPrepared(
        budgetSourceResultValue,
        resolution.evidence.preparedRequest,
        request,
      );
      const durableReceipt = budgetSourceResult.durable.value;
      const sourceReceipt = budgetSourceResult.sourceReceipt;
      const sourceDecision = budgetSourceResult.value.decision;
      const authorization = sourceDecision.authorization;
      if (
        payload.reservationId !== request.reservationId ||
        payload.status !== sourceDecision.status ||
        payload.authorizedTokens !== authorization.tokens ||
        payload.authorizedCostNanoUsd !== authorization.nanoUsd ||
        payload.authorizedCalls !== authorization.calls ||
        payload.authorityReceiptHash !== budgetSourceResult.durable.receiptHash ||
        payload.committedRunRevision !== sourceReceipt.acceptedRunRevision ||
        stage.route.backend !== 'go' ||
        stage.route.authority !== 'workflow-control' ||
        stage.route.authorityBuildHash !== durableReceipt.authorityBuildHash
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
          '$/payload',
          'Budget decision differs from the exact prepared authority evidence.',
        );
      }
      break;
    }
    case 'effect_authorization': {
      const authorityReceiptHash = hashValidatedBindingValue('receipt', resolutionReceipt);
      if (
        stage.operation !== 'effect_authorize' ||
        resolution.evidence.schema !== 'openslack.workflow_runner_effect_authority_evidence.v1'
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
          '$/controlKind',
          'Effect authorization is not valid for this binding operation.',
        );
      }
      const evidence = resolution.evidence;
      if (
        payload.effectId !== evidence.effectId ||
        payload.effectHash !== evidence.effectHash ||
        payload.approvalId !== evidence.approvalId ||
        payload.approvalStatus !== evidence.approvalStatus ||
        payload.decisionRevision !== evidence.decisionRevision ||
        payload.grantHash !== evidence.grantHash ||
        payload.authorityReceiptHash !== authorityReceiptHash ||
        payload.expiresAt !== evidence.expiresAt
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
          '$/payload',
          'Effect decision differs from the exact effect-v2 evidence.',
        );
      }
      break;
    }
    case 'resume_offer': {
      const authorityReceiptHash = hashValidatedBindingValue('receipt', resolutionReceipt);
      if (
        stage.operation !== 'resume_advance' ||
        resolution.evidence.schema !== 'openslack.workflow_runner_resume_authority_evidence.v1'
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
          '$/controlKind',
          'Resume offer is not valid for this binding operation.',
        );
      }
      const evidence = resolution.evidence;
      if (
        payload.checkpointId !== evidence.priorCheckpointId ||
        payload.checkpointHash !== evidence.priorCheckpointHash ||
        payload.nextPhaseId !== evidence.nextPhaseId ||
        payload.nextPhaseIndex !== evidence.nextPhaseIndex ||
        payload.newResumeGeneration !== stage.runnerAuthority.acceptedResumeGeneration ||
        payload.newAttemptId !== evidence.logicalResumeAttemptId ||
        payload.authorityReceiptHash !== authorityReceiptHash ||
        payload.expiresAt !== evidence.expiresAt
      ) {
        fail(
          'WORKFLOW_RUNNER_AUTHORITY_BINDING_IDENTITY_MISMATCH',
          '$/payload',
          'Resume offer differs from the exact resume authority evidence.',
        );
      }
      break;
    }
    case 'cancel_request':
      break;
    default:
      fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_AUTHORITY_PLANE_MISMATCH',
        '$/controlKind',
        'Control kind is outside the authority-binding delivery set.',
      );
  }

  if (control.kind === 'event_receipt') {
    if (priorEventDeliveryValue !== null) {
      fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_SEQUENCE_CONFLICT',
        '$/priorEventDelivery',
        'An event-receipt delivery acknowledgement cannot have a predecessor.',
      );
    }
  } else {
    const prior = inertRecord(
      priorEventDeliveryValue,
      ['message', 'receipt'],
      '$/priorEventDelivery',
    );
    let priorReceipt: WorkflowRunnerAuthorityControlDeliveryReceipt;
    try {
      priorReceipt = validateControlDeliveryForValidatedContext(
        own(prior, 'receipt'),
        own(prior, 'message'),
        stage,
        resolution,
        resolutionReceipt,
        stageReceipt,
        null,
        undefined,
        session,
      );
    } catch (error) {
      if (error instanceof WorkflowRunnerAuthorityBindingContractError) {
        fail(
          error.code,
          nestedContractPath('$/priorEventDelivery', error.path),
          'Prior event-receipt delivery acknowledgement is invalid.',
        );
      }
      throw error;
    }
    const priorMessage = validateAuthorityContractForBinding('$/priorEventDelivery/message', () =>
      validateWorkflowControlAuthorityMessage(own(prior, 'message')),
    );
    if (
      priorMessage.kind !== 'event_receipt' ||
      priorReceipt.controlKind !== 'event_receipt' ||
      priorReceipt.disposition !== 'accepted' ||
      priorMessage.sequence === null ||
      control.sequence !== priorMessage.sequence + 1 ||
      control.sentAt < priorMessage.sentAt ||
      receipt.companionSequence !== priorReceipt.companionSequence + 1
    ) {
      fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_SEQUENCE_CONFLICT',
        '$/priorEventDelivery',
        'Optional control delivery is not contiguous with an accepted event-receipt ACK.',
      );
    }
    if (
      budgetSourceResult !== null &&
      (() => {
        const committedAt = budgetSourceResult.sourceReceipt.committedAt;
        return (
          committedAt === null ||
          resolutionReceipt.committedAt === null ||
          committedAt < resolutionReceipt.committedAt ||
          committedAt > priorMessage.sentAt ||
          control.sentAt < committedAt
        );
      })()
    ) {
      fail(
        'WORKFLOW_RUNNER_AUTHORITY_BINDING_SEQUENCE_CONFLICT',
        '$/budgetSourceResult/receipt/committedAt',
        'Budget authority must commit after the staged event and before its receipt and decision.',
      );
    }
  }
  return receipt;
}

export function validateWorkflowRunnerAuthorityBindingError(
  value: unknown,
): WorkflowRunnerAuthorityBindingError {
  const record = inertRecord(
    value,
    ['schema', 'code', 'message', 'bindingId', 'operation', 'reconciliationToken'],
    '$',
  );
  const result = immutable({
    schema: literal(
      own(record, 'schema'),
      WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_SCHEMA,
      '$/schema',
    ),
    code: oneOf(own(record, 'code'), WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES, '$/code'),
    message: text(own(record, 'message'), '$/message', /^.{1,512}$/u, 512),
    bindingId: nullable(own(record, 'bindingId'), (entry) => id(entry, '$/bindingId')),
    operation: nullable(own(record, 'operation'), (entry) =>
      oneOf(entry, WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS, '$/operation'),
    ),
    reconciliationToken: nullable(own(record, 'reconciliationToken'), (entry) =>
      ref(entry, '$/reconciliationToken'),
    ),
  } satisfies WorkflowRunnerAuthorityBindingError);
  framedByteBound(result, WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxErrorBytes, '$');
  return result;
}

function parseCanonicalBindingBytes<T>(
  bytes: Uint8Array,
  limit: number,
  validate: (value: unknown) => T,
): T {
  if (bytes.byteLength === 0 || bytes.byteLength > limit) {
    fail('WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED', '$', 'Binding frame size is invalid.');
  }
  const frame = Buffer.from(bytes);
  if (frame.at(-1) !== 0x0a || frame.at(-2) === 0x0a || frame.includes(0x0d)) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
      '$',
      'Binding frame must be canonical JSON plus exactly one LF.',
    );
  }
  let parsed: unknown;
  try {
    parsed = parseWorkflowEffectJson(frame.subarray(0, -1), {
      maxDepth: WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxDepth,
      maxNodes: WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxNodes,
      maxStringLength: WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxStringBytes,
      maxStringBytes: WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxStringBytes,
      unicodeScalarsOnly: true,
      canonicalSafeIntegersOnly: true,
    });
  } catch (error) {
    if (error instanceof WorkflowEffectJsonError) {
      return fail(
        error.code === 'WORKFLOW_EFFECT_JSON_LIMIT_EXCEEDED'
          ? 'WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMIT_EXCEEDED'
          : 'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
        '$',
        error.code === 'WORKFLOW_EFFECT_JSON_LIMIT_EXCEEDED'
          ? 'Binding JSON exceeds its structural limit.'
          : 'Binding frame is not valid strict JSON.',
      );
    }
    throw error;
  }
  const validated = validate(parsed);
  if (!Buffer.from(`${canonicalWorkflowControlAuthorityJson(validated)}\n`).equals(frame)) {
    fail(
      'WORKFLOW_RUNNER_AUTHORITY_BINDING_INVALID',
      '$',
      'Binding frame is not canonical exact bytes.',
    );
  }
  return validated;
}

export function parseWorkflowRunnerAuthorityBindingStageBytes(
  bytes: Uint8Array,
): WorkflowRunnerAuthorityBindingStage {
  return parseCanonicalBindingBytes(
    bytes,
    WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxFrameBytes,
    validateWorkflowRunnerAuthorityBindingStage,
  );
}

export function parseWorkflowRunnerAuthorityBindingResolutionBytes(
  bytes: Uint8Array,
): WorkflowRunnerAuthorityBindingResolution {
  return parseCanonicalBindingBytes(
    bytes,
    WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxFrameBytes,
    validateWorkflowRunnerAuthorityBindingResolution,
  );
}

export function parseWorkflowRunnerAuthorityBindingReceiptBytes(
  bytes: Uint8Array,
): WorkflowRunnerAuthorityBindingReceipt {
  return parseCanonicalBindingBytes(
    bytes,
    WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxReceiptBytes,
    validateWorkflowRunnerAuthorityBindingReceipt,
  );
}

export function parseWorkflowRunnerAuthorityBindingErrorBytes(
  bytes: Uint8Array,
): WorkflowRunnerAuthorityBindingError {
  return parseCanonicalBindingBytes(
    bytes,
    WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxErrorBytes,
    validateWorkflowRunnerAuthorityBindingError,
  );
}

function prepareBindingValue<T>(
  value: unknown,
  validate: (entry: unknown) => T,
  domain: 'stage' | 'resolution' | 'receipt' | 'error',
): WorkflowRunnerAuthorityBindingPrepared<T> {
  const validated = validate(value);
  const body = `${canonicalWorkflowControlAuthorityJson(validated)}\n`;
  const bodyHash = sha256(
    `openslack.workflow-runner-authority-binding.${domain}.v1\0${body.slice(0, -1)}`,
  );
  return immutable({
    schema: WORKFLOW_RUNNER_AUTHORITY_BINDING_PREPARED_SCHEMA,
    body,
    bodyHash,
    idempotencyKey: `${WORKFLOW_RUNNER_AUTHORITY_BINDING_IDEMPOTENCY_PREFIX}${bodyHash}`,
    requestFingerprint: `sha256:${sha256(
      `openslack.workflow-runner-authority-binding.fingerprint.v1\0${domain}\0${bodyHash}`,
    )}`,
    value: validated,
  });
}

export function prepareWorkflowRunnerAuthorityBindingStage(
  value: unknown,
): WorkflowRunnerAuthorityBindingPrepared<WorkflowRunnerAuthorityBindingStage> {
  return prepareBindingValue(value, validateWorkflowRunnerAuthorityBindingStage, 'stage');
}

export function prepareWorkflowRunnerAuthorityBindingResolution(
  value: unknown,
): WorkflowRunnerAuthorityBindingPrepared<WorkflowRunnerAuthorityBindingResolution> {
  return prepareBindingValue(value, validateWorkflowRunnerAuthorityBindingResolution, 'resolution');
}

export function prepareWorkflowRunnerAuthorityBindingReceipt(
  value: unknown,
): WorkflowRunnerAuthorityBindingPrepared<WorkflowRunnerAuthorityBindingReceipt> {
  return prepareBindingValue(value, validateWorkflowRunnerAuthorityBindingReceipt, 'receipt');
}

export function prepareWorkflowRunnerAuthorityBindingError(
  value: unknown,
): WorkflowRunnerAuthorityBindingPrepared<WorkflowRunnerAuthorityBindingError> {
  return prepareBindingValue(value, validateWorkflowRunnerAuthorityBindingError, 'error');
}
