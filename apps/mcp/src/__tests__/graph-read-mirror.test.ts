import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEvents } from '@openslack/collaboration';
import {
  GRAPH_SNAPSHOT_SCHEMA,
  canonicalJson,
  deriveGraphNodeId,
  queryGraph,
  sealGraphSnapshot,
  type GraphQueryInput,
  type GraphQueryResult,
} from '@openslack/organization-graph';
import { createOpenSlackGraphReadMirror } from '../graph-read-mirror.js';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-graph-read-mirror-'));
  roots.push(root);
  return root;
}

function authority(input: GraphQueryInput): GraphQueryResult {
  const authorityRef = {
    provider: 'github' as const,
    objectType: 'issue',
    objectId: 'mirror-audit-1',
    version: 'v1',
    observedAt: '2026-08-01T00:00:00.000Z',
  };
  const nodeId = deriveGraphNodeId({
    scenarioInstanceId: 'scenario-001',
    type: 'core.work_item',
    authorityRef,
  });
  const snapshot = sealGraphSnapshot({
    schema: GRAPH_SNAPSHOT_SCHEMA,
    cursor: 'cursor-001',
    scenarioInstanceId: 'scenario-001',
    generatedAt: '2026-08-01T00:00:00.000Z',
    projectorVersion: 'projector-v1',
    nodes: [
      {
        id: nodeId,
        type: 'core.work_item',
        scenarioDefinitionId: 'software-delivery',
        scenarioInstanceId: 'scenario-001',
        title: 'Secret Mirror Node',
        authorityRef,
        owners: [],
        properties: {},
        sourceEventIds: ['raw-source-event'],
        evidenceRefs: ['raw-evidence-ref'],
        projectorVersion: 'projector-v1',
        validFrom: '2026-08-01T00:00:00.000Z',
      },
    ],
    edges: [],
    completeness: {
      sourcesRequested: ['github'],
      sourcesObserved: ['github'],
      missingSources: [],
      warnings: [],
    },
  });
  return queryGraph(snapshot, input, {
    cursorSecret: 'organization-graph-read-mirror-audit-test-secret',
    now: new Date('2026-08-01T00:00:00.000Z'),
  });
}

