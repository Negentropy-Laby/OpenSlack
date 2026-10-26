import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { HarnessTaskHost, HarnessTaskReport } from '@openslack/agent-runtime/internal/harness';
import type { WorkflowPlanResolverEntry, WorkflowStartPlan } from '@openslack/workflows';
import type { GovernedActionExecutionContext } from '@openslack/operator';

export const HARNESS_WORKFLOW_BUILD_SOURCE_PATH = fileURLToPath(import.meta.url);
export const HARNESS_WORKFLOW_IDS = ['harness.task.dispatch', 'harness.task.report'] as const;
export type HarnessWorkflowId = typeof HARNESS_WORKFLOW_IDS[number];

export function isHarnessWorkflowId(value: unknown): value is HarnessWorkflowId {
  return value === 'harness.task.dispatch' || value === 'harness.task.report';
}

/** Reviewed orchestration targets. No model-supplied prompts, paths, principals or commands. */
export function harnessWorkflowEntries(): WorkflowPlanResolverEntry[] {
  return HARNESS_WORKFLOW_IDS.map(id => ({
    id, version: '1.0.0', adapterId: 'openslack-harness-task', executorId: id,
    workflowHash: createHash('sha256').update(`openslack.harness_workflow.v1:${id}`).digest('hex'),
    risk: 'medium', capabilityIds: [id], authorityRequirements: [],
  }));
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Inspect sealed input through the task owner at preview, confirmation and effect time. */
export async function observeHarnessWorkflow(host: HarnessTaskHost, plan: WorkflowStartPlan): Promise<Readonly<Record<string, unknown>>> {
  if (!isHarnessWorkflowId(plan.workflow.id) || !record(plan.normalizedInput)) throw new Error('Invalid Harness Workflow plan');
  return host.observe(plan.workflow.id, plan.normalizedInput);
}

/** Admission succeeds independently of business acceptance; report effects cannot set acceptance. */
export async function executeHarnessWorkflow(
  host: HarnessTaskHost,
  plan: WorkflowStartPlan,
  context: GovernedActionExecutionContext,
) {
  await observeHarnessWorkflow(host, plan);
  const input = plan.normalizedInput;
  if (!record(input)) throw new Error('Invalid Harness input');
  if (plan.workflow.id === 'harness.task.dispatch') {
    const receipt = await host.dispatch(String(input.taskId), String(input.requestId), true);
    return {
      status: 'succeeded' as const,
      summary: 'Dispatch effect completed: task admitted. Business completion requires host acceptance.',
      data: { ...receipt }, evidenceRefs: [`plan:${context.planId}`, `run:${receipt.runId}`],
    };
  }
  const report: HarnessTaskReport = {
    runId: String(input.runId), reportId: String(input.reportId), summary: String(input.summary),
    evidenceRefs: input.evidenceRefs as string[],
  };
  const receipt = await host.report(report);
  return { status: 'succeeded' as const, summary: 'Recorded current-task progress; acceptance is unchanged.',
    data: { ...receipt }, evidenceRefs: [`plan:${context.planId}`, `run:${receipt.runId}`] };
}
