import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  WORKFLOW_CONTROL_AUTHORITY,
  WORKFLOW_CONTROL_AUTHORITY_ADDED_MESSAGE_KINDS,
  WORKFLOW_CONTROL_AUTHORITY_APPROVAL_PLANES,
  WORKFLOW_CONTROL_AUTHORITY_APPROVAL_STATUSES,
  WORKFLOW_CONTROL_AUTHORITY_BUDGET_REVISION_PLANES,
  WORKFLOW_CONTROL_AUTHORITY_CLAIM,
  WORKFLOW_CONTROL_AUTHORITY_CONTRACT_VERSION,
  WORKFLOW_CONTROL_AUTHORITY_DIRECTIONS,
  WORKFLOW_CONTROL_AUTHORITY_ERROR_CODES,
  WORKFLOW_CONTROL_AUTHORITY_GO_ROLE,
  WORKFLOW_CONTROL_AUTHORITY_IDEMPOTENCY_PREFIX,
  WORKFLOW_CONTROL_AUTHORITY_LIMITS,
  WORKFLOW_CONTROL_AUTHORITY_MAX_INT64,
  WORKFLOW_CONTROL_AUTHORITY_MESSAGE_KINDS,
  WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
  WORKFLOW_CONTROL_AUTHORITY_MONEY_SCALE,
  WORKFLOW_CONTROL_AUTHORITY_MONEY_UNIT,
  WORKFLOW_CONTROL_AUTHORITY_PREPARED_SCHEMA,
  WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
  WORKFLOW_CONTROL_AUTHORITY_RECEIPTABLE_KINDS,
  WORKFLOW_CONTROL_AUTHORITY_RECEIPT_OPERATIONS,
  WORKFLOW_CONTROL_AUTHORITY_RECEIPT_SCHEMA,
  WORKFLOW_CONTROL_AUTHORITY_RECEIPT_STATUSES,
  WORKFLOW_CONTROL_AUTHORITY_ROUNDING,
  WORKFLOW_CONTROL_AUTHORITY_RUN_STATES,
  WORKFLOW_CONTROL_AUTHORITY_STATE_SCHEMA,
  WorkflowControlAuthorityContractError,
  prepareWorkflowControlAuthorityMessage,
  validateWorkflowControlAuthorityDecimal,
  validateWorkflowControlAuthorityMessage,
  validateWorkflowControlAuthorityReceipt,
  validateWorkflowControlAuthorityState,
  validateWorkflowControlAuthorityTransition,
  workflowControlAuthorityUsdToNanoUsd,
  type WorkflowControlAuthorityMessage,
  type WorkflowControlAuthorityState,
} from '../../packages/workflows/src/workflow-control-authority-contract.js';

type JsonRecord = Record<string, unknown>;

function jsonRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as JsonRecord;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const outputRoot =
  process.env.OPENSLACK_WORKFLOW_AUTHORITY_CONTRACTS_OUTPUT_ROOT === undefined
    ? repositoryRoot
    : resolve(process.env.OPENSLACK_WORKFLOW_AUTHORITY_CONTRACTS_OUTPUT_ROOT);
const contractRoot = resolve(
  outputRoot,
  'packages/workflows/contracts/workflow-control-authority/v2',
);
const mirrorRoot = resolve(outputRoot, 'services/workflow-control/authoritycontract/generated/v2');
const expectedPaths = Object.freeze([
  'schemas/workflow-control-authority-state.v2.schema.json',
  'schemas/workflow-control-authority-message.v2.schema.json',
  'schemas/workflow-control-authority-prepared-message.v2.schema.json',
  'schemas/workflow-control-authority-receipt.v2.schema.json',
  'golden-vectors.json',
  'manifest.json',
] as const);

const HASH_PATTERN = '^[0-9a-f]{64}$';
const SAFE_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$';
const SAFE_REF_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$';
const TIMESTAMP_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
const DECIMAL_PATTERN = '^(?:0|[1-9][0-9]{0,18})$';
const IDEMPOTENCY_PATTERN = '^openslack\\.workflow-control-authority\\.v2\\.[0-9a-f]{64}$';
const FINGERPRINT_PATTERN = '^sha256:[0-9a-f]{64}$';
const V1_LOCKS = Object.freeze({
  workflowControlManifest: '3c7440ae6254337a6e1d93beb2e531d591fa2f781717d3a8e96d0d2e5d872d86',
  workflowControlGolden: '342c877a46adc5f533d9c9c8b25d1c30c5809d8f219115af3f4e97260f9da023',
  workflowRunnerManifest: '908ff368f35033206b975a0421396f49e588098f040aecef2fdd18cd8b67ece6',
  workflowRunnerGolden: 'b4569ca9e9e3f9b027c1bf3d531760ca9fbf87ecd3f7818204eca367a7fce844',
});

function strictObject(properties: JsonRecord, required = Object.keys(properties)): JsonRecord {
  return { type: 'object', additionalProperties: false, properties, required };
}

