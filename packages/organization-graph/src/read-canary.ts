import { canonicalJson } from './canonical.js';
import { normalizeGraphServiceOrigin, type GraphServiceNetworkMode } from './service-origin.js';
import { parseStrictGraphJson, type StrictJsonObject } from './strict-json.js';
import {
  GRAPH_AUTHORITY_PROVIDERS,
  GRAPH_DELTA_SCHEMA,
  GRAPH_HARD_LIMITS,
  GRAPH_SNAPSHOT_SCHEMA,
  GRAPH_VALUE_LIMITS,
  type AuthorityRef,
  type GraphCompleteness,
  type GraphExplainInput,
  type GraphExplanation,
  type GraphQueryInput,
  type GraphQueryResult,
  type GraphRelationshipPath,
} from './types.js';
import { validateGraphDelta, validateGraphSnapshot } from './validation.js';

export const GRAPH_READ_CANARY_SCHEMA = 'openslack.graph_canary_read.v1' as const;

export const GRAPH_READ_CANARY_POLICY = Object.freeze({
  defaultTimeoutMs: 2_000,
  maxTimeoutMs: 30_000,
  maxScenarioInstanceIds: 16,
  maxPolicyLifetimeMs: 7 * 24 * 60 * 60 * 1_000,
  maxEnvelopeBytes: GRAPH_HARD_LIMITS.responseBytes + 4 * 1_024,
} as const);

export type GraphReadCanaryBackend = 'go' | 'ts-local';
export type GraphReadCanaryOperation = 'query' | 'explain';
export type GraphReadCanaryErrorCode =
  | 'GRAPH_READ_CANARY_POLICY_INVALID'
  | 'GRAPH_READ_CANARY_POLICY_EXPIRED'
  | 'GRAPH_READ_CANARY_NOT_SELECTED'
  | 'GRAPH_READ_CANARY_BACKEND_ROLLBACK'
  | 'GRAPH_READ_CANARY_TIMEOUT'
  | 'GRAPH_READ_CANARY_NETWORK_ERROR'
  | 'GRAPH_READ_CANARY_HTTP_ERROR'
  | 'GRAPH_READ_CANARY_RESPONSE_INVALID'
  | 'GRAPH_READ_CANARY_ROUTE_MISMATCH'
  | 'GRAPH_READ_CANARY_AUDIT_FAILED'
  | 'GRAPH_QUERY_CURSOR_INVALID'
  | 'GRAPH_QUERY_CURSOR_EXPIRED'
  | 'GRAPH_QUERY_CURSOR_MISMATCH';

export class GraphReadCanaryError extends Error {
  constructor(
    readonly code: GraphReadCanaryErrorCode,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'GraphReadCanaryError';
  }
}

export interface GraphReadCanaryRoute {
  readonly backend: GraphReadCanaryBackend;
  readonly routingEpoch: number;
}

export interface GraphReadCanaryQueryProjection extends GraphQueryResult {
  readonly generatedAt: string;
}

export interface GraphReadCanaryExplainProjection extends GraphExplanation {
  readonly generatedAt: string;
  readonly snapshotCursor: string;
}

export interface GraphReadCanaryPort {
  route(scenarioInstanceId: string): GraphReadCanaryRoute | undefined;
  query(input: Readonly<GraphQueryInput>): Promise<GraphReadCanaryQueryProjection>;
  explain(input: Readonly<GraphExplainInput>): Promise<GraphReadCanaryExplainProjection>;
  recordBlockedRead?(
    operation: GraphReadCanaryOperation,
    input: Readonly<GraphQueryInput | GraphExplainInput>,
    error: unknown,
  ): void | Promise<void>;
  recordTsLocalRead?(
    operation: GraphReadCanaryOperation,
    input: Readonly<GraphQueryInput | GraphExplainInput>,
  ): void | Promise<void>;
}

type GraphReadCanaryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GraphReadCanaryRouterOptions {
  readonly backend: GraphReadCanaryBackend;
  readonly tenantId: string;
  readonly expectedTenantId: string;
  readonly scenarioInstanceIds: readonly string[];
  readonly routingEpoch: number;
  readonly expiresAt: string;
  readonly origin?: string;
  readonly networkMode?: GraphServiceNetworkMode;
  readonly expectedBuildSha?: string;
  readonly timeoutMs?: number;
  readonly fetch?: GraphReadCanaryFetch;
  readonly now?: () => number;
}

