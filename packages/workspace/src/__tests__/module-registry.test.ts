import { afterEach, describe, it, expect } from 'vitest';
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

const liveEvidenceRoots: string[] = [];

afterEach(() => {
  for (const root of liveEvidenceRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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
      evidenceRefs: [
        'commit:1234567',
        'test:packages/workspace/src/__tests__/module-registry.test.ts',
      ],
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
      evidenceRefs: [
        'commit:1234567',
        'test:packages/workspace/src/__tests__/module-registry.test.ts',
      ],
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

    const commitOnly = {
      ...validRegistry,
      modules: [moduleFixture({ evidenceRefs: ['commit:1234567'] })],
    } as ModulesRegistry;
    expect(
      validateModules(commitOnly).errors.some((error) =>
        error.includes('without test or repository evidence'),
      ),
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
              evidenceRefs: ['commit:1234567', 'test:runtime.test.ts'],
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

    const emptyEvidence = {
      ...validRegistry,
      deferredWork: [
        {
          id: 'empty',
          name: 'Empty evidence',
          status: 'deferred',
          maturity: 'local_ready',
          countedTowardStandalone: false,
          evidenceRefs: [],
        },
      ],
    } as ModulesRegistry;
    expect(
      validateModules(emptyEvidence).errors.some((error) =>
        error.includes('without a declared evidence commit'),
      ),
    ).toBe(true);

    const missingBranch = {
      ...validRegistry,
      deferredWork: [
        {
          id: 'missing-branch',
          name: 'Missing branch',
          status: 'deferred',
          maturity: 'local_ready',
          countedTowardStandalone: false,
          branch: 'agent/does-not-exist',
          evidenceRefs: ['commit:1234567', 'branch:agent/does-not-exist'],
        },
      ],
    } as ModulesRegistry;
    expect(
      validateModules(missingBranch, { rootPath: process.cwd() }).errors.some((error) =>
        error.includes('branch evidence does not resolve'),
      ),
    ).toBe(true);

    const localOnlyBranchLocator = {
      ...validRegistry,
      deferredWork: [
        {
          id: 'local-only-branch',
          name: 'Local-only branch',
          status: 'deferred',
          maturity: 'local_ready',
          countedTowardStandalone: false,
          branch: 'agent/not-published',
          evidenceRefs: [
            `commit:${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim()}`,
            'repo:packages/workspace/src/__tests__/module-registry.test.ts',
          ],
        },
      ],
    } as ModulesRegistry;
    expect(
      validateModules(localOnlyBranchLocator, { rootPath: process.cwd() }).errors.some((error) =>
        error.includes('branch evidence does not resolve'),
      ),
    ).toBe(false);
  });

  it('accepts a tested product revision followed only by evidence and status commits', () => {
    const fixture = createLiveEvidenceFixture();
    const result = validateModules(fixture.registry, { rootPath: fixture.root });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects stale live evidence when product code changes after the tested revision', () => {
    const fixture = createLiveEvidenceFixture({ productChangeAfterEvidence: true });
    const result = validateModules(fixture.registry, { rootPath: fixture.root });

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('tested commit is stale; product paths changed: src/product.ts'),
      ]),
    );
  });

  it('rejects future-dated and overlong live-evidence validity windows', () => {
    const futureObservedAt = Date.now() + 10 * 60 * 1000;
    const futureFixture = createLiveEvidenceFixture({
      observedAt: futureObservedAt,
      expiresAt: futureObservedAt + 24 * 60 * 60 * 1000,
    });
    const futureResult = validateModules(futureFixture.registry, {
      rootPath: futureFixture.root,
    });
    expect(futureResult.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('exceeds the allowed clock skew')]),
    );

    const observedAt = Date.now() - 60 * 1000;
    const overlongFixture = createLiveEvidenceFixture({
      observedAt,
      expiresAt: observedAt + 31 * 24 * 60 * 60 * 1000,
    });
    const overlongResult = validateModules(overlongFixture.registry, {
      rootPath: overlongFixture.root,
    });
    expect(overlongResult.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('validity exceeds 30 days')]),
    );
  });

  it('rejects an observation that predates the tested commit beyond clock skew', () => {
    const fixture = createLiveEvidenceFixture({
      observedAtOffsetFromTestedCommitMs: -10 * 60 * 1000,
    });
    const result = validateModules(fixture.registry, { rootPath: fixture.root });

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('observation predates the tested commit beyond allowed clock skew'),
      ]),
    );
  });

  it('requires revision-bound trace metadata and redacted live evidence references', () => {
    const revisionMismatch = createLiveEvidenceFixture({ revision: '0'.repeat(40) });
    const mismatchResult = validateModules(revisionMismatch.registry, {
      rootPath: revisionMismatch.root,
    });
    expect(mismatchResult.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('revision does not match the tested product revision'),
      ]),
    );

    const missingTrace = createLiveEvidenceFixture({
      correlationId: '',
      evidenceRefs: [],
    });
    const missingTraceResult = validateModules(missingTrace.registry, {
      rootPath: missingTrace.root,
    });
    expect(missingTraceResult.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('schema or required fields are invalid')]),
    );

    const rawCredential = createLiveEvidenceFixture({
      evidenceRefs: ['credential=https://operator:secret-canary@example.invalid'],
    });
    const rawCredentialResult = validateModules(rawCredential.registry, {
      rootPath: rawCredential.root,
    });
    expect(rawCredentialResult.errors).toEqual(
      expect.arrayContaining([expect.stringContaining('schema or required fields are invalid')]),
    );
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
        '    evidenceRefs: [commit:1234567, test:bundled.test.ts]',
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
    evidenceRefs: ['commit:1234567', 'test:module.test.ts'],
    phase: '1.0',
    ...overrides,
  };
}

