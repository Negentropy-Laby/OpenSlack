import { describe, it, expect } from 'vitest';
import { summarizePRForChat, formatPRChatSummary } from '../chat-report.js';
import type { PRReviewReport } from '../types.js';

function makeReport(overrides: Partial<PRReviewReport> = {}): PRReviewReport {
  return {
    prNumber: 12,
    title: 'Fix validation',
    author: 'bob',
    state: 'open',
    draft: false,
    baseRef: 'main',
    riskZone: 'green',
    changedFiles: ['docs/readme.md'],
    checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    reviews: [],
    humanApprovals: [],
    decision: 'ANALYZED',
    reason: '',
    recommendation: '',
    mergeable: true,
    ...overrides,
  };
}

describe('summarizePRForChat', () => {
  it('returns ready for green zone with approval', () => {
    const report = makeReport({
      decision: 'READY_TO_MERGE',
      reason: 'All checks passed.',
      recommendation: 'Safe to merge.',
      reviews: [{ user: 'alice', state: 'APPROVED' }],
    });
    const summary = summarizePRForChat(report);
    expect(summary.canMerge).toBe(true);
    expect(summary.blocker).toBeUndefined();
    expect(summary.why).toBe('All checks passed.');
    expect(summary.next).toContain('openslack pr merge 12');
  });

  it('returns blocked for missing human approval', () => {
    const report = makeReport({
      decision: 'NEEDS_HUMAN_APPROVAL',
      reason: 'No valid human approval found.',
      recommendation: 'Request review.',
    });
    const summary = summarizePRForChat(report);
    expect(summary.canMerge).toBe(false);
    expect(summary.blocker).toBe('Missing valid human approval');
    expect(summary.next).toContain('GitHub approval');
    expect(summary.owner).toBe('human');
  });

  it('returns blocked for checks pending', () => {
    const report = makeReport({
      decision: 'CHECKS_PENDING',
      reason: 'Checks still running: ci',
      recommendation: 'Wait.',
    });
    const summary = summarizePRForChat(report);
    expect(summary.canMerge).toBe(false);
    expect(summary.blocker).toBe('Checks still running');
  });

  it('returns blocked for black zone', () => {
    const report = makeReport({
      riskZone: 'black',
      decision: 'BLOCKED_BLACK_ZONE',
      reason: 'Policy: Black Zone PRs are never mergeable.',
      recommendation: 'Close PR.',
    });
    const summary = summarizePRForChat(report);
    expect(summary.canMerge).toBe(false);
    expect(summary.blocker).toBe('Black Zone — never mergeable');
  });

  it('uses bot-authored PR guidance for sole CODEOWNER deadlocks', () => {
    const report = makeReport({
      riskZone: 'red',
      decision: 'BLOCKED_AUTHOR_IS_SOLE_CODEOWNER',
      reason: 'PR author is the only CODEOWNER.',
      recommendation: 'Old recommendation.',
    });
    const summary = summarizePRForChat(report);
    expect(summary.next).toContain('bot/agent-authored PR');
    expect(summary.next).toContain('human CODEOWNER approval');
  });

  it('includes correct PR number and title', () => {
    const report = makeReport({ prNumber: 42, title: 'Add feature X' });
    const summary = summarizePRForChat(report);
    expect(summary.prNumber).toBe(42);
    expect(summary.title).toBe('Add feature X');
  });
});

describe('formatPRChatSummary', () => {
  it('formats ready PR as markdown', () => {
    const summary = {
      prNumber: 12,
      title: 'Fix validation',
      decision: 'READY_TO_MERGE' as const,
      canMerge: true,
      why: 'All checks passed.',
      next: 'Safe to merge.',
      zone: 'green',
    };
    const text = formatPRChatSummary(summary);
    expect(text).toContain('PR #12 — Fix validation');
    expect(text).toContain('✅ *Ready to merge*');
    expect(text).toContain('Why: All checks passed.');
    expect(text).toContain('Next: Safe to merge.');
  });

  it('formats blocked PR with blocker', () => {
    const summary = {
      prNumber: 12,
      title: 'Fix validation',
      decision: 'NEEDS_HUMAN_APPROVAL' as const,
      canMerge: false,
      blocker: 'Missing valid human approval',
      why: 'No valid human approval found.',
      next: 'Request review from an independent human reviewer on GitHub.',
      zone: 'yellow',
    };
    const text = formatPRChatSummary(summary);
    expect(text).toContain('🚫 *Cannot merge*');
    expect(text).toContain('Blocker: Missing valid human approval');
    expect(text).toContain('Slack confirmation is not a GitHub approval');
  });

  it('does not mention Slack approval for non-approval blockers', () => {
    const summary = {
      prNumber: 12,
      title: 'Fix validation',
      decision: 'CHECKS_PENDING' as const,
      canMerge: false,
      blocker: 'Checks still running',
      why: 'CI still running.',
      next: 'Wait for all checks to complete.',
      zone: 'yellow',
    };
    const text = formatPRChatSummary(summary);
    expect(text).not.toContain('Slack confirmation');
  });
});
