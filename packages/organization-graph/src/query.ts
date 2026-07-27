import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { GraphQueryError } from './errors.js';
import { assertGraphSnapshotIntegrity } from './integrity.js';
import { parseStrictGraphJson } from './strict-json.js';
import { GRAPH_HARD_LIMITS } from './types.js';
import type {
  GraphCompleteness,
  GraphDirection,
  GraphEdge,
  GraphExplainInput,
  GraphExplanation,
  GraphNode,
  GraphQueryInput,
  GraphQueryOptions,
  GraphQueryResult,
  GraphRelationshipPath,
  GraphSnapshot,
} from './types.js';

const DEFAULT_CURSOR_TTL_MS = 5 * 60 * 1_000;
const MAX_CURSOR_TTL_MS = 60 * 60 * 1_000;
const MIN_RESPONSE_BYTES = 1_024;

interface NormalizedQuery {
  scenarioInstanceId: string;
  rootNodeIds: string[];
  nodeTypes: string[];
  edgeTypes: string[];
  statuses: string[];
  direction: GraphDirection;
  depth: number;
  maxNodes: number;
  maxEdges: number;
  maxResponseBytes: number;
  includeEvidence: boolean;
}

interface CursorPayload {
  version: 1;
  queryHash: string;
  snapshotHash: string;
  offset: number;
  expiresAt: number;
}

interface Traversal {
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: Map<string, GraphRelationshipPath>;
}

interface AdjacencyStep {
  edge: GraphEdge;
  next: string;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): never {
  throw new GraphQueryError('GRAPH_QUERY_INVALID', message);
}

function assertClosedInput(value: unknown, name: string, allowedKeys: readonly string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`${name} must be an object.`);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!allowed.has(key)) invalid(`${name}.${key} is not an allowed property.`);
  }
}

function boundedString(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return invalid(`${name} must be a non-empty bounded identifier.`);
  }
  return value;
}

function stringSet(value: readonly string[] | undefined, name: string, max: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) {
    return invalid(`${name} must contain at most ${max} identifiers.`);
  }
  return [...new Set(value.map((item, index) => boundedString(item, `${name}[${index}]`)))].sort(
    compare,
  );
}

