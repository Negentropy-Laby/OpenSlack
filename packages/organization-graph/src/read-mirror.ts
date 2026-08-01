import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.js';
import { normalizeGraphServiceOrigin, type GraphServiceNetworkMode } from './service-origin.js';
import { parseStrictGraphJson, type StrictJsonObject } from './strict-json.js';
import { GRAPH_HARD_LIMITS } from './types.js';
import type {
  GraphExplainInput,
  GraphExplanation,
  GraphQueryInput,
  GraphQueryResult,
} from './types.js';

export const GRAPH_READ_MIRROR_OBSERVATION_SCHEMA =
  'openslack.graph_read_mirror_observation.v1' as const;

export const GRAPH_READ_MIRROR_POLICY = Object.freeze({
  defaultTimeoutMs: 2_000,
  maxTimeoutMs: 30_000,
  maxResponseBytes: GRAPH_HARD_LIMITS.responseBytes,
  maxDifferenceCodes: 16,
} as const);

export const GRAPH_READ_MIRROR_DIFFERENCE_CODES = Object.freeze([
  'RESULT_SCHEMA_MISMATCH',
  'SCENARIO_INSTANCE_ID_MISMATCH',
  'SNAPSHOT_CURSOR_MISMATCH',
  'QUERY_HASH_MISMATCH',
  'NODES_MISMATCH',
  'EDGES_MISMATCH',
  'PATHS_MISMATCH',
  'COMPLETENESS_MISMATCH',
  'TRUNCATION_MISMATCH',
  'CURSOR_PRESENCE_MISMATCH',
  'CURSOR_TOKEN_MISMATCH',
  'TARGET_KIND_MISMATCH',
  'TARGET_ID_MISMATCH',
  'AUTHORITY_REF_MISMATCH',
  'SOURCE_EVENT_IDS_MISMATCH',
  'EVIDENCE_REFS_MISMATCH',
  'PROJECTOR_VERSION_MISMATCH',
  'VALID_FROM_MISMATCH',
  'VALID_TO_MISMATCH',
  'PATH_MISMATCH',
] as const);

export type GraphReadMirrorDifferenceCode = (typeof GRAPH_READ_MIRROR_DIFFERENCE_CODES)[number];
export type GraphReadMirrorOperation = 'query' | 'explain';
export type GraphReadMirrorOutcome =
  | 'matched'
  | 'mismatched'
  | 'http_error'
  | 'transport_error'
  | 'response_invalid';

export interface GraphReadMirrorObservation {
  readonly schema: typeof GRAPH_READ_MIRROR_OBSERVATION_SCHEMA;
  readonly operation: GraphReadMirrorOperation;
  readonly outcome: GraphReadMirrorOutcome;
  readonly parity: 'matched' | 'mismatched' | 'not_compared';
  readonly authority: 'ts-local';
  readonly mirror: 'go';
  readonly endpoint: string;
  readonly attemptedAt: string;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly scenarioInstanceId: string;
  readonly requestFingerprint: string;
  readonly authorityDigest: string;
  readonly mirrorDigest?: string;
  readonly snapshotCursorHash?: string;
  readonly queryHash?: string;
  readonly differenceCodes?: readonly GraphReadMirrorDifferenceCode[];
  readonly httpStatus?: number;
  readonly code?: string;
}

export type GraphReadMirrorAuditSink = (
  observation: Readonly<GraphReadMirrorObservation>,
) => void | Promise<void>;
export type GraphReadMirrorAuditFailureSink = () => void;

export interface GraphReadMirrorPort {
  /** Observational only. Callers must return the TypeScript authority result regardless of outcome. */
  observeQuery(
    input: Readonly<GraphQueryInput>,
    authority: Readonly<GraphQueryResult>,
  ): Promise<GraphReadMirrorObservation>;
  /** Observational only. Callers must return the TypeScript authority result regardless of outcome. */
  observeExplain(
    input: Readonly<GraphExplainInput>,
    authority: Readonly<GraphExplanation>,
  ): Promise<GraphReadMirrorObservation>;
}

type GraphReadMirrorFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GraphReadMirrorHttpClientOptions {
  readonly origin: string;
  readonly networkMode?: GraphServiceNetworkMode;
  readonly timeoutMs?: number;
  readonly fetch?: GraphReadMirrorFetch;
  readonly auditSink?: GraphReadMirrorAuditSink;
  readonly auditFailureSink?: GraphReadMirrorAuditFailureSink;
  readonly now?: () => number;
}

interface PreparedRead {
  readonly operation: GraphReadMirrorOperation;
  readonly path: '/v1/graph:query' | '/v1/graph:explain';
  readonly body: string;
  readonly requestFingerprint: string;
}

interface ParsedResponse {
  readonly value: StrictJsonObject;
  readonly canonical: string;
}

type ObservationBase = Omit<
  GraphReadMirrorObservation,
  'outcome' | 'parity' | 'completedAt' | 'latencyMs'
>;
type ObservationDraft = Omit<GraphReadMirrorObservation, 'completedAt' | 'latencyMs'>;

const QUERY_FIELDS = Object.freeze([
  ['scenarioInstanceId', 'SCENARIO_INSTANCE_ID_MISMATCH'],
  ['snapshotCursor', 'SNAPSHOT_CURSOR_MISMATCH'],
  ['queryHash', 'QUERY_HASH_MISMATCH'],
  ['nodes', 'NODES_MISMATCH'],
  ['edges', 'EDGES_MISMATCH'],
  ['paths', 'PATHS_MISMATCH'],
  ['completeness', 'COMPLETENESS_MISMATCH'],
  ['truncation', 'TRUNCATION_MISMATCH'],
  ['nextCursor', 'CURSOR_TOKEN_MISMATCH'],
] as const satisfies readonly (readonly [string, GraphReadMirrorDifferenceCode])[]);

const EXPLAIN_FIELDS = Object.freeze([
  ['scenarioInstanceId', 'SCENARIO_INSTANCE_ID_MISMATCH'],
  ['targetKind', 'TARGET_KIND_MISMATCH'],
  ['targetId', 'TARGET_ID_MISMATCH'],
  ['authorityRef', 'AUTHORITY_REF_MISMATCH'],
  ['sourceEventIds', 'SOURCE_EVENT_IDS_MISMATCH'],
  ['evidenceRefs', 'EVIDENCE_REFS_MISMATCH'],
  ['projectorVersion', 'PROJECTOR_VERSION_MISMATCH'],
  ['validFrom', 'VALID_FROM_MISMATCH'],
  ['validTo', 'VALID_TO_MISMATCH'],
  ['completeness', 'COMPLETENESS_MISMATCH'],
  ['path', 'PATH_MISMATCH'],
  ['truncation', 'TRUNCATION_MISMATCH'],
] as const satisfies readonly (readonly [string, GraphReadMirrorDifferenceCode])[]);

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function prepareRead(
  operation: GraphReadMirrorOperation,
  input: Readonly<GraphQueryInput | GraphExplainInput>,
): PreparedRead {
  const path = operation === 'query' ? '/v1/graph:query' : '/v1/graph:explain';
  const body = canonicalJson(input);
  return Object.freeze({
    operation,
    path,
    body,
    requestFingerprint: sha256(`POST\n${path}\n${body}`),
  });
}

function memberEqual(
  authority: Readonly<Record<string, unknown>>,
  mirror: Readonly<Record<string, unknown>>,
  key: string,
): boolean {
  const authorityOwns = Object.hasOwn(authority, key);
  const mirrorOwns = Object.hasOwn(mirror, key);
  if (authorityOwns !== mirrorOwns) return false;
  if (!authorityOwns) return true;
  try {
    return canonicalJson(authority[key]) === canonicalJson(mirror[key]);
  } catch {
    return false;
  }
}

