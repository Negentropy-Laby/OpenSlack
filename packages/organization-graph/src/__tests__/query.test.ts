import { describe, expect, it } from 'vitest';
import { explainGraph, graphQueryHash, queryGraph, sealGraphSnapshot } from '../index.js';
import type { GraphQueryError } from '../index.js';
import { EDGE_IDS, NODE_IDS, graphSnapshot } from './fixtures.js';

const cursorSecret = 'query-test-secret-that-is-at-least-32-bytes';

describe('bounded graph query', () => {
  it('traverses deterministic paths without exceeding depth three', () => {
    const snapshot = graphSnapshot();
    const depthTwo = queryGraph(
      snapshot,
      {
        scenarioInstanceId: 'scenario-001',
        rootNodeIds: [NODE_IDS.a],
        depth: 2,
        includeEvidence: true,
      },
      { cursorSecret, now: 1_000 },
    );
    expect(depthTwo.nodes.map((node) => node.id)).toEqual(
      [NODE_IDS.a, NODE_IDS.b, NODE_IDS.c].sort(),
    );
    expect(depthTwo.edges.map((edge) => edge.id)).toEqual([EDGE_IDS.ab, EDGE_IDS.bc].sort());
    expect(depthTwo.paths.find((path) => path.nodeId === NODE_IDS.c)).toEqual({
      nodeId: NODE_IDS.c,
      nodeIds: [NODE_IDS.a, NODE_IDS.b, NODE_IDS.c],
      edgeIds: [EDGE_IDS.ab, EDGE_IDS.bc],
    });
    expect(() =>
      queryGraph(
        snapshot,
        { scenarioInstanceId: 'scenario-001', rootNodeIds: [NODE_IDS.a], depth: 4 },
        { cursorSecret },
      ),
    ).toThrow(/depth must be an integer between 0 and 3/);
  });

  it('uses opaque expiring cursors bound to the normalized query and snapshot', () => {
    const snapshot = graphSnapshot();
    const input = {
      scenarioInstanceId: 'scenario-001',
      rootNodeIds: [NODE_IDS.a],
      depth: 3,
      maxNodes: 2,
    };
    const first = queryGraph(snapshot, input, {
      cursorSecret,
      cursorTtlMs: 5_000,
      now: 1_000,
    });
    expect(first.nodes).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();
    expect(first.nextCursor).not.toContain(first.queryHash);

    const second = queryGraph(
      snapshot,
      { ...input, cursor: first.nextCursor },
      {
        cursorSecret,
        cursorTtlMs: 5_000,
        now: 2_000,
      },
    );
    expect(second.truncation.paginated).toBe(true);
    expect(second.nodes.map((node) => node.id)).toEqual(
      Object.values(NODE_IDS).slice(0, 4).sort().slice(2),
    );

    expect(() =>
      queryGraph(
        snapshot,
        { ...input, depth: 2, cursor: first.nextCursor },
        { cursorSecret, now: 2_000 },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<GraphQueryError>>({
        code: 'GRAPH_QUERY_CURSOR_MISMATCH',
      }),
    );
    expect(() =>
      queryGraph(snapshot, { ...input, cursor: first.nextCursor }, { cursorSecret, now: 6_000 }),
    ).toThrowError(
      expect.objectContaining<Partial<GraphQueryError>>({
        code: 'GRAPH_QUERY_CURSOR_EXPIRED',
      }),
    );
  });

  it('binds filters, evidence mode, direction, limits, and roots into the query hash', () => {
    const base = graphQueryHash({
      scenarioInstanceId: 'scenario-001',
      rootNodeIds: [NODE_IDS.b, NODE_IDS.a],
      depth: 2,
    });
    expect(
      graphQueryHash({
        scenarioInstanceId: 'scenario-001',
        rootNodeIds: [NODE_IDS.a, NODE_IDS.b],
        depth: 2,
      }),
    ).toBe(base);
    expect(
      graphQueryHash({
        scenarioInstanceId: 'scenario-001',
        rootNodeIds: [NODE_IDS.a, NODE_IDS.b],
        depth: 2,
        includeEvidence: true,
      }),
    ).not.toBe(base);
  });

  it('rejects undeclared or ill-typed query input', () => {
    const snapshot = graphSnapshot();
    expect(() =>
      queryGraph(
        snapshot,
        {
          scenarioInstanceId: 'scenario-001',
          includeEvidence: 'yes',
        } as never,
        { cursorSecret },
      ),
    ).toThrow(/includeEvidence must be a boolean/);
    expect(() =>
      queryGraph(
        snapshot,
        {
          scenarioInstanceId: 'scenario-001',
          undeclared: true,
        } as never,
        { cursorSecret },
      ),
    ).toThrow(/not an allowed property/);
  });

  it('does not return edges whose endpoint nodes were filtered out', () => {
    const snapshot = graphSnapshot();
    const result = queryGraph(
      snapshot,
      {
        scenarioInstanceId: 'scenario-001',
        rootNodeIds: [NODE_IDS.a],
        depth: 2,
        nodeTypes: ['verification_evidence'],
      },
      { cursorSecret },
    );
    expect(result.nodes.map((node) => node.id)).toEqual([NODE_IDS.c]);
    expect(result.edges).toEqual([]);
  });

  it('truncates by response bytes while preserving a forward-only cursor', () => {
    const snapshot = graphSnapshot();
    const expanded = sealGraphSnapshot({
      ...snapshot,
      nodes: snapshot.nodes.map((node, index) => ({
        ...node,
        properties: { text: index === 0 ? 'small' : 'x'.repeat(2_000) },
      })),
    });
    const result = queryGraph(
      expanded,
      {
        scenarioInstanceId: 'scenario-001',
        maxNodes: 200,
        maxEdges: 500,
        maxResponseBytes: 2_000,
      },
      { cursorSecret, now: 1_000 },
    );
    expect(result.truncation.truncated).toBe(true);
    expect(result.truncation.byteLimit).toBe(true);
    expect(result.truncation.responseBytes).toBeLessThanOrEqual(2_000);
    expect(result.nextCursor).toBeDefined();
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it('fails closed when one item cannot fit instead of emitting a zero-progress cursor', () => {
    const snapshot = graphSnapshot();
    const expanded = sealGraphSnapshot({
      ...snapshot,
      nodes: snapshot.nodes.map((node) => ({
        ...node,
        properties: { text: 'x'.repeat(2_000) },
      })),
    });
    expect(() =>
      queryGraph(
        expanded,
        {
          scenarioInstanceId: 'scenario-001',
          maxResponseBytes: 1_024,
        },
        { cursorSecret, now: 1_000 },
      ),
    ).toThrow(/pagination cannot make forward progress/);
  });

  it('omits evidence unless explicitly requested', () => {
    const snapshot = graphSnapshot();
    const result = queryGraph(
      snapshot,
      { scenarioInstanceId: 'scenario-001', rootNodeIds: [NODE_IDS.a], depth: 1 },
      { cursorSecret },
    );
    expect(result.nodes.every((node) => node.evidenceRefs.length === 0)).toBe(true);
    expect(result.edges.every((edge) => edge.sourceEventIds.length === 0)).toBe(true);
  });

  it('explains only bounded provenance and the relationship path', () => {
    const explanation = explainGraph(graphSnapshot(), {
      scenarioInstanceId: 'scenario-001',
      rootNodeId: NODE_IDS.a,
      targetId: NODE_IDS.c,
      depth: 2,
    });
    expect(explanation.path).toEqual({
      nodeId: NODE_IDS.c,
      nodeIds: [NODE_IDS.a, NODE_IDS.b, NODE_IDS.c],
      edgeIds: [EDGE_IDS.ab, EDGE_IDS.bc],
    });
    expect(explanation.authorityRef?.provider).toBe('github');
    expect(explanation).not.toHaveProperty('properties');
    expect(explanation).not.toHaveProperty('rawTranscript');
  });

  it('fails closed when a bounded explanation still exceeds the response-byte ceiling', () => {
    const snapshot = graphSnapshot();
    const oversized = sealGraphSnapshot({
      ...snapshot,
      completeness: {
        sourcesRequested: Array.from(
          { length: 50 },
          (_, index) => `${index}-${'界'.repeat(2_000)}`,
        ),
        sourcesObserved: Array.from({ length: 50 }, (_, index) => `${index}-${'界'.repeat(2_000)}`),
        missingSources: Array.from({ length: 50 }, (_, index) => `${index}-${'界'.repeat(2_000)}`),
        warnings: Array.from({ length: 50 }, (_, index) => `${index}-${'界'.repeat(2_000)}`),
      },
    });
    expect(() =>
      explainGraph(oversized, {
        scenarioInstanceId: 'scenario-001',
        targetId: NODE_IDS.a,
      }),
    ).toThrow(/exceeds 524288 bytes/);
  });
});
