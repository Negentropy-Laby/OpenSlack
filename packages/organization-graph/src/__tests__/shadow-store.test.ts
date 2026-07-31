import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GRAPH_SHADOW_POLICY, LocalGraphStore } from '../index.js';
import type {
  GraphShadowObservation,
  GraphShadowPublishInput,
  GraphShadowPublishPort,
} from '../index.js';
import { graphDelta, graphSnapshot, graphTransitionSnapshot } from './fixtures.js';

const temporaryRoots: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'openslack-graph-shadow-store-'));
  temporaryRoots.push(directory);
  return join(directory, 'graph');
}

function observation(input: GraphShadowPublishInput): GraphShadowObservation {
  return {
    schema: 'openslack.graph_shadow_observation.v1',
    operation: input.delta === undefined ? 'snapshot_ingest' : 'delta_ingest',
    outcome: 'accepted',
    endpoint:
      input.delta === undefined
        ? 'http://127.0.0.1:18181/v1/graph/snapshots:ingest'
        : 'http://127.0.0.1:18181/v1/graph/deltas:ingest',
    attemptedAt: '2026-07-30T00:00:00.000Z',
    completedAt: '2026-07-30T00:00:00.001Z',
    latencyMs: 1,
    authority: 'ts-local',
    shadow: 'go',
    backlog: 0,
    inFlight: 1,
    parity: 'not_compared',
    scenarioInstanceId: input.snapshot.scenarioInstanceId,
    cursor: input.snapshot.cursor,
    snapshotIntegrityHash: input.snapshot.integrityHash,
    idempotencyKey: 'openslack.graph-shadow.v1.test',
    requestFingerprint: `sha256:${'a'.repeat(64)}`,
    httpStatus: 201,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('LocalGraphStore shadow observation boundary', () => {
  it('performs zero network work when no explicit shadow publisher is configured', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not run'));
    const store = new LocalGraphStore(await root());
    const snapshot = graphSnapshot('cursor-001');

    await store.publishSnapshot(snapshot, { expectedCursor: null });
    expect(await store.currentCursor(snapshot.scenarioInstanceId)).toBe(snapshot.cursor);
    expect(await store.readCurrentSnapshot(snapshot.scenarioInstanceId)).toEqual(snapshot);
    expect(network).not.toHaveBeenCalled();
  });

  it('publishes the same canonical sealed snapshot and delta only after local success', async () => {
    const calls: GraphShadowPublishInput[] = [];
    const publisher: GraphShadowPublishPort = {
      publish: vi.fn(async (input) => {
        calls.push(input);
        return observation(input);
      }),
    };
    const store = new LocalGraphStore(await root(), {}, publisher);
    const first = graphSnapshot('cursor-001');
    const nonCanonicalFirst = {
      ...first,
      nodes: [...first.nodes].reverse(),
      edges: [...first.edges].reverse(),
      completeness: {
        ...first.completeness,
        sourcesRequested: [...first.completeness.sourcesRequested].reverse(),
      },
    };

    const firstReceipt = await store.publishSnapshot(nonCanonicalFirst, {
      expectedCursor: null,
    });
    expect(firstReceipt.cursor).toBe('cursor-001');
    expect(calls).toEqual([{ expectedCursor: null, snapshot: first }]);

    await store.currentCursor(first.scenarioInstanceId);
    await store.readCurrentSnapshot(first.scenarioInstanceId);
    await store.readSnapshot(first.scenarioInstanceId, first.cursor);
    expect(calls).toHaveLength(1);

    const target = graphTransitionSnapshot('cursor-002');
    const delta = graphDelta('cursor-001', 'cursor-002');
    const secondReceipt = await store.publishSnapshot(target, {
      expectedCursor: 'cursor-001',
      delta,
    });
    expect(secondReceipt.cursor).toBe('cursor-002');
    expect(calls).toEqual([
      { expectedCursor: null, snapshot: first },
      { expectedCursor: 'cursor-001', snapshot: target, delta },
    ]);
    await store.readDelta(first.scenarioInstanceId, 'cursor-001', 'cursor-002');
    expect(calls).toHaveLength(2);
  });

  it('does not call the shadow publisher after a failed local CAS', async () => {
    const publish = vi.fn(async (input: GraphShadowPublishInput) => observation(input));
    const store = new LocalGraphStore(await root(), {}, { publish });
    await store.publishSnapshot(graphSnapshot('cursor-001'), { expectedCursor: null });

    await expect(
      store.publishSnapshot(graphSnapshot('cursor-002'), { expectedCursor: null }),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_CURSOR_CONFLICT' });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(await store.currentCursor('scenario-001')).toBe('cursor-001');
  });

  it('keeps the committed TypeScript result successful when the shadow port throws', async () => {
    const publish = vi.fn(async () => {
      throw new Error('shadow unavailable');
    });
    const store = new LocalGraphStore(await root(), {}, { publish });
    const snapshot = graphSnapshot('cursor-001');

    const localReceipt = await store.publishSnapshot(snapshot, { expectedCursor: null });

    expect(localReceipt).toMatchObject({
      cursor: 'cursor-001',
      snapshotIntegrityHash: snapshot.integrityHash,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await store.currentCursor(snapshot.scenarioInstanceId)).toBe(snapshot.cursor);
    expect(await store.readCurrentSnapshot(snapshot.scenarioInstanceId)).toEqual(snapshot);
  });

  it('bounds a stalled shadow queue and catches up without delaying local commits', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const published: GraphShadowPublishInput[] = [];
    const publish = vi.fn(async (input: GraphShadowPublishInput) => {
      started.push(input.snapshot.cursor);
      published.push(input);
      if (input.snapshot.cursor === 'cursor-001') {
        await firstGate;
      }
      return observation(input);
    });
    const store = new LocalGraphStore(await root(), {}, { publish });
    const attempted = GRAPH_SHADOW_POLICY.maxQueuedPublicationsPerScenario + 2;
    let expectedCursor: string | null = null;
    for (let index = 1; index <= attempted; index += 1) {
      const cursor = `cursor-${String(index).padStart(3, '0')}`;
      const snapshot = graphSnapshot(cursor);
      const localReceipt = await store.publishSnapshot(snapshot, { expectedCursor });
      expect(localReceipt.cursor).toBe(cursor);
      expectedCursor = cursor;
    }

    expect(publish).toHaveBeenCalledTimes(1);
    expect(await store.currentCursor('scenario-001')).toBe(expectedCursor);

    releaseFirst();
    await vi.waitFor(() =>
      expect(started).toHaveLength(GRAPH_SHADOW_POLICY.maxQueuedPublicationsPerScenario + 1),
    );
    expect(published.at(-1)).toEqual({
      expectedCursor: `cursor-${String(
        GRAPH_SHADOW_POLICY.maxQueuedPublicationsPerScenario,
      ).padStart(3, '0')}`,
      snapshot: graphSnapshot(`cursor-${String(attempted).padStart(3, '0')}`),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const resumedCursor = `cursor-${String(attempted + 1).padStart(3, '0')}`;
    await store.publishSnapshot(graphSnapshot(resumedCursor), { expectedCursor });
    await vi.waitFor(() => expect(started.at(-1)).toBe(resumedCursor));
  });

  it('serializes shadow publication across store instances without delaying local commits', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const publish = vi.fn(async (input: GraphShadowPublishInput) => {
      started.push(input.snapshot.cursor);
      if (input.snapshot.cursor === 'cursor-001') {
        await firstGate;
      }
      return observation(input);
    });
    const sharedRoot = await root();
    const firstStore = new LocalGraphStore(sharedRoot, {}, { publish });
    const secondStore = new LocalGraphStore(sharedRoot, {}, { publish });
    const first = graphSnapshot('cursor-001');
    const target = graphTransitionSnapshot('cursor-002');
    const delta = graphDelta('cursor-001', 'cursor-002');

    await firstStore.publishSnapshot(first, { expectedCursor: null });
    const secondLocalReceipt = await secondStore.publishSnapshot(target, {
      expectedCursor: first.cursor,
      delta,
    });

    expect(secondLocalReceipt.cursor).toBe(target.cursor);
    expect(started).toEqual(['cursor-001']);
    releaseFirst();
    await vi.waitFor(() => expect(started).toEqual(['cursor-001', 'cursor-002']));
  });
});
