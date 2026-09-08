import { resumeCorrelationId } from './workflow-resume-correlation.js';
import { WorkflowRunReadError, assertWorkflowRunPathId } from '../workflow-run-read-errors.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { RunStore, WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES } from '../run-store.js';
import { createWorkflowRunStoreRecoveryAccess } from './workflow-run-store-recovery-access.js';
import { resumeEvidence } from './workflow-runner-checkpoint-evidence.js';
import {
  isWorkflowAuthorityRetryable,
  workflowAuthorityFailure,
} from './workflow-authority-failure.js';
import { throwIfWorkflowRunnerAborted } from '../workflow-runner-control-http.js';
import {
  canonicalWorkflowControlAuthorityJson as canonical,
  type WorkflowControlAuthorityMessage,
} from '../workflow-control-authority-contract.js';
import type { WorkflowControlResumeAuthorityPort } from '../workflow-control-authority-client.js';
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
  validateSettledResumeIntent,
  historicalResumeEvidence,
  recoveryConflict,
  WorkflowRunRecoveryError,
  type WorkflowRunRecoveryEvidencePort,
  type WorkflowRunRecoveryEvidence,
} from '../workflow-run-recovery-evidence.js';
import type { WorkflowRunnerAuthoritySourceProbe } from '../workflow-runner-authority-binding-runtime.js';
import { validateWorkflowBindingSettlement } from '../workflow-binding-reconciliation-contract.js';

