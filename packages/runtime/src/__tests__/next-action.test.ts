import { describe, it, expect } from 'vitest';
import { recommendNextActions } from '../next-action.js';
import type { NextActionContext } from '../next-action.js';

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
