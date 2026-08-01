import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalJson } from './canonical.js';
import { assertGraphDeltaIntegrity, assertGraphSnapshotIntegrity } from './integrity.js';
import { normalizeGraphServiceOrigin } from './service-origin.js';
import { parseStrictGraphJson } from './strict-json.js';
import type { GraphDelta, GraphSnapshot } from './types.js';

export const GRAPH_SHADOW_RECEIPT_SCHEMA = 'openslack.graph_ingest_receipt.v1' as const;
export const GRAPH_SHADOW_OBSERVATION_SCHEMA = 'openslack.graph_shadow_observation.v2' as const;

export const GRAPH_SHADOW_POLICY = Object.freeze({
  maxRequestBytes: 64 * 1024 * 1024,
  defaultTimeoutMs: 2_000,
  maxTimeoutMs: 30_000,
  defaultReceiptBytes: 16 * 1024,
  maxReceiptBytes: 64 * 1024,
  maxQueuedPublicationsPerScenario: 4,
  orderingRetryAttempts: 64,
  defaultOrderingRetryDelayMs: 50,
  maxOrderingRetryDelayMs: 1_000,
} as const);

export type GraphShadowOperation = 'snapshot_ingest' | 'delta_ingest';
export type GraphShadowReceiptStatus = 'accepted' | 'duplicate' | 'reconciliation_required';

export interface GraphShadowReceipt {
  schema: typeof GRAPH_SHADOW_RECEIPT_SCHEMA;
  operation: GraphShadowOperation;
  status: GraphShadowReceiptStatus;
  idempotencyKey: string;
  requestFingerprint: string;
  scenarioInstanceId: string;
  cursor: string;
  revision: number;
  snapshotIntegrityHash: string;
  deltaIntegrityHash?: string;
  committedAt?: string;
  reconciliationToken?: string;
}

export interface GraphShadowPublishInput {
  expectedCursor: string | null;
  snapshot: GraphSnapshot;
  delta?: GraphDelta;
}

export type GraphShadowObservationOutcome =
  | 'accepted'
  | 'duplicate'
  | 'reconciliation_required'
  | 'conflict'
  | 'http_error'
  | 'transport_error'
  | 'response_invalid';

export interface GraphShadowObservation {
  schema: typeof GRAPH_SHADOW_OBSERVATION_SCHEMA;
  operation: GraphShadowOperation;
  outcome: GraphShadowObservationOutcome;
  endpoint: string;
  attemptedAt: string;
  completedAt: string;
  latencyMs: number;
  authority: 'ts-local';
  shadow: 'go';
  backlog: number | 'unknown';
  inFlight: number | 'unknown';
  parity: 'not_compared';
  scenarioInstanceId: string;
  cursor: string;
  snapshotIntegrityHash: string;
  idempotencyKey: string;
  requestFingerprint: string;
  httpStatus?: number;
  code?: string;
  receipt?: GraphShadowReceipt;
}

export interface GraphShadowQueueObservation {
  backlog: number;
  inFlight: number;
}

export type GraphShadowAuditSink = (
  observation: Readonly<GraphShadowObservation>,
) => void | Promise<void>;

export interface GraphShadowPublishPort {
  /**
   * Shadow publication is observational. Implementations must not grant graph
   * read or write authority, and callers must ignore failures.
   */
  publish(
    input: GraphShadowPublishInput,
    queue?: Readonly<GraphShadowQueueObservation>,
  ): Promise<GraphShadowObservation>;
}

type GraphShadowFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface GraphShadowHttpPublisherOptions {
  /** Exact HTTP origin; paths are fixed by the v1 ingest contract. */
  origin: string;
  /**
   * Both modes accept IP literals only. `internal` is an explicit opt-in for
   * private/link-local addresses. Neither mode resolves DNS or accepts a
   * wildcard/public address.
   */
  networkMode?: 'loopback' | 'internal';
  timeoutMs?: number;
  maxReceiptBytes?: number;
  /** Delay between bounded transition-order recovery attempts. */
  orderingRetryDelayMs?: number;
  fetch?: GraphShadowFetch;
  auditSink?: GraphShadowAuditSink;
  now?: () => number;
}

