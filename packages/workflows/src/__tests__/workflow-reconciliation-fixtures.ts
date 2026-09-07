import {
  canonicalWorkflowControlAuthorityJson as canonical,
  validateWorkflowControlAuthorityReceipt,
} from '../workflow-control-authority-contract.js';
import { prepareWorkflowControlAuthorityMutation } from '../workflow-control-authority-client.js';
import {
  parseWorkflowBindingSettlement,
  prepareWorkflowBindingReconciliation,
  type WorkflowBindingSettlementReceipt,
} from '../workflow-binding-reconciliation-contract.js';
import type { WorkflowRunnerAuthorityBindingStage } from '../workflow-runner-authority-binding-contract.js';
import type { resumeIntentFixture } from './workflow-recovery-fixtures.js';

export function settlementFixture(
  stage: WorkflowRunnerAuthorityBindingStage,
  proofKind: WorkflowBindingSettlementReceipt['proofKind'],
  proof: string,
) {
  const outcome = proofKind === 'source_fence' ? 'not_committed' : 'committed';
  const prepared = prepareWorkflowBindingReconciliation(stage, outcome);
  return parseWorkflowBindingSettlement(
    canonical({
      schema: 'openslack.workflow_runner_binding_settlement_receipt.v1',
      workspaceId: stage.workspaceId,
      runId: stage.runId,
      bindingId: stage.bindingId,
      stageHash: prepared.value.stageHash,
      outcome,
      proofKind,
      proof,
      idempotencyKey: prepared.idempotencyKey,
      requestHash: prepared.requestHash,
      callerId: 'recovery.test',
      rulesVersion: 1,
      committedAt: '2026-09-07T00:00:00.000Z',
    }) + '\n',
  );
}
export function sourceFenceFixture(stage: WorkflowRunnerAuthorityBindingStage) {
  const prepared = prepareWorkflowBindingReconciliation(stage, 'not_committed');
  return settlementFixture(
    stage,
    'source_fence',
    canonical({
      schema: 'openslack.workflow_control_source_fence.v1',
      bindingId: stage.bindingId,
      stageHash: prepared.value.stageHash,
      workspaceId: stage.workspaceId,
      runId: stage.runId,
      correlationId: `resume.${prepared.value.stageHash}`,
      expectedResumeGeneration: stage.runnerAuthority.expectedResumeGeneration,
    }) + '\n',
  );
}
export function sourceCommitFixture(f: ReturnType<typeof resumeIntentFixture>) {
  const { intent, stage } = f;
  const prepared = prepareWorkflowControlAuthorityMutation({
    operation: 'transition',
    record: intent.record,
    expected: intent.expected,
    correlationId: intent.correlationId,
    callerId: 'recovery.test',
    expectedBuildHash: stage.route.authorityBuildHash,
  });
  const source = validateWorkflowControlAuthorityReceipt({
    schema: 'openslack.workflow_control_authority_receipt.v2',
    operation: 'run_transition',
    status: 'accepted',
    workspaceId: stage.workspaceId,
    runId: stage.runId,
    expectedRevision: intent.expected.revision,
    acceptedRevision: intent.record.revision,
    resumeGeneration: intent.record.resumeGeneration,
    route: stage.route,
    idempotencyKey: prepared.idempotencyKey,
    requestFingerprint: prepared.requestFingerprint,
    requestHash: prepared.requestHash,
    recordHash: prepared.recordHash,
    correlationId: intent.correlationId,
    serviceBuildHash: stage.route.authorityBuildHash,
    committedAt: '2026-09-05T00:00:00.000Z',
    reconciliationToken: null,
  });
  return settlementFixture(stage, 'source_receipt', canonical(source) + '\n');
}
