import { createHash } from 'node:crypto';
import {
  canonicalWorkflowControlAuthorityJson,
  type WorkflowControlAuthorityMessage,
} from '../workflow-control-authority-contract.js';
import {
  WORKFLOW_CHECKPOINT_SHADOW_SCHEMA,
  WORKFLOW_CHECKPOINT_SHADOW_ENVELOPE_SCHEMA,
  workflowCheckpointHash,
  type WorkflowCheckpointControlState,
  type WorkflowCheckpointShadowEnvelope,
} from '../workflow-checkpoint-shadow-contract.js';
import type {
  WorkflowRunnerCheckpointAuthorityEvidence,
  WorkflowRunnerResumeAuthorityEvidence,
} from '../workflow-runner-authority-binding-contract.js';
function checkpointEnvelope(
  state: WorkflowCheckpointControlState,
  operation: 'checkpoint_commit' | 'resume_advance',
  checkpointPhaseIndex?: number,
): WorkflowCheckpointShadowEnvelope {
  const active = state.activeBinding;
  const checkpoint =
    operation === 'checkpoint_commit' && checkpointPhaseIndex !== undefined
      ? (state.checkpoints[checkpointPhaseIndex] ?? null)
      : null;
  const priorCheckpoint =
    operation === 'resume_advance' ? (state.checkpoints.at(-1) ?? null) : null;
  const observation = {
    schema: WORKFLOW_CHECKPOINT_SHADOW_SCHEMA,
    authority: 'typescript' as const,
    goRole: 'observer_only' as const,
    runId: state.runId,
    revision: state.revision,
    resumeGeneration: state.resumeGeneration,
    checkpoint,
    priorCheckpoint,
    nextPhaseId: operation === 'resume_advance' ? `phase-${state.checkpoints.length}` : null,
    nextPhaseIndex: operation === 'resume_advance' ? state.checkpoints.length : null,
    workflowSourceHash: active.workflowSourceHash,
    manifestHash: active.manifestHash,
    inputHash: active.inputHash,
    runner: {
      workspaceId: active.workspaceId,
      jobId: active.jobId,
      attemptId: active.attemptId,
      leaseId: active.leaseId,
      fencingToken: active.fencingToken,
      correlationId: active.correlationId,
      runnerBuildHash: active.runnerBuildHash,
    },
  };
  return Object.freeze({
    schema: WORKFLOW_CHECKPOINT_SHADOW_ENVELOPE_SCHEMA,
    goRole: 'observer_only' as const,
    sourceSequence: state.revision - 1,
    operation,
    observation,
    observationHash: workflowCheckpointHash(observation),
  });
}

export function checkpointEvidence(
  state: WorkflowCheckpointControlState,
  authorityBuildHash: string,
  phaseIndex: number,
): WorkflowRunnerCheckpointAuthorityEvidence {
  const envelope = checkpointEnvelope(state, 'checkpoint_commit', phaseIndex);
  const envelopeHash = createHash('sha256')
    .update(canonicalWorkflowControlAuthorityJson(envelope), 'utf8')
    .digest('hex');
  return Object.freeze({
    schema: 'openslack.workflow_runner_checkpoint_authority_evidence.v1',
    sourceAuthority: {
      plane: 'checkpoint_control' as const,
      evidenceState: 'committed' as const,
      expectedRevision: state.revision - 1,
      acceptedRevision: state.revision,
      expectedResumeGeneration: state.resumeGeneration,
      acceptedResumeGeneration: state.resumeGeneration,
      requestHash: envelopeHash,
      receiptSchema: 'openslack.workflow_runner_checkpoint_authority_receipt.v1',
      receiptHash: createHash('sha256')
        .update(
          canonicalWorkflowControlAuthorityJson({
            schema: 'openslack.workflow_runner_checkpoint_authority_receipt.v1',
            envelopeHash,
            acceptedRevision: state.revision,
          }),
          'utf8',
        )
        .digest('hex'),
      recordHash: envelope.observationHash,
      authorityBuildHash,
    },
    envelope,
    envelopeHash,
  });
}

export function resumeEvidence(
  state: WorkflowCheckpointControlState,
  target: WorkflowControlAuthorityMessage,
): WorkflowRunnerResumeAuthorityEvidence {
  const envelope = checkpointEnvelope(state, 'resume_advance');
  const envelopeHash = createHash('sha256')
    .update(canonicalWorkflowControlAuthorityJson(envelope), 'utf8')
    .digest('hex');
  const priorCheckpoint = envelope.observation.priorCheckpoint;
  if (
    target.attemptId === null ||
    target.authorityBuildHash === null ||
    typeof target.payload.leaseExpiresAt !== 'string'
  ) {
    throw new Error('Resume source evidence lacks its lease identity.');
  }
  return Object.freeze({
    schema: 'openslack.workflow_runner_resume_authority_evidence.v1',
    sourceAuthority: {
      plane: 'resume_control' as const,
      evidenceState: 'committed' as const,
      expectedRevision: state.revision - 1,
      acceptedRevision: state.revision,
      expectedResumeGeneration: state.resumeGeneration - 1,
      acceptedResumeGeneration: state.resumeGeneration,
      requestHash: envelopeHash,
      receiptSchema: 'openslack.workflow_runner_resume_authority_receipt.v1',
      receiptHash: createHash('sha256')
        .update(
          canonicalWorkflowControlAuthorityJson({
            schema: 'openslack.workflow_runner_resume_authority_receipt.v1',
            envelopeHash,
            acceptedRevision: state.revision,
            acceptedResumeGeneration: state.resumeGeneration,
          }),
          'utf8',
        )
        .digest('hex'),
      recordHash: envelope.observationHash,
      authorityBuildHash: target.authorityBuildHash,
    },
    envelope,
    envelopeHash,
    priorCheckpointId: priorCheckpoint?.checkpointId ?? null,
    priorCheckpointHash: priorCheckpoint
      ? createHash('sha256')
          .update(canonicalWorkflowControlAuthorityJson(priorCheckpoint), 'utf8')
          .digest('hex')
      : null,
    nextPhaseId: envelope.observation.nextPhaseId!,
    nextPhaseIndex: envelope.observation.nextPhaseIndex!,
    logicalResumeAttemptId: `logical.resume.${createHash('sha256')
      .update(`${target.attemptId}\0${state.resumeGeneration}`, 'utf8')
      .digest('hex')}`,
    expiresAt: target.payload.leaseExpiresAt,
  });
}