const idSchema = { type: 'string', pattern: SAFE_ID_PATTERN };
const refSchema = { type: 'string', pattern: SAFE_REF_PATTERN };
const hashSchema = { type: 'string', pattern: HASH_PATTERN };
const nullableHashSchema = { anyOf: [hashSchema, { type: 'null' }] };
const timestampSchema = { type: 'string', pattern: TIMESTAMP_PATTERN };
const decimalSchema = {
  type: 'string',
  pattern: DECIMAL_PATTERN,
  $comment: `Runtime validation additionally enforces <= ${WORKFLOW_CONTROL_AUTHORITY_MAX_INT64}.`,
};
const safeIntegerSchema = {
  type: 'integer',
  minimum: 0,
  maximum: WORKFLOW_CONTROL_AUTHORITY_LIMITS.maxSafeInteger,
};
const positiveIntegerSchema = { ...safeIntegerSchema, minimum: 1 };
const nullableSafeIntegerSchema = { anyOf: [safeIntegerSchema, { type: 'null' }] };
const routeSchema = strictObject({
  backend: { enum: ['ts-local', 'go'] },
  authority: { enum: ['typescript', 'workflow-control'] },
  routingEpoch: positiveIntegerSchema,
  authorityBuildHash: hashSchema,
});

const checkpointHeadSchema = strictObject({
  checkpointId: idSchema,
  phaseId: idSchema,
  phaseIndex: safeIntegerSchema,
  commitPoint: { const: 'after_phase_work' },
  artifactRef: refSchema,
  artifactHash: hashSchema,
  resultHash: nullableHashSchema,
  cacheKeyHash: nullableHashSchema,
  committedRevision: positiveIntegerSchema,
  resumeGeneration: safeIntegerSchema,
});

const stateSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-control-authority/v2/workflow-control-authority-state.v2.schema.json',
  title: 'OpenSlack GS9-A future Workflow Control authority state v2',
  $comment:
    'Contract-only future state. TypeScript remains the sole writer and Go has NO_AUTHORITY in GS9-A.',
  ...strictObject({
    schema: { const: WORKFLOW_CONTROL_AUTHORITY_STATE_SCHEMA },
    contractVersion: { const: WORKFLOW_CONTROL_AUTHORITY_CONTRACT_VERSION },
    contractAuthority: { const: WORKFLOW_CONTROL_AUTHORITY },
    goRole: { const: WORKFLOW_CONTROL_AUTHORITY_GO_ROLE },
    authorityClaim: { const: WORKFLOW_CONTROL_AUTHORITY_CLAIM },
    workspaceId: idSchema,
    runId: idSchema,
    workflowId: idSchema,
    workflowVersion: idSchema,
    workflowSourceHash: hashSchema,
    manifestHash: hashSchema,
    inputHash: hashSchema,
    route: routeSchema,
    state: { enum: WORKFLOW_CONTROL_AUTHORITY_RUN_STATES },
    revision: positiveIntegerSchema,
    resumeGeneration: safeIntegerSchema,
    currentPhaseId: { anyOf: [idSchema, { type: 'null' }] },
    currentPhaseIndex: nullableSafeIntegerSchema,
    checkpointHead: { anyOf: [checkpointHeadSchema, { type: 'null' }] },
    approvals: strictObject({
      legacyRunGate: strictObject({
        plane: { const: 'legacy_run_gate' },
        status: { enum: WORKFLOW_CONTROL_AUTHORITY_APPROVAL_STATUSES },
        revision: safeIntegerSchema,
        effectDecisionAuthority: { const: false },
      }),
      effectV2: strictObject({
        plane: { const: 'workflow_effect_v2' },
        schema: { const: 'openslack.workflow_effect_approval.v2' },
        status: { enum: WORKFLOW_CONTROL_AUTHORITY_APPROVAL_STATUSES },
        revision: safeIntegerSchema,
        approvalHash: nullableHashSchema,
      }),
    }),
    budget: strictObject({
      policyHash: hashSchema,
      tokenLimit: decimalSchema,
      costLimitNanoUsd: decimalSchema,
      callLimit: decimalSchema,
      reservedTokens: decimalSchema,
      settledTokens: decimalSchema,
      reservedCostNanoUsd: decimalSchema,
      settledCostNanoUsd: decimalSchema,
      reservedCalls: decimalSchema,
      settledCalls: decimalSchema,
    }),
    reconciliationRequired: { type: 'boolean' },
    updatedAt: timestampSchema,
  }),
};

const v1RunnerSchemaPath = resolve(
  repositoryRoot,
  'packages/workflows/contracts/workflow-runner/v1/schemas/workflow-runner-message.v1.schema.json',
);

