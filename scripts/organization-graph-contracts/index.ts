import { createHash, createHmac } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  CANONICAL_JSON_ERROR_CODES,
  CanonicalJsonError,
  canonicalJson,
} from '../../packages/organization-graph/src/canonical-json.js';
import {
  GRAPH_CONTRACT_ERROR_CODES,
  GRAPH_QUERY_ERROR_CODES,
  GraphContractError,
  GraphQueryError,
} from '../../packages/organization-graph/src/errors.js';
import {
  deriveGraphEdgeId,
  deriveGraphNodeId,
} from '../../packages/organization-graph/src/identity.js';
import {
  assertGraphSnapshotIntegrity,
  sealGraphDelta,
  sealGraphSnapshot,
  serializeGraphDelta,
  serializeGraphSnapshot,
  verifyGraphDeltaIntegrity,
  verifyGraphSnapshotIntegrity,
} from '../../packages/organization-graph/src/integrity.js';
import {
  GRAPH_QUERY_PROTOCOL_LIMITS,
  explainGraph,
  graphQueryHash,
  queryGraph,
} from '../../packages/organization-graph/src/query.js';
import {
  STRICT_GRAPH_JSON_ERROR_CODES,
  STRICT_GRAPH_JSON_DEFAULT_LIMITS,
  StrictGraphJsonError,
  parseStrictGraphJson,
} from '../../packages/organization-graph/src/strict-json.js';
import {
  GRAPH_AUTHORITY_PROVIDERS,
  GRAPH_DELTA_SCHEMA,
  GRAPH_HARD_LIMITS,
  GRAPH_SNAPSHOT_SCHEMA,
  GRAPH_VALUE_LIMITS,
} from '../../packages/organization-graph/src/types.js';
import type {
  AuthorityRef,
  GraphDelta,
  GraphEdge,
  GraphNode,
  GraphQueryInput,
  GraphSnapshot,
} from '../../packages/organization-graph/src/types.js';
import { buildSoftwareDeliveryContractArtifacts } from './software-delivery.js';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const generatedOutputRoot =
  process.env.OPENSLACK_GRAPH_CONTRACTS_OUTPUT_ROOT === undefined
    ? repositoryRoot
    : resolve(process.env.OPENSLACK_GRAPH_CONTRACTS_OUTPUT_ROOT);
const contractSourceRoot = resolve(repositoryRoot, 'packages/organization-graph/contracts/v1');
const contractOutputRoot = resolve(generatedOutputRoot, 'packages/organization-graph/contracts/v1');
const sourceMirrorRoot = resolve(
  generatedOutputRoot,
  'packages/organization-graph/src/generated/contracts/v1',
);
const serviceMirrorRoot = resolve(
  generatedOutputRoot,
  'services/organization-graph/internal/contractmirror/generated/v1',
);
const softwareDeliveryContractOutputRoot = resolve(
  generatedOutputRoot,
  'packages/organization-graph/contracts/software-delivery/v1',
);
const softwareDeliverySourceMirrorRoot = resolve(
  generatedOutputRoot,
  'packages/organization-graph/src/generated/contracts/software-delivery/v1',
);
const softwareDeliveryServiceMirrorRoot = resolve(
  generatedOutputRoot,
  'services/organization-graph/internal/contractmirror/generated/software-delivery/v1',
);

const snapshotSchemaPath = resolve(contractSourceRoot, 'schemas/graph-snapshot.v1.schema.json');
const deltaSchemaPath = resolve(contractSourceRoot, 'schemas/graph-delta.v1.schema.json');
const cursorSecret = 'organization-graph-golden-cursor-secret-v1';
const observedAt = '2026-07-26T08:00:00.000Z';
const emptyHash = `sha256:${'0'.repeat(64)}`;

type JsonRecord = Record<string, unknown>;

interface GoldenVector {
  readonly id: string;
  readonly family: string;
  readonly operation: string;
  readonly input: JsonRecord;
  readonly expected?: unknown;
  readonly expectedError?: JsonRecord;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function prettyJson(value: unknown): Promise<Buffer> {
  return Buffer.from(
    await format(JSON.stringify(value), {
      parser: 'json',
      printWidth: 100,
      tabWidth: 2,
    }),
    'utf8',
  );
}

function bytesContract(bytes: Buffer): JsonRecord {
  return {
    utf8Base64: bytes.toString('base64'),
    byteLength: bytes.length,
    sha256: sha256(bytes),
  };
}

const base64urlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function signedCursorFromPayload(encodedPayload: string): string {
  const signature = createHmac('sha256', cursorSecret)
    .update(encodedPayload, 'utf8')
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

function nonCanonicalBase64urlTail(encodedPayload: string): string {
  const decoded = Buffer.from(encodedPayload, 'base64url');
  const remainder = decoded.length % 3;
  if (remainder === 0) {
    throw new Error('Golden cursor payload must have unused base64url tail bits.');
  }
  const tailIndex = base64urlAlphabet.indexOf(encodedPayload.at(-1) ?? '');
  if (tailIndex < 0) {
    throw new Error('Golden cursor payload has an invalid base64url tail.');
  }
  const unusedBits = remainder === 1 ? 4 : 2;
  const variantIndex = (tailIndex & ~((1 << unusedBits) - 1)) | 1;
  return `${encodedPayload.slice(0, -1)}${base64urlAlphabet[variantIndex]}`;
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), 'utf8');
}

function errorContract(run: () => unknown): JsonRecord {
  try {
    run();
  } catch (error) {
    if (
      error instanceof CanonicalJsonError ||
      error instanceof GraphContractError ||
      error instanceof GraphQueryError ||
      error instanceof StrictGraphJsonError
    ) {
      return {
        name: error.name,
        code: error.code,
        message: error.message,
        ...('path' in error ? { path: error.path } : {}),
        ...('offset' in error ? { offset: error.offset } : {}),
      };
    }
    throw error;
  }
  throw new Error('Golden error vector unexpectedly succeeded.');
}

function graphNode(authorityObjectId: string, overrides: Partial<GraphNode> = {}): GraphNode {
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

function graphEdge(type: string, from: string, to: string, suffix: string): GraphEdge {
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
    sourceEventIds: [`event-${suffix}`],
    evidenceRefs: [`evidence-${suffix}`],
    projectorVersion: 'projector-v1',
    validFrom: observedAt,
  };
}