function response(value: unknown, status = 200): Response {
  return new Response(`${canonicalJson(value)}\n`, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('MCP Organization Graph read-mirror audit composition', () => {
  it('records matching evidence without graph records, endpoints, or request bodies', async () => {
    const root = workspace();
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    const result = authority(input);
    const mirror = createOpenSlackGraphReadMirror({
      workspaceRoot: root,
      origin: 'http://127.0.0.1:18181',
      fetch: vi.fn(async () => response(result)),
      now: () => Date.parse('2026-08-01T01:02:03.000Z'),
    });

    await mirror.observeQuery(input, result);

    const events = readEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'graph.read_mirror.matched',
      actor: { id: 'organization-graph-read-mirror', kind: 'system' },
      object: { kind: 'graph', id: 'scenario-001' },
      source: { kind: 'openslack', ref: 'organization-graph-read-mirror' },
      redacted: true,
      containsSensitiveData: false,
      metadata: {
        observationSchema: 'openslack.graph_read_mirror_observation.v1',
        operation: 'query',
        outcome: 'matched',
        parity: 'matched',
        authority: 'ts-local',
        mirror: 'go',
        requestFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        authorityDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        mirrorDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        snapshotCursorHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    expect(events[0]?.metadata).not.toHaveProperty('snapshotCursor');
    const bytes = readFileSync(
      join(root, '.openslack.local', 'collaboration', 'events.jsonl'),
      'utf8',
    );
    expect(bytes).not.toContain('http://127.0.0.1:18181');
    expect(bytes).not.toContain('Secret Mirror Node');
    expect(bytes).not.toContain('raw-evidence-ref');
    expect(bytes).not.toContain('raw-source-event');
    expect(bytes).not.toContain('rootNodeIds');
    expect(bytes).not.toContain('cursor-001');
  });

  it('records bounded mismatch codes and unavailable outcomes as separate events', async () => {
    const root = workspace();
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    const result = authority(input);
    const drift = structuredClone(result);
    drift.snapshotCursor = 'different-cursor';
    const responses = [response(drift), new Response('unavailable', { status: 503 })];
    const mirror = createOpenSlackGraphReadMirror({
      workspaceRoot: root,
      origin: 'http://127.0.0.1:18181',
      fetch: vi.fn(async () => responses.shift()!),
    });

    await mirror.observeQuery(input, result);
    await mirror.observeQuery(input, result);

    const events = readEvents(root);
    expect(events.map((event) => event.type)).toEqual([
      'graph.read_mirror.mismatched',
      'graph.read_mirror.unavailable',
    ]);
    expect(events[0]?.metadata).toMatchObject({
      parity: 'mismatched',
      differenceCodes: ['SNAPSHOT_CURSOR_MISMATCH'],
    });
    expect(events[1]?.metadata).toMatchObject({
      parity: 'not_compared',
      httpStatus: 503,
      code: 'GRAPH_READ_MIRROR_UNEXPECTED_STATUS',
    });
  });

  it('retains repeated identical observations as distinct audit events', async () => {
    const root = workspace();
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    const result = authority(input);
    const mirror = createOpenSlackGraphReadMirror({
      workspaceRoot: root,
      origin: 'http://127.0.0.1:18181',
      fetch: vi.fn(async () => response(result)),
      now: () => Date.parse('2026-08-01T01:02:03.000Z'),
    });

    await mirror.observeQuery(input, result);
    await mirror.observeQuery(input, result);

    const events = readEvents(root);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
    expect(events.every((event) => event.type === 'graph.read_mirror.matched')).toBe(true);
  });

  it('keeps the TypeScript observation result available when the bound audit path is replaced', async () => {
    const root = workspace();
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    const result = authority(input);
    const mirror = createOpenSlackGraphReadMirror({
      workspaceRoot: root,
      origin: 'http://127.0.0.1:18181',
      fetch: vi.fn(async () => response(result)),
    });
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const collaboration = join(root, '.openslack.local', 'collaboration');
    const original = join(root, '.openslack.local', 'collaboration-original');
    let renamed = false;
    try {
      renameSync(collaboration, original);
      renamed = true;
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toMatch(/^(?:EACCES|EPERM)$/u);
    }
    if (!renamed) {
      await expect(mirror.observeQuery(input, result)).resolves.toMatchObject({
        outcome: 'matched',
        parity: 'matched',
      });
      expect(readEvents(root)).toHaveLength(1);
      expect(diagnostic).not.toHaveBeenCalled();
      return;
    }
    mkdirSync(collaboration);

    await expect(mirror.observeQuery(input, result)).resolves.toMatchObject({
      outcome: 'matched',
      parity: 'matched',
    });
    expect(readEvents(root)).toEqual([]);
    expect(readFileSync(join(original, 'events.jsonl'), 'utf8')).toBe('');
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(
      'OPENSLACK_GRAPH_READ_MIRROR_AUDIT_FAILED: bounded Collaboration audit append failed.',
    );
  });

  it('rejects an unsafe pre-existing hard-linked audit target at composition time', () => {
    const root = workspace();
    const collaboration = join(root, '.openslack.local', 'collaboration');
    mkdirSync(collaboration, { recursive: true });
    const redirected = join(root, 'redirected.txt');
    writeFileSync(redirected, 'unchanged\n');
    linkSync(redirected, join(collaboration, 'events.jsonl'));

    expect(() =>
      createOpenSlackGraphReadMirror({
        workspaceRoot: root,
        origin: 'http://127.0.0.1:18181',
      }),
    ).toThrow(/event file is unsafe/u);
    expect(readFileSync(redirected, 'utf8')).toBe('unchanged\n');
  });

  it('rejects non-canonical workspace roots and public mirror origins', () => {
    const root = workspace();
    expect(() =>
      createOpenSlackGraphReadMirror({
        workspaceRoot: `${root}/.`,
        origin: 'http://127.0.0.1:18181',
      }),
    ).toThrow(/absolute and normalized/u);
    expect(() =>
      createOpenSlackGraphReadMirror({
        workspaceRoot: root,
        origin: 'http://8.8.8.8:18181',
        networkMode: 'internal',
      }),
    ).toThrow(/exact credential-free internal HTTP origin/u);
    expect(existsSync(join(root, '.openslack.local'))).toBe(false);
  });
});
