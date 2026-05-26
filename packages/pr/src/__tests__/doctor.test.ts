import { describe, it, expect } from 'vitest';
import { diagnosePR } from '../doctor.js';
import { generateDoctorReport } from '../doctor-report.js';
import type { PRReviewReport, PRReviewPolicy } from '../types.js';

function makeReport(overrides: Partial<PRReviewReport> = {}): PRReviewReport {
  return {
    prNumber: 1,
    title: 'Test PR',
    author: 'wsman',
    state: 'open',
    draft: false,
    baseRef: 'main',
    riskZone: 'green',
    changedFiles: ['docs/readme.md'],
    checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    reviews: [],
    humanApprovals: [],
    decision: 'ANALYZED',
    reason: '',
    recommendation: '',
    mergeable: true,
    ...overrides,
  };
}

const DEFAULT_POLICY: PRReviewPolicy = {
  no_auto_approval: true,
  no_self_review: true,
  red_zone_human_required: true,
  black_zone_never_merge: true,
};

describe('diagnosePR', () => {
  it('blocks draft PRs', () => {
    const report = makeReport({ draft: true });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('BLOCKED_DRAFT');
  });

  it('blocks closed PRs', () => {
    const report = makeReport({ state: 'closed' });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('BLOCKED_POLICY');
  });

  it('blocks merge conflicts', () => {
    const report = makeReport({ mergeable: false });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('BLOCKED_POLICY');
  });

  it('blocks black zone PRs', () => {
    const report = makeReport({ riskZone: 'black' });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('BLOCKED_BLACK_ZONE');
  });

  it('blocks when checks are pending', () => {
    const report = makeReport({
      checks: [{ name: 'ci', status: 'in_progress', conclusion: null }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('CHECKS_PENDING');
  });

  it('blocks when checks fail', () => {
    const report = makeReport({
      checks: [{ name: 'ci', status: 'completed', conclusion: 'failure' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('CHECKS_FAILED');
  });

  it('blocks author-is-sole-codeowner deadlock', () => {
    const report = makeReport({
      riskZone: 'red',
      changedFiles: ['.github/workflows/ci.yml'],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, ['@wsman']);
    expect(result.decision).toBe('BLOCKED_AUTHOR_IS_SOLE_CODEOWNER');
  });

  it('blocks self-review', () => {
    const report = makeReport({
      reviews: [{ user: 'wsman', state: 'APPROVED' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('BLOCKED_SELF_REVIEW');
  });

  it('needs human approval when none exist', () => {
    const report = makeReport();
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('NEEDS_HUMAN_APPROVAL');
  });

  it('ignores bot approvals and needs human approval', () => {
    const report = makeReport({
      reviews: [{ user: 'dependabot[bot]', state: 'APPROVED' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('BOT_APPROVAL_IGNORED');
  });

  it('needs CODEOWNER approval for red zone', () => {
    const report = makeReport({
      author: 'bob',
      riskZone: 'red',
      changedFiles: ['.github/workflows/ci.yml'],
      reviews: [{ user: 'alice', state: 'APPROVED' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, ['@wsman', '@bob']);
    expect(result.decision).toBe('NEEDS_CODEOWNER_APPROVAL');
  });

  it('allows green zone with passing checks and valid approval', () => {
    const report = makeReport({
      reviews: [{ user: 'alice', state: 'APPROVED' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('READY_TO_MERGE');
  });

  it('allows yellow zone with passing checks and valid approval', () => {
    const report = makeReport({
      riskZone: 'yellow',
      changedFiles: ['apps/cli/src/index.ts'],
      reviews: [{ user: 'alice', state: 'APPROVED' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, []);
    expect(result.decision).toBe('READY_TO_MERGE');
  });

  it('allows red zone with CODEOWNER approval', () => {
    const report = makeReport({
      author: 'bob',
      riskZone: 'red',
      changedFiles: ['.github/workflows/ci.yml'],
      reviews: [{ user: 'alice', state: 'APPROVED' }],
    });
    const result = diagnosePR(report, DEFAULT_POLICY, ['@wsman', '@alice']);
    expect(result.decision).toBe('READY_TO_MERGE');
  });

  it('allows red zone when policy does not require human approval', () => {
    const report = makeReport({
      author: 'bob',
      riskZone: 'red',
      changedFiles: ['.github/workflows/ci.yml'],
      reviews: [{ user: 'alice', state: 'APPROVED' }],
    });
    const policy = { ...DEFAULT_POLICY, red_zone_human_required: false };
    const result = diagnosePR(report, policy, ['@wsman', '@alice']);
    // Without red_zone_human_required, it skips the codeowner approval gate
    expect(result.decision).toBe('READY_TO_MERGE');
  });
});

describe('generateDoctorReport', () => {
  it('renders skipped checks with skip icon', () => {
    const report = makeReport({
      checks: [
        { name: 'canary', status: 'completed', conclusion: 'success' },
        { name: 'on-pr-merged', status: 'completed', conclusion: 'skipped' },
      ],
    });
    const md = generateDoctorReport(report, []);
    expect(md).toContain('⏭️');
    expect(md).toContain('on-pr-merged');
    expect(md).not.toContain('❌');
  });
});
