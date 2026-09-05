import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { closedDataRecord } from './contract-validation.js';
import { RunStore, WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES } from '../run-store.js';
import { createWorkflowRunStoreRecoveryAccess } from './workflow-run-store-recovery-access.js';
import { resumeEvidence } from './workflow-runner-checkpoint-evidence.js';
import {
  canonicalWorkflowControlAuthorityJson as canonical,
  type WorkflowControlAuthorityMessage,
} from '../workflow-control-authority-contract.js';
import type {
  WorkflowControlResumeAuthorityPort,
  WorkflowControlAuthorityExpectedHead,
  WorkflowControlAuthorityRunRecord,
} from '../workflow-control-authority-client.js';
import {
  hashWorkflowRunnerAuthorityBindingStage,
  validateWorkflowRunnerAuthorityBindingStageReceipt,
  parseWorkflowRunnerAuthorityBindingResolutionBytes,
  parseWorkflowRunnerAuthorityBindingReceiptBytes,
  type WorkflowRunnerAuthorityBindingStage,
  type WorkflowRunnerAuthorityStageReceipt,
  type WorkflowRunnerResumeAuthorityEvidence,
  type WorkflowRunnerAuthorityResolutionReceipt,
} from '../workflow-runner-authority-binding-contract.js';
import {
  workflowCheckpointHash,
  validateWorkflowCheckpointControlState,
  type WorkflowCheckpointControlState,
} from '../workflow-checkpoint-shadow-contract.js';
import {
  readOwnerFile,
  atomicWrite,
  productionJournalSecurity,
} from '../workflow-control-shadow.js';
import { resolveWorkflowRunProjectionRoot } from '../workflow-run-projection.js';
import {
  assertRecoveryFrontier,
  historicalResumeEvidence,
  recoveryConflict,
  type WorkflowRunRecoveryEvidencePort,
  type WorkflowRunRecoveryEvidence,
} from '../workflow-run-recovery-evidence.js';
import type { WorkflowRunnerAuthoritySourceProbe } from '../workflow-runner-authority-binding-runtime.js';

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
interface ResumeIntent extends Omit<LegacyResumeIntent, 'schema' | 'correlationId'> {
  schema: 'openslack.workflow_runner_resume_source_intent.v2';
  /** Older v2 writers persisted this derived value; new writers reconstruct it. */
  correlationId?: string;
  prior: WorkflowCheckpointControlState;
  next: WorkflowCheckpointControlState;
  evidence: WorkflowRunnerResumeAuthorityEvidence;
}
type Intent = LegacyResumeIntent | ResumeIntent;

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
    const invalid = (): never => {
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
        intent.correlationId !== `resume.${intent.stageHash}`) ||
      !Number.isSafeInteger(intent.priorRevision) ||
      intent.priorRevision < 1 ||
      !Number.isSafeInteger(intent.phaseCount) ||
      intent.phaseCount < 0 ||
      !/^[0-9a-f]{64}$/u.test(intent.priorBindingHash) ||
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

