import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
} from '@openslack/organization-graph';
import { createOpenSlackGraphReadAuthority } from '../graph-read-authority.js';

const roots: string[] = [];
const now = Date.parse('2026-08-02T00:00:00.000Z');
const buildSha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-graph-read-authority-'));
  roots.push(root);
  writeFileSync(
    join(root, 'openslack.yaml'),
    [
      'schema: openslack.workspace.v1',
      'workspace_id: workspace-1',
      'name: Authority Test',
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
    objectId: 'authority-audit-1',
    version: 'v1',
    observedAt: '2026-08-02T00:00:00.000Z',
  };
  const nodeId = deriveGraphNodeId({
    scenarioInstanceId: input.scenarioInstanceId,
    type: 'core.work_item',
    authorityRef,
  });
  const snapshot = sealGraphSnapshot({
    schema: GRAPH_SNAPSHOT_SCHEMA,
    cursor: 'cursor-authority-001',
    scenarioInstanceId: input.scenarioInstanceId,
    generatedAt: '2026-08-02T00:00:00.000Z',
    projectorVersion: 'projector-v1',
    nodes: [
      {
        id: nodeId,
        type: 'core.work_item',
        scenarioDefinitionId: 'software-delivery',
        scenarioInstanceId: input.scenarioInstanceId,
        title: 'Secret Authority Node',
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
      cursorSecret: 'organization-graph-read-authority-audit-secret',
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

describe('MCP Organization Graph global read-authority audit composition', () => {
  it('requires a redacted served audit before releasing a Go result', async () => {
    const root = workspace();
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-global' };
    const { snapshot, result } = fixture(input);
    const authority = createOpenSlackGraphReadAuthority({
      workspaceRoot: root,
      backend: 'go',
      tenantId: 'workspace-1',
      routingEpoch: 42,
      expiresAt: '2026-08-03T00:00:00.000Z',
      origin: 'http://127.0.0.1:18181',
      expectedBuildSha: buildSha,
      now: () => now,
      fetch: vi.fn(async () =>
        response({
          schema: 'openslack.graph_authority_read.v1',
          operation: 'query',
          backend: 'go',
          routingEpoch: 42,
          serviceBuildSha: buildSha,
          generatedAt: snapshot.generatedAt,
          snapshotCursor: snapshot.cursor,
          result,
        }),
      ),
    });

    await expect(authority.query(input)).resolves.toMatchObject({
      scenarioInstanceId: 'scenario-global',
    });
    expect(readEvents(root)).toMatchObject([
      {
        type: 'graph.read_authority.served',
        object: { kind: 'graph', id: 'scenario-global' },
        metadata: {
          backend: 'go',
          routingEpoch: 42,
          expectedBuildSha: buildSha,
          requestFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
        },
      },
    ]);
    const bytes = readFileSync(
      join(root, '.openslack.local', 'collaboration', 'events.jsonl'),
      'utf8',
    );
    expect(bytes).not.toContain('http://127.0.0.1:18181');
    expect(bytes).not.toContain('Secret Authority Node');
    expect(bytes).not.toContain('raw-evidence-ref');
    expect(bytes).not.toContain('cursor-authority-001');
  });

  it('records an explicit higher-epoch ts-local rollback for every scenario', () => {
    const root = workspace();
    const authority = createOpenSlackGraphReadAuthority({
      workspaceRoot: root,
      backend: 'ts-local',
      tenantId: 'workspace-1',
      routingEpoch: 43,
      expiresAt: '2026-08-03T00:00:00.000Z',
      now: () => now,
    });
    expect(authority.route('scenario-one')).toEqual({ backend: 'ts-local', routingEpoch: 43 });
    authority.recordTsLocalRead?.('query', { scenarioInstanceId: 'scenario-one' });
    expect(readEvents(root)[0]).toMatchObject({
      type: 'graph.read_authority.rolled_back',
      metadata: { backend: 'ts-local', routingEpoch: 43 },
    });
  });
});
