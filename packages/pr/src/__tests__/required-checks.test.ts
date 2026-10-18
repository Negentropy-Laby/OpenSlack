import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { diagnosePR } from '../doctor.js';
import { checkMergeReadiness } from '../readiness.js';
import { loadPRReviewPolicy } from '../policy.js';
import { generateDoctorReport } from '../doctor-report.js';
import type { PRReviewPolicy, PRReviewReport } from '../types.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const policy = {
  no_auto_approval: true,
  no_self_review: true,
  red_zone_human_required: true,
  black_zone_never_merge: true,
  required_base_ref: 'main',
  effective_after_pr: 296,
  required_check_contexts: {
    green: ['validate / validate'],
    yellow: ['validate / validate'],
    red: ['validate / validate'],
  },
} satisfies PRReviewPolicy & { required_check_contexts: Record<string, string[]> };

function report(checks: PRReviewReport['checks']): PRReviewReport {
  return {
    prNumber: 423,
    title: 'governed policy',
    author: 'openslack-agent-operator[bot]',
    state: 'open',
    draft: false,
    baseRef: 'main',
    headSha: 'current',
    riskZone: 'red',
    changedFiles: ['.openslack/policies/pr-cleanup-policy.json'],
    checks,
    reviews: [{ user: 'wsman', state: 'APPROVED', commitOid: 'current' }],
    humanApprovals: [{ user: 'wsman' }],
    decision: 'ANALYZED',
    reason: '',
    recommendation: '',
    mergeable: true,
  };
}

describe.each([
  ['PR doctor', (r: PRReviewReport) => diagnosePR(r, policy, ['@wsman'])],
  ['readiness', (r: PRReviewReport) => checkMergeReadiness(r, policy)],
] as const)('%s required check enforcement', (_name, evaluate) => {
  it('refuses an absent required context despite unrelated green checks and human approval', () => {
    const result = evaluate(
      report([{ name: 'unrelated', status: 'completed', conclusion: 'success' }]),
    );
    expect(result.decision).toBe('CHECKS_PENDING');
    expect(result.reason).toContain('validate / validate');
  });

  it.each(['skipped', 'neutral', 'failure', 'timed_out', 'cancelled', null])(
    'refuses a required result of %s',
    (conclusion) => {
      const result = evaluate(
        report([{ name: 'validate / validate', status: 'completed', conclusion }]),
      );
      expect(result.decision).toBe('CHECKS_FAILED');
    },
  );

  it('refuses ambiguous duplicate required contexts', () => {
    const check = { name: 'validate / validate', status: 'completed', conclusion: 'success' };
    expect(evaluate(report([check, check])).decision).toBe('BLOCKED_POLICY');
  });

  it('accepts exactly one completed successful required context', () => {
    expect(
      evaluate(
        report([{ name: 'validate / validate', status: 'completed', conclusion: 'success' }]),
      ).decision,
    ).toBe('READY_TO_MERGE');
  });
});

it('does not print checks PASS when an unreported required control blocks the doctor', () => {
  const result = diagnosePR(
    report([{ name: 'unrelated', status: 'completed', conclusion: 'success' }]),
    policy,
    ['@wsman'],
  );
  expect(generateDoctorReport(result, ['@wsman'])).toContain('| Checks | pending |');
});

it('prints ambiguous required check producers as failure rather than PASS', () => {
  const check = { name: 'validate / validate', status: 'completed', conclusion: 'success' };
  const result = diagnosePR(report([check, check]), policy, ['@wsman']);
  expect(result.decision).toBe('BLOCKED_POLICY');
  expect(generateDoctorReport(result, ['@wsman'])).toContain('| Checks | fail |');
});

