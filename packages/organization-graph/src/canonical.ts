import type {
  ActorRef,
  AuthorityRef,
  GraphCompleteness,
  GraphDelta,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
} from './types.js';
import { validateGraphDelta, validateGraphSnapshot } from './validation.js';
import { canonicalJson } from './canonical-json.js';
export { canonicalJson } from './canonical-json.js';

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare);
}

function canonicalProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalProperties);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort(compare)
        .map((key) => [key, canonicalProperties((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function canonicalAuthority(value: AuthorityRef): AuthorityRef {
  return {
    provider: value.provider,
    objectType: value.objectType,
    objectId: value.objectId,
    version: value.version,
    observedAt: value.observedAt,
  };
}

function canonicalOwners(values: readonly ActorRef[]): ActorRef[] {
  const keyed = new Map<string, ActorRef>();
  for (const value of values) {
    const canonical: ActorRef = {
      id: value.id,
      kind: value.kind,
      ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
    };
    keyed.set(canonicalJson(canonical), canonical);
  }
  return [...keyed.values()].sort((left, right) =>
    compare(
      `${left.kind}\u0000${left.id}\u0000${left.displayName ?? ''}`,
      `${right.kind}\u0000${right.id}\u0000${right.displayName ?? ''}`,
    ),
  );
}

function canonicalNode(value: GraphNode): GraphNode {
  return {
    id: value.id,
    type: value.type,
    scenarioDefinitionId: value.scenarioDefinitionId,
    scenarioInstanceId: value.scenarioInstanceId,
    title: value.title,
    ...(value.status === undefined ? {} : { status: value.status }),
    authorityRef: canonicalAuthority(value.authorityRef),
    owners: canonicalOwners(value.owners),
    properties: canonicalProperties(value.properties) as Record<string, unknown>,
    sourceEventIds: sortedUnique(value.sourceEventIds),
    evidenceRefs: sortedUnique(value.evidenceRefs),
    projectorVersion: value.projectorVersion,
    validFrom: value.validFrom,
    ...(value.validTo === undefined ? {} : { validTo: value.validTo }),
  };
}

function canonicalEdge(value: GraphEdge): GraphEdge {
  return {
    id: value.id,
    type: value.type,
    from: value.from,
    to: value.to,
    scenarioInstanceId: value.scenarioInstanceId,
    ...(value.authorityRef === undefined
      ? {}
      : { authorityRef: canonicalAuthority(value.authorityRef) }),
    sourceEventIds: sortedUnique(value.sourceEventIds),
    evidenceRefs: sortedUnique(value.evidenceRefs),
    projectorVersion: value.projectorVersion,
    validFrom: value.validFrom,
    ...(value.validTo === undefined ? {} : { validTo: value.validTo }),
  };
}

function canonicalCompleteness(value: GraphCompleteness): GraphCompleteness {
  return {
    sourcesRequested: sortedUnique(value.sourcesRequested),
    sourcesObserved: sortedUnique(value.sourcesObserved),
    missingSources: sortedUnique(value.missingSources),
    warnings: sortedUnique(value.warnings),
  };
}

export function canonicalizeGraphSnapshot(value: unknown): GraphSnapshot {
  const snapshot = validateGraphSnapshot(value);
  return {
    schema: snapshot.schema,
    cursor: snapshot.cursor,
    scenarioInstanceId: snapshot.scenarioInstanceId,
    generatedAt: snapshot.generatedAt,
    projectorVersion: snapshot.projectorVersion,
    nodes: snapshot.nodes.map(canonicalNode).sort((left, right) => compare(left.id, right.id)),
    edges: snapshot.edges.map(canonicalEdge).sort((left, right) => compare(left.id, right.id)),
    completeness: canonicalCompleteness(snapshot.completeness),
    integrityHash: snapshot.integrityHash,
  };
}

export function canonicalizeGraphDelta(value: unknown): GraphDelta {
  const delta = validateGraphDelta(value);
  return {
    schema: delta.schema,
    scenarioInstanceId: delta.scenarioInstanceId,
    fromCursor: delta.fromCursor,
    toCursor: delta.toCursor,
    generatedAt: delta.generatedAt,
    upsertNodes: delta.upsertNodes
      .map(canonicalNode)
      .sort((left, right) => compare(left.id, right.id)),
    closeNodeIds: sortedUnique(delta.closeNodeIds),
    upsertEdges: delta.upsertEdges
      .map(canonicalEdge)
      .sort((left, right) => compare(left.id, right.id)),
    closeEdgeIds: sortedUnique(delta.closeEdgeIds),
    evidenceRefs: sortedUnique(delta.evidenceRefs),
    integrityHash: delta.integrityHash,
  };
}