const BUILD_SHA = /^[0-9a-f]{64}$/u;
const HASH = /^sha256:[0-9a-f]{64}$/u;
const CURSOR = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u;
const PROVIDERS = new Set<string>(GRAPH_AUTHORITY_PROVIDERS);
const ZERO_HASH = `sha256:${'0'.repeat(64)}`;

function fail(code: GraphReadCanaryErrorCode, message: string, status?: number): never {
  throw new GraphReadCanaryError(code, message, status);
}

function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail('GRAPH_READ_CANARY_POLICY_INVALID', `${name} must be a positive safe integer.`);
  }
  return value;
}

function boundedIdentifier(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    [...value].length > GRAPH_VALUE_LIMITS.identifierCharacters ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', `${name} is not a bounded identifier.`);
  }
  return value;
}

function policyIdentifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    fail('GRAPH_READ_CANARY_POLICY_INVALID', `${name} is not a canonical policy identifier.`);
  }
  try {
    return boundedIdentifier(value, name);
  } catch {
    fail('GRAPH_READ_CANARY_POLICY_INVALID', `${name} is not a bounded identifier.`);
  }
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): StrictJsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', 'Graph canary response must contain objects.');
  }
  const object = value as StrictJsonObject;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(object, key)) ||
    Object.keys(object).some((key) => !allowed.has(key))
  ) {
    fail(
      'GRAPH_READ_CANARY_RESPONSE_INVALID',
      'Graph canary response object has an invalid shape.',
    );
  }
  return object;
}

function strictDateTime(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > GRAPH_VALUE_LIMITS.dateTimeCharacters) {
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', `${name} is not a bounded date-time.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', `${name} is not a valid date-time.`);
  }
  return value;
}

function stringArray(value: unknown, name: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', `${name} is not a bounded string array.`);
  }
  return value.map((item, index) => boundedIdentifier(item, `${name}[${index}]`));
}

function booleanMember(object: StrictJsonObject, key: string): boolean {
  const value = object[key];
  if (typeof value !== 'boolean') {
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', `${key} must be boolean.`);
  }
  return value;
}

function nonnegativeInteger(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', `${name} must be a bounded non-negative integer.`);
  }
  return value as number;
}

function validateCompleteness(
  value: unknown,
  scenarioInstanceId: string,
  generatedAt: string,
): GraphCompleteness {
  return validateGraphSnapshot({
    schema: GRAPH_SNAPSHOT_SCHEMA,
    cursor: 'canary-validation-cursor',
    scenarioInstanceId,
    generatedAt,
    projectorVersion: 'canary-read-validation',
    nodes: [],
    edges: [],
    completeness: value,
    integrityHash: ZERO_HASH,
  }).completeness;
}

function validatePath(value: unknown, name: string): GraphRelationshipPath {
  const object = exactObject(value, ['nodeId', 'nodeIds', 'edgeIds']);
  return {
    nodeId: boundedIdentifier(object.nodeId, `${name}.nodeId`),
    nodeIds: stringArray(object.nodeIds, `${name}.nodeIds`, GRAPH_HARD_LIMITS.traversalSteps),
    edgeIds: stringArray(object.edgeIds, `${name}.edgeIds`, GRAPH_HARD_LIMITS.traversalSteps),
  };
}

function validateAuthorityRef(value: unknown): AuthorityRef {
  const object = exactObject(value, [
    'provider',
    'objectType',
    'objectId',
    'version',
    'observedAt',
  ]);
  const provider = boundedIdentifier(object.provider, 'authorityRef.provider');
  if (!PROVIDERS.has(provider)) {
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', 'authorityRef.provider is not registered.');
  }
  return {
    provider: provider as AuthorityRef['provider'],
    objectType: boundedIdentifier(object.objectType, 'authorityRef.objectType'),
    objectId: boundedIdentifier(object.objectId, 'authorityRef.objectId'),
    version: boundedIdentifier(object.version, 'authorityRef.version'),
    observedAt: strictDateTime(object.observedAt, 'authorityRef.observedAt'),
  };
}

