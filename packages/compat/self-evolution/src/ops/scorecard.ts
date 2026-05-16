import type { FitnessScore, CheckResult } from '../types.js';

interface ScoreInput {
  checks: Record<string, CheckResult>;
  diffStats?: { filesChanged: number; linesAdded: number; linesRemoved: number };
  hasNewDependency?: boolean;
}

export function computeFitnessScore(input: ScoreInput): FitnessScore {
  const dimensions: Record<string, { weight: number; score: number; evidence: string[] }> = {};

  // Correctness (0.30) — unit tests + integration tests
  const unitPassed = input.checks['unit-tests']?.result === 'pass';
  const integrationPassed = input.checks['integration-tests']?.result === 'pass';
  const correctnessScore = (unitPassed ? 0.6 : 0) + (integrationPassed ? 0.4 : 0);
  dimensions.correctness = {
    weight: 0.30,
    score: correctnessScore,
    evidence: [unitPassed ? 'unit_tests_passed' : 'unit_tests_failed', integrationPassed ? 'integration_tests_passed' : 'integration_tests_skipped'],
  };

  // Reliability (0.20) — self eval + workspace validate
  const evalPassed = input.checks['self-eval']?.result === 'pass';
  const wsPassed = input.checks['workspace-validate']?.result === 'pass';
  const reliabilityScore = (evalPassed ? 0.5 : 0) + (wsPassed ? 0.5 : 0);
  dimensions.reliability = {
    weight: 0.20,
    score: reliabilityScore,
    evidence: [evalPassed ? 'self_eval_passed' : 'self_eval_failed', wsPassed ? 'workspace_valid' : 'workspace_invalid'],
  };

  // Security (0.20) — security scan + black zone check
  const securityPassed = input.checks['security-scan']?.result === 'pass';
  const noSecrets = !input.checks['security-scan']?.findings?.length;
  const securityScore = (securityPassed ? 0.5 : 0) + (noSecrets ? 0.5 : 0);
  dimensions.security = {
    weight: 0.20,
    score: securityScore,
    evidence: [securityPassed ? 'security_scan_clean' : 'security_scan_failed', noSecrets ? 'no_secret_findings' : 'secrets_found'],
  };

  // Cost (0.10) — diff size + no new dependencies
  const smallDiff = input.diffStats ? input.diffStats.linesAdded + input.diffStats.linesRemoved < 500 : true;
  const noNewDep = !input.hasNewDependency;
  const costScore = (smallDiff ? 0.5 : 0.2) + (noNewDep ? 0.5 : 0.2);
  dimensions.cost = {
    weight: 0.10,
    score: costScore,
    evidence: [smallDiff ? 'small_diff' : 'large_diff', noNewDep ? 'no_new_dependency' : 'new_dependency_added'],
  };

  // Simplicity (0.10) — small diff + few files
  const fewFiles = input.diffStats ? input.diffStats.filesChanged < 10 : true;
  const simplicityScore = (fewFiles ? 0.5 : 0.2) + (smallDiff ? 0.5 : 0.2);
  dimensions.simplicity = {
    weight: 0.10,
    score: simplicityScore,
    evidence: [fewFiles ? 'few_files_changed' : 'many_files_changed'],
  };

  // Developer Experience (0.10) — typecheck passed
  const typecheckPassed = input.checks['typecheck']?.result === 'pass';
  const dxScore = typecheckPassed ? 1.0 : 0.3;
  dimensions.developer_experience = {
    weight: 0.10,
    score: dxScore,
    evidence: [typecheckPassed ? 'typecheck_passed' : 'typecheck_failed'],
  };

  const overall = Object.values(dimensions).reduce((sum, d) => sum + d.weight * d.score, 0);
  const decision = overall >= 0.85 ? 'pass' : overall >= 0.70 ? 'review' : 'block';

  return { dimensions, overall: Math.round(overall * 1000) / 1000, decision };
}