import {
  parseWorkflowResumeIntent,
  createWorkflowResumeIntent,
  type Intent,
  type ResumeIntent,
} from './workflow-resume-intent.js';
export { parseWorkflowResumeIntent } from './workflow-resume-intent.js';

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
    assertWorkflowRunPathId(stage.runId, { scope: 'run', backend: 'go' });
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
      if (isWorkflowAuthorityRetryable(error)) throw workflowAuthorityFailure(error);
      if (error instanceof WorkflowRunReadError) throw error;
      return recoveryConflict('Resume intent cannot be read safely.');
    }
    return parseWorkflowResumeIntent(bytes, stage, this.target);
  }
  #receipt(intent: Intent, signal?: AbortSignal) {
    return this.authority.readTransitionReceipt(
      intent.record,
      intent.expected,
      resumeCorrelationId(intent.stageHash),
      signal,
    );
  }
  async #settlement(stage: WorkflowRunnerAuthorityBindingStage, view: WorkflowRunRecoveryEvidence) {
    const settlement = view.settlements?.find((item) => item.bindingId === stage.bindingId);
    if (!settlement) return null;
    const binding = view.bindings.find((item) => item.bindingId === stage.bindingId);
    if (!binding || canonical(JSON.parse(binding.stage)) !== canonical(stage))
      return recoveryConflict('Settlement does not match the original resume stage.');
    validateWorkflowBindingSettlement(settlement, stage, binding.resolution);
    if (settlement.outcome === 'not_committed') {
      await this.releaseCheckpointReservation(stage.runId, stage.bindingId);
      throw new WorkflowRunRecoveryError(
        'WORKFLOW_RUN_RECOVERY_SUPERSEDED',
        'This resume operation is durably fenced; use a new execution after reconciliation.',
      );
    }
    return settlement;
  }
  async #finish(
    intent: ResumeIntent,
    stage: WorkflowRunnerAuthorityBindingStage,
  ): Promise<WorkflowCheckpointControlState> {
    // Only the exact healthy pre-CAS cache can be completed automatically.
    let current: WorkflowCheckpointControlState | null;
    try {
      current = await this.loadCheckpointControl(stage.runId);
    } catch (cause) {
      if (isWorkflowAuthorityRetryable(cause)) throw workflowAuthorityFailure(cause);
      if (cause instanceof WorkflowRunReadError) throw cause;
      if (
        cause &&
        typeof cause === 'object' &&
        'code' in cause &&
        cause.code !== 'WORKFLOW_CHECKPOINT_CONTROL_CORRUPT' &&
        cause.code !== 'WORKFLOW_CHECKPOINT_CONTROL_MISSING'
      )
        throw cause;
      throw new WorkflowRunRecoveryError(
        'WORKFLOW_RUN_RECOVERY_CACHE_REPAIR_REQUIRED',
        'Committed resume has an unreadable cache; use runs repair-checkpoints.',
        { cause },
      );
    }
    if (!current)
      throw new WorkflowRunRecoveryError(
        'WORKFLOW_RUN_RECOVERY_CACHE_REPAIR_REQUIRED',
        'Committed resume has no cache; use runs repair-checkpoints.',
      );
    if (
      current.resumeGeneration > intent.next.resumeGeneration ||
      current.revision > intent.next.revision
    )
      throw new WorkflowRunRecoveryError(
        'WORKFLOW_RUN_RECOVERY_SUPERSEDED',
        'A newer checkpoint cache supersedes this resume.',
      );
    return this.finalizeCheckpointResume(stage.runId, stage.bindingId, intent.prior, intent.next);
  }

  async #assertCurrentHead(
    stage: WorkflowRunnerAuthorityBindingStage,
    evidence: WorkflowRunnerResumeAuthorityEvidence,
    state: WorkflowCheckpointControlState,
    signal?: AbortSignal,
    intent?: Intent,
  ): Promise<void> {
    throwIfWorkflowRunnerAborted(signal);
    if (
      typeof this.target.payload.leaseExpiresAt !== 'string' ||
      Date.parse(this.target.payload.leaseExpiresAt) <= Date.now()
    )
      throw new WorkflowRunRecoveryError(
        'WORKFLOW_RUN_RECOVERY_SUPERSEDED',
        'The old lease cannot authorize resume execution.',
      );
    const head = await this.authority.read(stage.runId, stage.route, signal);
    if (
      head.workspaceId !== stage.workspaceId ||
      head.runId !== stage.runId ||
      canonical(head.record.route) !== canonical(stage.route) ||
      head.state !== 'resuming' ||
      head.resumeGeneration !== evidence.sourceAuthority.acceptedResumeGeneration ||
      head.currentPhaseId !== evidence.nextPhaseId ||
      head.currentPhaseIndex !== evidence.nextPhaseIndex ||
      head.record.workflowSourceHash !== state.activeBinding.workflowSourceHash ||
      head.record.manifestHash !== state.activeBinding.manifestHash ||
      head.record.inputHash !== state.activeBinding.inputHash ||
      (intent && canonical(head.record) !== canonical(intent.record))
    )
      throw new WorkflowRunRecoveryError(
        'WORKFLOW_RUN_RECOVERY_SUPERSEDED',
        'Current authority no longer matches this committed resume.',
      );
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
    const settlement = await this.#settlement(stage, view);
    const evidence = await this.#readEvidence(stage, view, signal);
    if (!evidence) {
      if (settlement)
        throw new WorkflowRunRecoveryError(
          'WORKFLOW_RUN_RECOVERY_CACHE_REPAIR_REQUIRED',
          'Committed resume needs its original source evidence; use runs repair-checkpoints.',
        );
      return { state: 'not_committed' };
    }
    let readiness: Extract<WorkflowRunnerAuthoritySourceProbe, { state: 'committed' }>['readiness'];
    try {
      if (settlement)
        throw new WorkflowRunRecoveryError(
          'WORKFLOW_RUN_RECOVERY_SUPERSEDED',
          'This historical commit is closed; its old lease cannot authorize execution.',
        );
      const intent = await this.#intent(stage);
      if (intent?.schema === 'openslack.workflow_runner_resume_source_intent.v2') {
        if (canonical(intent.evidence) !== canonical(evidence))
          return recoveryConflict('Local resume intent differs from its durable resolution.');
        await this.#assertCurrentHead(stage, evidence, intent.next, signal, intent);
        await this.#finish(intent, stage);
      } else {
        const current = await this.loadCheckpointControl(stage.runId);
        if (!current || canonical(resumeEvidence(current, this.target)) !== canonical(evidence))
          throw new WorkflowRunRecoveryError(
            'WORKFLOW_RUN_RECOVERY_CACHE_REPAIR_REQUIRED',
            'Historical resume proof needs its exact healthy cache before delivery.',
          );
        await this.#assertCurrentHead(stage, evidence, current, signal, intent ?? undefined);
      }
      readiness = { state: 'ready' };
    } catch (error) {
      throwIfWorkflowRunnerAborted(signal);
      if (isWorkflowAuthorityRetryable(error)) throw workflowAuthorityFailure(error);
      readiness = {
        state: 'blocked',
        code:
          error instanceof WorkflowRunRecoveryError || error instanceof WorkflowRunReadError
            ? error.code
            : 'WORKFLOW_RUN_RECOVERY_CACHE_REPAIR_REQUIRED',
        message:
          error instanceof WorkflowRunReadError
            ? error.message
            : error instanceof WorkflowRunRecoveryError &&
                error.code === 'WORKFLOW_RUN_RECOVERY_CACHE_REPAIR_REQUIRED'
              ? 'Resume history is committed, but its local cache requires runs repair-checkpoints.'
              : 'Resume history is committed; inspect current authority and evidence before recovery.',
      };
    }
    const entry = view.bindings.find((entry) => entry.bindingId === stage.bindingId);
    return {
      state: 'committed',
      evidence,
      readiness,
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
    if (historical) return historical;
    const intent = await this.#intent(stage);
    if (!intent) return null;
    const settlement = view.settlements?.find((item) => item.bindingId === stage.bindingId);
    if (
      settlement?.proofKind === 'source_receipt' &&
      intent.schema === 'openslack.workflow_runner_resume_source_intent.v2'
    ) {
      validateSettledResumeIntent(stage, settlement, intent);
      return intent.evidence;
    }
    if (!(await this.#receipt(intent, signal))) return null;
    if (intent.schema === 'openslack.workflow_runner_resume_source_intent.v2') {
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
    this.#assertStage(stage);
    const view = await this.recovery.readRecoveryEvidence(stage.runId, stage.bindingId, signal);
    if (await this.#settlement(stage, view))
      throw new WorkflowRunRecoveryError(
        'WORKFLOW_RUN_RECOVERY_SUPERSEDED',
        'This closed resume requires a new execution identity.',
      );
    const intent = await this.#intent(stage);
    if (!intent || !(await this.#receipt(intent, signal))) return null;
    if (intent.schema === 'openslack.workflow_runner_resume_source_intent.v2') {
      await this.#assertCurrentHead(stage, intent.evidence, intent.next, signal, intent);
      return this.#finish(intent, stage);
    }
    const result = await this.probe(stage, signal);
    if (result.state !== 'committed')
      return recoveryConflict('Legacy resume has no verified historical commit.');
    if (result.readiness?.state !== 'ready')
      throw new WorkflowRunRecoveryError(
        'WORKFLOW_RUN_RECOVERY_CACHE_REPAIR_REQUIRED',
        'Legacy resume requires a healthy cache and current authority before delivery.',
      );
    const current = await this.loadCheckpointControl(stage.runId);
    if (!current || canonical(resumeEvidence(current, this.target)) !== canonical(result.evidence))
      return recoveryConflict('Legacy resume cache changed after verification.');
    await this.#assertCurrentHead(
      stage,
      result.evidence as WorkflowRunnerResumeAuthorityEvidence,
      current,
      signal,
      intent,
    );
    return current;
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
    throwIfWorkflowRunnerAborted(signal);
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
    const exactResumeIntents = new Map<string, string>();
    for (const entry of view.bindings) {
      if (
        entry.resolution ||
        !view.settlements?.some(
          (item) => item.bindingId === entry.bindingId && item.proofKind === 'source_receipt',
        )
      )
        continue;
      const original = JSON.parse(entry.stage) as WorkflowRunnerAuthorityBindingStage;
      try {
        const bytes = await readOwnerFile(
          this.#path(original),
          this.#security,
          WORKFLOW_CHECKPOINT_CONTROL_MAX_BYTES,
        );
        parseWorkflowResumeIntent(bytes, original, JSON.parse(original.target.body));
        exactResumeIntents.set(entry.bindingId, bytes);
      } catch (cause) {
        if (isWorkflowAuthorityRetryable(cause)) throw workflowAuthorityFailure(cause);
        throw new WorkflowRunRecoveryError(
          'WORKFLOW_RUN_RECOVERY_CACHE_REPAIR_REQUIRED',
          'Closed resume history requires its exact source intent; inspect and repair checkpoints.',
          { cause },
        );
      }
    }
    assertRecoveryFrontier(view, head, prior, stage.bindingId, exactResumeIntents);
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
            intent = createWorkflowResumeIntent({
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
            });
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
          throwIfWorkflowRunnerAborted(signal);
          if (!(await this.#receipt(intent, signal))) {
            throwIfWorkflowRunnerAborted(signal);
            if (Date.parse(String(this.target.payload.leaseExpiresAt)) <= Date.now())
              return recoveryConflict('The resume lease expired before its authority transition.');
            await this.authority.transition(
              intent.record,
              intent.expected,
              resumeCorrelationId(intent.stageHash),
              signal,
            );
          }
          if (!(await this.#receipt(intent, signal)))
            return recoveryConflict('Resume CAS lacks its exact receipt.');
          if (intent.schema === 'openslack.workflow_runner_resume_source_intent.v2')
            await this.#assertCurrentHead(stage, intent.evidence, intent.next, signal, intent);
        },
      },
    );
  }
}
