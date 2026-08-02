import { describe, expect, it, vi } from 'vitest';
import {
  GraphReadAuthorityError,
  GraphReadAuthorityRouter,
  canonicalJson,
  queryGraph,
  type GraphQueryInput,
} from '../index.js';
import { graphSnapshot } from './fixtures.js';

const BUILD_SHA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const NOW = Date.parse('2026-08-02T00:00:00.000Z');

function authority(
  options: Partial<ConstructorParameters<typeof GraphReadAuthorityRouter>[0]> = {},
) {
  return new GraphReadAuthorityRouter({
    backend: 'go',
    tenantId: 'workspace-1',
    expectedTenantId: 'workspace-1',
    routingEpoch: 42,
    expiresAt: '2026-08-03T00:00:00.000Z',
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

describe('Organization Graph global read authority', () => {
  it('selects every canonical scenario and calls only the authority route', async () => {
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    const snapshot = {
      ...graphSnapshot(),
      generatedAt: new Date(NOW).toISOString(),
    };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:18181/v1/authority/graph:query');
      const headers = new Headers(init?.headers);
      expect(headers.get('X-OpenSlack-Graph-Routing-Epoch')).toBe('42');
      expect(headers.get('X-OpenSlack-Graph-Expected-Build-SHA')).toBe(BUILD_SHA);
      expect(headers.get('X-OpenSlack-Graph-Tenant-ID')).toBe('workspace-1');
      return response({
        schema: 'openslack.graph_authority_read.v1',
        operation: 'query',
        backend: 'go',
        routingEpoch: 42,
        serviceBuildSha: BUILD_SHA,
        generatedAt: snapshot.generatedAt,
        snapshotCursor: snapshot.cursor,
        result: queryGraph(snapshot, input, {
          cursorSecret: 'organization-graph-global-authority-test-secret',
          now: NOW,
        }),
      });
    });
    const router = authority({ fetch: fetchMock });
    expect(router.route('scenario-one')).toEqual({ backend: 'go', routingEpoch: 42 });
    expect(router.route('scenario-two')).toEqual({ backend: 'go', routingEpoch: 42 });
    await expect(router.query(input)).resolves.toMatchObject({
      scenarioInstanceId: 'scenario-001',
      generatedAt: new Date(NOW).toISOString(),
    });
  });

  it('maps failures to authority-specific codes and supports only explicit rollback', async () => {
    await expect(
      authority({ fetch: vi.fn(async () => Promise.reject(new Error('offline'))) }).query({
        scenarioInstanceId: 'scenario-any',
      }),
    ).rejects.toMatchObject({ code: 'GRAPH_READ_AUTHORITY_NETWORK_ERROR' });
    const rollback = authority({
      backend: 'ts-local',
      routingEpoch: 43,
      origin: undefined,
      expectedBuildSha: undefined,
    });
    expect(rollback.route('scenario-any')).toEqual({ backend: 'ts-local', routingEpoch: 43 });
    await expect(rollback.query({ scenarioInstanceId: 'scenario-any' })).rejects.toMatchObject({
      code: 'GRAPH_READ_AUTHORITY_BACKEND_ROLLBACK',
    });
    expect(() => authority({ expectedTenantId: 'workspace-2' })).toThrow(GraphReadAuthorityError);
  });
});