/** Durable Go proof is independent of current cache progress and lease authority. */
export class WorkflowRunnerResumeSourceStore extends RunStore {
  readonly #security = productionJournalSecurity();
  constructor(
    workspaceRoot: string,
    readonly target: WorkflowControlAuthorityMessage,
    readonly authority: WorkflowControlResumeAuthorityPort,
    readonly recovery: WorkflowRunRecoveryEvidencePort,
  ) {
    super({
      baseDir: resolveWorkflowRunProjectionRoot(workspaceRoot, 'go'),
      access: createWorkflowRunStoreRecoveryAccess(),
    });
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
    )
      recoveryConflict('Resume target differs from its exact staged event.');
  }
  async #intent(stage: WorkflowRunnerAuthorityBindingStage): Promise<Intent | null> {
    this.#assertStage(stage);
    let bytes: string;
    try {
      bytes = await readOwnerFile(
        this.#path(stage),
        this.#security,
        WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return recoveryConflict('Resume intent cannot be read safely.');
    }
    return parseWorkflowResumeIntent(bytes, stage, this.target);
  }
  #receipt(intent: Intent, signal?: AbortSignal) {
    return this.authority.readTransitionReceipt(
      intent.record,
      intent.expected,
      `resume.${intent.stageHash}`,
      signal,
    );
  }
  async #finish(intent: ResumeIntent, stage: WorkflowRunnerAuthorityBindingStage): Promise<void> {
    // Only the exact healthy pre-CAS cache can be completed automatically.
    let current: WorkflowCheckpointControlState | null;
    try {
      current = await this.loadCheckpointControl(stage.runId);
    } catch {
      return;
    }
    if (
      !current ||
      current.resumeGeneration > intent.next.resumeGeneration ||
      current.revision > intent.next.revision
    )
      return;
    await this.finalizeCheckpointResume(stage.runId, stage.bindingId, intent.prior, intent.next);
  }

  async probeEvidence(
    stage: WorkflowRunnerAuthorityBindingStage,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerResumeAuthorityEvidence | null> {
    const result = await this.probe(stage, signal);
    return result.state === 'committed'
      ? (result.evidence as WorkflowRunnerResumeAuthorityEvidence)
      : null;
  }

  async probe(
    stage: WorkflowRunnerAuthorityBindingStage,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerAuthoritySourceProbe> {
    this.#assertStage(stage);
    // Precise immutable operation lookup precedes any local generation check.
    const view = await this.recovery.readRecoveryEvidence(stage.runId, stage.bindingId, signal);
    const evidence = await this.#readEvidence(stage, view, signal);
    if (!evidence) return { state: 'not_committed' };
    const entry = view.bindings.find((entry) => entry.bindingId === stage.bindingId);
    return {
      state: 'committed',
      evidence,
      ...(entry?.resolution && entry.resolutionReceipt
        ? {
            durableResolution: {
              resolution: parseWorkflowRunnerAuthorityBindingResolutionBytes(
                Buffer.from(entry.resolution),
              ),
              receipt: parseWorkflowRunnerAuthorityBindingReceiptBytes(
                Buffer.from(entry.resolutionReceipt),
              ) as WorkflowRunnerAuthorityResolutionReceipt,
            },
          }
        : {}),
    };
  }

  async #readEvidence(
    stage: WorkflowRunnerAuthorityBindingStage,
    view: WorkflowRunRecoveryEvidence,
    signal?: AbortSignal,
  ): Promise<WorkflowRunnerResumeAuthorityEvidence | null> {
    const historical = historicalResumeEvidence(view, stage);
    const intent = await this.#intent(stage);
    if (!intent) return historical;
    if (historical) {
      if (intent.schema === 'openslack.workflow_runner_resume_source_intent.v2') {
        if (canonical(intent.evidence) !== canonical(historical))
          return recoveryConflict('Local resume intent differs from its durable resolution.');
        // A durable resolution proves the old operation independently of any
        // later reservation. Cache repair must not turn that proof into a
        // conflict while another generation is committing outside its lock.
      }
      return historical;
    }
    if (!(await this.#receipt(intent, signal))) return null;
    if (intent.schema === 'openslack.workflow_runner_resume_source_intent.v2') {
      await this.#finish(intent, stage);
      return intent.evidence;
    }
    const state = await this.loadCheckpointControl(stage.runId);
    if (
      !state ||
      state.revision !== intent.priorRevision + 1 ||
      state.resumeGeneration !== intent.record.resumeGeneration ||
      state.checkpoints.length !== intent.phaseCount ||
      state.activeBinding.attemptId !== this.target.attemptId ||
      state.activeBinding.leaseId !== this.target.leaseId
    )
      return recoveryConflict('Legacy resume intent requires its exact durable source evidence.');
    return resumeEvidence(state, this.target);
  }

  async committed(
    stage: WorkflowRunnerAuthorityBindingStage,
    signal?: AbortSignal,
  ): Promise<WorkflowCheckpointControlState | null> {
    const intent = await this.#intent(stage);
    if (!intent || !(await this.#receipt(intent, signal))) return null;
    if (intent.schema === 'openslack.workflow_runner_resume_source_intent.v2') {
      await this.#finish(intent, stage);
      return intent.next;
    }
    await this.probeEvidence(stage, signal);
    return this.loadCheckpointControl(stage.runId);
  }

  async commitResume(
    stage: WorkflowRunnerAuthorityBindingStage,
    stageReceipt: WorkflowRunnerAuthorityStageReceipt,
    signal?: AbortSignal,
  ): Promise<WorkflowCheckpointControlState> {
    this.#assertStage(stage);
    validateWorkflowRunnerAuthorityBindingStageReceipt(stageReceipt, stage);
    const committed = await this.committed(stage, signal);
    if (committed) return committed;
    signal?.throwIfAborted();
    if (
      typeof this.target.payload.leaseExpiresAt !== 'string' ||
      Date.parse(this.target.payload.leaseExpiresAt) <= Date.now()
    )
      return recoveryConflict(
        'The resume lease has expired; history does not authorize execution.',
      );
    const prior = await this.loadCheckpointControl(stage.runId);
    if (!prior)
      return recoveryConflict(
        'Resume source has no checkpoint cache; explicit repair is required.',
      );
    const head = await this.authority.read(stage.runId, stage.route, signal);
    const view = await this.recovery.readRecoveryEvidence(stage.runId, undefined, signal);
    assertRecoveryFrontier(view, head, prior, stage.bindingId);
    if (
      head.resumeGeneration !== this.target.resumeGeneration ||
      !['paused', 'paused_waiting_approval'].includes(head.state) ||
      view.activeAttempts.some((attempt) => attempt !== this.target.attemptId)
    )
      return recoveryConflict('Resume has no matching current authority and exclusive lease.');
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
    let intent: Intent | null = null;
    return this.advanceCheckpointResumeGeneration(
      stage.runId,
      binding,
      `phase-${prior.checkpoints.length}`,
      prior.checkpoints.length,
      {
        expectedGeneration: target.resumeGeneration!,
        reservationId: stage.bindingId,
        prepare: async (lockedPrior, next) => {
          if (workflowCheckpointHash(lockedPrior) !== workflowCheckpointHash(prior))
            return recoveryConflict(
              'Checkpoint cache changed after its recovery evidence was read.',
            );
          intent = await this.#intent(stage);
          if (!intent) {
            intent = {
              schema: 'openslack.workflow_runner_resume_source_intent.v2',
              stageHash: hashWorkflowRunnerAuthorityBindingStage(stage),
              stageReceipt,
              priorRevision: prior.revision,
              priorBindingHash: workflowCheckpointHash(prior.activeBinding),
              phaseCount: prior.checkpoints.length,
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
                currentPhaseId: `phase-${prior.checkpoints.length}`,
                currentPhaseIndex: prior.checkpoints.length,
              },
              prior: lockedPrior,
              next,
              evidence: resumeEvidence(next, target),
            };
            const bytes = canonical(intent) + '\n';
            // Intents contain two checkpoint states. Use the local checkpoint
            // file ceiling, and prove readability before publishing or CAS.
            if (Buffer.byteLength(bytes) > WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES)
              return recoveryConflict('Resume intent exceeds the checkpoint file contract.');
            await atomicWrite(this.#path(stage), bytes, this.#security);
          }
          if (
            intent.priorRevision !== lockedPrior.revision ||
            intent.priorBindingHash !== workflowCheckpointHash(lockedPrior.activeBinding) ||
            intent.phaseCount !== lockedPrior.checkpoints.length
          )
            return recoveryConflict('Resume intent conflicts with the checkpoint cache.');
          if (intent.schema === 'openslack.workflow_runner_resume_source_intent.v2')
            return intent.next;
        },
        commit: async () => {
          if (!intent) return recoveryConflict('Resume intent was not published.');
          signal?.throwIfAborted();
          if (!(await this.#receipt(intent, signal))) {
            signal?.throwIfAborted();
            if (Date.parse(String(this.target.payload.leaseExpiresAt)) <= Date.now())
              return recoveryConflict('The resume lease expired before its authority transition.');
            await this.authority.transition(
              intent.record,
              intent.expected,
              `resume.${intent.stageHash}`,
              signal,
            );
          }
          if (!(await this.#receipt(intent, signal)))
            return recoveryConflict('Resume CAS lacks its exact receipt.');
        },
      },
    );
  }
}