interface PreparedRequest {
  operation: GraphShadowOperation;
  path: '/v1/graph/snapshots:ingest' | '/v1/graph/deltas:ingest';
  body: string;
  idempotencyKey: string;
  requestFingerprint: string;
}

const RECEIPT_PARSE_LIMITS = Object.freeze({
  maxDepth: 4,
  maxNodes: 32,
  maxStringLength: 2_048,
});

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

function normalizeShadowOrigin(value: string, networkMode: 'loopback' | 'internal'): string {
  return normalizeGraphServiceOrigin(value, networkMode, 'Graph shadow origin');
}

function fingerprint(method: 'POST', path: string, body: string): string {
  const digest = createHash('sha256').update(`${method}\n${path}\n${body}`, 'utf8').digest('hex');
  return `sha256:${digest}`;
}

export function prepareGraphShadowRequest(input: GraphShadowPublishInput): PreparedRequest {
  const snapshot = assertGraphSnapshotIntegrity(input.snapshot);
  if (input.expectedCursor !== null && !isBoundedIdentifier(input.expectedCursor)) {
    throw new TypeError('Graph shadow expectedCursor must be null or a bounded identifier.');
  }
  const delta = input.delta === undefined ? undefined : assertGraphDeltaIntegrity(input.delta);
  if (
    delta !== undefined &&
    (input.expectedCursor === null ||
      delta.scenarioInstanceId !== snapshot.scenarioInstanceId ||
      delta.fromCursor !== input.expectedCursor ||
      delta.toCursor !== snapshot.cursor ||
      delta.generatedAt !== snapshot.generatedAt)
  ) {
    throw new TypeError('Graph shadow delta must bind the expected cursor and target snapshot.');
  }
  const operation: GraphShadowOperation = delta === undefined ? 'snapshot_ingest' : 'delta_ingest';
  const path =
    operation === 'snapshot_ingest' ? '/v1/graph/snapshots:ingest' : '/v1/graph/deltas:ingest';
  const envelope =
    operation === 'snapshot_ingest'
      ? {
          expectedCursor: input.expectedCursor,
          snapshot,
        }
      : {
          expectedCursor: input.expectedCursor,
          targetSnapshot: snapshot,
          delta: delta!,
        };
  const body = canonicalJson(envelope);
  if (Buffer.byteLength(body, 'utf8') > GRAPH_SHADOW_POLICY.maxRequestBytes) {
    throw new TypeError(
      `Graph shadow request exceeds ${GRAPH_SHADOW_POLICY.maxRequestBytes} bytes.`,
    );
  }
  const requestFingerprint = fingerprint('POST', path, body);
  return {
    operation,
    path,
    body,
    requestFingerprint,
    idempotencyKey: `openslack.graph-shadow.v1.${requestFingerprint.slice('sha256:'.length)}`,
  };
}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isBoundedIdentifier(value: unknown, maximum = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isIntegrityHash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function isRfc3339(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(
      value,
    );
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return (
    month >= 1 &&
    month <= 12 &&
    daysInMonth !== undefined &&
    day >= 1 &&
    day <= daysInMonth &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

export function parseGraphShadowReceipt(
  bytes: Uint8Array,
  operation: GraphShadowOperation,
): GraphShadowReceipt | null {
  let parsed: unknown;
  try {
    parsed = parseStrictGraphJson(Buffer.from(bytes), RECEIPT_PARSE_LIMITS);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const status = record.status;
  if (
    record.schema !== GRAPH_SHADOW_RECEIPT_SCHEMA ||
    record.operation !== operation ||
    (status !== 'accepted' && status !== 'duplicate' && status !== 'reconciliation_required')
  ) {
    return null;
  }

  const expectedKeys = [
    'schema',
    'operation',
    'status',
    'idempotencyKey',
    'requestFingerprint',
    'scenarioInstanceId',
    'cursor',
    'revision',
    'snapshotIntegrityHash',
    ...(operation === 'delta_ingest' ? ['deltaIntegrityHash'] : []),
    ...(status === 'reconciliation_required' ? ['reconciliationToken'] : ['committedAt']),
  ];
  if (
    !exactKeys(record, expectedKeys) ||
    !isIdempotencyKey(record.idempotencyKey) ||
    !isIntegrityHash(record.requestFingerprint) ||
    !isBoundedIdentifier(record.scenarioInstanceId) ||
    !isBoundedIdentifier(record.cursor) ||
    !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 1 ||
    !isIntegrityHash(record.snapshotIntegrityHash) ||
    (operation === 'delta_ingest' && !isIntegrityHash(record.deltaIntegrityHash)) ||
    (status === 'reconciliation_required'
      ? !isBoundedIdentifier(record.reconciliationToken, 2_048)
      : !isRfc3339(record.committedAt))
  ) {
    return null;
  }

  return {
    schema: GRAPH_SHADOW_RECEIPT_SCHEMA,
    operation,
    status,
    idempotencyKey: record.idempotencyKey,
    requestFingerprint: record.requestFingerprint,
    scenarioInstanceId: record.scenarioInstanceId,
    cursor: record.cursor,
    revision: record.revision as number,
    snapshotIntegrityHash: record.snapshotIntegrityHash,
    ...(operation === 'delta_ingest'
      ? { deltaIntegrityHash: record.deltaIntegrityHash as string }
      : {}),
    ...(status === 'reconciliation_required'
      ? { reconciliationToken: record.reconciliationToken as string }
      : { committedAt: record.committedAt as string }),
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Observation classification is already fixed; cancellation is best effort.
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

function baseObservation(
  input: GraphShadowPublishInput,
  request: PreparedRequest,
  endpoint: string,
  attemptedAt: string,
  queue?: Readonly<GraphShadowQueueObservation>,
): Omit<GraphShadowObservation, 'outcome' | 'completedAt' | 'latencyMs'> {
  const normalizedQueue = normalizeQueueObservation(queue);
  return {
    schema: GRAPH_SHADOW_OBSERVATION_SCHEMA,
    operation: request.operation,
    endpoint,
    attemptedAt,
    authority: 'ts-local',
    shadow: 'go',
    backlog: normalizedQueue?.backlog ?? 'unknown',
    inFlight: normalizedQueue?.inFlight ?? 'unknown',
    parity: 'not_compared',
    scenarioInstanceId: input.snapshot.scenarioInstanceId,
    cursor: input.snapshot.cursor,
    snapshotIntegrityHash: input.snapshot.integrityHash,
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: request.requestFingerprint,
  };
}

function normalizeQueueObservation(value: unknown): GraphShadowQueueObservation | undefined {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      nodeTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const backlog = descriptors.backlog;
    const inFlight = descriptors.inFlight;
    if (
      backlog === undefined ||
      inFlight === undefined ||
      !Object.hasOwn(backlog, 'value') ||
      !Object.hasOwn(inFlight, 'value') ||
      !Number.isSafeInteger(backlog.value) ||
      backlog.value < 0 ||
      backlog.value > GRAPH_SHADOW_POLICY.maxQueuedPublicationsPerScenario ||
      inFlight.value !== 1
    ) {
      return undefined;
    }
    return { backlog: backlog.value as number, inFlight: 1 };
  } catch {
    return undefined;
  }
}

function receiptMatchesRequest(
  receipt: GraphShadowReceipt,
  input: GraphShadowPublishInput,
  request: PreparedRequest,
): boolean {
  return (
    receipt.operation === request.operation &&
    receipt.idempotencyKey === request.idempotencyKey &&
    receipt.requestFingerprint === request.requestFingerprint &&
    receipt.scenarioInstanceId === input.snapshot.scenarioInstanceId &&
    receipt.cursor === input.snapshot.cursor &&
    receipt.snapshotIntegrityHash === input.snapshot.integrityHash &&
    (input.delta === undefined || receipt.deltaIntegrityHash === input.delta.integrityHash)
  );
}

function expectedHttpStatus(receipt: GraphShadowReceipt): number {
  if (receipt.status === 'accepted') return 201;
  if (receipt.status === 'duplicate') return 200;
  return 202;
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

async function waitForOrderingRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    const timer = setTimeout(finish, delayMs);
    if (signal.aborted) {
      finish();
    }
  });
}

export class GraphShadowHttpPublisher implements GraphShadowPublishPort {
  private readonly origin: string;
  private readonly timeoutMs: number;
  private readonly maxReceiptBytes: number;
  private readonly orderingRetryDelayMs: number;
  private readonly fetch: GraphShadowFetch;
  private readonly auditSink: GraphShadowAuditSink | undefined;
  private readonly now: () => number;

  constructor(options: GraphShadowHttpPublisherOptions) {
    const networkMode = options.networkMode ?? 'loopback';
    if (networkMode !== 'loopback' && networkMode !== 'internal') {
      throw new TypeError('Graph shadow networkMode must be loopback or internal.');
    }
    this.origin = normalizeShadowOrigin(options.origin, networkMode);
    this.timeoutMs = positiveInteger(
      options.timeoutMs ?? GRAPH_SHADOW_POLICY.defaultTimeoutMs,
      'Graph shadow timeoutMs',
      GRAPH_SHADOW_POLICY.maxTimeoutMs,
    );
    this.maxReceiptBytes = positiveInteger(
      options.maxReceiptBytes ?? GRAPH_SHADOW_POLICY.defaultReceiptBytes,
      'Graph shadow maxReceiptBytes',
      GRAPH_SHADOW_POLICY.maxReceiptBytes,
    );
    this.orderingRetryDelayMs = positiveInteger(
      options.orderingRetryDelayMs ?? GRAPH_SHADOW_POLICY.defaultOrderingRetryDelayMs,
      'Graph shadow orderingRetryDelayMs',
      GRAPH_SHADOW_POLICY.maxOrderingRetryDelayMs,
    );
    this.fetch = options.fetch ?? fetch;
    this.auditSink = options.auditSink;
    this.now = options.now ?? Date.now;
  }

  async publish(
    input: GraphShadowPublishInput,
    queue?: Readonly<GraphShadowQueueObservation>,
  ): Promise<GraphShadowObservation> {
    const request = prepareGraphShadowRequest(input);
    const endpoint = `${this.origin}${request.path}`;
    const attemptedMs = this.safeNow();
    const base = baseObservation(
      input,
      request,
      endpoint,
      new Date(attemptedMs).toISOString(),
      queue,
    );
    const controller = new AbortController();
    const result = await raceWithTimeout(
      Promise.resolve().then(() =>
        this.deliverWithOrderingRetry(input, request, endpoint, base, controller.signal),
      ),
      controller,
      this.timeoutMs,
    );

    let draft: Omit<GraphShadowObservation, 'completedAt' | 'latencyMs'>;
    if (result.kind === 'timeout') {
      draft = { ...base, outcome: 'transport_error', code: 'SHADOW_TIMEOUT' };
    } else if (result.kind === 'error') {
      draft = { ...base, outcome: 'transport_error', code: 'SHADOW_NETWORK_ERROR' };
    } else {
      draft = result.value;
    }
    const completedMs = this.safeNow(attemptedMs);
    const observation: GraphShadowObservation = {
      ...draft,
      completedAt: new Date(completedMs).toISOString(),
      latencyMs: Math.max(0, completedMs - attemptedMs),
    };
    this.audit(observation);
    return observation;
  }

  private async deliverWithOrderingRetry(
    input: GraphShadowPublishInput,
    request: PreparedRequest,
    endpoint: string,
    base: Omit<GraphShadowObservation, 'outcome' | 'completedAt' | 'latencyMs'>,
    signal: AbortSignal,
  ): Promise<Omit<GraphShadowObservation, 'completedAt' | 'latencyMs'>> {
    for (let attempt = 1; attempt <= GRAPH_SHADOW_POLICY.orderingRetryAttempts; attempt += 1) {
      const response = await this.fetch(endpoint, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': request.idempotencyKey,
        },
        body: request.body,
        signal,
      });
      const orderingRace =
        input.expectedCursor !== null && (response.status === 404 || response.status === 409);
      if (orderingRace && attempt < GRAPH_SHADOW_POLICY.orderingRetryAttempts) {
        await cancelResponseBody(response);
        await waitForOrderingRetry(this.orderingRetryDelayMs, signal);
        if (signal.aborted) throw new Error('graph shadow ordering retry aborted');
        continue;
      }
      return this.classifyResponse(input, request, response, base);
    }
    throw new Error('graph shadow ordering retry exhausted unexpectedly');
  }

  private async classifyResponse(
    input: GraphShadowPublishInput,
    request: PreparedRequest,
    response: Response,
    base: Omit<GraphShadowObservation, 'outcome' | 'completedAt' | 'latencyMs'>,
  ): Promise<Omit<GraphShadowObservation, 'completedAt' | 'latencyMs'>> {
    if (response.status === 409 || (input.expectedCursor !== null && response.status === 404)) {
      await cancelResponseBody(response);
      return {
        ...base,
        outcome: 'conflict',
        httpStatus: response.status,
        code: response.status === 409 ? 'SHADOW_CONFLICT' : 'SHADOW_PARENT_NOT_FOUND',
      };
    }
    if (![200, 201, 202].includes(response.status)) {
      await cancelResponseBody(response);
      return {
        ...base,
        outcome: 'http_error',
        httpStatus: response.status,
        code: 'SHADOW_UNEXPECTED_STATUS',
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
        httpStatus: response.status,
        code: 'SHADOW_RECEIPT_CONTENT_TYPE_INVALID',
      };
    }

    const body = await readBoundedBody(response, this.maxReceiptBytes);
    if (body.kind !== 'ok') {
      return {
        ...base,
        outcome: 'response_invalid',
        httpStatus: response.status,
        code: body.kind === 'overflow' ? 'SHADOW_RECEIPT_TOO_LARGE' : 'SHADOW_RECEIPT_READ_ERROR',
      };
    }
    const receipt = parseGraphShadowReceipt(body.bytes, request.operation);
    if (!receipt) {
      return {
        ...base,
        outcome: 'response_invalid',
        httpStatus: response.status,
        code: 'SHADOW_RECEIPT_INVALID',
      };
    }
    if (response.status !== expectedHttpStatus(receipt)) {
      return {
        ...base,
        outcome: 'response_invalid',
        httpStatus: response.status,
        code: 'SHADOW_RECEIPT_STATUS_MISMATCH',
        receipt,
      };
    }
    if (!receiptMatchesRequest(receipt, input, request)) {
      return {
        ...base,
        outcome: 'response_invalid',
        httpStatus: response.status,
        code: 'SHADOW_RECEIPT_BINDING_MISMATCH',
        receipt,
      };
    }
    return {
      ...base,
      outcome: receipt.status,
      httpStatus: response.status,
      receipt,
    };
  }

  private audit(observation: GraphShadowObservation): void {
    if (!this.auditSink) return;
    try {
      const receipt =
        observation.receipt === undefined ? undefined : Object.freeze({ ...observation.receipt });
      const frozen = Object.freeze({
        ...observation,
        ...(receipt === undefined ? {} : { receipt }),
      });
      void Promise.resolve(this.auditSink(frozen)).catch(() => undefined);
    } catch {
      // Shadow audit failure cannot change the authoritative TypeScript result.
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
