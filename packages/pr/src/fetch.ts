import {
  getPR,
  listPRFiles,
  getPRChecks,
  getPRReviews,
  getPRFilePatches,
  getRepositoryTree,
  findWorkflowGovernanceIssue,
} from '@openslack/github';
import type { GitHubClientOptions, PRReview } from '@openslack/github';
import type { PRReviewReport, WorkflowEvidence } from './types.js';
import { isBotUser } from './approvals.js';
import {
  createWorkflowEvidence,
  isCoreWorkflowArtifactPath,
  touchesWorkflowFiles,
} from './workflow-gate.js';

function isProfileSyncCandidate(files: string[], headRef: string, body: string): boolean {
  return (
    headRef.startsWith('openslack/profile-sync/') ||
    body.includes('```openslack-profile-sync-metadata') ||
    body.includes('profile: sync latest') ||
    files.includes('profile/README.md')
  );
}

function latestReviewsByReviewer(reviews: PRReview[]): PRReview[] {
  const latest = new Map<string, { review: PRReview; index: number }>();

  reviews.forEach((review, index) => {
    const key = review.user.login.toLowerCase();
    const current = latest.get(key);
    if (!current) {
      latest.set(key, { review, index });
      return;
    }

    const nextTime = review.submittedAt ? Date.parse(review.submittedAt) : Number.NaN;
    const currentTime = current.review.submittedAt
      ? Date.parse(current.review.submittedAt)
      : Number.NaN;
    const newerByTime =
      Number.isFinite(nextTime) && Number.isFinite(currentTime) ? nextTime >= currentTime : false;
    const newerByOrder =
      !Number.isFinite(nextTime) || !Number.isFinite(currentTime) ? index >= current.index : false;

    if (newerByTime || newerByOrder) latest.set(key, { review, index });
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
  const shouldFetchPatches = pr ? isProfileSyncCandidate(files, pr.head.ref, pr.body) : false;
  const filePatches = shouldFetchPatches ? await getPRFilePatches(prNumber, options) : [];
  let workflowEvidence: WorkflowEvidence | undefined;
  if (pr && touchesWorkflowFiles(files)) {
    const [baseTree, headTree] = await Promise.all([
      getRepositoryTree(pr.base.sha, options),
      getRepositoryTree(pr.head.sha, options),
    ]);
    workflowEvidence = createWorkflowEvidence({
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      baseTree,
      headTree,
    });
  }
  const governanceRequired =
    workflowEvidence !== undefined &&
    (workflowEvidence.addedFiles.length > 0 ||
      workflowEvidence.artifactFiles.some(isCoreWorkflowArtifactPath));
  const workflowGovernanceIssue = governanceRequired
    ? await findWorkflowGovernanceIssue(prNumber, options)
    : undefined;

  const author = pr?.user.login || 'unknown';
  const humanApprovals = latestReviews
    .filter((review) => review.state === 'APPROVED')
    .filter((review) => review.user.login.toLowerCase() !== author.toLowerCase())
    .filter((review) => !isBotUser(review.user.login))
    .filter((review) => Boolean(pr?.head.sha) && review.commitOid === pr?.head.sha)
    .map((review) => ({ user: review.user.login }));

  return {
    prNumber,
    title: pr?.title || `PR #${prNumber}`,
    author,
    state: pr?.state || 'unknown',
    draft: pr?.draft ?? false,
    baseRef: pr?.base.ref || 'main',
    baseSha: pr?.base.sha,
    headRef: pr?.head.ref || '',
    headSha: pr?.head.sha,
    riskZone: 'green',
    changedFiles: files,
    filePatches,
    checks: checks.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
    })),
    reviews: latestReviews.map((review) => ({
      user: review.user.login,
      state: review.state,
      body: review.body,
      submittedAt: review.submittedAt,
      commitOid: review.commitOid,
    })),
    humanApprovals,
    decision: 'DISCOVERED',
    reason: 'Initial fetch complete. Awaiting classification.',
    recommendation: 'Run classification to determine risk zone and next steps.',
    mergeable: pr?.mergeable ?? false,
    body: pr?.body ?? '',
    workflowEvidence,
    workflowGovernanceIssue:
      workflowGovernanceIssue?.body && workflowGovernanceIssue.author
        ? {
            issueNumber: workflowGovernanceIssue.issueNumber,
            prNumber,
            author: workflowGovernanceIssue.author,
            body: workflowGovernanceIssue.body,
          }
        : undefined,
  };
}