function graphFixtures(): {
  snapshot: GraphSnapshot;
  delta: GraphDelta;
  nodes: Record<'a' | 'b' | 'c' | 'd' | 'e', GraphNode>;
  edges: Record<'ab' | 'bc' | 'cd', GraphEdge>;
} {
  const nodes = {
    a: graphNode('node-a'),
    b: graphNode('node-b', { type: 'reviewable_deliverable' }),
    c: graphNode('node-c', { type: 'verification_evidence', status: 'complete' }),
    d: graphNode('node-d', { type: 'outcome' }),
    e: graphNode('node-e'),
  };
  const edges = {
    ab: graphEdge('produces', nodes.a.id, nodes.b.id, 'ab'),
    bc: graphEdge('verifies', nodes.b.id, nodes.c.id, 'bc'),
    cd: graphEdge('produces', nodes.c.id, nodes.d.id, 'cd'),
  };
  const snapshot = sealGraphSnapshot({
    schema: GRAPH_SNAPSHOT_SCHEMA,
    cursor: 'cursor-001',
    scenarioInstanceId: 'scenario-001',
    generatedAt: '2026-07-26T09:00:00.000Z',
    projectorVersion: 'projector-v1',
    nodes: [nodes.d, nodes.b, nodes.a, nodes.c],
    edges: [edges.cd, edges.ab, edges.bc],
    completeness: {
      sourcesRequested: ['openslack', 'github', 'github'],
      sourcesObserved: ['github'],
      missingSources: ['openslack'],
      warnings: ['workflow evidence unavailable'],
    },
  });
  const delta = sealGraphDelta({
    schema: GRAPH_DELTA_SCHEMA,
    scenarioInstanceId: 'scenario-001',
    fromCursor: 'cursor-001',
    toCursor: 'cursor-002',
    generatedAt: '2026-07-26T10:00:00.000Z',
    upsertNodes: [nodes.e],
    closeNodeIds: [nodes.d.id],
    upsertEdges: [],
    closeEdgeIds: [edges.cd.id],
    evidenceRefs: ['evidence-delta'],
  });
  return { snapshot, delta, nodes, edges };
}

function canonicalVector(id: string, source: string): GoldenVector {
  const inputBytes = Buffer.from(source, 'utf8');
  const parsed = parseStrictGraphJson(inputBytes);
  return {
    id,
    family: 'canonical_json',
    operation: 'parse_then_canonicalize',
    input: { ...bytesContract(inputBytes) },
    expected: bytesContract(canonicalBytes(parsed)),
  };
}

function javascriptAdversarialVector(id: string, kind: string): GoldenVector {
  return {
    id,
    family: 'canonical_json_error',
    operation: 'canonicalize_tagged_javascript_value',
    input: { valueSpec: { kind } },
    expectedError: errorContract(() => canonicalJson(taggedJavascriptValue(kind))),
  };
}

function javascriptCanonicalVector(id: string, kind: string): GoldenVector {
  return {
    id,
    family: 'canonical_json',
    operation: 'canonicalize_tagged_javascript_value',
    input: { valueSpec: { kind } },
    expected: bytesContract(canonicalBytes(taggedJavascriptValue(kind))),
  };
}

function taggedJavascriptValue(kind: string): unknown {
  switch (kind) {
    case 'undefined_object_member':
      return { value: undefined };
    case 'nan':
      return Number.NaN;
    case 'positive_infinity':
      return Number.POSITIVE_INFINITY;
    case 'negative_infinity':
      return Number.NEGATIVE_INFINITY;
    case 'sparse_array': {
      const sparse = new Array(2);
      sparse[1] = 'present';
      return sparse;
    }
    case 'bigint':
      return 1n;
    case 'symbol':
      return Symbol('blocked');
    case 'function':
      return () => undefined;
    case 'mixed_nonfinite_then_forbidden':
      return { a: Number.NaN, constructor: 1 };
    case 'long_string_above_strict_limit':
      return 'x'.repeat(STRICT_GRAPH_JSON_DEFAULT_LIMITS.maxStringLength + 1);
    case 'depth_above_strict_limit': {
      let value: unknown = 0;
      for (let depth = 0; depth < STRICT_GRAPH_JSON_DEFAULT_LIMITS.maxDepth + 1; depth += 1) {
        value = [value];
      }
      return value;
    }
    case 'unpaired_high_surrogate_string':
      return String.fromCharCode(0xd800);
    case 'unpaired_low_surrogate_key':
      return { [String.fromCharCode(0xdc00)]: true };
    default:
      throw new Error(`Unknown tagged JavaScript golden value ${kind}.`);
  }
}

function taggedQueryInput(kind: string): GraphQueryInput {
  switch (kind) {
    case 'unpaired_high_surrogate_scenario_instance_id':
      return { scenarioInstanceId: String.fromCharCode(0xd800) };
    case 'unpaired_low_surrogate_scenario_instance_id':
      return { scenarioInstanceId: String.fromCharCode(0xdc00) };
    default:
      throw new Error(`Unknown tagged query input ${kind}.`);
  }
}

