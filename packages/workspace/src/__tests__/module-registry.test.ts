import { describe, it, expect } from 'vitest';
import { validateModules, getTotalTests, getTotalTestFiles, getModuleById } from '../module-registry.js';
import type { ModulesRegistry } from '../module-registry.js';

const validRegistry: ModulesRegistry = {
  schema: 'openslack.modules.v1',
  modules: [
    {
      id: 'test_module',
      name: 'Test Module',
      status: 'active',
      phase: '1.0',
      cli: ['openslack test'],
      packages: ['@openslack/test'],
      tests: 10,
      test_files: 2,
      golden_evals: 1,
    },
    {
      id: 'other_module',
      name: 'Other Module',
      status: 'early',
      phase: '1.1',
      tests: 5,
      test_files: 1,
    },
  ],
};

describe('validateModules', () => {
  it('passes for valid registry', () => {
    const result = validateModules(validRegistry);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails for missing required fields', () => {
    const bad = {
      schema: 'openslack.modules.v1',
      modules: [{ id: 'bad', name: 'Bad', status: 'active' }],
    } as ModulesRegistry;
    const result = validateModules(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('phase'))).toBe(true);
  });

  it('fails for duplicate ids', () => {
    const dup = {
      schema: 'openslack.modules.v1',
      modules: [
        { id: 'dup', name: 'A', status: 'active', phase: '1.0' },
        { id: 'dup', name: 'B', status: 'active', phase: '1.0' },
      ],
    } as ModulesRegistry;
    const result = validateModules(dup);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate'))).toBe(true);
  });

  it('fails for non-number tests', () => {
    const bad = {
      schema: 'openslack.modules.v1',
      modules: [
        { id: 'bad', name: 'Bad', status: 'active', phase: '1.0', tests: 'ten' },
      ],
    } as unknown as ModulesRegistry;
    const result = validateModules(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('tests must be a number'))).toBe(true);
  });
});

describe('getTotalTests', () => {
  it('sums tests across modules', () => {
    expect(getTotalTests(validRegistry)).toBe(15);
  });
});

describe('getTotalTestFiles', () => {
  it('sums test files across modules', () => {
    expect(getTotalTestFiles(validRegistry)).toBe(3);
  });
});

describe('getModuleById', () => {
  it('finds existing module', () => {
    const mod = getModuleById(validRegistry, 'test_module');
    expect(mod).toBeDefined();
    expect(mod?.name).toBe('Test Module');
  });

  it('returns undefined for missing module', () => {
    expect(getModuleById(validRegistry, 'missing')).toBeUndefined();
  });
});
