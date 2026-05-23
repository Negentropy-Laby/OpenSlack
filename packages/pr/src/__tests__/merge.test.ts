import { describe, it, expect, vi } from 'vitest';
import { mergeIfReady } from '../merge.js';
import type { PRReviewReport, PRReviewPolicy } from '../types.js';

vi.mock('@openslack/github', () => ({
  getCODEOWNERS: vi.fn(() => Promise.resolve(null)),
  mergePR: vi.fn(() => Promise.resolve({ merged: true, sha: 'abc123', message: 'Merged' })),
}));

vi.mock('../fetch.js', () => ({
  fetchPRDetails: vi.fn(),
}));

vi.mock('../classify.js', () => ({
  classifyPRReport: vi.fn((report: PRReviewReport) => report),
}));

const DEFAULT_POLICY: PRReviewPolicy = {
  no_auto_approval: true,
  no_self_review: true,
  red_zone_human_required: true,
  black_zone_never_merge: true,
};

function makeReport(overrides: Partial<PRReviewReport> = {}): PRReviewReport {
  return {
    prNumber: 1,
    title: 'Test PR',
    author: 'test-agent',
    state: 'open',
    draft: false,
    baseRef: 'main',
    riskZone: 'green',
    changedFiles: [],
    checks: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
    reviews: [{ user: 'alice', state: 'APPROVED' }],
    humanApprovals: [{ user: 'alice' }],
    decision: 'ANALYZED',
    reason: '',
    recommendation: '',
    mergeable: true,
    ...overrides,
  };
}

describe('mergeIfReady', () => {
  it('blocks black zone PRs', async () => {
    const { fetchPRDetails } = await import('../fetch.js');
    vi.mocked(fetchPRDetails).mockResolvedValue(makeReport({ riskZone: 'black' }));

    const result = await mergeIfReady(1, DEFAULT_POLICY);
    expect(result.merged).toBe(false);
    expect(result.decision).toBe('BLOCKED_BLACK_ZONE');
  });

  it('blocks when checks are pending', async () => {
    const { fetchPRDetails } = await import('../fetch.js');
    vi.mocked(fetchPRDetails).mockResolvedValue(
      makeReport({
        checks: [{ name: 'ci', status: 'in_progress', conclusion: null }],
      }),
    );

    const result = await mergeIfReady(1, DEFAULT_POLICY);
    expect(result.merged).toBe(false);
    expect(result.decision).toBe('CHECKS_PENDING');
  });

  it('blocks when checks fail', async () => {
    const { fetchPRDetails } = await import('../fetch.js');
    vi.mocked(fetchPRDetails).mockResolvedValue(
      makeReport({
        checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
      }),
    );

    const result = await mergeIfReady(1, DEFAULT_POLICY);
    expect(result.merged).toBe(false);
    expect(result.decision).toBe('CHECKS_FAILED');
  });

  it('blocks author-is-sole-codeowner deadlock', async () => {
    const { fetchPRDetails } = await import('../fetch.js');
    const { getCODEOWNERS } = await import('@openslack/github');
    vi.mocked(fetchPRDetails).mockResolvedValue(
      makeReport({
        author: 'wsman',
        riskZone: 'red',
        changedFiles: ['.github/workflows/ci.yml'],
        reviews: [],
        humanApprovals: [],
      }),
    );
    vi.mocked(getCODEOWNERS).mockResolvedValue('.github/** @wsman');

    const result = await mergeIfReady(1, DEFAULT_POLICY);
    expect(result.merged).toBe(false);
    expect(result.decision).toBe('BLOCKED_AUTHOR_IS_SOLE_CODEOWNER');
  });

  it('blocks missing human approval', async () => {
    const { fetchPRDetails } = await import('../fetch.js');
    vi.mocked(fetchPRDetails).mockResolvedValue(makeReport({ reviews: [], humanApprovals: [] }));

    const result = await mergeIfReady(1, DEFAULT_POLICY);
    expect(result.merged).toBe(false);
    expect(result.decision).toBe('NEEDS_HUMAN_APPROVAL');
  });

  it('merges when all gates pass', async () => {
    const { fetchPRDetails } = await import('../fetch.js');
    const { mergePR } = await import('@openslack/github');
    vi.mocked(fetchPRDetails).mockResolvedValue(makeReport());

    const result = await mergeIfReady(1, DEFAULT_POLICY);
    expect(result.merged).toBe(true);
    expect(result.decision).toBe('READY_TO_MERGE');
    expect(mergePR).toHaveBeenCalledWith(1, { method: undefined });
  });

  it('passes merge method option to mergePR', async () => {
    const { fetchPRDetails } = await import('../fetch.js');
    const { mergePR } = await import('@openslack/github');
    vi.mocked(fetchPRDetails).mockResolvedValue(makeReport());

    await mergeIfReady(1, DEFAULT_POLICY, { method: 'squash' });
    expect(mergePR).toHaveBeenCalledWith(1, { method: 'squash' });
  });
});
