export const GRAPH_SNAPSHOT_SCHEMA = 'openslack.graph_snapshot.v1' as const;
export const GRAPH_DELTA_SCHEMA = 'openslack.graph_delta.v1' as const;

export const GRAPH_AUTHORITY_PROVIDERS = Object.freeze([
  'github',
  'openslack',
  'demo_fixture',
  'dingtalk',
  'crm',
  'erp',
  'hr',
] as const);

export type GraphAuthorityProvider = (typeof GRAPH_AUTHORITY_PROVIDERS)[number];
export type GraphActorKind = 'human' | 'agent' | 'system';

export interface AuthorityRef {
  provider: GraphAuthorityProvider;
  objectType: string;
  objectId: string;
  version: string;
  observedAt: string;
}

export interface ActorRef {
  id: string;
  kind: GraphActorKind;
  displayName?: string;
}

export interface GraphNode {
  id: string;
  type: string;
  scenarioDefinitionId: string;
  scenarioInstanceId: string;
  title: string;
  status?: string;
  authorityRef: AuthorityRef;
  owners: ActorRef[];
  properties: Record<string, unknown>;
  sourceEventIds: string[];
  evidenceRefs: string[];
  projectorVersion: string;
  validFrom: string;
  validTo?: string;
}

export interface GraphEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  scenarioInstanceId: string;
  authorityRef?: AuthorityRef;
  sourceEventIds: string[];
  evidenceRefs: string[];
  projectorVersion: string;
  validFrom: string;
  validTo?: string;
}

export interface GraphCompleteness {
  sourcesRequested: string[];
  sourcesObserved: string[];
  missingSources: string[];
  warnings: string[];
}

export interface GraphSnapshot {
  schema: typeof GRAPH_SNAPSHOT_SCHEMA;
  cursor: string;
  scenarioInstanceId: string;
  generatedAt: string;
  projectorVersion: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  completeness: GraphCompleteness;
  integrityHash: string;
}

export interface GraphDelta {
  schema: typeof GRAPH_DELTA_SCHEMA;
  scenarioInstanceId: string;
  fromCursor: string;
  toCursor: string;
  generatedAt: string;
  upsertNodes: GraphNode[];
  closeNodeIds: string[];
  upsertEdges: GraphEdge[];
  closeEdgeIds: string[];
  evidenceRefs: string[];
  integrityHash: string;
}

export type UnsealedGraphSnapshot = Omit<GraphSnapshot, 'integrityHash'> & {
  integrityHash?: string;
};

export type UnsealedGraphDelta = Omit<GraphDelta, 'integrityHash'> & {
  integrityHash?: string;
};

export const GRAPH_HARD_LIMITS = Object.freeze({
  depth: 3,
  nodes: 200,
  edges: 500,
  responseBytes: 512 * 1024,
  propertyDepth: 8,
  propertyKeys: 64,
  propertyItems: 200,
  evidenceRefs: 50,
  owners: 50,
  sourceEventIds: 50,
  snapshotNodes: 10_000,
  snapshotEdges: 25_000,
  deltaEvidenceRefs: 200,
  traversalSteps: 100_000,
} as const);

export type GraphDirection = 'outgoing' | 'incoming' | 'both';

export interface GraphQueryInput {
  scenarioInstanceId: string;
  rootNodeIds?: string[];
  nodeTypes?: string[];
  edgeTypes?: string[];
  statuses?: string[];
  direction?: GraphDirection;
  depth?: number;
  maxNodes?: number;
  maxEdges?: number;
  maxResponseBytes?: number;
  includeEvidence?: boolean;
  cursor?: string;
}

export interface GraphRelationshipPath {
  nodeId: string;
  nodeIds: string[];
  edgeIds: string[];
}

export interface GraphQueryTruncation {
  truncated: boolean;
  nodeLimit: boolean;
  edgeLimit: boolean;
  byteLimit: boolean;
  paginated: boolean;
  responseBytes: number;
}

export interface GraphQueryResult {
  scenarioInstanceId: string;
  snapshotCursor: string;
  queryHash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: GraphRelationshipPath[];
  completeness: GraphCompleteness;
  truncation: GraphQueryTruncation;
  nextCursor?: string;
}

export interface GraphQueryOptions {
  cursorSecret: string | Buffer;
  cursorTtlMs?: number;
  now?: Date | number;
}

export interface GraphExplainInput {
  scenarioInstanceId: string;
  targetId: string;
  rootNodeId?: string;
  direction?: GraphDirection;
  depth?: number;
}

export interface GraphExplanation {
  scenarioInstanceId: string;
  targetKind: 'node' | 'edge';
  targetId: string;
  authorityRef?: AuthorityRef;
  sourceEventIds: string[];
  evidenceRefs: string[];
  projectorVersion: string;
  validFrom: string;
  validTo?: string;
  completeness: GraphCompleteness;
  path: GraphRelationshipPath;
  truncation: {
    sourceEventIds: boolean;
    evidenceRefs: boolean;
    path: boolean;
  };
}
