import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GRAPH_SHADOW_POLICY,
  GRAPH_SHADOW_RECEIPT_SCHEMA,
  GraphShadowHttpPublisher,
  canonicalJson,
  parseGraphShadowReceipt,
  prepareGraphShadowRequest,
} from '../index.js';
import type {
  GraphShadowOperation,
  GraphShadowPublishInput,
  GraphShadowReceipt,
  GraphShadowReceiptStatus,
} from '../index.js';
import { graphDelta, graphSnapshot, graphTransitionSnapshot } from './fixtures.js';

function receiptFor(
  input: GraphShadowPublishInput,
  status: GraphShadowReceiptStatus,
  revision = 1,
): GraphShadowReceipt {
  const request = prepareGraphShadowRequest(input);
  const operation: GraphShadowOperation =
    input.delta === undefined ? 'snapshot_ingest' : 'delta_ingest';
  return {
    schema: GRAPH_SHADOW_RECEIPT_SCHEMA,
    operation,
    status,
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: request.requestFingerprint,
    scenarioInstanceId: input.snapshot.scenarioInstanceId,
    cursor: input.snapshot.cursor,
    revision,
    snapshotIntegrityHash: input.snapshot.integrityHash,
    ...(input.delta === undefined ? {} : { deltaIntegrityHash: input.delta.integrityHash }),
    ...(status === 'reconciliation_required'
      ? { reconciliationToken: 'reconcile-001' }
      : { committedAt: '2026-07-30T01:02:03.000Z' }),
  };
}

