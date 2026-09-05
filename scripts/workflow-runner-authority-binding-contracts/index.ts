import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format } from 'prettier';

import {
  WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_SCHEMA,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_RESOLUTION_SCHEMA,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_RECEIPT_SCHEMAS,
  WORKFLOW_RUNNER_AUTHORITY_BINDING_STAGE_SCHEMA,
  WORKFLOW_RUNNER_BUDGET_SOURCE_RESULT_SCHEMA,
  WorkflowRunnerAuthorityBindingContractError,
  deriveWorkflowRunnerAuthorityBindingId,
  hashWorkflowRunnerAuthorityBindingEvidence,
  hashWorkflowRunnerAuthorityBindingReceipt,
  hashWorkflowRunnerAuthorityBindingResolution,
  hashWorkflowRunnerAuthorityBindingStage,
  hashWorkflowRunnerBudgetSourceReceipt,
  parseWorkflowRunnerBudgetDurableReceiptBytes,
  prepareWorkflowRunnerAuthorityBindingReceipt,
  prepareWorkflowRunnerAuthorityBindingResolution,
  prepareWorkflowRunnerAuthorityBindingStage,
  validateWorkflowRunnerAuthorityBindingError,
  validateWorkflowRunnerAuthorityBindingResolution,
  validateWorkflowRunnerAuthorityBindingResolutionForStage,
  validateWorkflowRunnerAuthorityBindingResolutionReceipt,
  validateWorkflowRunnerAuthorityBindingStage,
  validateWorkflowRunnerAuthorityBindingStageReceipt,
  validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage as validateWorkflowRunnerAuthorityControlDeliveryReceiptWithContext,
  validateWorkflowRunnerBudgetSourceResult,
  workflowRunnerAuthorityBindingExpectedKind,
  workflowRunnerAuthorityBindingMissingProviderUsageHash,
  workflowRunnerAuthorityBindingRunnerDelta,
  type WorkflowRunnerAuthorityBindingOperation,
  type WorkflowRunnerAuthorityBindingReceipt,
  type WorkflowRunnerAuthorityBindingResolution,
  type WorkflowRunnerAuthorityBindingStage,
  type WorkflowRunnerBudgetSourceResult,
} from '../../packages/workflows/src/workflow-runner-authority-binding-contract.js';
import {
  WORKFLOW_BUDGET_RECEIPT_SCHEMA,
  WORKFLOW_BUDGET_PREVIOUS_MANIFEST_SHA256,
  canonicalWorkflowBudgetAuthorityJson,
  evaluateWorkflowBudgetReserve,
  hashWorkflowBudgetAuthorityValue,
  parseWorkflowBudgetAuthorityBytes,
  prepareWorkflowBudgetAuthorityRequest,
  validateWorkflowBudgetAccount,
  validateWorkflowBudgetReceipt,
  validateWorkflowBudgetReceiptForResult,
  validateWorkflowBudgetReserveRequest,
  workflowBudgetAuthorityChargeNanoUsd,
  type WorkflowBudgetLedgerEntry,
  type WorkflowBudgetReceipt,
  type WorkflowBudgetReserveDecision,
  validateWorkflowBudgetSettlementRequest,
} from '../../packages/workflows/src/workflow-budget-authority-contract.js';
import {
  WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
  WORKFLOW_CONTROL_AUTHORITY_BUDGET_REVISION_PLANES,
  WORKFLOW_CONTROL_AUTHORITY_PREPARED_SCHEMA,
  WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
  canonicalWorkflowControlAuthorityJson,
  parseWorkflowControlAuthorityMessageBytes,
  prepareWorkflowControlAuthorityMessage,
  validateWorkflowControlAuthorityMessage,
  type WorkflowControlAuthorityMessage,
} from '../../packages/workflows/src/workflow-control-authority-contract.js';
import { canonicalWorkflowEffectJson } from '../../packages/workflows/src/workflow-effect-json.js';
import {
  WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_DOMAINS,
  WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_KEY_PREFIX,
  WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS,
  WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_RECEIPT_SCHEMA,
  WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_SCHEMA,
  prepareWorkflowRunnerV2RuntimeAdmission,
  validateWorkflowRunnerV2RuntimeAdmissionReceipt,
  type WorkflowRunnerV2RuntimeAdmission,
  type WorkflowRunnerV2RuntimeAdmissionReceipt,
} from '../../packages/workflows/src/workflow-runner-runtime-admission-contract.js';

type Json = Record<string, unknown>;

const BUDGET_RUNNER_REVISION_OFFSET = 10;

function independentBudgetRunnerRevision(sourceRevision: number): number {
  const revision = sourceRevision + BUDGET_RUNNER_REVISION_OFFSET;
  if (
    !Number.isSafeInteger(sourceRevision) ||
    sourceRevision < 0 ||
    !Number.isSafeInteger(revision)
  ) {
    throw new Error('Budget source revision cannot produce a safe runner-global fixture revision.');
  }
  return revision;
}

function validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
  receipt: unknown,
  message: unknown,
  stage: unknown,
  resolution: unknown,
  resolutionReceipt: unknown,
  stageReceipt: unknown,
  priorEventDelivery: unknown,
  budgetSourceResult: unknown = null,
) {
  return validateWorkflowRunnerAuthorityControlDeliveryReceiptWithContext(receipt, message, {
    stage,
    resolution,
    resolutionReceipt,
    stageReceipt,
    priorEventDelivery,
    budgetSourceResult,
  });
}

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '../..');
const outputRoot = process.env.OPENSLACK_WORKFLOW_RUNNER_AUTHORITY_BINDING_OUTPUT_ROOT
  ? resolve(process.env.OPENSLACK_WORKFLOW_RUNNER_AUTHORITY_BINDING_OUTPUT_ROOT)
  : repositoryRoot;
const contractRoot = resolve(
  outputRoot,
  'packages/workflows/contracts/workflow-runner-authority-binding/v1',
);
const serviceMirrorRoot = resolve(
  outputRoot,
  'services/workflow-control/runnerbindingcontract/generated/v1',
);
function selectedOutputRoots(): readonly (readonly [string, string])[] {
  return [
    ['typescript', contractRoot],
    ['go', serviceMirrorRoot],
  ];
}

export const bundleFiles = Object.freeze([
  'schemas/workflow-runner-authority-binding-stage.v1.schema.json',
  'schemas/workflow-runner-authority-binding-resolution.v1.schema.json',
  'schemas/workflow-runner-authority-binding-receipt.v1.schema.json',
  'schemas/workflow-runner-authority-binding-error.v1.schema.json',
  'schemas/workflow-runner-v2-runtime-admission.v1.schema.json',
  'schemas/workflow-runner-v2-runtime-admission-receipt.v1.schema.json',
  'golden-vectors.json',
  'manifest.json',
] as const);

const GOLDEN_BUNDLE_FILE = 'golden-vectors.json' as const;
const MANIFEST_BUNDLE_FILE = 'manifest.json' as const;

const runnerOpenAPIPath = resolve(
  repositoryRoot,
  'services/workflow-control/docs/api/runner-openapi.yaml',
);
const openAPIBindingSchemaStart = '    # BEGIN GENERATED WORKFLOW RUNNER AUTHORITY BINDING SCHEMAS';
const openAPIBindingSchemaEnd = '    # END GENERATED WORKFLOW RUNNER AUTHORITY BINDING SCHEMAS';

const sourceLockPaths = Object.freeze({
  runnerV1Manifest: 'packages/workflows/contracts/workflow-runner/v1/manifest.json',
  authorityV2Manifest: 'packages/workflows/contracts/workflow-control-authority/v2/manifest.json',
  checkpointManifest: 'packages/workflows/contracts/workflow-checkpoint-shadow/v1/manifest.json',
  effectControlManifest: 'packages/workflows/contracts/workflow-effect-control/v1/manifest.json',
  effectShadowManifest: 'packages/workflows/contracts/workflow-effect-shadow/v1/manifest.json',
  budgetManifest: 'packages/workflows/contracts/workflow-budget-authority/v1/manifest.json',
  migration7Up: 'services/workflow-control/migrations/000007_integrate_workflow_runner_v2.up.sql',
  migration7Down:
    'services/workflow-control/migrations/000007_integrate_workflow_runner_v2.down.sql',
} as const satisfies Record<keyof typeof WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS, string>);

const authorityBoundary = Object.freeze({
  batch: 'GS9-F2a',
  normative: true,
  contractOnly: true,
  qualificationOnly: true,
  authorityClaim: 'NO_AUTHORITY',
  goAuthorityImplemented: false,
  runtimeCompositionImplemented: false,
  productionRoutingActivated: false,
  frozenAuthorityV2KindsExtended: false,
  frozenAuthorityV2KindCount: 18,
  sourceAuthoritiesReplaced: false,
  notDelivered: Object.freeze([
    'migration_000008',
    'database',
    'http',
    'durable_store',
    'scheduler',
    'worker',
    'checkpoint_adapter',
    'effect_adapter',
    'budget_adapter',
    'resume_adapter',
    'provider_adapter',
    'authority_recovery',
    'runtime_composition',
  ]),
  notActivated: Object.freeze([
    'future_runtime_profile',
    'production_v2_submission',
    'new_record_acceptance',
    'routing',
    'canary',
    'cutover',
    'typescript_fallback_removal',
    'typescript_writer_retirement',
  ]),
  notClaimed: Object.freeze([
    'runtime_authority_delivery',
    'go_production_workflow_authority',
    'go_production_checkpoint_authority',
    'go_production_effect_authority',
    'go_production_budget_policy_authority',
    'go_production_provider_authority',
    'go_production_run_store_authority',
    'go_production_user_visible_read_authority',
    'authenticated_external_host_qualification',
    'qoder',
    'remote_connector',
    'release',
    'live',
    'tag',
    'npm',
    'production_readiness',
  ]),
  separateGates: Object.freeze([
    'hosted_exact_head_checks',
    'review_thread_resolution',
    'independent_human_approval',
    'merge',
  ]),
});

const budgetDecisionDelivery = Object.freeze({
  sourceResultRequired: true,
  durableReceiptSchema: 'openslack.workflow_control_budget_durable_record.v1',
  revisionPlanes: WORKFLOW_CONTROL_AUTHORITY_BUDGET_REVISION_PLANES,
  authorityReceiptHash:
    WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS.budget_reserve.authorityReceiptHashAlgorithm,
  acceptedStates: Object.freeze({
    reserved: 'requested_amounts',
    rejected: 'zero_amounts',
  }),
  databaseReconciliationRequired: Object.freeze({
    delivery: 'event_receipt_only',
    budgetAuthorizationAllowed: false,
    reason: 'accepted_run_revision_null',
  }),
});

const HASH = '^[0-9a-f]{64}$';
const PREFIXED_HASH = '^sha256:[0-9a-f]{64}$';
const SAFE_ID = '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$';
const SAFE_REF = '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$';
const TIME = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
const V2_KEY = '^openslack\\.workflow-control-authority\\.v2\\.[0-9a-f]{64}$';
const RATE = '^(?:0|[1-9][0-9]*)(?:\\.[0-9]{0,17}[1-9])?$';

const H = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const h = (character: string): string => character.repeat(64);

const OPERATION_MATRIX = Object.freeze(
  WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS.map((operation) => ({
    operation,
    targetKind: WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].targetKind,
    completionControlKind:
      WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].completionControlKind,
    runnerDelta: WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].runnerDelta,
    sourcePlane: WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].sourcePlane,
    sourceEvidenceState:
      WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].sourceEvidenceState,
    sourceRevisionDelta:
      WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].sourceRevisionDelta,
    sourceGenerationDelta:
      WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].sourceGenerationDelta,
    sourceReceiptSchema:
      WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].sourceReceiptSchema,
    authorityReceiptHashAlgorithm:
      WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation].authorityReceiptHashAlgorithm,
  })),
);

function asJson(value: unknown, label: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Json;
}

function cloneJson(value: unknown, label: string): Json {
  return asJson(structuredClone(value), label);
}

function requiredExchange(values: Readonly<Record<string, Exchange>>, key: string): Exchange {
  const value = values[key];
  if (value === undefined) {
    throw new Error(`Missing generated exchange ${key}.`);
  }
  return value;
}

function strict(properties: Json, required: readonly string[] = Object.keys(properties)): Json {
  return { type: 'object', additionalProperties: false, properties, required };
}

function routeSchema(): Json {
  const common = {
    routingEpoch: {
      type: 'integer',
      minimum: 1,
      maximum: WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxSafeInteger,
    },
    authorityBuildHash: { type: 'string', pattern: HASH },
  };
  return {
    oneOf: [
      strict({ backend: { const: 'ts-local' }, authority: { const: 'typescript' }, ...common }),
      strict({ backend: { const: 'go' }, authority: { const: 'workflow-control' }, ...common }),
    ],
  };
}

function receiptLifecycleSchema(schema: Json, value: Json): Json {
  const properties = asJson(schema.properties, 'receipt properties');
  const phase = value.phase;
  if (phase === 'control_delivery') {
    properties.status = { const: 'accepted' };
    properties.committedAt = { type: 'string', pattern: TIME };
    properties.reconciliationToken = { type: 'null' };
    properties.disposition = { enum: ['accepted', 'reconciliation_required'] };
    properties.controlKind = {
      enum: [
        'event_receipt',
        'budget_authorization',
        'effect_authorization',
        'resume_offer',
        'cancel_request',
      ],
    };
    return schema;
  }
  if (phase === 'stage_event' || phase === 'commit_authority') {
    properties.status = { enum: ['accepted', 'reconciliation_required'] };
    properties.committedAt = {
      oneOf: [{ type: 'string', pattern: TIME }, { type: 'null' }],
    };
    properties.reconciliationToken = {
      oneOf: [{ type: 'string', pattern: SAFE_REF, maxLength: 512 }, { type: 'null' }],
    };
    schema.allOf = [
      {
        if: { properties: { status: { const: 'accepted' } }, required: ['status'] },
        then: {
          properties: {
            committedAt: { type: 'string', pattern: TIME },
            reconciliationToken: { type: 'null' },
          },
        },
      },
      {
        if: {
          properties: { status: { const: 'reconciliation_required' } },
          required: ['status'],
        },
        then: {
          properties: {
            committedAt: { type: 'null' },
            reconciliationToken: { type: 'string', pattern: SAFE_REF, maxLength: 512 },
          },
        },
      },
    ];
  }
  return schema;
}

function schemaForValue(value: unknown, path: readonly string[] = []): Json {
  const key = path.at(-1) ?? '';
  if (value === null) {
    if (/Hash$/u.test(key)) return { oneOf: [{ type: 'string', pattern: HASH }, { type: 'null' }] };
    if (/(?:Id|Schema|Token|At)$/u.test(key)) {
      return { oneOf: [{ type: 'string', minLength: 1, maxLength: 512 }, { type: 'null' }] };
    }
    return { type: 'null' };
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? { type: 'array', maxItems: 0 }
      : { type: 'array', items: schemaForValue(value[0], [...path, '0']) };
  }
  if (typeof value === 'object') {
    const record = value as Json;
    if (
      Object.keys(record).length === 4 &&
      ['backend', 'authority', 'routingEpoch', 'authorityBuildHash'].every((field) =>
        Object.hasOwn(record, field),
      )
    ) {
      return routeSchema();
    }
    const schema = strict(
      Object.fromEntries(
        Object.entries(record).map(([name, entry]) => [
          name,
          schemaForValue(entry, [...path, name]),
        ]),
      ),
    );
    if (
      record.schema === WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA &&
      typeof record.phase === 'string'
    ) {
      receiptLifecycleSchema(schema, record);
    }
    if (record.schema === 'openslack.workflow_runner_effect_completion_evidence.v1') {
      asJson(schema.properties, 'effect completion properties').status = {
        const: record.status,
      };
    }
    if (record.schema === 'openslack.workflow_runner_effect_authority_evidence.v1') {
      asJson(schema.properties, 'effect authority properties').approvalStatus = {
        const: record.approvalStatus,
      };
    }
    return schema;
  }
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'number') {
    return {
      type: 'integer',
      minimum: 0,
      maximum: WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxSafeInteger,
    };
  }
  if (typeof value !== 'string') throw new Error(`Unsupported schema sample at ${path.join('/')}.`);

  const fixedKeys = new Set([
    'schema',
    'contractVersion',
    'profile',
    'phase',
    'direction',
    'operation',
    'kind',
    'plane',
    'evidenceState',
    'receiptSchema',
    'protocolVersion',
    'authority',
    'goRole',
    'goAuthorityClaim',
    'writer',
    'method',
    'path',
    'commitPoint',
  ]);
  if (fixedKeys.has(key)) return { const: value };
  if (key === 'status') return { type: 'string', minLength: 1, maxLength: 64 };
  if (key === 'approvalStatus') return { enum: ['approved', 'rejected', 'expired'] };
  if (key === 'disposition') return { enum: ['accepted', 'reconciliation_required'] };
  if (key === 'body') {
    return {
      type: 'string',
      minLength: 2,
      maxLength: WORKFLOW_RUNNER_AUTHORITY_BINDING_LIMITS.maxStringBytes,
    };
  }
  if (key === 'idempotencyKey') {
    return {
      type: 'string',
      pattern: value.startsWith('openslack.workflow-control-authority')
        ? V2_KEY
        : '^openslack\\.[A-Za-z0-9._:-]+$',
    };
  }
  if (key === 'requestFingerprint' || value.startsWith('sha256:')) {
    return { type: 'string', pattern: PREFIXED_HASH };
  }
  if (key === 'rateNanoUsdPerToken') {
    return { type: 'string', pattern: RATE, maxLength: 64 };
  }
  if (/(?:Hash|Digest)$/u.test(key)) return { type: 'string', pattern: HASH };
  if (/(?:At|ExpiresAt)$/u.test(key)) return { type: 'string', pattern: TIME };
  if (/(?:Id|Kind)$/u.test(key)) return { type: 'string', pattern: SAFE_ID, maxLength: 256 };
  return { type: 'string', minLength: 1, maxLength: 524_288 };
}

function replaceRootConst(schema: Json, field: string, value: unknown): void {
  const properties = asJson(schema.properties, 'schema properties');
  properties[field] = { const: value };
}