function authorityEnvelopeProperties(
  kind: string,
  payload: JsonRecord,
  handshake = false,
): JsonRecord {
  return {
    schema: { const: WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA },
    protocolVersion: { const: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION },
    kind: { const: kind },
    workspaceId: idSchema,
    jobId: handshake ? { type: 'null' } : idSchema,
    workflowRunId: handshake ? { type: 'null' } : idSchema,
    attemptId: handshake ? { type: 'null' } : idSchema,
    leaseId: handshake ? { type: 'null' } : idSchema,
    fencingToken: handshake ? { type: 'null' } : positiveIntegerSchema,
    sequence: handshake ? { type: 'null' } : positiveIntegerSchema,
    authorityBackend: handshake ? { type: 'null' } : { enum: ['ts-local', 'go'] },
    authority: handshake ? { type: 'null' } : { enum: ['typescript', 'workflow-control'] },
    routingEpoch: handshake ? { type: 'null' } : positiveIntegerSchema,
    authorityBuildHash: handshake ? { type: 'null' } : hashSchema,
    runRevision: handshake ? { type: 'null' } : positiveIntegerSchema,
    resumeGeneration: handshake ? { type: 'null' } : safeIntegerSchema,
    eventId: idSchema,
    correlationId: idSchema,
    sentAt: timestampSchema,
    payload,
  };
}

function addedPayloadSchemas(): Record<string, JsonRecord> {
  return {
    checkpoint_commit: strictObject({
      checkpointId: idSchema,
      phaseId: idSchema,
      phaseIndex: safeIntegerSchema,
      commitPoint: { const: 'after_phase_work' },
      artifactRef: refSchema,
      artifactHash: hashSchema,
      resultHash: nullableHashSchema,
      cacheKeyHash: nullableHashSchema,
      workflowSourceHash: hashSchema,
      manifestHash: hashSchema,
      inputHash: hashSchema,
    }),
    budget_reserve_request: strictObject({
      reservationId: idSchema,
      callId: idSchema,
      policyHash: hashSchema,
      requestedTokens: decimalSchema,
      requestedCostNanoUsd: decimalSchema,
      requestedCalls: decimalSchema,
    }),
    budget_usage_report: strictObject({
      reservationId: idSchema,
      callId: idSchema,
      providerReceiptHash: hashSchema,
      actualTokens: decimalSchema,
      actualCostNanoUsd: decimalSchema,
      actualCalls: decimalSchema,
      settlementStatus: { enum: ['settled', 'reconciliation_required'] },
    }),
    budget_authorization: strictObject({
      reservationId: idSchema,
      status: { enum: ['reserved', 'rejected', 'reconciliation_required'] },
      authorizedTokens: decimalSchema,
      authorizedCostNanoUsd: decimalSchema,
      authorizedCalls: decimalSchema,
      authorityReceiptHash: hashSchema,
      committedRunRevision: positiveIntegerSchema,
    }),
    effect_authorization: strictObject({
      effectId: idSchema,
      effectHash: hashSchema,
      approvalId: idSchema,
      approvalStatus: { enum: ['approved', 'rejected', 'expired'] },
      decisionRevision: positiveIntegerSchema,
      grantHash: nullableHashSchema,
      authorityReceiptHash: hashSchema,
      expiresAt: timestampSchema,
    }),
    resume_offer: strictObject({
      checkpointId: idSchema,
      checkpointHash: hashSchema,
      nextPhaseId: idSchema,
      nextPhaseIndex: safeIntegerSchema,
      newResumeGeneration: positiveIntegerSchema,
      newAttemptId: idSchema,
      authorityReceiptHash: hashSchema,
      expiresAt: timestampSchema,
    }),
  };
}

async function buildMessageSchema(): Promise<JsonRecord> {
  const v1 = JSON.parse(await readFile(v1RunnerSchemaPath, 'utf8')) as JsonRecord;
  const retained = (v1.oneOf as JsonRecord[]).map((original) => {
    const variant = structuredClone(original);
    const properties = jsonRecord(variant.properties, 'v1 variant properties');
    const kind = jsonRecord(properties.kind, 'v1 kind schema').const as string;
    const handshake = kind === 'hello' || kind === 'hello_ack';
    const payload = jsonRecord(properties.payload, 'v1 payload schema');
    const payloadProperties = jsonRecord(payload.properties, 'v1 payload properties');
    if (kind === 'hello') {
      payloadProperties.supportedProtocolVersions = {
        type: 'array',
        prefixItems: [
          { const: 'openslack.workflow_runner.v1' },
          { const: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION },
        ],
        minItems: 2,
        maxItems: 2,
      };
    } else if (kind === 'hello_ack') {
      payloadProperties.selectedProtocolVersion = {
        const: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
      };
    } else if (kind === 'event_receipt') {
      jsonRecord(payloadProperties.receivedKind, 'received kind schema').enum =
        WORKFLOW_CONTROL_AUTHORITY_RECEIPTABLE_KINDS;
      jsonRecord(payloadProperties.receivedIdempotencyKey, 'received key schema').pattern =
        IDEMPOTENCY_PATTERN;
      payloadProperties.errorCode = {
        anyOf: [
          {
            enum: [
              'WORKFLOW_CONTROL_AUTHORITY_RECONCILIATION_REQUIRED',
              'WORKFLOW_CONTROL_AUTHORITY_STALE_REVISION',
              'WORKFLOW_CONTROL_AUTHORITY_STALE_RESUME_GENERATION',
              'WORKFLOW_CONTROL_AUTHORITY_STALE_FENCE',
            ],
          },
          { type: 'null' },
        ],
      };
    }
    variant.properties = authorityEnvelopeProperties(kind, payload, handshake);
    variant.required = Object.keys(jsonRecord(variant.properties, 'v2 variant properties'));
    return variant;
  });
  const added = Object.entries(addedPayloadSchemas()).map(([kind, payload]) =>
    strictObject(authorityEnvelopeProperties(kind, payload, false)),
  );
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openslack.dev/contracts/workflow-control-authority/v2/workflow-control-authority-message.v2.schema.json',
    title: 'OpenSlack GS9-A complete closed Workflow Runner protocol v2 message',
    $comment:
      'The 12 v1 kinds retain their payload semantics and six authority kinds are added. Runtime negotiation and delivery are not implemented in GS9-A.',
    oneOf: [...retained, ...added],
  };
}

const preparedSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-control-authority/v2/workflow-control-authority-prepared-message.v2.schema.json',
  title: 'OpenSlack GS9-A prepared exact-byte Workflow Runner v2 message',
  ...strictObject({
    schema: { const: WORKFLOW_CONTROL_AUTHORITY_PREPARED_SCHEMA },
    direction: { enum: ['runner-to-control', 'control-to-runner'] },
    body: {
      type: 'string',
      minLength: 2,
      maxLength: WORKFLOW_CONTROL_AUTHORITY_LIMITS.maxMessageBytes,
    },
    messageDigest: hashSchema,
    idempotencyKey: { type: 'string', pattern: IDEMPOTENCY_PATTERN },
    requestFingerprint: { type: 'string', pattern: FINGERPRINT_PATTERN },
  }),
};

const receiptCommon = {
  schema: { const: WORKFLOW_CONTROL_AUTHORITY_RECEIPT_SCHEMA },
  operation: { enum: WORKFLOW_CONTROL_AUTHORITY_RECEIPT_OPERATIONS },
  workspaceId: idSchema,
  runId: idSchema,
  expectedRevision: safeIntegerSchema,
  resumeGeneration: safeIntegerSchema,
  route: routeSchema,
  idempotencyKey: { type: 'string', pattern: IDEMPOTENCY_PATTERN },
  requestFingerprint: { type: 'string', pattern: FINGERPRINT_PATTERN },
  requestHash: hashSchema,
  correlationId: idSchema,
  serviceBuildHash: hashSchema,
};
const receiptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-control-authority/v2/workflow-control-authority-receipt.v2.schema.json',
  title: 'OpenSlack GS9-A future durable authority receipt v2',
  oneOf: [
    strictObject({
      ...receiptCommon,
      status: { enum: ['accepted', 'duplicate'] },
      acceptedRevision: positiveIntegerSchema,
      recordHash: hashSchema,
      committedAt: timestampSchema,
      reconciliationToken: { type: 'null' },
    }),
    strictObject({
      ...receiptCommon,
      status: { const: 'reconciliation_required' },
      acceptedRevision: { type: 'null' },
      recordHash: { type: 'null' },
      committedAt: { type: 'null' },
      reconciliationToken: refSchema,
    }),
  ],
};

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

const H = (value: string): string => sha256(value);
const hashes = Object.freeze({
  source: H('source'),
  manifest: H('manifest'),
  input: H('input'),
  build: H('build'),
  artifact: H('artifact'),
  result: H('result'),
  cache: H('cache'),
  policy: H('policy'),
  approval: H('approval'),
  effect: H('effect'),
  receipt: H('receipt'),
  request: H('request'),
  record: H('record'),
  provider: H('provider'),
  checkpoint: H('checkpoint'),
  grant: H('grant'),
});

function route() {
  return {
    backend: 'ts-local',
    authority: 'typescript',
    routingEpoch: 1,
    authorityBuildHash: hashes.build,
  } as const;
}

function baseState(): WorkflowControlAuthorityState {
  return validateWorkflowControlAuthorityState({
    schema: WORKFLOW_CONTROL_AUTHORITY_STATE_SCHEMA,
    contractVersion: WORKFLOW_CONTROL_AUTHORITY_CONTRACT_VERSION,
    contractAuthority: WORKFLOW_CONTROL_AUTHORITY,
    goRole: WORKFLOW_CONTROL_AUTHORITY_GO_ROLE,
    authorityClaim: WORKFLOW_CONTROL_AUTHORITY_CLAIM,
    workspaceId: 'workspace-gs9',
    runId: 'run-gs9-001',
    workflowId: 'contract-delivery-lite',
    workflowVersion: '1.0.0',
    workflowSourceHash: hashes.source,
    manifestHash: hashes.manifest,
    inputHash: hashes.input,
    route: route(),
    state: 'running',
    revision: 4,
    resumeGeneration: 1,
    currentPhaseId: 'verify',
    currentPhaseIndex: 1,
    checkpointHead: {
      checkpointId: 'checkpoint-discover-1',
      phaseId: 'discover',
      phaseIndex: 0,
      commitPoint: 'after_phase_work',
      artifactRef: 'artifact/checkpoint-discover-1',
      artifactHash: hashes.artifact,
      resultHash: hashes.result,
      cacheKeyHash: hashes.cache,
      committedRevision: 3,
      resumeGeneration: 1,
    },
    approvals: {
      legacyRunGate: {
        plane: 'legacy_run_gate',
        status: 'pending',
        revision: 0,
        effectDecisionAuthority: false,
      },
      effectV2: {
        plane: 'workflow_effect_v2',
        schema: 'openslack.workflow_effect_approval.v2',
        status: 'approved',
        revision: 2,
        approvalHash: hashes.approval,
      },
    },
    budget: {
      policyHash: hashes.policy,
      tokenLimit: WORKFLOW_CONTROL_AUTHORITY_MAX_INT64,
      costLimitNanoUsd: '1000000000',
      callLimit: '100',
      reservedTokens: '9007199254740993',
      settledTokens: '9007199254740992',
      reservedCostNanoUsd: '125000001',
      settledCostNanoUsd: '125000000',
      reservedCalls: '3',
      settledCalls: '2',
    },
    reconciliationRequired: false,
    updatedAt: '2026-08-04T03:00:00.000Z',
  });
}

