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

function report(): PRReviewReport {
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
});