function integer(
  value: number | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return invalid(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function normalizeQuery(input: GraphQueryInput): NormalizedQuery {
  assertClosedInput(input, 'query', [
    'scenarioInstanceId',
    'rootNodeIds',
    'nodeTypes',
    'edgeTypes',
    'statuses',
    'direction',
    'depth',
    'maxNodes',
    'maxEdges',
    'maxResponseBytes',
    'includeEvidence',
    'cursor',
  ]);
  const direction = input.direction ?? 'outgoing';
  if (direction !== 'outgoing' && direction !== 'incoming' && direction !== 'both') {
    invalid('direction must be outgoing, incoming, or both.');
  }
  if (input.includeEvidence !== undefined && typeof input.includeEvidence !== 'boolean') {
    invalid('includeEvidence must be a boolean.');
  }
  if (input.cursor !== undefined) {
    boundedString(input.cursor, 'cursor');
  }
  return {
    scenarioInstanceId: boundedString(input.scenarioInstanceId, 'scenarioInstanceId'),
    rootNodeIds: stringSet(input.rootNodeIds, 'rootNodeIds', GRAPH_HARD_LIMITS.nodes),
    nodeTypes: stringSet(input.nodeTypes, 'nodeTypes', 50),
    edgeTypes: stringSet(input.edgeTypes, 'edgeTypes', 50),
    statuses: stringSet(input.statuses, 'statuses', 50),
    direction,
    depth: integer(input.depth, 'depth', 1, 0, GRAPH_HARD_LIMITS.depth),
    maxNodes: integer(
      input.maxNodes,
      'maxNodes',
      GRAPH_HARD_LIMITS.nodes,
      1,
      GRAPH_HARD_LIMITS.nodes,
    ),
    maxEdges: integer(
      input.maxEdges,
      'maxEdges',
      GRAPH_HARD_LIMITS.edges,
      1,
      GRAPH_HARD_LIMITS.edges,
    ),
    maxResponseBytes: integer(
      input.maxResponseBytes,
      'maxResponseBytes',
      GRAPH_HARD_LIMITS.responseBytes,
      MIN_RESPONSE_BYTES,
      GRAPH_HARD_LIMITS.responseBytes,
    ),
    includeEvidence: input.includeEvidence ?? false,
  };
}

function secretBytes(secret: string | Buffer): Buffer {
  if (typeof secret !== 'string' && !Buffer.isBuffer(secret)) {
    invalid('cursorSecret must be a string or Buffer.');
  }
  const bytes = Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret, 'utf8');
  if (bytes.length < 32) invalid('cursorSecret must contain at least 32 bytes.');
  if (bytes.length > 1_024) invalid('cursorSecret must contain at most 1024 bytes.');
  return bytes;
}

function nowMilliseconds(value: Date | number | undefined): number {
  const now = value instanceof Date ? value.getTime() : (value ?? Date.now());
  if (!Number.isSafeInteger(now) || now < 0) invalid('now must be a valid timestamp.');
  return now;
}

function queryHash(query: NormalizedQuery): string {
  return `sha256:${createHash('sha256').update(canonicalJson(query)).digest('hex')}`;
}

function encodeCursor(payload: CursorPayload, secret: Buffer): string {
  const encoded = Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
  return `${encoded}.${signature}`;
}

function decodeCursor(value: string, secret: Buffer): CursorPayload {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new GraphQueryError('GRAPH_QUERY_CURSOR_INVALID', 'Graph query cursor is malformed.');
  }
  const parts = value.split('.');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new GraphQueryError('GRAPH_QUERY_CURSOR_INVALID', 'Graph query cursor is malformed.');
  }
  const [encoded, suppliedSignature] = parts as [string, string];
  const expectedSignature = createHmac('sha256', secret)
    .update(encoded, 'utf8')
    .digest('base64url');
  const supplied = Buffer.from(suppliedSignature, 'utf8');
  const expected = Buffer.from(expectedSignature, 'utf8');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new GraphQueryError('GRAPH_QUERY_CURSOR_INVALID', 'Graph query cursor is not authentic.');
  }
  let valueFromCursor: unknown;
  try {
    valueFromCursor = parseStrictGraphJson(Buffer.from(encoded, 'base64url'), {
      maxDepth: 4,
      maxNodes: 16,
      maxStringLength: 256,
    });
  } catch {
    throw new GraphQueryError(
      'GRAPH_QUERY_CURSOR_INVALID',
      'Graph query cursor payload is invalid.',
    );
  }
  if (
    valueFromCursor === null ||
    typeof valueFromCursor !== 'object' ||
    Array.isArray(valueFromCursor)
  ) {
    throw new GraphQueryError(
      'GRAPH_QUERY_CURSOR_INVALID',
      'Graph query cursor payload is invalid.',
    );
  }
  const object = valueFromCursor as Record<string, unknown>;
  const keys = Object.keys(object).sort(compare);
  if (
    keys.join(',') !== 'expiresAt,offset,queryHash,snapshotHash,version' ||
    object.version !== 1 ||
    typeof object.queryHash !== 'string' ||
    typeof object.snapshotHash !== 'string' ||
    !Number.isSafeInteger(object.offset) ||
    (object.offset as number) < 0 ||
    !Number.isSafeInteger(object.expiresAt) ||
    (object.expiresAt as number) < 0
  ) {
    throw new GraphQueryError(
      'GRAPH_QUERY_CURSOR_INVALID',
      'Graph query cursor payload is invalid.',
    );
  }
  return {
    version: 1,
    queryHash: object.queryHash,
    snapshotHash: object.snapshotHash,
    offset: object.offset as number,
    expiresAt: object.expiresAt as number,
  };
}

function buildAdjacency(
  edges: readonly GraphEdge[],
  direction: GraphDirection,
): Map<string, AdjacencyStep[]> {
  const adjacency = new Map<string, AdjacencyStep[]>();
  const add = (nodeId: string, step: AdjacencyStep) => {
    const existing = adjacency.get(nodeId);
    if (existing) existing.push(step);
    else adjacency.set(nodeId, [step]);
  };
  for (const edge of edges) {
    if (direction === 'outgoing' || direction === 'both') {
      add(edge.from, { edge, next: edge.to });
    }
    if (direction === 'incoming' || (direction === 'both' && edge.to !== edge.from)) {
      add(edge.to, { edge, next: edge.from });
    }
  }
  for (const steps of adjacency.values()) {
    steps.sort((left, right) => {
      const edgeOrder = compare(left.edge.id, right.edge.id);
      return edgeOrder === 0 ? compare(left.next, right.next) : edgeOrder;
    });
  }
  return adjacency;
}

function countTraversalStep(current: number): number {
  const next = current + 1;
  if (next > GRAPH_HARD_LIMITS.traversalSteps) {
    throw new GraphQueryError(
      'GRAPH_QUERY_INVALID',
      `Graph traversal exceeds ${GRAPH_HARD_LIMITS.traversalSteps} bounded adjacency steps.`,
    );
  }
  return next;
}