function message(kind: string, payload: JsonRecord): JsonRecord {
  return {
    schema: WORKFLOW_CONTROL_AUTHORITY_MESSAGE_SCHEMA,
    protocolVersion: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
    kind,
    workspaceId: 'workspace-gs9',
    jobId: 'job-gs9-001',
    workflowRunId: 'run-gs9-001',
    attemptId: 'attempt-gs9-001',
    leaseId: 'lease-gs9-001',
    fencingToken: 7,
    sequence: 11,
    authorityBackend: 'ts-local',
    authority: 'typescript',
    routingEpoch: 1,
    authorityBuildHash: hashes.build,
    runRevision: 4,
    resumeGeneration: 1,
    eventId: `event-${kind}`,
    correlationId: 'corr-gs9-001',
    sentAt: '2026-08-04T03:01:00.000Z',
    payload,
  };
}

function positiveMessages(): WorkflowControlAuthorityMessage[] {
  const values: JsonRecord[] = [
    message('checkpoint_commit', {
      checkpointId: 'checkpoint-verify-1',
      phaseId: 'verify',
      phaseIndex: 1,
      commitPoint: 'after_phase_work',
      artifactRef: 'artifact/checkpoint-verify-1',
      artifactHash: hashes.artifact,
      resultHash: hashes.result,
      cacheKeyHash: hashes.cache,
      workflowSourceHash: hashes.source,
      manifestHash: hashes.manifest,
      inputHash: hashes.input,
    }),
    message('budget_reserve_request', {
      reservationId: 'reservation-1',
      callId: 'call-1',
      policyHash: hashes.policy,
      requestedTokens: '9007199254740993',
      requestedCostNanoUsd: '125000001',
      requestedCalls: '1',
    }),
    message('budget_usage_report', {
      reservationId: 'reservation-1',
      callId: 'call-1',
      providerReceiptHash: hashes.provider,
      actualTokens: '9007199254740992',
      actualCostNanoUsd: '125000000',
      actualCalls: '1',
      settlementStatus: 'settled',
    }),
    message('budget_authorization', {
      reservationId: 'reservation-1',
      status: 'reserved',
      authorizedTokens: '9007199254740993',
      authorizedCostNanoUsd: '125000001',
      authorizedCalls: '1',
      authorityReceiptHash: hashes.receipt,
      committedRunRevision: 5,
    }),
    message('effect_authorization', {
      effectId: 'effect-1',
      effectHash: hashes.effect,
      approvalId: 'approval-1',
      approvalStatus: 'approved',
      decisionRevision: 1,
      grantHash: hashes.grant,
      authorityReceiptHash: hashes.receipt,
      expiresAt: '2026-08-04T03:05:00.000Z',
    }),
    message('resume_offer', {
      checkpointId: 'checkpoint-verify-1',
      checkpointHash: hashes.checkpoint,
      nextPhaseId: 'deliver',
      nextPhaseIndex: 2,
      newResumeGeneration: 2,
      newAttemptId: 'attempt-gs9-002',
      authorityReceiptHash: hashes.receipt,
      expiresAt: '2026-08-04T03:05:00.000Z',
    }),
    message('heartbeat', {
      observedAt: '2026-08-04T03:01:00.000Z',
      leaseExpiresAt: '2026-08-04T03:02:00.000Z',
      state: 'running',
      lastReceiptSequence: 3,
    }),
  ];
  const hello = message('hello', {
    runtimeName: 'node',
    runtimeVersion: '22.14.0',
    runnerBuildHash: hashes.build,
    supportedProtocolVersions: [
      'openslack.workflow_runner.v1',
      WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
    ],
    capabilities: ['cancel_ack', 'effect_receipts', 'lease_heartbeat'],
    maxConcurrentJobs: 1,
  });
  for (const field of [
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
  ])
    hello[field] = null;
  values.push(hello);
  return values.map((value) => validateWorkflowControlAuthorityMessage(value));
}

