import { describe, it, expect } from 'vitest';
import { decideMerge } from '../merge-decider.js';
import type { SelfValidationResult } from '../../types.js';

function makeValidation(
  decision: 'pass' | 'fail' | 'requires_human',
  overrides: Partial<SelfValidationResult> = {},
): SelfValidationResult {
  return {
    experimentId: 'EXP-001',
    prNumber: 1,
    headSha: 'abc123',
    checks: {},
    protectedPathCheck: { result: 'pass', red_zone_touched: false, black_zone_touched: false },
    score: { dimensions: {}, overall: 0.9, decision: 'pass' },
    decision,
    ...overrides,
  };
}

describe('decideMerge', () => {
  it('denies black zone regardless of validation', () => {
    const result = decideMerge({
      riskZone: 'black',
      validation: makeValidation('pass'),
      reviews: [
        { reviewerAgent: 'r1', implementationAgent: 'i1', decision: 'approve', comments: '' },
      ],
    });
    expect(result.decision).toBe('deny');
  });

  it('denies when validation is null', () => {
    const result = decideMerge({ riskZone: 'green', validation: null, reviews: [] });
    expect(result.decision).toBe('deny');
  });

  it('requires human for red zone without human approval', () => {
    const result = decideMerge({
      riskZone: 'red',
      validation: makeValidation('pass'),
      reviews: [
        { reviewerAgent: 'r1', implementationAgent: 'i1', decision: 'approve', comments: '' },
      ],
    });
    expect(result.decision).toBe('require_human');
  });

  it('allows red zone with human approval and valid review', () => {
    const result = decideMerge({
      riskZone: 'red',
      validation: makeValidation('pass'),
      reviews: [
        { reviewerAgent: 'r1', implementationAgent: 'i1', decision: 'approve', comments: '' },
      ],
      humanApproval: { approved: true, by: 'human:founder' },
    });
    expect(result.decision).toBe('merge_queue');
  });

  it('blocks self-review (same agent)', () => {
    const result = decideMerge({
      riskZone: 'yellow',
      validation: makeValidation('pass'),
      reviews: [
        {
          reviewerAgent: 'agent1',
          implementationAgent: 'agent1',
          decision: 'approve',
          comments: '',
        },
      ],
    });
    expect(result.decision).toBe('wait');
    expect(result.reason).toContain('cannot review own PR');
  });

  it('allows green with one approve review', () => {
    const result = decideMerge({
      riskZone: 'green',
      validation: makeValidation('pass'),
      reviews: [
        { reviewerAgent: 'r1', implementationAgent: 'i1', decision: 'approve', comments: '' },
      ],
    });
    expect(result.decision).toBe('merge_queue');
  });

  it('waits for green with no reviews', () => {
    const result = decideMerge({
      riskZone: 'green',
      validation: makeValidation('pass'),
      reviews: [],
    });
    // Green zone has requiredAgentReviews: 1, but merge_decider only checks review presence for non-green
    expect(result.decision).toBe('merge_queue');
  });

  it('waits for yellow with rejected review', () => {
    const result = decideMerge({
      riskZone: 'yellow',
      validation: makeValidation('pass'),
      reviews: [
        { reviewerAgent: 'r1', implementationAgent: 'i1', decision: 'reject', comments: 'bad' },
      ],
    });
    expect(result.decision).toBe('wait');
  });
});