function unionSchema(
  id: string,
  title: string,
  values: readonly unknown[],
  discriminants: readonly string[],
): Json {
  const variants = values.map((value) => {
    const schema = schemaForValue(value);
    const object = asJson(value, 'schema sample');
    for (const field of discriminants) replaceRootConst(schema, field, object[field]);
    return schema;
  });

  const unique = [
    ...new Map(variants.map((variant) => [JSON.stringify(variant), variant])).values(),
  ];
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: id,
    title,
    oneOf: unique,
  };
}

function route(
  buildHash: string,
  backend: 'ts-local' | 'go' = 'ts-local',
  authority: 'typescript' | 'workflow-control' = backend === 'ts-local'
    ? 'typescript'
    : 'workflow-control',
) {
  return {
    backend,
    authority,
    routingEpoch: 1,
    authorityBuildHash: buildHash,
  };
}

interface StageIdentity {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly runId: string;
  readonly runnerAttemptId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly correlationId: string;
  readonly buildHash: string;
  readonly expectedRevision: number;
  readonly expectedGeneration: number;
  readonly sequence: number;
  readonly sentAt: string;
  readonly backend?: 'ts-local' | 'go';
  readonly authority?: 'typescript' | 'workflow-control';
}

function targetMessage(
  operation: WorkflowRunnerAuthorityBindingOperation,
  identity: StageIdentity,
  payload: Json,
): WorkflowControlAuthorityMessage {
  return validateWorkflowControlAuthorityMessage({
    schema: WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
    protocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
    kind: workflowRunnerAuthorityBindingExpectedKind(operation),
    workspaceId: identity.workspaceId,
    jobId: identity.jobId,
    workflowRunId: identity.runId,
    attemptId: identity.runnerAttemptId,
    leaseId: identity.leaseId,
    fencingToken: identity.fencingToken,
    sequence: identity.sequence,
    authorityBackend: identity.backend ?? 'ts-local',
    authority:
      identity.authority ?? (identity.backend === 'go' ? 'workflow-control' : 'typescript'),
    routingEpoch: 1,
    authorityBuildHash: identity.buildHash,
    runRevision: identity.expectedRevision,
    resumeGeneration: identity.expectedGeneration,
    eventId: `binding-${operation}-${identity.sequence}`,
    correlationId: identity.correlationId,
    sentAt: identity.sentAt,
    payload,
  });
}

function stage(
  operation: WorkflowRunnerAuthorityBindingOperation,
  identity: StageIdentity,
  payload: Json,
): WorkflowRunnerAuthorityBindingStage {
  const message = targetMessage(operation, identity, payload);
  const prepared = prepareWorkflowControlAuthorityMessage(message);
  const delta = workflowRunnerAuthorityBindingRunnerDelta(operation);
  const input = {
    schema: WORKFLOW_RUNNER_AUTHORITY_BINDING_STAGE_SCHEMA,
    contractVersion: WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
    profile: WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
    phase: 'stage_event',
    direction: 'runner-to-control',
    companionSequence: 1,
    bindingId: 'placeholder',
    operation,
    workspaceId: identity.workspaceId,
    jobId: identity.jobId,
    runId: identity.runId,
    runnerAttemptId: identity.runnerAttemptId,
    leaseId: identity.leaseId,
    fencingToken: identity.fencingToken,
    route: route(identity.buildHash, identity.backend, identity.authority),
    runnerAuthority: {
      expectedGlobalRunRevision: identity.expectedRevision,
      acceptedGlobalRunRevision: identity.expectedRevision + delta.revision,
      expectedResumeGeneration: identity.expectedGeneration,
      acceptedResumeGeneration: identity.expectedGeneration + delta.generation,
    },
    target: {
      schema: WORKFLOW_CONTROL_AUTHORITY_PREPARED_SCHEMA,
      eventId: message.eventId,
      kind: message.kind,
      sequence: message.sequence!,
      body: prepared.body,
      messageDigest: prepared.messageDigest,
      idempotencyKey: prepared.idempotencyKey,
      requestFingerprint: prepared.requestFingerprint,
    },
    correlationId: identity.correlationId,
    sentAt: identity.sentAt,
  } as const;
  return validateWorkflowRunnerAuthorityBindingStage({
    ...input,
    bindingId: deriveWorkflowRunnerAuthorityBindingId(input),
  });
}

function sourceAuthority(
  operation: WorkflowRunnerAuthorityBindingOperation,
  input: {
    expectedRevision: number;
    expectedGeneration: number;
    requestHash: string;
    recordHash?: string;
    receiptHash?: string;
    buildHash: string;
  },
) {
  const prepared = operation === 'budget_reserve' || operation === 'budget_settle';
  return {
    plane:
      operation === 'checkpoint_commit'
        ? 'checkpoint_control'
        : operation === 'effect_authorize' || operation === 'effect_complete'
          ? 'effect_v2_sibling'
          : prepared
            ? 'budget_account'
            : 'resume_control',
    evidenceState: prepared ? 'prepared' : 'committed',
    expectedRevision: input.expectedRevision,
    acceptedRevision: prepared ? null : input.expectedRevision + 1,
    expectedResumeGeneration: input.expectedGeneration,
    acceptedResumeGeneration: input.expectedGeneration + (operation === 'resume_advance' ? 1 : 0),
    requestHash: input.requestHash,
    receiptSchema: WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_RECEIPT_SCHEMAS[operation],
    receiptHash: prepared ? null : (input.receiptHash ?? h('a')),
    recordHash: prepared ? null : (input.recordHash ?? h('b')),
    authorityBuildHash: input.buildHash,
  } as const;
}

interface Exchange {
  readonly stage: WorkflowRunnerAuthorityBindingStage;
  readonly stageReceipt: WorkflowRunnerAuthorityBindingReceipt;
  readonly resolution: WorkflowRunnerAuthorityBindingResolution;
  readonly resolutionReceipt: WorkflowRunnerAuthorityBindingReceipt;
}

function acceptedStageReceipt(
  staged: WorkflowRunnerAuthorityBindingStage,
  offset: number,
): WorkflowRunnerAuthorityBindingReceipt {
  return validateWorkflowRunnerAuthorityBindingStageReceipt(
    {
      schema: WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA,
      contractVersion: WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
      profile: WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
      direction: 'control-to-runner',
      phase: 'stage_event',
      companionSequence: 1,
      bindingId: staged.bindingId,
      operation: staged.operation,
      status: 'accepted',
      controlBuildHash: staged.route.authorityBuildHash,
      committedAt: `2026-08-20T00:${String(offset).padStart(2, '0')}:01.000Z`,
      reconciliationToken: null,
      requestHash: hashWorkflowRunnerAuthorityBindingStage(staged),
      targetEventId: staged.target.eventId,
      targetBodyHash: staged.target.messageDigest,
      evidenceHash: null,
    },
    staged,
  );
}

function exchange(
  staged: WorkflowRunnerAuthorityBindingStage,
  evidence: unknown,
  offset: number,
): Exchange {
  const stageReceipt = acceptedStageReceipt(staged, offset);
  const resolution = validateWorkflowRunnerAuthorityBindingResolutionForStage(
    {
      schema: WORKFLOW_RUNNER_AUTHORITY_BINDING_RESOLUTION_SCHEMA,
      contractVersion: WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
      profile: WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
      phase: 'commit_authority',
      direction: 'runner-to-control',
      companionSequence: 2,
      bindingId: staged.bindingId,
      operation: staged.operation,
      stageHash: hashWorkflowRunnerAuthorityBindingStage(staged),
      stageReceiptHash: hashWorkflowRunnerAuthorityBindingReceipt(stageReceipt),
      targetBodyHash: staged.target.messageDigest,
      evidence,
      evidenceHash: hashWorkflowRunnerAuthorityBindingEvidence(evidence, staged.operation),
      sentAt: `2026-08-20T00:${String(offset).padStart(2, '0')}:02.000Z`,
    },
    staged,
    stageReceipt,
  );
  const resolutionReceipt = validateWorkflowRunnerAuthorityBindingResolutionReceipt(
    {
      schema: WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA,
      contractVersion: WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
      profile: WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
      direction: 'control-to-runner',
      phase: 'commit_authority',
      companionSequence: 2,
      bindingId: staged.bindingId,
      operation: staged.operation,
      status: 'accepted',
      controlBuildHash: resolution.evidence.sourceAuthority.authorityBuildHash,
      committedAt: `2026-08-20T00:${String(offset).padStart(2, '0')}:03.000Z`,
      reconciliationToken: null,
      requestHash: hashWorkflowRunnerAuthorityBindingResolution(resolution),
      targetEventId: staged.target.eventId,
      targetBodyHash: staged.target.messageDigest,
      stageHash: resolution.stageHash,
      stageReceiptHash: resolution.stageReceiptHash,
      evidenceHash: resolution.evidenceHash,
    },
    resolution,
    staged,
    stageReceipt,
  );
  return { stage: staged, stageReceipt, resolution, resolutionReceipt };
}

function settlementStageDrift(
  original: Exchange,
  field:
    | 'providerReceiptHash'
    | 'actualTokens'
    | 'actualCostNanoUsd'
    | 'actualCalls'
    | 'settlementStatus',
  value: string,
): {
  readonly resolution: WorkflowRunnerAuthorityBindingResolution;
  readonly stage: WorkflowRunnerAuthorityBindingStage;
  readonly stageReceipt: WorkflowRunnerAuthorityBindingReceipt;
} {
  const originalMessage = asJson(
    parseWorkflowControlAuthorityMessageBytes(Buffer.from(original.stage.target.body, 'utf8')),
    'budget settlement message',
  );
  const payload = structuredClone(asJson(originalMessage.payload, 'budget settlement payload'));
  payload[field] = value;
  const staged = stage(
    'budget_settle',
    {
      workspaceId: original.stage.workspaceId,
      jobId: original.stage.jobId,
      runId: original.stage.runId,
      runnerAttemptId: original.stage.runnerAttemptId,
      leaseId: original.stage.leaseId,
      fencingToken: original.stage.fencingToken,
      correlationId: original.stage.correlationId,
      buildHash: original.stage.route.authorityBuildHash,
      expectedRevision: original.stage.runnerAuthority.expectedGlobalRunRevision,
      expectedGeneration: original.stage.runnerAuthority.expectedResumeGeneration,
      sequence: original.stage.target.sequence,
      sentAt: original.stage.sentAt,
      backend: original.stage.route.backend,
      authority: original.stage.route.authority,
    },
    payload,
  );
  const stageReceipt = acceptedStageReceipt(staged, 5);
  const candidate = cloneJson(original.resolution, 'drifted settlement resolution');
  candidate.bindingId = staged.bindingId;
  candidate.stageHash = hashWorkflowRunnerAuthorityBindingStage(staged);
  candidate.stageReceiptHash = hashWorkflowRunnerAuthorityBindingReceipt(stageReceipt);
  candidate.targetBodyHash = staged.target.messageDigest;
  return {
    stage: staged,
    stageReceipt,
    resolution: validateWorkflowRunnerAuthorityBindingResolution(candidate),
  };
}

async function sourceGolden(path: string): Promise<Json> {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), 'utf8')) as Json;
}

async function makeExchanges(
  budgetRecords: Json,
): Promise<Record<WorkflowRunnerAuthorityBindingOperation, Exchange>> {
  const checkpointGolden = await sourceGolden(
    'packages/workflows/contracts/workflow-checkpoint-shadow/v1/golden-vectors.json',
  );
  const checkpointVectors = asJson(checkpointGolden.vectors, 'checkpoint vectors');
  const checkpointEnvelope = asJson(
    asJson(checkpointVectors.checkpointCommit, 'checkpoint vector').value,
    'checkpoint envelope',
  );
  const resumeEnvelope = asJson(
    asJson(checkpointVectors.resumeAdvance, 'resume vector').value,
    'resume envelope',
  );
  const checkpointObservation = asJson(checkpointEnvelope.observation, 'checkpoint observation');
  const resumeObservation = asJson(resumeEnvelope.observation, 'resume observation');
  const checkpointRunner = asJson(checkpointObservation.runner, 'checkpoint runner');
  const resumeRunner = asJson(resumeObservation.runner, 'resume runner');
  const checkpointRecord = asJson(checkpointObservation.checkpoint, 'checkpoint record');
  const priorCheckpoint = asJson(resumeObservation.priorCheckpoint, 'prior checkpoint');

  const checkpointEnvelopeHash = H(canonicalWorkflowControlAuthorityJson(checkpointEnvelope));
  const resumeEnvelopeHash = H(canonicalWorkflowControlAuthorityJson(resumeEnvelope));
  const checkpointStage = stage(
    'checkpoint_commit',
    {
      workspaceId: checkpointRunner.workspaceId as string,
      jobId: checkpointRunner.jobId as string,
      runId: checkpointObservation.runId as string,
      runnerAttemptId: checkpointRunner.attemptId as string,
      leaseId: checkpointRunner.leaseId as string,
      fencingToken: checkpointRunner.fencingToken as number,
      correlationId: checkpointRunner.correlationId as string,
      buildHash: checkpointRunner.runnerBuildHash as string,
      expectedRevision: 10,
      expectedGeneration: checkpointObservation.resumeGeneration as number,
      sequence: 11,
      sentAt: '2026-08-20T00:01:00.000Z',
    },
    {
      checkpointId: checkpointRecord.checkpointId,
      phaseId: checkpointRecord.phaseId,
      phaseIndex: checkpointRecord.phaseIndex,
      commitPoint: checkpointRecord.commitPoint,
      artifactRef: checkpointRecord.artifactRef,
      artifactHash: checkpointRecord.artifactHash,
      resultHash: checkpointRecord.resultHash,
      cacheKeyHash: checkpointRecord.cacheKeyHash,
      workflowSourceHash: checkpointObservation.workflowSourceHash,
      manifestHash: checkpointObservation.manifestHash,
      inputHash: checkpointObservation.inputHash,
    },
  );
  const checkpointEvidence = {
    schema: 'openslack.workflow_runner_checkpoint_authority_evidence.v1',
    sourceAuthority: sourceAuthority('checkpoint_commit', {
      expectedRevision: (checkpointObservation.revision as number) - 1,
      expectedGeneration: checkpointObservation.resumeGeneration as number,
      requestHash: checkpointEnvelopeHash,
      recordHash: checkpointEnvelope.observationHash as string,
      receiptHash: h('c'),
      buildHash: checkpointRunner.runnerBuildHash as string,
    }),
    envelope: checkpointEnvelope,
    envelopeHash: checkpointEnvelopeHash,
  };

  const resumeStage = stage(
    'resume_advance',
    {
      workspaceId: resumeRunner.workspaceId as string,
      jobId: resumeRunner.jobId as string,
      runId: resumeObservation.runId as string,
      runnerAttemptId: resumeRunner.attemptId as string,
      leaseId: resumeRunner.leaseId as string,
      fencingToken: resumeRunner.fencingToken as number,
      correlationId: resumeRunner.correlationId as string,
      buildHash: resumeRunner.runnerBuildHash as string,
      expectedRevision: 20,
      expectedGeneration: (resumeObservation.resumeGeneration as number) - 1,
      sequence: 21,
      sentAt: '2026-08-20T00:06:00.000Z',
    },
    {
      acceptedAt: '2026-08-20T00:06:00.000Z',
      leaseExpiresAt: '2026-08-20T00:16:00.000Z',
    },
  );
  const resumeEvidence = {
    schema: 'openslack.workflow_runner_resume_authority_evidence.v1',
    sourceAuthority: sourceAuthority('resume_advance', {
      expectedRevision: (resumeObservation.revision as number) - 1,
      expectedGeneration: (resumeObservation.resumeGeneration as number) - 1,
      requestHash: resumeEnvelopeHash,
      recordHash: resumeEnvelope.observationHash as string,
      receiptHash: h('d'),
      buildHash: resumeRunner.runnerBuildHash as string,
    }),
    envelope: resumeEnvelope,
    envelopeHash: resumeEnvelopeHash,
    priorCheckpointId: priorCheckpoint.checkpointId,
    priorCheckpointHash: H(canonicalWorkflowControlAuthorityJson(priorCheckpoint)),
    nextPhaseId: resumeObservation.nextPhaseId,
    nextPhaseIndex: resumeObservation.nextPhaseIndex,
    logicalResumeAttemptId: 'logical.resume.attempt.1',
    expiresAt: '2026-08-20T00:16:00.000Z',
  };

  const effectBuild = h('1');
  const effectIdentity = {
    workspaceId: 'workspace.effect',
    jobId: 'job.effect',
    runId: 'run.effect',
    runnerAttemptId: 'attempt.effect',
    leaseId: 'lease.effect',
    fencingToken: 9,
    correlationId: 'correlation.effect',
    buildHash: effectBuild,
    expectedRevision: 30,
    expectedGeneration: 0,
    sequence: 31,
    sentAt: '2026-08-20T00:02:00.000Z',
  } as const;
  const effectHash = h('2');
  const capabilityHash = h('3');
  const intentBindingHash = h('4');
  const effectStage = stage('effect_authorize', effectIdentity, {
    effectId: 'effect.1',
    effectKind: 'collaboration.event',
    effectHash,
    capabilityHash,
    requiresHumanDecision: true,
  });
  const grantHash = h('5');
  const effectEvidence = {
    schema: 'openslack.workflow_runner_effect_authority_evidence.v1',
    sourceAuthority: sourceAuthority('effect_authorize', {
      expectedRevision: 0,
      expectedGeneration: 0,
      requestHash: intentBindingHash,
      recordHash: h('6'),
      receiptHash: h('7'),
      buildHash: effectBuild,
    }),
    occurrenceId: 'occurrence.1',
    intentBindingHash,
    effectId: 'effect.1',
    effectHash,
    capabilityHash,
    approvalId: 'approval.1',
    approvalStatus: 'approved',
    approvalRecordHash: h('8'),
    approvalDecisionHash: h('9'),
    decisionRevision: 1,
    humanBindingHash: h('a'),
    attestationHash: h('b'),
    executionId: 'execution.1',
    claimHash: grantHash,
    grantHash,
    expiresAt: '2026-08-20T00:12:00.000Z',
  };

  const completionIdentity = {
    ...effectIdentity,
    expectedRevision: 31,
    sequence: 32,
    sentAt: '2026-08-20T00:03:00.000Z',
  };
  const outcomeHash = h('c');
  const completionStage = stage('effect_complete', completionIdentity, {
    effectId: 'effect.1',
    status: 'executed',
    outcomeHash,
  });
  const completionEvidence = {
    schema: 'openslack.workflow_runner_effect_completion_evidence.v1',
    sourceAuthority: sourceAuthority('effect_complete', {
      expectedRevision: 1,
      expectedGeneration: 0,
      requestHash: grantHash,
      recordHash: h('d'),
      receiptHash: h('e'),
      buildHash: effectBuild,
    }),
    occurrenceId: 'occurrence.1',
    effectId: 'effect.1',
    effectHash,
    executionId: 'execution.1',
    claimHash: grantHash,
    status: 'executed',
    outcomeHash,
    reconciliationToken: null,
  };

  const preparedReserve = asJson(
    asJson(budgetRecords.preparedReserve, 'prepared reserve').value,
    'prepared reserve value',
  );
  const preparedSettlement = asJson(
    asJson(budgetRecords.preparedSettlement, 'prepared settlement').value,
    'prepared settlement value',
  );
  const reserveRequest = validateWorkflowBudgetReserveRequest(
    parseWorkflowBudgetAuthorityBytes(Buffer.from(preparedReserve.body as string, 'utf8')),
  );
  const settlementRequest = validateWorkflowBudgetSettlementRequest(
    parseWorkflowBudgetAuthorityBytes(Buffer.from(preparedSettlement.body as string, 'utf8')),
  );
  const reserveRoute = reserveRequest.route;
  const reserveIdentity: StageIdentity = {
    workspaceId: reserveRequest.workspaceId as string,
    jobId: 'job.budget',
    runId: reserveRequest.runId as string,
    runnerAttemptId: 'attempt.budget',
    leaseId: 'lease.budget',
    fencingToken: 11,
    correlationId: reserveRequest.correlationId as string,
    buildHash: reserveRoute.authorityBuildHash as string,
    expectedRevision: independentBudgetRunnerRevision(reserveRequest.expectedRunRevision),
    expectedGeneration: 0,
    sequence: 41,
    sentAt: '2026-08-20T00:04:00.000Z',
  };
  const reserveStage = stage('budget_reserve', reserveIdentity, {
    reservationId: reserveRequest.reservationId,
    callId: reserveRequest.callId,
    policyHash: reserveRequest.policyHash,
    requestedTokens: asJson(reserveRequest.requested, 'requested').tokens,
    requestedCostNanoUsd: asJson(reserveRequest.requested, 'requested').nanoUsd,
    requestedCalls: asJson(reserveRequest.requested, 'requested').calls,
  });
  const reserveEvidence = {
    schema: 'openslack.workflow_runner_budget_authority_evidence.v1',
    sourceAuthority: sourceAuthority('budget_reserve', {
      expectedRevision: reserveRequest.expectedAccountRevision as number,
      expectedGeneration: 0,
      requestHash: preparedReserve.requestHash as string,
      buildHash: reserveRoute.authorityBuildHash as string,
    }),
    preparedRequest: preparedReserve,
    providerHash: reserveRequest.expectedProviderHash,
    modelHash: reserveRequest.expectedModelHash,
    providerRunHash: reserveRequest.expectedProviderRunHash,
    providerAttempt: reserveRequest.providerAttempt,
    accountId: reserveRequest.accountId,
    policyHash: reserveRequest.policyHash,
    rateNanoUsdPerToken: reserveRequest.rateNanoUsdPerToken,
    providerUsageReceiptHash: null,
  };

  const usage = asJson(settlementRequest.providerUsage, 'provider usage');
  const settlementRoute = asJson(settlementRequest.route, 'settlement route');
  const settleIdentity: StageIdentity = {
    ...reserveIdentity,
    correlationId: settlementRequest.correlationId as string,
    buildHash: settlementRoute.authorityBuildHash as string,
    expectedRevision: independentBudgetRunnerRevision(settlementRequest.expectedRunRevision),
    sequence: 42,
    sentAt: '2026-08-20T00:05:00.000Z',
  };
  const settleStage = stage('budget_settle', settleIdentity, {
    reservationId: settlementRequest.reservationId,
    callId: settlementRequest.callId,
    providerReceiptHash: (settlementRequest.usageReceiptHash as string).slice('sha256:'.length),
    actualTokens: usage.totalTokens,
    actualCostNanoUsd: workflowBudgetAuthorityChargeNanoUsd(
      usage.totalTokens,
      settlementRequest.rateNanoUsdPerToken,
    ),
    actualCalls: usage.calls,
    settlementStatus: 'settled',
  });
  const settleEvidence = {
    schema: 'openslack.workflow_runner_budget_authority_evidence.v1',
    sourceAuthority: sourceAuthority('budget_settle', {
      expectedRevision: settlementRequest.expectedAccountRevision as number,
      expectedGeneration: 0,
      requestHash: preparedSettlement.requestHash as string,
      buildHash: settlementRoute.authorityBuildHash as string,
    }),
    preparedRequest: preparedSettlement,
    providerHash: settlementRequest.expectedProviderHash,
    modelHash: settlementRequest.expectedModelHash,
    providerRunHash: settlementRequest.expectedProviderRunHash,
    providerAttempt: settlementRequest.providerAttempt,
    accountId: settlementRequest.accountId,
    policyHash: settlementRequest.policyHash,
    rateNanoUsdPerToken: settlementRequest.rateNanoUsdPerToken,
    providerUsageReceiptHash: settlementRequest.usageReceiptHash,
  };

  return {
    checkpoint_commit: exchange(checkpointStage, checkpointEvidence, 1),
    effect_authorize: exchange(effectStage, effectEvidence, 2),
    effect_complete: exchange(completionStage, completionEvidence, 3),
    budget_reserve: exchange(reserveStage, reserveEvidence, 4),
    budget_settle: exchange(settleStage, settleEvidence, 5),
    resume_advance: exchange(resumeStage, resumeEvidence, 6),
  };
}

