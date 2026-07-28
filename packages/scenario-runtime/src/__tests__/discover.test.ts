import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSoftwareDeliveryScenarioCatalog,
  discoverScenarioPacks,
  SCENARIO_PACK_LIMITS,
} from '../index.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const sourcePack = join(repositoryRoot, 'scenarios', 'software-delivery');
const temporaryRoots: string[] = [];

async function scenarioRoot(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'openslack-scenario-discovery-'));
  temporaryRoots.push(parent);
  const root = join(parent, 'scenarios');
  await mkdir(root);
  return root;
}

async function rewriteLock(pack: string, scenarioId: string): Promise<void> {
  const lockPath = join(pack, 'scenario.lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8')) as {
    scenarioId: string;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  lock.scenarioId = scenarioId;
  for (const entry of lock.files) {
    const bytes = await readFile(join(pack, ...entry.path.split('/')));
    entry.bytes = bytes.length;
    entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

async function copyPack(root: string, scenarioId = 'software-delivery'): Promise<string> {
  const pack = join(root, scenarioId);
  await cp(sourcePack, pack, { recursive: true });
  if (scenarioId !== 'software-delivery') {
    const manifestPath = join(pack, 'scenario.yaml');
    const manifest = await readFile(manifestPath, 'utf8');
    await writeFile(
      manifestPath,
      manifest.replace('id: software-delivery', `id: ${scenarioId}`),
      'utf8',
    );
    await rewriteLock(pack, scenarioId);
  }
  return pack;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('bounded Scenario Pack discovery', () => {
  it('discovers the real locked software-delivery Pack and deeply freezes the result', async () => {
    const root = await scenarioRoot();
    await copyPack(root);

    const result = await discoverScenarioPacks({
      scenarioRoot: root,
      catalog: createSoftwareDeliveryScenarioCatalog(),
    });

    expect(result.accepted.map((definition) => definition.manifest.id)).toEqual([
      'software-delivery',
    ]);
    expect(result.blocked).toEqual([]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.accepted)).toBe(true);
    expect(Object.isFrozen(result.blocked)).toBe(true);
    expect(Object.isFrozen(result.accepted[0])).toBe(true);
  });

  it('keeps a valid Pack accepted when another candidate has lock drift', async () => {
    const root = await scenarioRoot();
    await copyPack(root);
    const drifted = join(root, 'lock-drift');
    await cp(sourcePack, drifted, { recursive: true });
    const manifestPath = join(drifted, 'scenario.yaml');
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, 'utf8')).replace('id: software-delivery', 'id: lock-drift'),
      'utf8',
    );

    const result = await discoverScenarioPacks({
      scenarioRoot: root,
      catalog: createSoftwareDeliveryScenarioCatalog(),
    });

    expect(result.accepted.map((definition) => definition.manifest.id)).toEqual([
      'software-delivery',
    ]);
    expect(result.blocked).toEqual([
      {
        scenarioId: 'lock-drift',
        code: 'SCENARIO_PACK_LOCK_INVALID',
        message: expect.any(String),
      },
    ]);
  });

  it.skipIf(process.platform === 'win32')('blocks a symlinked Pack directory', async () => {
    const root = await scenarioRoot();
    await copyPack(root);
    await symlink(sourcePack, join(root, 'linked-pack'), 'dir');

    const result = await discoverScenarioPacks({
      scenarioRoot: root,
      catalog: createSoftwareDeliveryScenarioCatalog(),
    });

    expect(result.blocked).toContainEqual({
      scenarioId: 'linked-pack',
      code: 'SCENARIO_PACK_SOURCE_SYMLINK',
      message: expect.any(String),
    });
  });

  it('blocks invalid directory IDs and ordinary non-directory entries with stable codes', async () => {
    const root = await scenarioRoot();
    await copyPack(root);
    await mkdir(join(root, 'Invalid_ID'));
    await writeFile(join(root, 'ordinary-file'), 'not a pack\n', 'utf8');

    const result = await discoverScenarioPacks({
      scenarioRoot: root,
      catalog: createSoftwareDeliveryScenarioCatalog(),
    });

    expect(result.blocked).toContainEqual({
      code: 'SCENARIO_PACK_SOURCE_INVALID',
      message: expect.any(String),
    });
    expect(result.blocked).toContainEqual({
      scenarioId: 'ordinary-file',
      code: 'SCENARIO_PACK_FILE_UNSAFE',
      message: expect.any(String),
    });
    expect(result.blocked.every((item) => !item.message.includes(root))).toBe(true);
    expect(result.blocked.every((item) => !Object.hasOwn(item, 'path'))).toBe(true);
  });

  it('narrows discovery with a canonical bounded allowlist', async () => {
    const root = await scenarioRoot();
    await copyPack(root);
    await copyPack(root, 'second-pack');

    const result = await discoverScenarioPacks({
      scenarioRoot: root,
      catalog: createSoftwareDeliveryScenarioCatalog(),
      allowlist: ['software-delivery'],
    });

    expect(result.accepted.map((definition) => definition.manifest.id)).toEqual([
      'software-delivery',
    ]);
    expect(result.blocked).toEqual([
      {
        scenarioId: 'second-pack',
        code: 'SCENARIO_PACK_POLICY_DENIED',
        message: expect.any(String),
      },
    ]);
    await expect(
      discoverScenarioPacks({
        scenarioRoot: root,
        catalog: createSoftwareDeliveryScenarioCatalog(),
        allowlist: ['software-delivery', 'software-delivery'],
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_PACK_SOURCE_INVALID' });
  });

  it('fails the whole discovery as soon as the root entry ceiling is crossed', async () => {
    const root = await scenarioRoot();
    for (let index = 0; index <= SCENARIO_PACK_LIMITS.maxDirectoryEntries; index += 1) {
      await writeFile(join(root, `entry-${String(index).padStart(2, '0')}`), 'x', 'utf8');
    }

    await expect(
      discoverScenarioPacks({
        scenarioRoot: root,
        catalog: createSoftwareDeliveryScenarioCatalog(),
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_PACK_LIMIT_EXCEEDED' });
  });

  it('sorts accepted and blocked results deterministically and redacts loader messages', async () => {
    const root = await scenarioRoot();
    await copyPack(root, 'zeta-pack');
    await copyPack(root, 'alpha-pack');
    const schemaBad = await copyPack(root, 'schema-bad');
    await writeFile(
      join(schemaBad, 'capabilities.yaml'),
      ['schema: openslack.scenario_capabilities.v1', 'requested: []', 'requested: []', ''].join(
        '\n',
      ),
      'utf8',
    );
    await rewriteLock(schemaBad, 'schema-bad');

    const result = await discoverScenarioPacks({
      scenarioRoot: root,
      catalog: createSoftwareDeliveryScenarioCatalog(),
    });

    expect(result.accepted.map((definition) => definition.manifest.id)).toEqual([
      'alpha-pack',
      'zeta-pack',
    ]);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]).toMatchObject({
      scenarioId: 'schema-bad',
      code: expect.stringMatching(/^SCENARIO_PACK_(YAML|SCHEMA)/),
    });
    expect(result.blocked[0]?.message).not.toContain('capabilities.yaml');
    expect(result.blocked[0]?.message).not.toContain(root);
    expect(Object.isFrozen(result.blocked[0])).toBe(true);
  });

  it('blocks references absent from the sealed Host catalog without poisoning valid Packs', async () => {
    const root = await scenarioRoot();
    await copyPack(root);
    const invalidCapability = await copyPack(root, 'invalid-capability-pack');
    await writeFile(
      join(invalidCapability, 'capabilities.yaml'),
      'schema: openslack.scenario_capabilities.v1\nrequested: [github.bad_capability]\n',
      'utf8',
    );
    await rewriteLock(invalidCapability, 'invalid-capability-pack');
    const unknown = await copyPack(root, 'unknown-pack');
    const projectionsPath = join(unknown, 'projections.yaml');
    await writeFile(
      projectionsPath,
      (await readFile(projectionsPath, 'utf8')).replaceAll(
        'openslack.software_delivery.v1',
        'openslack.unknown_projector.v1',
      ),
      'utf8',
    );
    await rewriteLock(unknown, 'unknown-pack');

    const result = await discoverScenarioPacks({
      scenarioRoot: root,
      catalog: createSoftwareDeliveryScenarioCatalog(),
    });

    expect(result.accepted.map((definition) => definition.manifest.id)).toEqual([
      'software-delivery',
    ]);
    expect(result.blocked).toEqual([
      {
        scenarioId: 'invalid-capability-pack',
        code: 'SCENARIO_PACK_REFERENCE_MISSING',
        message: expect.any(String),
      },
      {
        scenarioId: 'unknown-pack',
        code: 'SCENARIO_PACK_REFERENCE_MISSING',
        message: expect.any(String),
      },
    ]);
  });
});