function compareResult(
  operation: GraphReadMirrorOperation,
  authority: Readonly<Record<string, unknown>>,
  mirror: Readonly<Record<string, unknown>>,
): GraphReadMirrorDifferenceCode[] {
  const fields = operation === 'query' ? QUERY_FIELDS : EXPLAIN_FIELDS;
  const expectedKeys: ReadonlySet<string> = new Set<string>(fields.map(([key]) => key));
  const differences: GraphReadMirrorDifferenceCode[] = [];
  if (Object.keys(mirror).some((key) => !expectedKeys.has(key))) {
    differences.push('RESULT_SCHEMA_MISMATCH');
  }
  for (const [key, code] of fields) {
    if (memberEqual(authority, mirror, key)) continue;
    if (key === 'nextCursor' && Object.hasOwn(authority, key) !== Object.hasOwn(mirror, key)) {
      differences.push('CURSOR_PRESENCE_MISMATCH');
    } else {
      differences.push(code);
    }
  }
  return differences.slice(0, GRAPH_READ_MIRROR_POLICY.maxDifferenceCodes);
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Classification is already fixed; cancellation is best effort.
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ kind: 'ok'; bytes: Uint8Array } | { kind: 'overflow' } | { kind: 'read_error' }> {
  const declaredLength = response.headers.get('Content-Length');
  if (declaredLength !== null && /^\d+$/u.test(declaredLength)) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > maxBytes) {
      await cancelResponseBody(response);
      return { kind: 'overflow' };
    }
  }
  if (!response.body) return { kind: 'ok', bytes: new Uint8Array() };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { kind: 'overflow' };
      }
      chunks.push(result.value);
    }
  } catch {
    return { kind: 'read_error' };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'ok', bytes };
}

