import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  WORKFLOW_EFFECT_CONTROL_ARTIFACT_KINDS,
  WORKFLOW_EFFECT_CONTROL_ARTIFACT_SCHEMA,
  WORKFLOW_EFFECT_CONTROL_AUTHORITY_V2_GOLDEN_SHA256,
  WORKFLOW_EFFECT_CONTROL_AUTHORITY_V2_MANIFEST_SHA256,
  WORKFLOW_EFFECT_CONTROL_AUTHORITY_CLAIM,
  WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION,
  WORKFLOW_EFFECT_CONTROL_CHECKPOINT_GOLDEN_SHA256,
  WORKFLOW_EFFECT_CONTROL_CHECKPOINT_MANIFEST_SHA256,
  WORKFLOW_EFFECT_CONTROL_ENVELOPE_SCHEMA,
  WORKFLOW_EFFECT_CONTROL_GO_ROLE,
  WORKFLOW_EFFECT_CONTROL_HUMAN_DECISION_SCHEMA,
  WORKFLOW_EFFECT_CONTROL_IDEMPOTENCY_PREFIX,
  WORKFLOW_EFFECT_CONTROL_HUMAN_DECISION_FIELDS,
  WORKFLOW_EFFECT_CONTROL_LIMITS,
  WORKFLOW_EFFECT_CONTROL_OBSERVATION_SCHEMA,
  WORKFLOW_EFFECT_CONTROL_OBSERVER_OPERATIONS,
  WORKFLOW_EFFECT_CONTROL_ROUTE,
  WORKFLOW_EFFECT_CONTROL_RUNNER_V1_GOLDEN_SHA256,
  WORKFLOW_EFFECT_CONTROL_RUNNER_V1_MANIFEST_SHA256,
  WORKFLOW_EFFECT_CONTROL_SANITIZED_HUMAN_DECISION_FIELDS,
  canonicalWorkflowEffectControlJson,
  deriveWorkflowEffectApprovalId,
  deriveWorkflowEffectOccurrenceId,
  hashWorkflowEffectApprovalDecision,
  hashWorkflowEffectApprovalRecord,
  hashWorkflowEffectControlDomain,
  hashWorkflowEffectControlObservation,
  hashWorkflowEffectIntentBinding,
  prepareWorkflowEffectControlEnvelope,
  projectWorkflowEffectControlObservation,
  projectWorkflowEffectHumanDecision,
  validateWorkflowEffectControlArtifact,
  type WorkflowEffectControlArtifact,
  type WorkflowEffectControlEnvelope,
  type WorkflowEffectIntentArtifact,
} from '../../packages/workflows/src/workflow-effect-control-contract.js';
import {
  createPendingWorkflowEffectApproval,
  validateWorkflowEffectApproval,
  workflowEffectApprovalAuditEventId,
  type WorkflowEffectApprovalRecord,
} from '../../packages/workflows/src/workflow-effect-approval.js';
import {
  WORKFLOW_RUNNER_PROTOCOL_VERSION,
  createWorkflowRunnerEventReceipt,
  prepareWorkflowRunnerMessage,
  type WorkflowRunnerEffectIntentMessage,
} from '../../packages/workflows/src/workflow-runner-contract.js';
import { hashWorkflowRunnerDomain } from '../../packages/workflows/src/workflow-runner-descriptor.js';

type Json = Record<string, unknown>;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outputRoot = process.env.OPENSLACK_WORKFLOW_EFFECT_CONTROL_CONTRACTS_OUTPUT_ROOT
  ? resolve(process.env.OPENSLACK_WORKFLOW_EFFECT_CONTROL_CONTRACTS_OUTPUT_ROOT)
  : root;
const contractRoot = resolve(outputRoot, 'packages/workflows/contracts/workflow-effect-control/v1');
const paths = [
  'schemas/workflow-effect-control-artifact.v1.schema.json',
  'schemas/workflow-effect-approval-record.v2.schema.json',
  'schemas/workflow-effect-control-human-decision.v1.schema.json',
  'schemas/workflow-effect-control-observation.v1.schema.json',
  'schemas/workflow-effect-control-envelope.v1.schema.json',
  'golden-vectors.json',
  'manifest.json',
] as const;

const H = '^[0-9a-f]{64}$';
const ID = '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$';
const CAP = '^[a-z][A-Za-z0-9_-]*(?:\\.[a-z][A-Za-z0-9_-]*)+$';
const CODE = '^[a-z0-9][a-z0-9._:-]{0,127}$';
const SEMVER =
  '^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(?:0|[1-9]\\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$';
