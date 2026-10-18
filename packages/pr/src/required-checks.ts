import type { PRReviewPolicy, PRReviewReport } from './types.js';

/** A reported green check is not proof that a required control was reported. */
export function requiredCheckBlocker(
  report: PRReviewReport,
  policy: PRReviewPolicy,
): Pick<PRReviewReport, 'decision' | 'reason' | 'recommendation'> | undefined {
  for (const name of policy.required_check_contexts?.[report.riskZone] ?? []) {
    const matches = report.checks.filter((check) => check.name === name);
    if (matches.length === 0) {
      return {
        decision: 'CHECKS_PENDING',
        reason: `Required check has no current-head result: ${name}`,
        recommendation: 'Run the configured required control on this head before merge.',
      };
    }
    if (matches.length !== 1) {
      return {
        decision: 'BLOCKED_POLICY',
        reason: `Required check context is ambiguous: ${name}`,
        recommendation: 'Resolve duplicate check producers; do not select a convenient result.',
      };
    }
    const check = matches[0]!;
    if (check.status !== 'completed') {
      return {
        decision: 'CHECKS_PENDING',
        reason: `Required check is still running: ${name}`,
        recommendation: 'Wait for the required control to complete.',
      };
    }
    if (check.conclusion !== 'success') {
      return {
        decision: 'CHECKS_FAILED',
        reason: `Required check did not succeed: ${name} (${check.conclusion ?? 'unknown'})`,
        recommendation: 'Fix and run the required control; skipped or neutral is not success.',
      };
    }
  }
}