function parseCanonicalResponse(bytes: Uint8Array): ParsedResponse | undefined {
  const buffer = Buffer.from(bytes);
  const content = buffer.at(-1) === 0x0a ? buffer.subarray(0, -1) : buffer;
  if (content.length === 0 || content.at(-1) === 0x0a || content.at(-1) === 0x0d) return undefined;
  try {
    const value = parseStrictGraphJson(content);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const canonical = canonicalJson(value);
    if (!content.equals(Buffer.from(canonical, 'utf8'))) return undefined;
    return { value: value as StrictJsonObject, canonical };
  } catch {
    return undefined;
  }
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
): Promise<{ kind: 'ok'; value: T } | { kind: 'timeout' } | { kind: 'error' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: 'timeout' });
      controller.abort();
    }, timeoutMs);
  });
  const settled = promise.then(
    (value) => ({ kind: 'ok' as const, value }),
    () => ({ kind: 'error' as const }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function prepareObservationBase(
  operation: GraphReadMirrorOperation,
  input: Readonly<GraphQueryInput | GraphExplainInput>,
  authority: Readonly<GraphQueryResult | GraphExplanation>,
  prepared: PreparedRead,
  endpoint: string,
  attemptedMs: number,
): ObservationBase {
  return {
    schema: GRAPH_READ_MIRROR_OBSERVATION_SCHEMA,
    operation,
    authority: 'ts-local',
    mirror: 'go',
    endpoint,
    attemptedAt: new Date(attemptedMs).toISOString(),
    scenarioInstanceId: input.scenarioInstanceId,
    requestFingerprint: prepared.requestFingerprint,
    authorityDigest: sha256(canonicalJson(authority)),
    ...(operation === 'query'
      ? {
          snapshotCursorHash: sha256((authority as GraphQueryResult).snapshotCursor),
          queryHash: (authority as GraphQueryResult).queryHash,
        }
      : {}),
  };
}

async function classifyMirrorResponse(
  operation: GraphReadMirrorOperation,
  input: Readonly<GraphQueryInput | GraphExplainInput>,
  authority: Readonly<GraphQueryResult | GraphExplanation>,
  response: Response,
  base: ObservationBase,
): Promise<ObservationDraft> {
  if (response.status !== 200) {
    await cancelResponseBody(response);
    return {
      ...base,
      outcome: 'http_error',
      parity: 'not_compared',
      httpStatus: response.status,
      code: 'GRAPH_READ_MIRROR_UNEXPECTED_STATUS',
    };
  }
  const contentType = response.headers.get('Content-Type');
  if (
    contentType === null ||
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())
  ) {
    await cancelResponseBody(response);
    return {
      ...base,
      outcome: 'response_invalid',
      parity: 'not_compared',
      httpStatus: response.status,
      code: 'GRAPH_READ_MIRROR_CONTENT_TYPE_INVALID',
    };
  }
  const requestedLimit =
    operation === 'query'
      ? ((input as GraphQueryInput).maxResponseBytes ?? GRAPH_READ_MIRROR_POLICY.maxResponseBytes)
      : GRAPH_READ_MIRROR_POLICY.maxResponseBytes;
  const body = await readBoundedBody(
    response,
    Math.min(requestedLimit, GRAPH_READ_MIRROR_POLICY.maxResponseBytes) + 1,
  );
  if (body.kind !== 'ok') {
    return {
      ...base,
      outcome: 'response_invalid',
      parity: 'not_compared',
      httpStatus: response.status,
      code:
        body.kind === 'overflow'
          ? 'GRAPH_READ_MIRROR_RESPONSE_TOO_LARGE'
          : 'GRAPH_READ_MIRROR_RESPONSE_READ_ERROR',
    };
  }
  const parsed = parseCanonicalResponse(body.bytes);
  if (!parsed) {
    return {
      ...base,
      outcome: 'response_invalid',
      parity: 'not_compared',
      httpStatus: response.status,
      code: 'GRAPH_READ_MIRROR_RESPONSE_INVALID',
    };
  }
  if (Buffer.byteLength(parsed.canonical, 'utf8') > requestedLimit) {
    return {
      ...base,
      outcome: 'response_invalid',
      parity: 'not_compared',
      httpStatus: response.status,
      code: 'GRAPH_READ_MIRROR_RESPONSE_TOO_LARGE',
    };
  }
  const differences = compareResult(
    operation,
    authority as unknown as Readonly<Record<string, unknown>>,
    parsed.value,
  );
  return {
    ...base,
    outcome: differences.length === 0 ? 'matched' : 'mismatched',
    parity: differences.length === 0 ? 'matched' : 'mismatched',
    httpStatus: response.status,
    mirrorDigest: sha256(parsed.canonical),
    ...(differences.length === 0 ? {} : { differenceCodes: differences }),
  };
}

async function executeMirrorRead(options: {
  readonly fetch: GraphReadMirrorFetch;
  readonly endpoint: string;
  readonly prepared: PreparedRead;
  readonly timeoutMs: number;
  readonly operation: GraphReadMirrorOperation;
  readonly input: Readonly<GraphQueryInput | GraphExplainInput>;
  readonly authority: Readonly<GraphQueryResult | GraphExplanation>;
  readonly base: ObservationBase;
}): Promise<ObservationDraft> {
  const controller = new AbortController();
  const result = await raceWithTimeout(
    Promise.resolve().then(async () => {
      const response = await options.fetch(options.endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: options.prepared.body,
        signal: controller.signal,
      });
      return classifyMirrorResponse(
        options.operation,
        options.input,
        options.authority,
        response,
        options.base,
      );
    }),
    controller,
    options.timeoutMs,
  );
  if (result.kind === 'timeout') {
    return {
      ...options.base,
      outcome: 'transport_error',
      parity: 'not_compared',
      code: 'GRAPH_READ_MIRROR_TIMEOUT',
    };
  }
  if (result.kind === 'error') {
    return {
      ...options.base,
      outcome: 'transport_error',
      parity: 'not_compared',
      code: 'GRAPH_READ_MIRROR_NETWORK_ERROR',
    };
  }
  return result.value;
}

