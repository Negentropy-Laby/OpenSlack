import { describe, it, expect } from 'vitest';
import { checkMergeReadiness } from '../readiness.js';
import type { PRReviewReport, PRReviewPolicy } from '../types.js';

function makeReport(overrides: Partial<PRReviewReport> = {}): PRReviewReport {
  return {
    prNumber: 1,
    title: 'Test PR',
    author: 'test-agent',
    state: 'open',
    draft: false,
    baseRef: 'main',
    riskZone: 'green',
    changedFiles: [],
    checks: [],
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

describe('checkMergeReadiness', () => {
  it('blocks black zone PRs', () => {
    const report = makeReport({ riskZone: 'black' });
    const result = checkMergeReadiness(report, DEFAULT_POLICY);
    expect(result.decision).toBe('BLOCKED_BLACK_ZONE');
  });

  it('allows green zone with passing checks', () => {
    const report = makeReport({
      riskZone: 'green',
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    });
    const result = checkMergeReadiness(report, DEFAULT_POLICY);
    expect(result.decision).toBe('READY_TO_MERGE');
  });

  it('blocks when checks are pending', () => {
    const report = makeReport({
      riskZone: 'green',
      checks: [{ name: 'test', status: 'in_progress', conclusion: null }],
    });
    const result = checkMergeReadiness(report, DEFAULT_POLICY);
    expect(result.decision).toBe('CHECKS_PENDING');
  });

  it('blocks when checks fail', () => {
    const report = makeReport({
      riskZone: 'green',
      checks: [{ name: 'test', status: 'completed', conclusion: 'failure' }],
    });
    const result = checkMergeReadiness(report, DEFAULT_POLICY);
    expect(result.decision).toBe('CHECKS_FAILED');
  });

  it('requires human approval for red zone', () => {
    const report = makeReport({
      riskZone: 'red',
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    });
    const result = checkMergeReadiness(report, DEFAULT_POLICY);
    expect(result.decision).toBe('NEEDS_HUMAN_APPROVAL');
  });

  it('allows red zone with human approval', () => {
    const report = makeReport({
      riskZone: 'red',
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      humanApprovals: [{ user: 'wsman' }],
    });
    const result = checkMergeReadiness(report, DEFAULT_POLICY);
    expect(result.decision).toBe('READY_TO_MERGE');
  });

  it('allows yellow zone with passing checks', () => {
    const report = makeReport({
      riskZone: 'yellow',
      checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
    });
    const result = checkMergeReadiness(report, DEFAULT_POLICY);
    expect(result.decision).toBe('READY_TO_MERGE');
  });

  it('allows black zone when policy is disabled', () => {
    const report = makeReport({ riskZone: 'black' });
    const policy = { ...DEFAULT_POLICY, black_zone_never_merge: false };
    // With black policy disabled and no checks, it should proceed to READY
    // But black zone classification already blocked it before readiness check
    // This test verifies policy override works at readiness layer
    const result = checkMergeReadiness(report, policy);
    expect(result.decision).not.toBe('BLOCKED_BLACK_ZONE');
  });

  it('treats skipped checks as passing', () => {
    const report = makeReport({
      riskZone: 'green',
      checks: [
        { name: 'canary', status: 'completed', conclusion: 'success' },
        { name: 'validate', status: 'completed', conclusion: 'success' },
        { name: 'on-pr-merged', status: 'completed', conclusion: 'skipped' },
      ],
    });
    const result = checkMergeReadiness(report, DEFAULT_POLICY);
    expect(result.decision).toBe('READY_TO_MERGE');
  });
});
