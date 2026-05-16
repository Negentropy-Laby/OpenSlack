import type { SelfValidationResult } from '../types.js';

export interface ReviewResult {
  reviewerAgent: string;
  implementationAgent: string;
  decision: 'approve' | 'reject' | 'needs_changes';
  comments: string;
  checks: ReviewCheck[];
}

export interface ReviewCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export function reviewPR(
  _prNumber: number,
  validation: SelfValidationResult | null,
  implementationAgent: string,
  reviewerAgent: string,
): ReviewResult {
  const checks: ReviewCheck[] = [];

  // Check 1: Different agents
  if (implementationAgent === reviewerAgent) {
    checks.push({ name: 'independent_review', passed: false, detail: 'Implementation agent cannot review own PR' });
  } else {
    checks.push({ name: 'independent_review', passed: true, detail: `Reviewer ${reviewerAgent} != implementer ${implementationAgent}` });
  }

  // Check 2: Validation passed
  if (!validation || validation.decision === 'fail') {
    checks.push({ name: 'validation', passed: false, detail: 'Self-validation failed or missing' });
  } else {
    checks.push({ name: 'validation', passed: true, detail: 'Self-validation passed' });
  }

  // Check 3: No protected path violations
  if (validation?.protectedPathCheck) {
    if (validation.protectedPathCheck.black_zone_touched) {
      checks.push({ name: 'black_zone', passed: false, detail: 'Black Zone files touched — automatic rejection' });
    } else if (validation.protectedPathCheck.red_zone_touched) {
      checks.push({ name: 'red_zone', passed: false, detail: 'Red Zone files touched — requires human approval' });
    } else {
      checks.push({ name: 'protected_paths', passed: true, detail: 'No protected zones touched' });
    }
  }

  // Check 4: Validation score threshold
  if (validation?.score) {
    if (validation.score.overall < 0.70) {
      checks.push({ name: 'fitness', passed: false, detail: `Fitness score ${validation.score.overall.toFixed(3)} < 0.70 threshold` });
    } else if (validation.score.overall < 0.85) {
      checks.push({ name: 'fitness', passed: true, detail: `Fitness score ${validation.score.overall.toFixed(3)} — manual review recommended` });
    } else {
      checks.push({ name: 'fitness', passed: true, detail: `Fitness score ${validation.score.overall.toFixed(3)} >= 0.85` });
    }
  }

  const allPassed = checks.every((c) => c.passed);

  return {
    reviewerAgent,
    implementationAgent,
    decision: allPassed ? 'approve' : 'needs_changes',
    comments: checks.map((c) => `[${c.passed ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`).join('\n'),
    checks,
  };
}
