import { describe, it, expect } from 'vitest';
import { recommendNextActions, getAttentionItems, getNextAction } from '../next-action.js';
import type { NextActionContext, AttentionItem } from '../next-action.js';

describe('recommendNextActions', () => {
  it('returns "All clear" when context is empty', () => {
    const recs = recommendNextActions({});
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toBe('All clear');
    expect(recs[0].priority).toBe(6);
  });

  it('prioritizes doctor failure above everything', () => {
    const ctx: NextActionContext = {
      doctorFailed: true,
      setupFindings: [{ status: 'fixable_by_command', title: 'Missing auth', nextAction: 'Configure auth', command: 'openslack setup' }],
      gitHubOps: { ready: 5, claimed: 0, blocked: 0, openPRs: 3, blockedPRs: 2, readyPRs: 1, available: true },
      blockers: [{ object: 'pr:42', summary: 'Blocked', owner: 'human:wsman' }],
    };
    const recs = recommendNextActions(ctx);
    expect(recs[0].priority).toBe(0);
    expect(recs[0].title).toBe('Health check failed');
  });

  it('maps fixable setup findings with nextAction to recommendations', () => {
    const ctx: NextActionContext = {
      setupFindings: [
        { status: 'fixable_by_command', title: 'Missing auth', nextAction: 'Configure auth', command: 'openslack setup github' },
        { status: 'ok', title: 'Repo root', command: undefined },
      ],
    };
    const recs = recommendNextActions(ctx);
    expect(recs).toHaveLength(1);
    expect(recs[0].priority).toBe(1);
    expect(recs[0].command).toBe('openslack setup github');
  });

  it('skips evergreen setup findings without nextAction (e.g. github-labels)', () => {
    const ctx: NextActionContext = {
      setupFindings: [
        { status: 'fixable_by_command', title: 'OpenSlack labels', command: 'openslack github repair labels --apply' },
        { status: 'fixable_by_command', title: 'Missing auth', nextAction: 'Configure auth', command: 'openslack setup' },
      ],
    };
    const recs = recommendNextActions(ctx);
    expect(recs).toHaveLength(1);
    expect(recs[0].title).toBe('Missing auth');
  });

  it('maps human-owned blockers with natural language in action, not command', () => {
    const ctx: NextActionContext = {
      blockers: [
        { object: 'pr:42', summary: 'Missing approval', owner: 'human:wsman', nextAction: 'Review on GitHub' },
        { object: 'pr:43', summary: 'Checks failing', owner: 'agent:bot' },
      ],
    };
    const recs = recommendNextActions(ctx);
    expect(recs[0].priority).toBe(2);
    expect(recs[0].title).toContain('blocker');
    expect(recs[0].action).toBe('Review on GitHub');
    expect(recs[0].command).toBeUndefined();
  });

  it('maps blocked PRs to recommendations', () => {
    const ctx: NextActionContext = {
      gitHubOps: { ready: 0, claimed: 0, blocked: 0, openPRs: 5, blockedPRs: 3, readyPRs: 2, available: true },
    };
    const recs = recommendNextActions(ctx);
    expect(recs).toHaveLength(2);
    expect(recs[0].priority).toBe(3);
    expect(recs[0].title).toContain('3 PRs blocked');
    expect(recs[1].priority).toBe(5);
    expect(recs[1].title).toContain('2 PRs ready to merge');
  });

  it('maps ready tasks with correct agent tick command including --agent-id', () => {
    const ctx: NextActionContext = {
      gitHubOps: { ready: 4, claimed: 0, blocked: 0, openPRs: 0, blockedPRs: 0, readyPRs: 0, available: true },
    };
    const recs = recommendNextActions(ctx);
    expect(recs).toHaveLength(1);
    expect(recs[0].priority).toBe(4);
    expect(recs[0].command).toContain('--agent-id');
    expect(recs[0].command).toContain('--source github-issues');
  });

  it('maintains deterministic priority ordering', () => {
    const ctx: NextActionContext = {
      setupFindings: [{ status: 'fixable_by_command', title: 'Missing auth', nextAction: 'Fix auth', command: 'openslack setup' }],
      gitHubOps: { ready: 2, claimed: 0, blocked: 0, openPRs: 3, blockedPRs: 1, readyPRs: 1, available: true },
      blockers: [{ object: 'pr:10', summary: 'Needs review', owner: 'human:lead', nextAction: 'Review on GitHub' }],
    };
    const recs = recommendNextActions(ctx);
    const priorities = recs.map((r) => r.priority);
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i]).toBeGreaterThan(priorities[i - 1]);
    }
  });

  it('caps output at 5 recommendations', () => {
    const ctx: NextActionContext = {
      doctorFailed: true,
      setupFindings: [
        { status: 'fixable_by_command', title: 'A', nextAction: 'Fix A', command: 'a' },
        { status: 'fixable_by_command', title: 'B', nextAction: 'Fix B', command: 'b' },
        { status: 'fixable_by_command', title: 'C', nextAction: 'Fix C', command: 'c' },
        { status: 'fixable_by_command', title: 'D', nextAction: 'Fix D', command: 'd' },
      ],
      gitHubOps: { ready: 5, claimed: 0, blocked: 0, openPRs: 3, blockedPRs: 2, readyPRs: 1, available: true },
      blockers: [{ object: 'pr:1', summary: 'X', owner: 'human:a' }],
    };
    const recs = recommendNextActions(ctx);
    expect(recs.length).toBeLessThanOrEqual(5);
  });

  it('does not put non-command text into command field', () => {
    const ctx: NextActionContext = {
      blockers: [
        { object: 'pr:42', summary: 'Needs review', owner: 'human:lead', nextAction: 'Approve the PR on GitHub' },
      ],
    };
    const recs = recommendNextActions(ctx);
    expect(recs[0].command).toBeUndefined();
    expect(recs[0].action).toBe('Approve the PR on GitHub');
  });
});

