import { describe, it, expect } from 'vitest';
import { computeFitnessScore } from '../scorecard.js';

describe('computeFitnessScore', () => {
  it('returns pass for all-passing checks', () => {
    const score = computeFitnessScore({
      checks: {
        'unit-tests': { result: 'pass', command: 'bun run test' },
        'integration-tests': { result: 'pass', command: 'bun run test:integration' },
        'typecheck': { result: 'pass', command: 'bun run typecheck' },
        'workspace-validate': { result: 'pass', command: 'openslack workspace validate' },
        'self-eval': { result: 'pass', command: 'openslack self eval' },
        'security-scan': { result: 'pass', command: 'openslack self scan-secrets', findings: [] },
      },
    });
    expect(score.decision).toBe('pass');
    expect(score.overall).toBeGreaterThanOrEqual(0.85);
  });

  it('returns block when tests fail', () => {
    const score = computeFitnessScore({
      checks: {
        'unit-tests': { result: 'fail', command: 'bun run test' },
        'typecheck': { result: 'pass', command: 'bun run typecheck' },
        'workspace-validate': { result: 'pass', command: 'openslack workspace validate' },
        'self-eval': { result: 'pass', command: 'openslack self eval' },
        'security-scan': { result: 'pass', command: 'openslack self scan-secrets', findings: [] },
      },
    });
    expect(score.overall).toBeLessThan(0.85);
    expect(score.dimensions.correctness.score).toBe(0); // unit test failed + no integration test
  });

  it('drops security dimension when secrets found', () => {
    const score = computeFitnessScore({
      checks: {
        'unit-tests': { result: 'pass', command: 'bun run test' },
        'integration-tests': { result: 'pass', command: 'bun run test:integration' },
        'typecheck': { result: 'pass', command: 'bun run typecheck' },
        'workspace-validate': { result: 'pass', command: 'openslack workspace validate' },
        'self-eval': { result: 'pass', command: 'openslack self eval' },
        'security-scan': { result: 'fail', command: 'openslack self scan-secrets', findings: ['API_KEY_LEAK'] },
      },
    });
    expect(score.dimensions.security.score).toBe(0);
    expect(score.overall).toBeLessThan(0.85);
  });

  it('penalizes large diffs', () => {
    const score = computeFitnessScore({
      checks: {
        'unit-tests': { result: 'pass', command: 'bun run test' },
        'typecheck': { result: 'pass', command: 'bun run typecheck' },
        'workspace-validate': { result: 'pass', command: 'openslack workspace validate' },
        'self-eval': { result: 'pass', command: 'openslack self eval' },
        'security-scan': { result: 'pass', command: 'openslack self scan-secrets', findings: [] },
      },
      diffStats: { filesChanged: 15, linesAdded: 600, linesRemoved: 400 },
    });
    expect(score.dimensions.cost.score).toBeLessThan(0.8);
    expect(score.dimensions.simplicity.score).toBeLessThan(0.8);
  });

  it('penalizes new dependencies', () => {
    const score = computeFitnessScore({
      checks: {
        'unit-tests': { result: 'pass', command: 'bun run test' },
        'typecheck': { result: 'pass', command: 'bun run typecheck' },
        'workspace-validate': { result: 'pass', command: 'openslack workspace validate' },
        'self-eval': { result: 'pass', command: 'openslack self eval' },
        'security-scan': { result: 'pass', command: 'openslack self scan-secrets', findings: [] },
      },
      hasNewDependency: true,
    });
    expect(score.dimensions.cost.score).toBe(0.7); // smallDiff(0.5) + noNewDep false (0.2)
  });

  it('returns all six dimensions with weights', () => {
    const score = computeFitnessScore({
      checks: {
        'unit-tests': { result: 'pass', command: 'bun run test' },
        'typecheck': { result: 'pass', command: 'bun run typecheck' },
        'workspace-validate': { result: 'pass', command: 'openslack workspace validate' },
        'self-eval': { result: 'pass', command: 'openslack self eval' },
        'security-scan': { result: 'pass', command: 'openslack self scan-secrets', findings: [] },
      },
    });
    const dims = Object.keys(score.dimensions);
    expect(dims).toContain('correctness');
    expect(dims).toContain('reliability');
    expect(dims).toContain('security');
    expect(dims).toContain('cost');
    expect(dims).toContain('simplicity');
    expect(dims).toContain('developer_experience');
    expect(dims.length).toBe(6);

    // Verify weights
    expect(score.dimensions.correctness.weight).toBe(0.30);
    expect(score.dimensions.reliability.weight).toBe(0.20);
    expect(score.dimensions.security.weight).toBe(0.20);
    expect(score.dimensions.cost.weight).toBe(0.10);
    expect(score.dimensions.simplicity.weight).toBe(0.10);
    expect(score.dimensions.developer_experience.weight).toBe(0.10);
  });
});