function buildVectors(): readonly GoldenVector[] {
  const { snapshot, delta, nodes, edges } = graphFixtures();
  const authority = nodes.a.authorityRef;
  const reobservedAuthority: AuthorityRef = {
    ...authority,
    version: 'new-version',
    observedAt: '2026-07-27T08:00:00.000Z',
  };
  const edgeWithAuthority = deriveGraphEdgeId({
    scenarioInstanceId: 'scenario-001',
    type: 'produces',
    from: nodes.a.id,
    to: nodes.b.id,
    authorityRef: authority,
  });
  const queryInput: GraphQueryInput = {
    scenarioInstanceId: 'scenario-001',
    rootNodeIds: [nodes.a.id],
    depth: 3,
    maxNodes: 2,
    includeEvidence: true,
  };
  const queryOptions = { cursorSecret, cursorTtlMs: 5_000, now: 1_000 };
  const firstPage = queryGraph(snapshot, queryInput, queryOptions);
  if (firstPage.nextCursor === undefined) {
    throw new Error('Golden query fixture must paginate.');
  }
  const secondPageInput = { ...queryInput, cursor: firstPage.nextCursor };
  const [firstPagePayload] = firstPage.nextCursor.split('.');
  if (firstPagePayload === undefined) {
    throw new Error('Golden query fixture cursor must contain a payload.');
  }
  const nonCanonicalPayload = `${firstPagePayload}A`;
  const nonCanonicalCursor = signedCursorFromPayload(nonCanonicalPayload);
  const tailBitsPage = queryGraph(snapshot, queryInput, {
    cursorSecret,
    cursorTtlMs: 5_000,
    now: 5_000,
  });
  if (tailBitsPage.nextCursor === undefined) {
    throw new Error('Golden tail-bits query fixture must paginate.');
  }
  const [tailBitsPayload] = tailBitsPage.nextCursor.split('.');
  if (tailBitsPayload === undefined) {
    throw new Error('Golden tail-bits cursor must contain a payload.');
  }
  const nonZeroTailBitsCursor = signedCursorFromPayload(nonCanonicalBase64urlTail(tailBitsPayload));
  const nonCanonicalJsonPayload = Buffer.from(
    `${JSON.stringify(JSON.parse(Buffer.from(firstPagePayload, 'base64url').toString('utf8')), null, 1)}\n`,
    'utf8',
  ).toString('base64url');
  const nonCanonicalJsonCursor = signedCursorFromPayload(nonCanonicalJsonPayload);
  const hugeOffsetPayload = JSON.parse(
    Buffer.from(firstPagePayload, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  hugeOffsetPayload.offset = GRAPH_HARD_LIMITS.snapshotNodes + GRAPH_HARD_LIMITS.snapshotEdges + 1;
  const hugeOffsetCursor = signedCursorFromPayload(
    Buffer.from(canonicalJson(hugeOffsetPayload), 'utf8').toString('base64url'),
  );
  const secondPage = queryGraph(snapshot, secondPageInput, {
    ...queryOptions,
    now: 2_000,
  });
  const nodeExplanation = explainGraph(snapshot, {
    scenarioInstanceId: 'scenario-001',
    rootNodeId: nodes.a.id,
    targetId: nodes.c.id,
    depth: 2,
  });
  const edgeExplanation = explainGraph(snapshot, {
    scenarioInstanceId: 'scenario-001',
    rootNodeId: nodes.a.id,
    targetId: edges.bc.id,
    depth: 2,
  });
  const byteLimitedSnapshot = sealGraphSnapshot({
    ...snapshot,
    nodes: snapshot.nodes.map((node, index) => ({
      ...node,
      properties: { text: index === 0 ? 'small' : 'x'.repeat(2_000) },
    })),
  });
  const byteLimitedQuery = {
    scenarioInstanceId: 'scenario-001',
    maxNodes: GRAPH_HARD_LIMITS.nodes,
    maxEdges: GRAPH_HARD_LIMITS.edges,
    maxResponseBytes: 2_000,
  } satisfies GraphQueryInput;
  const byteLimitedResult = queryGraph(byteLimitedSnapshot, byteLimitedQuery, {
    cursorSecret,
    cursorTtlMs: 5_000,
    now: 1_000,
  });
  const subMillisecondValiditySnapshot = sealGraphSnapshot({
    ...snapshot,
    nodes: [
      {
        ...snapshot.nodes[0]!,
        validFrom: '2026-07-26T08:00:00.0009Z',
        validTo: '2026-07-26T08:00:00.0001Z',
      },
      ...snapshot.nodes.slice(1),
    ],
  });
  const snapshotBytes = serializeGraphSnapshot(snapshot);
  const deltaBytes = serializeGraphDelta(delta);
  const vectors: GoldenVector[] = [
    canonicalVector(
      'canonical-object-order-and-negative-zero',
      '{"z":0,"a":[true,null,"界"],"m":{"b":2,"a":-0}}',
    ),
    canonicalVector(
      'canonical-ecmascript-number-boundaries',
      '[-0,1e-7,1e-6,100000000000000000000,1e21,9007199254740993]',
    ),
    canonicalVector('canonical-utf16-key-order', '{"":"bmp","😀":"astral"}'),
    canonicalVector('canonical-cjk-key-order', '{"中":"middle","国":"country","a":"latin"}'),
    canonicalVector(
      'canonical-non-emoji-astral-key-order',
      '{"😀":"emoji","𐀀":"linear-b","a":"latin"}',
    ),
    canonicalVector('canonical-string-escaping', '{"value":"<>&/  😀\\\\\\"\\b\\f\\n\\r\\t"}'),
    canonicalVector('canonical-control-character-escaping', '{"value":"\\u0000\\u001f"}'),
    javascriptCanonicalVector(
      'canonical-string-above-strict-json-limit',
      'long_string_above_strict_limit',
    ),
    javascriptCanonicalVector(
      'canonical-depth-above-strict-json-limit',
      'depth_above_strict_limit',
    ),
    ...['__proto__', 'prototype', 'constructor'].map((key): GoldenVector => {
      const bytes = Buffer.from(`{"${key}":"blocked"}`, 'utf8');
      return {
        id: `canonical-forbidden-key-${key}`,
        family: 'canonical_json_error',
        operation: 'parse_then_canonicalize',
        input: bytesContract(bytes),
        expectedError: errorContract(() => canonicalJson(parseStrictGraphJson(bytes))),
      };
    }),
    javascriptAdversarialVector('canonical-undefined-object-member', 'undefined_object_member'),
    javascriptAdversarialVector('canonical-nan', 'nan'),
    javascriptAdversarialVector('canonical-positive-infinity', 'positive_infinity'),
    javascriptAdversarialVector('canonical-negative-infinity', 'negative_infinity'),
    javascriptAdversarialVector('canonical-sparse-array', 'sparse_array'),
    javascriptAdversarialVector('canonical-bigint', 'bigint'),
    javascriptAdversarialVector('canonical-symbol', 'symbol'),
    javascriptAdversarialVector('canonical-function', 'function'),
    javascriptAdversarialVector(
      'canonical-mixed-error-precedence',
      'mixed_nonfinite_then_forbidden',
    ),
    javascriptAdversarialVector(
      'canonical-unpaired-high-surrogate-string',
      'unpaired_high_surrogate_string',
    ),
    javascriptAdversarialVector(
      'canonical-unpaired-low-surrogate-key',
      'unpaired_low_surrogate_key',
    ),
    {
      id: 'node-identity-authority-object-only',
      family: 'identity',
      operation: 'derive_graph_node_id',
      input: {
        scenarioInstanceId: 'scenario-001',
        type: nodes.a.type,
        authorityRef: authority,
        reobservedAuthorityRef: reobservedAuthority,
      },
      expected: {
        value: nodes.a.id,
        reobservedValue: deriveGraphNodeId({
          scenarioInstanceId: 'scenario-001',
          type: nodes.a.type,
          authorityRef: reobservedAuthority,
        }),
      },
    },
    {
      id: 'edge-identity-without-authority',
      family: 'identity',
      operation: 'derive_graph_edge_id',
      input: {
        scenarioInstanceId: 'scenario-001',
        type: edges.ab.type,
        from: nodes.a.id,
        to: nodes.b.id,
      },
      expected: { value: edges.ab.id },
    },
    {
      id: 'edge-identity-with-authority',
      family: 'identity',
      operation: 'derive_graph_edge_id',
      input: {
        scenarioInstanceId: 'scenario-001',
        type: edges.ab.type,
        from: nodes.a.id,
        to: nodes.b.id,
        authorityRef: authority,
      },
      expected: { value: edgeWithAuthority },
    },
    {
      id: 'snapshot-canonical-integrity-and-serialization',
      family: 'snapshot_integrity',
      operation: 'seal_graph_snapshot',
      input: { value: { ...snapshot, integrityHash: emptyHash } },
      expected: {
        canonicalValue: snapshot,
        integrityHash: snapshot.integrityHash,
        serialized: bytesContract(snapshotBytes),
        trailingLf: snapshotBytes.at(-1) === 0x0a,
      },
    },
    {
      id: 'snapshot-generated-at-excluded-from-integrity',
      family: 'snapshot_integrity',
      operation: 'seal_graph_snapshot',
      input: {
        value: {
          ...snapshot,
          generatedAt: '2026-07-27T09:00:00.000Z',
          integrityHash: emptyHash,
        },
        baseline: { ...snapshot, integrityHash: emptyHash },
      },
      expected: {
        integrityHash: sealGraphSnapshot({
          ...snapshot,
          generatedAt: '2026-07-27T09:00:00.000Z',
        }).integrityHash,
        baselineIntegrityHash: snapshot.integrityHash,
      },
    },
    {
      id: 'snapshot-integrity-verify-success-and-failure',
      family: 'snapshot_integrity',
      operation: 'verify_graph_snapshot_integrity',
      input: {
        valid: snapshot,
        tampered: { ...snapshot, cursor: 'cursor-tampered' },
      },
      expected: {
        valid: verifyGraphSnapshotIntegrity(snapshot),
        tampered: verifyGraphSnapshotIntegrity({ ...snapshot, cursor: 'cursor-tampered' }),
      },
    },
    {
      id: 'snapshot-validity-submillisecond-date-parse-precision',
      family: 'snapshot_integrity',
      operation: 'seal_graph_snapshot',
      input: {
        value: {
          ...subMillisecondValiditySnapshot,
          integrityHash: emptyHash,
        },
      },
      expected: {
        accepted: true,
        canonicalValue: subMillisecondValiditySnapshot,
      },
    },
    {
      id: 'delta-canonical-integrity-and-serialization',
      family: 'delta_integrity',
      operation: 'seal_graph_delta',
      input: { value: { ...delta, integrityHash: emptyHash } },
      expected: {
        canonicalValue: delta,
        integrityHash: delta.integrityHash,
        serialized: bytesContract(deltaBytes),
        trailingLf: deltaBytes.at(-1) === 0x0a,
      },
    },
    {
      id: 'delta-generated-at-excluded-from-integrity',
      family: 'delta_integrity',
      operation: 'seal_graph_delta',
      input: {
        value: {
          ...delta,
          generatedAt: '2026-07-27T10:00:00.000Z',
          integrityHash: emptyHash,
        },
        baseline: { ...delta, integrityHash: emptyHash },
      },
      expected: {
        integrityHash: sealGraphDelta({
          ...delta,
          generatedAt: '2026-07-27T10:00:00.000Z',
        }).integrityHash,
        baselineIntegrityHash: delta.integrityHash,
      },
    },
    {
      id: 'delta-integrity-verify-success-and-failure',
      family: 'delta_integrity',
      operation: 'verify_graph_delta_integrity',
      input: {
        valid: delta,
        tampered: { ...delta, toCursor: 'cursor-tampered' },
      },
      expected: {
        valid: verifyGraphDeltaIntegrity(delta),
        tampered: verifyGraphDeltaIntegrity({ ...delta, toCursor: 'cursor-tampered' }),
      },
    },
    {
      id: 'query-normalization-hash',
      family: 'query',
      operation: 'graph_query_hash',
      input: {
        value: {
          ...queryInput,
          rootNodeIds: [nodes.a.id, nodes.a.id],
          nodeTypes: ['core.work_item', 'core.work_item'],
        },
      },
      expected: {
        value: graphQueryHash({
          ...queryInput,
          rootNodeIds: [nodes.a.id],
          nodeTypes: ['core.work_item'],
        }),
      },
    },
    {
      id: 'query-first-page-and-cursor',
      family: 'query_cursor',
      operation: 'query_graph',
      input: { snapshot, query: queryInput, options: queryOptions },
      expected: firstPage,
    },
    {
      id: 'query-second-page-preserves-expiry',
      family: 'query_cursor',
      operation: 'query_graph',
      input: {
        snapshot,
        query: secondPageInput,
        options: { ...queryOptions, cursorTtlMs: 10_000, now: 2_000 },
      },
      expected: secondPage,
    },
    {
      id: 'query-byte-limit-truncation-and-response-size',
      family: 'query',
      operation: 'query_graph',
      input: {
        snapshot: byteLimitedSnapshot,
        query: byteLimitedQuery,
        options: { cursorSecret, cursorTtlMs: 5_000, now: 1_000 },
      },
      expected: byteLimitedResult,
    },
    {
      id: 'explain-node-path',
      family: 'explain',
      operation: 'explain_graph',
      input: {
        snapshot,
        explain: {
          scenarioInstanceId: 'scenario-001',
          rootNodeId: nodes.a.id,
          targetId: nodes.c.id,
          depth: 2,
        },
      },
      expected: nodeExplanation,
    },
    {
      id: 'explain-edge-path',
      family: 'explain',
      operation: 'explain_graph',
      input: {
        snapshot,
        explain: {
          scenarioInstanceId: 'scenario-001',
          rootNodeId: nodes.a.id,
          targetId: edges.bc.id,
          depth: 2,
        },
      },
      expected: edgeExplanation,
    },
    {
      id: 'contract-scenario-scope-error',
      family: 'contract_error',
      operation: 'seal_graph_snapshot',
      input: {
        value: {
          ...snapshot,
          integrityHash: emptyHash,
          nodes: [{ ...snapshot.nodes[0]!, scenarioInstanceId: 'other-scenario' }],
        },
      },
      expectedError: errorContract(() =>
        sealGraphSnapshot({
          ...snapshot,
          nodes: [{ ...snapshot.nodes[0]!, scenarioInstanceId: 'other-scenario' }],
        }),
      ),
    },
    {
      id: 'contract-snapshot-error-precedence',
      family: 'contract_error',
      operation: 'seal_graph_snapshot',
      input: {
        value: {
          ...snapshot,
          cursor: 1,
          integrityHash: emptyHash,
          nodes: [
            { ...snapshot.nodes[0]!, scenarioInstanceId: 'other-scenario' },
            ...snapshot.nodes.slice(1),
          ],
        },
      },
      expectedError: errorContract(() =>
        sealGraphSnapshot({
          ...snapshot,
          cursor: 1,
          nodes: [
            { ...snapshot.nodes[0]!, scenarioInstanceId: 'other-scenario' },
            ...snapshot.nodes.slice(1),
          ],
        } as never),
      ),
    },
    {
      id: 'contract-delta-error-precedence',
      family: 'contract_error',
      operation: 'seal_graph_delta',
      input: {
        value: {
          ...delta,
          generatedAt: 1,
          integrityHash: emptyHash,
          upsertNodes: [
            { ...delta.upsertNodes[0]!, scenarioInstanceId: 'other-scenario' },
            ...delta.upsertNodes.slice(1),
          ],
        },
      },
      expectedError: errorContract(() =>
        sealGraphDelta({
          ...delta,
          generatedAt: 1,
          upsertNodes: [
            { ...delta.upsertNodes[0]!, scenarioInstanceId: 'other-scenario' },
            ...delta.upsertNodes.slice(1),
          ],
        } as never),
      ),
    },
    {
      id: 'contract-schema-error',
      family: 'contract_error',
      operation: 'seal_graph_snapshot',
      input: { value: { ...snapshot, integrityHash: emptyHash, unexpected: true } },
      expectedError: errorContract(() =>
        sealGraphSnapshot({ ...snapshot, unexpected: true } as never),
      ),
    },
    {
      id: 'contract-bound-error',
      family: 'contract_error',
      operation: 'seal_graph_snapshot',
      input: {
        value: {
          ...snapshot,
          integrityHash: emptyHash,
          nodes: [
            {
              ...snapshot.nodes[0]!,
              title: 'x'.repeat(GRAPH_VALUE_LIMITS.boundedStringCharacters + 1),
            },
            ...snapshot.nodes.slice(1),
          ],
        },
      },
      expectedError: errorContract(() =>
        sealGraphSnapshot({
          ...snapshot,
          nodes: [
            {
              ...snapshot.nodes[0]!,
              title: 'x'.repeat(GRAPH_VALUE_LIMITS.boundedStringCharacters + 1),
            },
            ...snapshot.nodes.slice(1),
          ],
        }),
      ),
    },
    {
      id: 'contract-reference-error',
      family: 'contract_error',
      operation: 'seal_graph_snapshot',
      input: {
        value: {
          ...snapshot,
          integrityHash: emptyHash,
          nodes: [{ ...snapshot.nodes[0]!, id: 'caller-selected' }, ...snapshot.nodes.slice(1)],
        },
      },
      expectedError: errorContract(() =>
        sealGraphSnapshot({
          ...snapshot,
          nodes: [{ ...snapshot.nodes[0]!, id: 'caller-selected' }, ...snapshot.nodes.slice(1)],
        }),
      ),
    },
    {
      id: 'contract-property-error',
      family: 'contract_error',
      operation: 'seal_graph_snapshot',
      input: {
        value: {
          ...snapshot,
          integrityHash: emptyHash,
          nodes: [
            { ...snapshot.nodes[0]!, properties: { api_token: 'blocked' } },
            ...snapshot.nodes.slice(1),
          ],
        },
      },
      expectedError: errorContract(() =>
        sealGraphSnapshot({
          ...snapshot,
          nodes: [
            { ...snapshot.nodes[0]!, properties: { api_token: 'blocked' } },
            ...snapshot.nodes.slice(1),
          ],
        }),
      ),
    },
    ...[
      {
        id: 'contract-property-nbsp-script-error',
        value: '<\u00a0script>alert(1)',
      },
      {
        id: 'contract-property-nbsp-bearer-error',
        value: 'bearer\u00a0ABCDEFGHIJKL',
      },
    ].map(
      ({ id, value }): GoldenVector => ({
        id,
        family: 'contract_error',
        operation: 'seal_graph_snapshot',
        input: {
          value: {
            ...snapshot,
            integrityHash: emptyHash,
            nodes: [
              { ...snapshot.nodes[0]!, properties: { note: value } },
              ...snapshot.nodes.slice(1),
            ],
          },
        },
        expectedError: errorContract(() =>
          sealGraphSnapshot({
            ...snapshot,
            nodes: [
              { ...snapshot.nodes[0]!, properties: { note: value } },
              ...snapshot.nodes.slice(1),
            ],
          }),
        ),
      }),
    ),
    ...[
      {
        id: 'contract-datetime-offset-hour-error',
        generatedAt: '2026-07-26T09:00:00+24:00',
      },
      {
        id: 'contract-datetime-offset-minute-error',
        generatedAt: '2026-07-26T09:00:00+00:60',
      },
    ].map(
      ({ id, generatedAt }): GoldenVector => ({
        id,
        family: 'contract_error',
        operation: 'seal_graph_snapshot',
        input: {
          value: {
            ...snapshot,
            generatedAt,
            integrityHash: emptyHash,
          },
        },
        expectedError: errorContract(() =>
          sealGraphSnapshot({
            ...snapshot,
            generatedAt,
          }),
        ),
      }),
    ),
    {
      id: 'integrity-mismatch-error',
      family: 'contract_error',
      operation: 'assert_graph_snapshot_integrity',
      input: { value: { ...snapshot, integrityHash: emptyHash } },
      expectedError: errorContract(() =>
        assertGraphSnapshotIntegrity({
          ...snapshot,
          integrityHash: `sha256:${'0'.repeat(64)}`,
        }),
      ),
    },
    {
      id: 'query-depth-error',
      family: 'query_error',
      operation: 'query_graph',
      input: {
        snapshot,
        query: { scenarioInstanceId: 'scenario-001', depth: 4 },
        options: { cursorSecret, cursorTtlMs: 5_000, now: 1_000 },
      },
      expectedError: errorContract(() =>
        queryGraph(
          snapshot,
          { scenarioInstanceId: 'scenario-001', depth: 4 },
          { cursorSecret, cursorTtlMs: 5_000, now: 1_000 },
        ),
      ),
    },
    {
      id: 'query-expiry-overflow-error',
      family: 'query_error',
      operation: 'query_graph',
      input: {
        snapshot,
        query: queryInput,
        options: {
          cursorSecret,
          cursorTtlMs: 5_000,
          now: Number.MAX_SAFE_INTEGER,
        },
      },
      expectedError: errorContract(() =>
        queryGraph(snapshot, queryInput, {
          cursorSecret,
          cursorTtlMs: 5_000,
          now: Number.MAX_SAFE_INTEGER,
        }),
      ),
    },
    {
      id: 'query-unpaired-high-surrogate-error',
      family: 'query_error',
      operation: 'graph_query_hash_tagged_input',
      input: { valueSpec: { kind: 'unpaired_high_surrogate_scenario_instance_id' } },
      expectedError: errorContract(() =>
        graphQueryHash(taggedQueryInput('unpaired_high_surrogate_scenario_instance_id')),
      ),
    },
    {
      id: 'query-unpaired-low-surrogate-error',
      family: 'query_error',
      operation: 'graph_query_hash_tagged_input',
      input: { valueSpec: { kind: 'unpaired_low_surrogate_scenario_instance_id' } },
      expectedError: errorContract(() =>
        graphQueryHash(taggedQueryInput('unpaired_low_surrogate_scenario_instance_id')),
      ),
    },
    {
      id: 'cursor-expired-error',
      family: 'query_error',
      operation: 'query_graph',
      input: {
        snapshot,
        query: secondPageInput,
        options: { cursorSecret, cursorTtlMs: 5_000, now: 6_000 },
      },
      expectedError: errorContract(() =>
        queryGraph(snapshot, secondPageInput, {
          cursorSecret,
          cursorTtlMs: 5_000,
          now: 6_000,
        }),
      ),
    },
    {
      id: 'cursor-query-mismatch-error',
      family: 'query_error',
      operation: 'query_graph',
      input: {
        snapshot,
        query: { ...secondPageInput, depth: 2 },
        options: { cursorSecret, cursorTtlMs: 5_000, now: 2_000 },
      },
      expectedError: errorContract(() =>
        queryGraph(
          snapshot,
          { ...secondPageInput, depth: 2 },
          { cursorSecret, cursorTtlMs: 5_000, now: 2_000 },
        ),
      ),
    },
    {
      id: 'cursor-malformed-error',
      family: 'query_error',
      operation: 'query_graph',
      input: {
        snapshot,
        query: { ...queryInput, cursor: 'not-a-cursor' },
        options: { cursorSecret, cursorTtlMs: 5_000, now: 2_000 },
      },
      expectedError: errorContract(() =>
        queryGraph(
          snapshot,
          { ...queryInput, cursor: 'not-a-cursor' },
          { cursorSecret, cursorTtlMs: 5_000, now: 2_000 },
        ),
      ),
    },
    {
      id: 'cursor-tampered-error',
      family: 'query_error',
      operation: 'query_graph',
      input: {
        snapshot,
        query: {
          ...queryInput,
          cursor: `${firstPage.nextCursor.slice(0, -1)}${
            firstPage.nextCursor.endsWith('A') ? 'B' : 'A'
          }`,
        },
        options: { cursorSecret, cursorTtlMs: 5_000, now: 2_000 },
      },
      expectedError: errorContract(() =>
        queryGraph(
          snapshot,
          {
            ...queryInput,
            cursor: `${firstPage.nextCursor!.slice(0, -1)}${
              firstPage.nextCursor!.endsWith('A') ? 'B' : 'A'
            }`,
          },
          { cursorSecret, cursorTtlMs: 5_000, now: 2_000 },
        ),
      ),
    },
    {
      id: 'cursor-noncanonical-base64url-error',
      family: 'query_error',
      operation: 'query_graph',
      input: {
        snapshot,
        query: { ...queryInput, cursor: nonCanonicalCursor },
        options: { cursorSecret, cursorTtlMs: 5_000, now: 2_000 },
      },
      expectedError: errorContract(() =>
        queryGraph(
          snapshot,
          { ...queryInput, cursor: nonCanonicalCursor },
          { cursorSecret, cursorTtlMs: 5_000, now: 2_000 },
        ),
      ),
    },
    {
      id: 'cursor-nonzero-tail-bits-error',
      family: 'query_error',
      operation: 'query_graph',
      input: {
        snapshot,
        query: { ...queryInput, cursor: nonZeroTailBitsCursor },
        options: { cursorSecret, cursorTtlMs: 5_000, now: 6_000 },
      },
      expectedError: errorContract(() =>
        queryGraph(
          snapshot,
          { ...queryInput, cursor: nonZeroTailBitsCursor },
          { cursorSecret, cursorTtlMs: 5_000, now: 6_000 },
        ),
      ),
    },
    {
      id: 'cursor-noncanonical-json-error',
      family: 'query_error',
      operation: 'query_graph',
      input: {
        snapshot,
        query: { ...queryInput, cursor: nonCanonicalJsonCursor },
        options: { cursorSecret, cursorTtlMs: 5_000, now: 2_000 },
      },
      expectedError: errorContract(() =>
        queryGraph(
          snapshot,
          { ...queryInput, cursor: nonCanonicalJsonCursor },
          { cursorSecret, cursorTtlMs: 5_000, now: 2_000 },
        ),
      ),
    },
    {
      id: 'cursor-offset-out-of-contract-bounds-error',
      family: 'query_error',
      operation: 'query_graph',
      input: {
        snapshot,
        query: { ...queryInput, cursor: hugeOffsetCursor },
        options: { cursorSecret, cursorTtlMs: 5_000, now: 2_000 },
      },
      expectedError: errorContract(() =>
        queryGraph(
          snapshot,
          { ...queryInput, cursor: hugeOffsetCursor },
          { cursorSecret, cursorTtlMs: 5_000, now: 2_000 },
        ),
      ),
    },
    {
      id: 'explain-target-not-found-error',
      family: 'query_error',
      operation: 'explain_graph',
      input: {
        snapshot,
        explain: {
          scenarioInstanceId: 'scenario-001',
          targetId: 'node:sha256:missing',
        },
      },
      expectedError: errorContract(() =>
        explainGraph(snapshot, {
          scenarioInstanceId: 'scenario-001',
          targetId: 'node:sha256:missing',
        }),
      ),
    },
    {
      id: 'explain-path-not-found-error',
      family: 'query_error',
      operation: 'explain_graph',
      input: {
        snapshot,
        explain: {
          scenarioInstanceId: 'scenario-001',
          rootNodeId: nodes.d.id,
          targetId: nodes.a.id,
          direction: 'outgoing',
          depth: 3,
        },
      },
      expectedError: errorContract(() =>
        explainGraph(snapshot, {
          scenarioInstanceId: 'scenario-001',
          rootNodeId: nodes.d.id,
          targetId: nodes.a.id,
          direction: 'outgoing',
          depth: 3,
        }),
      ),
    },
    {
      id: 'explain-empty-root-error',
      family: 'query_error',
      operation: 'explain_graph',
      input: {
        snapshot,
        explain: {
          scenarioInstanceId: 'scenario-001',
          rootNodeId: '',
          targetId: nodes.c.id,
          direction: 'outgoing',
          depth: 3,
        },
      },
      expectedError: errorContract(() =>
        explainGraph(snapshot, {
          scenarioInstanceId: 'scenario-001',
          rootNodeId: '',
          targetId: nodes.c.id,
          direction: 'outgoing',
          depth: 3,
        }),
      ),
    },
  ];

  const strictErrorInputs: ReadonlyArray<{
    id: string;
    bytes: Buffer;
    limits?: { maxDepth?: number; maxNodes?: number; maxStringLength?: number };
  }> = [
    { id: 'strict-json-invalid-utf8', bytes: Buffer.from([0xc3, 0x28]) },
    { id: 'strict-json-bom', bytes: Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]) },
    {
      id: 'strict-json-duplicate-decoded-key',
      bytes: Buffer.from('{"a":1,"\\u0061":2}', 'utf8'),
    },
    { id: 'strict-json-syntax', bytes: Buffer.from('{"a":', 'utf8') },
    {
      id: 'strict-json-unpaired-high-surrogate',
      bytes: Buffer.from('{"value":"\\ud800"}', 'utf8'),
    },
    {
      id: 'strict-json-unpaired-low-surrogate',
      bytes: Buffer.from('{"value":"\\udc00"}', 'utf8'),
    },
    {
      id: 'strict-json-limit',
      bytes: Buffer.from('{"value":"12345"}', 'utf8'),
      limits: { maxStringLength: 4 },
    },
    {
      id: 'strict-json-zero-max-depth',
      bytes: Buffer.from('{}', 'utf8'),
      limits: { maxDepth: 0 },
    },
    {
      id: 'strict-json-negative-max-depth',
      bytes: Buffer.from('{}', 'utf8'),
      limits: { maxDepth: -1 },
    },
    {
      id: 'strict-json-zero-max-nodes',
      bytes: Buffer.from('{}', 'utf8'),
      limits: { maxNodes: 0 },
    },
    {
      id: 'strict-json-negative-max-nodes',
      bytes: Buffer.from('{}', 'utf8'),
      limits: { maxNodes: -1 },
    },
    {
      id: 'strict-json-zero-max-string-length',
      bytes: Buffer.from('"a"', 'utf8'),
      limits: { maxStringLength: 0 },
    },
    {
      id: 'strict-json-negative-max-string-length',
      bytes: Buffer.from('"a"', 'utf8'),
      limits: { maxStringLength: -1 },
    },
  ];
  for (const item of strictErrorInputs) {
    vectors.push({
      id: item.id,
      family: 'strict_json_error',
      operation: 'parse_strict_graph_json',
      input: {
        ...bytesContract(item.bytes),
        ...(item.limits === undefined ? {} : { limits: item.limits }),
      },
      expectedError: errorContract(() => parseStrictGraphJson(item.bytes, item.limits)),
    });
  }
  const vectorIds = new Set<string>();
  for (const vector of vectors) {
    if (vectorIds.has(vector.id)) {
      throw new Error(`Golden vector ID ${vector.id} is duplicated.`);
    }
    vectorIds.add(vector.id);
    const replayed = replayGoldenVector(vector);
    const declared = vector.expected ?? vector.expectedError;
    if (declared === undefined || canonicalJson(replayed) !== canonicalJson(declared)) {
      throw new Error(`Golden vector ${vector.id} is not replayable from its declared input.`);
    }
  }
  return vectors;
}

