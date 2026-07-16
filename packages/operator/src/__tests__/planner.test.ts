import { describe, it, expect, vi } from 'vitest';
import { planActions } from '../planner.js';
import { parseIntent } from '../intent.js';
import {
  BUILTIN_ACTION_REGISTRY,
  type ActionRegistryPort,
} from '../tool-registry.js';

describe('planActions', () => {
  it('plans status with no confirmation needed', () => {
    const intent = parseIntent('check status');
    const plan = planActions(intent);
    expect(plan.goal).toBe('Check OpenSlack status');
    expect(plan.steps.length).toBe(1);
    expect(plan.riskLevel).toBe('none');
    expect(plan.requiresConfirmation).toBe(false);
    expect(plan.missingParams.length).toBe(0);
  });

  it('plans PR doctor', () => {
    const intent = parseIntent('doctor PR #12');
    const plan = planActions(intent);
    expect(plan.goal).toBe('Diagnose PR #12');
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].command).toBe('pr');
    expect(plan.steps[0].args).toEqual(['doctor', '12']);
    expect(plan.riskLevel).toBe('none');
  });

  it('plans PR merge with high risk', () => {
    const intent = parseIntent('merge PR #12');
    const plan = planActions(intent);
    expect(plan.goal).toBe('Merge PR #12');
    expect(plan.steps.length).toBe(2);
    expect(plan.steps[0].command).toBe('pr');
    expect(plan.steps[0].args).toEqual(['doctor', '12']);
    expect(plan.steps[1].command).toBe('pr');
    expect(plan.steps[1].args).toEqual(['merge', '12']);
    expect(plan.steps[1].confirmationRequired).toBe(true);
    expect(plan.riskLevel).toBe('high');
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.sideEffects).toBe(true);
  });

  it('uses an explicit action registry without changing built-in planning', () => {
    const intent = parseIntent('merge PR #12');
    const createStep = vi.fn(BUILTIN_ACTION_REGISTRY.createStep.bind(BUILTIN_ACTION_REGISTRY));
    const registry: ActionRegistryPort = {
      list: () => BUILTIN_ACTION_REGISTRY.list(),
      get: (actionId) => BUILTIN_ACTION_REGISTRY.get(actionId),
      createStep,
      revalidateStep: (step) => BUILTIN_ACTION_REGISTRY.revalidateStep(step),
      buildPlanSteps: (goal, intentKind, calls) =>
        BUILTIN_ACTION_REGISTRY.buildPlanSteps(goal, intentKind, calls),
    };

    const baseline = planActions(intent);
    const explicit = planActions(intent, registry);

    expect(explicit).toEqual(baseline);
    expect(createStep.mock.calls.map(([actionId]) => actionId)).toEqual([
      'pr.doctor',
      'pr.merge',
    ]);
  });

  it('identifies missing params for sync', () => {
    const intent = parseIntent('sync issue #12');
    const plan = planActions(intent);
    expect(plan.missingParams.length).toBeGreaterThan(0);
    expect(plan.steps.length).toBe(0);
    const names = plan.missingParams.map((m) => m.name);
    expect(names).toContain('agentId');
    expect(names).toContain('paths');
  });

  it('identifies missing PR number', () => {
    const intent = parseIntent('merge PR');
    const plan = planActions(intent);
    expect(plan.missingParams.length).toBeGreaterThan(0);
    expect(plan.missingParams.some((m) => m.name === 'prNumber')).toBe(true);
  });

  it('plans task creation as a preview with no side effects', () => {
    const intent = parseIntent('create task "Investigate flaky setup"');
    const plan = planActions(intent);
    expect(plan.goal).toBe('Preview task "Investigate flaky setup"');
    expect(plan.steps[0].actionId).toBe('task.create.preview');
    expect(plan.sideEffects).toBe(false);
  });

  it('asks for task title when creating a task without one', () => {
    const intent = parseIntent('create task');
    const plan = planActions(intent);
    expect(plan.missingParams.some((m) => m.name === 'title')).toBe(true);
  });

  it('blocks unallowlisted intents', () => {
    const intent = parseIntent('do something random');
    const plan = planActions(intent);
    expect(plan.steps.length).toBe(0);
  });

  it('plans workflow recommendations without executing them', () => {
    const intent = parseIntent('use a workflow to audit every API endpoint');
    const plan = planActions(intent);
    expect(plan.steps).toEqual([]);
    expect(plan.workflowRecommendation?.decision).toBe('workflow_recommended');
    expect(plan.workflowRecommendation?.suggestedPattern).toBeTruthy();
    expect(plan.workflowRecommendation?.nextAction).toContain('workflow generate');
  });

  it('plans ultracode as a workflow draft requirement', () => {
    const intent = parseIntent('ultracode: root-cause all failing workflow tests');
    const plan = planActions(intent);
    expect(plan.workflowRecommendation?.decision).toBe('workflow_draft_required');
    expect(plan.requiresConfirmation).toBe(false);
  });
});
