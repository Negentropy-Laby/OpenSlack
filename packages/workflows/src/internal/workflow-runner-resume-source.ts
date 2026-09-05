import { createHash } from 'node:crypto';
import { createWorkflowRunStoreRecoveryAccess } from './workflow-run-store-recovery-access.js';
import { join } from 'node:path';
import { RunStore } from '../run-store.js';
import {
  canonicalWorkflowControlAuthorityJson as canonical,
  type WorkflowControlAuthorityMessage,
} from '../workflow-control-authority-contract.js';
import type {
  WorkflowControlAuthorityPort,
  WorkflowControlAuthorityExpectedHead,
  WorkflowControlAuthorityRunRecord,
} from '../workflow-control-authority-client.js';
import {
  hashWorkflowRunnerAuthorityBindingStage,
  validateWorkflowRunnerAuthorityBindingStageReceipt,
  type WorkflowRunnerAuthorityBindingStage,
  type WorkflowRunnerAuthorityStageReceipt,
} from '../workflow-runner-authority-binding-contract.js';
import {
  workflowCheckpointHash,
  type WorkflowCheckpointControlState,
} from '../workflow-checkpoint-shadow-contract.js';
import {
  readOwnerFile,
  writeExclusive,
  syncDirectory,
  productionJournalSecurity,
} from '../workflow-control-shadow.js';
import { resolveWorkflowRunProjectionRoot } from '../workflow-run-projection.js';

interface ResumeIntent {
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

/** Private worker source. An accepted companion stage precedes every Go CAS. */
export class WorkflowRunnerResumeSourceStore extends RunStore {
  readonly #security = productionJournalSecurity();
  constructor(
    workspaceRoot: string,
    readonly target: WorkflowControlAuthorityMessage,
    readonly authority: WorkflowControlAuthorityPort,
  ) {
    super({
      baseDir: resolveWorkflowRunProjectionRoot(workspaceRoot, 'go'),
      access: createWorkflowRunStoreRecoveryAccess(),
    });
    if (!authority.readTransitionReceipt)
      throw new Error('Resume requires exact authority receipt recovery.');
  }

  #path(stage: WorkflowRunnerAuthorityBindingStage): string {
    return join(
      this.checkpointControlDir(stage.runId),
      `resume-${createHash('sha256').update(stage.bindingId).digest('hex')}.json`,
    );
  }