function replayGoldenVector(vector: GoldenVector): unknown {
  const input = vector.input;
  switch (vector.family) {
    case 'canonical_json': {
      if (vector.operation === 'canonicalize_tagged_javascript_value') {
        const valueSpec = input.valueSpec as { kind: string };
        return bytesContract(canonicalBytes(taggedJavascriptValue(valueSpec.kind)));
      }
      const bytes = Buffer.from(input.utf8Base64 as string, 'base64');
      return bytesContract(canonicalBytes(parseStrictGraphJson(bytes)));
    }
    case 'canonical_json_error':
      return errorContract(() => {
        if (vector.operation === 'parse_then_canonicalize') {
          const bytes = Buffer.from(input.utf8Base64 as string, 'base64');
          return canonicalJson(parseStrictGraphJson(bytes));
        }
        const valueSpec = input.valueSpec as { kind: string };
        return canonicalJson(taggedJavascriptValue(valueSpec.kind));
      });
    case 'identity':
      if (vector.operation === 'derive_graph_node_id') {
        return {
          value: deriveGraphNodeId(input as unknown as Parameters<typeof deriveGraphNodeId>[0]),
          reobservedValue: deriveGraphNodeId({
            scenarioInstanceId: input.scenarioInstanceId as string,
            type: input.type as string,
            authorityRef: input.reobservedAuthorityRef as AuthorityRef,
          }),
        };
      }
      return {
        value: deriveGraphEdgeId(input as unknown as Parameters<typeof deriveGraphEdgeId>[0]),
      };
    case 'snapshot_integrity': {
      if (vector.operation === 'verify_graph_snapshot_integrity') {
        return {
          valid: verifyGraphSnapshotIntegrity(input.valid),
          tampered: verifyGraphSnapshotIntegrity(input.tampered),
        };
      }
      const sealed = sealGraphSnapshot(input.value as never);
      if (vector.id === 'snapshot-canonical-integrity-and-serialization') {
        const serialized = serializeGraphSnapshot(sealed);
        return {
          canonicalValue: sealed,
          integrityHash: sealed.integrityHash,
          serialized: bytesContract(serialized),
          trailingLf: serialized.at(-1) === 0x0a,
        };
      }
      if (vector.id === 'snapshot-generated-at-excluded-from-integrity') {
        return {
          integrityHash: sealed.integrityHash,
          baselineIntegrityHash: sealGraphSnapshot(input.baseline as never).integrityHash,
        };
      }
      return { accepted: true, canonicalValue: sealed };
    }
    case 'delta_integrity': {
      if (vector.operation === 'verify_graph_delta_integrity') {
        return {
          valid: verifyGraphDeltaIntegrity(input.valid),
          tampered: verifyGraphDeltaIntegrity(input.tampered),
        };
      }
      const sealed = sealGraphDelta(input.value as never);
      if (vector.id === 'delta-canonical-integrity-and-serialization') {
        const serialized = serializeGraphDelta(sealed);
        return {
          canonicalValue: sealed,
          integrityHash: sealed.integrityHash,
          serialized: bytesContract(serialized),
          trailingLf: serialized.at(-1) === 0x0a,
        };
      }
      return {
        integrityHash: sealed.integrityHash,
        baselineIntegrityHash: sealGraphDelta(input.baseline as never).integrityHash,
      };
    }
    case 'query':
    case 'query_cursor':
      if (vector.operation === 'graph_query_hash') {
        return { value: graphQueryHash(input.value as GraphQueryInput) };
      }
      return queryGraph(
        input.snapshot as GraphSnapshot,
        input.query as GraphQueryInput,
        input.options as Parameters<typeof queryGraph>[2],
      );
    case 'explain':
      return explainGraph(
        input.snapshot as GraphSnapshot,
        input.explain as Parameters<typeof explainGraph>[1],
      );
    case 'contract_error':
      return errorContract(() => {
        if (vector.operation === 'assert_graph_snapshot_integrity') {
          return assertGraphSnapshotIntegrity(input.value);
        }
        if (vector.operation === 'seal_graph_delta') {
          return sealGraphDelta(input.value as never);
        }
        return sealGraphSnapshot(input.value as never);
      });
    case 'query_error':
      return errorContract(() => {
        if (vector.operation === 'graph_query_hash_tagged_input') {
          const valueSpec = input.valueSpec as { kind: string };
          return graphQueryHash(taggedQueryInput(valueSpec.kind));
        }
        if (vector.operation === 'explain_graph') {
          return explainGraph(
            input.snapshot as GraphSnapshot,
            input.explain as Parameters<typeof explainGraph>[1],
          );
        }
        return queryGraph(
          input.snapshot as GraphSnapshot,
          input.query as GraphQueryInput,
          input.options as Parameters<typeof queryGraph>[2],
        );
      });
    case 'strict_json_error':
      return errorContract(() =>
        parseStrictGraphJson(
          Buffer.from(input.utf8Base64 as string, 'base64'),
          input.limits as Parameters<typeof parseStrictGraphJson>[1],
        ),
      );
    default:
      throw new Error(`Golden vector ${vector.id} has unknown family ${vector.family}.`);
  }
}

