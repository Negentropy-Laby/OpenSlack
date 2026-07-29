import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTRACT_TO_DELIVERY_SCENARIO_ID,
  CONTRACT_TO_DELIVERY_SOURCE_LIMITS,
  GraphStoreError,
  LocalGraphStore,
  SOFTWARE_DELIVERY_SOURCE_LIMITS,
  buildAndPublishGraphSnapshot,
  buildAndPublishSoftwareDeliverySnapshot,
  graphSnapshotBuildProfile,
} from '../index.js';

const roots: string[] = [];
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'software-delivery-source.json',
);
const contractFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'contract-to-delivery-source.json',
);

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'openslack-graph-build-'));
  roots.push(value);
  return value;
}

function fixture(): Buffer {
  return readFileSync(fixturePath);
}

function contractFixture(): Buffer {
  return readFileSync(contractFixturePath);
}

function fixtureObject(): Record<string, unknown> {
  return JSON.parse(fixture().toString('utf8')) as Record<string, unknown>;
}

function changedFixture(cursor: string): Buffer {
  const value = fixtureObject();
  value.cursor = cursor;
  value.generatedAt = '2026-07-28T03:00:00.000Z';
  return Buffer.from(JSON.stringify(value), 'utf8');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('buildAndPublishSoftwareDeliverySnapshot', () => {
  it('strictly projects and CAS-publishes the checked-in inert fixture', async () => {
    const store = new LocalGraphStore(join(await root(), 'graph'));
    const result = await buildAndPublishSoftwareDeliverySnapshot({
      sourceBytes: fixture(),
      store,
      expectedCursor: null,
      expectedScenarioInstanceId: 'scenario-software-delivery-fixture',
    });

    const readback = await store.readCurrentSnapshot(result.scenarioInstanceId);
    expect(result).toMatchObject({
      scenarioInstanceId: 'scenario-software-delivery-fixture',
      previousCursor: null,
      cursor: 'fixture-cursor-001',
      snapshotIntegrityHash: readback.integrityHash,
      nodeCount: readback.nodes.length,
      edgeCount: readback.edges.length,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ['duplicate key', Buffer.from('{"schema":1,"schema":2}', 'utf8'), 'GRAPH_JSON_DUPLICATE_KEY'],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28]), 'GRAPH_JSON_UTF8_INVALID'],
    [
      'UTF-8 BOM',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fixture()]),
      'GRAPH_JSON_BOM_FORBIDDEN',
    ],
  ])('rejects %s before publication', async (_name, sourceBytes, code) => {
    const store = new LocalGraphStore(join(await root(), 'graph'));
    await expect(
      buildAndPublishSoftwareDeliverySnapshot({
        sourceBytes,
        store,
        expectedCursor: null,
      }),
    ).rejects.toMatchObject({ code });
    expect(await store.currentCursor('scenario-software-delivery-fixture')).toBeNull();
  });

  it('rejects source bytes above the input ceiling before parsing', async () => {
    const store = new LocalGraphStore(join(await root(), 'graph'));
    await expect(
      buildAndPublishSoftwareDeliverySnapshot({
        sourceBytes: Buffer.alloc(SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes + 1, 0x20),
        store,
        expectedCursor: null,
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_BOUND_EXCEEDED', path: '$' });
  });

  it('rejects scenario definition and explicit instance scope mismatches', async () => {
    const store = new LocalGraphStore(join(await root(), 'graph'));
    const wrongDefinition = fixtureObject();
    wrongDefinition.scenarioDefinitionId = 'other-scenario';
    await expect(
      buildAndPublishSoftwareDeliverySnapshot({
        sourceBytes: Buffer.from(JSON.stringify(wrongDefinition), 'utf8'),
        store,
        expectedCursor: null,
      }),
    ).rejects.toMatchObject({
      code: 'GRAPH_SCOPE_INVALID',
      path: '$.scenarioDefinitionId',
    });
    await expect(
      buildAndPublishSoftwareDeliverySnapshot({
        sourceBytes: fixture(),
        store,
        expectedCursor: null,
        expectedScenarioInstanceId: 'other-instance',
      }),
    ).rejects.toMatchObject({
      code: 'GRAPH_SCOPE_INVALID',
      path: '$.scenarioInstanceId',
    });
  });

  it('updates only through a matching cursor and rejects stale or absent CAS claims', async () => {
    const store = new LocalGraphStore(join(await root(), 'graph'));
    await buildAndPublishSoftwareDeliverySnapshot({
      sourceBytes: fixture(),
      store,
      expectedCursor: null,
    });
    const updated = await buildAndPublishSoftwareDeliverySnapshot({
      sourceBytes: changedFixture('fixture-cursor-002'),
      store,
      expectedCursor: 'fixture-cursor-001',
    });
    expect(updated.previousCursor).toBe('fixture-cursor-001');

    await expect(
      buildAndPublishSoftwareDeliverySnapshot({
        sourceBytes: changedFixture('fixture-cursor-003'),
        store,
        expectedCursor: 'fixture-cursor-001',
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_CURSOR_CONFLICT' });
    await expect(
      buildAndPublishSoftwareDeliverySnapshot({
        sourceBytes: changedFixture('fixture-cursor-003'),
        store,
        expectedCursor: null,
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_CURSOR_CONFLICT' });
    expect(await store.currentCursor('scenario-software-delivery-fixture')).toBe(
      'fixture-cursor-002',
    );
  });

  it('propagates store lock contention without changing the current cursor', async () => {
    const store = new LocalGraphStore(join(await root(), 'graph'));
    await buildAndPublishSoftwareDeliverySnapshot({
      sourceBytes: fixture(),
      store,
      expectedCursor: null,
    });
    await writeFile(
      join(store.paths('scenario-software-delivery-fixture').locksDirectory, '.publication.lock'),
      'held\n',
    );

    await expect(
      buildAndPublishSoftwareDeliverySnapshot({
        sourceBytes: changedFixture('fixture-cursor-002'),
        store,
        expectedCursor: 'fixture-cursor-001',
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_LOCKED' });
    expect(await store.currentCursor('scenario-software-delivery-fixture')).toBe(
      'fixture-cursor-001',
    );
  });

  it('preserves the committed-unverified store outcome for caller reconciliation', async () => {
    const error = new GraphStoreError(
      'GRAPH_STORE_COMMITTED_UNVERIFIED',
      'injected post-commit readback failure',
    );
    const store = {
      publishSnapshot: async () => {
        throw error;
      },
    } as unknown as LocalGraphStore;

    await expect(
      buildAndPublishSoftwareDeliverySnapshot({
        sourceBytes: fixture(),
        store,
        expectedCursor: null,
      }),
    ).rejects.toBe(error);
  });
});

describe('buildAndPublishGraphSnapshot sealed scenario dispatch', () => {
  it('registers only the two host-owned source profiles', () => {
    expect(graphSnapshotBuildProfile(CONTRACT_TO_DELIVERY_SCENARIO_ID)).toEqual({
      scenarioId: CONTRACT_TO_DELIVERY_SCENARIO_ID,
      sourceBytes: CONTRACT_TO_DELIVERY_SOURCE_LIMITS.sourceBytes,
      sourceJsonNodes: CONTRACT_TO_DELIVERY_SOURCE_LIMITS.sourceJsonNodes,
      textBytes: CONTRACT_TO_DELIVERY_SOURCE_LIMITS.textBytes,
    });
    expect(graphSnapshotBuildProfile('software-delivery')).toEqual({
      scenarioId: 'software-delivery',
      sourceBytes: SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceBytes,
      sourceJsonNodes: SOFTWARE_DELIVERY_SOURCE_LIMITS.sourceJsonNodes,
      textBytes: SOFTWARE_DELIVERY_SOURCE_LIMITS.textBytes,
    });
    expect(graphSnapshotBuildProfile('unregistered-pack')).toBeUndefined();
  });

  it('rejects a runtime-selected scenario outside the sealed dispatch', async () => {
    const store = new LocalGraphStore(join(await root(), 'graph'));
    await expect(
      buildAndPublishGraphSnapshot({
        scenarioId: 'unregistered-pack' as never,
        sourceBytes: contractFixture(),
        store,
        expectedCursor: null,
      }),
    ).rejects.toMatchObject({
      code: 'GRAPH_SCOPE_INVALID',
      path: '$.scenarioId',
    });
  });

  it('strictly projects and CAS-publishes the checked-in composite fixture', async () => {
    const store = new LocalGraphStore(join(await root(), 'graph'));
    const result = await buildAndPublishGraphSnapshot({
      scenarioId: CONTRACT_TO_DELIVERY_SCENARIO_ID,
      sourceBytes: contractFixture(),
      store,
      expectedCursor: null,
      expectedScenarioInstanceId: 'scenario-contract-delivery-001',
    });

    const readback = await store.readCurrentSnapshot(result.scenarioInstanceId);
    expect(result).toMatchObject({
      scenarioInstanceId: 'scenario-contract-delivery-001',
      previousCursor: null,
      cursor: 'contract-source-cursor-001',
      snapshotIntegrityHash: readback.integrityHash,
      nodeCount: readback.nodes.length,
      edgeCount: readback.edges.length,
    });
    expect(readback.projectorVersion).toBe('openslack.contract_to_delivery.v1');
    expect(readback.nodes.some((node) => node.type === 'business.outcome')).toBe(true);
  });

  it('enforces the composite pre-parse byte ceiling', async () => {
    const store = new LocalGraphStore(join(await root(), 'graph'));
    await expect(
      buildAndPublishGraphSnapshot({
        scenarioId: CONTRACT_TO_DELIVERY_SCENARIO_ID,
        sourceBytes: Buffer.alloc(CONTRACT_TO_DELIVERY_SOURCE_LIMITS.sourceBytes + 1, 0x20),
        store,
        expectedCursor: null,
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_BOUND_EXCEEDED', path: '$' });
  });
});
