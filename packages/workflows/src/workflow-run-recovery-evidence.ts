import { isWorkflowRunId } from './internal/workflow-run-identity.js';
import { closedDataRecord } from './internal/contract-validation.js';
import {
  canonicalWorkflowControlAuthorityJson as canonical,
  validateWorkflowControlAuthorityRoute,
  type WorkflowControlAuthorityRoute,
} from './workflow-control-authority-contract.js';
import type { WorkflowControlAuthorityRunRead } from './workflow-control-authority-client.js';
import {
  parseWorkflowRunnerAuthorityBindingStageBytes,
  parseWorkflowRunnerAuthorityBindingResolutionBytes,
  parseWorkflowRunnerAuthorityBindingReceiptBytes,
  validateWorkflowRunnerAuthorityBindingStageReceipt,
  validateWorkflowRunnerAuthorityBindingResolutionReceipt,
  type WorkflowRunnerAuthorityBindingStage,
  type WorkflowRunnerAuthorityBindingResolution,
  type WorkflowRunnerResumeAuthorityEvidence,
} from './workflow-runner-authority-binding-contract.js';
import {
  workflowCheckpointHash,
  validateWorkflowCheckpointControlState,
  WORKFLOW_CHECKPOINT_CONTROL_SCHEMA,
  type WorkflowCheckpointControlState,
  type WorkflowCheckpointExecutionBinding,
  type WorkflowCheckpointRecord,
} from './workflow-checkpoint-shadow-contract.js';

export class WorkflowRunRecoveryError extends Error {
  constructor(
    readonly code:
      | 'WORKFLOW_RUN_RECOVERY_UNKNOWN'
      | 'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'WorkflowRunRecoveryError';
  }
}

export function recoveryConflict(message: string): never {
  throw new WorkflowRunRecoveryError('WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED', message);
}

export interface WorkflowRunRecoveryEvidence {
  readonly schema: 'openslack.workflow_runner_recovery_evidence.v1';
  readonly workspaceId: string;
  readonly runId: string;
  readonly route: WorkflowControlAuthorityRoute;
  readonly complete: boolean;
  readonly snapshot: string;
  readonly nextCursor: string | null;
  readonly bindings: readonly {
    readonly bindingId: string;
    readonly state: string;
    readonly stage: string;
    readonly stageReceipt: string;
    readonly resolution: string | null;
    readonly resolutionReceipt: string | null;
  }[];
  readonly unfinished: readonly {
    readonly bindingId: string;
    readonly operation: string;
    readonly state: string;
  }[];
  readonly activeAttempts: readonly string[];
}

export interface WorkflowRunRecoveryEvidencePort {
  readRecoveryEvidence(
    runId: string,
    bindingId?: string,
    signal?: AbortSignal,
  ): Promise<WorkflowRunRecoveryEvidence>;
}

function exactFields(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  const invalid = (): never => recoveryConflict('Recovery response has invalid fields.');
  closedDataRecord(value, fields, '$', {
    inert: invalid,
    missing: invalid,
    unknown: invalid,
    dataField: invalid,
  });
}
const id = isWorkflowRunId;
const states = [
  'staged',
  'resolved',
  'runner_committed',
  'completed',
  'aborted',
  'reconciliation_required',
];

export function parseWorkflowRunRecoveryEvidence(
  bytes: string,
  workspaceId: string,
  runId: string,
  bindingId?: string,
): WorkflowRunRecoveryEvidence {
  try {
    const value: unknown = JSON.parse(bytes);
    exactFields(value, [
      'schema',
      'workspaceId',
      'runId',
      'route',
      'complete',
      'snapshot',
      'nextCursor',
      'bindings',
      'unfinished',
      'activeAttempts',
    ]);
    if (
      value.schema !== 'openslack.workflow_runner_recovery_evidence.v1' ||
      value.workspaceId !== workspaceId ||
      value.runId !== runId ||
      value.complete !== (bindingId === undefined && value.nextCursor === null) ||
      typeof value.snapshot !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(value.snapshot) ||
      (value.nextCursor !== null && (bindingId !== undefined || !id(value.nextCursor))) ||
      !Array.isArray(value.bindings) ||
      !Array.isArray(value.unfinished) ||
      !Array.isArray(value.activeAttempts) ||
      !value.activeAttempts.every(id)
    )
      recoveryConflict('Recovery response identity or completeness is invalid.');
    validateWorkflowControlAuthorityRoute(value.route, '$/route');
    const seen = new Set<string>();
    for (const entry of value.bindings) {
      exactFields(entry, [
        'bindingId',
        'state',
        'stage',
        'stageReceipt',
        'resolution',
        'resolutionReceipt',
      ]);
      if (
        !id(entry.bindingId) ||
        seen.has(entry.bindingId) ||
        (bindingId !== undefined && entry.bindingId !== bindingId) ||
        !states.includes(entry.state as string) ||
        typeof entry.stage !== 'string' ||
        typeof entry.stageReceipt !== 'string' ||
        (entry.resolution !== null && typeof entry.resolution !== 'string') ||
        (entry.resolutionReceipt !== null && typeof entry.resolutionReceipt !== 'string')
      )
        recoveryConflict('Recovery binding is invalid or duplicated.');
      seen.add(entry.bindingId);
    }
    for (const entry of value.unfinished) {
      exactFields(entry, ['bindingId', 'operation', 'state']);
      if (
        !id(entry.bindingId) ||
        typeof entry.operation !== 'string' ||
        !states.includes(entry.state as string)
      )
        recoveryConflict('Recovery diagnostic is invalid.');
    }
    const result = value as unknown as WorkflowRunRecoveryEvidence;
    for (const entry of result.bindings) readRecoveryBinding(result, entry);
    return result;
  } catch (error) {
    if (error instanceof WorkflowRunRecoveryError) throw error;
    return recoveryConflict('Recovery response is malformed or contains invalid exact receipts.');
  }
}