function validateQueryResult(
  value: unknown,
  input: Readonly<GraphQueryInput>,
  generatedAt: string,
  snapshotCursor: string,
): GraphQueryResult {
  const object = exactObject(
    value,
    [
      'scenarioInstanceId',
      'snapshotCursor',
      'queryHash',
      'nodes',
      'edges',
      'paths',
      'completeness',
      'truncation',
    ],
    ['nextCursor'],
  );
  const scenarioInstanceId = boundedIdentifier(
    object.scenarioInstanceId,
    'result.scenarioInstanceId',
  );
  if (scenarioInstanceId !== input.scenarioInstanceId || object.snapshotCursor !== snapshotCursor) {
    fail(
      'GRAPH_READ_CANARY_ROUTE_MISMATCH',
      'Graph canary result scope does not match its request envelope.',
    );
  }
  if (typeof object.queryHash !== 'string' || !HASH.test(object.queryHash)) {
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', 'Graph canary query hash is invalid.');
  }
  if (
    !Array.isArray(object.nodes) ||
    object.nodes.length > (input.maxNodes ?? GRAPH_HARD_LIMITS.nodes)
  ) {
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', 'Graph canary nodes exceed the requested bound.');
  }
  if (
    !Array.isArray(object.edges) ||
    object.edges.length > (input.maxEdges ?? GRAPH_HARD_LIMITS.edges)
  ) {
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', 'Graph canary edges exceed the requested bound.');
  }
  const validatedNodes = validateGraphSnapshot({
    schema: GRAPH_SNAPSHOT_SCHEMA,
    cursor: snapshotCursor,
    scenarioInstanceId,
    generatedAt,
    projectorVersion: 'canary-read-validation',
    nodes: object.nodes,
    edges: [],
    completeness: object.completeness,
    integrityHash: ZERO_HASH,
  }).nodes;
  const validatedEdges = validateGraphDelta({
    schema: GRAPH_DELTA_SCHEMA,
    scenarioInstanceId,
    fromCursor: 'canary-validation-source',
    toCursor: 'canary-validation-target',
    generatedAt,
    upsertNodes: [],
    closeNodeIds: [],
    upsertEdges: object.edges,
    closeEdgeIds: [],
    evidenceRefs: [],
    integrityHash: ZERO_HASH,
  }).upsertEdges;
  if (!Array.isArray(object.paths) || object.paths.length > GRAPH_HARD_LIMITS.nodes) {
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', 'Graph canary paths exceed the frozen bound.');
  }
  const truncation = exactObject(object.truncation, [
    'truncated',
    'nodeLimit',
    'edgeLimit',
    'byteLimit',
    'paginated',
    'responseBytes',
  ]);
  const result: GraphQueryResult = {
    scenarioInstanceId,
    snapshotCursor,
    queryHash: object.queryHash,
    nodes: validatedNodes,
    edges: validatedEdges,
    paths: object.paths.map((item, index) => validatePath(item, `result.paths[${index}]`)),
    completeness: validateCompleteness(object.completeness, scenarioInstanceId, generatedAt),
    truncation: {
      truncated: booleanMember(truncation, 'truncated'),
      nodeLimit: booleanMember(truncation, 'nodeLimit'),
      edgeLimit: booleanMember(truncation, 'edgeLimit'),
      byteLimit: booleanMember(truncation, 'byteLimit'),
      paginated: booleanMember(truncation, 'paginated'),
      responseBytes: nonnegativeInteger(
        truncation.responseBytes,
        'result.truncation.responseBytes',
        GRAPH_HARD_LIMITS.responseBytes,
      ),
    },
  };
  if (Object.hasOwn(object, 'nextCursor')) {
    if (
      typeof object.nextCursor !== 'string' ||
      object.nextCursor.length > 512 ||
      !CURSOR.test(object.nextCursor)
    ) {
      fail('GRAPH_READ_CANARY_RESPONSE_INVALID', 'Graph canary next cursor is invalid.');
    }
    result.nextCursor = object.nextCursor;
  }
  const requestedBytes = input.maxResponseBytes ?? GRAPH_HARD_LIMITS.responseBytes;
  if (Buffer.byteLength(canonicalJson(result), 'utf8') > requestedBytes) {
    fail(
      'GRAPH_READ_CANARY_RESPONSE_INVALID',
      'Graph canary query result exceeds the requested byte bound.',
    );
  }
  return result;
}

