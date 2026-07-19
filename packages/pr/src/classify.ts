import { classifyPaths } from '@openslack/kernel';
import type { PRReviewReport } from './types.js';

export function classifyPRReport(report: PRReviewReport): PRReviewReport {
  const riskZone = classifyPaths(report.changedFiles);

  let decision = report.decision;
  let reason = report.reason;
  let recommendation = report.recommendation;

  switch (riskZone) {
    case 'black':
      decision = 'BLOCKED_BLACK_ZONE';
      reason =
        'Black Zone path detected. This PR touches forbidden paths (secrets, credentials, keys). Merging is prohibited.';
      recommendation = 'Close this PR immediately and investigate the intent.';
      break;
    case 'red':
      decision = 'NEEDS_HUMAN_APPROVAL';
      reason =
        'Red Zone path detected. Governance-critical changes require human code owner approval.';
      recommendation = 'Wait for CODEOWNERS human review and approval before proceeding.';
      break;
    case 'yellow':
      decision = 'ANALYZED';
      reason =
        'Yellow Zone path detected. Product code changes require independent review and passing checks.';
      recommendation =
        'Ensure all required checks pass and at least one independent review exists.';
      break;
    case 'green':
      decision = 'ANALYZED';
      reason =
        'Green Zone path detected. Low-risk changes (docs, templates, tasks). Auto-merge eligible if checks pass.';
      recommendation =
        'If all checks pass, this PR may be merged without additional human approval.';
      break;
  }

  return {
    ...report,
    riskZone,
    decision,
    reason,
    recommendation,
  };
}
