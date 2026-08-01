import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const contractRoot = resolve(repositoryRoot, 'packages/organization-graph/contracts/v1');
const sourceMirrorRoot = resolve(
  repositoryRoot,
  'packages/organization-graph/src/generated/contracts/v1',
);
const serviceMirrorRoot = resolve(
  repositoryRoot,
  'services/organization-graph/internal/contractmirror/generated/v1',
);
const softwareDeliveryContractRoot = resolve(
  repositoryRoot,
  'packages/organization-graph/contracts/software-delivery/v1',
);
const softwareDeliverySourceMirrorRoot = resolve(
  repositoryRoot,
  'packages/organization-graph/src/generated/contracts/software-delivery/v1',
);
const softwareDeliveryServiceMirrorRoot = resolve(
  repositoryRoot,
  'services/organization-graph/internal/contractmirror/generated/software-delivery/v1',
);
const softwareDeliveryHistoricalFixturePath = resolve(
  repositoryRoot,
  'packages/organization-graph/src/__tests__/fixtures/software-delivery-source.json',
);
const contractToDeliveryContractRoot = resolve(
  repositoryRoot,
  'packages/organization-graph/contracts/contract-to-delivery/v1',
);
const contractToDeliverySourceMirrorRoot = resolve(
  repositoryRoot,
  'packages/organization-graph/src/generated/contracts/contract-to-delivery/v1',
);
const contractToDeliveryServiceMirrorRoot = resolve(
  repositoryRoot,
  'services/organization-graph/internal/contractmirror/generated/contract-to-delivery/v1',
);
const contractToDeliveryFixturePath = resolve(
  repositoryRoot,
  'packages/organization-graph/src/fixtures/contract-to-delivery-source.json',
);
// Full-suite CI runs hundreds of files concurrently. These contract freeze cases
// launch generator processes and/or read large generated artifacts, and have
// exceeded 30 seconds under that measured load; keep the larger budget scoped here.
const CONTRACT_FREEZE_TIMEOUT_MS = 60_000;
const temporaryRoots: string[] = [];

interface ContractArtifact {
  readonly path: string;
  readonly sha256: string;
}

interface SoftwareDeliveryManifest {
  readonly schema: string;
  readonly authority: string;
  readonly sourceSchema: string;
  readonly projectorId: string;
  readonly errorCodes: {
    readonly graphContract: readonly string[];
    readonly strictJson: readonly string[];
  };
  readonly vectorInventory: {
    readonly total: number;
    readonly success: number;
    readonly error: number;
    readonly schemaValid: number;
    readonly schemaInvalid: number;
    readonly families: Readonly<Record<string, number>>;
    readonly random: number;
  };
  readonly artifacts: {
    readonly sourceSchema: ContractArtifact;
    readonly projectorGoldenVectors: ContractArtifact;
  };
}

interface ProjectorVector {
  readonly id: string;
  readonly family: string;
  readonly sourceSchemaValid: boolean;
  readonly input: { readonly source: unknown };
  readonly expected?: {
    readonly integrityHash?: string;
  };
  readonly expectedError?: {
    readonly code?: string;
    readonly path?: string;
  };
}

interface SoftwareDeliveryVectors {
  readonly randomized: { readonly cases: number };
  readonly cases: readonly ProjectorVector[];
}

type ContractToDeliveryManifest = SoftwareDeliveryManifest;
type ContractToDeliveryVectors = SoftwareDeliveryVectors;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function runGenerator(mode: 'generate' | '--check', outputRoot?: string) {
  const result = spawnSync('bun', ['run', 'graph:golden', '--', mode], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      ...(outputRoot === undefined ? {} : { OPENSLACK_GRAPH_CONTRACTS_OUTPUT_ROOT: outputRoot }),
    },
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (process.platform !== 'win32' || !output.includes('EACCES reading')) return result;

  const toWslPath = (path: string): string => {
    const match = /^([A-Za-z]):\/(.*)$/.exec(path.replaceAll('\\', '/'));
    if (match === null) throw new Error(`Cannot translate Windows path for WSL: ${path}`);
    return `/mnt/${match[1]!.toLowerCase()}/${match[2]}`;
  };
  return spawnSync(
    'wsl.exe',
    [
      '--cd',
      toWslPath(repositoryRoot),
      '--exec',
      '/usr/bin/env',
      ...(outputRoot === undefined
        ? []
        : [`OPENSLACK_GRAPH_CONTRACTS_OUTPUT_ROOT=${toWslPath(outputRoot)}`]),
      '/root/.bun/bin/bun',
      'run',
      'graph:golden',
      '--',
      mode,
    ],
    { encoding: 'utf8' },
  );
}

