import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeAgentAction, type AgentPermissionSnapshot } from '@openslack/kernel';
import { createGovernedActionExecutionRegistry, createGovernedPlanService, LocalGovernedPlanStore } from '@openslack/operator';
import { compileWorkflowStartPlan, rehydrateWorkflowStartPlan, type WorkflowPlanResolverEntry } from '@openslack/workflows';
import { createGovernedWorkflowFamilies, workflowPlanFromActionInput, type GovernedWorkflowFamily } from '../governed-workflow-family.js';
import { createOpenSlackGovernedMutationPort } from '../mutations.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const authority = { actorId: 'fixture', workspaceId: 'fixture' };
const snapshot: AgentPermissionSnapshot = { principal: { registry_id: 'fixture', runtime_uid: 'fixture', run_id: 'RUN-FIXTURE', provider: 'cli' },
  registry_entry_agent_id: 'fixture', permissions: { paths: { allow: [], deny: [] }, actions: { 'fixture.work': 'allow' },
    github: { can_create_pr: false, can_comment: false, can_approve: false, can_merge: false }, max_risk_zone: 'yellow' },
  resolved_at: new Date().toISOString(), source: 'registry_v2' };

function fixture(id = 'fixture.workflow', executorId = 'fixture.execute', adapterId = 'fixture-adapter') {
  const entry: WorkflowPlanResolverEntry = { id, executorId, adapterId, version: '1.0.0', workflowHash: 'a'.repeat(64),
    risk: 'low', capabilityIds: ['fixture.work'], authorityRequirements: [] };
  const execute = vi.fn(async () => ({ status: 'succeeded' as const, summary: 'Fixture complete', data: { fixture: true }, evidenceRefs: [] }));
  const authorize = vi.fn((value: AgentPermissionSnapshot) => {
    if (authorizeAgentAction({ snapshot: value, action: 'fixture.work', riskZone: 'yellow' }).decision !== 'allow') throw new Error('Fixture permission denied');
  });
  const family = Object.freeze({ id: `family-${id}`, entries: Object.freeze([entry]), description: 'Test-only family with unequal target identities', buildSources: [],
    authorize,
    restore: (plan, resolver, binding) => rehydrateWorkflowStartPlan(plan, { resolver, planHash: plan.planHash, actorId: binding.actorId,
      workspaceId: binding.workspaceId, correlationId: binding.correlationId, workflowHash: 'a'.repeat(64), now: new Date().toISOString() }),
    observe: async plan => ({ subject: { planHash: plan.planHash }, sources: { fixture: '1' }, stores: {} }),
    compile: async plan => ({ kind: 'workflow.start', goal: 'Exercise the test-only family port.', input: {},
      actions: [{ actionId: plan.workflow.executorId, input: { workflowPlan: plan } }], effects: [{ type: 'workflow.start', summary: 'Fixture only', risk: plan.risk }] }),
    execute,
  } satisfies GovernedWorkflowFamily);
  return { family, execute, authorize, entry };
}

describe('process-sealed workflow families', () => {
  it('previews, binds, confirms and executes a family whose workflow, executor and adapter IDs all differ', async () => {
    const root = mkdtempSync(join(tmpdir(), 'workflow-family-')); roots.push(root);
    const value = fixture();
    const families = createGovernedWorkflowFamilies([value.family]);
    const registry = createGovernedActionExecutionRegistry(families.executors('b'.repeat(64), () => snapshot));
    const service = createGovernedPlanService({ store: new LocalGovernedPlanStore(join(root, 'plans')), registry, audit: async () => {},
      getBindingSnapshot: async context => {
        const action = context.canonicalPlan.actions[0]!;
        const restored = families.restore(action.input, action.actionId, { ...authority, correlationId: workflowPlanFromActionInput(action.input).correlationId });
        restored.target.family.authorize(snapshot, restored.target.entry);
        return { sourceVersions: await restored.target.family.observe(restored.plan), permissionSnapshot: snapshot, buildNonce: 'fixture-build-0123456789' };
      } });
    const mutations = createOpenSlackGovernedMutationPort({ service, authority, compileScenario: () => { throw new Error('No Scenario fixture port'); },
      compileWorkflow: async ({ compilation }) => {
        const plan = compileWorkflowStartPlan({ resolver: families.resolver, workflowId: value.entry.id, input: { value: 'fixture' },
          ...authority, correlationId: compilation.correlationId, createdAt: compilation.createdAt, expiresAt: compilation.expiresAt, authorityBindings: [] });
        const target = families.workflow(plan.workflow.id)!; target.family.authorize(snapshot, target.entry);
        return target.family.compile(plan);
      } });
    const invocation = { signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10_000).toISOString() };
    const preview = await mutations.previewWorkflow({}, invocation);
    expect(value.execute).not.toHaveBeenCalled();
    const confirmed = await mutations.confirm({ planId: preview.record.planId, confirmationToken: preview.confirmationToken }, invocation);
    expect(confirmed.state).toBe('succeeded');
    expect(value.execute).toHaveBeenCalledOnce();
    expect(value.authorize.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(confirmed.canonicalPlan.actions[0]!.actionId).toBe('fixture.execute');
  });
  it.each(['workflow', 'executor', 'adapter'] as const)('rejects cross-family %s collisions', field => {
    const first = fixture();
    const next = fixture(field === 'workflow' ? first.entry.id : 'fixture.other', field === 'executor' ? first.entry.executorId : 'fixture.other.execute',
      field === 'adapter' ? first.entry.adapterId : 'other-adapter');
    expect(() => createGovernedWorkflowFamilies([first.family, next.family])).toThrow();
  });
  it('allows one family to own multiple targets with the same adapter and retains immutable resolver entries', () => {
    const first = fixture();
    const second = fixture('fixture.other', 'fixture.other.execute');
    const family = Object.freeze({ ...first.family, entries: Object.freeze([first.entry, second.entry]) });
    const families = createGovernedWorkflowFamilies([family]);
    expect(families.workflow(first.entry.id)?.entry.executorId).toBe('fixture.execute');
    expect(families.workflow(second.entry.id)?.entry.executorId).toBe('fixture.other.execute');
    expect(Object.isFrozen(families.workflow(first.entry.id)!.entry)).toBe(true);
    expect(families.workflow('fixture.execute')).toBeUndefined();
  });
  it('rejects a workflow/executor swap before any family effect', async () => {
    const value = fixture(), families = createGovernedWorkflowFamilies([value.family]);
    const plan = compileWorkflowStartPlan({ resolver: families.resolver, workflowId: value.entry.id, input: {}, ...authority,
      correlationId: 'fixture', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), authorityBindings: [] });
    expect(() => families.restore({ workflowPlan: plan } as never, value.entry.id, { ...authority, correlationId: 'fixture' })).toThrow();
    expect(value.execute).not.toHaveBeenCalled();
  });
});
