import type { WorkflowControlAuthorityRunRead } from '../workflow-control-authority-client.js';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { WORKFLOW_RUNNER_CONTRACT_LIMITS } from '../workflow-runner-contract.js';
import {
  canonicalWorkflowControlAuthorityJson as canonical,
  prepareWorkflowControlAuthorityMessage,
  type WorkflowControlAuthorityPreparedMessage,
} from '../workflow-control-authority-contract.js';
import {
  deriveWorkflowRunnerAuthorityBindingId,
  prepareWorkflowRunnerAuthorityBindingStage,
  prepareWorkflowRunnerAuthorityBindingResolution,
  hashWorkflowRunnerAuthorityBindingStage,
  hashWorkflowRunnerAuthorityBindingReceipt,
  hashWorkflowRunnerAuthorityBindingEvidence,
  hashWorkflowRunnerAuthorityBindingResolution,
  type WorkflowRunnerAuthorityBindingStage,
  type WorkflowRunnerAuthorityBindingResolution,
  type WorkflowRunnerAuthorityStageReceipt,
  type WorkflowRunnerAuthorityResolutionReceipt,
} from '../workflow-runner-authority-binding-contract.js';
import {
  checkpointEvidence,
  resumeEvidence,
} from '../internal/workflow-runner-checkpoint-evidence.js';
import {
  workflowCheckpointHash,
  validateWorkflowCheckpointControlState,
  type WorkflowCheckpointControlState,
} from '../workflow-checkpoint-shadow-contract.js';
import type { WorkflowRunRecoveryEvidence } from '../workflow-run-recovery-evidence.js';

