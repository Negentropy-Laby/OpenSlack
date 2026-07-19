import { describe, expect, it } from 'vitest';
import { renderPRDecisionSummary, summarizePRDecision } from '../decision-summary.js';
import type { PRReviewReport } from '../types.js';

function makeReport(overrides: Partial<PRReviewReport> = {}): PRReviewReport {
  return {
    prNumber: 42,
    title: 'Test PR',
    author: 'alice',
    state: 'open',
    draft: false,
    baseRef: 'main',
    riskZone: 'yellow',
    changedFiles: ['packages/pr/src/doctor.ts'],
    checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    reviews: [],
    humanApprovals: [],
    decision: 'NEEDS_HUMAN_APPROVAL',
    reason: 'No valid human approval found.',
    recommendation: 'Request review.',
    mergeable: true,
    ...overrides,
  };
}

describe('PR decision summary', () => {
  it('summarizes missing approval with owner and next action', () => {
    const summary = summarizePRDecision(makeReport());
    expect(summary.blockerCategory).toBe('approvals');
    expect(summary.owner).toBe('human');
    expect(summary.nextAction).toContain('GitHub approval');
    expect(summary.rerunCommand).toBe('openslack pr doctor 42');
  });

  it('shows bot approvals as ignored evidence', () => {
    const summary = summarizePRDecision(
      makeReport({
        decision: 'BOT_APPROVAL_IGNORED',
        reviews: [{ user: 'github-actions[bot]', state: 'APPROVED' }],
      }),
    );
    expect(summary.evidence.some((e) => e.includes('Bot approvals ignored'))).toBe(true);
    expect(summary.nextAction).toContain('bot approvals do not satisfy PRMS');
  });

  it('renders a compact operational decision block', () => {
    const text = renderPRDecisionSummary(
      summarizePRDecision(
        makeReport({
          decision: 'READY_TO_MERGE',
          reviews: [{ user: 'bob', state: 'APPROVED' }],
        }),
      ),
    );
    expect(text).toContain('Operational Decision');
    expect(text).toContain('READY_TO_MERGE');
    expect(text).toContain('openslack pr doctor 42');
  });
});
