import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubEvidenceUnavailableError } from '@openslack/github';
import type * as GitHubModule from '@openslack/github';

const hoisted = vi.hoisted(() => ({
  fetchPRDetails: vi.fn(),
  getCODEOWNERS: vi.fn(),
  listOpenPRs: vi.fn(),
  checkTaskClaimReview: vi.fn(),
}));

vi.mock('@openslack/github', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubModule>()),
  getCODEOWNERS: (...args: unknown[]) => hoisted.getCODEOWNERS(...args),
  listOpenPRs: (...args: unknown[]) => hoisted.listOpenPRs(...args),
  checkTaskClaimReview: (...args: unknown[]) => hoisted.checkTaskClaimReview(...args),
}));

vi.mock('../policy.js', () => ({
  loadPRReviewPolicy: () => ({
    no_auto_approval: true,
    no_self_review: true,
    red_zone_human_required: true,
    black_zone_never_merge: true,
    required_base_ref: 'main',
    effective_after_pr: 0,
  }),
}));

vi.mock('../fetch.js', () => ({
  fetchPRDetails: (...args: unknown[]) => hoisted.fetchPRDetails(...args),
}));

import { PRCodeownerEvidenceUnavailableError } from '../codeowners.js';
import { buildPRQueue, renderPRQueue } from '../decision-summary.js';
import type { PRReviewReport } from '../types.js';
import { watchPR } from '../watch.js';

function report(overrides: Partial<PRReviewReport> = {}): PRReviewReport {
  return {
    prNumber: 42,
    title: 'PR without CODEOWNERS evidence',
    author: 'app/openslack-agent-operator',
    state: 'open',
    draft: false,
    baseRef: 'main',
    baseSha: 'immutable-base-sha',
    headSha: 'head-sha',
    riskZone: 'yellow',
    changedFiles: ['packages/pr/src/watch.ts'],
    checks: [{ name: 'validate', status: 'completed', conclusion: 'success' }],
    reviews: [],
    humanApprovals: [],
    decision: 'ANALYZED',
    reason: '',
    recommendation: '',
    mergeable: true,
    ...overrides,
  };
}

describe('strict CODEOWNERS evidence consumers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.fetchPRDetails.mockResolvedValue(report());
    hoisted.getCODEOWNERS.mockResolvedValue(null);
    hoisted.listOpenPRs.mockResolvedValue([
      { number: 42, title: 'PR without CODEOWNERS evidence' },
    ]);
  });

  it('makes watch fail closed instead of treating missing CODEOWNERS as no owners', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(watchPR(42, { timeoutSeconds: 1, intervalSeconds: 0 })).rejects.toBeInstanceOf(
      PRCodeownerEvidenceUnavailableError,
    );
    expect(hoisted.getCODEOWNERS).toHaveBeenCalledWith(
      'immutable-base-sha',
      expect.objectContaining({ strictEvidence: true, signal: expect.any(AbortSignal) }),
    );
    logSpy.mockRestore();
  });

  it('makes queue construction fail closed instead of publishing incomplete ownership', async () => {
    await expect(buildPRQueue(20)).rejects.toBeInstanceOf(PRCodeownerEvidenceUnavailableError);
    expect(hoisted.getCODEOWNERS).toHaveBeenCalledWith('immutable-base-sha', {
      requireLive: true,
      strictEvidence: true,
    });
  });

  it('makes watch stop on a non-main base before loading CODEOWNERS', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    hoisted.fetchPRDetails.mockResolvedValue(report({ baseRef: 'release/0.3' }));

    const result = await watchPR(42, { timeoutSeconds: 1, intervalSeconds: 0 });

    expect(result.finalState).toBe('BLOCKED_BASE_BRANCH');
    expect(hoisted.getCODEOWNERS).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('makes queue diagnosis skip CODEOWNERS for a non-main base', async () => {
    hoisted.fetchPRDetails.mockResolvedValue(report({ baseRef: 'feature/topic' }));

    const items = await buildPRQueue(20);

    expect(items[0]).toMatchObject({
      decision: 'BLOCKED_BASE_BRANCH',
      blockerCategory: 'branch_policy',
    });
    expect(hoisted.getCODEOWNERS).not.toHaveBeenCalled();
  });
});

