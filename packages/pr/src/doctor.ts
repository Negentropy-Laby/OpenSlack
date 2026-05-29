import type { PRReviewReport, PRReviewState, PRReviewPolicy } from './types.js';
import { filterValidApprovals, isBotUser } from './approvals.js';
import { detectDeadlock } from './deadlock.js';
import { evaluateWorkflowGate } from './workflow-gate.js';

export function diagnosePR(
  report: PRReviewReport,
  policy: PRReviewPolicy,
  codeowners: string[],
): PRReviewReport {
  let decision: PRReviewState = report.decision;
  let reason = report.reason;
  let recommendation = report.recommendation;

  // Initialize workflow gate as N/A; will be re-evaluated after basic checks
  const workflowGate = evaluateWorkflowGate(report.changedFiles, report.body ?? '');

  const validApprovers = filterValidApprovals(report.reviews, report.author);

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
    recommendation = 'Link workflow proposal/review issues, include workflow hash, and record trust decision in the PR body.';
    return { ...report, decision, reason, recommendation, workflowGate };
  }

  // 5. Black zone
  if (policy.black_zone_never_merge && report.riskZone === 'black') {
    decision = 'BLOCKED_BLACK_ZONE';
    reason = 'Policy: Black Zone PRs are never mergeable.';
    recommendation = 'Close PR. Black Zone changes are prohibited.';
    return { ...report, decision, reason, recommendation, workflowGate };
  }

  // 6. Checks pending
  const pendingChecks = report.checks.filter((c) => c.status !== 'completed');
  if (pendingChecks.length > 0) {
    decision = 'CHECKS_PENDING';
    reason = `Checks still running: ${pendingChecks.map((c) => c.name).join(', ')}`;
    recommendation = 'Wait for all checks to complete before evaluating merge readiness.';
    return { ...report, decision, reason, recommendation, workflowGate };
  }

  // 6. Checks failed
  const failingChecks = report.checks.filter(
    (c) => c.conclusion && c.conclusion !== 'success' && c.conclusion !== 'neutral' && c.conclusion !== 'skipped',
  );
  if (failingChecks.length > 0) {
    decision = 'CHECKS_FAILED';
    reason = `Failing checks: ${failingChecks.map((c) => c.name).join(', ')}`;
    recommendation = 'Fix failing checks before merge.';
    return { ...report, decision, reason, recommendation, workflowGate };
  }

  // 7. Deadlock detection (author is sole CODEOWNER / single maintainer)
  const deadlock = detectDeadlock(report.author, codeowners, validApprovers);
  if (deadlock.deadlocked) {
    if (deadlock.type === 'AUTHOR_IS_SOLE_CODEOWNER') {
      decision = 'BLOCKED_AUTHOR_IS_SOLE_CODEOWNER';
    } else if (deadlock.type === 'SINGLE_MAINTAINER') {
      decision = 'BLOCKED_SINGLE_MAINTAINER';
    }
    reason = deadlock.reason;
    recommendation = deadlock.recommendation;
    return { ...report, decision, reason, recommendation, workflowGate };
  }

  // 8. Self-review detection
  if (policy.no_self_review) {
    const selfReview = report.reviews.find(
      (r) => r.user === report.author && r.state === 'APPROVED',
    );
    if (selfReview) {
      decision = 'BLOCKED_SELF_REVIEW';
      reason = `Self-review detected: @${report.author} approved their own PR.`;
      recommendation = 'Remove self-approval. Another reviewer must approve.';
      return { ...report, decision, reason, recommendation, workflowGate };
    }
  }

  // 9. Missing human approval
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
    return { ...report, decision, reason, recommendation, workflowGate };
  }

  // 10. Missing CODEOWNER approval for Red Zone
  if (policy.red_zone_human_required && report.riskZone === 'red') {
    const codeownerApprovals = validApprovers.filter((approver) =>
      codeowners.some((owner) => owner.replace('@', '') === approver),
    );
    if (codeownerApprovals.length === 0) {
      decision = 'NEEDS_CODEOWNER_APPROVAL';
      reason = 'Red Zone requires CODEOWNER approval. No CODEOWNER has approved this PR.';
      recommendation = `Request review from CODEOWNERS (${codeowners.join(', ')}).`;
      return { ...report, decision, reason, recommendation, workflowGate };
    }
  }

  // 11. All gates pass
  if (report.riskZone === 'green' || report.riskZone === 'yellow') {
    decision = 'READY_TO_MERGE';
    reason = `${report.riskZone.charAt(0).toUpperCase() + report.riskZone.slice(1)} Zone. All checks passed. Valid approvals found.`;
    recommendation = 'Safe to merge.';
  } else if (report.riskZone === 'red') {
    decision = 'READY_TO_MERGE';
    reason = 'Red Zone. CODEOWNER approval satisfied. All checks passed.';
    recommendation = 'Ready to merge.';
  }

  return { ...report, decision, reason, recommendation, workflowGate };
}