export function readRecoveryBinding(
  view: WorkflowRunRecoveryEvidence,
  entry: WorkflowRunRecoveryEvidence['bindings'][number],
): {
  stage: WorkflowRunnerAuthorityBindingStage;
  resolution: WorkflowRunnerAuthorityBindingResolution | null;
} {
  const stage = parseWorkflowRunnerAuthorityBindingStageBytes(Buffer.from(entry.stage));
  const receipt = validateWorkflowRunnerAuthorityBindingStageReceipt(
    parseWorkflowRunnerAuthorityBindingReceiptBytes(Buffer.from(entry.stageReceipt)),
    stage,
  );
  if (
    stage.bindingId !== entry.bindingId ||
    stage.workspaceId !== view.workspaceId ||
    stage.runId !== view.runId ||
    canonical(stage.route) !== canonical(view.route) ||
    !['checkpoint_commit', 'resume_advance'].includes(stage.operation)
  )
    recoveryConflict('Recovery stage differs from the selected run or route.');
  if (entry.resolution === null || entry.resolutionReceipt === null) {
    if (
      entry.resolution !== entry.resolutionReceipt ||
      !['staged', 'aborted', 'reconciliation_required'].includes(entry.state)
    )
      recoveryConflict('Recovery resolution is partially persisted.');
    return { stage, resolution: null };
  }
  const resolution = parseWorkflowRunnerAuthorityBindingResolutionBytes(
    Buffer.from(entry.resolution),
  );
  const resolved = validateWorkflowRunnerAuthorityBindingResolutionReceipt(
    parseWorkflowRunnerAuthorityBindingReceiptBytes(Buffer.from(entry.resolutionReceipt)),
    resolution,
    stage,
    receipt,
  );
  if (receipt.status !== 'accepted' || resolved.status !== 'accepted')
    recoveryConflict('Recovery receipt requires reconciliation.');
  return { stage, resolution };
}

export function historicalResumeEvidence(
  view: WorkflowRunRecoveryEvidence,
  target: WorkflowRunnerAuthorityBindingStage,
): WorkflowRunnerResumeAuthorityEvidence | null {
  const entry = view.bindings.find((candidate) => candidate.bindingId === target.bindingId);
  if (!entry) return null;
  const { stage, resolution } = readRecoveryBinding(view, entry);
  if (canonical(stage) !== canonical(target))
    recoveryConflict('Historical resume stage was cross-spliced.');
  if (!resolution) return null;
  if (resolution.evidence.schema !== 'openslack.workflow_runner_resume_authority_evidence.v1')
    return recoveryConflict('Historical resume evidence has the wrong operation.');
  return resolution.evidence;
}