function acceptedReceipt() {
  return validateWorkflowControlAuthorityReceipt({
    schema: WORKFLOW_CONTROL_AUTHORITY_RECEIPT_SCHEMA,
    operation: 'checkpoint_commit',
    status: 'accepted',
    workspaceId: 'workspace-gs9',
    runId: 'run-gs9-001',
    expectedRevision: 4,
    acceptedRevision: 5,
    resumeGeneration: 1,
    route: route(),
    idempotencyKey: `${WORKFLOW_CONTROL_AUTHORITY_IDEMPOTENCY_PREFIX}${hashes.request}`,
    requestFingerprint: `sha256:${hashes.request}`,
    requestHash: hashes.request,
    recordHash: hashes.record,
    correlationId: 'corr-gs9-001',
    serviceBuildHash: hashes.build,
    committedAt: '2026-08-04T03:02:00.000Z',
    reconciliationToken: null,
  });
}

function reconciliationReceipt() {
  return validateWorkflowControlAuthorityReceipt({
    ...acceptedReceipt(),
    status: 'reconciliation_required',
    acceptedRevision: null,
    recordHash: null,
    committedAt: null,
    reconciliationToken: 'reconcile-gs9-001',
  });
}

function errorOf(operation: () => unknown): JsonRecord {
  try {
    operation();
  } catch (error) {
    if (error instanceof WorkflowControlAuthorityContractError) {
      return { name: error.name, code: error.code, path: error.path, message: error.message };
    }
    throw error;
  }
  throw new Error('Golden negative case unexpectedly succeeded.');
}

function goldenVectors(): JsonRecord {
  const state = baseState();
  const messages = positiveMessages();
  const checkpoint = messages.find((entry) => entry.kind === 'checkpoint_commit')!;
  const invalidPlane = structuredClone(state) as unknown as JsonRecord;
  jsonRecord(
    jsonRecord(invalidPlane.approvals, 'approvals').legacyRunGate,
    'legacy run gate',
  ).effectDecisionAuthority = true;
  const invalidDecimalMessage = structuredClone(
    messages.find((entry) => entry.kind === 'budget_reserve_request')!,
  ) as unknown as JsonRecord;
  jsonRecord(invalidDecimalMessage.payload, 'budget reserve payload').requestedTokens = '01';
  const futureCheckpoint = structuredClone(state) as unknown as JsonRecord;
  jsonRecord(futureCheckpoint.checkpointHead, 'checkpoint head').resumeGeneration = 2;
  const invalidTimestamp = structuredClone(state) as unknown as JsonRecord;
  invalidTimestamp.updatedAt = '2026-13-01T00:00:00.000Z';
  const rejectedBudgetAuthorization = structuredClone(
    messages.find((entry) => entry.kind === 'budget_authorization')!,
  ) as unknown as JsonRecord;
  jsonRecord(rejectedBudgetAuthorization.payload, 'budget authorization payload').status =
    'rejected';
  const oldProtocol = { ...checkpoint, protocolVersion: 'openslack.workflow_runner.v1' };
  return {
    schema: 'openslack.workflow_control_authority_golden_vectors.v2',
    contractVersion: WORKFLOW_CONTROL_AUTHORITY_CONTRACT_VERSION,
    authority: WORKFLOW_CONTROL_AUTHORITY,
    goRole: WORKFLOW_CONTROL_AUTHORITY_GO_ROLE,
    authorityClaim: WORKFLOW_CONTROL_AUTHORITY_CLAIM,
    positive: {
      state,
      messages: messages.map((entry) => ({
        kind: entry.kind,
        input: entry,
        prepared: prepareWorkflowControlAuthorityMessage(entry),
      })),
      receipts: [acceptedReceipt(), reconciliationReceipt()],
      transitions: [
        { from: 'running', to: 'completed', allowed: true },
        { from: 'completed', to: 'running', allowed: false },
      ],
      decimals: [
        { input: '0', expected: validateWorkflowControlAuthorityDecimal('0') },
        {
          input: '9007199254740993',
          expected: validateWorkflowControlAuthorityDecimal('9007199254740993'),
        },
        {
          input: WORKFLOW_CONTROL_AUTHORITY_MAX_INT64,
          expected: validateWorkflowControlAuthorityDecimal(WORKFLOW_CONTROL_AUTHORITY_MAX_INT64),
        },
      ],
      usdToNanoUsd: [
        { input: '0.0000000004', expected: workflowControlAuthorityUsdToNanoUsd('0.0000000004') },
        { input: '0.0000000005', expected: workflowControlAuthorityUsdToNanoUsd('0.0000000005') },
        { input: '1.2345678915', expected: workflowControlAuthorityUsdToNanoUsd('1.2345678915') },
      ],
    },
    negative: [
      {
        id: 'approval-plane-mismatch',
        operation: 'validate_state',
        input: invalidPlane,
        expectedError: errorOf(() => validateWorkflowControlAuthorityState(invalidPlane)),
      },
      {
        id: 'decimal-leading-zero',
        operation: 'validate_message',
        input: invalidDecimalMessage,
        expectedError: errorOf(() =>
          validateWorkflowControlAuthorityMessage(invalidDecimalMessage),
        ),
      },
      {
        id: 'decimal-overflow',
        operation: 'validate_decimal',
        input: '9223372036854775808',
        expectedError: errorOf(() =>
          validateWorkflowControlAuthorityDecimal('9223372036854775808'),
        ),
      },
      {
        id: 'checkpoint-future-generation',
        operation: 'validate_state',
        input: futureCheckpoint,
        expectedError: errorOf(() => validateWorkflowControlAuthorityState(futureCheckpoint)),
      },
      {
        id: 'calendar-invalid-timestamp',
        operation: 'validate_state',
        input: invalidTimestamp,
        expectedError: errorOf(() => validateWorkflowControlAuthorityState(invalidTimestamp)),
      },
      {
        id: 'rejected-budget-cannot-authorize-spend',
        operation: 'validate_message',
        input: rejectedBudgetAuthorization,
        expectedError: errorOf(() =>
          validateWorkflowControlAuthorityMessage(rejectedBudgetAuthorization),
        ),
      },
      {
        id: 'v1-downgrade-forbidden',
        operation: 'validate_message',
        input: oldProtocol,
        expectedError: errorOf(() => validateWorkflowControlAuthorityMessage(oldProtocol)),
      },
      {
        id: 'terminal-transition',
        operation: 'transition',
        input: { from: 'completed', to: 'running' },
        expectedError: errorOf(() =>
          validateWorkflowControlAuthorityTransition('completed', 'running'),
        ),
      },
    ],
    v1Locks: V1_LOCKS,
  };
}

