import { describe, it, expect } from 'vitest';
import { resolveContext, extractSlotsFromMessage, mergeDefinedSlots } from '../context-resolver.js';
import type { ConversationTurn } from '../conversation-store.js';
import type { Intent } from '../types.js';

function makeTurn(role: 'user' | 'assistant', content: string, intent?: Intent): ConversationTurn {
  return { role, content, intent, timestamp: new Date().toISOString() };
}

function makeIntent(kind: string, slots: Record<string, string | number | string[] | undefined> = {}): Intent {
  return { kind: kind as Intent['kind'], slots, confidence: 0.9 };
}

describe('resolveContext', () => {
  it('returns none for empty history', () => {
    const result = resolveContext(makeIntent('pr_merge'), []);
    expect(result.type).toBe('none');
  });

  it('detects English affirmation via currentMessage', () => {
    const history: ConversationTurn[] = [];
    const result = resolveContext(makeIntent('pr_merge'), history, 'PLAN-001', 'yes');
    expect(result.type).toBe('confirm_last_plan');
    if (result.type === 'confirm_last_plan') expect(result.planId).toBe('PLAN-001');
  });

  it('detects Chinese affirmation via currentMessage', () => {
    const history: ConversationTurn[] = [];
    const result = resolveContext(makeIntent('pr_merge'), history, 'PLAN-001', '确认');
    expect(result.type).toBe('confirm_last_plan');
  });

  it('detects English negation via currentMessage', () => {
    const history: ConversationTurn[] = [];
    const result = resolveContext(makeIntent('pr_merge'), history, 'PLAN-001', 'cancel');
    expect(result.type).toBe('cancel_last_plan');
  });

  it('detects Chinese negation via currentMessage', () => {
    const history: ConversationTurn[] = [];
    const result = resolveContext(makeIntent('pr_merge'), history, 'PLAN-001', '取消');
    expect(result.type).toBe('cancel_last_plan');
  });

  it('falls back to history for affirmation when no currentMessage', () => {
    const history = [makeTurn('user', 'ok')];
    const result = resolveContext(makeIntent('pr_merge'), history, 'PLAN-001');
    expect(result.type).toBe('confirm_last_plan');
  });

  it('resolves missing prNumber from history', () => {
    const history = [
      makeTurn('user', 'check PR 42', makeIntent('pr_status', { prNumber: 42 })),
      makeTurn('assistant', 'PR 42 is open'),
    ];
    const current = makeIntent('pr_merge', { prNumber: undefined });
    const result = resolveContext(current, history);
    expect(result.type).toBe('resolve_slots');
    if (result.type === 'resolve_slots') {
      expect(result.resolved.prNumber).toBe(42);
    }
  });

  it('resolves multiple missing slots', () => {
    const history = [
      makeTurn('user', 'checkout 15 as bot_001', makeIntent('checkout_task', { issueNumber: 15, agentId: 'bot_001' })),
      makeTurn('assistant', 'Checked out issue 15'),
    ];
    const current = makeIntent('sync_task', { issueNumber: undefined, agentId: undefined, paths: undefined });
    const result = resolveContext(current, history);
    expect(result.type).toBe('resolve_slots');
    if (result.type === 'resolve_slots') {
      expect(result.resolved.issueNumber).toBe(15);
      expect(result.resolved.agentId).toBe('bot_001');
    }
  });

  it('returns none when all slots filled', () => {
    const history = [makeTurn('user', 'check PR 42', makeIntent('pr_status', { prNumber: 42 }))];
    const current = makeIntent('pr_merge', { prNumber: 99 });
    const result = resolveContext(current, history);
    expect(result.type).toBe('none');
  });

  it('prefers more recent slot values', () => {
    const history = [
      makeTurn('user', 'check PR 10', makeIntent('pr_status', { prNumber: 10 })),
      makeTurn('assistant', 'PR 10 is open'),
      makeTurn('user', 'check PR 20', makeIntent('pr_status', { prNumber: 20 })),
      makeTurn('assistant', 'PR 20 is open'),
    ];
    const current = makeIntent('pr_merge', { prNumber: undefined });
    const result = resolveContext(current, history);
    expect(result.type).toBe('resolve_slots');
    if (result.type === 'resolve_slots') {
      expect(result.resolved.prNumber).toBe(20);
    }
  });
});

describe('extractSlotsFromMessage', () => {
  it('extracts bare number', () => {
    const slots = extractSlotsFromMessage('42');
    expect(slots.prNumber).toBe(42);
    expect(slots.issueNumber).toBe(42);
  });

  it('extracts bare number with hash', () => {
    const slots = extractSlotsFromMessage('#42');
    expect(slots.prNumber).toBe(42);
  });

  it('extracts explicit PR number', () => {
    const slots = extractSlotsFromMessage('merge pr #42');
    expect(slots.prNumber).toBe(42);
  });

  it('extracts explicit issue number', () => {
    const slots = extractSlotsFromMessage('checkout issue #15');
    expect(slots.issueNumber).toBe(15);
  });

  it('extracts agent ID', () => {
    const slots = extractSlotsFromMessage('--agent-id claude_code_001');
    expect(slots.agentId).toBe('claude_code_001');
  });

  it('returns empty for plain text', () => {
    const slots = extractSlotsFromMessage('hello world');
    expect(Object.keys(slots)).toHaveLength(0);
  });
});

describe('mergeDefinedSlots', () => {
  it('does not let undefined current slots erase resolved history', () => {
    const slots = mergeDefinedSlots(
      { prNumber: 42 },
      {},
      { prNumber: undefined },
    );
    expect(slots.prNumber).toBe(42);
  });

  it('lets explicit message slots override resolved history', () => {
    const slots = mergeDefinedSlots(
      { prNumber: 42 },
      { prNumber: 99 },
      { prNumber: undefined },
    );
    expect(slots.prNumber).toBe(99);
  });

  it('lets filled intent slots override earlier sources', () => {
    const slots = mergeDefinedSlots(
      { prNumber: 42 },
      { prNumber: 99 },
      { prNumber: 123 },
    );
    expect(slots.prNumber).toBe(123);
  });
});
