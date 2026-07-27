import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { parse } from 'yaml';
import type { PRReviewPolicy } from './types.js';
import { CANONICAL_PR_BASE_EFFECTIVE_AFTER_PR, CANONICAL_PR_BASE_REF } from './base-policy.js';

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
  required_base_ref: CANONICAL_PR_BASE_REF,
  effective_after_pr: CANONICAL_PR_BASE_EFFECTIVE_AFTER_PR,
};

const DEFAULT_MAX_POLICY_BYTES = 256 * 1024;

export interface LoadPRReviewPolicyOptions {
  strict?: boolean;
  maxBytes?: number;
}

function policyUnavailable(): never {
  throw new Error('PR_REVIEW_POLICY_UNAVAILABLE');
}

function readPolicySnapshot(path: string, maxBytes: number): string | null {
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) policyUnavailable();
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== entry.dev ||
      before.ino !== entry.ino ||
      before.mode !== entry.mode ||
      before.size > BigInt(maxBytes)
    ) {
      policyUnavailable();
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > maxBytes) policyUnavailable();
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      BigInt(bytesRead) !== after.size
    ) {
      policyUnavailable();
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      policyUnavailable();
    }
  } finally {
    closeSync(descriptor);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function strictPolicyRules(parsed: unknown): Record<string, Record<string, unknown>> {
  const document = record(parsed);
  const rules = record(document?.rules);
  if (document?.schema !== 'openslack.pr_review_policy.v1' || !rules) policyUnavailable();
  const requiredRules = [
    'no_auto_approval',
    'no_self_review',
    'red_zone_human_required',
    'black_zone_never_merge',
  ] as const;
  const output: Record<string, Record<string, unknown>> = {};
  for (const name of requiredRules) {
    const rule = record(rules[name]);
    if (!rule || typeof rule.enabled !== 'boolean') policyUnavailable();
    output[name] = rule;
  }
  const canonical = record(rules.canonical_pr_base);
  if (
    !canonical ||
    canonical.enabled !== true ||
    canonical.required_base_ref !== CANONICAL_PR_BASE_REF ||
    canonical.effective_after_pr !== CANONICAL_PR_BASE_EFFECTIVE_AFTER_PR
  ) {
    policyUnavailable();
  }
  output.canonical_pr_base = canonical;
  return output;
}

export function loadPRReviewPolicy(
  rootDir?: string,
  options: LoadPRReviewPolicyOptions = {},
): PRReviewPolicy {
  const root = rootDir ?? findRepoRoot();
  const policyPath = join(root, '.openslack', 'policies', 'pr_review.yaml');
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_POLICY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024) {
    throw new TypeError('maxBytes must be an integer between 1 and 2097152.');
  }
  try {
    const raw = readPolicySnapshot(policyPath, maxBytes);
    if (raw === null) {
      if (options.strict) policyUnavailable();
      return DEFAULT_POLICY;
    }
    const parsed = parse(raw);
    const rules = options.strict ? strictPolicyRules(parsed) : record(record(parsed)?.rules) || {};
    return {
      no_auto_approval: record(rules.no_auto_approval)?.enabled !== false,
      no_self_review: record(rules.no_self_review)?.enabled !== false,
      red_zone_human_required: record(rules.red_zone_human_required)?.enabled !== false,
      black_zone_never_merge: record(rules.black_zone_never_merge)?.enabled !== false,
      required_base_ref: CANONICAL_PR_BASE_REF,
      effective_after_pr: CANONICAL_PR_BASE_EFFECTIVE_AFTER_PR,
    };
  } catch {
    if (options.strict) policyUnavailable();
    return DEFAULT_POLICY;
  }
}