function matchingEdge(edge: GraphEdge, query: NormalizedQuery): boolean {
  return query.edgeTypes.length === 0 || query.edgeTypes.includes(edge.type);
}

function matchingNode(node: GraphNode, query: NormalizedQuery): boolean {
  return (
    (query.nodeTypes.length === 0 || query.nodeTypes.includes(node.type)) &&
    (query.statuses.length === 0 ||
      (node.status !== undefined && query.statuses.includes(node.status)))
  );
}

function traverse(snapshot: GraphSnapshot, query: NormalizedQuery): Traversal {
  const nodeMap = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const allowedEdges = snapshot.edges.filter((edge) => matchingEdge(edge, query));
  const adjacency = buildAdjacency(allowedEdges, query.direction);
  const paths = new Map<string, GraphRelationshipPath>();
  const visited = new Set<string>();

  if (query.rootNodeIds.length === 0) {
    const nodes = snapshot.nodes.filter((node) => matchingNode(node, query));
    const ids = new Set(nodes.map((node) => node.id));
    for (const node of nodes) {
      paths.set(node.id, { nodeId: node.id, nodeIds: [node.id], edgeIds: [] });
    }
    return {
      nodes,
      edges: allowedEdges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
      paths,
    };
  }

  const queue: Array<{ id: string; depth: number }> = [];
  let traversalSteps = 0;
  for (const root of query.rootNodeIds) {
    if (!nodeMap.has(root)) {
      throw new GraphQueryError(
        'GRAPH_QUERY_TARGET_NOT_FOUND',
        `Graph query root ${root} does not exist.`,
      );
    }
    visited.add(root);
    paths.set(root, { nodeId: root, nodeIds: [root], edgeIds: [] });
    queue.push({ id: root, depth: 0 });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= query.depth) continue;
    for (const step of adjacency.get(current.id) ?? []) {
      traversalSteps = countTraversalStep(traversalSteps);
      const { edge, next } = step;
      if (visited.has(next) || !nodeMap.has(next)) continue;
      const parentPath = paths.get(current.id)!;
      visited.add(next);
      paths.set(next, {
        nodeId: next,
        nodeIds: [...parentPath.nodeIds, next],
        edgeIds: [...parentPath.edgeIds, edge.id],
      });
      queue.push({ id: next, depth: current.depth + 1 });
    }
  }

  const nodes = [...visited]
    .map((id) => nodeMap.get(id)!)
    .filter((node) => matchingNode(node, query))
    .sort((left, right) => compare(left.id, right.id));
  const returnedNodeIds = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: allowedEdges
      .filter((edge) => returnedNodeIds.has(edge.from) && returnedNodeIds.has(edge.to))
      .sort((left, right) => compare(left.id, right.id)),
    paths,
  };
}

function projectNode(node: GraphNode, includeEvidence: boolean): GraphNode {
  if (includeEvidence) return node;
  return { ...node, sourceEventIds: [], evidenceRefs: [] };
}

function projectEdge(edge: GraphEdge, includeEvidence: boolean): GraphEdge {
  if (includeEvidence) return edge;
  return { ...edge, sourceEventIds: [], evidenceRefs: [] };
}

function responseSize(result: GraphQueryResult): number {
  let previous = -1;
  let current = 0;
  // responseBytes contributes to the serialized envelope, so converge until recording the
  // measured value no longer changes the measurement itself.
  while (current !== previous) {
    previous = current;
    result.truncation.responseBytes = current;
    current = Buffer.byteLength(canonicalJson(result), 'utf8');
  }
  result.truncation.responseBytes = current;
  return Buffer.byteLength(canonicalJson(result), 'utf8');
}