function acceptedBudgetReserveReceipt(
  prepared: ReturnType<typeof prepareWorkflowBudgetAuthorityRequest>,
  decision: WorkflowBudgetReserveDecision,
  ledgerEntry: WorkflowBudgetLedgerEntry,
): WorkflowBudgetReceipt {
  const request = decision.request;
  const receipt = validateWorkflowBudgetReceipt({
    schema: WORKFLOW_BUDGET_RECEIPT_SCHEMA,
    contractVersion: decision.contractVersion,
    authority: decision.authority,
    writer: decision.writer,
    goRole: decision.goRole,
    goAuthorityClaim: decision.goAuthorityClaim,
    goAuthorityEligible: decision.goAuthorityEligible,
    operation: 'reserve',
    status: 'accepted',
    workspaceId: request.workspaceId,
    runId: request.runId,
    accountId: request.accountId,
    reservationId: request.reservationId,
    callId: request.callId,
    expectedAccountRevision: request.expectedAccountRevision,
    acceptedAccountRevision: decision.afterAccount.accountRevision,
    expectedRunRevision: request.expectedRunRevision,
    acceptedRunRevision: decision.afterAccount.runRevision,
    idempotencyKey: prepared.idempotencyKey,
    requestFingerprint: prepared.requestFingerprint,
    requestHash: prepared.requestHash,
    recordHash: hashWorkflowBudgetAuthorityValue('reserve-decision', decision),
    ledgerEntryHash: hashWorkflowBudgetAuthorityValue('ledger-entry', ledgerEntry),
    correlationId: request.correlationId,
    serviceBuildHash: request.route.authorityBuildHash,
    committedAt: decision.decidedAt,
    reconciliationToken: null,
  });
  return validateWorkflowBudgetReceiptForResult(receipt, prepared, decision, ledgerEntry, null);
}

function exactDurableBudgetReceipt(receipt: WorkflowBudgetReceipt): string {
  return canonicalWorkflowBudgetAuthorityJson({
    schema: 'openslack.workflow_control_budget_durable_record.v1',
    authority: 'workflow-control',
    writer: 'workflow-control/budget-authority-server',
    authorityMode: 'local-qualification-v1',
    productionAuthority: false,
    contractManifestSha256: WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS.budgetManifest,
    authorityBuildHash: receipt.serviceBuildHash,
    recordKind: 'receipt',
    operationalProjection: receipt,
    operationalProjectionHash: hashWorkflowBudgetAuthorityValue('receipt', receipt),
  });
}

