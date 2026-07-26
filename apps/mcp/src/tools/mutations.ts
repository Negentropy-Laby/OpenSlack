import {
  createOpenSlackMcpResult,
  type OpenSlackMcpResult,
  type OpenSlackMcpRisk,
} from '@openslack/qoder-adapter';
import type { GovernedPlanPreview, GovernedPlanRecord } from '@openslack/operator';
import type {
  OpenSlackGovernedMutationInvocation,
  OpenSlackGovernedMutationPort,
} from '../mutations.js';

export interface GovernedMutationToolResult {
  readonly result: OpenSlackMcpResult;
  readonly correlationId: string;
  readonly planHash?: string;
  readonly confirmationToken?: string;
  readonly confirmationActionIds?: readonly string[];
}

function maxRisk(record: GovernedPlanRecord): Exclude<OpenSlackMcpRisk, 'none'> {
  let risk: Exclude<OpenSlackMcpRisk, 'none'> = 'low';
  for (const effect of record.canonicalPlan.effects) {
    if (effect.risk === 'high') return 'high';
    if (effect.risk === 'medium') risk = 'medium';
  }
  return risk;
}

function planEvidence(record: GovernedPlanRecord): readonly string[] {
  const refs = [
    `plan:${record.planId}`,
    ...(record.execution?.outcomes.flatMap((outcome) => [...outcome.evidenceRefs]) ?? []),
  ];
  return Object.freeze([...new Set(refs)]);
}

function previewData(record: GovernedPlanRecord): Readonly<Record<string, unknown>> {
  return Object.freeze({
    kind: record.canonicalPlan.kind,
    goal: record.canonicalPlan.goal,
    input: record.canonicalPlan.input,
    actions: record.canonicalPlan.actions.map((action) =>
      Object.freeze({ actionId: action.actionId }),
    ),
    effects: record.canonicalPlan.effects,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  });
}

function previewResult(preview: GovernedPlanPreview): GovernedMutationToolResult {
  const { record } = preview;
  const confirmActionId = `confirm:${record.planId}`;
  const result = createOpenSlackMcpResult({
    status: 'needs_confirmation',
    summary: `Previewed immutable ${record.canonicalPlan.kind} plan with ${record.canonicalPlan.effects.length} governed effect(s).`,
    data: previewData(record),
    governance: {
      risk: maxRisk(record),
      approvalRequired: true,
      approvalKind: 'openslack_confirm',
      owner: record.bindings.actorId,
    },
    nextActions: [
      {
        id: confirmActionId,
        label: 'Confirm this immutable OpenSlack plan',
        tool: 'openslack_confirm_plan',
        arguments: { planId: record.planId },
      },
      {
        id: `cancel:${record.planId}`,
        label: 'Cancel this pending OpenSlack plan',
        tool: 'openslack_cancel_plan',
        arguments: { planId: record.planId },
      },
    ],
    evidenceRefs: planEvidence(record),
    planId: record.planId,
  });
  return Object.freeze({
    result,
    correlationId: record.bindings.correlationId,
    planHash: record.bindings.planHash,
    confirmationToken: preview.confirmationToken,
    confirmationActionIds: Object.freeze([confirmActionId]),
  });
}

export function governedMutationRecordResult(
  record: GovernedPlanRecord,
): GovernedMutationToolResult {
  const state = record.state;
  const status = state === 'succeeded' ? 'completed' : state === 'failed' ? 'failed' : 'blocked';
  const blocker =
    state === 'reconciliation_required'
      ? 'GOVERNED_MUTATION_RECONCILIATION_REQUIRED'
      : state === 'blocked'
        ? (record.execution?.blocker ?? 'GOVERNED_MUTATION_BLOCKED')
        : state === 'failed'
          ? (record.execution?.failure ?? 'GOVERNED_MUTATION_FAILED')
          : state === 'cancelled'
            ? 'GOVERNED_PLAN_CANCELLED'
            : state === 'expired'
              ? 'GOVERNED_PLAN_EXPIRED'
              : state === 'executing'
                ? 'GOVERNED_MUTATION_EXECUTION_ACTIVE'
                : undefined;
  const result = createOpenSlackMcpResult({
    status,
    summary:
      state === 'succeeded'
        ? `Governed ${record.canonicalPlan.kind} plan completed.`
        : state === 'cancelled'
          ? `Governed ${record.canonicalPlan.kind} plan was cancelled before execution.`
          : state === 'reconciliation_required' || state === 'executing'
            ? `Governed ${record.canonicalPlan.kind} execution has an uncertain outcome and requires reconciliation.`
            : `Governed ${record.canonicalPlan.kind} plan ended in ${state}.`,
    data: {
      state,
      kind: record.canonicalPlan.kind,
      revision: record.revision,
      outcomes: record.execution?.outcomes ?? [],
    },
    governance: {
      risk: maxRisk(record),
      approvalRequired: false,
      owner: record.bindings.actorId,
      ...(blocker ? { blocker } : {}),
    },
    evidenceRefs: planEvidence(record),
    planId: record.planId,
    ...(record.execution ? { executionId: record.execution.executionId } : {}),
    ...(state === 'failed'
      ? {
          error: {
            code: 'GOVERNED_MUTATION_FAILED',
            message: 'The governed action executor returned a trusted failed outcome.',
          },
        }
      : {}),
  });
  return Object.freeze({
    result,
    correlationId: record.bindings.correlationId,
    planHash: record.bindings.planHash,
  });
}

export async function callGovernedMutationTool(
  port: OpenSlackGovernedMutationPort,
  name:
    | 'openslack_preview_scenario'
    | 'openslack_preview_workflow'
    | 'openslack_confirm_plan'
    | 'openslack_cancel_plan',
  input: Readonly<Record<string, unknown>>,
  invocation: OpenSlackGovernedMutationInvocation,
): Promise<GovernedMutationToolResult> {
  if (name === 'openslack_preview_scenario') {
    return previewResult(await port.previewScenario(input, invocation));
  }
  if (name === 'openslack_preview_workflow') {
    return previewResult(await port.previewWorkflow(input, invocation));
  }
  if (name === 'openslack_cancel_plan') {
    return governedMutationRecordResult(await port.cancel(input, invocation));
  }
  try {
    return governedMutationRecordResult(await port.confirm(input, invocation));
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      (error as { readonly code?: unknown }).code === 'GOVERNED_PLAN_EXECUTION_ABORTED' &&
      typeof input.planId === 'string'
    ) {
      const durable = await port.get(input.planId);
      if (durable?.state === 'reconciliation_required' || durable?.state === 'executing') {
        return governedMutationRecordResult(durable);
      }
    }
    throw error;
  }
}