interface LiveEvidenceFixtureOptions {
  observedAt?: number;
  observedAtOffsetFromTestedCommitMs?: number;
  expiresAt?: number;
  productChangeAfterEvidence?: boolean;
  revision?: string;
  correlationId?: string;
  evidenceRefs?: string[];
}

function createLiveEvidenceFixture(options: LiveEvidenceFixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'openslack-live-evidence-'));
  liveEvidenceRoots.push(root);
  git(root, ['init']);
  git(root, ['config', 'user.name', 'OpenSlack Test']);
  git(root, ['config', 'user.email', 'openslack-test@example.invalid']);

  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'src', 'product.ts'), 'export const product = 1;\n', 'utf-8');
  writeFileSync(join(root, 'test', 'product.test.ts'), 'product revision test\n', 'utf-8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'test product revision']);
  const testedCommit = git(root, ['rev-parse', 'HEAD']);
  const testedCommitTime = Number(git(root, ['show', '-s', '--format=%ct', testedCommit])) * 1000;

  const observedAt =
    options.observedAt ?? testedCommitTime + (options.observedAtOffsetFromTestedCommitMs ?? 1000);
  const expiresAt = options.expiresAt ?? observedAt + 24 * 60 * 60 * 1000;
  mkdirSync(join(root, '.openslack', 'evidence', 'live'), { recursive: true });
  mkdirSync(join(root, 'docs', 'status'), { recursive: true });
  writeFileSync(
    join(root, '.openslack', 'evidence', 'live', 'module.json'),
    `${JSON.stringify(
      {
        schema: 'openslack.live_evidence.v1',
        ownerId: 'module',
        testedCommit,
        outcome: 'pass',
        environment: 'clean-test-host',
        observedAt: new Date(observedAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        correlationId: options.correlationId ?? 'corr-module-clean-host',
        revision: options.revision ?? testedCommit,
        evidenceRefs: options.evidenceRefs ?? ['audit:clean-host/module-pass'],
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
  writeFileSync(
    join(root, '.openslack', 'modules.yaml'),
    'schema: openslack.modules.v2\n',
    'utf-8',
  );
  writeFileSync(join(root, 'docs', 'status', 'current.md'), '# Generated status\n', 'utf-8');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'record live evidence']);
  const evidenceCommit = git(root, ['rev-parse', 'HEAD']);

  if (options.productChangeAfterEvidence) {
    writeFileSync(join(root, 'src', 'product.ts'), 'export const product = 2;\n', 'utf-8');
    git(root, ['add', 'src/product.ts']);
    git(root, ['commit', '-m', 'change product after live test']);
  }

  const registry: ModulesRegistry = {
    schema: 'openslack.modules.v2',
    modules: [
      moduleFixture({
        maturity: 'live_verified',
        operatorConfigured: true,
        evidenceRefs: [
          `commit:${evidenceCommit}`,
          'test:test/product.test.ts',
          'repo:.openslack/evidence/live/module.json',
        ],
      }),
    ],
  };
  return { root, registry };
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
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