async function prettyJson(value: unknown): Promise<Buffer> {
  return Buffer.from(
    await format(JSON.stringify(value), { parser: 'json', printWidth: 100, tabWidth: 2 }),
    'utf8',
  );
}

async function verifyV1Locks(): Promise<void> {
  const files = {
    workflowControlManifest: 'packages/workflows/contracts/workflow-control/v1/manifest.json',
    workflowControlGolden: 'packages/workflows/contracts/workflow-control/v1/golden-vectors.json',
    workflowRunnerManifest: 'packages/workflows/contracts/workflow-runner/v1/manifest.json',
    workflowRunnerGolden: 'packages/workflows/contracts/workflow-runner/v1/golden-vectors.json',
  } as const;
  for (const [name, path] of Object.entries(files) as [keyof typeof files, string][]) {
    const digest = sha256(await readFile(resolve(repositoryRoot, path)));
    if (digest !== V1_LOCKS[name])
      throw new Error(`Refusing v1 contract drift: ${path} = ${digest}`);
  }
}

async function buildOutputs(): Promise<Map<string, Buffer>> {
  await verifyV1Locks();
  const outputs = new Map<string, Buffer>();
  outputs.set(expectedPaths[0], await prettyJson(stateSchema));
  outputs.set(expectedPaths[1], await prettyJson(await buildMessageSchema()));
  outputs.set(expectedPaths[2], await prettyJson(preparedSchema));
  outputs.set(expectedPaths[3], await prettyJson(receiptSchema));
  outputs.set(expectedPaths[4], await prettyJson(goldenVectors()));
  const artifacts = Object.fromEntries(
    [...outputs].map(([path, bytes]) => [
      path,
      { path, byteLength: bytes.byteLength, sha256: sha256(bytes) },
    ]),
  );
  outputs.set(
    expectedPaths[5],
    await prettyJson({
      schema: 'openslack.workflow_control_authority_contract_manifest.v2',
      contractVersion: WORKFLOW_CONTROL_AUTHORITY_CONTRACT_VERSION,
      contractAuthority: WORKFLOW_CONTROL_AUTHORITY,
      authorityBoundary: {
        currentWriter: '@openslack/workflows',
        typescriptRemainsSoleWriter: true,
        goRole: WORKFLOW_CONTROL_AUTHORITY_GO_ROLE,
        authorityClaim: WORKFLOW_CONTROL_AUTHORITY_CLAIM,
        authorityEligible: false,
        postgresAuthorityImplemented: false,
        routingActivated: false,
      },
      protocol: {
        version: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
        baseVersion: 'openslack.workflow_runner.v1',
        retainedKinds: WORKFLOW_CONTROL_AUTHORITY_MESSAGE_KINDS.filter(
          (kind) => !new Set<string>(WORKFLOW_CONTROL_AUTHORITY_ADDED_MESSAGE_KINDS).has(kind),
        ),
        addedKinds: WORKFLOW_CONTROL_AUTHORITY_ADDED_MESSAGE_KINDS,
        kinds: WORKFLOW_CONTROL_AUTHORITY_MESSAGE_KINDS,
        directions: WORKFLOW_CONTROL_AUTHORITY_DIRECTIONS,
        receiptableKinds: WORKFLOW_CONTROL_AUTHORITY_RECEIPTABLE_KINDS,
        helloAdvertises: [
          'openslack.workflow_runner.v1',
          WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
        ],
        helloAckSelects: WORKFLOW_CONTROL_AUTHORITY_PROTOCOL_VERSION,
        oldWorkerDisposition: 'fail_closed_for_v2_required_run',
        runtimeNegotiationImplemented: false,
        runtimeDeliveryImplemented: false,
      },
      concurrency: {
        workflowCAS: [
          'expected_run_revision',
          'authority_route',
          'expected_state',
          'expected_phase',
          'resume_generation',
        ],
        runnerFencing: ['job_id', 'attempt_id', 'lease_id', 'fencing_token'],
        interchangeable: false,
      },
      checkpoint: {
        commitPoint: 'durable_authority_receipt_after_phase_work',
        acceptedReceiptStatuses: ['accepted', 'duplicate'],
        rawResultAllowed: false,
        unknownOutcome: 'reconciliation_required',
      },
      approvals: {
        planes: WORKFLOW_CONTROL_AUTHORITY_APPROVAL_PLANES,
        interchangeable: false,
        legacyRunGateEffectDecisionAuthority: false,
        effectAuthorizationCarriesHumanAttestation: false,
      },
      budget: {
        quantityEncoding: 'canonical_nonnegative_int64_decimal_string',
        max: WORKFLOW_CONTROL_AUTHORITY_MAX_INT64,
        moneyUnit: WORKFLOW_CONTROL_AUTHORITY_MONEY_UNIT,
        moneyScale: WORKFLOW_CONTROL_AUTHORITY_MONEY_SCALE,
        rounding: WORKFLOW_CONTROL_AUTHORITY_ROUNDING,
        binaryFloatingPointAuthority: false,
        flow: ['reserve_before_provider_call', 'settle_by_exact_provider_receipt'],
        nonReservedAuthorization: 'zero_tokens_cost_and_calls',
        unknownSettlement: 'reconciliation_required',
        revisionPlanes: WORKFLOW_CONTROL_AUTHORITY_BUDGET_REVISION_PLANES,
      },
      receipts: {
        operations: WORKFLOW_CONTROL_AUTHORITY_RECEIPT_OPERATIONS,
        statuses: WORKFLOW_CONTROL_AUTHORITY_RECEIPT_STATUSES,
        idempotencyPrefix: WORKFLOW_CONTROL_AUTHORITY_IDEMPOTENCY_PREFIX,
        sameKeySameFingerprint: 'exact_original_receipt',
        sameKeyDifferentFingerprint: 'conflict',
      },
      canonicalization: {
        encoding: 'utf-8',
        objectKeys: 'lexicographic-ecmascript-code-unit',
        messageBody: 'canonical-json-plus-one-lf',
        hash: 'sha256',
        duplicateKeys: 'rejected',
      },
      limits: WORKFLOW_CONTROL_AUTHORITY_LIMITS,
      errorCodes: WORKFLOW_CONTROL_AUTHORITY_ERROR_CODES,
      v1Locks: V1_LOCKS,
      qualification: {
        localStatus: 'LOCAL_PASS_when_all_exact_byte_and_parity_gates_pass',
        goAuthority: 'NOT_CLAIMED',
        deferred: [
          'postgres_authority',
          'runtime_protocol_v2',
          'routing',
          'canary',
          'typescript_writer_removal',
        ],
      },
      artifacts,
      bundleFiles: expectedPaths,
    }),
  );
  return outputs;
}

