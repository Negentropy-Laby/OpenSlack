import { afterEach, describe, expect, it } from 'vitest';
import { handleAction } from '../actions.js';
import { createPendingPlan, deletePendingPlan, loadPendingPlan } from '../plan-store.js';
import { routeMessage } from '../router.js';
import type { ChatMessage, GatewayConfig } from '../types.js';

const createdPlans: string[] = [];

function makeMessage(text: string, userId = 'U123', channelId = 'C456', threadId?: string): ChatMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    text,
    user: { id: userId },
    channel: { id: channelId, type: 'webhook' },
    threadId,
    timestamp: new Date().toISOString(),
  };
}

function makePlan(params: Partial<Parameters<typeof createPendingPlan>[0]> = {}) {
  const plan = createPendingPlan({
    actorId: 'U123',
    channelId: 'C456',
    action: 'cancel',
    value: 'test',
    riskLevel: 'low',
    ...params,
  });
  createdPlans.push(plan.planId);
  return plan;
}

afterEach(() => {
  for (const planId of createdPlans.splice(0)) {
    deletePendingPlan(planId);
  }
});

describe('chat action pending-plan authorization', () => {
  it('does not let a different actor cancel a pending plan', async () => {
    const plan = makePlan({ action: 'cancel' });

    const response = await handleAction(makeMessage(`action:cancel:${plan.planId}`, 'U999'));

    expect(response?.text).toContain('different user');
    expect(loadPendingPlan(plan.planId)).not.toBeNull();
  });

  it('lets the creating actor cancel a pending plan', async () => {
    const plan = makePlan({ action: 'cancel' });

    const response = await handleAction(makeMessage(`action:cancel:${plan.planId}`));

    expect(response?.text).toBe('Cancelled.');
    expect(loadPendingPlan(plan.planId)).toBeNull();
  });

  it('does not let a different channel approve a pending plan', async () => {
    const plan = makePlan({ action: 'approve_plan' });

    const response = await handleAction(makeMessage(`action:approve_plan:${plan.planId}`, 'U123', 'C999'));

    expect(response?.text).toContain('different channel');
    expect(loadPendingPlan(plan.planId)).not.toBeNull();
  });

  it('does not claim chat approval executes a plan', async () => {
    const plan = makePlan({ action: 'approve_plan' });

    const response = await handleAction(makeMessage(`action:approve_plan:${plan.planId}`));

    expect(response?.text).toContain('does not execute');
    expect(loadPendingPlan(plan.planId)).not.toBeNull();
  });

  it('rejects approve_plan for non-approve actions without deleting the plan', async () => {
    const plan = makePlan({ action: 'confirm_merge', value: '42', riskLevel: 'high' });

    const response = await handleAction(makeMessage(`action:approve_plan:${plan.planId}`));

    expect(response?.text).toContain('cannot be approved with this chat action');
    expect(loadPendingPlan(plan.planId)).not.toBeNull();
  });

  it('blocks unmapped read-only actors from cancelling through the router', async () => {
    const plan = makePlan({ actorId: 'U999', channelId: 'C999', action: 'cancel' });
    const config: GatewayConfig = { readOnlyByDefault: true };

    const response = await routeMessage(
      makeMessage(`action:cancel:${plan.planId}`, 'U999', 'C999'),
      config,
      { payload: '{}' },
    );

    expect(response.text).toContain('requires a mapped chat user with write permission');
    expect(loadPendingPlan(plan.planId)).not.toBeNull();
  });
});