function validateExplanation(
  value: unknown,
  input: Readonly<GraphExplainInput>,
  generatedAt: string,
): GraphExplanation {
  const object = exactObject(
    value,
    [
      'scenarioInstanceId',
      'targetKind',
      'targetId',
      'sourceEventIds',
      'evidenceRefs',
      'projectorVersion',
      'validFrom',
      'completeness',
      'path',
      'truncation',
    ],
    ['authorityRef', 'validTo'],
  );
  const scenarioInstanceId = boundedIdentifier(
    object.scenarioInstanceId,
    'result.scenarioInstanceId',
  );
  const targetId = boundedIdentifier(object.targetId, 'result.targetId');
  if (scenarioInstanceId !== input.scenarioInstanceId || targetId !== input.targetId) {
    fail(
      'GRAPH_READ_CANARY_ROUTE_MISMATCH',
      'Graph canary explanation scope does not match its request.',
    );
  }
  if (object.targetKind !== 'node' && object.targetKind !== 'edge') {
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', 'Graph canary target kind is invalid.');
  }
  const truncation = exactObject(object.truncation, ['sourceEventIds', 'evidenceRefs', 'path']);
  const result: GraphExplanation = {
    scenarioInstanceId,
    targetKind: object.targetKind,
    targetId,
    sourceEventIds: stringArray(
      object.sourceEventIds,
      'result.sourceEventIds',
      GRAPH_HARD_LIMITS.sourceEventIds,
    ),
    evidenceRefs: stringArray(
      object.evidenceRefs,
      'result.evidenceRefs',
      GRAPH_HARD_LIMITS.evidenceRefs,
    ),
    projectorVersion: boundedIdentifier(object.projectorVersion, 'result.projectorVersion'),
    validFrom: strictDateTime(object.validFrom, 'result.validFrom'),
    completeness: validateCompleteness(object.completeness, scenarioInstanceId, generatedAt),
    path: validatePath(object.path, 'result.path'),
    truncation: {
      sourceEventIds: booleanMember(truncation, 'sourceEventIds'),
      evidenceRefs: booleanMember(truncation, 'evidenceRefs'),
      path: booleanMember(truncation, 'path'),
    },
  };
  if (Object.hasOwn(object, 'authorityRef'))
    result.authorityRef = validateAuthorityRef(object.authorityRef);
  if (Object.hasOwn(object, 'validTo'))
    result.validTo = strictDateTime(object.validTo, 'result.validTo');
  return result;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort after the response classification is fixed.
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await cancelResponseBody(response);
    fail(
      'GRAPH_READ_CANARY_RESPONSE_INVALID',
      'Graph canary response exceeds the frozen byte bound.',
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        fail(
          'GRAPH_READ_CANARY_RESPONSE_INVALID',
          'Graph canary response exceeds the frozen byte bound.',
        );
      }
      chunks.push(item.value);
    }
  } catch (error) {
    if (error instanceof GraphReadCanaryError) throw error;
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', 'Graph canary response body could not be read.');
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseCanonicalObject(bytes: Uint8Array): StrictJsonObject {
  const buffer = Buffer.from(bytes);
  const body = buffer.at(-1) === 0x0a ? buffer.subarray(0, -1) : buffer;
  if (body.length === 0 || body.at(-1) === 0x0a || body.at(-1) === 0x0d) {
    fail(
      'GRAPH_READ_CANARY_RESPONSE_INVALID',
      'Graph canary response is not one canonical JSON object.',
    );
  }
  try {
    const value = parseStrictGraphJson(body);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail('GRAPH_READ_CANARY_RESPONSE_INVALID', 'Graph canary response is not an object.');
    }
    if (!body.equals(Buffer.from(canonicalJson(value), 'utf8'))) {
      fail('GRAPH_READ_CANARY_RESPONSE_INVALID', 'Graph canary response is not canonical JSON.');
    }
    return value as StrictJsonObject;
  } catch (error) {
    if (error instanceof GraphReadCanaryError) throw error;
    fail('GRAPH_READ_CANARY_RESPONSE_INVALID', 'Graph canary response is not strict JSON.');
  }
}

function classifyErrorResponse(response: Response, body: StrictJsonObject): never {
  const error = exactObject(body, ['schema', 'code', 'message']);
  const code = error.code;
  if (
    error.schema === 'openslack.graph_error.v1' &&
    typeof error.message === 'string' &&
    (code === 'GRAPH_QUERY_CURSOR_INVALID' ||
      code === 'GRAPH_QUERY_CURSOR_EXPIRED' ||
      code === 'GRAPH_QUERY_CURSOR_MISMATCH')
  ) {
    fail(code, 'The Go graph read authority rejected the bound query cursor.', response.status);
  }
  if (code === 'GRAPH_CANARY_ROUTE_MISMATCH' || code === 'GRAPH_CANARY_NOT_CONFIGURED') {
    fail(
      'GRAPH_READ_CANARY_ROUTE_MISMATCH',
      'The Go graph read authority rejected its route binding.',
      response.status,
    );
  }
  fail(
    'GRAPH_READ_CANARY_HTTP_ERROR',
    'The Go graph read authority returned a bounded HTTP failure.',
    response.status,
  );
}