function buildResult(
  snapshot: GraphSnapshot,
  hash: string,
  query: NormalizedQuery,
  traversal: Traversal,
  offset: number,
  secret: Buffer,
  expiresAt: number,
): GraphQueryResult {
  const items: Array<{ kind: 'node'; value: GraphNode } | { kind: 'edge'; value: GraphEdge }> = [
    ...traversal.nodes.map((value) => ({ kind: 'node' as const, value })),
    ...traversal.edges.map((value) => ({ kind: 'edge' as const, value })),
  ];
  if (offset > items.length) {
    throw new GraphQueryError(
      'GRAPH_QUERY_CURSOR_INVALID',
      'Graph query cursor is beyond the deterministic result set.',
    );
  }

  const selected: typeof items = [];
  let nodeCount = 0;
  let edgeCount = 0;
  let byteLimit = false;
  let index = offset;

  while (index < items.length) {
    const item = items[index]!;
    if (item.kind === 'node' && nodeCount >= query.maxNodes) {
      break;
    }
    if (item.kind === 'edge' && edgeCount >= query.maxEdges) {
      break;
    }
    selected.push(item);
    if (item.kind === 'node') nodeCount += 1;
    else edgeCount += 1;
    index += 1;
  }

  const makeResult = (): GraphQueryResult => {
    const nodes = selected
      .filter((item): item is { kind: 'node'; value: GraphNode } => item.kind === 'node')
      .map((item) => projectNode(item.value, query.includeEvidence));
    const edges = selected
      .filter((item): item is { kind: 'edge'; value: GraphEdge } => item.kind === 'edge')
      .map((item) => projectEdge(item.value, query.includeEvidence));
    const nextOffset = offset + selected.length;
    const nextItem = items[nextOffset];
    const paths = nodes
      .map((node) => traversal.paths.get(node.id))
      .filter((path): path is GraphRelationshipPath => path !== undefined);
    return {
      scenarioInstanceId: snapshot.scenarioInstanceId,
      snapshotCursor: snapshot.cursor,
      queryHash: hash,
      nodes,
      edges,
      paths,
      completeness: snapshot.completeness,
      truncation: {
        truncated: nextOffset < items.length,
        nodeLimit: nextItem?.kind === 'node' && nodeCount >= query.maxNodes,
        edgeLimit: nextItem?.kind === 'edge' && edgeCount >= query.maxEdges,
        byteLimit,
        paginated: offset > 0,
        responseBytes: 0,
      },
      ...(nextOffset >= items.length
        ? {}
        : {
            nextCursor: encodeCursor(
              {
                version: 1,
                queryHash: hash,
                snapshotHash: snapshot.integrityHash,
                offset: nextOffset,
                expiresAt,
              },
              secret,
            ),
          }),
    };
  };

  let result = makeResult();
  while (responseSize(result) > query.maxResponseBytes && selected.length > 0) {
    const removed = selected.pop()!;
    if (removed.kind === 'node') nodeCount -= 1;
    else edgeCount -= 1;
    index -= 1;
    byteLimit = true;
    result = makeResult();
  }
  if (responseSize(result) > query.maxResponseBytes) {
    throw new GraphQueryError(
      'GRAPH_QUERY_INVALID',
      'maxResponseBytes is too small for the bounded query envelope.',
    );
  }
  if (selected.length === 0 && index < items.length) {
    throw new GraphQueryError(
      'GRAPH_QUERY_INVALID',
      byteLimit
        ? 'A graph query item exceeds maxResponseBytes, so pagination cannot make forward progress.'
        : 'Query limits cannot make forward progress.',
    );
  }
  return result;
}

export function queryGraph(
  snapshotValue: unknown,
  input: GraphQueryInput,
  options: GraphQueryOptions,
): GraphQueryResult {
  assertClosedInput(options, 'options', ['cursorSecret', 'cursorTtlMs', 'now']);
  const snapshot = assertGraphSnapshotIntegrity(snapshotValue);
  const query = normalizeQuery(input);
  if (snapshot.scenarioInstanceId !== query.scenarioInstanceId) {
    throw new GraphQueryError(
      'GRAPH_QUERY_INVALID',
      'Query scenario does not match the graph snapshot scope.',
    );
  }
  const secret = secretBytes(options.cursorSecret);
  const now = nowMilliseconds(options.now);
  const ttl = integer(
    options.cursorTtlMs,
    'cursorTtlMs',
    DEFAULT_CURSOR_TTL_MS,
    1,
    MAX_CURSOR_TTL_MS,
  );
  const hash = queryHash(query);
  let offset = 0;
  let expiresAt = now + ttl;
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor, secret);
    if (cursor.expiresAt <= now) {
      throw new GraphQueryError('GRAPH_QUERY_CURSOR_EXPIRED', 'Graph query cursor has expired.');
    }
    if (cursor.queryHash !== hash || cursor.snapshotHash !== snapshot.integrityHash) {
      throw new GraphQueryError(
        'GRAPH_QUERY_CURSOR_MISMATCH',
        'Graph query cursor is bound to a different query or snapshot.',
      );
    }
    offset = cursor.offset;
    expiresAt = cursor.expiresAt;
  }
  return buildResult(snapshot, hash, query, traverse(snapshot, query), offset, secret, expiresAt);
}

