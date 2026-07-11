import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  getModuleById,
  getTotalTestFiles,
  getTotalTests,
  migrateModulesRegistry,
  readProductModules,
  validateModules,
} from '../module-registry.js';
import type { ModulesRegistry, RawModulesRegistry } from '../module-registry.js';

const validRegistry: ModulesRegistry = {
  schema: 'openslack.modules.v2',
  modules: [
    {
      id: 'test_module',
      name: 'Test Module',
      status: 'active',
      maturity: 'local_ready',
      operatorConfigured: false,
      externalBlockers: ['live_test_pending'],
      evidenceRefs: ['test:packages/workspace/src/__tests__/module-registry.test.ts'],
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
      maturity: 'implemented',
      operatorConfigured: false,
      externalBlockers: [],
      evidenceRefs: ['test:packages/workspace/src/__tests__/module-registry.test.ts'],
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
      schema: 'openslack.modules.v2',
      modules: [{ id: 'bad', name: 'Bad', status: 'active' }],
    } as ModulesRegistry;
    const result = validateModules(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('phase'))).toBe(true);

    const malformed = {
      schema: 'openslack.modules.v2',
      modules: [null, { ...moduleFixture(), components: [null] }],
      deferredWork: [null],
    } as unknown as ModulesRegistry;
    expect(() => validateModules(malformed)).not.toThrow();
    expect(validateModules(malformed).valid).toBe(false);

    const malformedCollections = {
      schema: 'openslack.modules.v2',
      modules: [{ ...moduleFixture(), components: {} }],
      deferredWork: {},
    } as unknown as ModulesRegistry;
    expect(() => validateModules(malformedCollections)).not.toThrow();
    expect(validateModules(malformedCollections).errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('components must be an array'),
        expect.stringContaining('deferredWork must be an array'),
      ]),
    );
  });

  it('fails for duplicate ids', () => {
    const dup = {
      schema: 'openslack.modules.v2',
      modules: [moduleFixture({ id: 'dup', name: 'A' }), moduleFixture({ id: 'dup', name: 'B' })],
    } as ModulesRegistry;
    const result = validateModules(dup);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Duplicate'))).toBe(true);
  });

  it('fails for non-number tests', () => {
    const bad = {
      schema: 'openslack.modules.v2',
      modules: [{ ...moduleFixture({ id: 'bad', name: 'Bad' }), tests: 'ten' }],
    } as unknown as ModulesRegistry;
    const result = validateModules(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('tests must be a non-negative integer'))).toBe(
      true,
    );
  });

  it('rejects unsupported schemas rather than treating them as v1', () => {
    const bad = {
      ...validRegistry,
      schema: 'openslack.modules.evil',
    } as unknown as ModulesRegistry;
    const result = validateModules(bad);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Unsupported registry schema: openslack.modules.evil');
    expect(() => migrateModulesRegistry(bad)).toThrow('Unsupported registry schema');
  });

  it('migrates v1 conservatively without inferring readiness from active lifecycle', () => {
    const legacy: RawModulesRegistry = {
      schema: 'openslack.modules.v1',
      modules: [{ id: 'legacy', name: 'Legacy', status: 'active', phase: '1.0' }],
    };
    const migrated = migrateModulesRegistry(legacy);
    expect(migrated.modules[0]).toMatchObject({
      status: 'active',
      maturity: 'planned',
      operatorConfigured: false,
      externalBlockers: ['maturity_evidence_not_audited'],
      evidenceRefs: [],
    });
  });

  it('rejects arbitrary lifecycle and maturity strings', () => {
    const bad = {
      ...validRegistry,
      modules: [
        {
          ...moduleFixture(),
          status: 'done',
          maturity: 'shipped',
        },
      ],
    } as unknown as ModulesRegistry;
    const result = validateModules(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('invalid lifecycle'))).toBe(true);
    expect(result.errors.some((error) => error.includes('invalid maturity'))).toBe(true);
  });

  it('requires committed evidence for live or production claims', () => {
    const bad = {
      ...validRegistry,
      modules: [moduleFixture({ maturity: 'live_verified', evidenceRefs: [] })],
    } as ModulesRegistry;
    const result = validateModules(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('without evidenceRefs'))).toBe(true);
    expect(result.errors.some((error) => error.includes('without committed evidence'))).toBe(true);

    const ordinaryCommitOnly = {
      ...validRegistry,
      modules: [
        moduleFixture({
          maturity: 'live_verified',
          evidenceRefs: [
            `commit:${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()}`,
            'test:packages/workspace/src/__tests__/module-registry.test.ts',
          ],
        }),
      ],
    } as ModulesRegistry;
    const ordinaryResult = validateModules(ordinaryCommitOnly, { rootPath: process.cwd() });
    expect(
      ordinaryResult.errors.some((error) => error.includes('without structured live evidence')),
    ).toBe(true);
  });

  it('caps module maturity at the least mature component', () => {
    const bad = {
      ...validRegistry,
      modules: [
        moduleFixture({
          maturity: 'live_verified',
          evidenceRefs: ['commit:1234567'],
          components: [
            {
              id: 'runtime',
              name: 'Runtime',
              maturity: 'local_ready',
              operatorConfigured: false,
              externalBlockers: ['live_smoke_pending'],
              evidenceRefs: ['test:runtime.test.ts'],
            },
          ],
        }),
      ],
    } as ModulesRegistry;
    const result = validateModules(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('exceeds component'))).toBe(true);
  });

  it('keeps deferred work excluded and below live maturity', () => {
    const bad = {
      ...validRegistry,
      deferredWork: [
        {
          id: 'sidecar',
          name: 'Sidecar',
          status: 'deferred',
          maturity: 'production_ready',
          countedTowardStandalone: false,
          evidenceRefs: [],
        },
      ],
    } as ModulesRegistry;
    const result = validateModules(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('cannot claim live or production'))).toBe(
      true,
    );

    const mismatch = {
      ...validRegistry,
      deferredWork: [
        {
          id: 'sidecar',
          name: 'Sidecar',
          status: 'deferred',
          maturity: 'local_ready',
          countedTowardStandalone: false,
          branch: 'agent/expected',
          evidenceRefs: ['branch:agent/different'],
        },
      ],
    } as ModulesRegistry;
    const mismatchResult = validateModules(mismatch);
    expect(mismatchResult.errors.some((error) => error.includes('must match'))).toBe(true);
  });

  it('verifies tracked repository paths and current-history commit evidence', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    }).trim();
    const registry = {
      ...validRegistry,
      modules: [
        moduleFixture({
          maturity: 'local_ready',
          evidenceRefs: [
            `commit:${head}`,
            'test:packages/workspace/src/__tests__/module-registry.test.ts',
          ],
        }),
      ],
    } as ModulesRegistry;
    const result = validateModules(registry, { rootPath: process.cwd() });
    expect(result.valid).toBe(true);
  });

  it('rejects missing repository evidence paths', () => {
    const registry = {
      ...validRegistry,
      modules: [moduleFixture({ evidenceRefs: ['test:not/a/tracked-test.ts'] })],
    } as ModulesRegistry;
    const result = validateModules(registry, { rootPath: process.cwd() });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('path is missing'))).toBe(true);
  });
});

