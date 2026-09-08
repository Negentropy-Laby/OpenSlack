import {
  parseWorkflowBindingSettlement,
  validateWorkflowBindingSettlement,
  type WorkflowBindingSettlementReceipt,
} from './workflow-binding-reconciliation-contract.js';
import {
  canonicalWorkflowControlAuthorityJson as canonical,
  validateWorkflowControlAuthorityRoute,
  validateWorkflowControlAuthorityReceipt,
  type WorkflowControlAuthorityRoute,
} from './workflow-control-authority-contract.js';
import type { WorkflowControlAuthorityRunRead } from './workflow-control-authority-client.js';
import { prepareWorkflowControlAuthorityMutation } from './workflow-control-authority-client.js';
import { parseWorkflowResumeIntent, type ResumeIntent } from './internal/workflow-resume-intent.js';
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
      | 'WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED'
      | 'WORKFLOW_RUN_RECOVERY_CACHE_REPAIR_REQUIRED'
      | 'WORKFLOW_RUN_RECOVERY_SUPERSEDED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'WorkflowRunRecoveryError';
  }
}

export function recoveryConflict(message: string): never {
  throw new WorkflowRunRecoveryError('WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED', message);
}

export interface WorkflowRunRecoveryEvidence {
  readonly schema:
    | 'openslack.workflow_runner_recovery_evidence.v1'
    | 'openslack.workflow_runner_recovery_evidence.v2'
    | 'openslack.workflow_runner_recovery_evidence.v3';
  readonly recoveryVersion?: string;
  readonly readAt?: string;
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
  readonly settlements?: readonly WorkflowBindingSettlementReceipt[];
  readonly recordKeys?: readonly string[];
}

export const WORKFLOW_RECOVERY_V3_MEDIA_TYPE =
  'application/vnd.openslack.workflow-run-recovery-evidence.v3+json';

export interface WorkflowRunRecoveryEvidencePort {
  readRecoveryEvidence(
    runId: string,
    bindingId?: string,
    signal?: AbortSignal,
  ): Promise<WorkflowRunRecoveryEvidence>;
}

function exactFields(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== fields.sort().join(',')
  )
    recoveryConflict('Recovery response has invalid fields.');
}
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(value);
const states = [
  'staged',
  'resolved',
  'runner_committed',
  'completed',
  'aborted',
  'reconciliation_required',
];

function normalizeRecoveryV2(value: Record<string, unknown>): Record<string, unknown> {
  const v3 = value.schema === 'openslack.workflow_runner_recovery_evidence.v3';
  exactFields(value, [
    'schema',
    'workspaceId',
    'runId',
    'route',
    'complete',
    'snapshot',
    'nextCursor',
    'records',
    ...(v3 ? ['recoveryVersion', 'readAt'] : []),
  ]);
  if (
    v3 &&
    (typeof value.recoveryVersion !== 'string' ||
      !/^[1-9][0-9]{0,18}$/u.test(value.recoveryVersion) ||
      BigInt(value.recoveryVersion) > 9223372036854775807n ||
      typeof value.readAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.readAt) ||
      new Date(value.readAt).toISOString() !== value.readAt)
  )
    return recoveryConflict('Recovery v3 snapshot metadata is invalid.');
  if (!Array.isArray(value.records))
    return recoveryConflict('Recovery v2 record stream is invalid.');
  const bindings: unknown[] = [],
    unfinished: unknown[] = [],
    activeAttempts: unknown[] = [];
  const settlements: WorkflowBindingSettlementReceipt[] = [],
    recordKeys: string[] = [];
  for (const record of value.records) {
    exactFields(record, ['key', 'kind', 'value']);
    let key: string;
    if (record.kind === 'binding' || record.kind === 'diagnostic') {
      if (
        !record.value ||
        typeof record.value !== 'object' ||
        !('bindingId' in record.value) ||
        !id(record.value.bindingId)
      )
        return recoveryConflict('Recovery record identity is invalid.');
      key = `${record.kind}.${record.value.bindingId}`;
      (record.kind === 'binding' ? bindings : unfinished).push(record.value);
    } else if (record.kind === 'settlement' && typeof record.value === 'string') {
      const receipt = parseWorkflowBindingSettlement(record.value);
      if (receipt.workspaceId !== value.workspaceId || receipt.runId !== value.runId)
        return recoveryConflict('Recovery settlement belongs to another run.');
      key = `settlement.${receipt.bindingId}`;
      settlements.push(receipt);
    } else if (record.kind === 'active_attempt' && id(record.value)) {
      key = `attempt.${record.value}`;
      activeAttempts.push(record.value);
    } else return recoveryConflict('Recovery record kind is invalid.');
    if (record.key !== key || (recordKeys.length > 0 && key <= recordKeys.at(-1)!))
      return recoveryConflict('Recovery records repeat or reorder their identity.');
    recordKeys.push(key);
  }
  if (value.nextCursor !== null && value.nextCursor !== recordKeys.at(-1))
    return recoveryConflict('Recovery record cursor does not advance.');
  return {
    schema: value.schema,
    workspaceId: value.workspaceId,
    runId: value.runId,
    route: value.route,
    complete: value.complete,
    snapshot: value.snapshot,
    nextCursor: value.nextCursor,
    bindings,
    unfinished,
    activeAttempts,
    settlements,
    recordKeys,
    ...(v3 ? { recoveryVersion: value.recoveryVersion, readAt: value.readAt } : {}),
  };
}

