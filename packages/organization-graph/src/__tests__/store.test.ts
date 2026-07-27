import { afterEach, describe, expect, it } from 'vitest';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GRAPH_SNAPSHOT_SCHEMA,
  LocalGraphStore,
  sealGraphDelta,
  sealGraphSnapshot,
  serializeGraphSnapshot,
} from '../index.js';
import type { GraphStoreError } from '../index.js';
import { graphDelta, graphSnapshot, graphTransitionSnapshot } from './fixtures.js';

const temporaryRoots: string[] = [];

async function temporaryStore(limits: ConstructorParameters<typeof LocalGraphStore>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'openslack-graph-store-'));
  temporaryRoots.push(root);
  return new LocalGraphStore(join(root, 'graph'), limits);
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('local organization graph store', () => {
  it('publishes immutable bytes and advances the current cursor with CAS', async () => {
    const store = await temporaryStore();
    const first = graphSnapshot('cursor-001');
    const published = await store.publishSnapshot(first, { expectedCursor: null });
    expect(published.previousCursor).toBeNull();
    expect(await store.currentCursor('scenario-001')).toBe('cursor-001');
    expect(await store.readCurrentSnapshot('scenario-001')).toEqual(first);
    if (process.platform !== 'win32') {
      expect((await stat(published.snapshotPath)).mode & 0o777).toBe(0o600);
    }

    const second = graphTransitionSnapshot('cursor-002');
    const delta = graphDelta('cursor-001', 'cursor-002');
    await store.publishSnapshot(second, { expectedCursor: 'cursor-001', delta });
    expect(await store.readDelta('scenario-001', 'cursor-001', 'cursor-002')).toEqual(delta);
    await expect(
      store.publishSnapshot(graphSnapshot('cursor-003'), {
        expectedCursor: 'cursor-001',
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_CURSOR_CONFLICT' });
  });

  it('does not initialize missing authority state during a read', async () => {
    const store = await temporaryStore();
    expect(await store.currentCursor('scenario-001')).toBeNull();
    await expect(lstat(store.root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal identifiers before deriving any filesystem path', async () => {
    const store = await temporaryStore();
    expect(() => store.paths('../outside', 'cursor-001')).toThrowError(
      expect.objectContaining<Partial<GraphStoreError>>({
        code: 'GRAPH_STORE_PATH_UNSAFE',
      }),
    );
    await expect(store.readSnapshot('scenario-001', '..\\outside')).rejects.toMatchObject({
      code: 'GRAPH_STORE_PATH_UNSAFE',
    });
  });

  it.skipIf(process.platform === 'win32')('rejects symbolic-link projection files', async () => {
    const store = await temporaryStore();
    const snapshot = graphSnapshot();
    const published = await store.publishSnapshot(snapshot, { expectedCursor: null });
    const outside = join(dirnameFor(published.snapshotPath), 'outside.json');
    await writeFile(outside, serializeGraphSnapshot(snapshot));
    await unlink(published.snapshotPath);
    await symlink(outside, published.snapshotPath);
    await expect(store.readSnapshot('scenario-001', snapshot.cursor)).rejects.toMatchObject({
      code: 'GRAPH_STORE_FILE_UNSAFE',
    });
  });

  it('rejects oversized files before parsing', async () => {
    const writer = await temporaryStore();
    const snapshot = graphSnapshot();
    const published = await writer.publishSnapshot(snapshot, { expectedCursor: null });
    const reader = new LocalGraphStore(writer.root, {
      maxFileBytes: 512,
      maxDirectoryEntries: 4_096,
      maxTotalBytes: 128 * 1024 * 1024,
      maxRecords: 35_000,
    });
    expect((await stat(published.snapshotPath)).size).toBeGreaterThan(512);
    await expect(reader.readSnapshot('scenario-001', snapshot.cursor)).rejects.toMatchObject({
      code: 'GRAPH_STORE_FILE_TOO_LARGE',
    });
  });

  it('rejects oversized directories and non-regular candidates before parsing', async () => {
    const writer = await temporaryStore();
    const snapshot = graphSnapshot();
    await writer.publishSnapshot(snapshot, { expectedCursor: null });
    const entryBoundedReader = new LocalGraphStore(writer.root, {
      maxFileBytes: 16 * 1024 * 1024,
      maxDirectoryEntries: 1,
      maxTotalBytes: 128 * 1024 * 1024,
      maxRecords: 35_000,
    });
    await expect(
      entryBoundedReader.readSnapshot('scenario-001', snapshot.cursor),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_DIRECTORY_LIMIT' });

    const paths = writer.paths('scenario-001', snapshot.cursor);
    await mkdir(join(paths.snapshotsDirectory, 'not-a-regular-file'));
    await expect(writer.readSnapshot('scenario-001', snapshot.cursor)).rejects.toMatchObject({
      code: 'GRAPH_STORE_FILE_UNSAFE',
    });
  });

  it('reserves directory capacity before leaving any immutable projection', async () => {
    const store = await temporaryStore({
      maxFileBytes: 16 * 1024 * 1024,
      maxDirectoryEntries: 3,
      maxTotalBytes: 128 * 1024 * 1024,
      maxRecords: 35_000,
    });
    const paths = store.paths('scenario-001', 'cursor-001');
    await expect(
      store.publishSnapshot(graphSnapshot(), { expectedCursor: null }),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_DIRECTORY_LIMIT' });
    expect(await readdir(paths.snapshotsDirectory)).toEqual([]);
    expect(await readdir(paths.cursorsDirectory)).toEqual([]);
  });

  it('enforces the configured record bound after strict parsing', async () => {
    const writer = await temporaryStore();
    const snapshot = graphSnapshot();
    await writer.publishSnapshot(snapshot, { expectedCursor: null });
    const recordBoundedReader = new LocalGraphStore(writer.root, {
      maxFileBytes: 16 * 1024 * 1024,
      maxDirectoryEntries: 4_096,
      maxTotalBytes: 128 * 1024 * 1024,
      maxRecords: 3,
    });
    await expect(
      recordBoundedReader.readSnapshot('scenario-001', snapshot.cursor),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_RECORD_LIMIT' });
  });

  it.each([
    ['invalid UTF-8', Buffer.from([0xff, 0xfe, 0xfd])],
    ['duplicate keys', Buffer.from('{"schema":1,"schema":2}', 'utf8')],
    ['UTF-8 BOM', Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d])],
  ])('rejects %s in stored JSON', async (_name, bytes) => {
    const store = await temporaryStore();
    const snapshot = graphSnapshot();
    const published = await store.publishSnapshot(snapshot, { expectedCursor: null });
    await writeFile(published.snapshotPath, bytes);
    await expect(store.readSnapshot('scenario-001', snapshot.cursor)).rejects.toMatchObject({
      code: 'GRAPH_STORE_CONTENT_INVALID',
    });
  });

  it('detects same-path identity replacement during a bounded read', async () => {
    const store = await temporaryStore();
    const snapshot = graphSnapshot();
    const published = await store.publishSnapshot(snapshot, { expectedCursor: null });
    const bytes = await readFile(published.snapshotPath);
    const displaced = `${published.snapshotPath}.old`;
    await expect(
      store.readSnapshotForTest('scenario-001', snapshot.cursor, {
        afterBoundedRead: async (path) => {
          await rename(path, displaced);
          await writeFile(path, bytes, { mode: 0o600 });
        },
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_FILE_UNSAFE' });
  });

  it('never publishes a cursor after a partial projection write', async () => {
    const store = await temporaryStore();
    const first = graphSnapshot('cursor-001');
    await store.publishSnapshot(first, { expectedCursor: null });
    const second = graphTransitionSnapshot('cursor-002');
    await expect(
      store.publishSnapshotForTest(
        second,
        {
          expectedCursor: 'cursor-001',
          delta: graphDelta('cursor-001', 'cursor-002'),
        },
        {
          afterProjectionWrite: () => {
            throw new Error('injected partial publish');
          },
        },
      ),
    ).rejects.toThrow('injected partial publish');
    expect(await store.currentCursor('scenario-001')).toBe('cursor-001');
    expect((await store.readCurrentSnapshot('scenario-001')).integrityHash).toBe(
      first.integrityHash,
    );
  });

  it('rejects a delta that does not reconstruct its target snapshot', async () => {
    const store = await temporaryStore();
    await store.publishSnapshot(graphSnapshot('cursor-001'), { expectedCursor: null });
    await expect(
      store.publishSnapshot(graphSnapshot('cursor-002'), {
        expectedCursor: 'cursor-001',
        delta: graphDelta('cursor-001', 'cursor-002'),
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_CONTENT_INVALID' });
    expect(await store.currentCursor('scenario-001')).toBe('cursor-001');
  });

  it('rejects reopening a closed v1 node or edge through an upsert', async () => {
    const current = graphTransitionSnapshot('cursor-001');
    const reopen = <T extends { validTo?: string }>(record: T): Omit<T, 'validTo'> => {
      const { validTo: _closedAt, ...openRecord } = record;
      return openRecord;
    };

    const nodeStore = await temporaryStore();
    await nodeStore.publishSnapshot(current, { expectedCursor: null });
    const closedNode = current.nodes.find((node) => node.validTo !== undefined)!;
    const reopenedNode = reopen(closedNode);
    const nodeTarget = sealGraphSnapshot({
      ...current,
      cursor: 'cursor-002',
      nodes: current.nodes.map((node) => (node.id === reopenedNode.id ? reopenedNode : node)),
    });
    const nodeDelta = sealGraphDelta({
      ...graphDelta('cursor-001', 'cursor-002'),
      generatedAt: nodeTarget.generatedAt,
      upsertNodes: [reopenedNode],
      closeNodeIds: [],
      upsertEdges: [],
      closeEdgeIds: [],
    });
    await expect(
      nodeStore.publishSnapshot(nodeTarget, {
        expectedCursor: 'cursor-001',
        delta: nodeDelta,
      }),
    ).rejects.toThrow(/cannot reopen a closed v1 record/);

    const edgeStore = await temporaryStore();
    await edgeStore.publishSnapshot(current, { expectedCursor: null });
    const closedEdge = current.edges.find((edge) => edge.validTo !== undefined)!;
    const reopenedEdge = reopen(closedEdge);
    const edgeTarget = sealGraphSnapshot({
      ...current,
      cursor: 'cursor-002',
      edges: current.edges.map((edge) => (edge.id === reopenedEdge.id ? reopenedEdge : edge)),
    });
    const edgeDelta = sealGraphDelta({
      ...graphDelta('cursor-001', 'cursor-002'),
      generatedAt: edgeTarget.generatedAt,
      upsertNodes: [],
      closeNodeIds: [],
      upsertEdges: [reopenedEdge],
      closeEdgeIds: [],
    });
    await expect(
      edgeStore.publishSnapshot(edgeTarget, {
        expectedCursor: 'cursor-001',
        delta: edgeDelta,
      }),
    ).rejects.toThrow(/cannot reopen a closed v1 record/);
  });

  it('rejects a projection directory identity replacement before cursor publication', async () => {
    const store = await temporaryStore();
    const first = graphSnapshot('cursor-001');
    await store.publishSnapshot(first, { expectedCursor: null });
    const paths = store.paths('scenario-001', 'cursor-002');
    let replaced = false;
    await expect(
      store.publishSnapshotForTest(
        graphSnapshot('cursor-002'),
        { expectedCursor: 'cursor-001' },
        {
          afterProjectionWrite: async () => {
            if (replaced) return;
            replaced = true;
            await rename(paths.snapshotsDirectory, `${paths.snapshotsDirectory}.displaced`);
            await mkdir(paths.snapshotsDirectory);
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_PATH_UNSAFE' });
    expect(await store.currentCursor('scenario-001')).toBe('cursor-001');
  });

  it('revalidates the compare-and-swap cursor immediately before publication', async () => {
    const store = await temporaryStore();
    const first = graphSnapshot('cursor-001');
    await store.publishSnapshot(first, { expectedCursor: null });
    const paths = store.paths('scenario-001', 'cursor-002');
    await expect(
      store.publishSnapshotForTest(
        graphSnapshot('cursor-002'),
        { expectedCursor: 'cursor-001' },
        {
          beforeCursorPublish: async () => {
            const record = JSON.parse(await readFile(paths.cursorPath, 'utf8')) as Record<
              string,
              unknown
            >;
            record.updatedAt = '2026-07-27T00:00:00.000Z';
            await writeFile(paths.cursorPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_CURSOR_CONFLICT' });
    expect(await store.currentCursor('scenario-001')).toBe('cursor-001');
  });

  it('reports failures after cursor rename as an explicitly committed outcome', async () => {
    const store = await temporaryStore();
    await expect(
      store.publishSnapshotForTest(
        graphSnapshot('cursor-001'),
        { expectedCursor: null },
        {
          afterCursorRename: () => {
            throw new Error('injected post-rename failure');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_COMMITTED_UNVERIFIED' });
    expect(await store.currentCursor('scenario-001')).toBe('cursor-001');
    expect((await store.readCurrentSnapshot('scenario-001')).cursor).toBe('cursor-001');
  });

  it('serializes writers with a per-scenario exclusive lock', async () => {
    const store = await temporaryStore();
    const paths = store.paths('scenario-001', 'cursor-001');
    await store.publishSnapshotForTest(
      graphSnapshot('cursor-001'),
      { expectedCursor: null },
      {
        beforeCursorPublish: async () => {
          await expect(
            store.publishSnapshot(graphSnapshot('cursor-002'), { expectedCursor: null }),
          ).rejects.toMatchObject({ code: 'GRAPH_STORE_LOCKED' });
        },
      },
    );
    expect(await lstat(paths.lockPath).catch(() => undefined)).toBeUndefined();
  });

  it('serializes capacity decisions across different scenarios', async () => {
    const store = await temporaryStore();
    let releaseFirst!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = store.publishSnapshotForTest(
      emptySnapshot('scenario-a', 'cursor-a'),
      { expectedCursor: null },
      {
        afterProjectionWrite: async () => {
          markEntered();
          await release;
        },
      },
    );
    await entered;
    await expect(
      store.publishSnapshot(emptySnapshot('scenario-b', 'cursor-b'), {
        expectedCursor: null,
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_STORE_LOCKED' });
    releaseFirst();
    await first;
    expect(await store.currentCursor('scenario-a')).toBe('cursor-a');
    expect(await store.currentCursor('scenario-b')).toBeNull();
  });
});

function dirnameFor(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')));
}

function emptySnapshot(scenarioInstanceId: string, cursor: string) {
  return sealGraphSnapshot({
    schema: GRAPH_SNAPSHOT_SCHEMA,
    cursor,
    scenarioInstanceId,
    generatedAt: '2026-07-26T09:00:00.000Z',
    projectorVersion: 'projector-v1',
    nodes: [],
    edges: [],
    completeness: {
      sourcesRequested: [],
      sourcesObserved: [],
      missingSources: [],
      warnings: [],
    },
  });
}
