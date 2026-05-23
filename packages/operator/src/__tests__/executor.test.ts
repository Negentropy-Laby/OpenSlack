import { describe, it, expect } from 'vitest';
import { executePlan } from '../executor.js';
import { planActions } from '../planner.js';
import { parseIntent } from '../intent.js';

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
    const intent = parseIntent('merge PR #12');
    const plan = planActions(intent);
    const result = await executePlan(plan, {
      confirmStep: async () => false,
    });
    expect(result.status).toBe('cancelled');
  });

  it('produces a plan ID', async () => {
    const intent = parseIntent('check status');
    const plan = planActions(intent);
    const result = await executePlan(plan, { dryRun: true });
    expect(result.planId).toMatch(/^PLAN-\d{8}-\d{4}$/);
  });
});