it.each([null, [], false, 'disabled', { enabled: false }])(
  'refuses a malformed declared rule without an approval matrix: %j',
  (requiredRule) => {
    const temporary = mkdtempSync(join(tmpdir(), 'pr-required-rule-'));
    try {
      const path = join(temporary, '.openslack/policies');
      mkdirSync(path, { recursive: true });
      const review = parse(readFileSync(join(root, '.openslack/policies/pr_review.yaml'), 'utf8'));
      review.rules.required_checks = requiredRule;
      writeFileSync(join(path, 'pr_review.yaml'), JSON.stringify(review));
      expect(() => loadPRReviewPolicy(temporary, { strict: true })).toThrow(
        'PR_REVIEW_POLICY_UNAVAILABLE',
      );
      expect(() => loadPRReviewPolicy(temporary)).toThrow('PR_REVIEW_POLICY_UNAVAILABLE');
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  },
);

it.each([
  'rules: [unterminated',
  'rules:\n  required_checks: { enabled: true, checks: [classify] }\n  required_checks: null\n',
  'null',
])('refuses malformed existing policy instead of zero-check defaults: %s', (raw) => {
  const temporary = mkdtempSync(join(tmpdir(), 'pr-malformed-rule-'));
  try {
    const path = join(temporary, '.openslack/policies');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'pr_review.yaml'), raw);
    expect(() => loadPRReviewPolicy(temporary)).toThrow('PR_REVIEW_POLICY_UNAVAILABLE');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

it('loads the repository logical-control mapping into enforced current CI contexts', () => {
  const loaded = loadPRReviewPolicy(root, { strict: true });
  expect(loaded).toHaveProperty('required_check_contexts.red');
  expect((loaded as typeof policy).required_check_contexts.red).toEqual([
    'classify',
    'validate / validate',
    'canary',
    'canonical-base',
  ]);
});

it('retains all seven logical Red controls and binds them to actual mandatory producer steps', () => {
  const approval = parse(readFileSync(join(root, '.openslack/policies/approvals.yaml'), 'utf8'));
  const evolution = parse(
    readFileSync(join(root, '.openslack/policies/self_evolution.yaml'), 'utf8'),
  );
  for (const zone of ['green', 'yellow', 'red']) {
    expect(approval.approval_matrix[`${zone}_zone_merge`].required_checks).toEqual(
      evolution.merge_rules[zone].required_checks.map((name: string) =>
        name.replace(/^openslack\//, ''),
      ),
    );
  }
  expect(approval.approval_matrix.red_zone_merge.required_checks).toHaveLength(7);
  for (const control of approval.approval_matrix.red_zone_merge.required_checks) {
    const binding = approval.check_bindings[control];
    expect(binding.context).toBe('validate / validate');
    const workflow = parse(readFileSync(join(root, binding.workflow), 'utf8'));
    const producer = workflow.jobs[binding.job].steps.filter(
      (step: { name?: string }) => step.name === binding.step,
    );
    expect(producer, control).toHaveLength(1);
    expect(producer[0].run, control).toBeTruthy();
    expect(producer[0].if, control).toBeUndefined();
    expect(producer[0]['continue-on-error'], control).not.toBe(true);
  }
  const workflow = parse(
    readFileSync(join(root, '.github/workflows/openslack-reusable-validate.yml'), 'utf8'),
  );
  const audit = workflow.jobs.validate.steps.find(
    (step: { name?: string }) => step.name === 'Committed cleanup policy audit',
  );
  expect(audit.run).toBe('go test ./internal/permit -count=1');
});

it.each([
  'missing mapping',
  'unknown control',
  'empty required set',
  'invalid context',
  'duplicate control',
  'disabled rule',
])('refuses %s without permissive fallback', (mutation) => {
  const temporary = mkdtempSync(join(tmpdir(), 'pr-required-checks-'));
  try {
    const path = join(temporary, '.openslack/policies');
    mkdirSync(path, { recursive: true });
    const approval = parse(readFileSync(join(root, '.openslack/policies/approvals.yaml'), 'utf8'));
    const review = parse(readFileSync(join(root, '.openslack/policies/pr_review.yaml'), 'utf8'));
    if (mutation === 'missing mapping') delete approval.check_bindings;
    if (mutation === 'unknown control')
      approval.approval_matrix.red_zone_merge.required_checks.push('unproduced');
    if (mutation === 'empty required set')
      approval.approval_matrix.red_zone_merge.required_checks = [];
    if (mutation === 'invalid context') approval.check_bindings['policy-audit'].context = ' ';
    if (mutation === 'duplicate control')
      approval.approval_matrix.red_zone_merge.required_checks.push('policy-audit');
    if (mutation === 'disabled rule') review.rules.required_checks.enabled = false;
    writeFileSync(join(path, 'approvals.yaml'), JSON.stringify(approval));
    writeFileSync(join(path, 'pr_review.yaml'), JSON.stringify(review));
    expect(() => loadPRReviewPolicy(temporary, { strict: true })).toThrow(
      'PR_REVIEW_POLICY_UNAVAILABLE',
    );
    expect(() => loadPRReviewPolicy(temporary)).toThrow('PR_REVIEW_POLICY_UNAVAILABLE');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