function offsetTimestamp(value: string, milliseconds: number): string {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

const BUDGET_DELIVERY_TIMELINE = Object.freeze({
  requestedAt: '2026-08-20T00:06:00.000Z',
  accountUpdatedAt: '2026-08-20T00:05:59.000Z',
  acceptedAt: '2026-08-20T00:06:04.000Z',
  rejectedAt: '2026-08-20T00:06:04.500Z',
  resolutionReceiptCommittedAt: '2026-08-20T00:06:03.000Z',
  priorEventSentAt: '2026-08-20T00:07:00.000Z',
});

function budgetDecisionFixtures(budgetRecords: Json) {
  const account = asJson(asJson(budgetRecords.account, 'budget account').value, 'account value');
  const baseRequest = asJson(
    asJson(budgetRecords.reserveRequest, 'budget reserve request').value,
    'reserve request value',
  );
  const authorityBuildHash = h('8');
  const route = {
    backend: 'go',
    authority: 'workflow-control',
    routingEpoch: 1,
    authorityBuildHash,
  } as const;
  const request = validateWorkflowBudgetReserveRequest({
    ...baseRequest,
    route,
    requestedAt: BUDGET_DELIVERY_TIMELINE.requestedAt,
  });
  const prepared = prepareWorkflowBudgetAuthorityRequest(
    'reserve',
    request,
    'qualification-caller',
  );
  const staged = stage(
    'budget_reserve',
    {
      workspaceId: request.workspaceId,
      jobId: 'job.budget.go',
      runId: request.runId,
      runnerAttemptId: 'attempt.budget.go',
      leaseId: 'lease.budget.go',
      fencingToken: 19,
      correlationId: request.correlationId,
      buildHash: authorityBuildHash,
      expectedRevision: independentBudgetRunnerRevision(request.expectedRunRevision),
      expectedGeneration: 0,
      sequence: 61,
      sentAt: BUDGET_DELIVERY_TIMELINE.requestedAt,
      backend: 'go',
      authority: 'workflow-control',
    },
    {
      reservationId: request.reservationId,
      callId: request.callId,
      policyHash: request.policyHash,
      requestedTokens: request.requested.tokens,
      requestedCostNanoUsd: request.requested.nanoUsd,
      requestedCalls: request.requested.calls,
    },
  );
  const evidence = {
    schema: 'openslack.workflow_runner_budget_authority_evidence.v1',
    sourceAuthority: sourceAuthority('budget_reserve', {
      expectedRevision: request.expectedAccountRevision,
      expectedGeneration: 0,
      requestHash: prepared.requestHash,
      buildHash: authorityBuildHash,
    }),
    preparedRequest: prepared,
    providerHash: request.expectedProviderHash,
    modelHash: request.expectedModelHash,
    providerRunHash: request.expectedProviderRunHash,
    providerAttempt: request.providerAttempt,
    accountId: request.accountId,
    policyHash: request.policyHash,
    rateNanoUsdPerToken: request.rateNanoUsdPerToken,
    providerUsageReceiptHash: null,
  };
  const exchangeValue = exchange(staged, evidence, 6);
  const goAccount = validateWorkflowBudgetAccount({
    ...account,
    route,
    updatedAt: BUDGET_DELIVERY_TIMELINE.accountUpdatedAt,
  });
  const rejectedAccount = validateWorkflowBudgetAccount({
    ...goAccount,
    limit: { tokens: '0', nanoUsd: '0', calls: '0' },
  });
  const reserved = evaluateWorkflowBudgetReserve(
    goAccount,
    request,
    BUDGET_DELIVERY_TIMELINE.acceptedAt,
  );
  const rejected = evaluateWorkflowBudgetReserve(
    rejectedAccount,
    request,
    BUDGET_DELIVERY_TIMELINE.rejectedAt,
  );
  const early = evaluateWorkflowBudgetReserve(
    goAccount,
    request,
    offsetTimestamp(BUDGET_DELIVERY_TIMELINE.resolutionReceiptCommittedAt, -1),
  );
  const late = evaluateWorkflowBudgetReserve(
    goAccount,
    request,
    offsetTimestamp(BUDGET_DELIVERY_TIMELINE.priorEventSentAt, 1),
  );
  const resultFor = (
    preparedRequest: ReturnType<typeof prepareWorkflowBudgetAuthorityRequest>,
    decision: WorkflowBudgetReserveDecision,
    ledgerEntry: WorkflowBudgetLedgerEntry,
  ): WorkflowRunnerBudgetSourceResult => {
    const receipt = acceptedBudgetReserveReceipt(preparedRequest, decision, ledgerEntry);
    return validateWorkflowRunnerBudgetSourceResult(
      {
        schema: WORKFLOW_RUNNER_BUDGET_SOURCE_RESULT_SCHEMA,
        durableReceiptBytes: exactDurableBudgetReceipt(receipt),
        decision,
        ledgerEntry,
      },
      preparedRequest,
    );
  };
  const siblingAccount = validateWorkflowBudgetAccount({
    ...goAccount,
    runRevision: goAccount.runRevision + 10,
  });
  const siblingRequest = validateWorkflowBudgetReserveRequest({
    ...request,
    reservationId: `${request.reservationId}.sibling`,
    callId: `${request.callId}.sibling`,
    correlationId: `${request.correlationId}.sibling`,
    expectedRunRevision: siblingAccount.runRevision,
    requestedAt: '2026-08-20T00:06:00.250Z',
  });
  const siblingPrepared = prepareWorkflowBudgetAuthorityRequest(
    'reserve',
    siblingRequest,
    'qualification-caller',
  );
  const siblingEvaluation = evaluateWorkflowBudgetReserve(
    siblingAccount,
    siblingRequest,
    '2026-08-20T00:06:04.250Z',
  );
  return {
    exchange: exchangeValue,
    prepared,
    reserved: resultFor(prepared, reserved.decision, reserved.ledgerEntry),
    rejected: resultFor(prepared, rejected.decision, rejected.ledgerEntry),
    early: resultFor(prepared, early.decision, early.ledgerEntry),
    late: resultFor(prepared, late.decision, late.ledgerEntry),
    sibling: resultFor(siblingPrepared, siblingEvaluation.decision, siblingEvaluation.ledgerEntry),
  };
}

function effectSemanticVariants(
  exchanges: Record<WorkflowRunnerAuthorityBindingOperation, Exchange>,
): Record<string, Exchange> {
  const authorized = exchanges.effect_authorize;
  const authorizedEvidence = asJson(authorized.resolution.evidence, 'authorized effect evidence');
  const baseEffect = {
    effectId: authorizedEvidence.effectId as string,
    effectHash: authorizedEvidence.effectHash as string,
    capabilityHash: authorizedEvidence.capabilityHash as string,
    occurrenceId: authorizedEvidence.occurrenceId as string,
    buildHash: authorized.stage.route.authorityBuildHash,
  };
  const authorization = (status: 'rejected' | 'expired', index: number): Exchange => {
    const intentBindingHash = H(`semantic-effect-${status}`);
    const staged = stage(
      'effect_authorize',
      {
        workspaceId: authorized.stage.workspaceId,
        jobId: authorized.stage.jobId,
        runId: authorized.stage.runId,
        runnerAttemptId: authorized.stage.runnerAttemptId,
        leaseId: authorized.stage.leaseId,
        fencingToken: authorized.stage.fencingToken,
        correlationId: authorized.stage.correlationId,
        buildHash: baseEffect.buildHash,
        expectedRevision: 32 + index,
        expectedGeneration: 0,
        sequence: 50 + index,
        sentAt: `2026-08-20T00:1${index}:00.000Z`,
      },
      {
        effectId: baseEffect.effectId,
        effectKind: 'collaboration.event',
        effectHash: baseEffect.effectHash,
        capabilityHash: baseEffect.capabilityHash,
        requiresHumanDecision: true,
      },
    );
    const expectedSourceRevision = 10 + index;
    const decided = status === 'rejected';
    const evidence = {
      schema: 'openslack.workflow_runner_effect_authority_evidence.v1',
      sourceAuthority: sourceAuthority('effect_authorize', {
        expectedRevision: expectedSourceRevision,
        expectedGeneration: 0,
        requestHash: intentBindingHash,
        recordHash: H(`effect-${status}-record`),
        receiptHash: H(`effect-${status}-receipt`),
        buildHash: baseEffect.buildHash,
      }),
      occurrenceId: `${baseEffect.occurrenceId}.${status}`,
      intentBindingHash,
      effectId: baseEffect.effectId,
      effectHash: baseEffect.effectHash,
      capabilityHash: baseEffect.capabilityHash,
      approvalId: `approval.${status}`,
      approvalStatus: status,
      approvalRecordHash: decided ? H(`approval-${status}`) : null,
      approvalDecisionHash: decided ? H(`decision-${status}`) : null,
      decisionRevision: expectedSourceRevision + 1,
      humanBindingHash: decided ? H(`human-${status}`) : null,
      attestationHash: decided ? H(`attestation-${status}`) : null,
      executionId: null,
      claimHash: null,
      grantHash: null,
      expiresAt: status === 'expired' ? '2026-08-20T00:12:02.000Z' : '2026-08-20T00:21:00.000Z',
    };
    return exchange(staged, evidence, 10 + index);
  };

  const completed = exchanges.effect_complete;
  const completedEvidence = asJson(completed.resolution.evidence, 'completed effect evidence');
  const completion = (status: 'failed' | 'reconciliation_required', index: number): Exchange => {
    const outcomeHash = H(`semantic-effect-outcome-${status}`);
    const staged = stage(
      'effect_complete',
      {
        workspaceId: completed.stage.workspaceId,
        jobId: completed.stage.jobId,
        runId: completed.stage.runId,
        runnerAttemptId: completed.stage.runnerAttemptId,
        leaseId: completed.stage.leaseId,
        fencingToken: completed.stage.fencingToken,
        correlationId: completed.stage.correlationId,
        buildHash: completed.stage.route.authorityBuildHash,
        expectedRevision: 40 + index,
        expectedGeneration: 0,
        sequence: 60 + index,
        sentAt: `2026-08-20T00:1${index + 2}:00.000Z`,
      },
      { effectId: completedEvidence.effectId, status, outcomeHash },
    );
    const claimHash = completedEvidence.claimHash as string;
    const evidence = {
      schema: 'openslack.workflow_runner_effect_completion_evidence.v1',
      sourceAuthority: sourceAuthority('effect_complete', {
        expectedRevision: 20 + index,
        expectedGeneration: 0,
        requestHash: claimHash,
        recordHash: H(`completion-${status}-record`),
        receiptHash: H(`completion-${status}-receipt`),
        buildHash: completed.stage.route.authorityBuildHash,
      }),
      occurrenceId: `${completedEvidence.occurrenceId as string}.${status}`,
      effectId: completedEvidence.effectId,
      effectHash: completedEvidence.effectHash,
      executionId: completedEvidence.executionId,
      claimHash,
      status,
      outcomeHash,
      reconciliationToken:
        status === 'reconciliation_required' ? 'reconcile.effect.completion' : null,
    };
    return exchange(staged, evidence, 12 + index);
  };

  return {
    effectAuthorizeRejected: authorization('rejected', 1),
    effectAuthorizeExpired: authorization('expired', 2),
    effectCompleteFailed: completion('failed', 1),
    effectCompleteReconciliation: completion('reconciliation_required', 2),
  };
}

function goRouteSemanticVariant(
  exchanges: Record<WorkflowRunnerAuthorityBindingOperation, Exchange>,
): Exchange {
  const checkpoint = exchanges.checkpoint_commit;
  const target = parseWorkflowControlAuthorityMessageBytes(
    Buffer.from(checkpoint.stage.target.body, 'utf8'),
  );
  const staged = stage(
    'checkpoint_commit',
    {
      workspaceId: checkpoint.stage.workspaceId,
      jobId: checkpoint.stage.jobId,
      runId: checkpoint.stage.runId,
      runnerAttemptId: checkpoint.stage.runnerAttemptId,
      leaseId: checkpoint.stage.leaseId,
      fencingToken: checkpoint.stage.fencingToken,
      correlationId: checkpoint.stage.correlationId,
      buildHash: checkpoint.stage.route.authorityBuildHash,
      expectedRevision: checkpoint.stage.runnerAuthority.expectedGlobalRunRevision,
      expectedGeneration: checkpoint.stage.runnerAuthority.expectedResumeGeneration,
      sequence: 81,
      sentAt: '2026-08-20T00:30:00.000Z',
      backend: 'go',
      authority: 'workflow-control',
    },
    target.payload as Json,
  );
  return exchange(staged, structuredClone(checkpoint.resolution.evidence), 30);
}

function firstPhaseResumeSemanticVariant(
  exchanges: Record<WorkflowRunnerAuthorityBindingOperation, Exchange>,
): Exchange {
  const base = exchanges.resume_advance;
  const evidence = cloneJson(base.resolution.evidence, 'phase zero resume');
  const envelope = asJson(evidence.envelope, 'resume envelope');
  const observation = asJson(envelope.observation, 'resume observation');
  observation.priorCheckpoint = null;
  observation.nextPhaseId = 'phase-0';
  observation.nextPhaseIndex = 0;
  envelope.observationHash = H(canonicalWorkflowControlAuthorityJson(observation));
  evidence.envelopeHash = H(canonicalWorkflowControlAuthorityJson(envelope));
  const source = asJson(evidence.sourceAuthority, 'resume source');
  source.requestHash = evidence.envelopeHash;
  source.recordHash = envelope.observationHash;
  evidence.priorCheckpointId = null;
  evidence.priorCheckpointHash = null;
  evidence.nextPhaseId = 'phase-0';
  evidence.nextPhaseIndex = 0;
  return exchange(base.stage, evidence, 6);
}

async function budgetSemanticVariants(
  exchanges: Record<WorkflowRunnerAuthorityBindingOperation, Exchange>,
  records: Json,
): Promise<Record<string, Exchange>> {
  const base = exchanges.budget_settle.stage;

  const settlement = (recordName: string, index: number): Exchange => {
    const record = asJson(asJson(records[recordName], recordName).value, `${recordName} value`);
    const request = validateWorkflowBudgetSettlementRequest(record.request);
    const prepared = prepareWorkflowBudgetAuthorityRequest(
      'settle',
      request,
      'qualification-caller',
    );
    const receiptHash =
      request.usageReceiptHash ??
      workflowRunnerAuthorityBindingMissingProviderUsageHash(prepared.requestHash);
    const staged = stage(
      'budget_settle',
      {
        workspaceId: request.workspaceId,
        jobId: base.jobId,
        runId: request.runId,
        runnerAttemptId: base.runnerAttemptId,
        leaseId: base.leaseId,
        fencingToken: base.fencingToken,
        correlationId: request.correlationId,
        buildHash: request.route.authorityBuildHash,
        expectedRevision: 70 + index,
        expectedGeneration: base.runnerAuthority.expectedResumeGeneration,
        sequence: 70 + index,
        sentAt: `2026-08-20T00:${String(14 + index).padStart(2, '0')}:00.000Z`,
      },
      {
        reservationId: request.reservationId,
        callId: request.callId,
        providerReceiptHash: receiptHash.slice('sha256:'.length),
        actualTokens: '0',
        actualCostNanoUsd: '0',
        actualCalls: '0',
        settlementStatus: 'reconciliation_required',
      },
    );
    const evidence = {
      schema: 'openslack.workflow_runner_budget_authority_evidence.v1',
      sourceAuthority: sourceAuthority('budget_settle', {
        expectedRevision: request.expectedAccountRevision,
        expectedGeneration: 0,
        requestHash: prepared.requestHash,
        buildHash: request.route.authorityBuildHash,
      }),
      preparedRequest: prepared,
      providerHash: request.expectedProviderHash,
      modelHash: request.expectedModelHash,
      providerRunHash: request.expectedProviderRunHash,
      providerAttempt: request.providerAttempt,
      accountId: request.accountId,
      policyHash: request.policyHash,
      rateNanoUsdPerToken: request.rateNanoUsdPerToken,
      providerUsageReceiptHash: receiptHash,
    };
    return exchange(staged, evidence, 20 + index);
  };

  return {
    budgetSettleMissing: settlement('usageMissing', 1),
    budgetSettleUntrusted: settlement('usageUntrusted', 2),
    budgetSettleProviderUnreported: settlement('providerUnknown', 3),
  };
}

type ControlDeliveryKind =
  | 'event_receipt'
  | 'budget_authorization'
  | 'effect_authorization'
  | 'resume_offer'
  | 'cancel_request';

const CONTROL_DELIVERY_TIMELINE = Object.freeze({
  eventReceiptSentAt: BUDGET_DELIVERY_TIMELINE.priorEventSentAt,
  decisionSentAt: '2026-08-20T00:07:02.000Z',
});

function controlMessage(
  exchangeValue: Exchange,
  kind: ControlDeliveryKind,
  budgetSourceResult: WorkflowRunnerBudgetSourceResult | null = null,
): WorkflowControlAuthorityMessage {
  const staged = exchangeValue.stage;
  const target = parseWorkflowControlAuthorityMessageBytes(Buffer.from(staged.target.body, 'utf8'));
  const resolutionEvidence = asJson(exchangeValue.resolution.evidence, 'resolution evidence');
  const decision = kind !== 'event_receipt';
  const sentAt = decision
    ? CONTROL_DELIVERY_TIMELINE.decisionSentAt
    : CONTROL_DELIVERY_TIMELINE.eventReceiptSentAt;
  if (kind === 'budget_authorization' && budgetSourceResult === null) {
    throw new Error('Budget authorization golden requires an exact source result.');
  }
  const authorityReceiptHash =
    kind === 'budget_authorization'
      ? hashWorkflowRunnerBudgetSourceReceipt(budgetSourceResult!.durableReceiptBytes)
      : hashWorkflowRunnerAuthorityBindingReceipt(exchangeValue.resolutionReceipt);
  const head =
    kind === 'resume_offer'
      ? {
          revision: staged.runnerAuthority.expectedGlobalRunRevision,
          generation: staged.runnerAuthority.expectedResumeGeneration,
        }
      : {
          revision: staged.runnerAuthority.acceptedGlobalRunRevision,
          generation: staged.runnerAuthority.acceptedResumeGeneration,
        };
  const common = {
    schema: WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
    protocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
    kind,
    workspaceId: staged.workspaceId,
    jobId: staged.jobId,
    workflowRunId: staged.runId,
    attemptId: staged.runnerAttemptId,
    leaseId: staged.leaseId,
    fencingToken: staged.fencingToken,
    sequence: 100 + staged.target.sequence + (decision ? 1 : 0),
    authorityBackend: staged.route.backend,
    authority: staged.route.authority,
    routingEpoch: staged.route.routingEpoch,
    authorityBuildHash: staged.route.authorityBuildHash,
    runRevision: head.revision,
    resumeGeneration: head.generation,
    eventId: `control-${kind}-${staged.target.sequence}`,
    correlationId: staged.correlationId,
    sentAt,
  };
  let payload: Json;
  switch (kind) {
    case 'event_receipt':
      payload = {
        receivedEventId: target.eventId,
        receivedKind: target.kind,
        receivedSequence: target.sequence,
        receivedDigest: staged.target.messageDigest,
        receivedIdempotencyKey: staged.target.idempotencyKey,
        receivedFingerprint: staged.target.requestFingerprint,
        status: 'accepted',
        controlBuildHash: staged.route.authorityBuildHash,
        committedAt: sentAt,
        errorCode: null,
      };
      break;
    case 'budget_authorization': {
      if (budgetSourceResult === null) {
        throw new Error('Budget authorization requires its exact durable source result.');
      }
      const durableReceipt = parseWorkflowRunnerBudgetDurableReceiptBytes(
        budgetSourceResult.durableReceiptBytes,
      );
      const sourceReceipt = asJson(
        durableReceipt.operationalProjection,
        'durable budget receipt projection',
      );
      const authorization = budgetSourceResult.decision.authorization;
      payload = {
        reservationId: budgetSourceResult.decision.request.reservationId,
        status: budgetSourceResult.decision.status,
        authorizedTokens: authorization.tokens,
        authorizedCostNanoUsd: authorization.nanoUsd,
        authorizedCalls: authorization.calls,
        authorityReceiptHash,
        committedRunRevision: sourceReceipt.acceptedRunRevision,
      };
      break;
    }
    case 'effect_authorization':
      payload = {
        effectId: resolutionEvidence.effectId,
        effectHash: resolutionEvidence.effectHash,
        approvalId: resolutionEvidence.approvalId,
        approvalStatus: resolutionEvidence.approvalStatus,
        decisionRevision: resolutionEvidence.decisionRevision,
        grantHash: resolutionEvidence.grantHash,
        authorityReceiptHash,
        expiresAt: resolutionEvidence.expiresAt,
      };
      break;
    case 'resume_offer':
      payload = {
        checkpointId: resolutionEvidence.priorCheckpointId,
        checkpointHash: resolutionEvidence.priorCheckpointHash,
        nextPhaseId: resolutionEvidence.nextPhaseId,
        nextPhaseIndex: resolutionEvidence.nextPhaseIndex,
        newResumeGeneration: staged.runnerAuthority.acceptedResumeGeneration,
        newAttemptId: resolutionEvidence.logicalResumeAttemptId,
        authorityReceiptHash,
        expiresAt: resolutionEvidence.expiresAt,
      };
      break;
    case 'cancel_request':
      payload = {
        cancelId: 'cancel.binding.1',
        requestedAt: sentAt,
        expiresAt: '2026-08-20T00:08:02.000Z',
        reason: 'operator',
      };
      break;
  }
  return validateWorkflowControlAuthorityMessage({
    ...common,
    payload,
  });
}

function controlDelivery(
  exchangeValue: Exchange,
  message: WorkflowControlAuthorityMessage,
  companionSequence: number,
  disposition: 'accepted' | 'reconciliation_required',
  priorEventDelivery: {
    message: WorkflowControlAuthorityMessage;
    receipt: WorkflowRunnerAuthorityBindingReceipt;
  } | null,
  budgetSourceResult: WorkflowRunnerBudgetSourceResult | null = null,
): WorkflowRunnerAuthorityBindingReceipt {
  const staged = exchangeValue.stage;
  const prepared = prepareWorkflowControlAuthorityMessage(message);
  const processedAt =
    companionSequence === 3 ? '2026-08-20T00:07:01.000Z' : '2026-08-20T00:07:03.000Z';
  const value = {
    schema: WORKFLOW_RUNNER_AUTHORITY_BINDING_RECEIPT_SCHEMA,
    contractVersion: WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
    profile: WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
    direction: 'runner-to-control',
    phase: 'control_delivery',
    companionSequence,
    bindingId: staged.bindingId,
    operation: staged.operation,
    status: 'accepted',
    controlBuildHash: staged.route.authorityBuildHash,
    committedAt: processedAt,
    reconciliationToken: null,
    controlEventId: message.eventId,
    controlKind: message.kind,
    controlSequence: message.sequence,
    messageDigest: prepared.messageDigest,
    runnerAttemptId: staged.runnerAttemptId,
    leaseId: staged.leaseId,
    fencingToken: staged.fencingToken,
    processedAt,
    disposition,
  };
  return validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
    value,
    message,
    staged,
    exchangeValue.resolution,
    exchangeValue.resolutionReceipt,
    exchangeValue.stageReceipt,
    priorEventDelivery,
    budgetSourceResult,
  );
}

function vector(value: unknown, domain: 'stage' | 'resolution' | 'receipt') {
  const prepared =
    domain === 'stage'
      ? prepareWorkflowRunnerAuthorityBindingStage(value)
      : domain === 'resolution'
        ? prepareWorkflowRunnerAuthorityBindingResolution(value)
        : prepareWorkflowRunnerAuthorityBindingReceipt(value);
  return {
    value: prepared.value,
    canonicalBytes: prepared.body,
    byteLength: Buffer.byteLength(prepared.body),
    sha256: H(prepared.body),
    prepared: {
      schema: prepared.schema,
      bodyHash: prepared.bodyHash,
      idempotencyKey: prepared.idempotencyKey,
      requestFingerprint: prepared.requestFingerprint,
    },
  };
}

function runtimeAdmissionVector(
  value: WorkflowRunnerV2RuntimeAdmission,
  body: string,
  idempotencyKey: string,
  requestFingerprint: string,
) {
  return {
    value,
    canonicalBytes: body,
    byteLength: Buffer.byteLength(body),
    sha256: H(body),
    prepared: { idempotencyKey, requestFingerprint },
  };
}

function runtimeAdmissionReceiptVector(value: WorkflowRunnerV2RuntimeAdmissionReceipt) {
  const canonicalBytes = `${canonicalWorkflowEffectJson(value)}\n`;
  return {
    value,
    canonicalBytes,
    byteLength: Buffer.byteLength(canonicalBytes),
    sha256: H(canonicalBytes),
  };
}

function errorOf(operation: () => unknown) {
  try {
    operation();
  } catch (error) {
    if (error instanceof WorkflowRunnerAuthorityBindingContractError) {
      return { name: error.name, code: error.code, path: error.path, message: error.message };
    }
    throw error;
  }
  throw new Error('Negative vector unexpectedly succeeded.');
}

function negative(id: string, operation: string, input: Json, execute: () => unknown): Json {
  return { id, operation, input, expectedError: errorOf(execute) };
}

function exactNegatives(values: Json[]): Json[] {
  const ids = values.map((value) => value.id);
  if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
    throw new Error(`Negative ID inventory is invalid: ${JSON.stringify(ids)}`);
  }
  return values;
}

