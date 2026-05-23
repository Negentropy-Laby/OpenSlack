import { describe, it, expect } from 'vitest';
import { classifyPRReport } from '../classify.js';
import type { PRReviewReport } from '../types.js';

function makeReport(changedFiles: string[]): PRReviewReport {
  return {
    prNumber: 1,
    title: 'Test PR',
    author: 'test-agent',
    state: 'open',
    draft: false,
    baseRef: 'main',
    riskZone: 'green',
    changedFiles,
    checks: [],
    reviews: [],
    humanApprovals: [],
    decision: 'DISCOVERED',
    reason: '',
    recommendation: '',
    mergeable: true,
  };
}

describe('classifyPRReport', () => {
  it('classifies docs-only changes as green', () => {
    const report = classifyPRReport(makeReport(['docs/readme.md']));
    expect(report.riskZone).toBe('green');
    expect(report.decision).toBe('ANALYZED');
  });

  it('classifies .github workflow changes as red', () => {
    const report = classifyPRReport(makeReport(['.github/workflows/test.yml']));
    expect(report.riskZone).toBe('red');
    expect(report.decision).toBe('NEEDS_HUMAN_APPROVAL');
  });

  it('classifies app code changes as yellow', () => {
    const report = classifyPRReport(makeReport(['apps/cli/src/index.ts']));
    expect(report.riskZone).toBe('yellow');
    expect(report.decision).toBe('ANALYZED');
  });

  it('classifies .env as black', () => {
    const report = classifyPRReport(makeReport(['.env']));
    expect(report.riskZone).toBe('black');
    expect(report.decision).toBe('BLOCKED_BLACK_ZONE');
  });

  it('returns most restrictive zone for mixed paths', () => {
    const report = classifyPRReport(makeReport(['docs/readme.md', '.github/workflows/test.yml']));
    expect(report.riskZone).toBe('red');
  });

  it('black wins over red in mixed paths', () => {
    const report = classifyPRReport(makeReport(['.github/workflows/test.yml', '.env']));
    expect(report.riskZone).toBe('black');
  });
});