function findPath(
  snapshot: GraphSnapshot,
  rootNodeId: string,
  targetId: string,
  targetKind: 'node' | 'edge',
  direction: GraphDirection,
  depth: number,
): GraphRelationshipPath | undefined {
  const nodes = new Set(snapshot.nodes.map((node) => node.id));
  if (!nodes.has(rootNodeId)) return undefined;
  const queue: GraphRelationshipPath[] = [
    { nodeId: rootNodeId, nodeIds: [rootNodeId], edgeIds: [] },
  ];
  const visited = new Set([rootNodeId]);
  const adjacency = buildAdjacency(snapshot.edges, direction);
  let traversalSteps = 0;
  while (queue.length > 0) {
    const path = queue.shift()!;
    const current = path.nodeIds[path.nodeIds.length - 1]!;
    if (targetKind === 'node' && current === targetId) return { ...path, nodeId: targetId };
    if (path.edgeIds.length >= depth) continue;
    for (const step of adjacency.get(current) ?? []) {
      traversalSteps = countTraversalStep(traversalSteps);
      const { edge, next } = step;
      if (!nodes.has(next)) continue;
      const nextPath: GraphRelationshipPath = {
        nodeId: next,
        nodeIds: [...path.nodeIds, next],
        edgeIds: [...path.edgeIds, edge.id],
      };
      if (targetKind === 'edge' && edge.id === targetId) return nextPath;
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(nextPath);
      }
    }
  }
  return undefined;
}

export function explainGraph(snapshotValue: unknown, input: GraphExplainInput): GraphExplanation {
  const snapshot = assertGraphSnapshotIntegrity(snapshotValue);
  assertClosedInput(input, 'explain', [
    'scenarioInstanceId',
    'targetId',
    'rootNodeId',
    'direction',
    'depth',
  ]);
  const scenarioInstanceId = boundedString(input.scenarioInstanceId, 'scenarioInstanceId');
  if (snapshot.scenarioInstanceId !== scenarioInstanceId) {
    invalid('Explanation scenario does not match the graph snapshot scope.');
  }
  const targetId = boundedString(input.targetId, 'targetId');
  const node = snapshot.nodes.find((item) => item.id === targetId);
  const edge = snapshot.edges.find((item) => item.id === targetId);
  if (!node && !edge) {
    throw new GraphQueryError(
      'GRAPH_QUERY_TARGET_NOT_FOUND',
      `Graph explanation target ${targetId} does not exist.`,
    );
  }
  const direction = input.direction ?? 'outgoing';
  if (direction !== 'outgoing' && direction !== 'incoming' && direction !== 'both') {
    invalid('direction must be outgoing, incoming, or both.');
  }
  const depth = integer(input.depth, 'depth', GRAPH_HARD_LIMITS.depth, 0, GRAPH_HARD_LIMITS.depth);
  const root = input.rootNodeId
    ? boundedString(input.rootNodeId, 'rootNodeId')
    : node
      ? node.id
      : edge!.from;
  const targetKind = node ? 'node' : 'edge';
  const path = findPath(snapshot, root, targetId, targetKind, direction, depth);
  if (!path) {
    throw new GraphQueryError(
      'GRAPH_QUERY_PATH_NOT_FOUND',
      `No relationship path reaches ${targetId} within depth ${depth}.`,
    );
  }
  const target = node ?? edge!;
  const result: GraphExplanation = {
    scenarioInstanceId,
    targetKind,
    targetId,
    ...(target.authorityRef === undefined ? {} : { authorityRef: target.authorityRef }),
    sourceEventIds: target.sourceEventIds,
    evidenceRefs: target.evidenceRefs,
    projectorVersion: target.projectorVersion,
    validFrom: target.validFrom,
    ...(target.validTo === undefined ? {} : { validTo: target.validTo }),
    completeness: snapshot.completeness,
    path,
    truncation: {
      sourceEventIds: false,
      evidenceRefs: false,
      path: false,
    },
  };
  if (Buffer.byteLength(canonicalJson(result), 'utf8') > GRAPH_HARD_LIMITS.responseBytes) {
    throw new GraphQueryError(
      'GRAPH_QUERY_INVALID',
      `Graph explanation exceeds ${GRAPH_HARD_LIMITS.responseBytes} bytes.`,
    );
  }
  return result;
}

export function graphQueryHash(input: GraphQueryInput): string {
  return queryHash(normalizeQuery(input));
}

export function canonicalGraphCompleteness(value: GraphCompleteness): GraphCompleteness {
  const sort = (items: readonly string[]) => [...new Set(items)].sort(compare);
  return {
    sourcesRequested: sort(value.sourcesRequested),
    sourcesObserved: sort(value.sourcesObserved),
    missingSources: sort(value.missingSources),
    warnings: sort(value.warnings),
  };
}
