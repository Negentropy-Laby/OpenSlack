import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GRAPH_READ_MIRROR_POLICY,
  GraphReadMirrorHttpClient,
  canonicalJson,
  explainGraph,
  queryGraph,
} from '../index.js';
import type {
  GraphExplainInput,
  GraphExplanation,
  GraphQueryInput,
  GraphQueryResult,
  GraphReadMirrorObservation,
} from '../index.js';
import { NODE_IDS, graphSnapshot } from './fixtures.js';

const cursorSecret = 'organization-graph-read-mirror-test-secret-v1';
const queryNow = new Date('2026-08-01T00:00:00.000Z');

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function queryAuthority(input: GraphQueryInput): GraphQueryResult {
  return queryGraph(graphSnapshot(), input, { cursorSecret, now: queryNow });
}

function explainAuthority(input: GraphExplainInput): GraphExplanation {
  return explainGraph(graphSnapshot(), input);
}

function canonicalResponse(value: unknown, status = 200): Response {
  return new Response(`${canonicalJson(value)}\n`, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Organization Graph Go read mirror', () => {
  it.each([
    'https://127.0.0.1:18181',
    'http://localhost:18181',
    'http://example.com:18181',
    'http://0.0.0.0:18181',
    'http://user:pass@127.0.0.1:18181',
    'http://127.0.0.1:18181/v1',
  ])('rejects a non-exact loopback origin: %s', (origin) => {
    expect(() => new GraphReadMirrorHttpClient({ origin })).toThrow(
      /exact credential-free loopback HTTP origin/u,
    );
  });

  it.each([
    'http://127.0.0.1:18181',
    'http://10.20.30.40:18181',
    'http://172.31.255.254:18181',
    'http://192.168.1.1:18181',
    'http://169.254.1.1:18181',
    'http://[::1]:18181',
    'http://[fd12::1]:18181',
    'http://[fe80::1]:18181',
  ])('allows an explicit private IP literal in internal mode: %s', (origin) => {
    expect(() => new GraphReadMirrorHttpClient({ origin, networkMode: 'internal' })).not.toThrow();
  });

  it('compares an exact query response and emits only bounded digest evidence', async () => {
    const input: GraphQueryInput = {
      scenarioInstanceId: 'scenario-001',
      rootNodeIds: [NODE_IDS.a],
      depth: 2,
      includeEvidence: true,
    };
    const authority = queryAuthority(input);
    const observations: GraphReadMirrorObservation[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('http://127.0.0.1:18181/v1/graph:query');
      expect(init?.method).toBe('POST');
      expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
      expect(init?.body).toBe(canonicalJson(input));
      return canonicalResponse(authority);
    });
    const client = new GraphReadMirrorHttpClient({
      origin: 'http://127.0.0.1:18181',
      fetch: fetchMock,
      auditSink: (observation) => {
        observations.push(observation);
      },
      now: sequenceClock(1_000, 1_019),
    });

    const observation = await client.observeQuery(input, authority);

    const fingerprint = createHash('sha256')
      .update(`POST\n/v1/graph:query\n${canonicalJson(input)}`, 'utf8')
      .digest('hex');
    expect(observation).toMatchObject({
      schema: 'openslack.graph_read_mirror_observation.v1',
      operation: 'query',
      outcome: 'matched',
      parity: 'matched',
      authority: 'ts-local',
      mirror: 'go',
      scenarioInstanceId: 'scenario-001',
      snapshotCursorHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      queryHash: authority.queryHash,
      requestFingerprint: `sha256:${fingerprint}`,
      attemptedAt: '1970-01-01T00:00:01.000Z',
      completedAt: '1970-01-01T00:00:01.019Z',
      latencyMs: 19,
      httpStatus: 200,
    });
    expect(observation.authorityDigest).toBe(observation.mirrorDigest);
    expect(observation.differenceCodes).toBeUndefined();
    expect(observations).toEqual([observation]);
    expect(JSON.stringify(observation)).not.toContain('Node node-a');
    expect(JSON.stringify(observation)).not.toContain('evidence-node-a');
  });

  it('compares an exact explanation response without persisting the target payload', async () => {
    const input: GraphExplainInput = {
      scenarioInstanceId: 'scenario-001',
      targetId: NODE_IDS.c,
      rootNodeId: NODE_IDS.a,
      depth: 3,
    };
    const authority = explainAuthority(input);
    const client = new GraphReadMirrorHttpClient({
      origin: 'http://127.0.0.1:18181',
      fetch: vi.fn(async () => canonicalResponse(authority)),
    });

    const observation = await client.observeExplain(input, authority);

    expect(observation).toMatchObject({
      operation: 'explain',
      outcome: 'matched',
      parity: 'matched',
      scenarioInstanceId: 'scenario-001',
      httpStatus: 200,
    });
    expect(observation).not.toHaveProperty('snapshotCursor');
    expect(observation).not.toHaveProperty('queryHash');
    expect(JSON.stringify(observation)).not.toContain(NODE_IDS.c);
  });

  it('records field-level parity differences, including distinct cursor issuers', async () => {
    const input: GraphQueryInput = {
      scenarioInstanceId: 'scenario-001',
      maxNodes: 1,
      maxEdges: 1,
      maxResponseBytes: 4_096,
    };
    const authority = queryAuthority(input);
    expect(authority.nextCursor).toBeDefined();
    const mirror = structuredClone(authority);
    mirror.snapshotCursor = 'go-shadow-cursor';
    mirror.nextCursor = `${authority.nextCursor!.slice(0, -1)}A`;
    const client = new GraphReadMirrorHttpClient({
      origin: 'http://127.0.0.1:18181',
      fetch: vi.fn(async () => canonicalResponse(mirror)),
    });

    const observation = await client.observeQuery(input, authority);

    expect(observation).toMatchObject({
      outcome: 'mismatched',
      parity: 'mismatched',
      differenceCodes: ['SNAPSHOT_CURSOR_MISMATCH', 'CURSOR_TOKEN_MISMATCH'],
    });
    expect(observation.authorityDigest).not.toBe(observation.mirrorDigest);
  });

  it('separates cursor presence drift from a token-value mismatch', async () => {
    const input: GraphQueryInput = {
      scenarioInstanceId: 'scenario-001',
      maxNodes: 1,
      maxEdges: 1,
      maxResponseBytes: 4_096,
    };
    const authority = queryAuthority(input);
    const mirror = structuredClone(authority) as GraphQueryResult;
    delete mirror.nextCursor;
    const observation = await new GraphReadMirrorHttpClient({
      origin: 'http://127.0.0.1:18181',
      fetch: vi.fn(async () => canonicalResponse(mirror)),
    }).observeQuery(input, authority);

    expect(observation.differenceCodes).toContain('CURSOR_PRESENCE_MISMATCH');
    expect(observation.differenceCodes).not.toContain('CURSOR_TOKEN_MISMATCH');
  });

  it('maps every non-cursor query and explain field plus unknown keys to closed codes', async () => {
    const queryInput: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    const queryResult = queryAuthority(queryInput);
    const queryCases: Array<readonly [string, (value: Record<string, unknown>) => void]> = [
      ['RESULT_SCHEMA_MISMATCH', (value) => (value.extra = true)],
      ['SCENARIO_INSTANCE_ID_MISMATCH', (value) => (value.scenarioInstanceId = 'other')],
      ['SNAPSHOT_CURSOR_MISMATCH', (value) => (value.snapshotCursor = 'other')],
      ['QUERY_HASH_MISMATCH', (value) => (value.queryHash = 'sha256:other')],
      ['NODES_MISMATCH', (value) => (value.nodes = [])],
      ['EDGES_MISMATCH', (value) => (value.edges = [])],
      ['PATHS_MISMATCH', (value) => (value.paths = [])],
      ['COMPLETENESS_MISMATCH', (value) => (value.completeness = {})],
      ['TRUNCATION_MISMATCH', (value) => (value.truncation = {})],
    ];
    for (const [code, mutate] of queryCases) {
      const mirror = structuredClone(queryResult) as unknown as Record<string, unknown>;
      mutate(mirror);
      const observation = await new GraphReadMirrorHttpClient({
        origin: 'http://127.0.0.1:18181',
        fetch: vi.fn(async () => canonicalResponse(mirror)),
      }).observeQuery(queryInput, queryResult);
      expect(observation.differenceCodes, code).toContain(code);
    }

    const explainInput: GraphExplainInput = {
      scenarioInstanceId: 'scenario-001',
      targetId: NODE_IDS.c,
    };
    const explainResult = explainAuthority(explainInput);
    const explainCases: Array<readonly [string, (value: Record<string, unknown>) => void]> = [
      ['SCENARIO_INSTANCE_ID_MISMATCH', (value) => (value.scenarioInstanceId = 'other')],
      ['TARGET_KIND_MISMATCH', (value) => (value.targetKind = 'edge')],
      ['TARGET_ID_MISMATCH', (value) => (value.targetId = NODE_IDS.a)],
      ['AUTHORITY_REF_MISMATCH', (value) => delete value.authorityRef],
      ['SOURCE_EVENT_IDS_MISMATCH', (value) => (value.sourceEventIds = [])],
      ['EVIDENCE_REFS_MISMATCH', (value) => (value.evidenceRefs = [])],
      ['PROJECTOR_VERSION_MISMATCH', (value) => (value.projectorVersion = 'other')],
      ['VALID_FROM_MISMATCH', (value) => (value.validFrom = '2026-08-02T00:00:00.000Z')],
      ['VALID_TO_MISMATCH', (value) => (value.validTo = '2026-08-03T00:00:00.000Z')],
      ['COMPLETENESS_MISMATCH', (value) => (value.completeness = {})],
      ['PATH_MISMATCH', (value) => (value.path = {})],
      ['TRUNCATION_MISMATCH', (value) => (value.truncation = {})],
    ];
    for (const [code, mutate] of explainCases) {
      const mirror = structuredClone(explainResult) as unknown as Record<string, unknown>;
      mutate(mirror);
      const observation = await new GraphReadMirrorHttpClient({
        origin: 'http://127.0.0.1:18181',
        fetch: vi.fn(async () => canonicalResponse(mirror)),
      }).observeExplain(explainInput, explainResult);
      expect(observation.differenceCodes, code).toContain(code);
    }
  });

  it.each([
    {
      name: 'HTTP status',
      response: () => new Response('not found', { status: 404 }),
      outcome: 'http_error',
      code: 'GRAPH_READ_MIRROR_UNEXPECTED_STATUS',
    },
    {
      name: 'content type',
      response: () =>
        new Response('{}', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      outcome: 'response_invalid',
      code: 'GRAPH_READ_MIRROR_CONTENT_TYPE_INVALID',
    },
    {
      name: 'non-canonical JSON',
      response: () =>
        new Response('{ "scenarioInstanceId": "scenario-001" }\n', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      outcome: 'response_invalid',
      code: 'GRAPH_READ_MIRROR_RESPONSE_INVALID',
    },
    {
      name: 'duplicate JSON key',
      response: () =>
        new Response('{"scenarioInstanceId":"a","scenarioInstanceId":"b"}\n', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      outcome: 'response_invalid',
      code: 'GRAPH_READ_MIRROR_RESPONSE_INVALID',
    },
  ])('classifies an invalid mirror $name without changing authority', async (testCase) => {
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    const authority = queryAuthority(input);
    const observation = await new GraphReadMirrorHttpClient({
      origin: 'http://127.0.0.1:18181',
      fetch: vi.fn(async () => testCase.response()),
    }).observeQuery(input, authority);

    expect(observation).toMatchObject({
      outcome: testCase.outcome,
      parity: 'not_compared',
      code: testCase.code,
    });
  });

  it('caps the response at the query budget before parsing', async () => {
    const input: GraphQueryInput = {
      scenarioInstanceId: 'scenario-001',
      maxResponseBytes: 4_096,
    };
    const authority = queryAuthority(input);
    const observation = await new GraphReadMirrorHttpClient({
      origin: 'http://127.0.0.1:18181',
      fetch: vi.fn(
        async () =>
          new Response('x'.repeat(4_098), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    }).observeQuery(input, authority);

    expect(observation).toMatchObject({
      outcome: 'response_invalid',
      code: 'GRAPH_READ_MIRROR_RESPONSE_TOO_LARGE',
    });
  });

  it('does not treat the optional line-feed allowance as canonical payload budget', async () => {
    const input: GraphQueryInput = {
      scenarioInstanceId: 'scenario-001',
      maxResponseBytes: 4_096,
    };
    const authority = queryAuthority(input);
    const emptyBytes = Buffer.byteLength(canonicalJson({ extra: '' }), 'utf8');
    const oversized = canonicalJson({ extra: 'x'.repeat(4_097 - emptyBytes) });
    expect(Buffer.byteLength(oversized, 'utf8')).toBe(4_097);
    const observation = await new GraphReadMirrorHttpClient({
      origin: 'http://127.0.0.1:18181',
      fetch: vi.fn(
        async () =>
          new Response(oversized, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    }).observeQuery(input, authority);

    expect(observation).toMatchObject({
      outcome: 'response_invalid',
      parity: 'not_compared',
      code: 'GRAPH_READ_MIRROR_RESPONSE_TOO_LARGE',
    });
  });

  it('bounds timeout and network failure while swallowing audit sink failure', async () => {
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    const authority = queryAuthority(input);
    const auditFailureSink = vi.fn();
    const timeout = await new GraphReadMirrorHttpClient({
      origin: 'http://127.0.0.1:18181',
      timeoutMs: 1,
      fetch: vi.fn(
        async (_url, init) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ),
      auditSink: () => {
        throw new Error('audit unavailable');
      },
      auditFailureSink,
    }).observeQuery(input, authority);
    const network = await new GraphReadMirrorHttpClient({
      origin: 'http://127.0.0.1:18181',
      fetch: vi.fn(async () => {
        throw new Error('network unavailable');
      }),
    }).observeQuery(input, authority);

    expect(timeout).toMatchObject({
      outcome: 'transport_error',
      parity: 'not_compared',
      code: 'GRAPH_READ_MIRROR_TIMEOUT',
    });
    expect(network).toMatchObject({
      outcome: 'transport_error',
      parity: 'not_compared',
      code: 'GRAPH_READ_MIRROR_NETWORK_ERROR',
    });
    expect(auditFailureSink).toHaveBeenCalledOnce();
  });

  it('applies the timeout to a stalled response body after successful headers', async () => {
    const input: GraphQueryInput = { scenarioInstanceId: 'scenario-001' };
    const authority = queryAuthority(input);
    const stalledBody = new ReadableStream<Uint8Array>({
      start() {
        // Deliberately never enqueue or close; the end-to-end mirror deadline must win.
      },
    });
    const observation = await new GraphReadMirrorHttpClient({
      origin: 'http://127.0.0.1:18181',
      timeoutMs: 1,
      fetch: vi.fn(
        async () =>
          new Response(stalledBody, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    }).observeQuery(input, authority);

    expect(observation).toMatchObject({
      outcome: 'transport_error',
      parity: 'not_compared',
      code: 'GRAPH_READ_MIRROR_TIMEOUT',
    });
  });

  it('rejects invalid timeout budgets at construction', () => {
    expect(
      () =>
        new GraphReadMirrorHttpClient({
          origin: 'http://127.0.0.1:18181',
          timeoutMs: GRAPH_READ_MIRROR_POLICY.maxTimeoutMs + 1,
        }),
    ).toThrow(/timeoutMs/u);
  });
});
