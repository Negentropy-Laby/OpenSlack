import { describe, it, expect, vi } from 'vitest';
import { executePlan } from '../executor.js';
import { planActions } from '../planner.js';
import { parseIntent } from '../intent.js';
import {
  createActionRegistry,
  createRegisteredStep,
  listRegisteredActions,
  type PluginActionId,
  type RegisteredAction,
} from '../tool-registry.js';
import type { ActionPlan, PlanStep } from '../types.js';
import type { AgentPermissionSnapshot } from '@openslack/kernel';

function makeSnapshot(overrides: Partial<AgentPermissionSnapshot['permissions']> = {}): AgentPermissionSnapshot {
  return {
    principal: {
      registry_id: 'test_agent',
      runtime_uid: 'uid-001',
      run_id: 'RUN-001',
      provider: 'cli',
    },
    registry_entry_agent_id: 'test_agent',
    permissions: {
      paths: { allow: ['**'], deny: [] },
      actions: { 'status.show': 'allow' },
      github: { can_create_pr: true, can_comment: true, can_approve: false, can_merge: false },
      max_risk_zone: 'yellow',
      ...overrides,
    },
    resolved_at: new Date().toISOString(),
    source: 'registry_v2',
  };
}

function makePlan(step: PlanStep, overrides: Partial<ActionPlan> = {}): ActionPlan {
  return {
    goal: 'Test execution',
    intent: { kind: 'status', slots: {}, confidence: 1 },
    steps: [step],
    riskLevel: 'none',
    missingParams: [],
    requiresConfirmation: step.confirmationRequired,
    sideEffects: step.confirmationRequired,
    ...overrides,
  };
}

function pluginPackageAction(id: PluginActionId): RegisteredAction<PluginActionId> {
  return {
    id,
    description: 'Test package action',
    inputSchema: {},
    riskLevel: 'none',
    sideEffects: false,
    confirmationRequired: false,
    build: (input, stepId) => ({
      id: stepId,
      actionId: id,
      input,
      tool: 'package-api',
      command: 'test-package-action',
      args: [],
      description: 'Test package action',
      confirmationRequired: false,
    }),
    match: (step) => step.command === 'test-package-action' && step.args.length === 0,
  };
}

