import { describe, it, expect } from 'vitest';
import {
  buildPRCard,
  buildTaskCard,
  buildHandoffCard,
  buildDecisionCard,
  buildWorkflowCard,
  buildPlanCard,
  toSlackBlocks,
  cardToText,
} from '../cards.js';
import type { PRChatSummary } from '@openslack/pr';
import type { Handoff, Decision, WorkflowPreview } from '@openslack/collaboration';
import type { ActionPlan } from '@openslack/operator';

describe('buildPRCard', () => {
  it('builds card for ready PR with confirm merge button', () => {
    const summary: PRChatSummary = {
      prNumber: 12,
      title: 'Fix validation',
      decision: 'READY_TO_MERGE',
      canMerge: true,
      why: 'All passed.',
      next: 'Safe to merge.',
      zone: 'green',
    };
    const card = buildPRCard(summary);

    expect(card.title).toBe('PR #12 — Fix validation');
    expect(card.summary).toContain('Ready to merge');
    expect(card.fields).toContainEqual({ label: 'Zone', value: 'green' });
    expect(card.fields).toContainEqual({ label: 'Status', value: 'Ready to merge' });
    expect(card.actions).toHaveLength(1);
    expect(card.actions[0].id).toBe('merge');
    expect(card.actions[0].action).toBe('confirm_merge');
    expect(card.actions[0].style).toBe('primary');
    expect(card.actions[0].value).toBe('12');
  });

  it('builds card for blocked PR with doctor and watch buttons', () => {
    const summary: PRChatSummary = {
      prNumber: 12,
      title: 'Fix validation',
      decision: 'NEEDS_HUMAN_APPROVAL',
      canMerge: false,
      blocker: 'Missing valid human approval',
      why: 'No approval.',
      next: 'Request review.',
      zone: 'yellow',
    };
    const card = buildPRCard(summary);

    expect(card.summary).toContain('Cannot merge');
    expect(card.fields).toContainEqual({ label: 'Blocker', value: 'Missing valid human approval' });
    expect(card.actions).toHaveLength(2);
    expect(card.actions[0].action).toBe('show_doctor');
    expect(card.actions[1].action).toBe('watch_pr');
  });
});

describe('toSlackBlocks', () => {
  it('converts card to Slack Block Kit format', () => {
    const summary: PRChatSummary = {
      prNumber: 12,
      title: 'Fix validation',
      decision: 'READY_TO_MERGE',
      canMerge: true,
      why: 'All passed.',
      next: 'Safe to merge.',
      zone: 'green',
    };
    const card = buildPRCard(summary);
    const blocks = toSlackBlocks(card);

    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks.length).toBeGreaterThanOrEqual(2);

    const header = blocks[0] as { type: string; text: { type: string; text: string } };
    expect(header.type).toBe('section');
    expect(header.text.text).toContain('PR #12');

    const actions = blocks[blocks.length - 1] as {
      type: string;
      elements: Array<{ type: string; action_id: string }>;
    };
    expect(actions.type).toBe('actions');
    expect(actions.elements[0].action_id).toBe('confirm_merge:12');
  });

  it('converts blocked card with no actions if empty', () => {
    const card = {
      title: 'Test',
      summary: 'Summary',
      fields: [],
      actions: [],
    };
    const blocks = toSlackBlocks(card);
    expect(blocks.length).toBe(1);
  });
});

describe('cardToText', () => {
  it('produces plain text from card', () => {
    const summary: PRChatSummary = {
      prNumber: 12,
      title: 'Fix validation',
      decision: 'READY_TO_MERGE',
      canMerge: true,
      why: 'All passed.',
      next: 'Safe to merge.',
      zone: 'green',
    };
    const card = buildPRCard(summary);
    const text = cardToText(card);
    expect(text).toContain('PR #12 — Fix validation');
    expect(text).toContain('Ready to merge');
  });
});