function finalizeObservation(
  draft: ObservationDraft,
  attemptedMs: number,
  completedMs: number,
): GraphReadMirrorObservation {
  return Object.freeze({
    ...draft,
    ...(draft.differenceCodes === undefined
      ? {}
      : { differenceCodes: Object.freeze([...draft.differenceCodes]) }),
    completedAt: new Date(completedMs).toISOString(),
    latencyMs: Math.max(0, completedMs - attemptedMs),
  }) as GraphReadMirrorObservation;
}

/** Bounded observational HTTP client used only for TypeScript-authoritative differential reads. */
export class GraphReadMirrorHttpClient implements GraphReadMirrorPort {
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly fetch: GraphReadMirrorFetch;
  private readonly auditSink: GraphReadMirrorAuditSink | undefined;
  private readonly auditFailureSink: GraphReadMirrorAuditFailureSink | undefined;
  private readonly now: () => number;

  constructor(options: GraphReadMirrorHttpClientOptions) {
    const networkMode = options.networkMode ?? 'loopback';
    this.origin = normalizeGraphServiceOrigin(
      options.origin,
      networkMode,
      'Graph read mirror origin',
    );
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? GRAPH_READ_MIRROR_POLICY.defaultTimeoutMs,
      'Graph read mirror timeoutMs',
      GRAPH_READ_MIRROR_POLICY.maxTimeoutMs,
    );
    this.fetch = options.fetch ?? fetch;
    this.auditSink = options.auditSink;
    this.auditFailureSink = options.auditFailureSink;
    this.now = options.now ?? Date.now;
  }

  /** Mirrors one successful TypeScript graph query without becoming a read authority. */
  observeQuery(
    input: Readonly<GraphQueryInput>,
    authority: Readonly<GraphQueryResult>,
  ): Promise<GraphReadMirrorObservation> {
    return this.observe('query', input, authority);
  }

  /** Mirrors one successful TypeScript graph explanation without becoming a read authority. */
  observeExplain(
    input: Readonly<GraphExplainInput>,
    authority: Readonly<GraphExplanation>,
  ): Promise<GraphReadMirrorObservation> {
    return this.observe('explain', input, authority);
  }

  private async observe(
    operation: GraphReadMirrorOperation,
    input: Readonly<GraphQueryInput | GraphExplainInput>,
    authority: Readonly<GraphQueryResult | GraphExplanation>,
  ): Promise<GraphReadMirrorObservation> {
    const prepared = prepareRead(operation, input);
    const endpoint = `${this.origin}${prepared.path}`;
    const attemptedMs = this.safeNow();
    const base = prepareObservationBase(
      operation,
      input,
      authority,
      prepared,
      endpoint,
      attemptedMs,
    );
    const draft = await executeMirrorRead({
      fetch: this.fetch,
      endpoint,
      prepared,
      timeoutMs: this.timeoutMs,
      operation,
      input,
      authority,
      base,
    });
    const observation = finalizeObservation(draft, attemptedMs, this.safeNow(attemptedMs));
    this.audit(observation);
    return observation;
  }

  private audit(observation: GraphReadMirrorObservation): void {
    if (!this.auditSink) return;
    try {
      void Promise.resolve(this.auditSink(observation)).catch(() => this.reportAuditFailure());
    } catch {
      // Mirror audit failure cannot change the authoritative TypeScript result.
      this.reportAuditFailure();
    }
  }

  private reportAuditFailure(): void {
    try {
      this.auditFailureSink?.();
    } catch {
      // Diagnostics are also observational and cannot affect the authority result.
    }
  }

  private safeNow(floor = 0): number {
    let value: number;
    try {
      value = this.now();
    } catch {
      value = Date.now();
    }
    return Number.isFinite(value) ? Math.max(floor, value) : Math.max(floor, Date.now());
  }
}
