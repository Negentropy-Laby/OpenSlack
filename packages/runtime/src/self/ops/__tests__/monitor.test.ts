import { describe, it, expect } from 'vitest';
import { monitorPostMerge } from '../monitor.js';
import type { CheckResult } from '@openslack/kernel';

function pass(name: string): { name: string; result: CheckResult; baseline: number; threshold: number } {
  return { name, result: { result: 'pass', command: name }, baseline: 1, threshold: -0.05 };
}

function fail(name: string): { name: string; result: CheckResult; baseline: number; threshold: number } {
  return { name, result: { result: 'fail', command: name }, baseline: 1, threshold: -0.05 };
}

describe('monitorPostMerge', () => {
  it('returns stable when all checks pass', () => {
    const result = monitorPostMerge('EXP-001', [pass('typecheck'), pass('tests')]);
    expect(result.regression).toBe(false);
    expect(result.recommendation).toBe('stable');
    expect(result.experimentId).toBe('EXP-001');
    expect(result.metrics.typecheck).toBeDefined();
    expect(result.metrics.tests).toBeDefined();
  });

  it('returns metrics with expected structure', () => {
    const result = monitorPostMerge('EXP-002', [pass('typecheck')]);
    for (const [, metric] of Object.entries(result.metrics)) {
      expect(metric).toHaveProperty('baseline');
      expect(metric).toHaveProperty('current');
      expect(metric).toHaveProperty('delta');
      expect(metric).toHaveProperty('threshold');
    }
  });

  it('includes observations array even when healthy', () => {
    const result = monitorPostMerge('EXP-003', [pass('typecheck')]);
    expect(Array.isArray(result.observations)).toBe(true);
  });

  it('detects regression when check fails', () => {
    const result = monitorPostMerge('EXP-004', [fail('typecheck')]);
    expect(result.regression).toBe(true);
    expect(result.recommendation).toBe('rollback');
    expect(result.metrics.typecheck.current).toBe(0);
  });

  it('uses default genesis check when no checks provided', () => {
    const result = monitorPostMerge('EXP-005');
    expect(result.metrics.genesis).toBeDefined();
    // genesis should pass since the workspace is valid
    expect(result.regression).toBe(false);
  });
});