describe('live claim review evidence consumers', () => {
  const body =
    '<!-- openslack-task-link {"schema":"openslack.task_link.v1","issue_number":9,"agent_id":"worker","task_id":"TASK-9","run_id":"RUN-9","claim_ref":"refs/heads/openslack/claims/issue-9"} -->';
  const clientOptions = { repoFullName: 'acme/project' };
  const blocker = {
    code: 'CLAIM_LEASE_NOT_CURRENT',
    reason: 'The claim has expired.',
    recommendation: 'Renew the claim.',
    owner: 'agent',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getCODEOWNERS.mockResolvedValue('');
    hoisted.checkTaskClaimReview.mockResolvedValue(blocker);
    hoisted.fetchPRDetails.mockResolvedValue(
      report({
        body,
        reviews: [{ user: 'reviewer', state: 'APPROVED', commitOid: 'head-sha' }],
      }),
    );
    hoisted.listOpenPRs.mockResolvedValue([{ number: 42, title: 'Task-linked change' }]);
  });

  it('stops watching on the typed claim blocker in the requested repository', async () => {
    await expect(watchPR(42, { clientOptions, timeoutSeconds: 1 })).resolves.toMatchObject({
      finalState: 'BLOCKED_CLAIM_REVIEW',
      reason: blocker.reason,
      polls: 1,
    });
    expect(hoisted.checkTaskClaimReview).toHaveBeenCalledWith(
      42,
      body,
      expect.objectContaining({
        ...clientOptions,
        requireLive: true,
        strictEvidence: true,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('keeps missing human approval visible alongside claim evidence in the queue', async () => {
    hoisted.fetchPRDetails.mockResolvedValue(report({ body }));
    const items = await buildPRQueue(20, clientOptions);
    expect(items).toMatchObject([
      {
        decision: 'NEEDS_HUMAN_APPROVAL',
        canMerge: false,
        blockerCategory: 'approvals',
        owner: 'human',
        evidence: expect.arrayContaining([expect.stringContaining(blocker.reason)]),
      },
    ]);
    expect(renderPRQueue(items)).toContain('Claim action: Renew the claim.');
    expect(hoisted.checkTaskClaimReview).toHaveBeenCalledWith(42, body, {
      ...clientOptions,
      requireLive: true,
      strictEvidence: true,
    });
  });
  it('returns nonmergeable when a PR snapshot cannot be read inside the watch budget', async () => {
    hoisted.fetchPRDetails.mockRejectedValueOnce(new Error('PR_EVIDENCE_SNAPSHOT_UNAVAILABLE'));
    await expect(watchPR(42, { clientOptions, timeoutSeconds: 1 })).resolves.toMatchObject({
      finalState: 'EVIDENCE_UNAVAILABLE',
      reason: expect.stringContaining('PR_EVIDENCE_SNAPSHOT_UNAVAILABLE'),
      polls: 1,
    });
  });

  it('keeps unavailable GitHub claim evidence out of mergeable states', async () => {
    hoisted.checkTaskClaimReview.mockRejectedValue(
      new GitHubEvidenceUnavailableError({
        operation: 'task claim review evidence',
        owner: 'acme',
        repo: 'project',
        prNumber: 42,
        status: 503,
        causeMessage: 'Refresh evidence.',
      }),
    );
    await expect(buildPRQueue(20, clientOptions)).resolves.toMatchObject([
      {
        decision: 'EVIDENCE_UNAVAILABLE',
        canMerge: false,
        blockerCategory: 'evidence',
      },
    ]);
    await expect(watchPR(42, { clientOptions, timeoutSeconds: 1 })).resolves.toMatchObject({
      finalState: 'EVIDENCE_UNAVAILABLE',
      polls: 1,
    });
  });
});
