import {
  createOpenSlackMcpResult,
  type OpenSlackMcpResult,
  type OpenSlackMcpResultV2,
} from '@openslack/qoder-adapter';
import type { OpenSlackGovernedMutationInvocation } from '../mutations.js';
import type { OpenSlackWorkflowApprovalPort } from '../workflow-approvals.js';
import type { WorkflowEffectApprovalRecord } from '@openslack/workflows';

export interface WorkflowApprovalToolResult {
  readonly result: OpenSlackMcpResult;
  readonly correlationId: string;
  readonly approval: NonNullable<OpenSlackMcpResultV2['approval']>;
}

export function workflowApprovalRecordResult(
  record: WorkflowEffectApprovalRecord,
  auditRecorded = record.auditProjection?.status === 'recorded',
  terminalConflict = false,
): WorkflowApprovalToolResult {
  const pending = record.status === 'pending';
  const auditProjectionFailed = !pending && !auditRecorded;
  const principalId = record.decision?.principalId;
  const result = createOpenSlackMcpResult({
    status: pending ? 'blocked' : terminalConflict ? 'failed' : 'completed',
    summary: pending
      ? 'The workflow-effect decision outcome is uncertain; read the approval record before another decision.'
      : terminalConflict
        ? `The OpenSlack workflow effect already has a different terminal decision; no decision or GitHub review was created by this call.`
        : auditProjectionFailed
          ? `Recorded one ${record.status} OpenSlack workflow-effect decision; its Collaboration audit projection requires reconciliation and no GitHub review was created.`
          : `Recorded one ${record.status} OpenSlack workflow-effect decision; no GitHub review was created.`,
    data: {
      runId: record.runId,
      approvalId: record.approvalId,
      status: record.status,
      revision: record.revision,
      workflowId: record.workflowId,
      workflowVersion: record.workflowVersion,
      effectId: record.effectId,
      decision: record.decision,
      auditProjection:
        record.auditProjection?.status === 'recorded'
          ? 'recorded'
          : record.auditProjection?.status === 'pending'
            ? 'reconciliation_required'
            : 'not_applicable',
    },
    governance: {
      risk: 'medium',
      approvalRequired: pending,
      ...(terminalConflict
        ? {
            blocker: 'WORKFLOW_APPROVAL_ALREADY_TERMINAL',
          }
        : pending
          ? {
              approvalKind: 'openslack_workflow_effect' as const,
              blocker: 'WORKFLOW_APPROVAL_RECONCILIATION_REQUIRED',
            }
          : auditProjectionFailed
            ? {
                blocker: 'WORKFLOW_APPROVAL_AUDIT_PROJECTION_RECONCILIATION_REQUIRED',
              }
            : {}),
      ...(principalId ? { owner: principalId } : {}),
    },
    evidenceRefs: [`workflow-run:${record.runId}`],
  });
  return Object.freeze({
    result,
    correlationId: record.correlationId,
    approval: Object.freeze({
      approvalId: record.approvalId,
      kind: 'openslack_workflow_effect' as const,
      expiresAt: record.expiresAt,
      risk: 'medium' as const,
    }),
  });
}

export async function callWorkflowApprovalTool(
  port: OpenSlackWorkflowApprovalPort,
  input: Readonly<Record<string, unknown>>,
  invocation: OpenSlackGovernedMutationInvocation,
): Promise<WorkflowApprovalToolResult> {
  const { record, auditRecorded, terminalConflict } = await port.decide(input, invocation);
  return workflowApprovalRecordResult(record, auditRecorded, terminalConflict);
}
