import { parseSecretReference, type CredentialStore } from '@openslack/credentials';
import { isNotificationDeploymentDigest } from './notification-handoff-contracts.js';
import { normalizeNotificationServiceOrigin } from './notification-service-endpoint.js';

const MAX_OPS_RESPONSE_BYTES = 64 * 1024;
const MAX_ATTEMPT_PAGES = 100;

type NotificationServiceFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type NotificationRemoteState = 'pending' | 'in_flight' | 'delivered' | 'dead';

export interface NotificationServiceStatus {
  notificationId: string;
  vendorId: string;
  state: NotificationRemoteState;
  version: number;
  attemptCount: number;
  deliveryCycleStartedAt: string;
  replayCount: number;
  createdAt: string;
  lastOutcomeClass?: 'success' | 'retryable_failure' | 'permanent_failure';
  lastErrorCode?: string;
  deliveredAt?: string;
  deadAt?: string;
  replayedAt?: string;
}

export interface NotificationServiceAttempt {
  attemptSeq: number;
  eventKind: 'claimed' | 'outcome' | 'recovery' | 'replay';
  configVersion?: number;
  resultKind?: 'http_response' | 'transport_failure' | 'unknown_result' | 'policy_termination';
  outcomeClass?: 'success' | 'retryable_failure' | 'permanent_failure';
  httpStatus?: number;
  errorCode?: string;
  reason?: string;
  recordedAt: string;
}

export type NotificationOpsResult<T> =
  | { kind: 'ok'; requestId: string; data: T }
  | { kind: 'not_found'; code: 'NOT_FOUND' }
  | { kind: 'denied'; code: 'UNAUTHENTICATED' | 'FORBIDDEN' }
  | { kind: 'retryable'; code: 'CREDENTIAL_UNAVAILABLE' | 'NETWORK_ERROR' | 'SERVICE_UNAVAILABLE' }
  | { kind: 'protocol_error'; code: string; status?: number };

export type NotificationServiceVersionResult =
  | { kind: 'ok'; ready: true; deploymentDigest: `sha256:${string}` }
  | { kind: 'not_ready'; deploymentDigest: `sha256:${string}` }
  | { kind: 'retryable'; code: 'NETWORK_ERROR' | 'SERVICE_UNAVAILABLE' }
  | { kind: 'protocol_error'; code: string; status?: number };

export interface NotificationServiceOpsClientOptions {
  endpoint: string;
  credentialRef: string;
  expectedDeploymentDigest: `sha256:${string}`;
  credentialStore: Pick<CredentialStore, 'withSecret'>;
  allowInsecureLoopback?: boolean;
  fetch?: NotificationServiceFetch;
}

/**
 * Read-only service client used by reconciliation. It cannot submit or replay
 * notifications and never returns credentials or raw response bodies.
 */
export class NotificationServiceOpsClient {
  private readonly origin: string;
  private readonly credentialRef: string;
  private readonly expectedDeploymentDigest: `sha256:${string}`;
  private readonly credentialStore: Pick<CredentialStore, 'withSecret'>;
  private readonly fetch: NotificationServiceFetch;

  constructor(options: NotificationServiceOpsClientOptions) {
    this.origin = normalizeNotificationServiceOrigin(options.endpoint, {
      allowInsecureLoopback: options.allowInsecureLoopback,
    });
    this.credentialRef = parseSecretReference(options.credentialRef).canonical;
    if (!isNotificationDeploymentDigest(options.expectedDeploymentDigest)) {
      throw new TypeError('Expected deployment digest must be sha256:<64 lowercase hex>.');
    }
    this.expectedDeploymentDigest = options.expectedDeploymentDigest;
    this.credentialStore = options.credentialStore;
    this.fetch = options.fetch ?? fetch;
  }

