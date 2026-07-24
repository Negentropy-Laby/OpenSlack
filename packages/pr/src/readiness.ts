import type { PRReviewReport, PRReviewPolicy, PRReviewState } from './types.js';
import { evaluatePRBasePolicy } from './base-policy.js';

export function checkMergeReadiness(
  report: PRReviewReport,
  policy: PRReviewPolicy,
): PRReviewReport {
  let decision: PRReviewState = report.decision;
  let reason = report.reason;
  let recommendation = report.recommendation;

  const baseViolation = evaluatePRBasePolicy(report, policy);
  if (baseViolation) return { ...report, ...baseViolation };

  // Black zone gate
  if (policy.black_zone_never_merge && report.riskZone === 'black') {
    decision = 'BLOCKED_BLACK_ZONE';
    reason = 'Policy: Black Zone PRs are never mergeable.';
    recommendation = 'Close PR. Black Zone changes are prohibited.';
    return { ...report, decision, reason, recommendation };
  }

  // Draft PR gate
  // Note: fetchPRDetails doesn't capture draft state; we'd need to add it.
  // For now, we rely on the classification output.

  // Self-review gate (requires agent_id context; Phase 1.14 enhancement)
  // For MVP, we skip runtime self-review detection and rely on policy + human gates.

  // Required checks gate
  const failingChecks = report.checks.filter(
    (c) =>
      c.conclusion &&
      c.conclusion !== 'success' &&
      c.conclusion !== 'neutral' &&
      c.conclusion !== 'skipped',
  );
  const pendingChecks = report.checks.filter((c) => c.status !== 'completed');

  if (pendingChecks.length > 0) {
    decision = 'CHECKS_PENDING';
    reason = `Checks still running: ${pendingChecks.map((c) => c.name).join(', ')}`;
    recommendation = 'Wait for all checks to complete before evaluating merge readiness.';
    return { ...report, decision, reason, recommendation };
  }

  if (failingChecks.length > 0) {
    decision = 'CHECKS_FAILED';
    reason = `Failing checks: ${failingChecks.map((c) => c.name).join(', ')}`;
    recommendation = 'Fix failing checks before merge.';
    return { ...report, decision, reason, recommendation };
  }

  // Red zone human approval gate. This lightweight pre-check does not load
  // immutable CODEOWNERS; diagnosePR enforces assigned-owner membership.
  if (policy.red_zone_human_required && report.riskZone === 'red') {
    if (report.humanApprovals.length === 0) {
      decision = 'NEEDS_HUMAN_APPROVAL';
      reason = 'Red Zone requires independent human approval. No approving review found.';
      recommendation = 'Request an authorized human review and wait for approval.';
      return { ...report, decision, reason, recommendation };
    }
    decision = 'HUMAN_APPROVED';
    reason = `Red Zone approved by: ${report.humanApprovals.map((a) => a.user).join(', ')}`;
    recommendation = 'Human approval satisfied. Ready to merge if no other blocks.';
  }

  // Final readiness
  if (report.riskZone === 'green') {
    decision = 'READY_TO_MERGE';
    reason = 'Green Zone. All checks passed. No human approval required.';
    recommendation = 'Safe to merge.';
  } else if (report.riskZone === 'yellow') {
    decision = 'READY_TO_MERGE';
    reason =
      'Yellow Zone. All checks passed. Independent review recommended but not gated for MVP.';
    recommendation = 'Proceed with merge if independent review exists.';
  } else if (report.riskZone === 'red' && report.humanApprovals.length > 0) {
    decision = 'READY_TO_MERGE';
    reason = `Red Zone. Human approval satisfied. All checks passed.`;
    recommendation = 'Ready to merge.';
  }

  return { ...report, decision, reason, recommendation };
}
