import type { PRReviewPolicy, PRReviewReport } from './types.js';

export const CANONICAL_PR_BASE_REF = 'main' as const;
export const CANONICAL_PR_BASE_EFFECTIVE_AFTER_PR = 296 as const;

export interface PRBasePolicyViolation {
  decision: 'BLOCKED_BASE_BRANCH';
  reason: string;
  recommendation: string;
}

export function evaluatePRBasePolicy(
  report: Pick<PRReviewReport, 'prNumber' | 'baseRef'>,
  _policy: Pick<PRReviewPolicy, 'required_base_ref'>,
): PRBasePolicyViolation | null {
  if (report.baseRef === CANONICAL_PR_BASE_REF) return null;

  return {
    decision: 'BLOCKED_BASE_BRANCH',
    reason: `PR targets base branch "${report.baseRef}"; policy requires "${CANONICAL_PR_BASE_REF}".`,
    recommendation: `Run gh pr edit ${report.prNumber} --base ${CANONICAL_PR_BASE_REF}, then refresh checks and request a new review if required.`,
  };
}