type Exchange = {
  stage: { value: WorkflowRunnerAuthorityBindingStage };
  resolution: { value: WorkflowRunnerAuthorityBindingResolution };
  stageReceipt: { value: WorkflowRunnerAuthorityStageReceipt };
  resolutionReceipt: { value: WorkflowRunnerAuthorityResolutionReceipt };
};
const vectors = JSON.parse(
  readFileSync(
    new URL(
      '../../contracts/workflow-runner-authority-binding/v1/golden-vectors.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const templates: Record<'checkpoint_commit' | 'resume_advance', Exchange> = {
  checkpoint_commit: vectors.positive.semanticVariants.goRouteCheckpoint,
  resume_advance: vectors.positive.operations.resume_advance,
};

export function checkpointState(count = 1): WorkflowCheckpointControlState {
  const activeBinding = {
    workspaceId: 'workspace.test',
    workflowRunId: 'run.recovery',
    jobId: 'job.prior',
    attemptId: 'attempt.prior',
    leaseId: 'lease.prior',
    fencingToken: 1,
    correlationId: 'correlation.recovery',
    runnerBuildHash: '1'.repeat(64),
    workflowSourceHash: 'a'.repeat(64),
    manifestHash: 'a'.repeat(64),
    inputHash: 'a'.repeat(64),
  };
  return validateWorkflowCheckpointControlState(
    {
      schema: 'openslack.workflow_checkpoint_control.v1',
      runId: activeBinding.workflowRunId,
      revision: count + 1,
      resumeGeneration: 0,
      sourceSequence: 0,
      shadowEnabled: false,
      shadowOverflowed: false,
      activeBinding,
      seenBindingHashes: [workflowCheckpointHash(activeBinding)],
      pendingObservations: [],
      updatedAt: '2026-09-05T00:00:00.000Z',
      checkpoints: Array.from({ length: count }, (_, index) => {
        const hash = createHash('sha256').update(`phase-${index}`).digest('hex');
        return {
          checkpointId: `checkpoint-${hash}`,
          phaseId: `phase-${index}`,
          phaseIndex: index,
          commitPoint: 'after_phase_work',
          artifactRef: `checkpoint-control/artifacts/${hash}.json`,
          artifactHash: hash,
          resultHash: '3'.repeat(64),
          cacheKeyHash: '4'.repeat(64),
          committedRevision: index + 2,
          resumeGeneration: 0,
          committedAt: '2026-09-05T00:00:00.000Z',
        };
      }),
    },
    activeBinding.workflowRunId,
  );
}

export function recoveryView(
  bindings: WorkflowRunRecoveryEvidence['bindings'],
  runId = 'run.recovery',
): WorkflowRunRecoveryEvidence {
  return {
    schema: 'openslack.workflow_runner_recovery_evidence.v1',
    workspaceId: 'workspace.test',
    runId,
    route: {
      backend: 'go',
      authority: 'workflow-control',
      routingEpoch: 1,
      authorityBuildHash: '1'.repeat(64),
    },
    complete: true,
    nextCursor: null,
    snapshot: 'b'.repeat(64),
    bindings,
    unfinished: [],
    activeAttempts: [],
  };
}

export function resumeIntentFixture(checkpoints = 1) {
  const prior = checkpointState(checkpoints);
  const activeBinding = {
    ...prior.activeBinding,
    jobId: 'job.resume',
    attemptId: 'attempt.resume',
    leaseId: 'lease.resume',
  };
  const next = {
    ...prior,
    revision: prior.revision + 1,
    resumeGeneration: 1,
    activeBinding,
    seenBindingHashes: [...prior.seenBindingHashes, workflowCheckpointHash(activeBinding)],
  };
  const frame = recoveryFrame(next, 'resume_advance');
  const stage = JSON.parse(frame.stage) as WorkflowRunnerAuthorityBindingStage;
  const target = JSON.parse(stage.target.body);
  const head = recoveryHead(prior);
  const stageHash = hashWorkflowRunnerAuthorityBindingStage(stage);
  return {
    stage,
    target,
    frame,
    intent: {
      schema: 'openslack.workflow_runner_resume_source_intent.v2' as const,
      stageHash,
      correlationId: `resume.${stageHash}`,
      stageReceipt: JSON.parse(frame.stageReceipt),
      priorRevision: prior.revision,
      priorBindingHash: workflowCheckpointHash(prior.activeBinding),
      phaseCount: checkpoints,
      expected: {
        revision: head.revision,
        state: head.state,
        currentPhaseId: head.currentPhaseId,
        currentPhaseIndex: head.currentPhaseIndex,
        resumeGeneration: 0,
      },
      record: {
        ...head.record,
        revision: head.revision + 1,
        state: 'resuming' as const,
        resumeGeneration: 1,
        currentPhaseId: `phase-${checkpoints}`,
        currentPhaseIndex: checkpoints,
      },
      prior,
      next,
      evidence: JSON.parse(frame.resolution!).evidence,
    },
  };
}

/** Construct independently validated durable frames from an actual committed cache. */
export function recoveryFrame(
  state: WorkflowCheckpointControlState,
  operation: 'checkpoint_commit' | 'resume_advance',
  resumeTarget?: WorkflowControlAuthorityPreparedMessage,
): WorkflowRunRecoveryEvidence['bindings'][number] {
  const base = templates[operation];
  const original = JSON.parse(base.stage.value.target.body);
  const active = state.activeBinding;
  const checkpoint = state.checkpoints.at(-1);
  const payload =
    operation === 'checkpoint_commit'
      ? {
          ...Object.fromEntries(
            [
              'checkpointId',
              'phaseId',
              'phaseIndex',
              'commitPoint',
              'artifactRef',
              'artifactHash',
              'resultHash',
              'cacheKeyHash',
            ].map((key) => [key, checkpoint![key as keyof typeof checkpoint]]),
          ),
          workflowSourceHash: active.workflowSourceHash,
          manifestHash: active.manifestHash,
          inputHash: active.inputHash,
        }
      : {
          acceptedAt: state.updatedAt,
          leaseExpiresAt: new Date(
            Date.parse(state.updatedAt) + WORKFLOW_RUNNER_CONTRACT_LIMITS.maxLeaseDurationMs,
          ).toISOString(),
        };
  const prepared =
    resumeTarget ??
    prepareWorkflowControlAuthorityMessage({
      ...original,
      workspaceId: active.workspaceId,
      workflowRunId: state.runId,
      jobId: active.jobId,
      attemptId: active.attemptId,
      leaseId: active.leaseId,
      fencingToken: active.fencingToken,
      correlationId: active.correlationId,
      resumeGeneration: state.resumeGeneration - (operation === 'resume_advance' ? 1 : 0),
      authorityBackend: 'go',
      authority: 'workflow-control',
      eventId: `recovery.${operation}.${state.revision}`,
      sentAt: state.updatedAt,
      payload,
    });
  const message = JSON.parse(prepared.body);
  const candidate = {
    ...base.stage.value,
    workspaceId: message.workspaceId,
    runId: message.workflowRunId,
    jobId: message.jobId,
    runnerAttemptId: message.attemptId,
    leaseId: message.leaseId,
    fencingToken: message.fencingToken,
    correlationId: message.correlationId,
    sentAt: message.sentAt,
    route: {
      backend: 'go' as const,
      authority: 'workflow-control' as const,
      routingEpoch: message.routingEpoch,
      authorityBuildHash: message.authorityBuildHash,
    },
    runnerAuthority: {
      expectedGlobalRunRevision: message.runRevision,
      acceptedGlobalRunRevision: message.runRevision + 1,
      expectedResumeGeneration: message.resumeGeneration,
      acceptedResumeGeneration: state.resumeGeneration,
    },
    target: {
      schema: prepared.schema,
      eventId: message.eventId,
      kind: message.kind,
      sequence: message.sequence,
      body: prepared.body,
      messageDigest: prepared.messageDigest,
      idempotencyKey: prepared.idempotencyKey,
      requestFingerprint: prepared.requestFingerprint,
    },
  };
  const stage = prepareWorkflowRunnerAuthorityBindingStage({
    ...candidate,
    bindingId: deriveWorkflowRunnerAuthorityBindingId(candidate),
  }).value;
  const stageReceipt: WorkflowRunnerAuthorityStageReceipt = {
    ...base.stageReceipt.value,
    bindingId: stage.bindingId,
    controlBuildHash: stage.route.authorityBuildHash,
    committedAt: stage.sentAt,
    requestHash: hashWorkflowRunnerAuthorityBindingStage(stage),
    targetEventId: stage.target.eventId,
    targetBodyHash: stage.target.messageDigest,
  };
  const evidence =
    operation === 'checkpoint_commit'
      ? checkpointEvidence(state, stage.route.authorityBuildHash, checkpoint!.phaseIndex)
      : resumeEvidence(state, message);
  const resolution = prepareWorkflowRunnerAuthorityBindingResolution({
    ...base.resolution.value,
    bindingId: stage.bindingId,
    stageHash: hashWorkflowRunnerAuthorityBindingStage(stage),
    stageReceiptHash: hashWorkflowRunnerAuthorityBindingReceipt(stageReceipt),
    targetBodyHash: stage.target.messageDigest,
    evidence,
    evidenceHash: hashWorkflowRunnerAuthorityBindingEvidence(evidence, operation),
    sentAt: new Date(Math.max(Date.parse(state.updatedAt), Date.parse(stage.sentAt))).toISOString(),
  }).value;
  const resolutionReceipt: WorkflowRunnerAuthorityResolutionReceipt = {
    ...base.resolutionReceipt.value,
    bindingId: stage.bindingId,
    controlBuildHash: stage.route.authorityBuildHash,
    committedAt: resolution.sentAt,
    requestHash: hashWorkflowRunnerAuthorityBindingResolution(resolution),
    targetEventId: stage.target.eventId,
    targetBodyHash: stage.target.messageDigest,
    stageHash: resolution.stageHash,
    stageReceiptHash: resolution.stageReceiptHash,
    evidenceHash: resolution.evidenceHash,
  };
  return {
    bindingId: stage.bindingId,
    state: 'completed',
    stage: canonical(stage) + '\n',
    stageReceipt: canonical(stageReceipt) + '\n',
    resolution: canonical(resolution) + '\n',
    resolutionReceipt: canonical(resolutionReceipt) + '\n',
  };
}

export function recoveryHead(
  state = checkpointState(),
  phase: number | null = state.checkpoints.length - 1,
): WorkflowControlAuthorityRunRead {
  const record = {
    schema: 'openslack.workflow_control_authority_run_record.v2' as const,
    workspaceId: state.activeBinding.workspaceId,
    runId: state.runId,
    workflowId: 'workflow.test',
    workflowVersion: '1.0.0',
    workflowSourceHash: state.activeBinding.workflowSourceHash,
    manifestHash: state.activeBinding.manifestHash,
    inputHash: state.activeBinding.inputHash,
    route: recoveryView([]).route,
    state: 'paused' as const,
    revision: 37,
    resumeGeneration: state.resumeGeneration,
    currentPhaseId: phase === null ? null : `phase-${phase}`,
    currentPhaseIndex: phase,
  };
  return {
    ...record,
    schema: 'openslack.workflow_control_authority_read.v2',
    record,
    recordHash: workflowCheckpointHash(record),
    updatedAt: state.updatedAt,
  };
}