describe('getAttentionItems', () => {
  it('returns empty array when context is empty', async () => {
    const items = await getAttentionItems({});
    expect(items).toEqual([]);
  });

  it('includes doctor failure as high priority', async () => {
    const items = await getAttentionItems({ doctorFailed: true });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('health');
    expect(items[0].priority).toBe('high');
    expect(items[0].description).toContain('Health check');
  });

  it('includes fixable setup findings as high priority', async () => {
    const ctx: NextActionContext = {
      setupFindings: [
        { status: 'fixable_by_command', title: 'Missing auth', nextAction: 'Configure auth', command: 'openslack setup' },
        { status: 'ok', title: 'Repo root' },
      ],
    };
    const items = await getAttentionItems(ctx);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('setup');
    expect(items[0].priority).toBe('high');
    expect(items[0].description).toBe('Missing auth');
  });

  it('skips setup findings without nextAction', async () => {
    const ctx: NextActionContext = {
      setupFindings: [
        { status: 'fixable_by_command', title: 'Labels', command: 'openslack repair labels' },
      ],
    };
    const items = await getAttentionItems(ctx);
    expect(items).toEqual([]);
  });

  it('includes human-owned blockers as medium priority', async () => {
    const ctx: NextActionContext = {
      blockers: [
        { object: 'pr:42', summary: 'Missing approval', owner: 'human:lead', nextAction: 'Review on GitHub' },
        { object: 'pr:43', summary: 'Failing checks', owner: 'agent:bot' },
      ],
    };
    const items = await getAttentionItems(ctx);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('blocker');
    expect(items[0].priority).toBe('medium');
    expect(items[0].description).toContain('pr:42');
  });

  it('includes blocked PRs as medium priority', async () => {
    const ctx: NextActionContext = {
      gitHubOps: { ready: 0, claimed: 0, blocked: 0, openPRs: 5, blockedPRs: 2, readyPRs: 1, available: true },
    };
    const items = await getAttentionItems(ctx);
    const blockedItem = items.find((i) => i.type === 'pr' && i.description.includes('blocked'));
    expect(blockedItem).toBeDefined();
    expect(blockedItem!.priority).toBe('medium');
  });

  it('includes ready tasks as low priority', async () => {
    const ctx: NextActionContext = {
      gitHubOps: { ready: 3, claimed: 0, blocked: 0, openPRs: 0, blockedPRs: 0, readyPRs: 0, available: true },
    };
    const items = await getAttentionItems(ctx);
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('task');
    expect(items[0].priority).toBe('low');
    expect(items[0].description).toContain('3 tasks');
  });

  it('includes ready PRs as low priority', async () => {
    const ctx: NextActionContext = {
      gitHubOps: { ready: 0, claimed: 0, blocked: 0, openPRs: 3, blockedPRs: 0, readyPRs: 2, available: true },
    };
    const items = await getAttentionItems(ctx);
    const readyItem = items.find((i) => i.description.includes('ready to merge'));
    expect(readyItem).toBeDefined();
    expect(readyItem!.priority).toBe('low');
  });

  it('aggregates items from multiple sources', async () => {
    const ctx: NextActionContext = {
      doctorFailed: true,
      setupFindings: [{ status: 'fixable_by_command', title: 'Auth', nextAction: 'Fix auth' }],
      blockers: [{ object: 'pr:1', summary: 'Blocked', owner: 'human:dev' }],
      gitHubOps: { ready: 5, claimed: 0, blocked: 0, openPRs: 2, blockedPRs: 1, readyPRs: 0, available: true },
    };
    const items = await getAttentionItems(ctx);
    expect(items.length).toBeGreaterThanOrEqual(4);
  });
});

describe('getNextAction', () => {
  it('returns "All clear" when items is empty', () => {
    const result = getNextAction([]);
    expect(result).toBe('All clear — no immediate actions needed.');
  });

  it('picks the highest priority item', () => {
    const items: AttentionItem[] = [
      { type: 'task', description: 'Tasks ready', action: 'Claim a task', priority: 'low' },
      { type: 'health', description: 'Health failed', action: 'Run doctor', priority: 'high' },
      { type: 'blocker', description: 'PR blocked', action: 'Review PR', priority: 'medium' },
    ];
    const result = getNextAction(items);
    expect(result).toContain('Health failed');
    expect(result).toContain('Run doctor');
  });

  it('picks medium over low when no high items exist', () => {
    const items: AttentionItem[] = [
      { type: 'task', description: 'Tasks ready', action: 'Claim a task', priority: 'low' },
      { type: 'blocker', description: 'PR blocked', action: 'Review PR', priority: 'medium' },
    ];
    const result = getNextAction(items);
    expect(result).toContain('PR blocked');
  });

  it('returns single item description when only one item', () => {
    const items: AttentionItem[] = [
      { type: 'setup', description: 'Auth missing', action: 'Configure auth', priority: 'high' },
    ];
    const result = getNextAction(items);
    expect(result).toBe('Auth missing: Configure auth');
  });
});