  #assertStage(stage: WorkflowRunnerAuthorityBindingStage): void {
    hashWorkflowRunnerAuthorityBindingStage(stage);
    if (
      stage.operation !== 'resume_advance' ||
      this.target.kind !== 'lease_accept' ||
      stage.target.body !== canonical(this.target) + '\n'
    ) {
      throw new Error('Resume source target differs from its exact staged event.');
    }
  }

  async #intent(stage: WorkflowRunnerAuthorityBindingStage): Promise<ResumeIntent | null> {
    this.#assertStage(stage);
    let bytes: string;
    try {
      bytes = await readOwnerFile(this.#path(stage), this.#security, 1_048_576);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const intent = JSON.parse(bytes) as ResumeIntent;
    if (
      canonical(intent) + '\n' !== bytes ||
      intent.schema !== 'openslack.workflow_runner_resume_source_intent.v1' ||
      Object.keys(intent).sort().join(',') !==
        'correlationId,expected,phaseCount,priorBindingHash,priorRevision,record,schema,stageHash,stageReceipt' ||
      intent.stageHash !== hashWorkflowRunnerAuthorityBindingStage(stage) ||
      intent.correlationId !== `resume.${intent.stageHash}` ||
      !Number.isSafeInteger(intent.priorRevision) ||
      intent.priorRevision < 1 ||
      !Number.isSafeInteger(intent.phaseCount) ||
      intent.phaseCount < 0 ||
      !/^[0-9a-f]{64}$/u.test(intent.priorBindingHash) ||
      intent.expected.resumeGeneration !== this.target.resumeGeneration ||
      intent.record.resumeGeneration !== this.target.resumeGeneration! + 1 ||
      intent.record.revision !== intent.expected.revision + 1 ||
      intent.record.runId !== stage.runId ||
      intent.record.workspaceId !== stage.workspaceId ||
      canonical(intent.record.route) !== canonical(stage.route) ||
      !['paused', 'paused_waiting_approval'].includes(intent.expected.state ?? '') ||
      intent.record.currentPhaseId !== intent.expected.currentPhaseId ||
      intent.record.currentPhaseIndex !== intent.expected.currentPhaseIndex ||
      intent.record.state !== 'resuming'
    ) {
      throw new Error('Resume source intent differs from the staged attempt.');
    }
    validateWorkflowRunnerAuthorityBindingStageReceipt(intent.stageReceipt, stage);
    return intent;
  }

  async #receipt(intent: ResumeIntent) {
    return this.authority.readTransitionReceipt!(
      intent.record,
      intent.expected,
      intent.correlationId,
    );
  }

  async #assertHead(intent: ResumeIntent): Promise<void> {
    const head = await this.authority.read(intent.record.runId, intent.record.route);
    if (
      head.resumeGeneration !== intent.record.resumeGeneration ||
      head.revision < intent.record.revision ||
      (head.state !== 'resuming' && head.state !== 'running') ||
      head.workspaceId !== intent.record.workspaceId ||
      head.workflowId !== intent.record.workflowId ||
      head.workflowVersion !== intent.record.workflowVersion ||
      canonical(head.route) !== canonical(intent.record.route) ||
      head.workflowSourceHash !== intent.record.workflowSourceHash ||
      head.manifestHash !== intent.record.manifestHash ||
      head.inputHash !== intent.record.inputHash
    ) {
      throw new Error('Resume authority has advanced or drifted beyond the exact source receipt.');
    }
  }

  async committed(
    stage: WorkflowRunnerAuthorityBindingStage,
  ): Promise<WorkflowCheckpointControlState | null> {
    const intent = await this.#intent(stage);
    if (!intent) return null;
    const state = await this.loadCheckpointControl(stage.runId);
    if (!state || state.resumeGeneration !== this.target.resumeGeneration! + 1) return null;
    const binding = state.activeBinding;
    if (
      state.revision !== intent.priorRevision + 1 ||
      state.checkpoints.length !== intent.phaseCount ||
      binding.workspaceId !== this.target.workspaceId ||
      binding.jobId !== this.target.jobId ||
      binding.attemptId !== this.target.attemptId ||
      binding.leaseId !== this.target.leaseId ||
      binding.fencingToken !== this.target.fencingToken ||
      binding.correlationId !== this.target.correlationId ||
      binding.workflowSourceHash !== intent.record.workflowSourceHash ||
      binding.manifestHash !== intent.record.manifestHash ||
      binding.inputHash !== intent.record.inputHash ||
      !(await this.#receipt(intent))
    )
      throw new Error('Resume projection is not backed by the exact committed source.');
    await this.#assertHead(intent);
    return state;
  }

  async commitResume(
    stage: WorkflowRunnerAuthorityBindingStage,
    stageReceipt: WorkflowRunnerAuthorityStageReceipt,
  ): Promise<WorkflowCheckpointControlState> {
    this.#assertStage(stage);
    validateWorkflowRunnerAuthorityBindingStageReceipt(stageReceipt, stage);
    const prior = await this.loadCheckpointControl(stage.runId);
    if (!prior) throw new Error('Resume source lacks its durable checkpoint control head.');
    const target = this.target;
    const binding = {
      ...prior.activeBinding,
      workspaceId: target.workspaceId!,
      jobId: target.jobId!,
      workflowRunId: target.workflowRunId!,
      attemptId: target.attemptId!,
      leaseId: target.leaseId!,
      fencingToken: target.fencingToken!,
      correlationId: target.correlationId,
    };
    await this.advanceCheckpointResumeGeneration(
      stage.runId,
      binding,
      `phase-${prior.checkpoints.length}`,
      prior.checkpoints.length,
      {
        expectedGeneration: target.resumeGeneration!,
        commit: async (lockedPrior) => {
          let intent = await this.#intent(stage);
          if (!intent) {
            const route = {
              backend: target.authorityBackend!,
              authority: target.authority!,
              routingEpoch: target.routingEpoch!,
              authorityBuildHash: target.authorityBuildHash!,
            };
            const head = await this.authority.read(stage.runId, route);
            if (
              head.resumeGeneration !== target.resumeGeneration ||
              !['paused', 'paused_waiting_approval'].includes(head.state) ||
              head.workspaceId !== target.workspaceId ||
              head.workflowSourceHash !== binding.workflowSourceHash ||
              head.manifestHash !== binding.manifestHash ||
              head.inputHash !== binding.inputHash
            ) {
              throw new Error('Resume source has no matching unadvanced Go authority head.');
            }
            intent = {
              schema: 'openslack.workflow_runner_resume_source_intent.v1',
              stageHash: hashWorkflowRunnerAuthorityBindingStage(stage),
              stageReceipt,
              correlationId: `resume.${hashWorkflowRunnerAuthorityBindingStage(stage)}`,
              priorRevision: lockedPrior.revision,
              priorBindingHash: workflowCheckpointHash(lockedPrior.activeBinding),
              phaseCount: lockedPrior.checkpoints.length,
              expected: {
                revision: head.revision,
                state: head.state,
                currentPhaseId: head.currentPhaseId,
                currentPhaseIndex: head.currentPhaseIndex,
                resumeGeneration: head.resumeGeneration,
              },
              record: {
                ...head.record,
                state: 'resuming',
                revision: head.revision + 1,
                resumeGeneration: head.resumeGeneration + 1,
              },
            };
            await writeExclusive(this.#path(stage), canonical(intent) + '\n', this.#security);
            await syncDirectory(this.checkpointControlDir(stage.runId));
          }
          if (
            intent.priorRevision !== lockedPrior.revision ||
            intent.priorBindingHash !== workflowCheckpointHash(lockedPrior.activeBinding) ||
            intent.record.workflowSourceHash !== lockedPrior.activeBinding.workflowSourceHash ||
            intent.record.manifestHash !== lockedPrior.activeBinding.manifestHash ||
            intent.record.inputHash !== lockedPrior.activeBinding.inputHash ||
            intent.phaseCount !== lockedPrior.checkpoints.length
          ) {
            throw new Error('Resume source checkpoint changed after its intent was recorded.');
          }
          if (!(await this.#receipt(intent))) {
            await this.authority.transition(intent.record, intent.expected, intent.correlationId);
          }
          // A read of generation alone cannot prove this attempt committed the CAS.
          if (!(await this.#receipt(intent)))
            throw new Error('Resume authority receipt is not point-readable.');
          await this.#assertHead(intent);
        },
      },
    );
    const state = await this.committed(stage);
    if (!state) throw new Error('Resume source commit is not point-readable.');
    return state;
  }
}
