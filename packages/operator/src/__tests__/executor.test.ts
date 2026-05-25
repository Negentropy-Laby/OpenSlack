import { describe, it, expect } from 'vitest';
import { executePlan } from '../executor.js';
import { planActions } from '../planner.js';
import { parseIntent } from '../intent.js';
import type { ActionPlan } from '../types.js';
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
    const plan: ActionPlan = {
      goal: 'Test cancellation',
      intent: { kind: 'status', slots: {}, confidence: 1 },
      steps: [
        { id: 's1', tool: 'openslack-cli', command: 'status', args: [], description: 'Check status', confirmationRequired: true },
      ],
      riskLevel: 'none',
      missingParams: [],
      requiresConfirmation: true,
      sideEffects: false,
    };
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
    const plan: ActionPlan = {
      goal: 'Ask authorization',
      intent: { kind: 'status', slots: {}, confidence: 1 },
      steps: [
        { id: 's1', actionId: 'status.show', input: {}, tool: 'openslack-cli', command: 'status', args: [], description: 'Check status', confirmationRequired: false },
      ],
      riskLevel: 'none',
      missingParams: [],
      requiresConfirmation: false,
      sideEffects: false,
    };

    const result = await executePlan(plan, {
      snapshot: makeSnapshot({ actions: { 'status.show': 'ask' } }),
    });

    expect(result.status).toBe('blocked');
    expect(result.summary).toContain('Authorization requires confirmation');
    expect(result.steps[0].status).toBe('skipped');
  });

  it('cancels ask authorization when confirmation is rejected', async () => {
    const plan: ActionPlan = {
      goal: 'Ask authorization',
      intent: { kind: 'status', slots: {}, confidence: 1 },
      steps: [
        { id: 's1', actionId: 'status.show', input: {}, tool: 'openslack-cli', command: 'status', args: [], description: 'Check status', confirmationRequired: false },
      ],
      riskLevel: 'none',
      missingParams: [],
      requiresConfirmation: false,
      sideEffects: false,
    };

    const result = await executePlan(plan, {
      snapshot: makeSnapshot({ actions: { 'status.show': 'ask' } }),
      confirmStep: async () => false,
    });

    expect(result.status).toBe('cancelled');
    expect(result.summary).toContain('Cancelled authorization');
    expect(result.steps[0].output).toBe('Authorization cancelled by user');
  });

  it('continues to execution after ask authorization is accepted', async () => {
    const plan: ActionPlan = {
      goal: 'Ask authorization',
      intent: { kind: 'status', slots: {}, confidence: 1 },
      steps: [
        { id: 's1', actionId: 'status.show', input: {}, tool: 'package-api', command: 'status', args: [], description: 'Check status', confirmationRequired: false },
      ],
      riskLevel: 'none',
      missingParams: [],
      requiresConfirmation: false,
      sideEffects: false,
    };

    const result = await executePlan(plan, {
      snapshot: makeSnapshot({ actions: { 'status.show': 'ask' } }),
      confirmStep: async () => true,
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Failed at step');
    expect(result.steps[0].output).toContain('Unsupported tool');
  });


  it('passes changed paths and derived risk to authorization', async () => {
    const plan: ActionPlan = {
      goal: 'Sync protected path',
      intent: { kind: 'sync_task', slots: {}, confidence: 1 },
      steps: [
        {
          id: 's1',
          actionId: 'task.sync',
          input: { issueNumber: 12, agentId: 'test_agent', paths: 'packages/kernel/src/index.ts' },
          tool: 'openslack-cli',
          command: 'task',
          args: ['sync', '--issue-number', '12', '--agent-id', 'test_agent', '--paths', 'packages/kernel/src/index.ts'],
          description: 'Sync protected path',
          confirmationRequired: true,
        },
      ],
      riskLevel: 'medium',
      missingParams: [],
      requiresConfirmation: true,
      sideEffects: true,
    };

    const result = await executePlan(plan, {
      snapshot: makeSnapshot({ actions: { 'task.sync': 'allow' }, max_risk_zone: 'yellow' }),
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Action requires "red" zone');
  });
});
