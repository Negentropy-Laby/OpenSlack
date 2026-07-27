import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as publicApi from '../index.js';
import {
  createPreviewedScenarioInstance,
  createSoftwareDeliveryScenarioCatalog,
  loadScenarioPack,
  LocalScenarioInstanceStore,
  previewScenario,
  transitionScenarioInstance,
} from '../index.js';
import { createScenarioInstanceStoreForTest } from '../store.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../');
const temporaryRoots: string[] = [];
const storeModuleUrl = new URL('../store.ts', import.meta.url).href;
const instanceModuleUrl = new URL('../instance.ts', import.meta.url).href;
const tsxExecutable = resolve(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.exe' : 'tsx',
);

async function newRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openslack-instance-store-'));
  temporaryRoots.push(root);
  return root;
}

async function instance(correlationId = 'correlation-001', repository = 'acme/project') {
  const catalog = createSoftwareDeliveryScenarioCatalog();
  const definition = await loadScenarioPack({
    scenarioRoot: join(repositoryRoot, 'scenarios'),
    scenarioId: 'software-delivery',
    catalog,
  });
  return createPreviewedScenarioInstance(
    previewScenario({
      definition,
      catalog,
      input: { objective: `Inspect ${repository}` },
      targetRefs: [
        {
          provider: 'github',
          objectType: 'repository',
          objectId: repository,
          version: 'head:abc123',
          observedAt: '2026-07-27T00:00:00.000Z',
        },
      ],
      actor: { id: 'human-reviewer', permissions: {} },
      workspaceId: 'workspace-main',
      correlationId,
      createdAt: '2026-07-27T00:00:00.000Z',
      expiresAt: '2026-07-27T00:15:00.000Z',
    }),
  );
}

