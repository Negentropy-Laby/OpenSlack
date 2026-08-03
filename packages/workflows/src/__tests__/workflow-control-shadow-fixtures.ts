import { createHash } from 'node:crypto';
import {
  WORKFLOW_CONTROL_AUTHORITY,
  WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA,
  WORKFLOW_CONTROL_OBSERVATION_SCHEMA,
  projectWorkflowControlReadModel,
  type WorkflowControlObservation,
} from '../workflow-control-contract.js';
import {
  WORKFLOW_CONTROL_SHADOW_OBSERVATION_SCHEMA,
  WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA,
  prepareWorkflowControlShadowRequest,
  validateWorkflowControlShadowEnvelope,
} from '../workflow-control-shadow.js';

export function shadowObservation(overrides: Partial<WorkflowControlObservation> = {}) {
  return {
    schema: WORKFLOW_CONTROL_OBSERVATION_SCHEMA,
    authority: WORKFLOW_CONTROL_AUTHORITY,
    runId: 'run-shadow-test',
    workflowName: 'shadow-test',
    mode: 'execute',
    status: 'running',
    startedAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:01.000Z',
    manifestHash: 'a'.repeat(64),
    currentPhase: null,
    phases: [],
    approvals: {
      legacyRunGate: {
        plane: 'legacy-run-gate',
        semantics: 'run-gate-only',
        counts: { pending: 0, approved: 0, rejected: 0 },
      },
      effectV2: {
        plane: 'workflow-effect-v2',
        semantics: 'effect-decision-only',
        schema: WORKFLOW_CONTROL_EFFECT_APPROVAL_SCHEMA,
        counts: { pending: 0, approved: 0, rejected: 0 },
      },
    },
    budget: {
      configured: false,
      policyHash: null,
      tokenBudget: null,
      tokensUsed: 0,
      costUsd: null,
      agentCalls: 0,
      warnings: [],
    },
    ...overrides,
  } satisfies WorkflowControlObservation;
}

export function shadowEnvelope(sequence = 1, observation = shadowObservation()) {
  return validateWorkflowControlShadowEnvelope({
    authority: 'typescript',
    observation,
    projection: projectWorkflowControlReadModel(observation),
    schema: WORKFLOW_CONTROL_SHADOW_OBSERVATION_SCHEMA,
    source: {
      runId: observation.runId,
      sourceSequence: sequence,
      workspaceId: 'workspace.test',
    },
  });
}

export function acceptedReceipt(
  sequence = 1,
  observation = shadowObservation(),
  status: 'accepted' | 'duplicate' = 'accepted',
) {
  const envelope = shadowEnvelope(sequence, observation);
  const request = prepareWorkflowControlShadowRequest(envelope);
  return {
    schema: WORKFLOW_CONTROL_SHADOW_RECEIPT_SCHEMA,
    operation: 'observation_ingest',
    status,
    parity: 'matched',
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: request.requestFingerprint,
    workspaceId: envelope.source.workspaceId,
    runId: envelope.source.runId,
    sourceSequence: sequence,
    observationDigest: createHash('sha256').update(request.body).digest('hex'),
    observationHash: envelope.projection.observationHash,
    committedAt: '2026-08-03T00:00:02.000Z',
  } as const;
}
