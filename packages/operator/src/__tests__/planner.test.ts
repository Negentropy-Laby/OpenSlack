import { describe, it, expect } from 'vitest';
import { planActions } from '../planner.js';
import { parseIntent } from '../intent.js';

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
