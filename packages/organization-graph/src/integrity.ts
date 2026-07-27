import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalJson, canonicalizeGraphDelta, canonicalizeGraphSnapshot } from './canonical.js';
import { GraphContractError } from './errors.js';
import {
  GRAPH_DELTA_SCHEMA,
  GRAPH_SNAPSHOT_SCHEMA,
  type GraphDelta,
  type GraphSnapshot,
  type UnsealedGraphDelta,
  type UnsealedGraphSnapshot,
} from './types.js';

const EMPTY_HASH = `sha256:${'0'.repeat(64)}`;

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function snapshotDigestValue(
  snapshot: GraphSnapshot,
): Omit<GraphSnapshot, 'generatedAt' | 'integrityHash'> {
  return {
    schema: snapshot.schema,
    cursor: snapshot.cursor,
    scenarioInstanceId: snapshot.scenarioInstanceId,
    projectorVersion: snapshot.projectorVersion,
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    completeness: snapshot.completeness,
  };
}

function deltaDigestValue(delta: GraphDelta): Omit<GraphDelta, 'generatedAt' | 'integrityHash'> {
  return {
    schema: delta.schema,
    scenarioInstanceId: delta.scenarioInstanceId,
    fromCursor: delta.fromCursor,
    toCursor: delta.toCursor,
    upsertNodes: delta.upsertNodes,
    closeNodeIds: delta.closeNodeIds,
    upsertEdges: delta.upsertEdges,
    closeEdgeIds: delta.closeEdgeIds,
    evidenceRefs: delta.evidenceRefs,
  };
}

function equalHash(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function calculateGraphSnapshotIntegrity(value: unknown): string {
  return digest(snapshotDigestValue(canonicalizeGraphSnapshot(value)));
}

export function calculateGraphDeltaIntegrity(value: unknown): string {
  return digest(deltaDigestValue(canonicalizeGraphDelta(value)));
}

export function sealGraphSnapshot(value: UnsealedGraphSnapshot): GraphSnapshot {
  const candidate: GraphSnapshot = {
    ...value,
    schema: GRAPH_SNAPSHOT_SCHEMA,
    integrityHash: EMPTY_HASH,
  };
  const canonical = canonicalizeGraphSnapshot(candidate);
  return {
    ...canonical,
    integrityHash: digest(snapshotDigestValue(canonical)),
  };
}

export function sealGraphDelta(value: UnsealedGraphDelta): GraphDelta {
  const candidate: GraphDelta = {
    ...value,
    schema: GRAPH_DELTA_SCHEMA,
    integrityHash: EMPTY_HASH,
  };
  const canonical = canonicalizeGraphDelta(candidate);
  return {
    ...canonical,
    integrityHash: digest(deltaDigestValue(canonical)),
  };
}

export function verifyGraphSnapshotIntegrity(value: unknown): value is GraphSnapshot {
  const snapshot = canonicalizeGraphSnapshot(value);
  return equalHash(snapshot.integrityHash, digest(snapshotDigestValue(snapshot)));
}

export function verifyGraphDeltaIntegrity(value: unknown): value is GraphDelta {
  const delta = canonicalizeGraphDelta(value);
  return equalHash(delta.integrityHash, digest(deltaDigestValue(delta)));
}

export function assertGraphSnapshotIntegrity(value: unknown): GraphSnapshot {
  const snapshot = canonicalizeGraphSnapshot(value);
  const expected = digest(snapshotDigestValue(snapshot));
  if (!equalHash(snapshot.integrityHash, expected)) {
    throw new GraphContractError(
      'GRAPH_INTEGRITY_INVALID',
      '$.integrityHash',
      `does not match canonical content digest ${expected}.`,
    );
  }
  return snapshot;
}

export function assertGraphDeltaIntegrity(value: unknown): GraphDelta {
  const delta = canonicalizeGraphDelta(value);
  const expected = digest(deltaDigestValue(delta));
  if (!equalHash(delta.integrityHash, expected)) {
    throw new GraphContractError(
      'GRAPH_INTEGRITY_INVALID',
      '$.integrityHash',
      `does not match canonical content digest ${expected}.`,
    );
  }
  return delta;
}

export function serializeGraphSnapshot(value: unknown): Buffer {
  const snapshot = assertGraphSnapshotIntegrity(value);
  return Buffer.from(`${canonicalJson(snapshot)}\n`, 'utf8');
}

export function serializeGraphDelta(value: unknown): Buffer {
  const delta = assertGraphDeltaIntegrity(value);
  return Buffer.from(`${canonicalJson(delta)}\n`, 'utf8');
}
