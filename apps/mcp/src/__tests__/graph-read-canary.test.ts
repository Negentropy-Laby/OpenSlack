import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEvents } from '@openslack/collaboration';
import {
  GRAPH_SNAPSHOT_SCHEMA,
  GraphReadCanaryError,
  canonicalJson,
  deriveGraphNodeId,
  queryGraph,
  sealGraphSnapshot,
  type GraphQueryInput,
} from '@openslack/organization-graph';
import { createOpenSlackGraphReadCanary } from '../graph-read-canary.js';

const roots: string[] = [];
const now = Date.parse('2026-08-02T00:00:00.000Z');
const buildSha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-graph-read-canary-'));
  roots.push(root);
  writeFileSync(
    join(root, 'openslack.yaml'),
    [
      'schema: openslack.workspace.v1',
      'workspace_id: workspace-1',
      'name: Canary Test',
      'mode: self_project',
      'workspace:',
      "  root: '.'",
      "  state_root: '.openslack'",
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

function fixture(input: GraphQueryInput) {
  const authorityRef = {
    provider: 'github' as const,
    objectType: 'issue',
    objectId: 'canary-audit-1',
    version: 'v1',
    observedAt: '2026-08-02T00:00:00.000Z',
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
    generatedAt: '2026-08-02T00:00:00.000Z',
    projectorVersion: 'projector-v1',
    nodes: [
      {
        id: nodeId,
        type: 'core.work_item',
        scenarioDefinitionId: 'software-delivery',
        scenarioInstanceId: 'scenario-001',
        title: 'Secret Canary Node',
        authorityRef,
        owners: [],
        properties: {},
        sourceEventIds: ['raw-source-event'],
        evidenceRefs: ['raw-evidence-ref'],
        projectorVersion: 'projector-v1',
        validFrom: '2026-08-02T00:00:00.000Z',
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
  return {
    snapshot,
    result: queryGraph(snapshot, input, {
      cursorSecret: 'organization-graph-read-canary-audit-test-secret',
      now,
    }),
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(`${canonicalJson(value)}\n`, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function goCanary(root: string, fetch: typeof globalThis.fetch) {
  return createOpenSlackGraphReadCanary({
    workspaceRoot: root,
    backend: 'go',
    tenantId: 'workspace-1',
    scenarioInstanceIds: ['scenario-001'],
    routingEpoch: 41,
    expiresAt: '2026-08-03T00:00:00.000Z',
    origin: 'http://127.0.0.1:18181',
    expectedBuildSha: buildSha,
    fetch,
    now: () => now,
  });
}

describe('MCP Organization Graph read-canary audit composition', () => {
  it('records a served Go read using only bounded route and digest evidence', async () => {
    const root = workspace();
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    const { snapshot, result } = fixture(input);
    const canary = goCanary(
      root,
      vi.fn(async () =>
        response({
          schema: 'openslack.graph_canary_read.v1',
          operation: 'query',
          backend: 'go',
          routingEpoch: 41,
          serviceBuildSha: buildSha,
          generatedAt: snapshot.generatedAt,
          snapshotCursor: snapshot.cursor,
          result,
        }),
      ),
    );

    await expect(canary.query(input)).resolves.toMatchObject({
      scenarioInstanceId: 'scenario-001',
      snapshotCursor: 'cursor-001',
    });
    const events = readEvents(root);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'graph.read_canary.served',
      object: { kind: 'graph', id: 'scenario-001' },
      source: { kind: 'openslack', ref: 'organization-graph-read-canary' },
      redacted: true,
      containsSensitiveData: false,
      metadata: {
        operation: 'query',
        outcome: 'served',
        backend: 'go',
        routingEpoch: 41,
        expectedBuildSha: buildSha,
        requestFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    const bytes = readFileSync(
      join(root, '.openslack.local', 'collaboration', 'events.jsonl'),
      'utf8',
    );
    expect(bytes).not.toContain('http://127.0.0.1:18181');
    expect(bytes).not.toContain('Secret Canary Node');
    expect(bytes).not.toContain('raw-evidence-ref');
    expect(bytes).not.toContain('raw-source-event');
    expect(bytes).not.toContain('cursor-001');
  });

  it('records a blocked Go read without replacing the fail-closed error', async () => {
    const root = workspace();
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    const canary = goCanary(
      root,
      vi.fn(async () =>
        response(
          {
            schema: 'openslack.graph_error.v1',
            code: 'GRAPH_QUERY_CURSOR_MISMATCH',
            message: 'safe failure',
          },
          409,
        ),
      ),
    );
    await expect(canary.query(input)).rejects.toMatchObject({
      code: 'GRAPH_QUERY_CURSOR_MISMATCH',
    });
    const expired = new GraphReadCanaryError(
      'GRAPH_READ_CANARY_POLICY_EXPIRED',
      'selected policy expired',
    );
    await canary.recordBlockedRead?.('query', input, expired);
    expect(readEvents(root)).toMatchObject([
      {
        type: 'graph.read_canary.blocked',
        metadata: {
          code: 'GRAPH_QUERY_CURSOR_MISMATCH',
          httpStatus: 409,
        },
      },
      {
        type: 'graph.read_canary.blocked',
        metadata: {
          code: 'GRAPH_READ_CANARY_POLICY_EXPIRED',
          backend: 'go',
          routingEpoch: 41,
        },
      },
    ]);
  });

  it('records stale Go evidence as blocked and never as served', async () => {
    const root = workspace();
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    const { snapshot, result } = fixture(input);
    const canary = goCanary(
      root,
      vi.fn(async () =>
        response({
          schema: 'openslack.graph_canary_read.v1',
          operation: 'query',
          backend: 'go',
          routingEpoch: 41,
          serviceBuildSha: buildSha,
          generatedAt: '2026-07-31T23:59:59.999Z',
          snapshotCursor: snapshot.cursor,
          result,
        }),
      ),
    );

    await expect(canary.query(input)).rejects.toMatchObject({ code: 'SOURCE_EVIDENCE_STALE' });
    expect(readEvents(root)).toMatchObject([
      {
        type: 'graph.read_canary.blocked',
        metadata: { code: 'SOURCE_EVIDENCE_STALE', backend: 'go', routingEpoch: 41 },
      },
    ]);
  });

  it('records an explicit ts-local rollback epoch after the local read succeeds', async () => {
    const root = workspace();
    const canary = createOpenSlackGraphReadCanary({
      workspaceRoot: root,
      backend: 'ts-local',
      tenantId: 'workspace-1',
      scenarioInstanceIds: ['scenario-001'],
      routingEpoch: 42,
      expiresAt: '2026-08-03T00:00:00.000Z',
      now: () => now,
    });
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    await canary.recordTsLocalRead?.('query', input);
    expect(readEvents(root)).toMatchObject([
      {
        type: 'graph.read_canary.rolled_back',
        metadata: { operation: 'query', backend: 'ts-local', routingEpoch: 42 },
      },
    ]);
  });

  it('rejects tenant drift before creating an audit target', () => {
    const root = workspace();
    expect(() =>
      createOpenSlackGraphReadCanary({
        workspaceRoot: root,
        backend: 'ts-local',
        tenantId: 'workspace-other',
        scenarioInstanceIds: ['scenario-001'],
        routingEpoch: 42,
        expiresAt: '2026-08-03T00:00:00.000Z',
        now: () => now,
      }),
    ).toThrow(/tenant binding/u);
    expect(readEvents(root)).toEqual([]);
    expect(existsSync(join(root, '.openslack.local', 'collaboration', 'events.jsonl'))).toBe(false);
  });
});