async function crashWriteInChild(
  root: string,
  value: Awaited<ReturnType<typeof instance>>,
  crashAt: 'after_lock_temporary_sync' | 'after_temporary_sync' | 'after_directory_sync',
): Promise<void> {
  const script = `
    void (async () => {
      const { createScenarioInstanceStoreForTest } = await import(process.env.SCENARIO_STORE_MODULE_URL);
      const { trustValidatedScenarioInstance, validateScenarioInstance } =
        await import(process.env.SCENARIO_INSTANCE_MODULE_URL);
      const value = trustValidatedScenarioInstance(
        validateScenarioInstance(JSON.parse(process.env.SCENARIO_STORE_INSTANCE)),
      );
      const store = createScenarioInstanceStoreForTest(
        process.env.SCENARIO_STORE_ROOT,
        value.correlationId,
        { crashAt: process.env.SCENARIO_STORE_CRASH_AT },
      );
      try {
        await store.write(value, { expectedRevision: null });
        process.exit(2);
      } catch (error) {
        process.exit(error?.name === 'SimulatedScenarioStoreCrash' ? 86 : 3);
      }
    })();
  `;
  const result = await new Promise<{ code: number | null; stderr: string }>((resolveChild) => {
    const child = spawn(tsxExecutable, ['-e', script], {
      cwd: resolve(repositoryRoot, 'packages/scenario-runtime'),
      env: {
        ...process.env,
        SCENARIO_STORE_MODULE_URL: storeModuleUrl,
        SCENARIO_INSTANCE_MODULE_URL: instanceModuleUrl,
        SCENARIO_STORE_INSTANCE: JSON.stringify(value),
        SCENARIO_STORE_ROOT: root,
        SCENARIO_STORE_CRASH_AT: crashAt,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => resolveChild({ code: null, stderr: error.message }));
    child.on('exit', (code) => resolveChild({ code, stderr }));
  });
  expect(result, result.stderr).toMatchObject({ code: 86 });
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('LocalScenarioInstanceStore', () => {
  it('atomically creates, reads, and CAS-updates a correlation-bound instance', async () => {
    const root = await newRoot();
    const initial = await instance();
    const store = new LocalScenarioInstanceStore(root, initial.correlationId);
    const created = await store.write(initial, { expectedRevision: null });
    expect(created.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.read(initial.id)).toEqual(initial);
    const repeated = await store.write(initial, { expectedRevision: null });
    expect(repeated).toEqual(created);
    expect(
      (await readdir(join(root, 'instances'))).filter((name) => name.endsWith('.json')),
    ).toHaveLength(1);

    const next = transitionScenarioInstance(initial, {
      state: 'instantiating',
      updatedAt: '2026-07-27T00:01:00.000Z',
      evidenceRefs: ['evidence:execution-started'],
    });
    const updated = await store.write(next, { expectedRevision: created.revision });
    expect(updated.instance.state).toBe('instantiating');
    expect(updated.revision).not.toBe(created.revision);
  });

  it('requires an existing trusted root and never recursively creates through ancestors', async () => {
    const parent = await newRoot();
    const missing = join(parent, 'not-created', 'scenario-store');
    const value = await instance();
    await expect(
      new LocalScenarioInstanceStore(missing, value.correlationId).write(value, {
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_STORE_NOT_FOUND' });
    await expect(readdir(parent)).resolves.toEqual([]);
  });

  it('rejects a structurally valid but non-nominal first write', async () => {
    const root = await newRoot();
    const value = await instance();
    await expect(
      new LocalScenarioInstanceStore(root, value.correlationId).write(
        { ...value },
        {
          expectedRevision: null,
        },
      ),
    ).rejects.toMatchObject({ code: 'SCENARIO_STORE_RECORD_INVALID' });
    expect(publicApi).not.toHaveProperty('trustValidatedScenarioInstance');
    expect(publicApi).not.toHaveProperty('isTrustedScenarioInstance');
  });

  it('fails closed on stale revision, same-timestamp lost update, and lifecycle rollback', async () => {
    const root = await newRoot();
    const initial = await instance();
    const store = new LocalScenarioInstanceStore(root, initial.correlationId);
    const created = await store.write(initial, { expectedRevision: null });
    const next = transitionScenarioInstance(initial, {
      state: 'instantiating',
      updatedAt: '2026-07-27T00:01:00.000Z',
      evidenceRefs: ['evidence:start'],
    });
    await expect(store.write(next, { expectedRevision: '0'.repeat(64) })).rejects.toMatchObject({
      code: 'SCENARIO_STORE_CAS_MISMATCH',
    });
    await expect(
      store.write(
        { ...next, updatedAt: initial.updatedAt },
        { expectedRevision: created.revision },
      ),
    ).rejects.toMatchObject({ code: 'SCENARIO_STORE_CAS_MISMATCH' });
    const updated = await store.write(next, { expectedRevision: created.revision });
    await expect(
      store.write(
        { ...initial, updatedAt: '2026-07-27T00:02:00.000Z' },
        { expectedRevision: updated.revision },
      ),
    ).rejects.toMatchObject({ code: 'SCENARIO_STORE_RECORD_INVALID' });
  });

  it('rejects BOM, duplicate-key, oversized, and record-scope drift on read', async () => {
    const root = await newRoot();
    const value = await instance();
    const store = new LocalScenarioInstanceStore(root, value.correlationId);
    await store.write(value, { expectedRevision: null });
    const recordPath = join(
      root,
      'instances',
      (await readdir(join(root, 'instances'))).find((name) => name.endsWith('.json'))!,
    );
    const canonical = await readFile(recordPath);

    await writeFile(recordPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]));
    await expect(store.read(value.id)).rejects.toMatchObject({
      code: 'SCENARIO_STORE_RECORD_INVALID',
    });

    const text = canonical.toString('utf8');
    await writeFile(
      recordPath,
      text.replace(
        `"id":${JSON.stringify(value.id)}`,
        `"id":${JSON.stringify(value.id)},"id":${JSON.stringify(value.id)}`,
      ),
      'utf8',
    );
    await expect(store.read(value.id)).rejects.toMatchObject({
      code: 'SCENARIO_STORE_RECORD_INVALID',
    });

    const drifted = JSON.parse(text) as Record<string, unknown>;
    drifted.correlationId = 'correlation-other';
    await writeFile(recordPath, `${JSON.stringify(drifted)}\n`, 'utf8');
    await expect(store.read(value.id)).rejects.toMatchObject({
      code: 'SCENARIO_STORE_SCOPE_MISMATCH',
    });

    await writeFile(recordPath, Buffer.alloc(1024 * 1024 + 1, 0x20));
    await expect(store.read(value.id)).rejects.toMatchObject({
      code: 'SCENARIO_STORE_LIMIT_EXCEEDED',
    });
  });

  it('uses a global instance path and rejects a second correlation for the same idempotency key', async () => {
    const root = await newRoot();
    const first = await instance('correlation-001');
    const second = { ...first, correlationId: 'correlation-002' };
    await new LocalScenarioInstanceStore(root, first.correlationId).write(first, {
      expectedRevision: null,
    });
    await expect(
      new LocalScenarioInstanceStore(root, second.correlationId).write(second, {
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_STORE_SCOPE_MISMATCH' });
  });

  it('serializes capacity checks across different instance IDs', async () => {
    const root = await newRoot();
    const first = await instance('correlation-001', 'acme/one');
    const second = await instance('correlation-001', 'acme/two');
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => {
      release = resolveHeld;
    });
    let entered!: () => void;
    const reached = new Promise<void>((resolveReached) => {
      entered = resolveReached;
    });
    const firstStore = createScenarioInstanceStoreForTest(root, first.correlationId, {
      beforeAtomicRename: async () => {
        entered();
        await held;
      },
    });
    const pending = firstStore.write(first, { expectedRevision: null });
    await reached;
    await expect(
      new LocalScenarioInstanceStore(root, second.correlationId).write(second, {
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_STORE_BUSY' });
    release();
    await expect(pending).resolves.toMatchObject({ instance: first });
  });

  it('recovers a provably stale lock and strict temporary file after a temp-fsync crash', async () => {
    const root = await newRoot();
    const value = await instance();
    await crashWriteInChild(root, value, 'after_temporary_sync');
    await expect(readdir(join(root, 'locks'))).resolves.toEqual(['capacity.lock']);
    expect((await readdir(join(root, 'instances'))).some((name) => name.endsWith('.tmp'))).toBe(
      true,
    );

    const recovered = new LocalScenarioInstanceStore(root, value.correlationId);
    await expect(recovered.write(value, { expectedRevision: null })).resolves.toMatchObject({
      instance: value,
    });
    expect((await readdir(join(root, 'instances'))).some((name) => name.endsWith('.tmp'))).toBe(
      false,
    );
    await expect(readdir(join(root, 'locks'))).resolves.toEqual([]);
  });

  it('preserves the canonical record and repairs the stale lock after a post-rename crash', async () => {
    const root = await newRoot();
    const value = await instance();
    await crashWriteInChild(root, value, 'after_directory_sync');
    expect(
      (await readdir(join(root, 'instances'))).filter((name) => name.endsWith('.json')),
    ).toHaveLength(1);
    await expect(readdir(join(root, 'locks'))).resolves.toEqual(['capacity.lock']);

    const recovered = new LocalScenarioInstanceStore(root, value.correlationId);
    await expect(recovered.read(value.id)).resolves.toEqual(value);
    await expect(readdir(join(root, 'locks'))).resolves.toEqual([]);
  });

  it('repairs a dead owner claim temp left before atomic capacity-lock publication', async () => {
    const root = await newRoot();
    const value = await instance();
    await crashWriteInChild(root, value, 'after_lock_temporary_sync');
    const lockArtifacts = await readdir(join(root, 'locks'));
    expect(lockArtifacts).toHaveLength(1);
    expect(lockArtifacts[0]).toMatch(/^\.capacity\..+\.tmp$/);
    await expect(readdir(join(root, 'instances'))).resolves.toEqual([]);

    const recovered = new LocalScenarioInstanceStore(root, value.correlationId);
    await expect(recovered.write(value, { expectedRevision: null })).resolves.toMatchObject({
      instance: value,
    });
    await expect(readdir(join(root, 'locks'))).resolves.toEqual([]);
  });

  it('does not treat an unverifiable same-PID claim as stale', async () => {
    const root = await newRoot();
    const value = await instance();
    const simulated = createScenarioInstanceStoreForTest(root, value.correlationId, {
      crashAt: 'after_lock_temporary_sync',
    });
    await expect(simulated.write(value, { expectedRevision: null })).rejects.toThrow(
      /Simulated Scenario instance-store crash/,
    );
    await expect(
      new LocalScenarioInstanceStore(root, value.correlationId).write(value, {
        expectedRevision: null,
      }),
    ).rejects.toMatchObject({ code: 'SCENARIO_STORE_BUSY' });
  });

  it('fails closed rather than guessing ownership of a malformed capacity lock', async () => {
    const root = await newRoot();
    const value = await instance();
    const store = new LocalScenarioInstanceStore(root, value.correlationId);
    await store.write(value, { expectedRevision: null });
    await writeFile(join(root, 'locks', 'capacity.lock'), '{"pid":1}\n', 'utf8');
    await expect(store.read(value.id)).rejects.toMatchObject({
      code: 'SCENARIO_STORE_FILE_UNSAFE',
    });
  });

  it('detects temporary-file replacement before rename and preserves the canonical record', async () => {
    const root = await newRoot();
    const initial = await instance();
    const normal = new LocalScenarioInstanceStore(root, initial.correlationId);
    const created = await normal.write(initial, { expectedRevision: null });
    const next = transitionScenarioInstance(initial, {
      state: 'instantiating',
      updatedAt: '2026-07-27T00:01:00.000Z',
      evidenceRefs: ['evidence:start'],
    });
    const hostile = createScenarioInstanceStoreForTest(root, initial.correlationId, {
      beforeAtomicRename: async (targetPath) => {
        const directory = dirname(targetPath);
        const temporary = (await readdir(directory)).find((name) => name.endsWith('.tmp'));
        if (!temporary) throw new Error('expected temporary file');
        const tempPath = join(directory, temporary);
        await rename(tempPath, `${tempPath}.replaced`);
        await writeFile(tempPath, '{"schema":"attacker"}\n', 'utf8');
      },
    });
    await expect(hostile.write(next, { expectedRevision: created.revision })).rejects.toMatchObject(
      { code: 'SCENARIO_STORE_FILE_CHANGED' },
    );
    const residual = (await readdir(join(root, 'instances'))).find((name) =>
      name.endsWith('.replaced'),
    );
    expect(residual).toBeDefined();
    await rm(join(root, 'instances', residual!));
    expect(await normal.read(initial.id)).toEqual(initial);
  });

  it('detects the instances directory being replaced before publication', async () => {
    const root = await newRoot();
    const value = await instance();
    const hostile = createScenarioInstanceStoreForTest(root, value.correlationId, {
      beforeAtomicRename: async (targetPath) => {
        const directory = dirname(targetPath);
        await rename(directory, `${directory}.replaced`);
        await mkdir(directory);
      },
    });
    await expect(hostile.write(value, { expectedRevision: null })).rejects.toMatchObject({
      code: 'SCENARIO_STORE_PATH_UNSAFE',
    });
    await expect(
      new LocalScenarioInstanceStore(root, value.correlationId).read(value.id),
    ).rejects.toMatchObject({ code: 'SCENARIO_STORE_FILE_UNSAFE' });
  });

  it('does not expose the deterministic fault-injection seam from the public package API', () => {
    expect(LocalScenarioInstanceStore.length).toBe(2);
    expect(publicApi).not.toHaveProperty('createScenarioInstanceStoreForTest');
    expect(publicApi).not.toHaveProperty('ScenarioInstanceStoreHooks');
  });
});
