import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { classifyPaths } from '@openslack/kernel';
import { validateWorkspace } from '@openslack/workspace';
import { computeFitnessScore } from './scorecard.js';
import { stringify } from 'yaml';
import type { SelfValidationResult, CheckResult, ProtectedPathResult } from '@openslack/kernel';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openslack.yaml'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function validatePR(options: {
  prNumber: number;
  headSha: string;
  changedPaths: string[];
  agentId: string;
  experimentId: string;
}): SelfValidationResult {
  const root = findRepoRoot();
  const riskZone = classifyPaths(options.changedPaths);

  // Workspace validation
  let wsResult: { pass: boolean; errors: string[] };
  try {
    const vr = validateWorkspace(root);
    wsResult = { pass: vr.valid, errors: vr.errors.map((e) => e.message) };
  } catch {
    wsResult = { pass: false, errors: ['validateWorkspace threw an error'] };
  }

  // Red zone check
  const hasRed = riskZone === 'red';
  const hasBlack = riskZone === 'black';
  const protectedPathCheck: ProtectedPathResult = {
    result: hasBlack ? 'fail' : 'pass',
    red_zone_touched: hasRed,
    black_zone_touched: hasBlack,
  };

  // Build check results
  const checks: Record<string, CheckResult> = {};
  checks['workspace-validate'] = {
    result: wsResult.pass ? 'pass' : 'fail',
    command: 'openslack workspace validate',
    findings: wsResult.pass ? [] : wsResult.errors,
  };
  checks['zone-classification'] = {
    result: hasBlack ? 'fail' : 'pass',
    command: 'openslack self classify-pr',
  };
  checks['protected-paths'] = {
    result: hasBlack ? 'fail' : 'pass',
    command: 'openslack self validate',
  };

  // Compute fitness score
  const score = computeFitnessScore({ checks });

  // Write self_validation.yaml
  const experimentDir = join(root, '.openslack', 'self', 'experiments', options.experimentId);
  mkdirSync(experimentDir, { recursive: true });
  const manifest: Record<string, unknown> = {
    schema: 'openslack.self_validation.v1',
    experiment_id: options.experimentId,
    pr: { number: options.prNumber, head_sha: options.headSha },
    agent_id: options.agentId,
    summary: {
      result: riskZone === 'black' ? 'fail' : (wsResult.pass ? 'pass' : 'fail'),
      risk_level: riskZone,
      human_approval_required: riskZone === 'red',
      auto_merge_candidate: riskZone === 'green',
    },
    checks: Object.fromEntries(
      Object.entries(checks).map(([k, v]) => [k, { result: v.result, command: v.command }]),
    ),
    protected_path_check: protectedPathCheck,
    score: { overall: score.overall, decision: score.decision, dimensions: score.dimensions },
    decision: riskZone === 'black' ? 'deny' : riskZone === 'red' ? 'require_human' : 'merge_queue',
    generated_at: new Date().toISOString(),
  };

  // Write YAML (yaml is a hard dependency)
  writeFileSync(join(experimentDir, 'self_validation.yaml'), stringify(manifest, { lineWidth: 120 }), 'utf-8');

  return {
    experimentId: options.experimentId,
    prNumber: options.prNumber,
    headSha: options.headSha,
    checks,
    protectedPathCheck,
    score,
    decision: riskZone === 'black' ? 'fail' : (wsResult.pass ? 'pass' : 'fail'),
  };
}
