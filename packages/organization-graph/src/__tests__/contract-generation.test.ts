import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function runGenerator(mode: 'generate' | '--check', outputRoot?: string) {
  return spawnSync('bun', ['run', 'graph:golden', '--', mode], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(outputRoot === undefined ? {} : { OPENSLACK_GRAPH_CONTRACTS_OUTPUT_ROOT: outputRoot }),
    },
  });
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

  it('supports deterministic generate/check modes and rejects one stale byte', async () => {
    const outputRoot = await mkdtemp(resolve(tmpdir(), 'openslack-graph-contracts-'));
    temporaryRoots.push(outputRoot);

    const generated = runGenerator('generate', outputRoot);
    expect(generated.status, generated.stderr).toBe(0);
    const checked = runGenerator('--check', outputRoot);
    expect(checked.status, checked.stderr).toBe(0);
    expect(checked.stdout).toContain('8 generated files');

    const manifestPath = resolve(
      outputRoot,
      'services/organization-graph/internal/contractmirror/generated/v1/manifest.json',
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
    await symlink('manifest.json', symlinkPath, 'file');
    const linked = runGenerator('--check', outputRoot);
    expect(linked.status).toBe(1);
    expect(`${linked.stdout}\n${linked.stderr}`).toContain('linked.json (symlink forbidden)');
    const linkedWrite = runGenerator('generate', outputRoot);
    expect(linkedWrite.status).toBe(1);
    expect(`${linkedWrite.stdout}\n${linkedWrite.stderr}`).toContain(
      'Refusing to write unsafe Organization Graph generated trees',
    );
    await rm(symlinkPath);

    expect(runGenerator('generate', outputRoot).status).toBe(0);
    const authoritativeManifestPath = resolve(
      outputRoot,
      'packages/organization-graph/contracts/v1/manifest.json',
    );
    await rm(authoritativeManifestPath);
    await symlink('golden-vectors.json', authoritativeManifestPath, 'file');
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
  });
});
