import { getPR, listPRFiles, getPRChecks, getPRReviews, getPRFilePatches } from '@openslack/github';
import type { GitHubClientOptions } from '@openslack/github';
import type { PRReviewReport } from './types.js';
import { isBotUser } from './approvals.js';

function isProfileSyncCandidate(
  files: string[],
  headRef: string,
  body: string,
): boolean {
  return headRef.startsWith('openslack/profile-sync/')
    || body.includes('```openslack-profile-sync-metadata')
    || body.includes('profile: sync latest')
    || files.includes('profile/README.md');
}

function latestReviewsByReviewer(
  reviews: Array<{ user: { login: string }; state: string; body: string; submittedAt?: string }>,
): Array<{ user: { login: string }; state: string; body: string; submittedAt?: string }> {
  const latest = new Map<string, { review: typeof reviews[number]; index: number }>();

  reviews.forEach((review, index) => {
    const key = review.user.login;
    const current = latest.get(key);
    if (!current) {
      latest.set(key, { review, index });
      return;
    }

    const nextTime = review.submittedAt ? Date.parse(review.submittedAt) : Number.NaN;
    const currentTime = current.review.submittedAt ? Date.parse(current.review.submittedAt) : Number.NaN;
    const newerByTime = Number.isFinite(nextTime) && Number.isFinite(currentTime)
      ? nextTime >= currentTime
      : false;
    const newerByOrder = !Number.isFinite(nextTime) || !Number.isFinite(currentTime)
      ? index >= current.index
      : false;

    if (newerByTime || newerByOrder) {
      latest.set(key, { review, index });
    }
  });

  return [...latest.values()].map((entry) => entry.review);
}

export async function fetchPRDetails(
  prNumber: number,
  options?: GitHubClientOptions,
): Promise<PRReviewReport> {
  const [pr, files, checks, reviews] = await Promise.all([
    getPR(prNumber, options),
    listPRFiles(prNumber, options),
    getPRChecks(prNumber, options),
    getPRReviews(prNumber, options),
  ]);
  const latestReviews = latestReviewsByReviewer(reviews);
  const shouldFetchPatches = pr
    ? isProfileSyncCandidate(files, pr.head.ref, pr.body)
    : false;
  const filePatches = shouldFetchPatches
    ? await getPRFilePatches(prNumber, options)
    : [];

  const author = pr?.user.login || 'unknown';
  const humanApprovals = latestReviews
    .filter((r) => r.state === 'APPROVED')
    .filter((r) => r.user.login !== author)
    .filter((r) => !isBotUser(r.user.login))
    .map((r) => ({ user: r.user.login }));

  return {
    prNumber,
    title: pr?.title || `PR #${prNumber}`,
    author,
    state: pr?.state || 'unknown',
    draft: pr?.draft ?? false,
    baseRef: pr?.base.ref || 'main',
    headRef: pr?.head.ref || '',
    riskZone: 'green',
    changedFiles: files,
    filePatches,
    checks: checks.map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion })),
    reviews: latestReviews.map((r) => ({ user: r.user.login, state: r.state })),
    humanApprovals,
    decision: 'DISCOVERED',
    reason: 'Initial fetch complete. Awaiting classification.',
    recommendation: 'Run classification to determine risk zone and next steps.',
    mergeable: pr?.mergeable ?? false,
    body: pr?.body ?? '',
  };
}
