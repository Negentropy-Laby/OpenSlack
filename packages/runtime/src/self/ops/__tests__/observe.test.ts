import { describe, it, expect } from 'vitest';
import { observeHealth } from '../observe.js';

describe('observeHealth', () => {
  it('returns no observations when all checks pass', () => {
    const observations = observeHealth({
      typecheck: { passed: true, output: '' },
      tests: { passed: true, output: '' },
    });
    expect(Array.isArray(observations)).toBe(true);
    expect(observations.filter((o) => o.type !== 'missing_file')).toHaveLength(0);
  });

  it('detects typecheck failure', () => {
    const observations = observeHealth({
      typecheck: { passed: false, output: 'error TS1234: Cannot find module' },
      tests: { passed: true, output: '' },
    });
    const err = observations.find((o) => o.type === 'typecheck_failure');
    expect(err).toBeDefined();
    expect(err!.severity).toBe('high');
    expect(err!.evidence.length).toBeGreaterThan(0);
  });

  it('detects test failure', () => {
    const observations = observeHealth({
      typecheck: { passed: true, output: '' },
      tests: { passed: false, output: 'FAIL tests/core.test.ts\nTests: 1 failed, 59 passed' },
    });
    const err = observations.find((o) => o.type === 'test_failure');
    expect(err).toBeDefined();
    expect(err!.severity).toBe('high');
    expect(err!.evidence.length).toBeGreaterThan(0);
  });

  it('each observation has required fields', () => {
    const observations = observeHealth({
      typecheck: { passed: false, output: 'error TS9999: fail' },
      tests: { passed: true, output: '' },
    });
    for (const obs of observations) {
      expect(obs).toHaveProperty('id');
      expect(obs).toHaveProperty('type');
      expect(obs).toHaveProperty('severity');
      expect(obs).toHaveProperty('summary');
      expect(obs).toHaveProperty('evidence');
      expect(obs).toHaveProperty('module');
      expect(obs).toHaveProperty('timestamp');
    }
  });
});