describe('executePlan', () => {
  it('blocks when missing params', async () => {
    const intent = parseIntent('sync issue #12');
    const plan = planActions(intent);
    const result = await executePlan(plan);
    expect(result.status).toBe('blocked');
    expect(result.summary).toContain('Missing required parameters');
  });

  it('dry-run returns skipped steps', async () => {
    const intent = parseIntent('check status');
    const plan = planActions(intent);
    const result = await executePlan(plan, { dryRun: true });
    expect(result.status).toBe('success');
    expect(result.steps.length).toBe(1);
    expect(result.steps[0].status).toBe('skipped');
    expect(result.steps[0].output).toContain('dry-run');
  });

  it('cancels when confirmStep returns false', async () => {
    const plan = makePlan(createRegisteredStep('pr.merge', { prNumber: 198 }, 's1'));
    const result = await executePlan(plan, {
      confirmStep: async () => false,
    });
    expect(result.status).toBe('cancelled');
    expect(result.steps[0].status).toBe('skipped');
    expect(result.steps[0].output).toBe('Cancelled by user');
  });

  it('produces a plan ID', async () => {
    const intent = parseIntent('check status');
    const plan = planActions(intent);
    const result = await executePlan(plan, { dryRun: true });
    expect(result.planId).toMatch(/^PLAN-\d{8}-\d{4}$/);
  });

  it('rejects unregistered raw command steps', async () => {
    const plan: ActionPlan = {
      goal: 'Raw shell',
      intent: { kind: 'unknown', slots: {}, confidence: 0 },
      steps: [
        { id: 's1', tool: 'openslack-cli', command: 'shell', args: ['rm', '-rf', '.'], description: 'Raw shell', confirmationRequired: false },
      ],
      riskLevel: 'high',
      missingParams: [],
      requiresConfirmation: false,
      sideEffects: true,
    };

    const result = await executePlan(plan, { dryRun: true });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Rejected unregistered action');
  });

  it('blocks ask authorization when no confirmation callback is available', async () => {
    const plan = makePlan(createRegisteredStep('status.show', {}, 's1'));

    const result = await executePlan(plan, {
      snapshot: makeSnapshot({ actions: { 'status.show': 'ask' } }),
    });

    expect(result.status).toBe('blocked');
    expect(result.summary).toContain('Authorization requires confirmation');
    expect(result.steps[0].status).toBe('skipped');
  });

  it('cancels ask authorization when confirmation is rejected', async () => {
    const plan = makePlan(createRegisteredStep('status.show', {}, 's1'));

    const result = await executePlan(plan, {
      snapshot: makeSnapshot({ actions: { 'status.show': 'ask' } }),
      confirmStep: async () => false,
    });

    expect(result.status).toBe('cancelled');
    expect(result.summary).toContain('Cancelled authorization');
    expect(result.steps[0].output).toBe('Authorization cancelled by user');
  });

  it('continues to execution after ask authorization is accepted', async () => {
    const pluginId: PluginActionId = 'plugin:test:package-status';
    const registry = createActionRegistry([
      ...listRegisteredActions(),
      pluginPackageAction(pluginId),
    ]);
    const plan = makePlan(registry.createStep(pluginId, {}, 's1'));

    const result = await executePlan(plan, {
      snapshot: makeSnapshot({ actions: { [pluginId]: 'ask' } }),
      confirmStep: async () => true,
    }, registry);

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Failed at step');
    expect(result.steps[0].output).toContain('Unsupported tool');
  });


  it('passes changed paths and derived risk to authorization', async () => {
    const plan = makePlan(createRegisteredStep('task.sync', {
      issueNumber: 12,
      agentId: 'test_agent',
      paths: 'packages/kernel/src/index.ts',
    }, 's1'), {
      goal: 'Sync protected path',
      intent: { kind: 'sync_task', slots: {}, confidence: 1 },
      riskLevel: 'medium',
      sideEffects: true,
    });

    const result = await executePlan(plan, {
      snapshot: makeSnapshot({ actions: { 'task.sync': 'allow' }, max_risk_zone: 'yellow' }),
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Action requires "red" zone');
  });

  it('rejects an actionless known command before authorization or callbacks', async () => {
    const onStepStart = vi.fn();
    const canonical = createRegisteredStep('status.show', {}, 's1');
    const plan = makePlan({ ...canonical, actionId: undefined, input: undefined });

    const result = await executePlan(plan, {
      snapshot: makeSnapshot(),
      onStepStart,
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Rejected unregistered action');
    expect(onStepStart).not.toHaveBeenCalled();
  });

  it('rejects split input/args authority before authorization or confirmation', async () => {
    const confirmStep = vi.fn(async () => true);
    const onStepStart = vi.fn();
    const canonical = createRegisteredStep('task.sync', {
      issueNumber: 12,
      agentId: 'test_agent',
      paths: 'docs/README.md',
    }, 's1');
    const plan = makePlan({
      ...canonical,
      args: canonical.args.map((arg) => arg === 'docs/README.md'
        ? 'packages/kernel/src/index.ts'
        : arg),
    });

    const result = await executePlan(plan, {
      snapshot: makeSnapshot({ actions: { 'task.sync': 'allow' } }),
      confirmStep,
      onStepStart,
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Rejected unregistered action');
    expect(confirmStep).not.toHaveBeenCalled();
    expect(onStepStart).not.toHaveBeenCalled();
  });

  it('passes an immutable canonical step to confirmation callbacks', async () => {
    const plan = makePlan(createRegisteredStep('pr.merge', { prNumber: 198 }, 's1'));
    const confirmStep = vi.fn(async (step: PlanStep) => {
      expect(Object.isFrozen(step)).toBe(true);
      expect(Object.isFrozen(step.args)).toBe(true);
      expect(Object.isFrozen(step.input)).toBe(true);
      expect(Reflect.set(step, 'confirmationRequired', false)).toBe(false);
      expect(Reflect.set(step.args, '0', 'status')).toBe(false);
      return false;
    });

    const result = await executePlan(plan, { confirmStep });

    expect(result.status).toBe('cancelled');
    expect(confirmStep).toHaveBeenCalledOnce();
  });

  it('passes immutable canonical steps to lifecycle callbacks', async () => {
    const pluginId: PluginActionId = 'plugin:test:immutable-step';
    const registry = createActionRegistry([
      ...listRegisteredActions(),
      pluginPackageAction(pluginId),
    ]);
    const plan = makePlan(registry.createStep(pluginId, {}, 's1'));
    const onStepStart = vi.fn((step: PlanStep) => {
      expect(Object.isFrozen(step)).toBe(true);
      expect(Reflect.set(step, 'tool', 'openslack-cli')).toBe(false);
      expect(Reflect.set(step.args, '0', '--bypass')).toBe(false);
    });

    const result = await executePlan(plan, { onStepStart }, registry);

    expect(result.status).toBe('failed');
    expect(result.steps[0].output).toContain('Unsupported tool: package-api');
    expect(onStepStart).toHaveBeenCalledOnce();
  });

  it('uses only the explicitly supplied registry instance for execution', async () => {
    const pluginId: PluginActionId = 'plugin:test:isolated-execution';
    const registryA = createActionRegistry([
      ...listRegisteredActions(),
      pluginPackageAction(pluginId),
    ]);
    const registryB = createActionRegistry(listRegisteredActions());
    const plan = makePlan(registryA.createStep(pluginId, {}, 's1'));

    const accepted = await executePlan(plan, { dryRun: true }, registryA);
    const isolated = await executePlan(plan, { dryRun: true }, registryB);

    expect(accepted.status).toBe('success');
    expect(isolated.status).toBe('failed');
    expect(isolated.summary).toContain('Rejected unregistered action');
  });
});