async function buildOutputs(): Promise<Map<string, Buffer>> {
  const snapshotSchemaBytes = await readFile(snapshotSchemaPath);
  const deltaSchemaBytes = await readFile(deltaSchemaPath);
  const vectors = {
    schema: 'openslack.organization_graph_golden_vectors.v1',
    authority: 'typescript',
    canonicalizationRuntime: 'ECMAScript JSON.stringify plus UTF-16 code-unit key ordering',
    cases: buildVectors(),
  };
  const vectorBytes = await prettyJson(vectors);
  const manifest = {
    schema: 'openslack.organization_graph_contract_manifest.v1',
    authority: 'typescript',
    graphSchemas: {
      snapshot: GRAPH_SNAPSHOT_SCHEMA,
      delta: GRAPH_DELTA_SCHEMA,
    },
    authorityProviders: GRAPH_AUTHORITY_PROVIDERS,
    hardLimits: GRAPH_HARD_LIMITS,
    valueLimits: GRAPH_VALUE_LIMITS,
    strictJsonLimits: STRICT_GRAPH_JSON_DEFAULT_LIMITS,
    queryProtocolLimits: GRAPH_QUERY_PROTOCOL_LIMITS,
    algorithms: {
      strictJson: 'openslack.strict_graph_json.v1',
      canonicalJson: 'openslack.ecmascript_canonical_json.v1',
      nodeIdentity: 'openslack.graph_node_identity.sha256.v1',
      edgeIdentity: 'openslack.graph_edge_identity.sha256.v1',
      snapshotIntegrity: 'openslack.graph_snapshot_integrity.sha256.v1',
      deltaIntegrity: 'openslack.graph_delta_integrity.sha256.v1',
      queryNormalization: 'openslack.graph_query_normalization.v1',
      queryCursor: 'openslack.graph_query_cursor.hmac_sha256.v1',
      explain: 'openslack.graph_explain.v1',
    },
    errorCodes: {
      canonicalJson: CANONICAL_JSON_ERROR_CODES,
      graphContract: GRAPH_CONTRACT_ERROR_CODES,
      graphQuery: GRAPH_QUERY_ERROR_CODES,
      strictJson: STRICT_GRAPH_JSON_ERROR_CODES,
    },
    artifacts: {
      snapshotSchema: {
        path: 'schemas/graph-snapshot.v1.schema.json',
        sha256: sha256(snapshotSchemaBytes),
      },
      deltaSchema: {
        path: 'schemas/graph-delta.v1.schema.json',
        sha256: sha256(deltaSchemaBytes),
      },
      goldenVectors: {
        path: 'golden-vectors.json',
        sha256: sha256(vectorBytes),
      },
    },
  };
  const manifestBytes = await prettyJson(manifest);
  const softwareDelivery = await buildSoftwareDeliveryContractArtifacts();
  const outputs = new Map<string, Buffer>();
  outputs.set(resolve(contractOutputRoot, 'golden-vectors.json'), vectorBytes);
  outputs.set(resolve(contractOutputRoot, 'manifest.json'), manifestBytes);
  for (const root of [sourceMirrorRoot, serviceMirrorRoot]) {
    outputs.set(resolve(root, 'schemas/graph-snapshot.v1.schema.json'), snapshotSchemaBytes);
    outputs.set(resolve(root, 'schemas/graph-delta.v1.schema.json'), deltaSchemaBytes);
  }
  outputs.set(resolve(serviceMirrorRoot, 'golden-vectors.json'), vectorBytes);
  outputs.set(resolve(serviceMirrorRoot, 'manifest.json'), manifestBytes);
  outputs.set(
    resolve(
      softwareDeliveryContractOutputRoot,
      'schemas/software-delivery-source-snapshot.v1.schema.json',
    ),
    softwareDelivery.schemaBytes,
  );
  outputs.set(
    resolve(softwareDeliveryContractOutputRoot, 'projector-golden-vectors.json'),
    softwareDelivery.vectorBytes,
  );
  outputs.set(
    resolve(softwareDeliveryContractOutputRoot, 'manifest.json'),
    softwareDelivery.manifestBytes,
  );
  outputs.set(
    resolve(
      softwareDeliverySourceMirrorRoot,
      'schemas/software-delivery-source-snapshot.v1.schema.json',
    ),
    softwareDelivery.schemaBytes,
  );
  outputs.set(
    resolve(
      softwareDeliveryServiceMirrorRoot,
      'schemas/software-delivery-source-snapshot.v1.schema.json',
    ),
    softwareDelivery.schemaBytes,
  );
  outputs.set(
    resolve(softwareDeliveryServiceMirrorRoot, 'projector-golden-vectors.json'),
    softwareDelivery.vectorBytes,
  );
  outputs.set(
    resolve(softwareDeliveryServiceMirrorRoot, 'manifest.json'),
    softwareDelivery.manifestBytes,
  );
  return outputs;
}