const TIME = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
const UUID4 = '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const strict = (properties: Json, required: readonly string[] = Object.keys(properties)): Json => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const hash = { type: 'string', pattern: H };
const id = { type: 'string', pattern: ID, maxLength: 256 };
const capability = { type: 'string', pattern: CAP, maxLength: 512 };
const time = { type: 'string', pattern: TIME, format: 'date-time' };
const nullableHash = { oneOf: [hash, { type: 'null' }] };
const VALIDATION_CONTEXT = Object.freeze({ expectedControlBuildHash: '2'.repeat(64) });

const approvalCommon = {
  schema: { const: 'openslack.workflow_effect_approval.v2' },
  runId: id,
  approvalId: id,
  correlationId: id,
  workflowId: id,
  workflowVersion: { type: 'string', pattern: SEMVER, maxLength: 512 },
  workflowHash: hash,
  inputHash: hash,
  effectId: id,
  effectHash: hash,
  requiredCapability: capability,
  createdAt: time,
  expiresAt: time,
};
const decision = strict({
  principalId: id,
  workspaceId: id,
  capability,
  reasonHash: hash,
  attestationNonce: { type: 'string', pattern: UUID4 },
  decidedAt: time,
});
const auditPending = strict({ status: { const: 'pending' }, eventId: id });
const auditRecorded = strict({ status: { const: 'recorded' }, eventId: id, recordedAt: time });
const approvalSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-effect-control/v1/schemas/workflow-effect-approval-record.v2.schema.json',
  oneOf: [
    strict({
      ...approvalCommon,
      revision: { const: 0 },
      status: { const: 'pending' },
      decision: { type: 'null' },
      auditProjection: { type: 'null' },
    }),
    ...(['approved', 'rejected'] as const).flatMap((status) => [
      strict({
        ...approvalCommon,
        revision: { const: 1 },
        status: { const: status },
        decision,
        auditProjection: auditPending,
      }),
      strict({
        ...approvalCommon,
        revision: { const: 2 },
        status: { const: status },
        decision,
        auditProjection: auditRecorded,
      }),
    ]),
  ],
};

const humanProperties = {
  schema: { const: WORKFLOW_EFFECT_CONTROL_HUMAN_DECISION_SCHEMA },
  channel: { const: 'local_human_attestation_tty_v1' },
  principalId: id,
  workspaceId: id,
  capability,
  runId: id,
  approvalId: id,
  correlationId: id,
  decision: { enum: ['approved', 'rejected'] },
  reasonHash: hash,
  approvalExpiresAt: time,
  issuedAt: time,
  expiresAt: time,
  nonce: { type: 'string', pattern: UUID4 },
  bindingHash: hash,
  attestationHash: hash,
  decidedAt: time,
} satisfies Record<(typeof WORKFLOW_EFFECT_CONTROL_HUMAN_DECISION_FIELDS)[number], unknown>;
const humanSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-effect-control/v1/schemas/workflow-effect-control-human-decision.v1.schema.json',
  ...strict(humanProperties, WORKFLOW_EFFECT_CONTROL_HUMAN_DECISION_FIELDS),
};
const sanitizedHuman = strict(
  Object.fromEntries(
    WORKFLOW_EFFECT_CONTROL_SANITIZED_HUMAN_DECISION_FIELDS.map((field) => [
      field,
      humanProperties[field],
    ]),
  ),
  WORKFLOW_EFFECT_CONTROL_SANITIZED_HUMAN_DECISION_FIELDS,
);

const artifactBase = {
  schema: { const: WORKFLOW_EFFECT_CONTROL_ARTIFACT_SCHEMA },
  contractVersion: { const: WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION },
  authority: { const: 'typescript' },
  writer: { const: '@openslack/workflows' },
  goRole: { const: 'validator_only' },
  goAuthorityClaim: { const: 'NO_AUTHORITY' },
  goAuthorityEligible: { const: false },
  workspaceId: id,
  runId: id,
  occurrenceIndex: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  occurrenceId: { type: 'string', pattern: '^WFOCCURRENCE-[0-9a-f]{64}$' },
};
const runnerMessageRef =
  'https://openslack.dev/contracts/workflow-runner/v1/workflow-runner-message.v1.schema.json';
const runnerPreparedRef =
  'https://openslack.dev/contracts/workflow-runner/v1/workflow-runner-prepared-message.v1.schema.json';
