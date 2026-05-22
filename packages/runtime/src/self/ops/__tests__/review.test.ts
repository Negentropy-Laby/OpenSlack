import { describe, it, expect } from 'vitest';
import { reviewPR } from '../review.js';
import type { SelfValidationResult } from '@openslack/kernel';

function makeValidation(overrides: Partial<SelfValidationResult> = {}): SelfValidationResult {
  return {
    experimentId: 'EXP-001',
    prNumber: 1,
    headSha: 'abc123',
    checks: {},
    protectedPathCheck: { result: 'pass', red_zone_touched: false, black_zone_touched: false },
    score: { dimensions: {}, overall: 0.9, decision: 'pass' },
    decision: 'pass',
    ...overrides,
  };
}

describe('reviewPR', () => {
  it('approves when all checks pass', () => {
    const result = reviewPR(1, makeValidation(), 'agent-a', 'agent-b');
    expect(result.decision).toBe('approve');
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('detects self-review', () => {
    const result = reviewPR(1, makeValidation(), 'agent-same', 'agent-same');
    const selfCheck = result.checks.find((c) => c.name === 'independent_review');
    expect(selfCheck?.passed).toBe(false);
    expect(selfCheck?.detail).toContain('cannot review own PR');
  });

  it('fails validation when validation is null', () => {
    const result = reviewPR(1, null, 'agent-a', 'agent-b');
    const valCheck = result.checks.find((c) => c.name === 'validation');
    expect(valCheck?.passed).toBe(false);
  });

  it('fails when validation result is fail', () => {
    const result = reviewPR(1, makeValidation({ decision: 'fail' }), 'agent-a', 'agent-b');
    const valCheck = result.checks.find((c) => c.name === 'validation');
    expect(valCheck?.passed).toBe(false);
  });

  it('detects black zone violation', () => {
    const result = reviewPR(1, makeValidation({
      protectedPathCheck: { result: 'fail', red_zone_touched: false, black_zone_touched: true },
    }), 'agent-a', 'agent-b');
    const blackCheck = result.checks.find((c) => c.name === 'black_zone');
    expect(blackCheck?.passed).toBe(false);
  });

  it('detects red zone violation', () => {
    const result = reviewPR(1, makeValidation({
      protectedPathCheck: { result: 'fail', red_zone_touched: true, black_zone_touched: false },
    }), 'agent-a', 'agent-b');
    const redCheck = result.checks.find((c) => c.name === 'red_zone');
    expect(redCheck?.passed).toBe(false);
    expect(redCheck?.detail).toContain('requires human approval');
  });

  it('blocks when fitness score < 0.70', () => {
    const result = reviewPR(1, makeValidation({
      score: { dimensions: {}, overall: 0.5, decision: 'block' },
    }), 'agent-a', 'agent-b');
    const fitnessCheck = result.checks.find((c) => c.name === 'fitness');
    expect(fitnessCheck?.passed).toBe(false);
  });

  it('warns when fitness score is between 0.70 and 0.85', () => {
    const result = reviewPR(1, makeValidation({
      score: { dimensions: {}, overall: 0.75, decision: 'review' },
    }), 'agent-a', 'agent-b');
    const fitnessCheck = result.checks.find((c) => c.name === 'fitness');
    expect(fitnessCheck?.passed).toBe(true);
    expect(fitnessCheck?.detail).toContain('manual review recommended');
  });
});
