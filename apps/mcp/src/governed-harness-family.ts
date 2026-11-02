import { fileURLToPath } from 'node:url';
import { authorizeAgentAction, type AgentPermissionSnapshot } from '@openslack/kernel';
import type { HarnessTaskHost } from '@openslack/agent-runtime/internal/harness';
import { HARNESS_WORKFLOW_BUILD_SOURCE_PATH, executeHarnessWorkflow, harnessWorkflowEntries,
  observeHarnessWorkflow, restoreHarnessWorkflow } from './harness-workflow.js';
import type { GovernedWorkflowFamily } from './governed-workflow-family.js';
import { OpenSlackMcpToolError } from './errors.js';
import { createHarnessConfirmationObserver, GOVERNED_CONFIRMATION_SOURCE } from './governed-confirmation.js';

/** Only construction filters capability; every later boundary authorizes again. */
export function createHarnessWorkflowFamily(host: HarnessTaskHost, snapshot: AgentPermissionSnapshot): GovernedWorkflowFamily | undefined {
  const roles = host.governanceBinding().targets;
  const entries = harnessWorkflowEntries().filter(entry => roles.includes(entry.id) &&
    authorizeAgentAction({ snapshot, action: entry.id, riskZone: 'yellow' }).decision === 'allow');
  if (!entries.length) return undefined;
  return Object.freeze({ id: 'harness-task', description: 'Admit an approved Harness task or record progress for the bound task only.',
    entries: Object.freeze(entries), buildSources: Object.freeze([fileURLToPath(import.meta.url), HARNESS_WORKFLOW_BUILD_SOURCE_PATH, GOVERNED_CONFIRMATION_SOURCE]),
    confirmationObserver: service => createHarnessConfirmationObserver(host, service),
    authorize(current, entry) {
      if (authorizeAgentAction({ snapshot: current, action: entry.id, riskZone: 'yellow' }).decision !== 'allow') {
        throw new OpenSlackMcpToolError('GOVERNED_ACTION_NOT_AUTHORIZED', 'Harness action is not authorized.', 'blocked');
      }
    },
    restore: restoreHarnessWorkflow,
    async observe(plan) { return { subject: await observeHarnessWorkflow(host, plan), sources: {}, stores: {} }; },
    async compile(plan) {
      const observed = await observeHarnessWorkflow(host, plan);
      return { kind: 'workflow.start', goal: plan.workflow.id === 'harness.task.dispatch'
        ? 'Admit an approved Harness task; acceptance remains pending.' : 'Record current-task progress only.',
      input: { workflowId: plan.workflow.id, normalizedInput: plan.normalizedInput },
      actions: [{ actionId: plan.workflow.executorId, input: { workflowPlan: plan } }],
      effects: [{ type: 'workflow.start', summary: `Run reviewed target ${plan.workflow.id}.`, risk: plan.risk, target: String(observed.taskId) }] };
    },
    execute: (plan, context) => executeHarnessWorkflow(host, plan, context),
  } satisfies GovernedWorkflowFamily);
}
