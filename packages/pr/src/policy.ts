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
  required_base_ref: 'main',
  effective_after_pr: 296,
};

export function loadPRReviewPolicy(rootDir?: string): PRReviewPolicy {
  const root = rootDir ?? findRepoRoot();
  const policyPath = join(root, '.openslack', 'policies', 'pr_review.yaml');
  if (!existsSync(policyPath)) {
    return DEFAULT_POLICY;
  }
  try {
    const raw = readFileSync(policyPath, 'utf-8');
    const parsed = parse(raw);
    const rules = parsed?.rules || {};
    const canonicalBase = rules.canonical_pr_base;
    if (canonicalBase?.enabled === false) return DEFAULT_POLICY;
    const requiredBaseRef =
      typeof canonicalBase?.required_base_ref === 'string' &&
      canonicalBase.required_base_ref.trim().length > 0
        ? canonicalBase.required_base_ref.trim()
        : DEFAULT_POLICY.required_base_ref;
    const effectiveAfterPR = Number.isSafeInteger(canonicalBase?.effective_after_pr)
      ? canonicalBase.effective_after_pr
      : DEFAULT_POLICY.effective_after_pr;
    return {
      no_auto_approval: rules.no_auto_approval?.enabled ?? true,
      no_self_review: rules.no_self_review?.enabled ?? true,
      red_zone_human_required: rules.red_zone_human_required?.enabled ?? true,
      black_zone_never_merge: rules.black_zone_never_merge?.enabled ?? true,
      required_base_ref: requiredBaseRef,
      effective_after_pr: effectiveAfterPR,
    };
  } catch {
    return DEFAULT_POLICY;
  }
}
