import { createHash } from 'node:crypto';
import {
  canonicalWorkflowControlAuthorityJson as canonical,
  validateWorkflowControlAuthorityReceipt,
} from './workflow-control-authority-contract.js';
import {
  hashWorkflowRunnerAuthorityBindingStage,
  parseWorkflowRunnerAuthorityBindingResolutionBytes,
  parseWorkflowRunnerBudgetDurableReceiptBytes,
  validateWorkflowRunnerBudgetSourceResult,
  type WorkflowRunnerAuthorityBindingStage,
} from './workflow-runner-authority-binding-contract.js';
import { validateWorkflowBudgetReceiptForRequest } from './workflow-budget-authority-contract.js';

export interface WorkflowBindingSettlementReceipt {
  schema: 'openslack.workflow_runner_binding_settlement_receipt.v1';
  workspaceId: string;
  runId: string;
  bindingId: string;
  stageHash: string;
  outcome: 'committed' | 'not_committed';
  proofKind: 'resolution' | 'source_receipt' | 'source_fence' | 'budget_source_result';
  proof: string;
  idempotencyKey: string;
  requestHash: string;
  callerId: string;
  rulesVersion: 1;
  committedAt: string;
}

export const workflowReconciliationHash = (bytes: string) =>
  createHash('sha256').update(bytes, 'utf8').digest('hex');

export function prepareWorkflowBindingReconciliation(
  stage: WorkflowRunnerAuthorityBindingStage,
  outcome: WorkflowBindingSettlementReceipt['outcome'],
) {
  const value = {
    schema: 'openslack.workflow_runner_binding_reconciliation.v1',
    workspaceId: stage.workspaceId,
    runId: stage.runId,
    bindingId: stage.bindingId,
    stageHash: hashWorkflowRunnerAuthorityBindingStage(stage),
    outcome,
    rulesVersion: 1,
  };
  const body = canonical(value) + '\n';
  const requestHash = workflowReconciliationHash(body);
  return {
    value,
    body,
    requestHash,
    idempotencyKey: `openslack.workflow-runner-reconciliation.v1.${requestHash}`,
  };
}