const effectIntent = strict({
  ...artifactBase,
  kind: { const: 'effect_intent' },
  runnerV1Message: {
    allOf: [
      { $ref: runnerMessageRef },
      strict({
        protocolVersion: { const: WORKFLOW_RUNNER_PROTOCOL_VERSION },
        kind: { const: 'effect_intent' },
        workspaceId: id,
        jobId: id,
        workflowRunId: id,
        attemptId: id,
        leaseId: id,
        fencingToken: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        sequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        eventId: id,
        correlationId: id,
        sentAt: time,
        payload: strict({
          effectId: id,
          effectKind: { type: 'string', pattern: CODE, maxLength: 128 },
          effectHash: hash,
          capabilityHash: hash,
          requiresHumanDecision: { const: true },
        }),
      }),
    ],
  },
  runnerV1Prepared: { $ref: runnerPreparedRef },
  runnerV1Receipt: {
    allOf: [
      { $ref: runnerMessageRef },
      strict({
        protocolVersion: { const: WORKFLOW_RUNNER_PROTOCOL_VERSION },
        kind: { const: 'event_receipt' },
        workspaceId: id,
        jobId: id,
        workflowRunId: id,
        attemptId: id,
        leaseId: id,
        fencingToken: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        sequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        eventId: id,
        correlationId: id,
        sentAt: time,
        payload: strict({
          receivedEventId: id,
          receivedKind: { const: 'effect_intent' },
          receivedSequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          receivedDigest: hash,
          receivedIdempotencyKey: id,
          receivedFingerprint: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          status: { enum: ['accepted', 'duplicate'] },
          controlBuildHash: hash,
          committedAt: time,
          errorCode: { type: 'null' },
        }),
      }),
    ],
  },
});
const approvalArtifactBase = {
  ...artifactBase,
  approvalGeneration: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  intentArtifact: { $ref: '#/$defs/effectIntent' },
  intentBindingHash: hash,
  intentEffectId: id,
  intentEffectHash: hash,
  correlationId: id,
  approval: { $ref: 'workflow-effect-approval-record.v2.schema.json' },
  approvalRecordHash: hash,
  approvalDecisionHash: nullableHash,
};
const approvalAtRevision = (revision: 0 | 1 | 2, status: 'pending' | 'recorded' | null) => ({
  allOf: [
    { $ref: 'workflow-effect-approval-record.v2.schema.json' },
    {
      type: 'object',
      properties: {
        revision: { const: revision },
        auditProjection:
          status === null
            ? { type: 'null' }
            : {
                type: 'object',
                properties: { status: { const: status } },
                required: ['status'],
              },
      },
      required: ['revision', 'auditProjection'],
    },
  ],
});
const executionClaimBase = {
  ...approvalArtifactBase,
  kind: { const: 'effect_execution_claim' },
  approvalDecisionHash: hash,
  humanDecision: { $ref: 'workflow-effect-control-human-decision.v1.schema.json' },
  executionId: { type: 'string', pattern: '^WFEXECUTION-[0-9a-f]{64}$' },
  approval: {
    allOf: [
      { $ref: 'workflow-effect-approval-record.v2.schema.json' },
      { type: 'object', properties: { status: { const: 'approved' } }, required: ['status'] },
    ],
  },
  consumedApprovalRecordHash: hash,
  consumedApprovalRevision: { enum: [1, 2] },
  claimedAt: time,
};
const artifactSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-effect-control/v1/schemas/workflow-effect-control-artifact.v1.schema.json',
  $defs: { effectIntent },
  oneOf: [
    { $ref: '#/$defs/effectIntent' },
    strict({
      ...approvalArtifactBase,
      kind: { const: 'effect_approval_pending' },
      approval: approvalAtRevision(0, null),
      approvalDecisionHash: { type: 'null' },
    }),
    strict({
      ...approvalArtifactBase,
      kind: { const: 'effect_decision_committed' },
      approval: approvalAtRevision(1, 'pending'),
      approvalDecisionHash: hash,
      humanDecision: { $ref: 'workflow-effect-control-human-decision.v1.schema.json' },
    }),
    strict({
      ...approvalArtifactBase,
      kind: { const: 'effect_audit_recorded' },
      approval: approvalAtRevision(2, 'recorded'),
      approvalDecisionHash: hash,
      humanDecision: { $ref: 'workflow-effect-control-human-decision.v1.schema.json' },
    }),
    strict({
      ...executionClaimBase,
      claimRevision: { const: 0 },
      claimStatus: { const: 'claimed' },
      outcomeHash: { type: 'null' },
      committedAt: { type: 'null' },
      reconciliationToken: { type: 'null' },
    }),
    strict({
      ...executionClaimBase,
      claimRevision: { const: 1 },
      claimStatus: { const: 'executed' },
      outcomeHash: hash,
      committedAt: time,
      reconciliationToken: { type: 'null' },
    }),
    strict({
      ...executionClaimBase,
      claimRevision: { const: 1 },
      claimStatus: { const: 'reconciliation_required' },
      outcomeHash: { type: 'null' },
      committedAt: time,
      reconciliationToken: id,
    }),
    strict({
      ...artifactBase,
      kind: { const: 'legacy_run_gate_observation' },
      plane: { const: 'legacy_run_gate' },
      semantics: { const: 'run_gate_only' },
      status: { enum: ['pending', 'approved', 'rejected', 'expired'] },
      revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      legacyProjectionHash: hash,
      observedAt: time,
      effectDecisionAuthority: { const: false },
      effectExecutionAuthority: { const: false },
    }),
  ],
};

