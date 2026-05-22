import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult } from '@openslack/kernel';

export interface MonitorResult {
  experimentId: string;
  regression: boolean;
  metrics: Record<string, { baseline: number; current: number; delta: number; threshold: number }>;
  recommendation: 'stable' | 'rollback' | 'investigate';
  observations: string[];
}

interface CheckInput {
  name: string;
  result: CheckResult;
  baseline: number;
  threshold: number;
}

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

function checkGenesis(): CheckResult {
  const root = findRepoRoot();
  // Genesis validation uses in-process file checks, no execSync needed
  const checks: Array<{ file: string; label: string }> = [
    { file: 'openslack.yaml', label: 'openslack.yaml' },
    { file: '.openslack/self/constitution.md', label: 'constitution.md' },
    { file: '.openslack/policies/self_evolution.yaml', label: 'self_evolution.yaml' },
    { file: '.openslack/self/invariants.yaml', label: 'invariants.yaml' },
  ];
  const missing = checks.filter((c) => !existsSync(join(root, c.file)));
  if (missing.length > 0) {
    return {
      result: 'fail',
      command: 'genesis-validate',
      findings: missing.map((m) => `missing: ${m.label}`),
    };
  }
  return { result: 'pass', command: 'genesis-validate' };
}

export function monitorPostMerge(
  experimentId: string,
  checks: CheckInput[] = [],
  _windowHours: number = 24,
): MonitorResult {
  const observations: string[] = [];
  let hasRegression = false;
  const metrics: Record<string, { baseline: number; current: number; delta: number; threshold: number }> = {};

  // If checks not provided, run genesis in-process (no execSync)
  const evalChecks = checks.length > 0 ? checks : [
    { name: 'genesis', result: checkGenesis(), baseline: 1, threshold: -0.05 },
  ];

  for (const check of evalChecks) {
    const current = check.result.result === 'pass' ? 1 : 0;
    const delta = current - check.baseline;
    metrics[check.name] = { baseline: check.baseline, current, delta, threshold: check.threshold };

    if (delta < check.threshold) {
      observations.push(`${check.name} degraded: ${delta}`);
      hasRegression = true;
    }
    if (check.result.result === 'fail') {
      observations.push(`${check.name}: ${check.result.command} failed`);
      hasRegression = true;
    }
  }

  return {
    experimentId,
    regression: hasRegression,
    metrics,
    recommendation: hasRegression ? 'rollback' : 'stable',
    observations,
  };
}