export class GraphReadCanaryRouter implements GraphReadCanaryPort {
  private readonly backend: GraphReadCanaryBackend;
  private readonly scenarios: ReadonlySet<string>;
  private readonly routingEpoch: number;
  private readonly expiresAtMs: number;
  private readonly origin: string | undefined;
  private readonly expectedBuildSha: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetch: GraphReadCanaryFetch;
  private readonly now: () => number;

  constructor(options: GraphReadCanaryRouterOptions) {
    if (options.backend !== 'go' && options.backend !== 'ts-local') {
      fail('GRAPH_READ_CANARY_POLICY_INVALID', 'Graph read canary backend is not registered.');
    }
    const tenantId = policyIdentifier(options.tenantId, 'tenantId');
    const expectedTenantId = policyIdentifier(options.expectedTenantId, 'expectedTenantId');
    if (tenantId !== expectedTenantId) {
      fail(
        'GRAPH_READ_CANARY_POLICY_INVALID',
        'Graph read canary tenant binding does not match the workspace.',
      );
    }
    if (
      options.scenarioInstanceIds.length < 1 ||
      options.scenarioInstanceIds.length > GRAPH_READ_CANARY_POLICY.maxScenarioInstanceIds
    ) {
      fail(
        'GRAPH_READ_CANARY_POLICY_INVALID',
        'Graph read canary scenario allowlist is outside its bound.',
      );
    }
    const scenarios = options.scenarioInstanceIds.map((value) =>
      policyIdentifier(value, 'scenarioInstanceId'),
    );
    if (new Set(scenarios).size !== scenarios.length) {
      fail(
        'GRAPH_READ_CANARY_POLICY_INVALID',
        'Graph read canary scenario allowlist contains duplicates.',
      );
    }
    this.backend = options.backend;
    this.scenarios = new Set(scenarios);
    this.routingEpoch = positiveInteger(options.routingEpoch, 'routingEpoch');
    this.now = options.now ?? Date.now;
    const initialNow = this.safeNow();
    const expiry = Date.parse(options.expiresAt);
    if (
      !Number.isFinite(expiry) ||
      expiry <= initialNow ||
      expiry - initialNow > GRAPH_READ_CANARY_POLICY.maxPolicyLifetimeMs
    ) {
      fail(
        'GRAPH_READ_CANARY_POLICY_INVALID',
        'Graph read canary expiry is invalid or outside its lifetime bound.',
      );
    }
    this.expiresAtMs = expiry;
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? GRAPH_READ_CANARY_POLICY.defaultTimeoutMs,
      'timeoutMs',
      GRAPH_READ_CANARY_POLICY.maxTimeoutMs,
    );
    this.fetch = options.fetch ?? fetch;
    if (options.backend === 'go') {
      if (
        options.origin === undefined ||
        options.expectedBuildSha === undefined ||
        !BUILD_SHA.test(options.expectedBuildSha)
      ) {
        fail(
          'GRAPH_READ_CANARY_POLICY_INVALID',
          'Go canary routing requires one exact origin and build SHA.',
        );
      }
      this.origin = normalizeGraphServiceOrigin(
        options.origin,
        options.networkMode ?? 'loopback',
        'Graph read canary origin',
      );
      this.expectedBuildSha = options.expectedBuildSha;
    } else if (
      options.origin !== undefined ||
      options.expectedBuildSha !== undefined ||
      options.networkMode !== undefined
    ) {
      fail(
        'GRAPH_READ_CANARY_POLICY_INVALID',
        'ts-local rollback does not accept Go transport settings.',
      );
    }
  }

  route(scenarioInstanceId: string): GraphReadCanaryRoute | undefined {
    if (!this.scenarios.has(scenarioInstanceId)) return undefined;
    if (this.safeNow() >= this.expiresAtMs) {
      fail(
        'GRAPH_READ_CANARY_POLICY_EXPIRED',
        'The graph read canary policy expired before this selected read.',
      );
    }
    return Object.freeze({ backend: this.backend, routingEpoch: this.routingEpoch });
  }

  query(input: Readonly<GraphQueryInput>): Promise<GraphReadCanaryQueryProjection> {
    return this.read('query', input) as Promise<GraphReadCanaryQueryProjection>;
  }

  explain(input: Readonly<GraphExplainInput>): Promise<GraphReadCanaryExplainProjection> {
    return this.read('explain', input) as Promise<GraphReadCanaryExplainProjection>;
  }

  private async read(
    operation: GraphReadCanaryOperation,
    input: Readonly<GraphQueryInput | GraphExplainInput>,
  ): Promise<GraphReadCanaryQueryProjection | GraphReadCanaryExplainProjection> {
    const route = this.route(input.scenarioInstanceId);
    if (!route)
      fail(
        'GRAPH_READ_CANARY_NOT_SELECTED',
        'The scenario is not selected by the graph read canary.',
      );
    if (route.backend !== 'go' || !this.origin || !this.expectedBuildSha) {
      fail(
        'GRAPH_READ_CANARY_BACKEND_ROLLBACK',
        'The selected graph read route explicitly retains TypeScript authority.',
      );
    }
    const path = operation === 'query' ? '/v1/canary/graph:query' : '/v1/canary/graph:explain';
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new GraphReadCanaryError(
            'GRAPH_READ_CANARY_TIMEOUT',
            'The Go graph read authority exceeded its deadline.',
          ),
        );
      }, this.timeoutMs);
    });
    try {
      const response = await Promise.race([
        Promise.resolve().then(() =>
          this.fetch(`${this.origin}${path}`, {
            method: 'POST',
            redirect: 'manual',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'X-OpenSlack-Graph-Routing-Epoch': String(this.routingEpoch),
              'X-OpenSlack-Graph-Expected-Build-SHA': this.expectedBuildSha!,
            },
            body: canonicalJson(input),
            signal: controller.signal,
          }),
        ),
        timeout,
      ]);
      const contentType = response.headers.get('Content-Type');
      if (
        contentType === null ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())
      ) {
        await cancelResponseBody(response);
        fail(
          'GRAPH_READ_CANARY_RESPONSE_INVALID',
          'Graph canary response content type is invalid.',
          response.status,
        );
      }
      const body = parseCanonicalObject(
        await readBoundedBody(response, GRAPH_READ_CANARY_POLICY.maxEnvelopeBytes),
      );
      if (response.status !== 200) classifyErrorResponse(response, body);
      const envelope = exactObject(body, [
        'schema',
        'operation',
        'backend',
        'routingEpoch',
        'serviceBuildSha',
        'generatedAt',
        'snapshotCursor',
        'result',
      ]);
      if (
        envelope.schema !== GRAPH_READ_CANARY_SCHEMA ||
        envelope.operation !== operation ||
        envelope.backend !== 'go' ||
        envelope.routingEpoch !== this.routingEpoch ||
        envelope.serviceBuildSha !== this.expectedBuildSha
      ) {
        fail(
          'GRAPH_READ_CANARY_ROUTE_MISMATCH',
          'Graph canary response route binding does not match the selected authority.',
        );
      }
      const generatedAt = strictDateTime(envelope.generatedAt, 'generatedAt');
      const snapshotCursor = boundedIdentifier(envelope.snapshotCursor, 'snapshotCursor');
      if (operation === 'query') {
        return Object.freeze({
          generatedAt,
          ...validateQueryResult(
            envelope.result,
            input as GraphQueryInput,
            generatedAt,
            snapshotCursor,
          ),
        });
      }
      return Object.freeze({
        generatedAt,
        snapshotCursor,
        ...validateExplanation(envelope.result, input as GraphExplainInput, generatedAt),
      });
    } catch (error) {
      if (error instanceof GraphReadCanaryError) throw error;
      throw new GraphReadCanaryError(
        'GRAPH_READ_CANARY_NETWORK_ERROR',
        'The Go graph read authority could not be reached.',
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private safeNow(): number {
    let value: number;
    try {
      value = this.now();
    } catch {
      value = Number.NaN;
    }
    if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
      fail(
        'GRAPH_READ_CANARY_POLICY_INVALID',
        'Graph read canary clock returned an invalid timestamp.',
      );
    }
    return value;
  }
}