  async version(signal?: AbortSignal): Promise<NotificationServiceVersionResult> {
    let response: Response;
    try {
      response = await this.fetch(`${this.origin}/health/version`, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'application/json' },
        signal,
      });
    } catch {
      return { kind: 'retryable', code: 'NETWORK_ERROR' };
    }
    if (response.status !== 200 && response.status !== 503) {
      await cancelBody(response);
      if (response.status >= 500) return { kind: 'retryable', code: 'SERVICE_UNAVAILABLE' };
      return { kind: 'protocol_error', code: 'VERSION_STATUS_INVALID', status: response.status };
    }
    const parsed = await readStrictJson(response, MAX_OPS_RESPONSE_BYTES);
    if (
      !hasExactKeys(parsed, ['ready', 'deployment_digest']) ||
      typeof parsed.ready !== 'boolean' ||
      !isNotificationDeploymentDigest(parsed.deployment_digest)
    ) {
      return { kind: 'protocol_error', code: 'VERSION_RESPONSE_INVALID', status: response.status };
    }
    if (parsed.deployment_digest !== this.expectedDeploymentDigest) {
      return {
        kind: 'protocol_error',
        code: 'DEPLOYMENT_DIGEST_MISMATCH',
        status: response.status,
      };
    }
    if ((response.status === 200 && !parsed.ready) || (response.status === 503 && parsed.ready)) {
      return {
        kind: 'protocol_error',
        code: 'VERSION_READINESS_STATUS_MISMATCH',
        status: response.status,
      };
    }
    if (response.status === 503 || !parsed.ready) {
      return { kind: 'not_ready', deploymentDigest: parsed.deployment_digest };
    }
    return { kind: 'ok', ready: true, deploymentDigest: parsed.deployment_digest };
  }

  async notification(
    notificationId: string,
    signal?: AbortSignal,
  ): Promise<NotificationOpsResult<NotificationServiceStatus>> {
    if (!isSafeId(notificationId)) {
      return { kind: 'protocol_error', code: 'NOTIFICATION_ID_INVALID' };
    }
    const result = await this.get(
      `/v1/ops/notifications/${encodeURIComponent(notificationId)}`,
      signal,
    );
    if (result.kind !== 'ok') return result;
    const data = parseNotificationStatus(result.data);
    if (!data) {
      return { kind: 'protocol_error', code: 'NOTIFICATION_STATUS_INVALID', status: 200 };
    }
    return { kind: 'ok', requestId: result.requestId, data };
  }

  async attempts(
    notificationId: string,
    signal?: AbortSignal,
  ): Promise<NotificationOpsResult<NotificationServiceAttempt[]>> {
    if (!isSafeId(notificationId)) {
      return { kind: 'protocol_error', code: 'NOTIFICATION_ID_INVALID' };
    }
    const items: NotificationServiceAttempt[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let requestId = '';
    for (let page = 0; page < MAX_ATTEMPT_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const result = await this.get(
        `/v1/ops/notifications/${encodeURIComponent(notificationId)}/attempts?${query.toString()}`,
        signal,
      );
      if (result.kind !== 'ok') return result;
      requestId = result.requestId;
      const parsed = parseAttemptPage(result.data);
      if (!parsed) {
        return { kind: 'protocol_error', code: 'ATTEMPT_PAGE_INVALID', status: 200 };
      }
      items.push(...parsed.items);
      if (!parsed.nextCursor) return { kind: 'ok', requestId, data: items };
      if (cursors.has(parsed.nextCursor)) {
        return { kind: 'protocol_error', code: 'ATTEMPT_CURSOR_LOOP', status: 200 };
      }
      cursors.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }
    return { kind: 'protocol_error', code: 'ATTEMPT_PAGE_LIMIT', status: 200 };
  }

  private async get(path: string, signal?: AbortSignal): Promise<NotificationOpsResult<unknown>> {
    let responsePromise: Promise<Response>;
    try {
      responsePromise = this.credentialStore.withSecret(this.credentialRef, (secret) => {
        if (typeof secret !== 'string' || secret.length === 0) {
          throw new Error('Credential unavailable.');
        }
        return this.fetch(`${this.origin}${path}`, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${secret}`,
          },
          signal,
        });
      });
    } catch {
      return { kind: 'retryable', code: 'CREDENTIAL_UNAVAILABLE' };
    }
    let response: Response;
    try {
      response = await responsePromise;
    } catch {
      return { kind: 'retryable', code: 'NETWORK_ERROR' };
    }
    if (response.status !== 200) {
      await cancelBody(response);
      if (response.status === 401) return { kind: 'denied', code: 'UNAUTHENTICATED' };
      if (response.status === 403) return { kind: 'denied', code: 'FORBIDDEN' };
      if (response.status === 404) return { kind: 'not_found', code: 'NOT_FOUND' };
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        return { kind: 'retryable', code: 'SERVICE_UNAVAILABLE' };
      }
      return { kind: 'protocol_error', code: 'OPS_STATUS_INVALID', status: response.status };
    }
    const parsed = await readStrictJson(response, MAX_OPS_RESPONSE_BYTES);
    if (!hasExactKeys(parsed, ['request_id', 'data']) || !isSafeId(parsed.request_id)) {
      return { kind: 'protocol_error', code: 'OPS_ENVELOPE_INVALID', status: 200 };
    }
    return { kind: 'ok', requestId: parsed.request_id, data: parsed.data };
  }
}

function parseNotificationStatus(value: unknown): NotificationServiceStatus | null {
  if (
    !hasOnlyKeys(value, [
      'notification_id',
      'vendor_id',
      'state',
      'version',
      'attempt_count',
      'delivery_cycle_started_at',
      'replay_count',
      'last_outcome_class',
      'last_error_code',
      'created_at',
      'delivered_at',
      'dead_at',
      'replayed_at',
    ]) ||
    !hasKeys(value, [
      'notification_id',
      'vendor_id',
      'state',
      'version',
      'attempt_count',
      'delivery_cycle_started_at',
      'replay_count',
      'created_at',
    ]) ||
    !isSafeId(value.notification_id) ||
    !isSafeId(value.vendor_id) ||
    !['pending', 'in_flight', 'delivered', 'dead'].includes(String(value.state)) ||
    !isPositiveInteger(value.version) ||
    !isNonNegativeInteger(value.attempt_count) ||
    !isTimestamp(value.delivery_cycle_started_at) ||
    !isNonNegativeInteger(value.replay_count) ||
    !isTimestamp(value.created_at) ||
    !optionalEnum(value.last_outcome_class, [
      'success',
      'retryable_failure',
      'permanent_failure',
    ]) ||
    !optionalBoundedString(value.last_error_code, 128) ||
    !optionalTimestamp(value.delivered_at) ||
    !optionalTimestamp(value.dead_at) ||
    !optionalTimestamp(value.replayed_at)
  ) {
    return null;
  }
  if (
    (value.state === 'delivered' && value.delivered_at === undefined) ||
    (value.state === 'dead' && value.dead_at === undefined) ||
    ((value.state === 'pending' || value.state === 'in_flight') &&
      (value.delivered_at !== undefined || value.dead_at !== undefined))
  ) {
    return null;
  }
  return {
    notificationId: value.notification_id,
    vendorId: value.vendor_id,
    state: value.state as NotificationRemoteState,
    version: value.version,
    attemptCount: value.attempt_count,
    deliveryCycleStartedAt: value.delivery_cycle_started_at,
    replayCount: value.replay_count,
    createdAt: value.created_at,
    ...(value.last_outcome_class === undefined
      ? {}
      : {
          lastOutcomeClass:
            value.last_outcome_class as NotificationServiceStatus['lastOutcomeClass'],
        }),
    ...(value.last_error_code === undefined ? {} : { lastErrorCode: value.last_error_code }),
    ...(value.delivered_at === undefined ? {} : { deliveredAt: value.delivered_at }),
    ...(value.dead_at === undefined ? {} : { deadAt: value.dead_at }),
    ...(value.replayed_at === undefined ? {} : { replayedAt: value.replayed_at }),
  };
}

function parseAttemptPage(
  value: unknown,
): { items: NotificationServiceAttempt[]; nextCursor?: string } | null {
  if (
    !hasOnlyKeys(value, ['items', 'next_cursor']) ||
    !hasKeys(value, ['items']) ||
    !Array.isArray(value.items) ||
    !optionalBoundedString(value.next_cursor, 4096)
  ) {
    return null;
  }
  const items: NotificationServiceAttempt[] = [];
  for (const item of value.items) {
    const parsed = parseAttempt(item);
    if (!parsed) return null;
    items.push(parsed);
  }
  return {
    items,
    ...(value.next_cursor === undefined ? {} : { nextCursor: value.next_cursor }),
  };
}

function parseAttempt(value: unknown): NotificationServiceAttempt | null {
  if (
    !hasOnlyKeys(value, [
      'attempt_seq',
      'event_kind',
      'config_version',
      'result_kind',
      'outcome_class',
      'http_status',
      'error_code',
      'reason',
      'recorded_at',
    ]) ||
    !hasKeys(value, ['attempt_seq', 'event_kind', 'recorded_at']) ||
    !isPositiveInteger(value.attempt_seq) ||
    !['claimed', 'outcome', 'recovery', 'replay'].includes(String(value.event_kind)) ||
    !(value.config_version === undefined || isPositiveInteger(value.config_version)) ||
    !optionalEnum(value.result_kind, [
      'http_response',
      'transport_failure',
      'unknown_result',
      'policy_termination',
    ]) ||
    !optionalEnum(value.outcome_class, ['success', 'retryable_failure', 'permanent_failure']) ||
    !(value.http_status === undefined || isHttpStatus(value.http_status)) ||
    !optionalBoundedString(value.error_code, 128) ||
    !optionalBoundedString(value.reason, 128) ||
    !isTimestamp(value.recorded_at)
  ) {
    return null;
  }
  return {
    attemptSeq: value.attempt_seq,
    eventKind: value.event_kind as NotificationServiceAttempt['eventKind'],
    recordedAt: value.recorded_at,
    ...(value.config_version === undefined ? {} : { configVersion: value.config_version }),
    ...(value.result_kind === undefined
      ? {}
      : { resultKind: value.result_kind as NotificationServiceAttempt['resultKind'] }),
    ...(value.outcome_class === undefined
      ? {}
      : { outcomeClass: value.outcome_class as NotificationServiceAttempt['outcomeClass'] }),
    ...(value.http_status === undefined ? {} : { httpStatus: value.http_status }),
    ...(value.error_code === undefined ? {} : { errorCode: value.error_code }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

async function readStrictJson(response: Response, maxBytes: number): Promise<unknown | null> {
  if (!response.body) return null;
  const declared = response.headers.get('Content-Length');
  if (declared && /^\d+$/u.test(declared) && Number(declared) > maxBytes) {
    await cancelBody(response);
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    new JsonKeyScanner(text).scan();
    return parsed;
  } catch {
    return null;
  }
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Status classification remains authoritative.
  }
}

class JsonKeyScanner {
  private cursor = 0;

  constructor(private readonly text: string) {}

  scan(): void {
    this.whitespace();
    this.value();
    this.whitespace();
    if (this.cursor !== this.text.length) throw new SyntaxError('Unexpected trailing JSON.');
  }

  private value(): void {
    this.whitespace();
    const token = this.text[this.cursor];
    if (token === '{') return this.object();
    if (token === '[') return this.array();
    if (token === '"') {
      this.string();
      return;
    }
    const primitive = this.text
      .slice(this.cursor)
      .match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u)?.[0];
    if (!primitive) throw new SyntaxError('Invalid JSON token.');
    this.cursor += primitive.length;
  }

  private object(): void {
    this.cursor += 1;
    this.whitespace();
    if (this.text[this.cursor] === '}') {
      this.cursor += 1;
      return;
    }
    const keys = new Set<string>();
    while (true) {
      this.whitespace();
      const key = this.string();
      if (keys.has(key)) throw new SyntaxError('Duplicate JSON member.');
      keys.add(key);
      this.whitespace();
      if (this.text[this.cursor] !== ':') throw new SyntaxError('Missing JSON colon.');
      this.cursor += 1;
      this.value();
      this.whitespace();
      if (this.text[this.cursor] === '}') {
        this.cursor += 1;
        return;
      }
      if (this.text[this.cursor] !== ',') throw new SyntaxError('Missing JSON comma.');
      this.cursor += 1;
    }
  }

  private array(): void {
    this.cursor += 1;
    this.whitespace();
    if (this.text[this.cursor] === ']') {
      this.cursor += 1;
      return;
    }
    while (true) {
      this.value();
      this.whitespace();
      if (this.text[this.cursor] === ']') {
        this.cursor += 1;
        return;
      }
      if (this.text[this.cursor] !== ',') throw new SyntaxError('Missing JSON comma.');
      this.cursor += 1;
    }
  }

  private string(): string {
    if (this.text[this.cursor] !== '"') throw new SyntaxError('Expected JSON string.');
    const start = this.cursor;
    this.cursor += 1;
    while (this.cursor < this.text.length) {
      const token = this.text[this.cursor];
      if (token === '\\') {
        this.cursor += 2;
        continue;
      }
      this.cursor += 1;
      if (token === '"') return JSON.parse(this.text.slice(start, this.cursor)) as string;
    }
    throw new SyntaxError('Unterminated JSON string.');
  }

  private whitespace(): void {
    while (/[\t\n\r ]/u.test(this.text[this.cursor] ?? '')) this.cursor += 1;
  }
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
}

function hasKeys<T extends string>(
  value: Record<string, unknown>,
  keys: readonly T[],
): value is Record<T, unknown> & Record<string, unknown> {
  return keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSafeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionalEnum(value: unknown, allowed: readonly string[]): boolean {
  return value === undefined || (typeof value === 'string' && allowed.includes(value));
}

function optionalBoundedString(value: unknown, maxLength: number): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === 'string' && value.length >= 1 && value.length <= maxLength)
  );
}

function optionalTimestamp(value: unknown): value is string | undefined {
  return value === undefined || isTimestamp(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
