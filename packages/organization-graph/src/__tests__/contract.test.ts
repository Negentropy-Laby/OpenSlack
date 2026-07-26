import { describe, expect, it } from 'vitest';
import {
  GraphContractError,
  calculateGraphSnapshotIntegrity,
  canonicalJson,
  canonicalizeGraphSnapshot,
  deriveGraphEdgeId,
  deriveGraphNodeId,
  graphDeltaJsonSchema,
  graphSnapshotJsonSchema,
  sealGraphDelta,
  sealGraphSnapshot,
  validateGraphSnapshot,
  verifyGraphDeltaIntegrity,
  verifyGraphSnapshotIntegrity,
} from '../index.js';
import { EDGE_IDS, NODE_IDS, graphDelta, graphSnapshot } from './fixtures.js';

describe('organization graph contracts', () => {
  it('publishes closed snapshot and delta JSON Schemas', () => {
    expect(graphSnapshotJsonSchema.additionalProperties).toBe(false);
    expect(graphDeltaJsonSchema.additionalProperties).toBe(false);
    expect(graphSnapshotJsonSchema.$defs.graphNode.additionalProperties).toBe(false);
    expect(graphSnapshotJsonSchema.$defs.graphEdge.additionalProperties).toBe(false);
    expect(graphSnapshotJsonSchema.$defs.authorityRef.additionalProperties).toBe(false);
    expect(Object.isFrozen(graphSnapshotJsonSchema.$defs.graphNode.properties)).toBe(true);
    for (const definition of [
      'boundedString',
      'identifier',
      'dateTime',
      'stringSet50',
      'authorityRef',
      'actorRef',
      'propertyValue',
      'graphNode',
      'graphEdge',
    ] as const) {
      expect(graphDeltaJsonSchema.$defs[definition]).toEqual(
        graphSnapshotJsonSchema.$defs[definition],
      );
    }
    expect(() => {
      (graphSnapshotJsonSchema.$defs.graphNode.properties as { id?: unknown }).id = {
        type: 'number',
      };
    }).toThrow(TypeError);
  });

  it('rejects undeclared fields at every closed boundary', () => {
    const snapshot = graphSnapshot();
    expect(() => validateGraphSnapshot({ ...snapshot, unexpected: true })).toThrow(
      GraphContractError,
    );
    expect(() =>
      validateGraphSnapshot({
        ...snapshot,
        nodes: [{ ...snapshot.nodes[0], unexpected: true }, ...snapshot.nodes.slice(1)],
      }),
    ).toThrow(/not an allowed property/);
  });

  it('canonicalizes graph order, references, owners, and property keys', () => {
    const snapshot = graphSnapshot();
    const input = {
      ...snapshot,
      nodes: [...snapshot.nodes].reverse(),
      edges: [...snapshot.edges].reverse(),
      completeness: {
        ...snapshot.completeness,
        sourcesRequested: ['openslack', 'github', 'github'],
      },
    };
    const sealed = sealGraphSnapshot(input);
    expect(sealed.nodes.map((node) => node.id)).toEqual(Object.values(NODE_IDS).slice(0, 4).sort());
    expect(sealed.edges.map((edge) => edge.id)).toEqual(Object.values(EDGE_IDS).sort());
    expect(sealed.completeness.sourcesRequested).toEqual(['github', 'openslack']);
    expect(canonicalJson(sealed.nodes[0]!.properties)).toContain(
      '"nested":{"alpha":"value","beta":true}',
    );
    expect(canonicalizeGraphSnapshot(sealed)).toEqual(sealed);
  });

  it('excludes only generatedAt and integrityHash from the snapshot digest', () => {
    const first = graphSnapshot();
    const regenerated = sealGraphSnapshot({
      ...first,
      generatedAt: '2026-07-27T09:00:00.000Z',
    });
    const advanced = sealGraphSnapshot({ ...first, cursor: 'cursor-002' });
    const authorityChanged = sealGraphSnapshot({
      ...first,
      nodes: first.nodes.map((node, index) =>
        index === 0
          ? {
              ...node,
              authorityRef: { ...node.authorityRef, version: 'changed-version' },
            }
          : node,
      ),
    });
    expect(regenerated.integrityHash).toBe(first.integrityHash);
    expect(advanced.integrityHash).not.toBe(first.integrityHash);
    expect(authorityChanged.integrityHash).not.toBe(first.integrityHash);
    expect(calculateGraphSnapshotIntegrity(first)).toBe(first.integrityHash);
    expect(verifyGraphSnapshotIntegrity(first)).toBe(true);
  });

  it('seals and verifies explicit closures in a delta', () => {
    const delta = graphDelta('cursor-001', 'cursor-002');
    expect(delta.closeNodeIds).toEqual([NODE_IDS.d]);
    expect(delta.closeEdgeIds).toEqual([EDGE_IDS.cd]);
    expect(verifyGraphDeltaIntegrity(delta)).toBe(true);
    expect(
      verifyGraphDeltaIntegrity({
        ...delta,
        closeNodeIds: [NODE_IDS.a],
      }),
    ).toBe(false);
    expect(() =>
      sealGraphDelta({
        ...delta,
        closeNodeIds: [NODE_IDS.e],
      }),
    ).toThrow(/cannot close and upsert the same node/);
  });

  it('rejects unsafe or unbounded properties before hashing', () => {
    const snapshot = graphSnapshot();
    expect(() =>
      sealGraphSnapshot({
        ...snapshot,
        nodes: snapshot.nodes.map((node, index) =>
          index === 0 ? { ...node, properties: { api_token: 'not-even-needed' } } : node,
        ),
      }),
    ).toThrow(/property key is not permitted/);
    expect(() =>
      sealGraphSnapshot({
        ...snapshot,
        nodes: snapshot.nodes.map((node, index) =>
          index === 0 ? { ...node, properties: { link: 'https://untrusted.invalid' } } : node,
        ),
      }),
    ).toThrow(/URLs, or active content/);
    expect(() =>
      sealGraphSnapshot({
        ...snapshot,
        nodes: snapshot.nodes.map((node, index) =>
          index === 0 ? { ...node, properties: { value: 'xoxb-1234567890-sensitive' } } : node,
        ),
      }),
    ).toThrow(/credentials, URLs, or active content/);
    expect(() =>
      sealGraphSnapshot({
        ...snapshot,
        nodes: snapshot.nodes.map((node, index) =>
          index === 0
            ? {
                ...node,
                properties: { value: 'AWS_SECRET_ACCESS_KEY=not-a-real-secret' },
              }
            : node,
        ),
      }),
    ).toThrow(/credentials, URLs, or active content/);
    const leakedAuthority = {
      ...snapshot.nodes[0]!.authorityRef,
      objectId: 'xoxb-1234567890-sensitive',
    };
    expect(() =>
      sealGraphSnapshot({
        ...snapshot,
        nodes: snapshot.nodes.map((node, index) =>
          index === 0
            ? {
                ...node,
                id: deriveGraphNodeId({
                  scenarioInstanceId: node.scenarioInstanceId,
                  type: node.type,
                  authorityRef: leakedAuthority,
                }),
                authorityRef: leakedAuthority,
              }
            : node,
        ),
      }),
    ).toThrow(/credential material/);
  });

  it('derives identity from scenario, type, and authority object identity only', () => {
    const authority = graphSnapshot().nodes[0]!.authorityRef;
    const first = deriveGraphNodeId({
      scenarioInstanceId: 'scenario-001',
      type: 'core.work_item',
      authorityRef: authority,
    });
    const reobservedAuthority = {
      ...authority,
      version: 'new-version',
      observedAt: '2026-07-27T08:00:00.000Z',
    };
    const observedAgain = deriveGraphNodeId({
      scenarioInstanceId: 'scenario-001',
      type: 'core.work_item',
      authorityRef: reobservedAuthority,
    });
    expect(observedAgain).toBe(first);
    expect(
      deriveGraphNodeId({
        scenarioInstanceId: 'scenario-002',
        type: 'core.work_item',
        authorityRef: authority,
      }),
    ).not.toBe(first);
    expect(
      deriveGraphNodeId({
        scenarioInstanceId: 'scenario-001',
        type: 'outcome',
        authorityRef: authority,
      }),
    ).not.toBe(first);
    expect(
      deriveGraphNodeId({
        scenarioInstanceId: 'scenario-001',
        type: 'core.work_item',
        authorityRef: { ...authority, objectId: 'different-object' },
      }),
    ).not.toBe(first);
    expect(
      deriveGraphEdgeId({
        scenarioInstanceId: 'scenario-001',
        type: 'produces',
        from: first,
        to: 'node-target',
      }),
    ).toMatch(/^edge:sha256:[0-9a-f]{64}$/);
  });

  it('rejects caller-selected IDs and semantic identity aliases', () => {
    const snapshot = graphSnapshot();
    expect(() =>
      sealGraphSnapshot({
        ...snapshot,
        nodes: snapshot.nodes.map((node, index) =>
          index === 0 ? { ...node, id: 'caller-selected' } : node,
        ),
      }),
    ).toThrow(/must equal the derived stable ID/);
    const first = snapshot.nodes[0]!;
    expect(() =>
      sealGraphSnapshot({
        ...snapshot,
        nodes: [
          ...snapshot.nodes,
          {
            ...first,
            id: 'semantic-alias',
            title: 'Duplicate semantic identity',
          },
        ],
      }),
    ).toThrow(/must equal the derived stable ID/);
  });

  it('rejects calendar-invalid RFC 3339 timestamps', () => {
    const snapshot = graphSnapshot();
    expect(() =>
      sealGraphSnapshot({
        ...snapshot,
        generatedAt: '2026-02-30T00:00:00.000Z',
      }),
    ).toThrow(/RFC 3339 date-time/);
  });
});
