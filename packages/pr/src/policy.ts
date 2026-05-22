import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { PRReviewPolicy } from './types.js';

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

const DEFAULT_POLICY: PRReviewPolicy = {
  no_auto_approval: true,
  no_self_review: true,
  red_zone_human_required: true,
  black_zone_never_merge: true,
};

export function loadPRReviewPolicy(): PRReviewPolicy {
  const root = findRepoRoot();
  const policyPath = join(root, '.openslack', 'policies', 'pr_review.yaml');
  if (!existsSync(policyPath)) {
    return DEFAULT_POLICY;
  }
  try {
    const raw = readFileSync(policyPath, 'utf-8');
    const parsed = parse(raw);
    const rules = parsed?.rules || {};
    return {
      no_auto_approval: rules.no_auto_approval?.enabled ?? true,
      no_self_review: rules.no_self_review?.enabled ?? true,
      red_zone_human_required: rules.red_zone_human_required?.enabled ?? true,
      black_zone_never_merge: rules.black_zone_never_merge?.enabled ?? true,
    };
  } catch {
    return DEFAULT_POLICY;
  }
}