async function writeOutputs(outputs: ReadonlyMap<string, Buffer>): Promise<void> {
  const unsafe = await generatedTreeIssues();
  if (unsafe.length > 0) {
    throw new Error(
      `Refusing to write unsafe Organization Graph generated trees:\n${unsafe
        .map((path) => `- ${path}`)
        .join('\n')}`,
    );
  }
  for (const [path, bytes] of outputs) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    console.log(`generated ${path.slice(generatedOutputRoot.length + 1)}`);
  }
}

async function checkOutputs(outputs: ReadonlyMap<string, Buffer>): Promise<void> {
  const stale = await generatedTreeIssues();
  for (const [path, expected] of outputs) {
    let actual: Buffer;
    try {
      actual = await readFile(path);
    } catch {
      stale.push(`${path.slice(generatedOutputRoot.length + 1)} (missing)`);
      continue;
    }
    if (!actual.equals(expected)) {
      stale.push(`${path.slice(generatedOutputRoot.length + 1)} (stale)`);
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `Organization Graph generated contracts are not current:\n${stale
        .map((path) => `- ${path}`)
        .join('\n')}\nRun: bun run graph:golden generate`,
    );
  }
  console.log(`organization-graph contracts current (${outputs.size} generated files)`);
}

async function generatedTreeIssues(): Promise<string[]> {
  return [
    ...(await exactGeneratedTreeIssues(contractOutputRoot, [
      'schemas/graph-snapshot.v1.schema.json',
      'schemas/graph-delta.v1.schema.json',
      'golden-vectors.json',
      'manifest.json',
    ])),
    ...(await exactGeneratedTreeIssues(sourceMirrorRoot, [
      'schemas/graph-snapshot.v1.schema.json',
      'schemas/graph-delta.v1.schema.json',
    ])),
    ...(await exactGeneratedTreeIssues(serviceMirrorRoot, [
      'schemas/graph-snapshot.v1.schema.json',
      'schemas/graph-delta.v1.schema.json',
      'golden-vectors.json',
      'manifest.json',
    ])),
    ...(await exactGeneratedTreeIssues(softwareDeliveryContractOutputRoot, [
      'schemas/software-delivery-source-snapshot.v1.schema.json',
      'projector-golden-vectors.json',
      'manifest.json',
    ])),
    ...(await exactGeneratedTreeIssues(softwareDeliverySourceMirrorRoot, [
      'schemas/software-delivery-source-snapshot.v1.schema.json',
    ])),
    ...(await exactGeneratedTreeIssues(softwareDeliveryServiceMirrorRoot, [
      'schemas/software-delivery-source-snapshot.v1.schema.json',
      'projector-golden-vectors.json',
      'manifest.json',
    ])),
  ];
}

