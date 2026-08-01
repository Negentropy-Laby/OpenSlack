import { describe, expect, it, vi } from 'vitest';
import {
  GraphReadCanaryError,
  GraphReadCanaryRouter,
  canonicalJson,
  explainGraph,
  queryGraph,
} from '../index.js';
import type { GraphExplainInput, GraphQueryInput } from '../index.js';
import { NODE_IDS, graphSnapshot } from './fixtures.js';

const BUILD_SHA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const NOW = Date.parse('2026-08-02T00:00:00.000Z');
const EXPIRES_AT = '2026-08-03T00:00:00.000Z';
const CURSOR_SECRET = 'organization-graph-read-canary-test-secret-v1';

function canary(options: Partial<ConstructorParameters<typeof GraphReadCanaryRouter>[0]> = {}) {
  return new GraphReadCanaryRouter({
    backend: 'go',
    tenantId: 'workspace-1',
    expectedTenantId: 'workspace-1',
    scenarioInstanceIds: ['scenario-001'],
    routingEpoch: 41,
    expiresAt: EXPIRES_AT,
    origin: 'http://127.0.0.1:18181',
    expectedBuildSha: BUILD_SHA,
    now: () => NOW,
    ...options,
  });
}

function response(value: unknown, status = 200): Response {
  return new Response(`${canonicalJson(value)}\n`, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function queryEnvelope(input: GraphQueryInput) {
  const snapshot = graphSnapshot();
  return {
    schema: 'openslack.graph_canary_read.v1',
    operation: 'query',
    backend: 'go',
    routingEpoch: 41,
    serviceBuildSha: BUILD_SHA,
    generatedAt: snapshot.generatedAt,
    snapshotCursor: snapshot.cursor,
    result: queryGraph(snapshot, input, { cursorSecret: CURSOR_SECRET, now: NOW }),
  };
}

function explainEnvelope(input: GraphExplainInput) {
  const snapshot = graphSnapshot();
  return {
    schema: 'openslack.graph_canary_read.v1',
    operation: 'explain',
    backend: 'go',
    routingEpoch: 41,
    serviceBuildSha: BUILD_SHA,
    generatedAt: snapshot.generatedAt,
    snapshotCursor: snapshot.cursor,
    result: explainGraph(snapshot, input),
  };
}

describe('Organization Graph bounded read canary', () => {
  it('selects only the exact scenario under one unexpired immutable epoch', () => {
    const router = canary();
    expect(router.route('scenario-other')).toBeUndefined();
    expect(router.route('scenario-001')).toEqual({ backend: 'go', routingEpoch: 41 });
    const expired = canary({
      now: () => Date.parse('2026-08-02T23:59:59.000Z'),
      expiresAt: '2026-08-03T00:00:00.000Z',
    });
    expect(expired.route('scenario-001')).toEqual({ backend: 'go', routingEpoch: 41 });
  });

  it('fails configuration closed for tenant drift, unsafe epochs, and partial Go bindings', () => {
    expect(() => canary({ expectedTenantId: 'workspace-2' })).toThrow(GraphReadCanaryError);
    expect(() => canary({ routingEpoch: 0 })).toThrow(/positive safe integer/u);
    expect(() => canary({ expectedBuildSha: undefined })).toThrow(/exact origin and build SHA/u);
    expect(() => canary({ scenarioInstanceIds: ['scenario-001', 'scenario-001'] })).toThrow(
      /duplicates/u,
    );
    expect(() => canary({ expiresAt: '2026-08-20T00:00:00.000Z' })).toThrow(/lifetime bound/u);
  });

  it('requires an explicit higher-epoch ts-local policy for rollback', async () => {
    const rollback = new GraphReadCanaryRouter({
      backend: 'ts-local',
      tenantId: 'workspace-1',
      expectedTenantId: 'workspace-1',
      scenarioInstanceIds: ['scenario-001'],
      routingEpoch: 42,
      expiresAt: EXPIRES_AT,
      now: () => NOW,
    });
    expect(rollback.route('scenario-001')).toEqual({ backend: 'ts-local', routingEpoch: 42 });
    await expect(rollback.query({ scenarioInstanceId: 'scenario-001' })).rejects.toMatchObject({
      code: 'GRAPH_READ_CANARY_BACKEND_ROLLBACK',
    });
    expect(
      () =>
        new GraphReadCanaryRouter({
          backend: 'ts-local',
          tenantId: 'workspace-1',
          expectedTenantId: 'workspace-1',
          scenarioInstanceIds: ['scenario-001'],
          routingEpoch: 42,
          expiresAt: EXPIRES_AT,
          origin: 'http://127.0.0.1:18181',
          now: () => NOW,
        }),
    ).toThrow(/does not accept Go transport/u);
  });

  it('returns a strictly validated Go query and binds every request to epoch and build', async () => {
    const input: GraphQueryInput = {
      scenarioInstanceId: 'scenario-001',
      rootNodeIds: [NODE_IDS.a],
      depth: 2,
      includeEvidence: true,
    };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:18181/v1/canary/graph:query');
      const headers = new Headers(init?.headers);
      expect(headers.get('X-OpenSlack-Graph-Routing-Epoch')).toBe('41');
      expect(headers.get('X-OpenSlack-Graph-Expected-Build-SHA')).toBe(BUILD_SHA);
      expect(init?.redirect).toBe('manual');
      expect(init?.body).toBe(canonicalJson(input));
      return response(queryEnvelope(input));
    });
    const result = await canary({ fetch: fetchMock }).query(input);
    expect(result).toMatchObject({
      generatedAt: graphSnapshot().generatedAt,
      scenarioInstanceId: 'scenario-001',
      snapshotCursor: graphSnapshot().cursor,
      queryHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a strictly validated Go explanation', async () => {
    const input: GraphExplainInput = {
      scenarioInstanceId: 'scenario-001',
      targetId: NODE_IDS.c,
      rootNodeId: NODE_IDS.a,
      depth: 3,
    };
    const result = await canary({
      fetch: vi.fn(async () => response(explainEnvelope(input))),
    }).explain(input);
    expect(result).toMatchObject({
      generatedAt: graphSnapshot().generatedAt,
      snapshotCursor: graphSnapshot().cursor,
      scenarioInstanceId: 'scenario-001',
      targetId: NODE_IDS.c,
      targetKind: 'node',
    });
  });

  it('never falls back when the selected Go authority fails or drifts', async () => {
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    await expect(
      canary({ fetch: vi.fn(async () => Promise.reject(new Error('offline'))) }).query(input),
    ).rejects.toMatchObject({ code: 'GRAPH_READ_CANARY_NETWORK_ERROR' });
    await expect(
      canary({
        fetch: vi.fn(async () => response({ ...queryEnvelope(input), routingEpoch: 42 })),
      }).query(input),
    ).rejects.toMatchObject({ code: 'GRAPH_READ_CANARY_ROUTE_MISMATCH' });
    await expect(
      canary({
        fetch: vi.fn(async () =>
          response(
            {
              schema: 'openslack.graph_error.v1',
              code: 'GRAPH_QUERY_CURSOR_MISMATCH',
              message: 'safe failure',
            },
            409,
          ),
        ),
      }).query(input),
    ).rejects.toMatchObject({ code: 'GRAPH_QUERY_CURSOR_MISMATCH', httpStatus: 409 });
  });

  it('fails a selected read after policy expiry instead of silently returning to TypeScript', () => {
    let now = NOW;
    const router = canary({ now: () => now, expiresAt: '2026-08-02T00:00:01.000Z' });
    expect(router.route('scenario-001')).toEqual({ backend: 'go', routingEpoch: 41 });
    now += 1_000;
    expect(() => router.route('scenario-001')).toThrowError(
      expect.objectContaining({ code: 'GRAPH_READ_CANARY_POLICY_EXPIRED' }),
    );
  });

  it('rejects noncanonical and extra response members', async () => {
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    await expect(
      canary({
        fetch: vi.fn(
          async () =>
            new Response(JSON.stringify({ ...queryEnvelope(input), extra: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        ),
      }).query(input),
    ).rejects.toMatchObject({ code: 'GRAPH_READ_CANARY_RESPONSE_INVALID' });
  });
});