const observationBase = {
  schema: { const: WORKFLOW_EFFECT_CONTROL_OBSERVATION_SCHEMA },
  contractVersion: { const: 'v1' },
  authority: { const: 'typescript' },
  goRole: { const: WORKFLOW_EFFECT_CONTROL_GO_ROLE },
  authorityClaim: { const: WORKFLOW_EFFECT_CONTROL_AUTHORITY_CLAIM },
  nonAuthorizingObservation: { const: true },
  goEffectDecisionAuthority: { const: false },
  goEffectExecutionAuthority: { const: false },
  workspaceId: id,
  runId: id,
  occurrenceId: { type: 'string', pattern: '^WFOCCURRENCE-[0-9a-f]{64}$' },
  approvalId: id,
  approvalHash: hash,
  effectId: id,
  effectHash: hash,
  correlationId: id,
  requiredCapabilityHash: hash,
  observedAt: time,
};
const terminalObservation = {
  ...observationBase,
  approvalStatus: { enum: ['approved', 'rejected'] },
  approvalDecisionHash: hash,
  humanDecision: sanitizedHuman,
  bindingHash: hash,
  decision: { enum: ['approved', 'rejected'] },
  auditEventId: id,
};
const observationSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-effect-control/v1/schemas/workflow-effect-control-observation.v1.schema.json',
  oneOf: [
    strict({
      ...observationBase,
      operation: { const: 'approval_created' },
      approvalRevision: { const: 0 },
      approvalStatus: { const: 'pending' },
      approvalDecisionHash: { type: 'null' },
      humanDecision: { type: 'null' },
      bindingHash: { type: 'null' },
      decision: { type: 'null' },
      auditEventId: { type: 'null' },
      auditStatus: { type: 'null' },
    }),
    strict({
      ...terminalObservation,
      operation: { const: 'approval_decided' },
      approvalRevision: { const: 1 },
      auditStatus: { const: 'pending' },
    }),
    strict({
      ...terminalObservation,
      operation: { const: 'audit_recorded' },
      approvalRevision: { const: 2 },
      auditStatus: { const: 'recorded' },
    }),
  ],
};
const envelopeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/workflow-effect-control/v1/schemas/workflow-effect-control-envelope.v1.schema.json',
  oneOf: WORKFLOW_EFFECT_CONTROL_OBSERVER_OPERATIONS.map((operation, index) =>
    strict({
      schema: { const: WORKFLOW_EFFECT_CONTROL_ENVELOPE_SCHEMA },
      contractVersion: { const: 'v1' },
      authority: { const: 'typescript' },
      goRole: { const: 'observer_only' },
      authorityClaim: { const: 'NO_AUTHORITY' },
      nonAuthorizingObservation: { const: true },
      sourceSequence: { const: index + 1 },
      operation: { const: operation },
      observation: {
        allOf: [
          { $ref: 'workflow-effect-control-observation.v1.schema.json' },
          {
            type: 'object',
            properties: { operation: { const: operation }, approvalRevision: { const: index } },
            required: ['operation', 'approvalRevision'],
          },
        ],
      },
      observationHash: hash,
    }),
  ),
};

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const pretty = async (value: unknown) =>
  Buffer.from(await format(`${JSON.stringify(value)}\n`, { parser: 'json', printWidth: 100 }));
