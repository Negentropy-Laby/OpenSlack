import {
  workflowCheckpointHash,
  validateWorkflowCheckpointControlState,
  type WorkflowCheckpointControlState,
} from '../workflow-checkpoint-shadow-contract.js';
import type {
  WorkflowControlAuthorityExpectedHead,
  WorkflowControlAuthorityRunRecord,
} from '../workflow-control-authority-client.js';
import {
  canonicalWorkflowControlAuthorityJson as canonical,
  type WorkflowControlAuthorityMessage,
} from '../workflow-control-authority-contract.js';
import { recoveryConflict } from '../workflow-run-recovery-evidence.js';
import {
  hashWorkflowRunnerAuthorityBindingStage,
  validateWorkflowRunnerAuthorityBindingStageReceipt,
  type WorkflowRunnerAuthorityBindingStage,
  type WorkflowRunnerAuthorityStageReceipt,
  type WorkflowRunnerResumeAuthorityEvidence,
} from '../workflow-runner-authority-binding-contract.js';
import { closedDataRecord } from './contract-validation.js';
import { WORKFLOW_BINDING_HASH_REGEX } from './workflow-binding-field-rules.js';
import { resumeCorrelationId } from './workflow-resume-correlation.js';
import { resumeEvidence } from './workflow-runner-checkpoint-evidence.js';

interface LegacyResumeIntent {
  schema: 'openslack.workflow_runner_resume_source_intent.v1';
  stageHash: string;
  correlationId: string;
  stageReceipt: WorkflowRunnerAuthorityStageReceipt;
  priorRevision: number;
  priorBindingHash: string;
  phaseCount: number;
  expected: WorkflowControlAuthorityExpectedHead;
  record: WorkflowControlAuthorityRunRecord;
}
export interface ResumeIntent extends Omit<LegacyResumeIntent, 'schema' | 'correlationId'> {
  schema: 'openslack.workflow_runner_resume_source_intent.v2';
  /** Writers persist this for rollback compatibility; readers also accept historical compact v2. */
  correlationId?: string;
  prior: WorkflowCheckpointControlState;
  next: WorkflowCheckpointControlState;
  evidence: WorkflowRunnerResumeAuthorityEvidence;
}
export type Intent = LegacyResumeIntent | ResumeIntent;

export function parseWorkflowResumeIntent(
  bytes: string,
  stage: WorkflowRunnerAuthorityBindingStage,
  target: WorkflowControlAuthorityMessage,
): Intent {
  try {
    const intent = JSON.parse(bytes) as Intent;
    const v2 = intent.schema === 'openslack.workflow_runner_resume_source_intent.v2';
    const fields = [
      'schema',
      'stageHash',
      ...(!v2 || Object.hasOwn(intent, 'correlationId') ? ['correlationId'] : []),
      'stageReceipt',
      'priorRevision',
      'priorBindingHash',
      'phaseCount',
      'expected',
      'record',
      ...(v2 ? ['prior', 'next', 'evidence'] : []),
    ];
    const invalid = () => {
      throw new TypeError('Invalid resume intent fields.');
    };
    closedDataRecord(intent, fields, '$', {
      inert: invalid,
      missing: invalid,
      unknown: invalid,
      dataField: invalid,
    });
    if (
      canonical(intent) + '\n' !== bytes ||
      (!v2 && intent.schema !== 'openslack.workflow_runner_resume_source_intent.v1') ||
      intent.stageHash !== hashWorkflowRunnerAuthorityBindingStage(stage) ||
      ((!v2 || Object.hasOwn(intent, 'correlationId')) &&
        intent.correlationId !== resumeCorrelationId(intent.stageHash)) ||
      !Number.isSafeInteger(intent.priorRevision) ||
      intent.priorRevision < 1 ||
      !Number.isSafeInteger(intent.phaseCount) ||
      intent.phaseCount < 0 ||
      !WORKFLOW_BINDING_HASH_REGEX.test(intent.priorBindingHash) ||
      intent.expected.resumeGeneration !== target.resumeGeneration ||
      intent.record.resumeGeneration !== target.resumeGeneration! + 1 ||
      intent.record.revision !== intent.expected.revision + 1 ||
      intent.record.runId !== stage.runId ||
      intent.record.workspaceId !== stage.workspaceId ||
      canonical(intent.record.route) !== canonical(stage.route) ||
      !['paused', 'paused_waiting_approval'].includes(intent.expected.state ?? '') ||
      intent.record.state !== 'resuming'
    )
      throw new Error();
    validateWorkflowRunnerAuthorityBindingStageReceipt(intent.stageReceipt, stage);
    if (v2) {
      validateWorkflowCheckpointControlState(intent.prior, stage.runId);
      validateWorkflowCheckpointControlState(intent.next, stage.runId);
      if (
        intent.prior.revision !== intent.priorRevision ||
        workflowCheckpointHash(intent.prior.activeBinding) !== intent.priorBindingHash ||
        intent.next.revision !== intent.priorRevision + 1 ||
        intent.next.resumeGeneration !== intent.record.resumeGeneration ||
        intent.prior.resumeGeneration !== intent.expected.resumeGeneration ||
        intent.next.activeBinding.workspaceId !== target.workspaceId ||
        intent.next.activeBinding.jobId !== target.jobId ||
        intent.next.activeBinding.attemptId !== target.attemptId ||
        intent.next.activeBinding.leaseId !== target.leaseId ||
        intent.next.activeBinding.fencingToken !== target.fencingToken ||
        intent.next.activeBinding.correlationId !== target.correlationId ||
        intent.next.activeBinding.runnerBuildHash !== intent.prior.activeBinding.runnerBuildHash ||
        canonical(intent.next.seenBindingHashes) !==
          canonical([
            ...intent.prior.seenBindingHashes,
            workflowCheckpointHash(intent.next.activeBinding),
          ]) ||
        intent.next.sourceSequence !== intent.prior.sourceSequence ||
        intent.next.shadowEnabled !== intent.prior.shadowEnabled ||
        intent.next.shadowOverflowed !==
          (intent.prior.shadowOverflowed || intent.prior.shadowEnabled) ||
        canonical(intent.next.pendingObservations) !==
          canonical(intent.prior.pendingObservations) ||
        (['workflowSourceHash', 'manifestHash', 'inputHash'] as const).some(
          (field) =>
            intent.record[field] !== intent.prior.activeBinding[field] ||
            intent.record[field] !== intent.next.activeBinding[field],
        ) ||
        canonical(intent.prior.checkpoints) !== canonical(intent.next.checkpoints) ||
        intent.phaseCount !== intent.next.checkpoints.length ||
        canonical(intent.evidence) !== canonical(resumeEvidence(intent.next, target)) ||
        intent.record.currentPhaseId !== intent.evidence.nextPhaseId ||
        intent.record.currentPhaseIndex !== intent.evidence.nextPhaseIndex
      )
        throw new Error();
    } else if (
      intent.record.currentPhaseId !== intent.expected.currentPhaseId ||
      intent.record.currentPhaseIndex !== intent.expected.currentPhaseIndex
    )
      throw new Error();
    return intent;
  } catch {
    return recoveryConflict(
      'Resume intent is torn or conflicts with its operation; explicit repair is required.',
    );
  }
}

/** Persist the derived field required by deployed v2 readers during rollback. */
export function createWorkflowResumeIntent(
  value: Omit<ResumeIntent, 'correlationId'>,
): ResumeIntent & { correlationId: string } {
  return { ...value, correlationId: resumeCorrelationId(value.stageHash) };
}