describe('readProductModules', () => {
  it('loads the bundled registry for an installed workspace', () => {
    const productHome = mkdtempSync(join(tmpdir(), 'openslack-product-'));
    const assetDir = join(productHome, 'assets', 'product');
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(
      join(assetDir, 'modules.yaml'),
      [
        'schema: openslack.modules.v2',
        'modules:',
        '  - id: bundled',
        '    name: Bundled Product Module',
        '    status: active',
        '    maturity: local_ready',
        '    operatorConfigured: false',
        '    externalBlockers: [live_smoke_pending]',
        '    evidenceRefs: [branch:release/test]',
        "    phase: '1.0'",
        '',
      ].join('\n'),
      'utf-8',
    );
    try {
      const registry = readProductModules({
        productHome,
        workspaceRoot: join(productHome, 'consumer-workspace'),
        sourceCheckout: false,
      });
      expect(registry.sourceSchema).toBe('openslack.modules.v2');
      expect(registry.modules[0]?.name).toBe('Bundled Product Module');
    } finally {
      rmSync(productHome, { recursive: true, force: true });
    }
  });
});

function moduleFixture(overrides: Partial<ModulesRegistry['modules'][number]> = {}) {
  return {
    id: 'module',
    name: 'Module',
    status: 'active' as const,
    maturity: 'local_ready' as const,
    operatorConfigured: false,
    externalBlockers: [],
    evidenceRefs: ['test:module.test.ts'],
    phase: '1.0',
    ...overrides,
  };
}

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