async function goldenVectors() {
  const budgetGolden = await sourceGolden(
    'packages/workflows/contracts/workflow-budget-authority/v1/golden-vectors.json',
  );
  const budgetRecords = asJson(
    asJson(budgetGolden.vectors, 'budget vectors').records,
    'budget records',
  );
  const exchanges = await makeExchanges(budgetRecords);
  const budgetDecisions = budgetDecisionFixtures(budgetRecords);
  const effectVariants = effectSemanticVariants(exchanges);
  const expiredEffectVariant = requiredExchange(effectVariants, 'effectAuthorizeExpired');
  const rejectedEffectVariant = requiredExchange(effectVariants, 'effectAuthorizeRejected');
  const semanticVariants = {
    ...effectVariants,
    ...(await budgetSemanticVariants(exchanges, budgetRecords)),
    goRouteCheckpoint: goRouteSemanticVariant(exchanges),
    budgetReserveGoAuthority: budgetDecisions.exchange,
    resumeFirstPhase: firstPhaseResumeSemanticVariant(exchanges),
  };
  const controlReceiptMessages = Object.fromEntries(
    WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS.map((operation) => [
      operation,
      controlMessage(exchanges[operation], 'event_receipt'),
    ]),
  ) as Record<WorkflowRunnerAuthorityBindingOperation, WorkflowControlAuthorityMessage>;
  const acceptedDeliveries = Object.fromEntries(
    WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS.map((operation) => [
      operation,
      controlDelivery(exchanges[operation], controlReceiptMessages[operation], 3, 'accepted', null),
    ]),
  ) as Record<WorkflowRunnerAuthorityBindingOperation, WorkflowRunnerAuthorityBindingReceipt>;
  const controlKindInputs = {
    event_receipt: exchanges.checkpoint_commit,
    budget_authorization: budgetDecisions.exchange,
    effect_authorization: exchanges.effect_authorize,
    resume_offer: exchanges.resume_advance,
    cancel_request: exchanges.effect_complete,
  } as const satisfies Record<ControlDeliveryKind, Exchange>;
  const controlKindMessages = Object.fromEntries(
    (Object.keys(controlKindInputs) as ControlDeliveryKind[]).map((kind) => [
      kind,
      controlMessage(
        controlKindInputs[kind],
        kind,
        kind === 'budget_authorization' ? budgetDecisions.reserved : null,
      ),
    ]),
  ) as Record<ControlDeliveryKind, WorkflowControlAuthorityMessage>;
  const budgetPriorMessage = controlMessage(budgetDecisions.exchange, 'event_receipt');
  const budgetPriorReceipt = controlDelivery(
    budgetDecisions.exchange,
    budgetPriorMessage,
    3,
    'accepted',
    null,
  );
  const budgetDatabaseReconciliationMessageValue = cloneJson(
    budgetPriorMessage,
    'budget database reconciliation message',
  );
  const budgetDatabaseReconciliationPayload = asJson(
    budgetDatabaseReconciliationMessageValue.payload,
    'budget database reconciliation event receipt payload',
  );
  budgetDatabaseReconciliationPayload.status = 'reconciliation_required';
  budgetDatabaseReconciliationPayload.errorCode =
    'WORKFLOW_CONTROL_AUTHORITY_RECONCILIATION_REQUIRED';
  const budgetDatabaseReconciliationMessage = validateWorkflowControlAuthorityMessage(
    budgetDatabaseReconciliationMessageValue,
  );
  const budgetDatabaseReconciliationReceipt = controlDelivery(
    budgetDecisions.exchange,
    budgetDatabaseReconciliationMessage,
    3,
    'reconciliation_required',
    null,
  );
  const controlKinds = Object.fromEntries(
    (Object.keys(controlKindInputs) as ControlDeliveryKind[]).map((kind) => [
      kind,
      {
        operation: controlKindInputs[kind].stage.operation,
        message: controlKindMessages[kind],
        receipt: controlDelivery(
          controlKindInputs[kind],
          controlKindMessages[kind],
          kind === 'event_receipt' ? 3 : 4,
          'accepted',
          kind === 'event_receipt'
            ? null
            : kind === 'budget_authorization'
              ? { message: budgetPriorMessage, receipt: budgetPriorReceipt }
              : {
                  message: controlReceiptMessages[controlKindInputs[kind].stage.operation],
                  receipt: acceptedDeliveries[controlKindInputs[kind].stage.operation],
                },
          kind === 'budget_authorization' ? budgetDecisions.reserved : null,
        ),
      },
    ]),
  ) as Record<
    ControlDeliveryKind,
    {
      operation: WorkflowRunnerAuthorityBindingOperation;
      message: WorkflowControlAuthorityMessage;
      receipt: WorkflowRunnerAuthorityBindingReceipt;
    }
  >;
  const rejectedBudgetMessage = controlMessage(
    budgetDecisions.exchange,
    'budget_authorization',
    budgetDecisions.rejected,
  );
  const previousBudgetSource = {
    ...budgetDecisions.reserved,
    durableReceiptBytes: canonicalWorkflowBudgetAuthorityJson({
      ...parseWorkflowRunnerBudgetDurableReceiptBytes(budgetDecisions.reserved.durableReceiptBytes),
      contractManifestSha256: WORKFLOW_BUDGET_PREVIOUS_MANIFEST_SHA256,
    }),
  };
  const previousBudgetMessage = controlMessage(
    budgetDecisions.exchange,
    'budget_authorization',
    previousBudgetSource,
  );
  const previousBudgetReceipt = controlDelivery(
    budgetDecisions.exchange,
    previousBudgetMessage,
    4,
    'accepted',
    { message: budgetPriorMessage, receipt: budgetPriorReceipt },
    previousBudgetSource,
  );
  const budgetAuthorization = {
    reserved: {
      message: controlKindMessages.budget_authorization,
      receipt: controlKinds.budget_authorization.receipt,
      priorEventDelivery: { message: budgetPriorMessage, receipt: budgetPriorReceipt },
      sourceResult: budgetDecisions.reserved,
    },
    rejected: {
      message: rejectedBudgetMessage,
      receipt: controlDelivery(
        budgetDecisions.exchange,
        rejectedBudgetMessage,
        4,
        'accepted',
        { message: budgetPriorMessage, receipt: budgetPriorReceipt },
        budgetDecisions.rejected,
      ),
      priorEventDelivery: { message: budgetPriorMessage, receipt: budgetPriorReceipt },
      sourceResult: budgetDecisions.rejected,
    },
  };
  const deliveries = {
    accepted: acceptedDeliveries,
    reconciliationRequired: controlDelivery(
      exchanges.effect_complete,
      controlKindMessages.cancel_request,
      4,
      'reconciliation_required',
      {
        message: controlReceiptMessages.effect_complete,
        receipt: acceptedDeliveries.effect_complete,
      },
    ),
  };

  const checkpoint = exchanges.checkpoint_commit;
  const badStageUnknown = { ...structuredClone(checkpoint.stage), rawPrompt: 'forbidden' } as Json;
  const badStageRevision = cloneJson(checkpoint.stage, 'bad stage revision');
  asJson(badStageRevision.runnerAuthority, 'runner authority').acceptedGlobalRunRevision = 99;
  const badResolutionHash = cloneJson(checkpoint.resolution, 'bad resolution hash');
  badResolutionHash.evidenceHash = h('0');
  const badStageReceipt = cloneJson(checkpoint.stageReceipt, 'bad stage receipt');
  badStageReceipt.targetEventId = 'event.cross-spliced';
  const badResolutionReceipt = cloneJson(checkpoint.resolutionReceipt, 'bad resolution receipt');
  badResolutionReceipt.evidenceHash = h('f');
  const badControl = cloneJson(deliveries.accepted.checkpoint_commit, 'bad control receipt');
  badControl.messageDigest = h('f');
  const sensitiveEvidence = cloneJson(
    exchanges.effect_authorize.resolution,
    'sensitive effect resolution',
  );
  asJson(sensitiveEvidence.evidence, 'effect evidence').providerId = 'raw-provider';
  const staleResume = cloneJson(exchanges.resume_advance.resolution, 'stale resume resolution');
  asJson(
    asJson(staleResume.evidence, 'resume evidence').sourceAuthority,
    'source authority',
  ).acceptedResumeGeneration = 0;
  const swappedSourceRevision = cloneJson(checkpoint.resolution, 'swapped source revision');
  const swappedEvidence = asJson(swappedSourceRevision.evidence, 'swapped evidence');
  const swappedSource = asJson(swappedEvidence.sourceAuthority, 'swapped source authority');
  const runnerAuthority = checkpoint.stage.runnerAuthority;
  swappedSource.expectedRevision = runnerAuthority.expectedGlobalRunRevision;
  swappedSource.acceptedRevision = runnerAuthority.acceptedGlobalRunRevision;
  const unacceptedStageReceipt = cloneJson(checkpoint.stageReceipt, 'unaccepted stage receipt');
  unacceptedStageReceipt.status = 'reconciliation_required';
  unacceptedStageReceipt.committedAt = null;
  unacceptedStageReceipt.reconciliationToken = 'reconcile.stage.before-resolution';
  const sameKeyBodyDrift = cloneJson(checkpoint.stage, 'same-key body drift');
  const sameKeyTarget = asJson(sameKeyBodyDrift.target, 'same-key target');
  sameKeyTarget.body = (sameKeyTarget.body as string).replace(/\n$/u, ' \n');
  const bodyCrossSplice = cloneJson(checkpoint.stage, 'body cross-splice');
  asJson(bodyCrossSplice.target, 'body cross-splice target').body =
    exchanges.resume_advance.stage.target.body;
  const keyCrossSplice = cloneJson(checkpoint.stage, 'key cross-splice');
  asJson(keyCrossSplice.target, 'key cross-splice target').idempotencyKey =
    exchanges.resume_advance.stage.target.idempotencyKey;
  const fingerprintCrossSplice = cloneJson(checkpoint.stage, 'fingerprint cross-splice');
  asJson(fingerprintCrossSplice.target, 'fingerprint cross-splice target').requestFingerprint =
    exchanges.resume_advance.stage.target.requestFingerprint;
  const alienStageReceipt = exchanges.resume_advance.stageReceipt;
  const alienStageHashResolution = cloneJson(checkpoint.resolution, 'alien stage hash resolution');
  alienStageHashResolution.stageHash = hashWorkflowRunnerAuthorityBindingStage(
    exchanges.resume_advance.stage,
  );
  const driftedResolutionReceiptStageHash = cloneJson(
    checkpoint.resolutionReceipt,
    'drifted resolution receipt stage hash',
  );
  driftedResolutionReceiptStageHash.stageHash = hashWorkflowRunnerAuthorityBindingStage(
    exchanges.resume_advance.stage,
  );
  const checkpointNestedError = cloneJson(checkpoint.resolution, 'checkpoint nested error');
  asJson(
    asJson(checkpointNestedError.evidence, 'checkpoint evidence').envelope,
    'checkpoint envelope',
  ).unexpected = true;
  const checkpointDeepPathError = cloneJson(checkpoint.resolution, 'checkpoint deep path error');
  asJson(
    asJson(
      asJson(
        asJson(checkpointDeepPathError.evidence, 'checkpoint evidence').envelope,
        'checkpoint envelope',
      ).observation,
      'checkpoint observation',
    ).runner,
    'checkpoint runner',
  ).unexpected = true;
  const budgetNestedError = cloneJson(exchanges.budget_reserve.resolution, 'budget nested error');
  asJson(
    asJson(budgetNestedError.evidence, 'budget evidence').preparedRequest,
    'budget prepared request',
  ).unexpected = true;
  const approvedExpiryBoundary = cloneJson(
    exchanges.effect_authorize.resolution,
    'approved expiry boundary',
  );
  asJson(approvedExpiryBoundary.evidence, 'approved effect evidence').expiresAt =
    approvedExpiryBoundary.sentAt;
  approvedExpiryBoundary.evidenceHash = hashWorkflowRunnerAuthorityBindingEvidence(
    approvedExpiryBoundary.evidence,
    'effect_authorize',
  );
  const expiredExpiryFuture = cloneJson(expiredEffectVariant.resolution, 'expired expiry future');
  asJson(expiredExpiryFuture.evidence, 'expired effect evidence').expiresAt =
    '2026-08-20T00:12:03.000Z';
  expiredExpiryFuture.evidenceHash = hashWorkflowRunnerAuthorityBindingEvidence(
    expiredExpiryFuture.evidence,
    'effect_authorize',
  );
  const rejectedExpiryBoundary = cloneJson(
    rejectedEffectVariant.resolution,
    'rejected expiry boundary',
  );
  asJson(rejectedExpiryBoundary.evidence, 'rejected effect evidence').expiresAt =
    rejectedExpiryBoundary.sentAt;
  rejectedExpiryBoundary.evidenceHash = hashWorkflowRunnerAuthorityBindingEvidence(
    rejectedExpiryBoundary.evidence,
    'effect_authorize',
  );
  const badEventMessage = cloneJson(controlKindMessages.event_receipt, 'bad event message');
  asJson(badEventMessage.payload, 'event receipt payload').receivedEventId = 'event.alien';
  const badEventDelivery = cloneJson(controlKinds.event_receipt.receipt, 'bad event delivery');
  badEventDelivery.messageDigest =
    prepareWorkflowControlAuthorityMessage(badEventMessage).messageDigest;
  const badResumeMessage = cloneJson(controlKindMessages.resume_offer, 'bad resume message');
  asJson(badResumeMessage.payload, 'resume offer payload').newAttemptId = 'logical.resume.alien';
  const badResumeDelivery = cloneJson(controlKinds.resume_offer.receipt, 'bad resume delivery');
  badResumeDelivery.messageDigest =
    prepareWorkflowControlAuthorityMessage(badResumeMessage).messageDigest;
  const badBudgetMessage = cloneJson(
    controlKindMessages.budget_authorization,
    'bad budget message',
  );
  asJson(badBudgetMessage.payload, 'budget authorization payload').authorizedTokens = '1';
  const badBudgetDelivery = cloneJson(
    controlKinds.budget_authorization.receipt,
    'bad budget delivery',
  );
  badBudgetDelivery.messageDigest =
    prepareWorkflowControlAuthorityMessage(badBudgetMessage).messageDigest;
  const budgetDeliveryInput = (
    message: unknown,
    receipt: unknown,
    sourceResult: unknown,
  ): Json => ({
    receipt,
    message,
    stage: budgetDecisions.exchange.stage,
    resolution: budgetDecisions.exchange.resolution,
    resolutionReceipt: budgetDecisions.exchange.resolutionReceipt,
    stageReceipt: budgetDecisions.exchange.stageReceipt,
    priorEventDelivery: { message: budgetPriorMessage, receipt: budgetPriorReceipt },
    budgetSourceResult: sourceResult,
  });
  const driftBudgetMessage = (mutate: (payload: Json, message: Json) => void): [Json, Json] => {
    const message = cloneJson(controlKindMessages.budget_authorization, 'drifted budget message');
    mutate(asJson(message.payload, 'budget authorization payload'), message);
    const receipt = cloneJson(controlKinds.budget_authorization.receipt, 'drifted budget receipt');
    receipt.messageDigest = prepareWorkflowControlAuthorityMessage(message).messageDigest;
    return [message, receipt];
  };
  const [budgetStatusDriftMessage, budgetStatusDriftReceipt] = driftBudgetMessage((payload) => {
    payload.status = 'rejected';
    payload.authorizedTokens = '0';
    payload.authorizedCostNanoUsd = '0';
    payload.authorizedCalls = '0';
  });
  const [budgetAmountDriftMessage, budgetAmountDriftReceipt] = driftBudgetMessage((payload) => {
    payload.authorizedCostNanoUsd = '1';
  });
  const [budgetReceiptHashDriftMessage, budgetReceiptHashDriftReceipt] = driftBudgetMessage(
    (payload) => {
      payload.authorityReceiptHash = h('0');
    },
  );
  const [budgetCommittedRunRevisionDriftMessage, budgetCommittedRunRevisionDriftReceipt] =
    driftBudgetMessage((payload) => {
      payload.committedRunRevision = (payload.committedRunRevision as number) + 1;
    });
  const [budgetRunnerEnvelopeRevisionDriftMessage, budgetRunnerEnvelopeRevisionDriftReceipt] =
    driftBudgetMessage((_payload, message) => {
      message.runRevision = (message.runRevision as number) + 1;
    });

  const missingBudgetSourceInput = budgetDeliveryInput(
    controlKindMessages.budget_authorization,
    controlKinds.budget_authorization.receipt,
    null,
  );
  delete missingBudgetSourceInput.budgetSourceResult;
  const nullBudgetSourceInput = budgetDeliveryInput(
    controlKindMessages.budget_authorization,
    controlKinds.budget_authorization.receipt,
    null,
  );
  const nonBudgetSourceInput = {
    receipt: controlKinds.effect_authorization.receipt,
    message: controlKindMessages.effect_authorization,
    stage: exchanges.effect_authorize.stage,
    resolution: exchanges.effect_authorize.resolution,
    resolutionReceipt: exchanges.effect_authorize.resolutionReceipt,
    stageReceipt: exchanges.effect_authorize.stageReceipt,
    priorEventDelivery: {
      message: controlReceiptMessages.effect_authorize,
      receipt: acceptedDeliveries.effect_authorize,
    },
    budgetSourceResult: budgetDecisions.reserved,
  };
  const sourceResultCrossSplice = {
    ...structuredClone(budgetDecisions.reserved),
    decision: budgetDecisions.rejected.decision,
  };
  const decisionRequestCrossSplice = cloneJson(
    budgetDecisions.reserved,
    'decision request cross-splice',
  );
  decisionRequestCrossSplice.decision = structuredClone(budgetDecisions.sibling.decision);
  decisionRequestCrossSplice.ledgerEntry = structuredClone(budgetDecisions.sibling.ledgerEntry);
  const decisionRequestDurable = cloneJson(
    parseWorkflowRunnerBudgetDurableReceiptBytes(decisionRequestCrossSplice.durableReceiptBytes),
    'decision request durable receipt',
  );
  const decisionRequestProjection = asJson(
    decisionRequestDurable.operationalProjection,
    'decision-request cross-splice projection',
  );
  decisionRequestProjection.recordHash = hashWorkflowBudgetAuthorityValue(
    'reserve-decision',
    decisionRequestCrossSplice.decision,
  );
  decisionRequestProjection.ledgerEntryHash = hashWorkflowBudgetAuthorityValue(
    'ledger-entry',
    decisionRequestCrossSplice.ledgerEntry,
  );
  decisionRequestDurable.operationalProjectionHash = hashWorkflowBudgetAuthorityValue(
    'receipt',
    decisionRequestProjection,
  );
  decisionRequestCrossSplice.durableReceiptBytes =
    canonicalWorkflowBudgetAuthorityJson(decisionRequestDurable);
  const driftDurableSource = (
    source: WorkflowRunnerBudgetSourceResult,
    mutate: (durable: Json) => void,
  ): Json => {
    const result = cloneJson(source, 'drifted durable source');
    const durable = cloneJson(
      parseWorkflowRunnerBudgetDurableReceiptBytes(result.durableReceiptBytes),
      'drifted durable receipt',
    );
    mutate(durable);
    result.durableReceiptBytes = canonicalWorkflowBudgetAuthorityJson(durable);
    return result;
  };
  const budgetManifestDrift = driftDurableSource(budgetDecisions.reserved, (durable) => {
    durable.contractManifestSha256 = h('0');
  });
  const budgetBuildDrift = driftDurableSource(budgetDecisions.reserved, (durable) => {
    durable.authorityBuildHash = h('7');
  });
  const budgetProjectionHashDrift = driftDurableSource(budgetDecisions.reserved, (durable) => {
    durable.operationalProjectionHash = h('0');
  });
  const databaseUnknown = driftDurableSource(budgetDecisions.reserved, (durable) => {
    const projection = asJson(durable.operationalProjection, 'budget receipt projection');
    projection.status = 'database_reconciliation_required';
    projection.acceptedAccountRevision = null;
    projection.acceptedRunRevision = null;
    projection.recordHash = null;
    projection.ledgerEntryHash = null;
    projection.committedAt = null;
    projection.reconciliationToken = 'database-reconciliation-binding';
    durable.operationalProjectionHash = hashWorkflowBudgetAuthorityValue('receipt', projection);
  });
  const whitespaceBytes = cloneJson(budgetDecisions.reserved, 'whitespace durable bytes');
  whitespaceBytes.durableReceiptBytes = ` ${String(whitespaceBytes.durableReceiptBytes)}`;
  const duplicateBytes = cloneJson(budgetDecisions.reserved, 'duplicate durable bytes');
  duplicateBytes.durableReceiptBytes = String(duplicateBytes.durableReceiptBytes).replace(
    /^\{"authority":"workflow-control",/u,
    '{"authority":"workflow-control","authority":"workflow-control",',
  );
  const trailingBytes = cloneJson(budgetDecisions.reserved, 'trailing durable bytes');
  trailingBytes.durableReceiptBytes = `${String(trailingBytes.durableReceiptBytes)}x`;
  const oversizedBytes = cloneJson(budgetDecisions.reserved, 'oversized durable bytes');
  oversizedBytes.durableReceiptBytes = 'x'.repeat(524_289);
  const earlyBudgetMessage = controlMessage(
    budgetDecisions.exchange,
    'budget_authorization',
    budgetDecisions.early,
  );
  const earlyBudgetReceipt = cloneJson(
    controlKinds.budget_authorization.receipt,
    'early budget receipt',
  );
  earlyBudgetReceipt.messageDigest =
    prepareWorkflowControlAuthorityMessage(earlyBudgetMessage).messageDigest;
  const lateBudgetMessage = controlMessage(
    budgetDecisions.exchange,
    'budget_authorization',
    budgetDecisions.late,
  );
  const lateBudgetReceipt = cloneJson(
    controlKinds.budget_authorization.receipt,
    'late budget receipt',
  );
  lateBudgetReceipt.messageDigest =
    prepareWorkflowControlAuthorityMessage(lateBudgetMessage).messageDigest;
  const tsPrepared = asJson(
    asJson(budgetRecords.preparedReserve, 'prepared reserve').value,
    'prepared reserve value',
  );
  const tsReceipt = asJson(
    asJson(budgetRecords.reserveReceipt, 'reserve receipt').value,
    'reserve receipt value',
  );
  const tsDurableBytes = canonicalWorkflowBudgetAuthorityJson({
    schema: 'openslack.workflow_control_budget_durable_record.v1',
    authority: 'workflow-control',
    writer: 'workflow-control/budget-authority-server',
    authorityMode: 'local-qualification-v1',
    productionAuthority: false,
    contractManifestSha256: WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS.budgetManifest,
    authorityBuildHash: tsReceipt.serviceBuildHash,
    recordKind: 'receipt',
    operationalProjection: tsReceipt,
    operationalProjectionHash: hashWorkflowBudgetAuthorityValue('receipt', tsReceipt),
  });
  const tsLocalGoOuter = {
    schema: WORKFLOW_RUNNER_BUDGET_SOURCE_RESULT_SCHEMA,
    durableReceiptBytes: tsDurableBytes,
    decision: asJson(
      asJson(budgetRecords.reserveReserved, 'reserve decision').value,
      'reserve decision value',
    ),
    ledgerEntry: asJson(
      asJson(budgetRecords.reserveLedger, 'reserve ledger').value,
      'reserve ledger value',
    ),
  };
  const badEffectMessage = cloneJson(
    controlKindMessages.effect_authorization,
    'bad effect message',
  );
  asJson(badEffectMessage.payload, 'effect authorization payload').effectId = 'effect.alien';
  const badEffectDelivery = cloneJson(
    controlKinds.effect_authorization.receipt,
    'bad effect delivery',
  );
  badEffectDelivery.messageDigest =
    prepareWorkflowControlAuthorityMessage(badEffectMessage).messageDigest;
  const badDecisionOrdering = cloneJson(
    controlKinds.effect_authorization.receipt,
    'bad decision ordering',
  );
  badDecisionOrdering.companionSequence = 3;
  const badRouteMessage = cloneJson(controlKindMessages.event_receipt, 'bad route message');
  badRouteMessage.authorityBackend = 'go';
  badRouteMessage.authority = 'workflow-control';
  const badRouteDelivery = cloneJson(controlKinds.event_receipt.receipt, 'bad route delivery');
  badRouteDelivery.messageDigest =
    prepareWorkflowControlAuthorityMessage(badRouteMessage).messageDigest;
  const alienControlResolution = cloneJson(checkpoint.resolution, 'alien control resolution');
  alienControlResolution.stageReceiptHash = hashWorkflowRunnerAuthorityBindingReceipt(
    exchanges.resume_advance.stageReceipt,
  );
  alienControlResolution.sentAt = '2026-08-20T00:06:02.000Z';
  const alienControlResolutionReceipt = cloneJson(
    checkpoint.resolutionReceipt,
    'alien control resolution receipt',
  );
  alienControlResolutionReceipt.stageReceiptHash = alienControlResolution.stageReceiptHash;
  alienControlResolutionReceipt.requestHash = hashWorkflowRunnerAuthorityBindingResolution(
    validateWorkflowRunnerAuthorityBindingResolution(alienControlResolution),
  );
  alienControlResolutionReceipt.committedAt = '2026-08-20T00:06:03.000Z';
  const sequenceGapMessage = cloneJson(
    controlKindMessages.effect_authorization,
    'sequence gap message',
  );
  sequenceGapMessage.sequence = (sequenceGapMessage.sequence as number) + 1;
  const sequenceGapDelivery = cloneJson(
    controlKinds.effect_authorization.receipt,
    'sequence gap delivery',
  );
  sequenceGapDelivery.controlSequence = sequenceGapMessage.sequence;
  sequenceGapDelivery.messageDigest =
    prepareWorkflowControlAuthorityMessage(sequenceGapMessage).messageDigest;
  const priorTimeInversionMessage = cloneJson(
    controlKindMessages.effect_authorization,
    'prior time inversion message',
  );
  priorTimeInversionMessage.sentAt = '2026-08-20T00:06:59.999Z';
  const priorTimeInversionDelivery = cloneJson(
    controlKinds.effect_authorization.receipt,
    'prior time inversion delivery',
  );
  priorTimeInversionDelivery.messageDigest =
    prepareWorkflowControlAuthorityMessage(priorTimeInversionMessage).messageDigest;
  const resolutionAckTimeInversionMessage = cloneJson(
    controlKindMessages.event_receipt,
    'resolution ACK time inversion message',
  );
  resolutionAckTimeInversionMessage.sentAt = '2026-08-20T00:01:02.500Z';
  asJson(
    resolutionAckTimeInversionMessage.payload,
    'resolution ACK time inversion payload',
  ).committedAt = resolutionAckTimeInversionMessage.sentAt;
  const resolutionAckTimeInversionDelivery = cloneJson(
    controlKinds.event_receipt.receipt,
    'resolution ACK time inversion delivery',
  );
  resolutionAckTimeInversionDelivery.messageDigest = prepareWorkflowControlAuthorityMessage(
    resolutionAckTimeInversionMessage,
  ).messageDigest;
  const budgetRateInvalid = cloneJson(exchanges.budget_reserve.resolution, 'budget rate invalid');
  asJson(budgetRateInvalid.evidence, 'budget evidence').rateNanoUsdPerToken = 'not-a-rate';
  const budgetSettleReceiptHashDrift = settlementStageDrift(
    exchanges.budget_settle,
    'providerReceiptHash',
    h('0'),
  );
  const budgetSettleTokenDrift = settlementStageDrift(
    exchanges.budget_settle,
    'actualTokens',
    '401',
  );
  const budgetSettleCostDrift = settlementStageDrift(
    exchanges.budget_settle,
    'actualCostNanoUsd',
    '4001',
  );
  const budgetSettleCallDrift = settlementStageDrift(exchanges.budget_settle, 'actualCalls', '2');
  const budgetSettleDispositionDrift = settlementStageDrift(
    exchanges.budget_settle,
    'settlementStatus',
    'reconciliation_required',
  );
  const resumeLogicalAttemptReuse = cloneJson(
    exchanges.resume_advance.resolution,
    'resume logical attempt reuse',
  );
  asJson(resumeLogicalAttemptReuse.evidence, 'resume evidence').logicalResumeAttemptId =
    exchanges.resume_advance.stage.runnerAttemptId;
  resumeLogicalAttemptReuse.evidenceHash = hashWorkflowRunnerAuthorityBindingEvidence(
    resumeLogicalAttemptReuse.evidence,
    'resume_advance',
  );

  const positives = Object.fromEntries(
    WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS.map((operation) => {
      const item = exchanges[operation];
      return [
        operation,
        {
          stage: vector(item.stage, 'stage'),
          stageReceipt: vector(item.stageReceipt, 'receipt'),
          resolution: vector(item.resolution, 'resolution'),
          resolutionReceipt: vector(item.resolutionReceipt, 'receipt'),
        },
      ];
    }),
  );
  const runtimeAdmissionPrepared = prepareWorkflowRunnerV2RuntimeAdmission({
    schema: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_SCHEMA,
    workspaceId: 'workspace-qualification',
    jobId: 'job-qualification',
    workflowRunId: 'run-qualification',
    attemptId: 'attempt-qualification',
    leaseId: 'lease-qualification',
    fencingToken: 41,
    jobSpecHash: h('8'),
    disposition: 'resume',
  });
  const runtimeAdmissionReceipt = validateWorkflowRunnerV2RuntimeAdmissionReceipt(
    {
      schema: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_RECEIPT_SCHEMA,
      status: 'accepted',
      ...Object.fromEntries(
        Object.entries(runtimeAdmissionPrepared.value).filter(([key]) => key !== 'schema'),
      ),
      idempotencyKey: runtimeAdmissionPrepared.idempotencyKey,
      requestFingerprint: runtimeAdmissionPrepared.requestFingerprint,
      committedAt: '2026-08-22T00:00:00.000Z',
    },
    runtimeAdmissionPrepared,
  );
  const runtimeAdmissionReceiptCrossSplice = cloneJson(
    runtimeAdmissionReceipt,
    'runtime admission receipt cross-splice',
  );
  runtimeAdmissionReceiptCrossSplice.jobId = 'job-alien';
  const runtimeAdmissionReceiptInvalidTimestamp = cloneJson(
    runtimeAdmissionReceipt,
    'runtime admission receipt invalid timestamp',
  );
  runtimeAdmissionReceiptInvalidTimestamp.committedAt = '2026-13-22T00:00:00.000Z';
  const runtimeAdmissionDispositionDrift = cloneJson(
    runtimeAdmissionPrepared.value,
    'runtime admission disposition drift',
  );
  runtimeAdmissionDispositionDrift.disposition = 'retry';

  return {
    schema: 'openslack.workflow_runner_authority_binding_golden_vectors.v1',
    contractVersion: WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
    profile: WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
    sourceLocks: WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS,
    operationMatrix: OPERATION_MATRIX,
    positive: {
      operations: positives,
      semanticVariants: Object.fromEntries(
        Object.entries(semanticVariants).map(([name, item]) => [
          name,
          {
            stage: vector(item.stage, 'stage'),
            stageReceipt: vector(item.stageReceipt, 'receipt'),
            resolution: vector(item.resolution, 'resolution'),
            resolutionReceipt: vector(item.resolutionReceipt, 'receipt'),
          },
        ]),
      ),
      controlDelivery: {
        accepted: Object.fromEntries(
          WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS.map((operation) => [
            operation,
            vector(deliveries.accepted[operation], 'receipt'),
          ]),
        ),
        reconciliationRequired: vector(deliveries.reconciliationRequired, 'receipt'),
        artifacts: {
          ...Object.fromEntries(
            (Object.keys(controlKinds) as ControlDeliveryKind[]).map((kind) => [
              `kind:${kind}`,
              {
                operation: controlKinds[kind].operation,
                message: controlKinds[kind].message,
                receipt: vector(controlKinds[kind].receipt, 'receipt'),
                budgetSourceResult:
                  kind === 'budget_authorization' ? budgetDecisions.reserved : null,
                priorEventDeliveryRef:
                  kind === 'budget_authorization' ? 'budget-authorization-event-receipt' : null,
              },
            ]),
          ),
          'budget:rejected': {
            operation: 'budget_reserve',
            message: budgetAuthorization.rejected.message,
            receipt: vector(budgetAuthorization.rejected.receipt, 'receipt'),
            budgetSourceResult: budgetAuthorization.rejected.sourceResult,
            priorEventDeliveryRef: 'budget-authorization-event-receipt',
          },
          'budget:previous-manifest': {
            operation: 'budget_reserve',
            message: previousBudgetMessage,
            receipt: vector(previousBudgetReceipt, 'receipt'),
            budgetSourceResult: previousBudgetSource,
            priorEventDeliveryRef: 'budget-authorization-event-receipt',
          },
        },
        priorEventDeliveries: {
          'budget-authorization-event-receipt': {
            message: budgetPriorMessage,
            receipt: vector(budgetPriorReceipt, 'receipt'),
          },
        },
        byKind: Object.fromEntries(
          (Object.keys(controlKinds) as ControlDeliveryKind[]).map((kind) => [
            kind,
            `kind:${kind}`,
          ]),
        ),
        budgetAuthorization: {
          reserved: 'kind:budget_authorization',
          rejected: 'budget:rejected',
        },
        budgetDatabaseReconciliation: {
          message: budgetDatabaseReconciliationMessage,
          receipt: vector(budgetDatabaseReconciliationReceipt, 'receipt'),
          decision: null,
        },
        messages: {
          accepted: controlReceiptMessages,
          reconciliationRequired: controlKindMessages.cancel_request,
        },
      },
      runtimeAdmission: {
        request: runtimeAdmissionVector(
          runtimeAdmissionPrepared.value,
          runtimeAdmissionPrepared.body,
          runtimeAdmissionPrepared.idempotencyKey,
          runtimeAdmissionPrepared.requestFingerprint,
        ),
        receipt: runtimeAdmissionReceiptVector(runtimeAdmissionReceipt),
      },
    },
    runtimeAdmissionNegative: [
      {
        id: 'runtime-admission-disposition-drift',
        operation: 'validate_runtime_admission',
        input: runtimeAdmissionDispositionDrift,
      },
      {
        id: 'runtime-admission-receipt-cross-splice',
        operation: 'validate_runtime_admission_receipt',
        input: runtimeAdmissionReceiptCrossSplice,
      },
      {
        id: 'runtime-admission-receipt-invalid-timestamp',
        operation: 'validate_runtime_admission_receipt',
        input: runtimeAdmissionReceiptInvalidTimestamp,
      },
    ],
    negative: exactNegatives([
      negative('stage-unknown-field', 'validate_stage', badStageUnknown, () =>
        validateWorkflowRunnerAuthorityBindingStage(badStageUnknown),
      ),
      negative('runner-revision-drift', 'validate_stage', badStageRevision, () =>
        validateWorkflowRunnerAuthorityBindingStage(badStageRevision),
      ),
      negative('resolution-evidence-hash-drift', 'validate_resolution', badResolutionHash, () =>
        validateWorkflowRunnerAuthorityBindingResolution(badResolutionHash),
      ),
      negative(
        'stage-receipt-cross-splice',
        'validate_stage_receipt',
        { receipt: badStageReceipt, stage: checkpoint.stage },
        () => validateWorkflowRunnerAuthorityBindingStageReceipt(badStageReceipt, checkpoint.stage),
      ),
      negative(
        'resolution-receipt-cross-splice',
        'validate_resolution_receipt',
        {
          receipt: badResolutionReceipt,
          resolution: checkpoint.resolution,
          stage: checkpoint.stage,
          stageReceipt: checkpoint.stageReceipt,
        },
        () =>
          validateWorkflowRunnerAuthorityBindingResolutionReceipt(
            badResolutionReceipt,
            checkpoint.resolution,
            checkpoint.stage,
            checkpoint.stageReceipt,
          ),
      ),
      negative(
        'control-delivery-digest-drift',
        'validate_control_delivery',
        {
          receipt: badControl,
          message: controlReceiptMessages.checkpoint_commit,
          stage: checkpoint.stage,
          resolution: checkpoint.resolution,
          resolutionReceipt: checkpoint.resolutionReceipt,
          stageReceipt: checkpoint.stageReceipt,
          priorEventDelivery: null,
        },
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            badControl,
            controlReceiptMessages.checkpoint_commit,
            checkpoint.stage,
            checkpoint.resolution,
            checkpoint.resolutionReceipt,
            checkpoint.stageReceipt,
            null,
          ),
      ),
      negative('raw-provider-forbidden', 'validate_resolution', sensitiveEvidence, () =>
        validateWorkflowRunnerAuthorityBindingResolution(sensitiveEvidence),
      ),
      negative(
        'resume-generation-drift',
        'validate_resolution_for_stage',
        {
          resolution: staleResume,
          stage: exchanges.resume_advance.stage,
          stageReceipt: exchanges.resume_advance.stageReceipt,
        },
        () =>
          validateWorkflowRunnerAuthorityBindingResolutionForStage(
            staleResume,
            exchanges.resume_advance.stage,
            exchanges.resume_advance.stageReceipt,
          ),
      ),
      negative(
        'source-global-revision-swap',
        'validate_resolution_for_stage',
        {
          resolution: swappedSourceRevision,
          stage: checkpoint.stage,
          stageReceipt: checkpoint.stageReceipt,
        },
        () =>
          validateWorkflowRunnerAuthorityBindingResolutionForStage(
            swappedSourceRevision,
            checkpoint.stage,
            checkpoint.stageReceipt,
          ),
      ),
      negative(
        'stage-before-resolution',
        'validate_resolution_for_stage',
        {
          resolution: checkpoint.resolution,
          stage: checkpoint.stage,
          stageReceipt: unacceptedStageReceipt,
        },
        () =>
          validateWorkflowRunnerAuthorityBindingResolutionForStage(
            checkpoint.resolution,
            checkpoint.stage,
            unacceptedStageReceipt,
          ),
      ),
      negative('same-key-body-drift', 'validate_stage', sameKeyBodyDrift, () =>
        validateWorkflowRunnerAuthorityBindingStage(sameKeyBodyDrift),
      ),
      negative('target-body-cross-splice', 'validate_stage', bodyCrossSplice, () =>
        validateWorkflowRunnerAuthorityBindingStage(bodyCrossSplice),
      ),
      negative('target-key-cross-splice', 'validate_stage', keyCrossSplice, () =>
        validateWorkflowRunnerAuthorityBindingStage(keyCrossSplice),
      ),
      negative('target-fingerprint-cross-splice', 'validate_stage', fingerprintCrossSplice, () =>
        validateWorkflowRunnerAuthorityBindingStage(fingerprintCrossSplice),
      ),
      negative(
        'resolution-alien-stage-receipt',
        'validate_resolution_for_stage',
        {
          resolution: checkpoint.resolution,
          stage: checkpoint.stage,
          stageReceipt: alienStageReceipt,
        },
        () =>
          validateWorkflowRunnerAuthorityBindingResolutionForStage(
            checkpoint.resolution,
            checkpoint.stage,
            alienStageReceipt,
          ),
      ),
      negative(
        'resolution-alien-stage-hash',
        'validate_resolution_for_stage',
        {
          resolution: alienStageHashResolution,
          stage: checkpoint.stage,
          stageReceipt: checkpoint.stageReceipt,
        },
        () =>
          validateWorkflowRunnerAuthorityBindingResolutionForStage(
            alienStageHashResolution,
            checkpoint.stage,
            checkpoint.stageReceipt,
          ),
      ),
      negative(
        'resolution-receipt-alien-stage-receipt',
        'validate_resolution_receipt',
        {
          receipt: checkpoint.resolutionReceipt,
          resolution: checkpoint.resolution,
          stage: checkpoint.stage,
          stageReceipt: alienStageReceipt,
        },
        () =>
          validateWorkflowRunnerAuthorityBindingResolutionReceipt(
            checkpoint.resolutionReceipt,
            checkpoint.resolution,
            checkpoint.stage,
            alienStageReceipt,
          ),
      ),
      negative(
        'resolution-receipt-stage-hash-drift',
        'validate_resolution_receipt',
        {
          receipt: driftedResolutionReceiptStageHash,
          resolution: checkpoint.resolution,
          stage: checkpoint.stage,
          stageReceipt: checkpoint.stageReceipt,
        },
        () =>
          validateWorkflowRunnerAuthorityBindingResolutionReceipt(
            driftedResolutionReceiptStageHash,
            checkpoint.resolution,
            checkpoint.stage,
            checkpoint.stageReceipt,
          ),
      ),
      negative(
        'checkpoint-nested-contract-error',
        'validate_resolution',
        checkpointNestedError,
        () => validateWorkflowRunnerAuthorityBindingResolution(checkpointNestedError),
      ),
      negative(
        'checkpoint-deep-path-contract-error',
        'validate_resolution',
        checkpointDeepPathError,
        () => validateWorkflowRunnerAuthorityBindingResolution(checkpointDeepPathError),
      ),
      negative('budget-nested-contract-error', 'validate_resolution', budgetNestedError, () =>
        validateWorkflowRunnerAuthorityBindingResolution(budgetNestedError),
      ),
      negative(
        'effect-approved-expiry-boundary',
        'validate_resolution_for_stage',
        {
          resolution: approvedExpiryBoundary,
          stage: exchanges.effect_authorize.stage,
          stageReceipt: exchanges.effect_authorize.stageReceipt,
        },
        () =>
          validateWorkflowRunnerAuthorityBindingResolutionForStage(
            approvedExpiryBoundary,
            exchanges.effect_authorize.stage,
            exchanges.effect_authorize.stageReceipt,
          ),
      ),
      negative(
        'effect-expired-future-boundary',
        'validate_resolution_for_stage',
        {
          resolution: expiredExpiryFuture,
          stage: expiredEffectVariant.stage,
          stageReceipt: expiredEffectVariant.stageReceipt,
        },
        () =>
          validateWorkflowRunnerAuthorityBindingResolutionForStage(
            expiredExpiryFuture,
            expiredEffectVariant.stage,
            expiredEffectVariant.stageReceipt,
          ),
      ),
      negative(
        'effect-rejected-expiry-boundary',
        'validate_resolution_for_stage',
        {
          resolution: rejectedExpiryBoundary,
          stage: rejectedEffectVariant.stage,
          stageReceipt: rejectedEffectVariant.stageReceipt,
        },
        () =>
          validateWorkflowRunnerAuthorityBindingResolutionForStage(
            rejectedExpiryBoundary,
            rejectedEffectVariant.stage,
            rejectedEffectVariant.stageReceipt,
          ),
      ),
      negative(
        'control-event-receipt-target-drift',
        'validate_control_delivery',
        {
          receipt: badEventDelivery,
          message: badEventMessage,
          stage: checkpoint.stage,
          resolution: checkpoint.resolution,
          resolutionReceipt: checkpoint.resolutionReceipt,
          stageReceipt: checkpoint.stageReceipt,
          priorEventDelivery: null,
        },
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            badEventDelivery,
            badEventMessage,
            checkpoint.stage,
            checkpoint.resolution,
            checkpoint.resolutionReceipt,
            checkpoint.stageReceipt,
            null,
          ),
      ),
      negative(
        'control-decision-budget-evidence-drift',
        'validate_control_delivery',
        budgetDeliveryInput(badBudgetMessage, badBudgetDelivery, budgetDecisions.reserved),
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            badBudgetDelivery,
            badBudgetMessage,
            budgetDecisions.exchange.stage,
            budgetDecisions.exchange.resolution,
            budgetDecisions.exchange.resolutionReceipt,
            budgetDecisions.exchange.stageReceipt,
            { message: budgetPriorMessage, receipt: budgetPriorReceipt },
            budgetDecisions.reserved,
          ),
      ),
      negative(
        'budget-decision-source-missing',
        'validate_control_delivery',
        missingBudgetSourceInput,
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptWithContext(
            controlKinds.budget_authorization.receipt,
            controlKindMessages.budget_authorization,
            {
              stage: budgetDecisions.exchange.stage,
              resolution: budgetDecisions.exchange.resolution,
              resolutionReceipt: budgetDecisions.exchange.resolutionReceipt,
              stageReceipt: budgetDecisions.exchange.stageReceipt,
              priorEventDelivery: { message: budgetPriorMessage, receipt: budgetPriorReceipt },
            },
          ),
      ),
      negative(
        'budget-decision-source-null',
        'validate_control_delivery',
        nullBudgetSourceInput,
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            controlKinds.budget_authorization.receipt,
            controlKindMessages.budget_authorization,
            budgetDecisions.exchange.stage,
            budgetDecisions.exchange.resolution,
            budgetDecisions.exchange.resolutionReceipt,
            budgetDecisions.exchange.stageReceipt,
            { message: budgetPriorMessage, receipt: budgetPriorReceipt },
            null,
          ),
      ),
      negative(
        'non-budget-decision-source-present',
        'validate_control_delivery',
        nonBudgetSourceInput,
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            controlKinds.effect_authorization.receipt,
            controlKindMessages.effect_authorization,
            exchanges.effect_authorize.stage,
            exchanges.effect_authorize.resolution,
            exchanges.effect_authorize.resolutionReceipt,
            exchanges.effect_authorize.stageReceipt,
            {
              message: controlReceiptMessages.effect_authorize,
              receipt: acceptedDeliveries.effect_authorize,
            },
            budgetDecisions.reserved,
          ),
      ),
      ...(
        [
          [
            'budget-decision-status-drift',
            budgetStatusDriftMessage,
            budgetStatusDriftReceipt,
            budgetDecisions.reserved,
          ],
          [
            'budget-decision-amount-drift',
            budgetAmountDriftMessage,
            budgetAmountDriftReceipt,
            budgetDecisions.reserved,
          ],
          [
            'budget-decision-receipt-hash-drift',
            budgetReceiptHashDriftMessage,
            budgetReceiptHashDriftReceipt,
            budgetDecisions.reserved,
          ],
          [
            'budget-decision-committed-run-revision-drift',
            budgetCommittedRunRevisionDriftMessage,
            budgetCommittedRunRevisionDriftReceipt,
            budgetDecisions.reserved,
          ],
          [
            'budget-runner-envelope-revision-drift',
            budgetRunnerEnvelopeRevisionDriftMessage,
            budgetRunnerEnvelopeRevisionDriftReceipt,
            budgetDecisions.reserved,
          ],
          [
            'budget-decision-source-result-cross-splice',
            controlKindMessages.budget_authorization,
            controlKinds.budget_authorization.receipt,
            sourceResultCrossSplice,
          ],
          [
            'budget-decision-valid-source-result-cross-splice',
            controlKindMessages.budget_authorization,
            controlKinds.budget_authorization.receipt,
            budgetDecisions.sibling,
          ],
          [
            'budget-durable-request-cross-splice',
            controlKindMessages.budget_authorization,
            controlKinds.budget_authorization.receipt,
            decisionRequestCrossSplice,
          ],
          [
            'budget-durable-manifest-drift',
            controlKindMessages.budget_authorization,
            controlKinds.budget_authorization.receipt,
            budgetManifestDrift,
          ],
          [
            'budget-durable-build-drift',
            controlKindMessages.budget_authorization,
            controlKinds.budget_authorization.receipt,
            budgetBuildDrift,
          ],
          [
            'budget-durable-projection-hash-drift',
            controlKindMessages.budget_authorization,
            controlKinds.budget_authorization.receipt,
            budgetProjectionHashDrift,
          ],
        ] as const
      ).map(([id, message, receipt, sourceResult]) =>
        negative(
          id,
          'validate_control_delivery',
          budgetDeliveryInput(message, receipt, sourceResult),
          () =>
            validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
              receipt,
              message,
              budgetDecisions.exchange.stage,
              budgetDecisions.exchange.resolution,
              budgetDecisions.exchange.resolutionReceipt,
              budgetDecisions.exchange.stageReceipt,
              { message: budgetPriorMessage, receipt: budgetPriorReceipt },
              sourceResult,
            ),
        ),
      ),
      negative(
        'budget-source-ts-local-go-outer-cross-splice',
        'validate_budget_source_result',
        { sourceResult: tsLocalGoOuter, preparedRequest: tsPrepared },
        () => validateWorkflowRunnerBudgetSourceResult(tsLocalGoOuter, tsPrepared),
      ),
      ...(
        [
          ['budget-durable-bytes-whitespace-drift', whitespaceBytes],
          ['budget-durable-bytes-duplicate-key-drift', duplicateBytes],
          ['budget-durable-bytes-trailing-drift', trailingBytes],
          ['budget-durable-bytes-size-overflow', oversizedBytes],
          ['budget-decision-database-unknown-no-seq4', databaseUnknown],
        ] as const
      ).map(([id, sourceResult]) =>
        negative(
          id,
          'validate_budget_source_result',
          { sourceResult, preparedRequest: budgetDecisions.prepared },
          () => validateWorkflowRunnerBudgetSourceResult(sourceResult, budgetDecisions.prepared),
        ),
      ),
      negative(
        'budget-decision-source-before-resolution-ack',
        'validate_control_delivery',
        budgetDeliveryInput(earlyBudgetMessage, earlyBudgetReceipt, budgetDecisions.early),
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            earlyBudgetReceipt,
            earlyBudgetMessage,
            budgetDecisions.exchange.stage,
            budgetDecisions.exchange.resolution,
            budgetDecisions.exchange.resolutionReceipt,
            budgetDecisions.exchange.stageReceipt,
            { message: budgetPriorMessage, receipt: budgetPriorReceipt },
            budgetDecisions.early,
          ),
      ),
      negative(
        'budget-decision-time-inversion',
        'validate_control_delivery',
        budgetDeliveryInput(lateBudgetMessage, lateBudgetReceipt, budgetDecisions.late),
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            lateBudgetReceipt,
            lateBudgetMessage,
            budgetDecisions.exchange.stage,
            budgetDecisions.exchange.resolution,
            budgetDecisions.exchange.resolutionReceipt,
            budgetDecisions.exchange.stageReceipt,
            { message: budgetPriorMessage, receipt: budgetPriorReceipt },
            budgetDecisions.late,
          ),
      ),
      negative(
        'control-decision-effect-evidence-drift',
        'validate_control_delivery',
        {
          receipt: badEffectDelivery,
          message: badEffectMessage,
          stage: exchanges.effect_authorize.stage,
          resolution: exchanges.effect_authorize.resolution,
          resolutionReceipt: exchanges.effect_authorize.resolutionReceipt,
          stageReceipt: exchanges.effect_authorize.stageReceipt,
          priorEventDelivery: {
            message: controlReceiptMessages.effect_authorize,
            receipt: acceptedDeliveries.effect_authorize,
          },
        },
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            badEffectDelivery,
            badEffectMessage,
            exchanges.effect_authorize.stage,
            exchanges.effect_authorize.resolution,
            exchanges.effect_authorize.resolutionReceipt,
            exchanges.effect_authorize.stageReceipt,
            {
              message: controlReceiptMessages.effect_authorize,
              receipt: acceptedDeliveries.effect_authorize,
            },
          ),
      ),
      negative(
        'control-decision-resume-attempt-drift',
        'validate_control_delivery',
        {
          receipt: badResumeDelivery,
          message: badResumeMessage,
          stage: exchanges.resume_advance.stage,
          resolution: exchanges.resume_advance.resolution,
          resolutionReceipt: exchanges.resume_advance.resolutionReceipt,
          stageReceipt: exchanges.resume_advance.stageReceipt,
          priorEventDelivery: {
            message: controlReceiptMessages.resume_advance,
            receipt: acceptedDeliveries.resume_advance,
          },
        },
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            badResumeDelivery,
            badResumeMessage,
            exchanges.resume_advance.stage,
            exchanges.resume_advance.resolution,
            exchanges.resume_advance.resolutionReceipt,
            exchanges.resume_advance.stageReceipt,
            {
              message: controlReceiptMessages.resume_advance,
              receipt: acceptedDeliveries.resume_advance,
            },
          ),
      ),
      negative(
        'control-decision-ordering-drift',
        'validate_control_delivery',
        {
          receipt: badDecisionOrdering,
          message: controlKindMessages.effect_authorization,
          stage: exchanges.effect_authorize.stage,
          resolution: exchanges.effect_authorize.resolution,
          resolutionReceipt: exchanges.effect_authorize.resolutionReceipt,
          stageReceipt: exchanges.effect_authorize.stageReceipt,
          priorEventDelivery: {
            message: controlReceiptMessages.effect_authorize,
            receipt: acceptedDeliveries.effect_authorize,
          },
        },
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            badDecisionOrdering,
            controlKindMessages.effect_authorization,
            exchanges.effect_authorize.stage,
            exchanges.effect_authorize.resolution,
            exchanges.effect_authorize.resolutionReceipt,
            exchanges.effect_authorize.stageReceipt,
            {
              message: controlReceiptMessages.effect_authorize,
              receipt: acceptedDeliveries.effect_authorize,
            },
          ),
      ),
      negative(
        'control-route-cross-splice',
        'validate_control_delivery',
        {
          receipt: badRouteDelivery,
          message: badRouteMessage,
          stage: checkpoint.stage,
          resolution: checkpoint.resolution,
          resolutionReceipt: checkpoint.resolutionReceipt,
          stageReceipt: checkpoint.stageReceipt,
          priorEventDelivery: null,
        },
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            badRouteDelivery,
            badRouteMessage,
            checkpoint.stage,
            checkpoint.resolution,
            checkpoint.resolutionReceipt,
            checkpoint.stageReceipt,
            null,
          ),
      ),
      negative(
        'control-delivery-alien-stage-receipt',
        'validate_control_delivery',
        {
          receipt: acceptedDeliveries.checkpoint_commit,
          message: controlReceiptMessages.checkpoint_commit,
          stage: checkpoint.stage,
          resolution: alienControlResolution,
          resolutionReceipt: alienControlResolutionReceipt,
          stageReceipt: exchanges.resume_advance.stageReceipt,
          priorEventDelivery: null,
        },
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            acceptedDeliveries.checkpoint_commit,
            controlReceiptMessages.checkpoint_commit,
            checkpoint.stage,
            alienControlResolution,
            alienControlResolutionReceipt,
            exchanges.resume_advance.stageReceipt,
            null,
          ),
      ),
      negative(
        'control-decision-missing-prior-event-ack',
        'validate_control_delivery',
        {
          receipt: controlKinds.effect_authorization.receipt,
          message: controlKindMessages.effect_authorization,
          stage: exchanges.effect_authorize.stage,
          resolution: exchanges.effect_authorize.resolution,
          resolutionReceipt: exchanges.effect_authorize.resolutionReceipt,
          stageReceipt: exchanges.effect_authorize.stageReceipt,
          priorEventDelivery: null,
        },
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            controlKinds.effect_authorization.receipt,
            controlKindMessages.effect_authorization,
            exchanges.effect_authorize.stage,
            exchanges.effect_authorize.resolution,
            exchanges.effect_authorize.resolutionReceipt,
            exchanges.effect_authorize.stageReceipt,
            null,
          ),
      ),
      negative(
        'control-cancel-missing-prior-event-ack',
        'validate_control_delivery',
        {
          receipt: controlKinds.cancel_request.receipt,
          message: controlKindMessages.cancel_request,
          stage: exchanges.effect_complete.stage,
          resolution: exchanges.effect_complete.resolution,
          resolutionReceipt: exchanges.effect_complete.resolutionReceipt,
          stageReceipt: exchanges.effect_complete.stageReceipt,
          priorEventDelivery: null,
        },
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            controlKinds.cancel_request.receipt,
            controlKindMessages.cancel_request,
            exchanges.effect_complete.stage,
            exchanges.effect_complete.resolution,
            exchanges.effect_complete.resolutionReceipt,
            exchanges.effect_complete.stageReceipt,
            null,
          ),
      ),
      negative(
        'control-decision-alien-prior-event-ack',
        'validate_control_delivery',
        {
          receipt: controlKinds.effect_authorization.receipt,
          message: controlKindMessages.effect_authorization,
          stage: exchanges.effect_authorize.stage,
          resolution: exchanges.effect_authorize.resolution,
          resolutionReceipt: exchanges.effect_authorize.resolutionReceipt,
          stageReceipt: exchanges.effect_authorize.stageReceipt,
          priorEventDelivery: {
            message: controlReceiptMessages.checkpoint_commit,
            receipt: acceptedDeliveries.checkpoint_commit,
          },
        },
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            controlKinds.effect_authorization.receipt,
            controlKindMessages.effect_authorization,
            exchanges.effect_authorize.stage,
            exchanges.effect_authorize.resolution,
            exchanges.effect_authorize.resolutionReceipt,
            exchanges.effect_authorize.stageReceipt,
            {
              message: controlReceiptMessages.checkpoint_commit,
              receipt: acceptedDeliveries.checkpoint_commit,
            },
          ),
      ),
      negative(
        'control-decision-sequence-gap',
        'validate_control_delivery',
        {
          receipt: sequenceGapDelivery,
          message: sequenceGapMessage,
          stage: exchanges.effect_authorize.stage,
          resolution: exchanges.effect_authorize.resolution,
          resolutionReceipt: exchanges.effect_authorize.resolutionReceipt,
          stageReceipt: exchanges.effect_authorize.stageReceipt,
          priorEventDelivery: {
            message: controlReceiptMessages.effect_authorize,
            receipt: acceptedDeliveries.effect_authorize,
          },
        },
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            sequenceGapDelivery,
            sequenceGapMessage,
            exchanges.effect_authorize.stage,
            exchanges.effect_authorize.resolution,
            exchanges.effect_authorize.resolutionReceipt,
            exchanges.effect_authorize.stageReceipt,
            {
              message: controlReceiptMessages.effect_authorize,
              receipt: acceptedDeliveries.effect_authorize,
            },
          ),
      ),
      negative(
        'control-event-receipt-resolution-ack-time-inversion',
        'validate_control_delivery',
        {
          receipt: resolutionAckTimeInversionDelivery,
          message: resolutionAckTimeInversionMessage,
          stage: checkpoint.stage,
          resolution: checkpoint.resolution,
          resolutionReceipt: checkpoint.resolutionReceipt,
          stageReceipt: checkpoint.stageReceipt,
          priorEventDelivery: null,
        },
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            resolutionAckTimeInversionDelivery,
            resolutionAckTimeInversionMessage,
            checkpoint.stage,
            checkpoint.resolution,
            checkpoint.resolutionReceipt,
            checkpoint.stageReceipt,
            null,
          ),
      ),
      negative(
        'control-decision-prior-time-inversion',
        'validate_control_delivery',
        {
          receipt: priorTimeInversionDelivery,
          message: priorTimeInversionMessage,
          stage: exchanges.effect_authorize.stage,
          resolution: exchanges.effect_authorize.resolution,
          resolutionReceipt: exchanges.effect_authorize.resolutionReceipt,
          stageReceipt: exchanges.effect_authorize.stageReceipt,
          priorEventDelivery: {
            message: controlReceiptMessages.effect_authorize,
            receipt: acceptedDeliveries.effect_authorize,
          },
        },
        () =>
          validateWorkflowRunnerAuthorityControlDeliveryReceiptForMessage(
            priorTimeInversionDelivery,
            priorTimeInversionMessage,
            exchanges.effect_authorize.stage,
            exchanges.effect_authorize.resolution,
            exchanges.effect_authorize.resolutionReceipt,
            exchanges.effect_authorize.stageReceipt,
            {
              message: controlReceiptMessages.effect_authorize,
              receipt: acceptedDeliveries.effect_authorize,
            },
          ),
      ),
      negative('budget-rate-invalid', 'validate_resolution', budgetRateInvalid, () =>
        validateWorkflowRunnerAuthorityBindingResolution(budgetRateInvalid),
      ),
      ...[
        ['budget-settle-receipt-hash-drift', budgetSettleReceiptHashDrift],
        ['budget-settle-token-drift', budgetSettleTokenDrift],
        ['budget-settle-cost-drift', budgetSettleCostDrift],
        ['budget-settle-call-drift', budgetSettleCallDrift],
        ['budget-settle-disposition-drift', budgetSettleDispositionDrift],
      ].map(([id, item]) => {
        const drift = item as typeof budgetSettleTokenDrift;
        return negative(id as string, 'validate_resolution_for_stage', drift, () =>
          validateWorkflowRunnerAuthorityBindingResolutionForStage(
            drift.resolution,
            drift.stage,
            drift.stageReceipt,
          ),
        );
      }),
      negative(
        'resume-logical-attempt-active-reuse',
        'validate_resolution_for_stage',
        {
          resolution: resumeLogicalAttemptReuse,
          stage: exchanges.resume_advance.stage,
          stageReceipt: exchanges.resume_advance.stageReceipt,
        },
        () =>
          validateWorkflowRunnerAuthorityBindingResolutionForStage(
            resumeLogicalAttemptReuse,
            exchanges.resume_advance.stage,
            exchanges.resume_advance.stageReceipt,
          ),
      ),
    ]),
  };
}

