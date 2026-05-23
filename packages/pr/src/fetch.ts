import { getPR, listPRFiles, getPRChecks, getPRReviews } from '@openslack/github';
import type { PRReviewReport } from './types.js';

export async function fetchPRDetails(prNumber: number): Promise<PRReviewReport> {
  const [pr, files, checks, reviews] = await Promise.all([
    getPR(prNumber),
    listPRFiles(prNumber),
    getPRChecks(prNumber),
    getPRReviews(prNumber),
  ]);

  const humanApprovals = reviews
    .filter((r) => r.state === 'APPROVED')
    .map((r) => ({ user: r.user.login }));

  return {
    prNumber,
    title: pr?.title || `PR #${prNumber}`,
    author: pr?.user.login || 'unknown',
    riskZone: 'green',
    changedFiles: files,
    checks: checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })),
    reviews: reviews.map((r) => ({ user: r.user.login, state: r.state })),
    humanApprovals,
    decision: 'DISCOVERED',
    reason: 'Initial fetch complete. Awaiting classification.',
    recommendation: 'Run classification to determine risk zone and next steps.',
    mergeable: pr?.mergeable ?? false,
  };
}