export function validateWorkflowRunRecoveryEvidence(view: WorkflowRunRecoveryEvidence): void {
  for (const entry of view.bindings) readRecoveryBinding(view, entry);
  for (const settlement of view.settlements ?? []) {
    const entry = view.bindings.find((binding) => binding.bindingId === settlement.bindingId);
    if (!entry) return recoveryConflict('Recovery settlement has no original binding.');
    const stage = parseWorkflowRunnerAuthorityBindingStageBytes(Buffer.from(entry.stage));
    validateWorkflowBindingSettlement(settlement, stage, entry.resolution);
  }
}

export function parseWorkflowRunRecoveryEvidence(
  bytes: string,
  workspaceId: string,
  runId: string,
  bindingId?: string,
): WorkflowRunRecoveryEvidence {
  try {
    let value: unknown = JSON.parse(bytes);
    const v2 =
      value !== null &&
      typeof value === 'object' &&
      'schema' in value &&
      (value.schema === 'openslack.workflow_runner_recovery_evidence.v2' ||
        value.schema === 'openslack.workflow_runner_recovery_evidence.v3');
    if (v2) value = normalizeRecoveryV2(value as Record<string, unknown>);
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
      ...(v2 ? ['settlements', 'recordKeys'] : []),
      ...(value &&
      typeof value === 'object' &&
      'schema' in value &&
      value.schema === 'openslack.workflow_runner_recovery_evidence.v3'
        ? ['recoveryVersion', 'readAt']
        : []),
    ]);
    if (
      (!v2 && value.schema !== 'openslack.workflow_runner_recovery_evidence.v1') ||
      value.workspaceId !== workspaceId ||
      value.runId !== runId ||
      value.complete !== (bindingId === undefined && value.nextCursor === null) ||
      typeof value.snapshot !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(value.snapshot) ||
      (value.nextCursor !== null &&
        (!v2
          ? bindingId !== undefined || !id(value.nextCursor)
          : typeof value.nextCursor !== 'string' ||
            !/^(attempt|binding|diagnostic|settlement)\.[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(
              value.nextCursor,
            ))) ||
      !Array.isArray(value.bindings) ||
      !Array.isArray(value.unfinished) ||
      !Array.isArray(value.activeAttempts) ||
      !value.activeAttempts.every(id)
    )
      recoveryConflict('Recovery response identity or completeness is invalid.');
    validateWorkflowControlAuthorityRoute(value.route, '$/route');
    if (
      value.schema === 'openslack.workflow_runner_recovery_evidence.v3' &&
      value.snapshot !==
        createHash('sha256')
          .update(
            canonical([
              value.schema,
              workspaceId,
              runId,
              bindingId ?? '',
              value.route,
              value.recoveryVersion,
              value.readAt,
            ]),
          )
          .digest('hex')
    )
      recoveryConflict('Recovery v3 snapshot belongs to another query.');
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
    (view.schema === 'openslack.workflow_runner_recovery_evidence.v1' &&
      !['checkpoint_commit', 'resume_advance'].includes(stage.operation))
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
  if (receipt.status !== 'accepted' || resolved.status !== 'accepted') {
    const settled = view.settlements?.find(
      (item) => item.bindingId === stage.bindingId && item.outcome === 'committed',
    );
    if (!settled) {
      if (view.schema !== 'openslack.workflow_runner_recovery_evidence.v1')
        return { stage, resolution: null };
      recoveryConflict('Recovery receipt requires reconciliation.');
    }
    validateWorkflowBindingSettlement(settled, stage, entry.resolution);
  }
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

export function validateSettledResumeIntent(
  stage: WorkflowRunnerAuthorityBindingStage,
  settlement: WorkflowBindingSettlementReceipt,
  intent: ResumeIntent,
) {
  validateWorkflowBindingSettlement(settlement, stage);
  if (settlement.proofKind !== 'source_receipt')
    return recoveryConflict('Resume settlement has no exact source receipt.');
  const receipt = validateWorkflowControlAuthorityReceipt(JSON.parse(settlement.proof));
  const prepared = prepareWorkflowControlAuthorityMutation({
    operation: 'transition',
    record: intent.record,
    expected: intent.expected,
    correlationId: intent.correlationId,
    callerId: 'recovery-proof',
    expectedBuildHash: stage.route.authorityBuildHash,
  });
  if (
    receipt.status !== 'accepted' ||
    receipt.requestHash !== prepared.requestHash ||
    receipt.idempotencyKey !== prepared.idempotencyKey ||
    receipt.recordHash !== prepared.recordHash ||
    receipt.expectedRevision !== intent.expected.revision ||
    receipt.acceptedRevision !== intent.record.revision
  )
    return recoveryConflict(
      'Resume intent does not match the exact committed source request and record.',
    );
  return receipt;
}

/** Rebuild only the local checkpoint cache. Durable Go frames remain untouched. */
export function recoveryCheckpointState(
  view: WorkflowRunRecoveryEvidence,
  local?: WorkflowCheckpointControlState,
  exactResumeIntents: ReadonlyMap<string, string> = new Map(),
): WorkflowCheckpointControlState | null {
  if (!view.complete)
    return recoveryConflict('A partial recovery query cannot prove the checkpoint frontier.');
  validateWorkflowRunRecoveryEvidence(view);
  const committed: {
    evidence: WorkflowRunnerAuthorityBindingResolution['evidence'];
    sentAt: string;
  }[] = [];
  let initial = local;
  for (const entry of view.bindings) {
    const { stage, resolution } = readRecoveryBinding(view, entry);
    if (!['checkpoint_commit', 'resume_advance'].includes(stage.operation)) continue;
    if (resolution) {
      committed.push({ evidence: resolution.evidence, sentAt: resolution.sentAt });
      continue;
    }
    const settlement = view.settlements?.find((item) => item.bindingId === entry.bindingId);
    if (!settlement) continue;
    const raw = exactResumeIntents.get(entry.bindingId);
    if (!raw) {
      if (settlement.outcome === 'committed')
        return recoveryConflict(
          'Committed resume has no reconstructable source intent; inspect its exact evidence.',
        );
      continue;
    }
    const intent = parseWorkflowResumeIntent(raw, stage, JSON.parse(stage.target.body));
    if (intent.schema !== 'openslack.workflow_runner_resume_source_intent.v2') {
      if (settlement.outcome === 'committed')
        return recoveryConflict('Legacy source commit lacks a durable checkpoint resolution.');
      continue;
    }
    if (settlement.outcome === 'committed') {
      if (settlement.proofKind !== 'source_receipt')
        return recoveryConflict('Resume settlement has no exact source receipt.');
      const receipt = validateSettledResumeIntent(stage, settlement, intent);
      committed.push({ evidence: intent.evidence, sentAt: receipt.committedAt! });
    }
    // An original versioned intent retains initial lineage that never emitted a
    // checkpoint. Later checkpoints still have to match every durable transition.
    if (
      !initial &&
      intent.prior.revision === 1 &&
      intent.prior.resumeGeneration === 0 &&
      intent.prior.checkpoints.length === 0
    )
      initial = intent.prior;
  }
  committed.sort(
    (a, b) =>
      (a.evidence.sourceAuthority.acceptedRevision ?? -1) -
      (b.evidence.sourceAuthority.acceptedRevision ?? -1),
  );
  let revision = 1,
    generation = 0;
  const checkpoints: WorkflowCheckpointRecord[] = [];
  const seenBindingHashes: string[] = [];
  let activeBinding: WorkflowCheckpointExecutionBinding | undefined;
  let updatedAt: string | undefined;
  for (const { evidence, sentAt } of committed) {
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
        const initialHash = initial?.seenBindingHashes[0];
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
      updatedAt = sentAt;
    }
    activeBinding = binding;
    revision = source.acceptedRevision;
    generation = source.acceptedResumeGeneration;
  }
  if (!activeBinding)
    return initial?.revision === 1 &&
      initial.resumeGeneration === 0 &&
      initial.checkpoints.length === 0
      ? initial
      : null;
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
  exactResumeIntents?: ReadonlyMap<string, string>,
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
  const proven = recoveryCheckpointState(view, local, exactResumeIntents);
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
import { createHash } from 'node:crypto';