async function schemas(golden: Awaited<ReturnType<typeof goldenVectors>>) {
  const operations = asJson(asJson(golden.positive, 'positive').operations, 'operations');
  const semanticVariants = asJson(
    asJson(golden.positive, 'positive').semanticVariants,
    'semantic variants',
  );
  const semantic = Object.values(semanticVariants).map((entry) => asJson(entry, 'semantic'));
  const stages = [
    ...WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS.map((operation) =>
      asJson(asJson(asJson(operations[operation], operation).stage, 'stage').value, 'stage value'),
    ),
    ...semantic.map((entry) =>
      asJson(asJson(entry.stage, 'semantic stage').value, 'semantic stage value'),
    ),
  ];
  const resolutions = [
    ...WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS.map((operation) =>
      asJson(
        asJson(asJson(operations[operation], operation).resolution, 'resolution').value,
        'resolution value',
      ),
    ),
    ...semantic.map((entry) =>
      asJson(asJson(entry.resolution, 'semantic resolution').value, 'semantic resolution value'),
    ),
  ];
  const receipts = WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS.flatMap((operation) => {
    const exchangeValue = asJson(operations[operation], operation);
    return [
      asJson(asJson(exchangeValue.stageReceipt, 'stage receipt').value, 'stage receipt value'),
      asJson(
        asJson(exchangeValue.resolutionReceipt, 'resolution receipt').value,
        'resolution receipt value',
      ),
    ];
  });
  for (const entry of semantic) {
    receipts.push(
      asJson(
        asJson(entry.stageReceipt, 'semantic stage receipt').value,
        'semantic stage receipt value',
      ),
      asJson(
        asJson(entry.resolutionReceipt, 'semantic resolution receipt').value,
        'semantic resolution receipt value',
      ),
    );
  }
  const control = asJson(asJson(golden.positive, 'positive').controlDelivery, 'control delivery');
  const acceptedControl = asJson(control.accepted, 'accepted control deliveries');
  for (const operation of WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS) {
    receipts.push(
      asJson(
        asJson(acceptedControl[operation], `${operation} delivery`).value,
        `${operation} delivery value`,
      ),
    );
  }
  const byKind = asJson(control.byKind, 'control deliveries by kind');
  const controlArtifacts = asJson(control.artifacts, 'control delivery artifacts');
  for (const kind of [
    'event_receipt',
    'budget_authorization',
    'effect_authorization',
    'resume_offer',
    'cancel_request',
  ]) {
    const reference = byKind[kind];
    if (typeof reference !== 'string') {
      throw new Error(`${kind} delivery reference must be a string.`);
    }
    const artifact = asJson(controlArtifacts[reference], `${kind} delivery`);
    receipts.push(
      asJson(asJson(artifact.receipt, `${kind} receipt`).value, `${kind} receipt value`),
    );
  }
  receipts.push(
    asJson(
      asJson(control.reconciliationRequired, 'reconciliation delivery').value,
      'reconciliation delivery value',
    ),
  );
  const errorSample = validateWorkflowRunnerAuthorityBindingError({
    schema: WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_SCHEMA,
    code: WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES[0],
    message: 'closed contract failure',
    bindingId: null,
    operation: null,
    reconciliationToken: null,
  });
  const errorSchema = schemaForValue(errorSample);
  replaceRootConst(errorSchema, 'schema', WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_SCHEMA);
  const errorProperties = asJson(errorSchema.properties, 'error properties');
  errorProperties.code = { enum: WORKFLOW_RUNNER_AUTHORITY_BINDING_ERROR_CODES };
  errorProperties.operation = {
    oneOf: [{ enum: WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS }, { type: 'null' }],
  };
  const runtimeAdmission = asJson(
    asJson(asJson(golden.positive, 'positive').runtimeAdmission, 'runtime admission').request,
    'runtime admission request vector',
  );
  const runtimeAdmissionRequest = asJson(runtimeAdmission.value, 'runtime admission request');
  const runtimeAdmissionReceipt = asJson(
    asJson(
      asJson(asJson(golden.positive, 'positive').runtimeAdmission, 'runtime admission').receipt,
      'runtime admission receipt vector',
    ).value,
    'runtime admission receipt',
  );
  const runtimeAdmissionSchema = schemaForValue(runtimeAdmissionRequest);
  runtimeAdmissionSchema.unevaluatedProperties = false;
  replaceRootConst(runtimeAdmissionSchema, 'schema', WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_SCHEMA);
  const runtimeAdmissionProperties = asJson(
    runtimeAdmissionSchema.properties,
    'runtime admission properties',
  );
  runtimeAdmissionProperties.disposition = { enum: ['initial', 'resume'] };
  const runtimeAdmissionReceiptSchema = schemaForValue(runtimeAdmissionReceipt);
  runtimeAdmissionReceiptSchema.unevaluatedProperties = false;
  replaceRootConst(
    runtimeAdmissionReceiptSchema,
    'schema',
    WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_RECEIPT_SCHEMA,
  );
  replaceRootConst(runtimeAdmissionReceiptSchema, 'status', 'accepted');
  const runtimeAdmissionReceiptProperties = asJson(
    runtimeAdmissionReceiptSchema.properties,
    'runtime admission receipt properties',
  );
  runtimeAdmissionReceiptProperties.disposition = { enum: ['initial', 'resume'] };
  return [
    unionSchema(
      'https://openslack.dev/contracts/workflow-runner-authority-binding/v1/schemas/workflow-runner-authority-binding-stage.v1.schema.json',
      'OpenSlack GS9-F2a authority-binding stage_event',
      stages,
      ['schema', 'operation'],
    ),
    unionSchema(
      'https://openslack.dev/contracts/workflow-runner-authority-binding/v1/schemas/workflow-runner-authority-binding-resolution.v1.schema.json',
      'OpenSlack GS9-F2a authority-binding commit_authority',
      resolutions,
      ['schema', 'operation'],
    ),
    unionSchema(
      'https://openslack.dev/contracts/workflow-runner-authority-binding/v1/schemas/workflow-runner-authority-binding-receipt.v1.schema.json',
      'OpenSlack GS9-F2a stage, resolution, and control-delivery receipts',
      receipts,
      ['schema', 'phase', 'operation'],
    ),
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://openslack.dev/contracts/workflow-runner-authority-binding/v1/schemas/workflow-runner-authority-binding-error.v1.schema.json',
      title: 'OpenSlack GS9-F2a authority-binding closed error',
      ...errorSchema,
    },
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://openslack.dev/contracts/workflow-runner-authority-binding/v1/schemas/workflow-runner-v2-runtime-admission.v1.schema.json',
      title: 'OpenSlack Workflow Runner v2 runtime admission',
      ...runtimeAdmissionSchema,
    },
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://openslack.dev/contracts/workflow-runner-authority-binding/v1/schemas/workflow-runner-v2-runtime-admission-receipt.v1.schema.json',
      title: 'OpenSlack Workflow Runner v2 runtime admission receipt',
      ...runtimeAdmissionReceiptSchema,
    },
  ];
}

