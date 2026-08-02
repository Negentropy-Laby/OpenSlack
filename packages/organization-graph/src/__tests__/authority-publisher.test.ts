import { describe, expect, it, vi } from 'vitest';
import {
  GRAPH_SHADOW_RECEIPT_SCHEMA,
  GraphAuthorityHttpPublisher,
  GraphAuthorityPublishError,
  canonicalJson,
  prepareGraphShadowRequest,
  type GraphShadowPublishInput,
  type GraphShadowReceipt,
} from '../index.js';
import { graphDelta, graphSnapshot, graphTransitionSnapshot } from './fixtures.js';

const BUILD_SHA = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function receipt(
  input: GraphShadowPublishInput,
  status: 'accepted' | 'duplicate' | 'reconciliation_required',
): GraphShadowReceipt {
  const request = prepareGraphShadowRequest(input);
  return {
    schema: GRAPH_SHADOW_RECEIPT_SCHEMA,
    operation: input.delta === undefined ? 'snapshot_ingest' : 'delta_ingest',
    status,
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: request.requestFingerprint,
    scenarioInstanceId: input.snapshot.scenarioInstanceId,
    cursor: input.snapshot.cursor,
    revision: 7,
    snapshotIntegrityHash: input.snapshot.integrityHash,
    ...(input.delta === undefined ? {} : { deltaIntegrityHash: input.delta.integrityHash }),
    ...(status === 'reconciliation_required'
      ? { reconciliationToken: 'reconcile-001' }
      : { committedAt: '2026-08-02T00:00:00.000Z' }),
  };
}

function response(value: unknown, status: number): Response {
  return new Response(canonicalJson(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Organization Graph durable authority publisher', () => {
  it('returns success only after an epoch/tenant/build-bound durable Go receipt', async () => {
    const snapshot = graphSnapshot('cursor-001');
    const input = { expectedCursor: null, snapshot } satisfies GraphShadowPublishInput;
    const target = graphTransitionSnapshot('cursor-002');
    const delta = graphDelta('cursor-001', 'cursor-002');
    const deltaInput = {
      expectedCursor: 'cursor-001',
      snapshot: target,
      delta,
    } satisfies GraphShadowPublishInput;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const endpoint = String(url);
      expect(endpoint).toMatch(
        /^http:\/\/127\.0\.0\.1:18181\/v1\/authority\/graph\/(?:snapshots|deltas):ingest$/u,
      );
      const headers = new Headers(init?.headers);
      expect(headers.get('X-OpenSlack-Graph-Routing-Epoch')).toBe('42');
      expect(headers.get('X-OpenSlack-Graph-Expected-Build-SHA')).toBe(BUILD_SHA);
      expect(headers.get('X-OpenSlack-Graph-Tenant-ID')).toBe('workspace-1');
      return response(
        receipt(endpoint.includes('/deltas:ingest') ? deltaInput : input, 'accepted'),
        201,
      );
    });
    const publisher = new GraphAuthorityHttpPublisher({
      origin: 'http://127.0.0.1:18181',
      tenantId: 'workspace-1',
      expectedTenantId: 'workspace-1',
      routingEpoch: 42,
      expectedBuildSha: BUILD_SHA,
      fetch: fetchMock,
    });

    await expect(publisher.publishSnapshot(snapshot, { expectedCursor: null })).resolves.toEqual({
      scenarioInstanceId: snapshot.scenarioInstanceId,
      previousCursor: null,
      cursor: snapshot.cursor,
      snapshotIntegrityHash: snapshot.integrityHash,
      authorityBackend: 'go',
      routingEpoch: 42,
      receiptStatus: 'accepted',
      revision: 7,
    });
    await expect(
      publisher.publishSnapshot(target, { expectedCursor: 'cursor-001', delta }),
    ).resolves.toMatchObject({
      previousCursor: 'cursor-001',
      cursor: 'cursor-002',
      snapshotIntegrityHash: target.integrityHash,
      authorityBackend: 'go',
      routingEpoch: 42,
      receiptStatus: 'accepted',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed for reconciliation and tenant drift', async () => {
    const snapshot = graphSnapshot('cursor-001');
    const input = { expectedCursor: null, snapshot } satisfies GraphShadowPublishInput;
    const publisher = new GraphAuthorityHttpPublisher({
      origin: 'http://127.0.0.1:18181',
      tenantId: 'workspace-1',
      expectedTenantId: 'workspace-1',
      routingEpoch: 42,
      expectedBuildSha: BUILD_SHA,
      fetch: vi.fn(async () => response(receipt(input, 'reconciliation_required'), 202)),
    });
    await expect(
      publisher.publishSnapshot(snapshot, { expectedCursor: null }),
    ).rejects.toMatchObject({
      code: 'GRAPH_AUTHORITY_RECONCILIATION_REQUIRED',
      reconciliationToken: 'reconcile-001',
    });
    expect(
      () =>
        new GraphAuthorityHttpPublisher({
          origin: 'http://127.0.0.1:18181',
          tenantId: 'workspace-1',
          expectedTenantId: 'workspace-2',
          routingEpoch: 42,
          expectedBuildSha: BUILD_SHA,
        }),
    ).toThrow(GraphAuthorityPublishError);
  });
});