const exact = (value: unknown) => {
  const canonicalBytes = `${canonicalWorkflowEffectControlJson(value)}\n`;
  return {
    value,
    canonicalBytes,
    byteLength: Buffer.byteLength(canonicalBytes),
    sha256: sha(canonicalBytes),
  };
};

function buildVectors() {
  const workspaceId = 'workspace-d1';
  const runId = 'run-d1-001';
  const occurrenceIndex = 1;
  const occurrenceId = deriveWorkflowEffectOccurrenceId(runId, occurrenceIndex);
  const correlationId = 'correlation-d1';
  const effectHash = '1'.repeat(64);
  const effectId = `workflow-effect:sha256:${effectHash}`;
  const effectKind = 'collaboration.event';
  const message: WorkflowRunnerEffectIntentMessage = {
    protocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
    kind: 'effect_intent',
    workspaceId,
    jobId: 'job-d1',
    workflowRunId: runId,
    attemptId: 'attempt-d1',
    leaseId: 'lease-d1',
    fencingToken: 1,
    sequence: occurrenceIndex,
    eventId: 'event-effect-intent-d1',
    correlationId,
    sentAt: '2026-08-12T00:00:00.000Z',
    payload: {
      effectId,
      effectKind,
      effectHash,
      capabilityHash: hashWorkflowRunnerDomain('effect-capability', effectKind),
      requiresHumanDecision: true,
    },
  };
  const prepared = prepareWorkflowRunnerMessage(message);
  const receipt = createWorkflowRunnerEventReceipt(message, {
    sequence: 2,
    sentAt: '2026-08-12T00:00:01.000Z',
    status: 'accepted',
    controlBuildHash: '2'.repeat(64),
    errorCode: null,
  });
  const duplicateReceipt = createWorkflowRunnerEventReceipt(message, {
    sequence: 3,
    sentAt: '2026-08-12T00:00:02.000Z',
    status: 'duplicate',
    controlBuildHash: '2'.repeat(64),
    errorCode: null,
  });
  const common = {
    schema: WORKFLOW_EFFECT_CONTROL_ARTIFACT_SCHEMA,
    contractVersion: WORKFLOW_EFFECT_CONTROL_CONTRACT_VERSION,
    authority: 'typescript',
    writer: '@openslack/workflows',
    goRole: 'validator_only',
    goAuthorityClaim: 'NO_AUTHORITY',
    goAuthorityEligible: false,
    workspaceId,
    runId,
    occurrenceIndex,
    occurrenceId,
  } as const;
  const intent = validateWorkflowEffectControlArtifact(
    {
      ...common,
      kind: 'effect_intent',
      runnerV1Message: message,
      runnerV1Prepared: prepared,
      runnerV1Receipt: receipt,
    },
    VALIDATION_CONTEXT,
  ) as WorkflowEffectIntentArtifact;
  const duplicateIntent = validateWorkflowEffectControlArtifact(
    {
      ...common,
      kind: 'effect_intent',
      runnerV1Message: message,
      runnerV1Prepared: prepared,
      runnerV1Receipt: duplicateReceipt,
    },
    VALIDATION_CONTEXT,
  ) as WorkflowEffectIntentArtifact;
  const intentBindingHash = hashWorkflowEffectIntentBinding(intent, VALIDATION_CONTEXT);
  if (hashWorkflowEffectIntentBinding(duplicateIntent, VALIDATION_CONTEXT) !== intentBindingHash)
    throw new Error('Replay changed stable intent binding.');
  const approvalId = deriveWorkflowEffectApprovalId(occurrenceId, intentBindingHash);
  const pendingApproval = createPendingWorkflowEffectApproval({
    runId,
    approvalId,
    correlationId,
    workflowId: 'workflow-d1',
    workflowVersion: '1.0.0',
    workflowHash: '3'.repeat(64),
    inputHash: '4'.repeat(64),
    effectId,
    effectHash,
    requiredCapability: 'workflow.effect.decide',
    createdAt: '2026-08-12T00:00:03.000Z',
    expiresAt: '2026-08-12T01:00:03.000Z',
  });
  const approvalBase = {
    ...common,
    approvalGeneration: 0,
    intentArtifact: intent,
    intentBindingHash,
    intentEffectId: effectId,
    intentEffectHash: effectHash,
    correlationId,
  };
  const pending = validateWorkflowEffectControlArtifact(
    {
      ...approvalBase,
      kind: 'effect_approval_pending',
      approval: pendingApproval,
      approvalRecordHash: hashWorkflowEffectApprovalRecord(pendingApproval),
      approvalDecisionHash: null,
    },
    VALIDATION_CONTEXT,
  );
  const terminal = (status: 'approved' | 'rejected'): WorkflowEffectApprovalRecord =>
    validateWorkflowEffectApproval({
      ...pendingApproval,
      revision: 1,
      status,
      decision: {
        principalId: 'human-wsman',
        workspaceId,
        capability: 'workflow.effect.decide',
        reasonHash: '5'.repeat(64),
        attestationNonce: '11111111-1111-4111-8111-111111111111',
        decidedAt: '2026-08-12T00:00:05.000Z',
      },
      auditProjection: {
        status: 'pending',
        eventId: workflowEffectApprovalAuditEventId(runId, approvalId),
      },
    });
  const decisionArtifact = (status: 'approved' | 'rejected') => {
    const approval = terminal(status);
    const humanDecision = projectWorkflowEffectHumanDecision({
      approval,
      issuedAt: '2026-08-12T00:00:04.000Z',
      expiresAt: '2026-08-12T00:00:30.000Z',
    });
    return validateWorkflowEffectControlArtifact(
      {
        ...approvalBase,
        kind: 'effect_decision_committed',
        approval,
        approvalRecordHash: hashWorkflowEffectApprovalRecord(approval),
        approvalDecisionHash: hashWorkflowEffectApprovalDecision(approval, humanDecision),
        humanDecision,
      },
      VALIDATION_CONTEXT,
    );
  };
  const approved = decisionArtifact('approved');
  const rejected = decisionArtifact('rejected');
  const auditArtifact = (decisionArtifactValue: WorkflowEffectControlArtifact) => {
    if (decisionArtifactValue.kind !== 'effect_decision_committed') throw new Error('bad vector');
    const approval = validateWorkflowEffectApproval({
      ...decisionArtifactValue.approval,
      revision: 2,
      auditProjection: {
        status: 'recorded',
        eventId: decisionArtifactValue.approval.auditProjection!.eventId,
        recordedAt: '2026-08-12T00:00:07.000Z',
      },
    });
    return validateWorkflowEffectControlArtifact(
      {
        ...approvalBase,
        kind: 'effect_audit_recorded',
        approval,
        approvalRecordHash: hashWorkflowEffectApprovalRecord(approval),
        approvalDecisionHash: decisionArtifactValue.approvalDecisionHash,
        humanDecision: decisionArtifactValue.humanDecision,
      },
      VALIDATION_CONTEXT,
    );
  };
  const auditApproved = auditArtifact(approved);
  const auditRejected = auditArtifact(rejected);
  if (approved.kind !== 'effect_decision_committed') throw new Error('bad approved vector');
  const executionId = `WFEXECUTION-${hashWorkflowEffectControlDomain('execution-id', {
    approvalDecisionHash: approved.approvalDecisionHash,
    occurrenceId,
  })}`;
  const claimBase = {
    ...approvalBase,
    kind: 'effect_execution_claim',
    approval: approved.approval,
    approvalRecordHash: approved.approvalRecordHash,
    approvalDecisionHash: approved.approvalDecisionHash,
    humanDecision: approved.humanDecision,
    executionId,
    consumedApprovalRecordHash: approved.approvalRecordHash,
    consumedApprovalRevision: 1,
    claimedAt: '2026-08-12T00:00:06.000Z',
  } as const;
  const claimed = validateWorkflowEffectControlArtifact(
    {
      ...claimBase,
      claimRevision: 0,
      claimStatus: 'claimed',
      outcomeHash: null,
      committedAt: null,
      reconciliationToken: null,
    },
    VALIDATION_CONTEXT,
  );
  const executed = validateWorkflowEffectControlArtifact(
    {
      ...claimBase,
      claimRevision: 1,
      claimStatus: 'executed',
      outcomeHash: '6'.repeat(64),
      committedAt: '2026-08-12T00:00:08.000Z',
      reconciliationToken: null,
    },
    VALIDATION_CONTEXT,
  );
  const reconciliation = validateWorkflowEffectControlArtifact(
    {
      ...claimBase,
      claimRevision: 1,
      claimStatus: 'reconciliation_required',
      outcomeHash: null,
      committedAt: '2026-08-12T00:00:08.000Z',
      reconciliationToken: 'reconciliation-d1',
    },
    VALIDATION_CONTEXT,
  );
  const legacy = (status: 'pending' | 'approved' | 'rejected' | 'expired', revision: number) =>
    validateWorkflowEffectControlArtifact(
      {
        ...common,
        kind: 'legacy_run_gate_observation',
        plane: 'legacy_run_gate',
        semantics: 'run_gate_only',
        status,
        revision,
        legacyProjectionHash: hashWorkflowEffectControlDomain('legacy-projection', {
          effectDecisionAuthority: false,
          plane: 'legacy_run_gate',
          revision,
          runId,
          semantics: 'run_gate_only',
          status,
          workspaceId,
        }),
        observedAt: '2026-08-12T00:00:09.000Z',
        effectDecisionAuthority: false,
        effectExecutionAuthority: false,
      },
      VALIDATION_CONTEXT,
    );
  const lifecycle = [pending, approved, auditApproved] as const;
  const envelopes = lifecycle.map((artifact, index) => {
    if (
      artifact.kind !== 'effect_approval_pending' &&
      artifact.kind !== 'effect_decision_committed' &&
      artifact.kind !== 'effect_audit_recorded'
    )
      throw new Error('bad lifecycle vector');
    const observation = projectWorkflowEffectControlObservation(artifact, VALIDATION_CONTEXT);
    return {
      schema: WORKFLOW_EFFECT_CONTROL_ENVELOPE_SCHEMA,
      contractVersion: 'v1',
      authority: 'typescript',
      goRole: 'observer_only',
      authorityClaim: 'NO_AUTHORITY',
      nonAuthorizingObservation: true,
      sourceSequence: index + 1,
      operation: observation.operation,
      observation,
      observationHash: hashWorkflowEffectControlObservation(observation),
    } as WorkflowEffectControlEnvelope;
  });
  if (pending.kind !== 'effect_approval_pending' || rejected.kind !== 'effect_decision_committed')
    throw new Error('bad approval chain vectors');
  return {
    artifacts: {
      intentAccepted: exact(intent),
      intentDuplicate: exact(duplicateIntent),
      pending: exact(pending),
      decisionApproved: exact(approved),
      decisionRejected: exact(rejected),
      auditApproved: exact(auditApproved),
      auditRejected: exact(auditRejected),
      claimClaimed: exact(claimed),
      claimExecuted: exact(executed),
      claimReconciliation: exact(reconciliation),
      legacyPending: exact(legacy('pending', 0)),
      legacyApproved: exact(legacy('approved', 1)),
      legacyExpired: exact(legacy('expired', 2)),
    },
    observer: {
      approvalCreated: exact(envelopes[0]),
      approvalDecided: exact(envelopes[1]),
      auditRecorded: exact(envelopes[2]),
    },
    transport: {
      preparedApprovalDecided: prepareWorkflowEffectControlEnvelope(envelopes[1]),
    },
    chains: {
      approved: [
        intentBindingHash,
        pending.approvalRecordHash,
        approved.approvalDecisionHash,
        executionId,
      ],
      rejectedNoClaim: [
        intentBindingHash,
        pending.approvalRecordHash,
        rejected.approvalDecisionHash,
      ],
      legacyApprovedNoAuthority: legacy('approved', 1),
    },
  };
}