async function pretty(value: unknown): Promise<Buffer> {
  return Buffer.from(
    await format(JSON.stringify(value), { parser: 'json', printWidth: 100, tabWidth: 2 }),
    'utf8',
  );
}

async function verifySourceLocks(): Promise<void> {
  for (const name of Object.keys(sourceLockPaths) as Array<keyof typeof sourceLockPaths>) {
    const path = sourceLockPaths[name];
    const actual = H(await readFile(resolve(repositoryRoot, path)));
    const expected = WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS[name];
    if (actual !== expected) {
      throw new Error(
        `Authority-binding source lock drift: ${path} = ${actual}; expected ${expected}`,
      );
    }
  }
}

async function outputs(): Promise<Map<string, Buffer>> {
  await verifySourceLocks();
  const golden = await goldenVectors();
  const generatedSchemas = await schemas(golden);
  const map = new Map<string, Buffer>();
  for (let index = 0; index < generatedSchemas.length; index += 1) {
    const path = bundleFiles[index];
    if (path === undefined) {
      throw new Error(`Missing bundle path for generated schema ${index}.`);
    }
    map.set(path, await pretty(generatedSchemas[index]));
  }
  map.set(GOLDEN_BUNDLE_FILE, await pretty(golden));
  const artifacts = Object.fromEntries(
    [...map].map(([path, bytes]) => [
      path,
      { path, byteLength: bytes.byteLength, sha256: H(bytes) },
    ]),
  );
  map.set(
    MANIFEST_BUNDLE_FILE,
    await pretty({
      schema: 'openslack.workflow_runner_authority_binding_contract_manifest.v1',
      contractVersion: WORKFLOW_RUNNER_AUTHORITY_BINDING_CONTRACT_VERSION,
      profile: WORKFLOW_RUNNER_AUTHORITY_BINDING_PROFILE,
      authorityBoundary,
      budgetDecisionDelivery,
      protocol: {
        sequence: ['stage_event', 'stage_event_ack', 'commit_authority', 'commit_authority_ack'],
        independentCompanionSequence: true,
        frozenTargetBytesBoundBeforeAuthority: true,
        resolutionAckPrecedesFrozenTargetDelivery: true,
        controlDeliveryAck: true,
        exactReplayReturnsOriginalReceiptBytes: true,
      },
      runtimeAdmission: {
        requestSchema: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_SCHEMA,
        receiptSchema: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_RECEIPT_SCHEMA,
        keyPrefix: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_KEY_PREFIX,
        domains: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_DOMAINS,
        limits: WORKFLOW_RUNNER_V2_RUNTIME_ADMISSION_LIMITS,
        negativeVectorIds: golden.runtimeAdmissionNegative.map((vector) => vector.id),
      },
      operations: WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATIONS.map((operation) => ({
        operation,
        ...WORKFLOW_RUNNER_AUTHORITY_BINDING_OPERATION_FACTS[operation],
      })),
      negativeVectorIds: golden.negative.map((vector) => vector.id),
      evidence: {
        closed: true,
        rawFieldsForbidden: [
          'provider',
          'providerId',
          'model',
          'modelId',
          'prompt',
          'result',
          'nonce',
          'credential',
          'credentials',
        ],
        providerIdentity: 'hash_only',
        resultIdentity: 'hash_only',
      },
      exactFraming: {
        encoding: 'utf-8',
        canonicalJson: true,
        terminalLfCount: 1,
        carriageReturnAllowed: false,
      },
      sourceLocks: Object.fromEntries(
        (Object.keys(sourceLockPaths) as Array<keyof typeof sourceLockPaths>).map((name) => [
          name,
          {
            path: sourceLockPaths[name],
            sha256: WORKFLOW_RUNNER_AUTHORITY_BINDING_SOURCE_LOCKS[name],
          },
        ]),
      ),
      bundleFiles,
      artifacts,
    }),
  );
  return map;
}

