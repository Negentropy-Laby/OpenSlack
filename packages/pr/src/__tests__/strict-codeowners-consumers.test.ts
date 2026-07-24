import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  fetchPRDetails: vi.fn(),
  getCODEOWNERS: vi.fn(),
  listOpenPRs: vi.fn(),
}));

vi.mock('@openslack/github', () => ({
  getCODEOWNERS: (...args: unknown[]) => hoisted.getCODEOWNERS(...args),
  listOpenPRs: (...args: unknown[]) => hoisted.listOpenPRs(...args),
}));

vi.mock('../fetch.js', () => ({
  fetchPRDetails: (...args: unknown[]) => hoisted.fetchPRDetails(...args),
}));

import { PRCodeownerEvidenceUnavailableError } from '../codeowners.js';
import { buildPRQueue } from '../decision-summary.js';
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
    expect(hoisted.getCODEOWNERS).toHaveBeenCalledWith('immutable-base-sha', {
      strictEvidence: true,
    });
    logSpy.mockRestore();
  });

  it('makes queue construction fail closed instead of publishing incomplete ownership', async () => {
    await expect(buildPRQueue(20)).rejects.toBeInstanceOf(PRCodeownerEvidenceUnavailableError);
    expect(hoisted.getCODEOWNERS).toHaveBeenCalledWith('immutable-base-sha', {
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