async function outputs() {
  const map = new Map<string, Buffer>();
  const schemas = [artifactSchema, approvalSchema, humanSchema, observationSchema, envelopeSchema];
  for (const [index, schema] of schemas.entries()) map.set(paths[index]!, await pretty(schema));
  map.set(
    'golden-vectors.json',
    await pretty({
      schema: 'openslack.workflow_effect_control_golden_vectors.v1',
      authority: 'typescript',
      goRole: 'validator_only',
      vectors: buildVectors(),
    }),
  );
  const artifacts = Object.fromEntries(
    [...map].map(([path, bytes]) => [path, { path, byteLength: bytes.length, sha256: sha(bytes) }]),
  );
  map.set(
    'manifest.json',
    await pretty({
      schema: 'openslack.workflow_effect_control_contract_manifest.v1',
      contractVersion: 'v1',
      authorityBoundary: {
        writer: '@openslack/workflows',
        typescriptRemainsSoleWriter: true,
        goRole: 'observer_only',
        goAuthorityClaim: 'NO_AUTHORITY',
        goAuthorityEligible: false,
        legacyRunGateCanAuthorizeEffect: false,
        observerCanAuthorizeEffect: false,
        runnerV1Unchanged: true,
      },
      semanticArtifacts: WORKFLOW_EFFECT_CONTROL_ARTIFACT_KINDS,
      observerOperations: WORKFLOW_EFFECT_CONTROL_OBSERVER_OPERATIONS,
      limits: WORKFLOW_EFFECT_CONTROL_LIMITS,
      transport: {
        method: 'POST',
        path: WORKFLOW_EFFECT_CONTROL_ROUTE,
        idempotencyKey: `${WORKFLOW_EFFECT_CONTROL_IDEMPOTENCY_PREFIX}{bodyHash}`,
      },
      sourceLocks: {
        runnerV1ManifestSha256: WORKFLOW_EFFECT_CONTROL_RUNNER_V1_MANIFEST_SHA256,
        runnerV1GoldenSha256: WORKFLOW_EFFECT_CONTROL_RUNNER_V1_GOLDEN_SHA256,
        authorityV2ManifestSha256: WORKFLOW_EFFECT_CONTROL_AUTHORITY_V2_MANIFEST_SHA256,
        authorityV2GoldenSha256: WORKFLOW_EFFECT_CONTROL_AUTHORITY_V2_GOLDEN_SHA256,
        checkpointManifestSha256: WORKFLOW_EFFECT_CONTROL_CHECKPOINT_MANIFEST_SHA256,
        checkpointGoldenSha256: WORKFLOW_EFFECT_CONTROL_CHECKPOINT_GOLDEN_SHA256,
      },
      observerRawForbidden: [
        'nonce',
        'reason',
        'detail',
        'prompt',
        'input',
        'providerRequest',
        'providerResponse',
        'credential',
        'token',
        'endpoint',
        'path',
        'transcript',
        'stack',
      ],
      artifacts,
      bundleFiles: paths,
    }),
  );
  return map;
}