/** Rebuild only the local checkpoint cache. Durable Go frames remain untouched. */
export function recoveryCheckpointState(
  view: WorkflowRunRecoveryEvidence,
  local?: WorkflowCheckpointControlState,
): WorkflowCheckpointControlState | null {
  if (!view.complete)
    return recoveryConflict('A partial recovery query cannot prove the checkpoint frontier.');
  const committed = view.bindings
    .map((entry) => readRecoveryBinding(view, entry))
    .filter((entry) => entry.resolution !== null)
    .sort(
      (a, b) =>
        (a.resolution!.evidence.sourceAuthority.acceptedRevision ?? -1) -
        (b.resolution!.evidence.sourceAuthority.acceptedRevision ?? -1),
    );
  let revision = 1,
    generation = 0;
  const checkpoints: WorkflowCheckpointRecord[] = [];
  const seenBindingHashes: string[] = [];
  let activeBinding: WorkflowCheckpointExecutionBinding | undefined;
  let updatedAt: string | undefined;
  for (const { resolution } of committed) {
    const evidence = resolution!.evidence;
    if (
      evidence.schema !== 'openslack.workflow_runner_checkpoint_authority_evidence.v1' &&
      evidence.schema !== 'openslack.workflow_runner_resume_authority_evidence.v1'
    )
      return recoveryConflict('Recovery source is not checkpoint evidence.');
    const source = evidence.sourceAuthority;
    const observation = evidence.envelope.observation;
    if (
      source.expectedRevision !== revision ||
      source.acceptedRevision !== revision + 1 ||
      source.expectedResumeGeneration !== generation ||
      source.acceptedResumeGeneration !==
        generation + (evidence.envelope.operation === 'resume_advance' ? 1 : 0)
    )
      return recoveryConflict(
        'Recovery history has a missing, duplicate, or reordered source transition.',
      );
    const binding = {
      ...observation.runner,
      workflowRunId: view.runId,
      workflowSourceHash: observation.workflowSourceHash,
      manifestHash: observation.manifestHash,
      inputHash: observation.inputHash,
    };
    const hash = workflowCheckpointHash(binding);
    if (
      activeBinding &&
      evidence.envelope.operation === 'checkpoint_commit' &&
      workflowCheckpointHash(activeBinding) !== hash
    )
      return recoveryConflict('Checkpoint binding changed without a resume transition.');
    if (!activeBinding || evidence.envelope.operation === 'resume_advance') {
      if (!activeBinding && evidence.envelope.operation === 'resume_advance') {
        const initialHash = local?.seenBindingHashes[0];
        if (!initialHash)
          return recoveryConflict(
            'The initial binding lineage is unavailable; this cache cannot be reconstructed.',
          );
        seenBindingHashes.push(initialHash);
      }
      if (seenBindingHashes.includes(hash))
        return recoveryConflict('Recovery history reuses an old execution binding.');
      seenBindingHashes.push(hash);
    }
    if (evidence.envelope.operation === 'checkpoint_commit') {
      const checkpoint = observation.checkpoint;
      if (
        !checkpoint ||
        checkpoint.phaseIndex !== checkpoints.length ||
        checkpoint.committedRevision !== source.acceptedRevision
      )
        return recoveryConflict('Checkpoint progress is not contiguous.');
      checkpoints.push(checkpoint);
      updatedAt = checkpoint.committedAt;
    } else {
      if (
        canonical(observation.priorCheckpoint) !== canonical(checkpoints.at(-1) ?? null) ||
        observation.nextPhaseIndex !== checkpoints.length
      )
        return recoveryConflict(
          'Resume destination differs from the committed checkpoint frontier.',
        );
      updatedAt = resolution!.sentAt;
    }
    activeBinding = binding;
    revision = source.acceptedRevision;
    generation = source.acceptedResumeGeneration;
  }
  if (!activeBinding) return null;
  return validateWorkflowCheckpointControlState(
    {
      schema: WORKFLOW_CHECKPOINT_CONTROL_SCHEMA,
      runId: view.runId,
      revision,
      resumeGeneration: generation,
      sourceSequence: 0,
      shadowEnabled: false,
      shadowOverflowed: false,
      activeBinding,
      seenBindingHashes,
      checkpoints,
      pendingObservations: [],
      updatedAt,
    },
    view.runId,
  );
}

export function assertRecoveryFrontier(
  view: WorkflowRunRecoveryEvidence,
  head: WorkflowControlAuthorityRunRead,
  local: WorkflowCheckpointControlState,
  pendingBindingId?: string,
): void {
  if (
    !view.complete ||
    view.workspaceId !== head.workspaceId ||
    view.runId !== head.runId ||
    canonical(view.route) !== canonical(head.route) ||
    local.runId !== head.runId ||
    local.activeBinding.workspaceId !== head.workspaceId ||
    local.activeBinding.workflowSourceHash !== head.workflowSourceHash ||
    local.activeBinding.manifestHash !== head.manifestHash ||
    local.activeBinding.inputHash !== head.inputHash ||
    view.unfinished.some((entry) => entry.bindingId !== pendingBindingId)
  )
    recoveryConflict('Recovery requires matching identity and no competing unfinished operation.');
  const proven = recoveryCheckpointState(view, local);
  if (
    proven
      ? proven.revision !== local.revision ||
        proven.resumeGeneration !== local.resumeGeneration ||
        canonical(proven.checkpoints) !== canonical(local.checkpoints) ||
        canonical(proven.seenBindingHashes) !== canonical(local.seenBindingHashes) ||
        canonical(proven.activeBinding) !== canonical(local.activeBinding)
      : local.revision !== 1 || local.resumeGeneration !== 0 || local.checkpoints.length !== 0
  )
    recoveryConflict(
      'Local checkpoint cache is behind or differs from durable evidence; inspect and repair it explicitly.',
    );
  const next = local.checkpoints.length;
  if (
    head.resumeGeneration !== local.resumeGeneration ||
    (head.currentPhaseIndex !== null &&
      (head.currentPhaseId !== `phase-${head.currentPhaseIndex}` ||
        (head.currentPhaseIndex !== next && (next === 0 || head.currentPhaseIndex !== next - 1))))
  )
    recoveryConflict(
      'Authority phase or generation differs from the committed resume destination.',
    );
}
