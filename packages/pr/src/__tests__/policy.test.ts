import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
});
