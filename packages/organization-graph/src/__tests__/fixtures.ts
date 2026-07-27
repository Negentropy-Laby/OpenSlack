import {
  GRAPH_DELTA_SCHEMA,
  GRAPH_SNAPSHOT_SCHEMA,
  deriveGraphEdgeId,
  deriveGraphNodeId,
  sealGraphDelta,
  sealGraphSnapshot,
} from '../index.js';
import type { GraphDelta, GraphEdge, GraphNode, GraphSnapshot } from '../index.js';

const observedAt = '2026-07-26T08:00:00.000Z';

export function graphNode(
  authorityObjectId: string,
  overrides: Partial<GraphNode> = {},
): GraphNode {
  const candidate: GraphNode = {
    id: '',
    type: 'core.work_item',
    scenarioDefinitionId: 'contract-delivery-lite',
    scenarioInstanceId: 'scenario-001',
    title: `Node ${authorityObjectId}`,
    status: 'open',
    authorityRef: {
      provider: 'github',
      objectType: 'issue',
      objectId: authorityObjectId,
      version: `v-${authorityObjectId}`,
      observedAt,
    },
    owners: [{ id: 'actor-1', kind: 'human', displayName: 'Owner' }],
    properties: { rank: 1, nested: { beta: true, alpha: 'value' } },
    sourceEventIds: [`event-${authorityObjectId}`],
    evidenceRefs: [`evidence-${authorityObjectId}`],
    projectorVersion: 'projector-v1',
    validFrom: observedAt,
    ...overrides,
  };
  candidate.id =
    overrides.id ??
    deriveGraphNodeId({
      scenarioInstanceId: candidate.scenarioInstanceId,
      type: candidate.type,
      authorityRef: candidate.authorityRef,
    });
  return candidate;
}

export const NODE_IDS = Object.freeze({
  a: graphNode('node-a').id,
  b: graphNode('node-b', { type: 'reviewable_deliverable' }).id,
  c: graphNode('node-c', { type: 'verification_evidence', status: 'complete' }).id,
  d: graphNode('node-d', { type: 'outcome' }).id,
  e: graphNode('node-e').id,
});

function graphEdge(type: string, from: string, to: string, sourceSuffix: string): GraphEdge {
  return {
    id: deriveGraphEdgeId({
      scenarioInstanceId: 'scenario-001',
      type,
      from,
      to,
    }),
    type,
    from,
    to,
    scenarioInstanceId: 'scenario-001',
    sourceEventIds: [`event-${sourceSuffix}`],
    evidenceRefs: [`evidence-${sourceSuffix}`],
    projectorVersion: 'projector-v1',
    validFrom: observedAt,
  };
}

export const EDGE_IDS = Object.freeze({
  ab: graphEdge('produces', NODE_IDS.a, NODE_IDS.b, 'ab').id,
  bc: graphEdge('verifies', NODE_IDS.b, NODE_IDS.c, 'bc').id,
  cd: graphEdge('produces', NODE_IDS.c, NODE_IDS.d, 'cd').id,
});

export function graphSnapshot(
  cursor = 'cursor-001',
  overrides: Partial<Omit<GraphSnapshot, 'integrityHash'>> = {},
): GraphSnapshot {
  const nodes = [
    graphNode('node-d', { type: 'outcome' }),
    graphNode('node-b', { type: 'reviewable_deliverable' }),
    graphNode('node-a'),
    graphNode('node-c', { type: 'verification_evidence', status: 'complete' }),
  ];
  return sealGraphSnapshot({
    schema: GRAPH_SNAPSHOT_SCHEMA,
    cursor,
    scenarioInstanceId: 'scenario-001',
    generatedAt: '2026-07-26T09:00:00.000Z',
    projectorVersion: 'projector-v1',
    nodes,
    edges: [
      graphEdge('produces', NODE_IDS.c, NODE_IDS.d, 'cd'),
      graphEdge('produces', NODE_IDS.a, NODE_IDS.b, 'ab'),
      graphEdge('verifies', NODE_IDS.b, NODE_IDS.c, 'bc'),
    ],
    completeness: {
      sourcesRequested: ['github', 'openslack'],
      sourcesObserved: ['github'],
      missingSources: ['openslack'],
      warnings: ['workflow evidence unavailable'],
    },
    ...overrides,
  });
}

export function graphDelta(
  fromCursor: string,
  toCursor: string,
  overrides: Partial<Omit<GraphDelta, 'integrityHash'>> = {},
): GraphDelta {
  return sealGraphDelta({
    schema: GRAPH_DELTA_SCHEMA,
    scenarioInstanceId: 'scenario-001',
    fromCursor,
    toCursor,
    generatedAt: '2026-07-26T10:00:00.000Z',
    upsertNodes: [graphNode('node-e')],
    closeNodeIds: [NODE_IDS.d],
    upsertEdges: [],
    closeEdgeIds: [EDGE_IDS.cd],
    evidenceRefs: ['evidence-delta'],
    ...overrides,
  });
}

export function graphTransitionSnapshot(cursor: string): GraphSnapshot {
  const base = graphSnapshot(cursor);
  return sealGraphSnapshot({
    ...base,
    generatedAt: '2026-07-26T10:00:00.000Z',
    nodes: [
      ...base.nodes.map((node) =>
        node.id === NODE_IDS.d ? { ...node, validTo: '2026-07-26T10:00:00.000Z' } : node,
      ),
      graphNode('node-e'),
    ],
    edges: base.edges.map((edge) =>
      edge.id === EDGE_IDS.cd ? { ...edge, validTo: '2026-07-26T10:00:00.000Z' } : edge,
    ),
  });
}