describe('buildTaskCard', () => {
  it('builds card with preview and claim actions', () => {
    const card = buildTaskCard({ issueNumber: 42, title: 'Fix setup', status: 'open' });
    expect(card.title).toContain('#42');
    expect(card.title).toContain('Fix setup');
    expect(card.actions).toHaveLength(2);
    expect(card.actions[0].action).toBe('preview_task');
    expect(card.actions[1].action).toBe('claim_task');
  });

  it('includes assignee and risk when present', () => {
    const card = buildTaskCard({
      issueNumber: 10,
      title: 'Bug',
      status: 'claimed',
      assignee: 'bot_001',
      risk: 'high',
    });
    expect(card.fields).toContainEqual({ label: 'Assignee', value: 'bot_001' });
    expect(card.fields).toContainEqual({ label: 'Risk', value: 'high' });
  });
});

describe('buildHandoffCard', () => {
  const handoff: Handoff = {
    schema: 'openslack.handoff.v1',
    id: 'HANDOFF-20260525-A1B2',
    status: 'open',
    from: 'agent_a',
    to: 'agent_b',
    createdAt: new Date().toISOString(),
    context: 'Review PR before merge',
    nextSteps: ['Run doctor', 'Confirm merge'],
  };

  it('builds card with accept/close for open handoff', () => {
    const card = buildHandoffCard(handoff);
    expect(card.title).toContain('HANDOFF-');
    expect(card.summary).toContain('agent_a');
    expect(card.summary).toContain('agent_b');
    expect(card.actions).toHaveLength(2);
    expect(card.actions[0].action).toBe('accept_handoff');
    expect(card.actions[1].action).toBe('close_handoff');
  });

  it('builds card with no actions for accepted handoff', () => {
    const card = buildHandoffCard({ ...handoff, status: 'accepted' });
    expect(card.actions).toHaveLength(0);
  });
});

describe('buildDecisionCard', () => {
  const decision: Decision = {
    schema: 'openslack.decision.v1',
    id: 'DEC-20260525-C3D4',
    topic: 'Merge strategy',
    decision: 'Squash merge',
    rationale: 'Keeps history clean',
    decidedBy: 'wsman',
    createdAt: new Date().toISOString(),
    status: 'active',
  };

  it('builds card with record alternative action for active decision', () => {
    const card = buildDecisionCard(decision);
    expect(card.title).toContain('DEC-');
    expect(card.summary).toContain('Merge strategy');
    expect(card.actions).toHaveLength(1);
    expect(card.actions[0].action).toBe('record_decision');
  });

  it('builds card with no actions for superseded decision', () => {
    const card = buildDecisionCard({ ...decision, status: 'superseded' });
    expect(card.actions).toHaveLength(0);
  });
});

describe('buildWorkflowCard', () => {
  const preview: WorkflowPreview = {
    templateId: 'release-flow',
    name: 'Release Flow',
    correlationId: 'WF-RELEASE-20260525-A1B2C3',
    steps: [
      {
        phase: 'Build',
        type: 'action',
        title: 'Run tests',
        sideEffects: false,
        requiresConfirmation: false,
      },
      {
        phase: 'Deploy',
        type: 'action',
        title: 'Deploy to prod',
        sideEffects: true,
        requiresConfirmation: true,
      },
    ],
    errors: [],
  };

  it('builds card with execute and cancel actions', () => {
    const card = buildWorkflowCard(preview);
    expect(card.title).toContain('Release Flow');
    expect(card.fields).toContainEqual({ label: 'Steps', value: '2' });
    expect(card.actions).toHaveLength(2);
    expect(card.actions[0].action).toBe('execute_workflow');
    expect(card.actions[1].action).toBe('cancel');
  });

  it('builds card with no actions when errors exist', () => {
    const card = buildWorkflowCard({ ...preview, errors: ['Missing input: version'] });
    expect(card.actions).toHaveLength(0);
    expect(card.fields).toContainEqual({ label: 'Errors', value: 'Missing input: version' });
  });
});

describe('buildPlanCard', () => {
  it('builds card with approve and cancel actions', () => {
    const plan: ActionPlan = {
      goal: 'Merge PR #42',
      intent: { kind: 'pr_merge', slots: { prNumber: 42 }, confidence: 1 },
      steps: [],
      riskLevel: 'high',
      missingParams: [],
      requiresConfirmation: true,
      sideEffects: true,
    };
    const card = buildPlanCard(plan, 'PLAN-20260525-ABCD');
    expect(card.title).toContain('Merge PR #42');
    expect(card.actions).toHaveLength(2);
    expect(card.actions[0].action).toBe('approve_plan');
    expect(card.actions[1].action).toBe('cancel');
  });
});
