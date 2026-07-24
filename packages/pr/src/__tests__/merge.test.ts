import { describe, it, expect, vi } from 'vitest';
import { mergeIfReady } from '../merge.js';
import type { PRReviewReport, PRReviewPolicy } from '../types.js';
import type { AgentPermissionSnapshot } from '@openslack/kernel';

vi.mock('@openslack/github', () => ({
  getCODEOWNERS: vi.fn(() => Promise.resolve('# no matching owners')),
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
  required_base_ref: 'main',
  effective_after_pr: 296,
};

function makeReport(overrides: Partial<PRReviewReport> = {}): PRReviewReport {
  return {
    prNumber: 1,
    title: 'Test PR',
    author: 'test-agent',
    state: 'open',
    draft: false,
    baseRef: 'main',
    baseSha: 'base-sha',
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

function makeSnapshot(actionVerdict: 'allow' | 'ask' | 'deny'): AgentPermissionSnapshot {
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
      actions: { 'github.merge': actionVerdict },
      github: { can_create_pr: true, can_comment: true, can_approve: false, can_merge: true },
      max_risk_zone: 'yellow',
    },
    resolved_at: new Date().toISOString(),
    source: 'registry_v2',
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

  it('never calls Merge Steward for a non-main PR even when checks and approval pass', async () => {
    const { fetchPRDetails } = await import('../fetch.js');
    const { getCODEOWNERS, mergePR } = await import('@openslack/github');
    vi.mocked(mergePR).mockClear();
    vi.mocked(getCODEOWNERS).mockClear();
    vi.mocked(fetchPRDetails).mockResolvedValue(
      makeReport({ prNumber: 414, baseRef: 'release/0.3' }),
    );

    const result = await mergeIfReady(414, DEFAULT_POLICY);

    expect(result.merged).toBe(false);
    expect(result.decision).toBe('BLOCKED_BASE_BRANCH');
    expect(result.message).toContain('gh pr edit 414 --base main');
    expect(mergePR).not.toHaveBeenCalled();
    expect(getCODEOWNERS).not.toHaveBeenCalled();
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

  it('blocks merge when agent authorization requires confirmation', async () => {
    const { fetchPRDetails } = await import('../fetch.js');
    vi.mocked(fetchPRDetails).mockResolvedValue(makeReport());

    const result = await mergeIfReady(1, DEFAULT_POLICY, { snapshot: makeSnapshot('ask') });

    expect(result.merged).toBe(false);
    expect(result.decision).toBe('BLOCKED_AUTHORIZATION');
    expect(result.message).toContain('requires authorization confirmation');
  });
});
