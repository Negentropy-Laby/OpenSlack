import {
  readWorkflowEffectApprovalRecordExact,
  resolveWorkflowEffectApprovalRoot,
} from '../../packages/workflows/src/workflow-effect-approval-store.js';
import { SAFE_IDENTIFIER_REGEX } from '../../packages/workflows/src/internal/workflow-binding-field-rules.js';
import { preparationStatus, timestamp } from './evidence.js';

/** Inspect only. This module cannot issue a binding, decide, or supply a TTY answer. */
export async function inspectPendingApproval(
  workspaceRoot: string,
  runId: string,
  approvalId: string,
  now: string,
) {
  if (!SAFE_IDENTIFIER_REGEX.test(runId) || !SAFE_IDENTIFIER_REGEX.test(approvalId))
    throw new Error('Invalid exact approval identity.');
  timestamp(now);
  const approval = await readWorkflowEffectApprovalRecordExact(
    resolveWorkflowEffectApprovalRoot(workspaceRoot),
    runId,
    approvalId,
  );
  if (
    !approval ||
    approval.status !== 'pending' ||
    Date.parse(approval.expiresAt) <= Date.parse(now)
  ) {
    throw new Error('The exact pending human approval is missing, expired or already decided.');
  }
  return Object.freeze({
    runId: approval.runId,
    approvalId: approval.approvalId,
    correlationId: approval.correlationId,
    workflowId: approval.workflowId,
    workflowHash: approval.workflowHash,
    inputHash: approval.inputHash,
    effectId: approval.effectId,
    effectHash: approval.effectHash,
    requiredCapability: approval.requiredCapability,
    expiresAt: approval.expiresAt,
    executionAllowed: false as const,
    blocker: preparationStatus().blocker,
    humanDecisionRequired: true as const,
  });
}