export function parseWorkflowBindingReconciliation(bytes: string) {
  const value: ReturnType<typeof prepareWorkflowBindingReconciliation>['value'] = JSON.parse(bytes);
  if (
    !value ||
    Array.isArray(value) ||
    canonical(value) + '\n' !== bytes ||
    Object.keys(value).sort().join(',') !==
      'bindingId,outcome,rulesVersion,runId,schema,stageHash,workspaceId' ||
    value.schema !== 'openslack.workflow_runner_binding_reconciliation.v1' ||
    value.rulesVersion !== 1 ||
    ![value.workspaceId, value.runId].every(
      (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(id),
    ) ||
    !/^WFRUNNER-BINDING-[0-9a-f]{64}$/u.test(value.bindingId) ||
    !/^[0-9a-f]{64}$/u.test(value.stageHash) ||
    !['committed', 'not_committed'].includes(value.outcome)
  )
    throw new TypeError('Binding reconciliation request is invalid.');
  const requestHash = workflowReconciliationHash(bytes);
  return {
    value,
    body: bytes,
    requestHash,
    idempotencyKey: `openslack.workflow-runner-reconciliation.v1.${requestHash}`,
  };
}

export function parseWorkflowBindingSettlement(bytes: string): WorkflowBindingSettlementReceipt {
  const value = JSON.parse(bytes) as WorkflowBindingSettlementReceipt;
  if (
    !value ||
    Array.isArray(value) ||
    canonical(value) + '\n' !== bytes ||
    Object.keys(value).sort().join(',') !==
      [
        'schema',
        'workspaceId',
        'runId',
        'bindingId',
        'stageHash',
        'outcome',
        'proofKind',
        'proof',
        'idempotencyKey',
        'requestHash',
        'callerId',
        'rulesVersion',
        'committedAt',
      ]
        .sort()
        .join(',') ||
    value.schema !== 'openslack.workflow_runner_binding_settlement_receipt.v1' ||
    ![value.workspaceId, value.runId, value.callerId].every(
      (id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(id),
    ) ||
    !/^WFRUNNER-BINDING-[0-9a-f]{64}$/u.test(value.bindingId) ||
    !/^[0-9a-f]{64}$/u.test(value.stageHash) ||
    !/^[0-9a-f]{64}$/u.test(value.requestHash) ||
    value.idempotencyKey !== `openslack.workflow-runner-reconciliation.v1.${value.requestHash}` ||
    !['committed', 'not_committed'].includes(value.outcome) ||
    !['resolution', 'source_receipt', 'source_fence', 'budget_source_result'].includes(
      value.proofKind,
    ) ||
    (value.outcome === 'not_committed') !== (value.proofKind === 'source_fence') ||
    typeof value.proof !== 'string' ||
    value.rulesVersion !== 1 ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value.committedAt) ||
    !Number.isFinite(Date.parse(value.committedAt)) ||
    new Date(value.committedAt).toISOString() !== value.committedAt
  )
    throw new TypeError('Binding settlement receipt is invalid.');
  return value;
}

/** Exact historical resolution carried by a closure, never a replacement ACK. */
export function workflowBindingSettlementResolution(
  receipt: WorkflowBindingSettlementReceipt,
): string | null {
  if (receipt.proofKind === 'resolution') return receipt.proof;
  if (receipt.proofKind !== 'budget_source_result') return null;
  const proof = JSON.parse(receipt.proof);
  if (!proof || typeof proof.resolution !== 'string')
    throw new TypeError('Budget settlement resolution is missing.');
  return proof.resolution;
}

/** Closure proves history only. It never supplies a current execution lease. */
export function validateWorkflowBindingSettlement(
  receipt: WorkflowBindingSettlementReceipt,
  stage: WorkflowRunnerAuthorityBindingStage,
  exactResolution?: string | null,
): void {
  const request = prepareWorkflowBindingReconciliation(stage, receipt.outcome);
  if (
    receipt.workspaceId !== stage.workspaceId ||
    receipt.runId !== stage.runId ||
    receipt.bindingId !== stage.bindingId ||
    receipt.stageHash !== request.value.stageHash ||
    receipt.requestHash !== request.requestHash ||
    receipt.idempotencyKey !== request.idempotencyKey
  )
    throw new TypeError('Binding settlement identity differs from its immutable stage.');
  if (receipt.proofKind === 'resolution') {
    if (
      exactResolution !== receipt.proof ||
      ['budget_reserve', 'budget_settle'].includes(stage.operation)
    )
      throw new TypeError(
        'Settlement resolution bytes differ or prove only prepared budget intent.',
      );
  } else if (receipt.proofKind === 'budget_source_result') {
    const proof = JSON.parse(receipt.proof);
    if (
      !proof ||
      Object.keys(proof).sort().join(',') !== 'resolution,schema,sourceResult' ||
      proof.schema !== 'openslack.workflow_runner_budget_settlement_proof.v1' ||
      canonical(proof) + '\n' !== receipt.proof ||
      proof.resolution !== exactResolution ||
      typeof proof.sourceResult !== 'string' ||
      !exactResolution
    )
      throw new TypeError('Budget settlement proof differs from its original resolution.');
    const resolution = parseWorkflowRunnerAuthorityBindingResolutionBytes(
      Buffer.from(exactResolution),
    );
    if (resolution.evidence.schema !== 'openslack.workflow_runner_budget_authority_evidence.v1')
      throw new TypeError('Budget settlement proof has another operation.');
    if (stage.operation === 'budget_reserve') {
      const result = validateWorkflowRunnerBudgetSourceResult(
        JSON.parse(proof.sourceResult),
        resolution.evidence.preparedRequest,
      );
      if (canonical(result) + '\n' !== proof.sourceResult)
        throw new TypeError('Budget source result bytes are not canonical.');
    } else if (stage.operation === 'budget_settle') {
      const result = parseWorkflowRunnerBudgetDurableReceiptBytes(proof.sourceResult);
      const source = validateWorkflowBudgetReceiptForRequest(
        result.operationalProjection,
        resolution.evidence.preparedRequest,
      );
      if (
        source.operation !== 'settle' ||
        source.status !== 'accepted' ||
        source.reconciliationToken !== null
      )
        throw new TypeError('Budget source settlement remains unresolved.');
    } else throw new TypeError('Budget proof is attached to a non-budget operation.');
  } else if (receipt.proofKind === 'source_receipt') {
    const proof = validateWorkflowControlAuthorityReceipt(JSON.parse(receipt.proof));
    if (
      stage.operation !== 'resume_advance' ||
      proof.operation !== 'run_transition' ||
      proof.status !== 'accepted' ||
      proof.workspaceId !== stage.workspaceId ||
      proof.runId !== stage.runId ||
      proof.correlationId !== `resume.${receipt.stageHash}` ||
      canonical(proof.route) !== canonical(stage.route) ||
      proof.resumeGeneration !== stage.runnerAuthority.acceptedResumeGeneration
    )
      throw new TypeError('Settlement source receipt is not this resume operation.');
  } else {
    const proof = JSON.parse(receipt.proof);
    const expected = {
      schema: 'openslack.workflow_control_source_fence.v1',
      bindingId: stage.bindingId,
      workspaceId: stage.workspaceId,
      runId: stage.runId,
      stageHash: receipt.stageHash,
      correlationId: `resume.${receipt.stageHash}`,
      expectedResumeGeneration: stage.runnerAuthority.expectedResumeGeneration,
    };
    if (
      stage.operation !== 'resume_advance' ||
      canonical(proof) + '\n' !== receipt.proof ||
      canonical(proof) !== canonical(expected)
    )
      throw new TypeError('Settlement source fence differs from its immutable operation.');
  }
}