function inside(candidate: string) {
  const path = relative(contractRoot, candidate);
  if (path === '..' || path.startsWith(`..${sep}`)) throw new Error('Output escape');
}
async function list(directory = contractRoot): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = resolve(directory, entry.name);
    inside(path);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Symlink forbidden');
    if (stat.isDirectory()) output.push(...(await list(path)));
    else output.push(relative(contractRoot, path).split(sep).join('/'));
  }
  return output.sort();
}

const built = await outputs();
if (process.argv[2] === '--check') {
  const sourceLocks = [
    [
      'packages/workflows/contracts/workflow-runner/v1/manifest.json',
      WORKFLOW_EFFECT_CONTROL_RUNNER_V1_MANIFEST_SHA256,
    ],
    [
      'packages/workflows/contracts/workflow-runner/v1/golden-vectors.json',
      WORKFLOW_EFFECT_CONTROL_RUNNER_V1_GOLDEN_SHA256,
    ],
    [
      'packages/workflows/contracts/workflow-control-authority/v2/manifest.json',
      WORKFLOW_EFFECT_CONTROL_AUTHORITY_V2_MANIFEST_SHA256,
    ],
    [
      'packages/workflows/contracts/workflow-control-authority/v2/golden-vectors.json',
      WORKFLOW_EFFECT_CONTROL_AUTHORITY_V2_GOLDEN_SHA256,
    ],
    [
      'packages/workflows/contracts/workflow-checkpoint-shadow/v1/manifest.json',
      WORKFLOW_EFFECT_CONTROL_CHECKPOINT_MANIFEST_SHA256,
    ],
    [
      'packages/workflows/contracts/workflow-checkpoint-shadow/v1/golden-vectors.json',
      WORKFLOW_EFFECT_CONTROL_CHECKPOINT_GOLDEN_SHA256,
    ],
  ] as const;
  for (const [path, expectedSha] of sourceLocks) {
    const actualSha = sha(await readFile(resolve(root, path)));
    if (actualSha !== expectedSha)
      throw new Error(`Workflow effect control source lock drift: ${path}`);
  }
  const actual = await list();
  const expected = [...built.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Workflow effect control inventory drift');
  for (const [path, bytes] of built)
    if (!(await readFile(resolve(contractRoot, path))).equals(bytes))
      throw new Error(`Workflow effect control exact-byte drift: ${path}`);
  console.log(`Workflow effect control bundle verified (${built.size} exact-byte files).`);
} else if (process.argv.length === 2) {
  for (const [path, bytes] of built) {
    const absolute = resolve(contractRoot, path);
    inside(absolute);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
  console.log(`Workflow effect control bundle generated (${built.size} exact-byte files).`);
} else {
  throw new Error('Usage: bun scripts/workflow-effect-control-contracts/index.ts [--check]');
}
