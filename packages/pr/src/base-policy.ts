import type { PRReviewPolicy, PRReviewReport } from './types.js';

export interface PRBasePolicyViolation {
  decision: 'BLOCKED_BASE_BRANCH';
  reason: string;
  recommendation: string;
}

export function evaluatePRBasePolicy(
  report: Pick<PRReviewReport, 'prNumber' | 'baseRef'>,
  policy: Pick<PRReviewPolicy, 'required_base_ref'>,
): PRBasePolicyViolation | null {
  if (report.baseRef === policy.required_base_ref) return null;

  return {
    decision: 'BLOCKED_BASE_BRANCH',
    reason: `PR targets base branch "${report.baseRef}"; policy requires "${policy.required_base_ref}".`,
    recommendation: `Run gh pr edit ${report.prNumber} --base ${policy.required_base_ref}, then refresh checks and request a new review if required.`,
  };
}
