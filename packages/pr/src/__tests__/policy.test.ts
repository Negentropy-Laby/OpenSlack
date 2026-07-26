import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPRReviewPolicy } from '../policy.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-pr-policy-'));
  roots.push(root);
  return root;
}

describe('loadPRReviewPolicy canonical base', () => {
  it('fails closed to main and the historical cutoff when the policy is absent', () => {
    expect(loadPRReviewPolicy(tempRoot())).toMatchObject({
      required_base_ref: 'main',
      effective_after_pr: 296,
    });
  });

  it('loads the required base and audit cutoff from the canonical rule', () => {
    const root = tempRoot();
    const policyDir = join(root, '.openslack', 'policies');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(
      join(policyDir, 'pr_review.yaml'),
      [
        'rules:',
        '  canonical_pr_base:',
        '    enabled: true',
        '    required_base_ref: main',
        '    effective_after_pr: 296',
        '',
      ].join('\n'),
    );

    expect(loadPRReviewPolicy(root)).toMatchObject({
      required_base_ref: 'main',
      effective_after_pr: 296,
    });
  });

  it('pins the canonical rule while preserving independent sibling overrides', () => {
    const root = tempRoot();
    const policyDir = join(root, '.openslack', 'policies');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(
      join(policyDir, 'pr_review.yaml'),
      [
        'rules:',
        '  no_auto_approval:',
        '    enabled: false',
        '  red_zone_human_required:',
        '    enabled: false',
        '  canonical_pr_base:',
        '    enabled: false',
        '    required_base_ref: release/0.3',
        '    effective_after_pr: 999999',
        '',
      ].join('\n'),
    );

    expect(loadPRReviewPolicy(root)).toMatchObject({
      no_auto_approval: false,
      red_zone_human_required: false,
      required_base_ref: 'main',
      effective_after_pr: 296,
    });
  });

  it('loads a complete canonical policy in strict bounded mode', () => {
    const root = tempRoot();
    const policyDir = join(root, '.openslack', 'policies');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(
      join(policyDir, 'pr_review.yaml'),
      [
        'schema: openslack.pr_review_policy.v1',
        'rules:',
        '  no_auto_approval: { enabled: true }',
        '  no_self_review: { enabled: true }',
        '  red_zone_human_required: { enabled: true }',
        '  black_zone_never_merge: { enabled: true }',
        '  canonical_pr_base:',
        '    enabled: true',
        '    required_base_ref: main',
        '    effective_after_pr: 296',
        '',
      ].join('\n'),
    );

    expect(loadPRReviewPolicy(root, { strict: true })).toMatchObject({
      no_auto_approval: true,
      no_self_review: true,
      red_zone_human_required: true,
      black_zone_never_merge: true,
      required_base_ref: 'main',
      effective_after_pr: 296,
    });
  });

  it('fails closed in strict mode for absent, malformed, invalid UTF-8, and oversized policy', () => {
    const absent = tempRoot();
    expect(() => loadPRReviewPolicy(absent, { strict: true })).toThrow(
      'PR_REVIEW_POLICY_UNAVAILABLE',
    );

    for (const body of [
      'schema: openslack.pr_review_policy.v1\nrules: {}\n',
      'schema: [broken',
      Buffer.from([0xc3, 0x28]),
      'x'.repeat(65),
    ]) {
      const root = tempRoot();
      const policyDir = join(root, '.openslack', 'policies');
      mkdirSync(policyDir, { recursive: true });
      writeFileSync(join(policyDir, 'pr_review.yaml'), body);
      expect(() =>
        loadPRReviewPolicy(root, {
          strict: true,
          ...(typeof body === 'string' && body.length === 65 ? { maxBytes: 64 } : {}),
        }),
      ).toThrow('PR_REVIEW_POLICY_UNAVAILABLE');
    }
  });

  it('refuses a policy symbolic link in strict mode when the platform permits links', () => {
    const root = tempRoot();
    const policyDir = join(root, '.openslack', 'policies');
    mkdirSync(policyDir, { recursive: true });
    const target = join(root, 'policy-target.yaml');
    writeFileSync(target, 'schema: openslack.pr_review_policy.v1\nrules: {}\n');
    try {
      symlinkSync(target, join(policyDir, 'pr_review.yaml'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM' && process.platform === 'win32') return;
      throw error;
    }

    expect(() => loadPRReviewPolicy(root, { strict: true })).toThrow(
      'PR_REVIEW_POLICY_UNAVAILABLE',
    );
  });
});
