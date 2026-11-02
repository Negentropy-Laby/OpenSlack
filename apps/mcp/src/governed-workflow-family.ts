import { fileURLToPath } from 'node:url';
import { hashGovernedValue, type CreateCanonicalGovernedPlanInput, type GovernedActionExecutionContext,
  type GovernedActionExecutorDefinition, type GovernedActionExecutorResult, type GovernedJsonValue,
  type GovernedPlanService } from '@openslack/operator';
import { createSealedWorkflowPlanResolver, type SealedWorkflowPlanResolver, type WorkflowPlanResolverEntry,
  type WorkflowStartPlan } from '@openslack/workflows';
import type { AgentPermissionSnapshot } from '@openslack/kernel';
import { OpenSlackMcpToolError } from './errors.js';
import type { CreateOpenSlackGovernedMutationPortOptions } from './mutations.js';

export const WORKFLOW_FAMILY_REGISTRY_SOURCE = fileURLToPath(import.meta.url);
export interface WorkflowFamilyAuthority { actorId: string; workspaceId: string; correlationId: string }
export interface WorkflowFamilyObservation {
  readonly subject: Readonly<Record<string, unknown>>;
  readonly sources: Readonly<Record<string, unknown>>;
  readonly stores: Readonly<Record<string, unknown>>;
}

/** Private host port. Concrete dependencies are captured by each enabled factory. */
export interface GovernedWorkflowFamily {
  readonly id: string;
  readonly description: string;
  readonly entries: readonly WorkflowPlanResolverEntry[];
  readonly buildSources: readonly string[];
  confirmationObserver?(service: GovernedPlanService): NonNullable<CreateOpenSlackGovernedMutationPortOptions['onConfirmationSettled']>;
  authorize(snapshot: AgentPermissionSnapshot, entry: WorkflowPlanResolverEntry): void;
  restore(plan: WorkflowStartPlan, resolver: SealedWorkflowPlanResolver, authority: WorkflowFamilyAuthority): WorkflowStartPlan;
  observe(plan: WorkflowStartPlan): Promise<WorkflowFamilyObservation>;
  compile(plan: WorkflowStartPlan): Promise<CreateCanonicalGovernedPlanInput>;
  execute(plan: WorkflowStartPlan, context: GovernedActionExecutionContext): Promise<GovernedActionExecutorResult>;
}

export function workflowPlanFromActionInput(value: GovernedJsonValue): WorkflowStartPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).join(',') !== 'workflowPlan' || !('workflowPlan' in value) ||
    !value.workflowPlan || typeof value.workflowPlan !== 'object' || Array.isArray(value.workflowPlan)) return changed();
  return value.workflowPlan as unknown as WorkflowStartPlan;
}

function changed(): never {
  throw new OpenSlackMcpToolError('GOVERNED_WORKFLOW_BINDING_CHANGED', 'The sealed Workflow family or target binding changed.', 'blocked');
}

/** No post-construction registration or mutable Maps escape this process-local seal. */
export function createGovernedWorkflowFamilies(input: readonly GovernedWorkflowFamily[]) {
  const workflows = new Map<string, Readonly<{ family: GovernedWorkflowFamily; entry: WorkflowPlanResolverEntry }>>();
  const executors = new Map<string, Readonly<{ family: GovernedWorkflowFamily; entry: WorkflowPlanResolverEntry }>>();
  const adapters = new Map<string, GovernedWorkflowFamily>();
  const ids = new Set<string>();
  const families = Object.freeze([...input]);
  const resolver = createSealedWorkflowPlanResolver({ entries: families.flatMap(family => [...family.entries]) });
  for (const family of families) {
    if (ids.has(family.id) || !family.entries.length || !Object.isFrozen(family)) throw new TypeError('Workflow family registration is ambiguous or unsealed');
    ids.add(family.id);
    for (const configured of family.entries) {
      const entry = resolver.resolve(configured.id)!;
      if (workflows.has(entry.id) || executors.has(entry.executorId) ||
        (adapters.has(entry.adapterId) && adapters.get(entry.adapterId) !== family)) throw new TypeError('Workflow family identity collision');
      const target = Object.freeze({ family, entry });
      workflows.set(entry.id, target); executors.set(entry.executorId, target); adapters.set(entry.adapterId, family);
    }
  }
  const workflow = (id: string) => workflows.get(id);
  const restore = (input: GovernedJsonValue, executorId: string, authority: WorkflowFamilyAuthority) => {
    const plan = workflowPlanFromActionInput(input);
    const target = workflows.get(plan.workflow?.id);
    const executor = executors.get(executorId);
    if (!target || executor !== target || adapters.get(plan.workflow.adapterId) !== target.family ||
      hashGovernedValue(plan.workflow) !== hashGovernedValue(target.entry) || plan.effect?.executorId !== executorId) return changed();
    const binding = Object.freeze({ actorId: authority.actorId, workspaceId: authority.workspaceId, correlationId: authority.correlationId });
    return Object.freeze({ target, plan: target.family.restore(plan, resolver, binding) });
  };
  return Object.freeze({
    resolver, workflow,
    buildSources: Object.freeze([...new Set([WORKFLOW_FAMILY_REGISTRY_SOURCE, ...families.flatMap(family => [...family.buildSources])])]),
    restore,
    confirmationObserver(service: GovernedPlanService): CreateOpenSlackGovernedMutationPortOptions['onConfirmationSettled'] {
      const observers = families.flatMap(family => family.confirmationObserver ? [family.confirmationObserver(service)] : []);
      return observers.length ? async (planId, outcome) => {
        for (const observer of observers) await observer(planId, outcome);
      } : undefined;
    },
    executors(buildHash: string, currentSnapshot: () => AgentPermissionSnapshot): GovernedActionExecutorDefinition[] {
      return [...executors.values()].map(({ family, entry }) => ({ actionId: entry.executorId, version: entry.version,
        bindingId: `${family.id}:v1:${buildHash.slice(0, 32)}:${entry.id}`, description: family.description,
        async execute(input, context) {
          family.authorize(currentSnapshot(), entry);
          const restored = restore(input, entry.executorId, context);
          return family.execute(restored.plan, context);
        },
      }));
    },
  });
}