async function inventory(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      const path = resolve(directory, name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Symlink forbidden in contract bundle: ${path}`);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) result.push(relative(root, path).split(sep).join('/'));
      else throw new Error(`Non-regular contract artifact forbidden: ${path}`);
    }
  }
  await visit(root);
  return result.sort();
}

function openAPIBindingSchemaBlock(map: ReadonlyMap<string, Buffer>): string {
  const entries = [
    ['AuthorityBindingStage', bundleFiles[0]],
    ['AuthorityBindingResolution', bundleFiles[1]],
    ['AuthorityBindingReceipt', bundleFiles[2]],
    ['WorkflowRunnerV2RuntimeAdmission', bundleFiles[4]],
    ['WorkflowRunnerV2RuntimeAdmissionReceipt', bundleFiles[5]],
  ] as const;
  const lines = [openAPIBindingSchemaStart];
  for (const [name, path] of entries) {
    const bytes = map.get(path);
    if (!bytes) throw new Error(`Missing generated OpenAPI schema source ${path}.`);
    const schema = JSON.parse(bytes.toString('utf8')) as Json;
    lines.push(`    ${name}:`);
    lines.push(
      ...JSON.stringify(schema, null, 2)
        .split('\n')
        .map((line) => `      ${line}`),
    );
  }
  lines.push(openAPIBindingSchemaEnd);
  return lines.join('\n');
}

async function projectedRunnerOpenAPI(map: ReadonlyMap<string, Buffer>): Promise<string> {
  const current = await readFile(runnerOpenAPIPath, 'utf8');
  const start = current.indexOf(openAPIBindingSchemaStart);
  const end = current.indexOf(openAPIBindingSchemaEnd);
  if (start < 0 || end < start) {
    throw new Error('Runner OpenAPI authority-binding schema marker is missing or invalid.');
  }
  const after = end + openAPIBindingSchemaEnd.length;
  return `${current.slice(0, start)}${openAPIBindingSchemaBlock(map)}${current.slice(after)}`;
}

async function generate(): Promise<void> {
  const map = await outputs();
  for (const [, root] of selectedOutputRoots()) {
    for (const [path, bytes] of map) {
      const destination = resolve(root, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
  }
  await writeFile(runnerOpenAPIPath, await projectedRunnerOpenAPI(map), 'utf8');
}

async function check(): Promise<void> {
  const map = await outputs();
  const expectedInventory = [...bundleFiles].sort();
  const stale: string[] = [];
  for (const [label, root] of selectedOutputRoots()) {
    const actualInventory = await inventory(root);
    if (JSON.stringify(actualInventory) !== JSON.stringify(expectedInventory)) {
      throw new Error(
        `Authority-binding ${label} bundle inventory drift:\nactual=${actualInventory.join(',')}\nexpected=${expectedInventory.join(',')}`,
      );
    }
    for (const [path, expected] of map) {
      const actual = await readFile(resolve(root, path)).catch(() => null);
      if (actual === null || !actual.equals(expected)) stale.push(`${label}:${path}`);
    }
  }
  const currentOpenAPI = await readFile(runnerOpenAPIPath, 'utf8');
  const expectedOpenAPI = await projectedRunnerOpenAPI(map);
  if (currentOpenAPI !== expectedOpenAPI) stale.push('runner-openapi:authority-binding-schemas');
  if (stale.length > 0) {
    throw new Error(
      `Authority-binding contracts are stale:\n${stale.join('\n')}\nRun: bun run workflow:runner-authority-binding-golden -- --generate`,
    );
  }
}

const command = process.argv[2] ?? '--generate';
if (command === '--generate' || command === 'generate') await generate();
else if (command === '--check' || command === 'check') await check();
else throw new Error('Usage: index.ts [--generate|--check]');