function generatorDiagnostic(result: ReturnType<typeof runGenerator>): string {
  return [result.error?.message, result.signal, result.stdout, result.stderr]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .join('\n');
}

async function tryCreateSymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, 'file');
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return false;
    throw error;
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('Organization Graph generated contract freeze', () => {
  it('keeps authoritative schemas and every generated mirror byte-identical', async () => {
    for (const name of ['graph-snapshot.v1.schema.json', 'graph-delta.v1.schema.json']) {
      const authority = await readFile(resolve(contractRoot, 'schemas', name));
      expect(await readFile(resolve(sourceMirrorRoot, 'schemas', name))).toEqual(authority);
      expect(await readFile(resolve(serviceMirrorRoot, 'schemas', name))).toEqual(authority);
    }
    for (const name of ['manifest.json', 'golden-vectors.json']) {
      expect(await readFile(resolve(serviceMirrorRoot, name))).toEqual(
        await readFile(resolve(contractRoot, name)),
      );
    }
  });

  it('publishes all frozen algorithm, limit, error, and golden-vector families', async () => {
    const manifest = JSON.parse(await readFile(resolve(contractRoot, 'manifest.json'), 'utf8')) as {
      algorithms: Record<string, string>;
      errorCodes: Record<string, string[]>;
      hardLimits: Record<string, number>;
      valueLimits: Record<string, number>;
      strictJsonLimits: Record<string, number>;
      queryProtocolLimits: Record<string, number>;
    };
    expect(Object.keys(manifest.algorithms).sort()).toEqual([
      'canonicalJson',
      'deltaIntegrity',
      'edgeIdentity',
      'explain',
      'nodeIdentity',
      'queryCursor',
      'queryNormalization',
      'snapshotIntegrity',
      'strictJson',
    ]);
    expect(Object.keys(manifest.errorCodes).sort()).toEqual([
      'canonicalJson',
      'graphContract',
      'graphQuery',
      'strictJson',
    ]);
    expect(manifest.hardLimits).toMatchObject({
      depth: 3,
      responseBytes: 512 * 1024,
      snapshotNodes: 10_000,
      traversalSteps: 100_000,
    });
    expect(manifest.valueLimits).toMatchObject({
      identifierCharacters: 512,
      propertyStringCharacters: 32_768,
    });
    expect(manifest.strictJsonLimits).toMatchObject({ maxDepth: 64, maxNodes: 250_000 });
    expect(manifest.queryProtocolLimits).toMatchObject({
      minResponseBytes: 1_024,
      cursorSecretMinBytes: 32,
      minCursorTtlMs: 1,
      maxCursorTtlMs: 60 * 60 * 1_000,
    });

    const vectors = JSON.parse(
      await readFile(resolve(contractRoot, 'golden-vectors.json'), 'utf8'),
    ) as { cases: Array<{ id: string; family: string }> };
    expect(new Set(vectors.cases.map((item) => item.id)).size).toBe(vectors.cases.length);
    expect(new Set(vectors.cases.map((item) => item.family))).toEqual(
      new Set([
        'canonical_json',
        'canonical_json_error',
        'identity',
        'snapshot_integrity',
        'delta_integrity',
        'query',
        'query_cursor',
        'explain',
        'contract_error',
        'query_error',
        'strict_json_error',
      ]),
    );
    const ids = new Set(vectors.cases.map((item) => item.id));
    for (const required of [
      'canonical-forbidden-key-__proto__',
      'canonical-forbidden-key-prototype',
      'canonical-forbidden-key-constructor',
      'canonical-cjk-key-order',
      'canonical-non-emoji-astral-key-order',
      'canonical-control-character-escaping',
      'canonical-string-above-strict-json-limit',
      'canonical-depth-above-strict-json-limit',
      'canonical-undefined-object-member',
      'canonical-nan',
      'canonical-positive-infinity',
      'canonical-negative-infinity',
      'canonical-sparse-array',
      'canonical-bigint',
      'canonical-symbol',
      'canonical-function',
      'canonical-mixed-error-precedence',
      'canonical-unpaired-high-surrogate-string',
      'canonical-unpaired-low-surrogate-key',
      'snapshot-integrity-verify-success-and-failure',
      'snapshot-validity-submillisecond-date-parse-precision',
      'delta-integrity-verify-success-and-failure',
      'query-byte-limit-truncation-and-response-size',
      'contract-datetime-offset-hour-error',
      'contract-datetime-offset-minute-error',
      'contract-snapshot-error-precedence',
      'contract-delta-error-precedence',
      'contract-property-nbsp-script-error',
      'contract-property-nbsp-bearer-error',
      'query-unpaired-high-surrogate-error',
      'query-unpaired-low-surrogate-error',
      'query-expiry-overflow-error',
      'cursor-malformed-error',
      'cursor-tampered-error',
      'cursor-noncanonical-base64url-error',
      'cursor-nonzero-tail-bits-error',
      'cursor-noncanonical-json-error',
      'cursor-offset-out-of-contract-bounds-error',
      'explain-empty-root-error',
      'strict-json-unpaired-high-surrogate',
      'strict-json-unpaired-low-surrogate',
      'strict-json-zero-max-depth',
      'strict-json-negative-max-depth',
      'strict-json-zero-max-nodes',
      'strict-json-negative-max-nodes',
      'strict-json-zero-max-string-length',
      'strict-json-negative-max-string-length',
    ]) {
      expect(ids.has(required), required).toBe(true);
    }
  });

  it(
    'supports deterministic generate/check modes and rejects one stale byte',
    async () => {
      const outputRoot = await mkdtemp(resolve(tmpdir(), 'openslack-graph-contracts-'));
      temporaryRoots.push(outputRoot);

      const generated = runGenerator('generate', outputRoot);
      expect(generated.status, generatorDiagnostic(generated)).toBe(0);
      const checked = runGenerator('--check', outputRoot);
      expect(checked.status, checked.stderr).toBe(0);
      expect(checked.stdout).toContain('22 generated files');

      const manifestPath = resolve(
        outputRoot,
        'services/organization-graph/internal/contractmirror/generated/software-delivery/v1/manifest.json',
      );
      await writeFile(manifestPath, 'stale\n', 'utf8');
      const stale = runGenerator('--check', outputRoot);
      expect(stale.status).toBe(1);
      expect(`${stale.stdout}\n${stale.stderr}`).toContain('manifest.json (stale)');

      expect(runGenerator('generate', outputRoot).status).toBe(0);
      const extraPath = resolve(
        outputRoot,
        'services/organization-graph/internal/contractmirror/generated/v1/extra.json',
      );
      await writeFile(extraPath, '{}\n', 'utf8');
      const extra = runGenerator('--check', outputRoot);
      expect(extra.status).toBe(1);
      expect(`${extra.stdout}\n${extra.stderr}`).toContain('extra.json (unexpected file)');
      await rm(extraPath);

      const symlinkPath = resolve(
        outputRoot,
        'services/organization-graph/internal/contractmirror/generated/v1/linked.json',
      );
      if (await tryCreateSymlink('manifest.json', symlinkPath)) {
        const linked = runGenerator('--check', outputRoot);
        expect(linked.status).toBe(1);
        expect(`${linked.stdout}\n${linked.stderr}`).toContain('linked.json (symlink forbidden)');
        const linkedWrite = runGenerator('generate', outputRoot);
        expect(linkedWrite.status).toBe(1);
        expect(`${linkedWrite.stdout}\n${linkedWrite.stderr}`).toContain(
          'Refusing to write unsafe Organization Graph generated trees',
        );
        await rm(symlinkPath);
      }

      expect(runGenerator('generate', outputRoot).status).toBe(0);
      const authoritativeManifestPath = resolve(
        outputRoot,
        'packages/organization-graph/contracts/v1/manifest.json',
      );
      await rm(authoritativeManifestPath);
      if (await tryCreateSymlink('golden-vectors.json', authoritativeManifestPath)) {
        const authoritativeLinked = runGenerator('--check', outputRoot);
        expect(authoritativeLinked.status).toBe(1);
        expect(`${authoritativeLinked.stdout}\n${authoritativeLinked.stderr}`).toContain(
          'packages/organization-graph/contracts/v1/manifest.json (symlink forbidden)',
        );
        const authoritativeLinkedWrite = runGenerator('generate', outputRoot);
        expect(authoritativeLinkedWrite.status).toBe(1);
        expect(`${authoritativeLinkedWrite.stdout}\n${authoritativeLinkedWrite.stderr}`).toContain(
          'Refusing to write unsafe Organization Graph generated trees',
        );
      }
    },
    CONTRACT_FREEZE_TIMEOUT_MS,
  );

  it(
    'freezes Software Delivery authority, mirrors, and manifest hashes exactly',
    async () => {
      const schemaPath = 'schemas/software-delivery-source-snapshot.v1.schema.json';
      const authoritySchema = await readFile(resolve(softwareDeliveryContractRoot, schemaPath));
      expect(await readFile(resolve(softwareDeliverySourceMirrorRoot, schemaPath))).toEqual(
        authoritySchema,
      );
      expect(await readFile(resolve(softwareDeliveryServiceMirrorRoot, schemaPath))).toEqual(
        authoritySchema,
      );

      for (const name of ['manifest.json', 'projector-golden-vectors.json']) {
        expect(await readFile(resolve(softwareDeliveryServiceMirrorRoot, name))).toEqual(
          await readFile(resolve(softwareDeliveryContractRoot, name)),
        );
      }

      const manifest = JSON.parse(
        await readFile(resolve(softwareDeliveryContractRoot, 'manifest.json'), 'utf8'),
      ) as SoftwareDeliveryManifest;
      expect(manifest).toMatchObject({
        schema: 'openslack.software_delivery_projector_contract_manifest.v1',
        authority: 'typescript',
        sourceSchema: 'openslack.software_delivery_source_snapshot.v1',
        projectorId: 'openslack.software_delivery.v1',
      });
      for (const artifact of Object.values(manifest.artifacts)) {
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(sha256(await readFile(resolve(softwareDeliveryContractRoot, artifact.path)))).toBe(
          artifact.sha256,
        );
      }
    },
    CONTRACT_FREEZE_TIMEOUT_MS,
  );

  it('keeps Software Delivery vector schema-validity classifications aligned with Ajv 2020', async () => {
    const schema = JSON.parse(
      await readFile(
        resolve(
          softwareDeliveryContractRoot,
          'schemas/software-delivery-source-snapshot.v1.schema.json',
        ),
        'utf8',
      ),
    ) as object;
    const vectors = JSON.parse(
      await readFile(
        resolve(softwareDeliveryContractRoot, 'projector-golden-vectors.json'),
        'utf8',
      ),
    ) as SoftwareDeliveryVectors;
    const manifest = JSON.parse(
      await readFile(resolve(softwareDeliveryContractRoot, 'manifest.json'), 'utf8'),
    ) as SoftwareDeliveryManifest;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);

    const inventory = manifest.vectorInventory;
    const familyCounts = Object.fromEntries(
      [...new Set(vectors.cases.map((vector) => vector.family))]
        .sort()
        .map((family) => [
          family,
          vectors.cases.filter((vector) => vector.family === family).length,
        ]),
    );
    expect(vectors.cases).toHaveLength(inventory.total);
    expect(vectors.cases.filter((vector) => vector.expected !== undefined)).toHaveLength(
      inventory.success,
    );
    expect(vectors.cases.filter((vector) => vector.expectedError !== undefined)).toHaveLength(
      inventory.error,
    );
    expect(vectors.cases.filter((vector) => vector.sourceSchemaValid)).toHaveLength(
      inventory.schemaValid,
    );
    expect(vectors.cases.filter((vector) => !vector.sourceSchemaValid)).toHaveLength(
      inventory.schemaInvalid,
    );
    expect(familyCounts).toEqual(inventory.families);
    expect(Object.keys(familyCounts)).toEqual([
      'aggregate_boundary',
      'all_missing',
      'authority_boundary',
      'boundary_valid',
      'complete',
      'historical',
      'incomplete_synthetic',
      'incomplete_truncation',
      'invalid',
      'ordering',
      'randomized_valid',
      'utf16',
    ]);
    expect(vectors.randomized.cases).toBe(inventory.random);
    expect(inventory.random).toBe(16);
    expect(manifest.errorCodes.strictJson).toEqual([
      'GRAPH_JSON_UTF8_INVALID',
      'GRAPH_JSON_BOM_FORBIDDEN',
      'GRAPH_JSON_SYNTAX_INVALID',
      'GRAPH_JSON_DUPLICATE_KEY',
      'GRAPH_JSON_LIMIT_EXCEEDED',
    ]);

    const byId = new Map(vectors.cases.map((vector) => [vector.id, vector] as const));
    expect(byId.get('projector-invalid-unexpected-key-utf16-order')?.expectedError?.path).toBe(
      '$.aUnexpected',
    );
    expect(byId.get('projector-invalid-utf16-split-surrogate-title')).toMatchObject({
      sourceSchemaValid: true,
      expectedError: { code: 'GRAPH_SCHEMA_INVALID' },
    });
    expect(byId.get('projector-multi-record-ordering')?.expected?.integrityHash).toBe(
      byId.get('projector-multi-record-ordering-permuted')?.expected?.integrityHash,
    );
    expect(byId.get('projector-invalid-review-date-parse-millisecond-tie')).toMatchObject({
      sourceSchemaValid: true,
      expectedError: { code: 'GRAPH_REFERENCE_INVALID' },
    });
    expect(byId.get('projector-invalid-aggregate-relations-over-limit')?.sourceSchemaValid).toBe(
      true,
    );
    const historical = vectors.cases.find(
      (vector) => vector.id === 'projector-historical-repository-fixture',
    );
    expect(historical?.family).toBe('historical');
    expect(historical?.input.source).toEqual(
      JSON.parse(await readFile(softwareDeliveryHistoricalFixturePath, 'utf8')),
    );
    for (const vector of vectors.cases) {
      const valid = validate(vector.input.source);
      expect(valid, `${vector.id}: ${ajv.errorsText(validate.errors, { separator: '\n' })}`).toBe(
        vector.sourceSchemaValid,
      );
    }
  }, 30_000);

  it(
    'freezes Contract-to-Delivery authority, mirrors, and manifest hashes exactly',
    async () => {
      const schemaPath = 'schemas/contract-to-delivery-source-snapshot.v1.schema.json';
      const authoritySchema = await readFile(resolve(contractToDeliveryContractRoot, schemaPath));
      expect(await readFile(resolve(contractToDeliverySourceMirrorRoot, schemaPath))).toEqual(
        authoritySchema,
      );
      expect(await readFile(resolve(contractToDeliveryServiceMirrorRoot, schemaPath))).toEqual(
        authoritySchema,
      );
      for (const name of ['manifest.json', 'projector-golden-vectors.json']) {
        expect(await readFile(resolve(contractToDeliveryServiceMirrorRoot, name))).toEqual(
          await readFile(resolve(contractToDeliveryContractRoot, name)),
        );
      }
      const manifest = JSON.parse(
        await readFile(resolve(contractToDeliveryContractRoot, 'manifest.json'), 'utf8'),
      ) as ContractToDeliveryManifest;
      expect(manifest).toMatchObject({
        schema: 'openslack.contract_to_delivery_projector_contract_manifest.v1',
        authority: 'typescript',
        sourceSchema: 'openslack.contract_to_delivery_source_snapshot.v1',
        projectorId: 'openslack.contract_to_delivery.v1',
      });
      for (const artifact of Object.values(manifest.artifacts)) {
        expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(sha256(await readFile(resolve(contractToDeliveryContractRoot, artifact.path)))).toBe(
          artifact.sha256,
        );
      }
    },
    CONTRACT_FREEZE_TIMEOUT_MS,
  );

  it('keeps Contract-to-Delivery vector classifications aligned with Ajv 2020', async () => {
    const schema = JSON.parse(
      await readFile(
        resolve(
          contractToDeliveryContractRoot,
          'schemas/contract-to-delivery-source-snapshot.v1.schema.json',
        ),
        'utf8',
      ),
    ) as object;
    const vectors = JSON.parse(
      await readFile(
        resolve(contractToDeliveryContractRoot, 'projector-golden-vectors.json'),
        'utf8',
      ),
    ) as ContractToDeliveryVectors;
    const manifest = JSON.parse(
      await readFile(resolve(contractToDeliveryContractRoot, 'manifest.json'), 'utf8'),
    ) as ContractToDeliveryManifest;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const validate = ajv.compile(schema);
    const inventory = manifest.vectorInventory;
    const familyCounts = Object.fromEntries(
      [...new Set(vectors.cases.map((vector) => vector.family))]
        .sort()
        .map((family) => [
          family,
          vectors.cases.filter((vector) => vector.family === family).length,
        ]),
    );
    expect(vectors.cases).toHaveLength(inventory.total);
    expect(vectors.cases.filter((vector) => vector.expected !== undefined)).toHaveLength(
      inventory.success,
    );
    expect(vectors.cases.filter((vector) => vector.expectedError !== undefined)).toHaveLength(
      inventory.error,
    );
    expect(vectors.cases.filter((vector) => vector.sourceSchemaValid)).toHaveLength(
      inventory.schemaValid,
    );
    expect(vectors.cases.filter((vector) => !vector.sourceSchemaValid)).toHaveLength(
      inventory.schemaInvalid,
    );
    expect(familyCounts).toEqual(inventory.families);
    expect(Object.keys(familyCounts)).toEqual([
      'acceptance_boundary',
      'all_missing',
      'boundary_valid',
      'bridge_drift',
      'complete',
      'historical',
      'incomplete',
      'invalid',
      'ordering',
      'outcome_boundary',
      'randomized_valid',
    ]);
    expect(vectors.randomized.cases).toBe(16);
    const byId = new Map(vectors.cases.map((vector) => [vector.id, vector] as const));
    expect(byId.get('projector-complete-business-chain')?.expected?.integrityHash).toBe(
      byId.get('projector-business-and-software-ordering')?.expected?.integrityHash,
    );
    expect(byId.get('projector-invalid-nested-scope-drift')).toMatchObject({
      sourceSchemaValid: true,
      expectedError: { code: 'GRAPH_SCOPE_INVALID', path: '$.softwareDelivery' },
    });
    const historical = byId.get('projector-historical-repository-fixture');
    expect(historical?.input.source).toEqual(
      JSON.parse(await readFile(contractToDeliveryFixturePath, 'utf8')),
    );
    for (const vector of vectors.cases) {
      const valid = validate(vector.input.source);
      expect(valid, `${vector.id}: ${ajv.errorsText(validate.errors, { separator: '\n' })}`).toBe(
        vector.sourceSchemaValid,
      );
    }
  }, 60_000);
});