function responseFor(receipt: GraphShadowReceipt, status: number): Response {
  return new Response(JSON.stringify(receipt), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

describe('organization graph HTTP shadow publisher', () => {
  it('materializes exact canonical snapshot and delta requests with stable fingerprints', () => {
    const snapshotInput: GraphShadowPublishInput = {
      expectedCursor: null,
      snapshot: graphSnapshot('cursor-001'),
    };
    const snapshotRequest = prepareGraphShadowRequest(snapshotInput);
    expect(snapshotRequest.operation).toBe('snapshot_ingest');
    expect(snapshotRequest.path).toBe('/v1/graph/snapshots:ingest');
    expect(snapshotRequest.body).toBe(
      canonicalJson({
        expectedCursor: null,
        snapshot: snapshotInput.snapshot,
      }),
    );
    expect(JSON.parse(snapshotRequest.body)).toEqual({
      expectedCursor: null,
      snapshot: snapshotInput.snapshot,
    });
    const snapshotDigest = createHash('sha256')
      .update(`POST\n${snapshotRequest.path}\n${snapshotRequest.body}`, 'utf8')
      .digest('hex');
    expect(snapshotRequest.requestFingerprint).toBe(`sha256:${snapshotDigest}`);
    expect(snapshotRequest.idempotencyKey).toBe(`openslack.graph-shadow.v1.${snapshotDigest}`);
    expect(snapshotRequest).toEqual(prepareGraphShadowRequest(snapshotInput));

    const deltaInput: GraphShadowPublishInput = {
      expectedCursor: 'cursor-001',
      snapshot: graphTransitionSnapshot('cursor-002'),
      delta: graphDelta('cursor-001', 'cursor-002'),
    };
    const deltaRequest = prepareGraphShadowRequest(deltaInput);
    expect(deltaRequest.operation).toBe('delta_ingest');
    expect(deltaRequest.path).toBe('/v1/graph/deltas:ingest');
    expect(JSON.parse(deltaRequest.body)).toEqual({
      expectedCursor: 'cursor-001',
      targetSnapshot: deltaInput.snapshot,
      delta: deltaInput.delta,
    });
    const expectedDigest = createHash('sha256')
      .update(`POST\n${deltaRequest.path}\n${deltaRequest.body}`, 'utf8')
      .digest('hex');
    expect(deltaRequest.requestFingerprint).toBe(`sha256:${expectedDigest}`);
    expect(deltaRequest.idempotencyKey).toBe(`openslack.graph-shadow.v1.${expectedDigest}`);
  });

  it.each([
    'https://127.0.0.1:8080',
    'http://example.com:8080',
    'http://0.0.0.0:8080',
    'http://user:pass@127.0.0.1:8080',
    'http://127.0.0.1:8080/v1',
    'http://127.0.0.1:8080/?query=yes',
  ])('rejects a non-exact loopback origin: %s', (origin) => {
    expect(() => new GraphShadowHttpPublisher({ origin })).toThrow(/loopback HTTP origin/u);
  });

  it.each([
    'http://127.0.0.1:18181',
    'http://10.20.30.40:18181',
    'http://172.16.0.1:18181',
    'http://172.31.255.254:18181',
    'http://192.168.1.1:18181',
    'http://169.254.1.1:18181',
    'http://[::1]:18181',
    'http://[fc00::1]:18181',
    'http://[fd12::1]:18181',
    'http://[fe80::1]:18181',
  ])('allows an explicit private or link-local IP literal in internal mode: %s', (origin) => {
    expect(() => new GraphShadowHttpPublisher({ origin, networkMode: 'internal' })).not.toThrow();
  });

  it.each([
    'http://localhost:18181',
    'http://graph.internal:18181',
    'http://8.8.8.8:18181',
    'http://0.0.0.0:18181',
    'http://172.15.0.1:18181',
    'http://172.32.0.1:18181',
    'http://[::]:18181',
    'http://[2001:4860:4860::8888]:18181',
  ])('rejects DNS, wildcard, and public origins in internal mode: %s', (origin) => {
    expect(() => new GraphShadowHttpPublisher({ origin, networkMode: 'internal' })).toThrow(
      /internal HTTP origin/u,
    );
  });

  it('sends one snapshot request and emits a bounded authority-explicit accepted observation', async () => {
    const input: GraphShadowPublishInput = {
      expectedCursor: null,
      snapshot: graphSnapshot('cursor-001'),
    };
    const expected = prepareGraphShadowRequest(input);
    const observations: unknown[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:18181/v1/graph/snapshots:ingest');
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(expected.idempotencyKey);
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
      expect(init?.body).toBe(expected.body);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return responseFor(receiptFor(input, 'accepted'), 201);
    });
    const publisher = new GraphShadowHttpPublisher({
      origin: 'http://127.0.0.1:18181',
      fetch: fetchMock,
      auditSink: (observation) => {
        observations.push(observation);
      },
      now: sequenceClock(1_000, 1_017),
    });

    const observation = await publisher.publish(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({
      schema: 'openslack.graph_shadow_observation.v1',
      operation: 'snapshot_ingest',
      outcome: 'accepted',
      endpoint: 'http://127.0.0.1:18181/v1/graph/snapshots:ingest',
      attemptedAt: '1970-01-01T00:00:01.000Z',
      completedAt: '1970-01-01T00:00:01.017Z',
      latencyMs: 17,
      authority: 'ts-local',
      shadow: 'go',
      backlog: 0,
      inFlight: 1,
      parity: 'not_compared',
      idempotencyKey: expected.idempotencyKey,
      requestFingerprint: expected.requestFingerprint,
      httpStatus: 201,
    });
    expect(observations).toEqual([observation]);
    expect(JSON.stringify(observation)).not.toContain('"nodes"');
    expect(JSON.stringify(observation)).not.toContain('"delta"');
  });

  it.each([['duplicate', 200] as const, ['reconciliation_required', 202] as const])(
    'accepts an exact delta %s receipt without claiming graph parity',
    async (status, httpStatus) => {
      const input: GraphShadowPublishInput = {
        expectedCursor: 'cursor-001',
        snapshot: graphTransitionSnapshot('cursor-002'),
        delta: graphDelta('cursor-001', 'cursor-002'),
      };
      const fetchMock = vi.fn(async () => responseFor(receiptFor(input, status, 2), httpStatus));
      const publisher = new GraphShadowHttpPublisher({
        origin: 'http://localhost:18181',
        fetch: fetchMock,
      });

      const observation = await publisher.publish(input);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(observation).toMatchObject({
        operation: 'delta_ingest',
        outcome: status,
        httpStatus,
        parity: 'not_compared',
        receipt: {
          deltaIntegrityHash: input.delta!.integrityHash,
          status,
        },
      });
    },
  );

  it('classifies terminal conflicts and retries bounded transition ordering races', async () => {
    const input: GraphShadowPublishInput = {
      expectedCursor: null,
      snapshot: graphSnapshot('cursor-001'),
    };
    const conflictFetch = vi.fn(async () => new Response('conflict', { status: 409 }));
    const conflict = await new GraphShadowHttpPublisher({
      origin: 'http://127.0.0.1:18181',
      fetch: conflictFetch,
    }).publish(input);
    expect(conflict).toMatchObject({
      outcome: 'conflict',
      code: 'SHADOW_CONFLICT',
      httpStatus: 409,
    });
    expect(conflictFetch).toHaveBeenCalledTimes(1);

    const deltaInput: GraphShadowPublishInput = {
      expectedCursor: 'cursor-001',
      snapshot: graphTransitionSnapshot('cursor-002'),
      delta: graphDelta('cursor-001', 'cursor-002'),
    };
    let orderingAttempt = 0;
    const orderingFetch = vi.fn(async () => {
      orderingAttempt += 1;
      if (orderingAttempt === 1) return new Response('parent missing', { status: 404 });
      if (orderingAttempt === 2) return new Response('head racing', { status: 409 });
      return responseFor(receiptFor(deltaInput, 'accepted', 2), 201);
    });
    const recovered = await new GraphShadowHttpPublisher({
      origin: 'http://127.0.0.1:18181',
      orderingRetryDelayMs: 1,
      fetch: orderingFetch,
    }).publish(deltaInput);
    expect(recovered).toMatchObject({
      outcome: 'accepted',
      httpStatus: 201,
      receipt: { cursor: 'cursor-002', revision: 2 },
    });
    expect(orderingFetch).toHaveBeenCalledTimes(3);

    const exhaustedFetch = vi.fn(async () => new Response('head still racing', { status: 409 }));
    const exhausted = await new GraphShadowHttpPublisher({
      origin: 'http://127.0.0.1:18181',
      orderingRetryDelayMs: 1,
      fetch: exhaustedFetch,
    }).publish(deltaInput);
    expect(exhausted).toMatchObject({
      outcome: 'conflict',
      code: 'SHADOW_CONFLICT',
      httpStatus: 409,
    });
    expect(exhaustedFetch).toHaveBeenCalledTimes(GRAPH_SHADOW_POLICY.orderingRetryAttempts);

    const unavailableFetch = vi.fn(async () => new Response('unavailable', { status: 503 }));
    const unavailable = await new GraphShadowHttpPublisher({
      origin: 'http://127.0.0.1:18181',
      fetch: unavailableFetch,
    }).publish(input);
    expect(unavailable).toMatchObject({
      outcome: 'http_error',
      code: 'SHADOW_UNEXPECTED_STATUS',
      httpStatus: 503,
    });
    expect(unavailableFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized, duplicate-key, extra-field, status, and binding receipt drift', async () => {
    const input: GraphShadowPublishInput = {
      expectedCursor: null,
      snapshot: graphSnapshot('cursor-001'),
    };
    const exact = receiptFor(input, 'accepted');
    const cases: Array<{ response: Response; code: string }> = [
      {
        response: new Response('x'.repeat(1_025), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
        code: 'SHADOW_RECEIPT_TOO_LARGE',
      },
      {
        response: new Response(
          `{"schema":"${GRAPH_SHADOW_RECEIPT_SCHEMA}","schema":"${GRAPH_SHADOW_RECEIPT_SCHEMA}"}`,
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        ),
        code: 'SHADOW_RECEIPT_INVALID',
      },
      {
        response: new Response(JSON.stringify({ ...exact, extra: true }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
        code: 'SHADOW_RECEIPT_INVALID',
      },
      {
        response: responseFor(exact, 200),
        code: 'SHADOW_RECEIPT_STATUS_MISMATCH',
      },
      {
        response: responseFor({ ...exact, cursor: 'different-cursor' }, 201),
        code: 'SHADOW_RECEIPT_BINDING_MISMATCH',
      },
    ];

    for (const fixture of cases) {
      const publisher = new GraphShadowHttpPublisher({
        origin: 'http://127.0.0.1:18181',
        maxReceiptBytes: 1_024,
        fetch: async () => fixture.response,
      });
      const observation = await publisher.publish(input);
      expect(observation).toMatchObject({
        outcome: 'response_invalid',
        code: fixture.code,
        parity: 'not_compared',
      });
    }
  });

  it('times out once, aborts the request, and ignores audit sink failure', async () => {
    const input: GraphShadowPublishInput = {
      expectedCursor: null,
      snapshot: graphSnapshot('cursor-001'),
    };
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        signal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      },
    );
    const publisher = new GraphShadowHttpPublisher({
      origin: 'http://127.0.0.1:18181',
      timeoutMs: 1,
      fetch: fetchMock,
      auditSink: () => {
        throw new Error('audit unavailable');
      },
    });

    const observation = await publisher.publish(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(observation).toMatchObject({
      outcome: 'transport_error',
      code: 'SHADOW_TIMEOUT',
    });
  });

  it('applies the same timeout to receipt streaming and never retries', async () => {
    const input: GraphShadowPublishInput = {
      expectedCursor: null,
      snapshot: graphSnapshot('cursor-001'),
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('{"schema":', 'utf8'));
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(body, {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const publisher = new GraphShadowHttpPublisher({
      origin: 'http://127.0.0.1:18181',
      timeoutMs: 1,
      fetch: fetchMock,
    });

    const observation = await publisher.publish(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({
      outcome: 'transport_error',
      code: 'SHADOW_TIMEOUT',
    });
  });

  it('strictly parses only the operation/status-dependent receipt shape', () => {
    const snapshotInput: GraphShadowPublishInput = {
      expectedCursor: null,
      snapshot: graphSnapshot(),
    };
    const accepted = receiptFor(snapshotInput, 'accepted');
    expect(
      parseGraphShadowReceipt(Buffer.from(JSON.stringify(accepted), 'utf8'), 'snapshot_ingest'),
    ).toEqual(accepted);
    expect(
      parseGraphShadowReceipt(
        Buffer.from(JSON.stringify({ ...accepted, reconciliationToken: 'unexpected' }), 'utf8'),
        'snapshot_ingest',
      ),
    ).toBeNull();
    expect(
      parseGraphShadowReceipt(Buffer.from(JSON.stringify(accepted), 'utf8'), 'delta_ingest'),
    ).toBeNull();
    expect(
      parseGraphShadowReceipt(
        Buffer.from(JSON.stringify({ ...accepted, revision: 0 }), 'utf8'),
        'snapshot_ingest',
      ),
    ).toBeNull();
  });
});
