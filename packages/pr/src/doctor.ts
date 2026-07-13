import type { PRReviewReport, PRReviewState, PRReviewPolicy } from './types.js';
import { filterValidApprovals, isBotUser } from './approvals.js';
import { detectDeadlock } from './deadlock.js';
import { evaluateWorkflowGate, isCoreWorkflowArtifactPath } from './workflow-gate.js';
import { evaluateProfileSyncGate } from './profile-sync-gate.js';

export function diagnosePR(
  report: PRReviewReport,
  policy: PRReviewPolicy,
  codeowners: string[],
): PRReviewReport {
  let decision: PRReviewState = report.decision;
  let reason = report.reason;
  let recommendation = report.recommendation;

  // Initialize workflow gate as N/A; will be re-evaluated after basic checks
  const workflowGate = evaluateWorkflowGate({
    changedFiles: report.changedFiles,
    body: report.body ?? '',
    author: report.author,
    baseSha: report.baseSha,
    headSha: report.headSha,
    reviews: report.reviews,
    workflowEvidence: report.workflowEvidence,
    governanceIssue: report.workflowGovernanceIssue,
    codeowners,
  });

  const validApprovers = filterValidApprovals(report.reviews, report.author, report.headSha);

  // 1. Draft PR
  if (report.draft) {
    decision = 'BLOCKED_DRAFT';
    reason = 'This PR is in draft state.';
    recommendation = 'Mark the PR as ready for review before merge evaluation.';
    return { ...report, decision, reason, recommendation, workflowGate };
  }

  // 2. Not open
  if (report.state !== 'open') {
    decision = 'BLOCKED_POLICY';
    reason = `PR is ${report.state}, not open.`;
    recommendation = 'Only open PRs can be merged.';
    return { ...report, decision, reason, recommendation, workflowGate };
  }

  // 3. Merge conflicts
  if (report.mergeable === false) {
    decision = 'BLOCKED_POLICY';
    reason = 'PR has merge conflicts and cannot be merged.';
    recommendation = 'Resolve merge conflicts before proceeding.';
    return { ...report, decision, reason, recommendation, workflowGate };
  }

  // 4. Workflow gate (for PRs that modify workflow files)
  if (workflowGate.overall === 'FAIL') {
    const failedCriteria = workflowGate.criteria
      .filter((c) => c.status === 'FAIL')
      .map((c) => c.name)
      .join(', ');
    decision = 'BLOCKED_WORKFLOW_GATE';
    reason = `Workflow gate failed. Missing: ${failedCriteria}`;
    if (workflowGate.criteria.some((criterion) => criterion.name === 'Current-head evidence' && criterion.status === 'FAIL')) {
      recommendation = `Refresh live base/head workflow evidence for PR #${report.prNumber}; do not approve stale or unavailable evidence.`;
    } else if (workflowGate.criteria.some((criterion) => criterion.name === 'Governance issue' && criterion.status === 'FAIL')) {
      recommendation = `Run openslack pr workflow-governance ${report.prNumber} with GitHub App authentication.`;
    } else {
      const trust = workflowGate.artifactFiles?.some(isCoreWorkflowArtifactPath) ? 'core' : 'trusted';
      recommendation = `Run gh pr review ${report.prNumber} --approve --body "Workflow-Trust: ${trust}" as an authorized human on the current head.`;
    }
    return { ...report, decision, reason, recommendation, workflowGate };
  }

  // 5. Profile-sync gate (for PRs that are profile-sync PRs)
  const profileSyncGate = evaluateProfileSyncGate(
    report.changedFiles,
    report.body ?? '',
    report.headRef ?? '',
    report.filePatches,
  );
  if (profileSyncGate.overall === 'FAIL') {
    const failedCriteria = profileSyncGate.criteria
      .filter((c) => c.status === 'FAIL')
      .map((c) => c.name)
      .join(', ');
    decision = 'BLOCKED_PROFILE_SYNC_GATE';
    reason = `Profile-sync gate failed. Issues: ${failedCriteria}`;
    recommendation = 'Ensure the PR only modifies profile/README.md within the marker block, includes full metadata, and is not a direct-main write.';
    return { ...report, decision, reason, recommendation, workflowGate, profileSyncGate };
  }

  // 6. Black zone
  if (policy.black_zone_never_merge && report.riskZone === 'black') {
    decision = 'BLOCKED_BLACK_ZONE';
    reason = 'Policy: Black Zone PRs are never mergeable.';
    recommendation = 'Close PR. Black Zone changes are prohibited.';
    return { ...report, decision, reason, recommendation, workflowGate, profileSyncGate };
  }

  // 7. Checks pending
  const pendingChecks = report.checks.filter((c) => c.status !== 'completed');
  if (pendingChecks.length > 0) {
    decision = 'CHECKS_PENDING';
    reason = `Checks still running: ${pendingChecks.map((c) => c.name).join(', ')}`;
    recommendation = 'Wait for all checks to complete before evaluating merge readiness.';
    return { ...report, decision, reason, recommendation, workflowGate, profileSyncGate };
  }

  // 8. Checks failed
  const failingChecks = report.checks.filter(
    (c) => c.conclusion && c.conclusion !== 'success' && c.conclusion !== 'neutral' && c.conclusion !== 'skipped',
  );
  if (failingChecks.length > 0) {
    decision = 'CHECKS_FAILED';
    reason = `Failing checks: ${failingChecks.map((c) => c.name).join(', ')}`;
    recommendation = 'Fix failing checks before merge.';
    return { ...report, decision, reason, recommendation, workflowGate, profileSyncGate };
  }

  // 9. Deadlock detection (author is sole CODEOWNER / single maintainer)
  const deadlock = detectDeadlock(report.author, codeowners, validApprovers);
  if (deadlock.deadlocked) {
    if (deadlock.type === 'AUTHOR_IS_SOLE_CODEOWNER') {
      decision = 'BLOCKED_AUTHOR_IS_SOLE_CODEOWNER';
    } else if (deadlock.type === 'SINGLE_MAINTAINER') {
      decision = 'BLOCKED_SINGLE_MAINTAINER';
    }
    reason = deadlock.reason;
    recommendation = deadlock.recommendation;
    return { ...report, decision, reason, recommendation, workflowGate, profileSyncGate };
  }

  // 10. Self-review detection
  if (policy.no_self_review) {
    const selfReview = report.reviews.find(
      (r) => r.user === report.author && r.state === 'APPROVED',
    );
    if (selfReview) {
      decision = 'BLOCKED_SELF_REVIEW';
      reason = `Self-review detected: @${report.author} approved their own PR.`;
      recommendation = 'Remove self-approval. Another reviewer must approve.';
      return { ...report, decision, reason, recommendation, workflowGate, profileSyncGate };
    }
  }

  // 11. Missing human approval
  if (validApprovers.length === 0) {
    const botApprovals = report.reviews.filter(
      (r) => r.state === 'APPROVED' && isBotUser(r.user),
    );
    if (botApprovals.length > 0) {
      decision = 'BOT_APPROVAL_IGNORED';
      reason = 'Bot approvals exist but are ignored per policy. Human approval required.';
      recommendation = 'Request review from an independent human reviewer.';
    } else {
      decision = 'NEEDS_HUMAN_APPROVAL';
      reason = 'No valid human approval found. Author and bot approvals are excluded.';
      recommendation = 'Request review from an independent human reviewer.';
    }
    return { ...report, decision, reason, recommendation, workflowGate, profileSyncGate };
  }

  // 12. Missing CODEOWNER approval for Red Zone when the immutable base
  // actually assigns one. An empty owner set must not create an impossible
  // approval requirement; the independent human gate above remains mandatory.
  if (policy.red_zone_human_required && report.riskZone === 'red' && codeowners.length > 0) {
    const codeownerApprovals = validApprovers.filter((approver) =>
      codeowners.some((owner) => owner.replace('@', '') === approver),
    );
    if (codeownerApprovals.length === 0) {
      decision = 'NEEDS_CODEOWNER_APPROVAL';
      reason = 'Red Zone requires CODEOWNER approval. No CODEOWNER has approved this PR.';
      recommendation = `Request review from CODEOWNERS (${codeowners.join(', ')}).`;
      return { ...report, decision, reason, recommendation, workflowGate, profileSyncGate };
    }
  }

  // 13. All gates pass
  if (report.riskZone === 'green' || report.riskZone === 'yellow') {
    decision = 'READY_TO_MERGE';
    reason = `${report.riskZone.charAt(0).toUpperCase() + report.riskZone.slice(1)} Zone. All checks passed. Valid approvals found.`;
    recommendation = 'Safe to merge.';
  } else if (report.riskZone === 'red') {
    decision = 'READY_TO_MERGE';
    reason =
      codeowners.length > 0
        ? 'Red Zone. CODEOWNER approval satisfied. All checks passed.'
        : 'Red Zone. Independent human approval satisfied; no matching CODEOWNERS entries. All checks passed.';
    recommendation = 'Ready to merge.';
  }

  return { ...report, decision, reason, recommendation, workflowGate, profileSyncGate };
}