async function exactGeneratedTreeIssues(
  root: string,
  expectedRelativePaths: readonly string[],
): Promise<string[]> {
  const issues: string[] = [];
  const expectedFiles = new Set(expectedRelativePaths.map((path) => path.split('/').join(sep)));
  const expectedDirectories = new Set<string>();
  for (const path of expectedFiles) {
    let current = dirname(path);
    while (current !== '.') {
      expectedDirectories.add(current);
      current = dirname(current);
    }
  }
  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink())
      return [`${relative(generatedOutputRoot, root)} (symlink forbidden)`];
    if (!rootStat.isDirectory())
      return [`${relative(generatedOutputRoot, root)} (not a directory)`];
  } catch {
    return [];
  }
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const relativePath = relative(root, path);
      const displayPath = relative(generatedOutputRoot, path).split(sep).join('/');
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) {
        issues.push(`${displayPath} (symlink forbidden)`);
      } else if (stat.isDirectory()) {
        if (!expectedDirectories.has(relativePath)) {
          issues.push(`${displayPath} (unexpected directory)`);
        } else {
          await visit(path);
        }
      } else if (!stat.isFile() || !expectedFiles.has(relativePath)) {
        issues.push(`${displayPath} (unexpected file)`);
      }
    }
  };
  await visit(root);
  return issues;
}

async function main(): Promise<void> {
  const argumentsFromCli = process.argv.slice(2).filter((argument) => argument !== '--');
  const mode = argumentsFromCli[0] ?? 'check';
  if (!['check', '--check', 'generate', '--write'].includes(mode) || argumentsFromCli.length > 1) {
    throw new Error('Usage: bun run graph:golden [check|generate]');
  }
  const outputs = await buildOutputs();
  if (mode === 'generate' || mode === '--write') await writeOutputs(outputs);
  else await checkOutputs(outputs);
}

await main();
