import { describe, it, expect } from 'vitest';
import { buildPRCard, toSlackBlocks, cardToText } from '../cards.js';
import type { PRChatSummary } from '@openslack/pr';

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

    const actions = blocks[blocks.length - 1] as { type: string; elements: Array<{ type: string; action_id: string }> };
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