function ensureInside(root: string, candidate: string): void {
  const path = relative(root, candidate);
  if (path === '..' || path.startsWith(`..${sep}`) || resolve(candidate) === resolve(root))
    throw new Error(`Output path escapes contract root: ${candidate}`);
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(current, entry.name);
    ensureInside(root, absolute);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) throw new Error(`Contract bundle rejects symlink ${absolute}`);
    if (stats.isDirectory()) files.push(...(await listFiles(root, absolute)));
    else if (stats.isFile()) files.push(relative(root, absolute).split(sep).join('/'));
    else throw new Error(`Contract bundle rejects non-file ${absolute}`);
  }
  return files.sort();
}

async function writeOutputs(root: string, outputs: Map<string, Buffer>): Promise<void> {
  for (const [path, bytes] of outputs) {
    const absolute = resolve(root, path);
    ensureInside(root, absolute);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
}

async function checkOutputs(root: string, outputs: Map<string, Buffer>): Promise<void> {
  const actualPaths = await listFiles(root);
  const wantedPaths = [...outputs.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(wantedPaths))
    throw new Error(`Workflow authority inventory drift: ${actualPaths.join(', ')}`);
  for (const [path, expected] of outputs) {
    const actual = await readFile(resolve(root, path));
    if (!actual.equals(expected)) throw new Error(`Workflow authority exact-byte drift: ${path}`);
  }
}

const outputs = await buildOutputs();
if (process.argv.includes('--check')) {
  await checkOutputs(contractRoot, outputs);
  await checkOutputs(mirrorRoot, outputs);
  console.log(
    `Workflow Control authority v2 bundle and Go mirror verified (${outputs.size} exact-byte files each).`,
  );
} else {
  await writeOutputs(contractRoot, outputs);
  await writeOutputs(mirrorRoot, outputs);
  console.log(
    `Workflow Control authority v2 bundle and Go mirror generated (${outputs.size} exact-byte files each).`,
  );
}
