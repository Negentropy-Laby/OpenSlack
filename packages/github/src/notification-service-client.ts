import { parseSecretReference, type CredentialStore } from '@openslack/credentials';
import {
  isNotificationDeploymentDigest,
  isNotificationHandoffIdempotencyKey,
  isNotificationHandoffVendorId,
  NOTIFICATION_HANDOFF_POLICY,
  type AcceptedReceipt,
  type HandoffResult,
} from './notification-handoff-contracts.js';
import { normalizeNotificationServiceOrigin } from './notification-service-endpoint.js';

export const NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST_HEADER =
  'X-Notification-Service-Deployment-Digest';

type NotificationServiceFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface NotificationServiceClientOptions {
  endpoint: string;
  credentialRef: string;
  expectedDeploymentDigest: `sha256:${string}`;
  credentialStore: Pick<CredentialStore, 'withSecret'>;
  allowInsecureLoopback?: boolean;
  fetch?: NotificationServiceFetch;
  now?: () => number;
}

export interface NotificationServiceHandoffRequest {
  vendorId: string;
  idempotencyKey: string;
  payloadBytes: Uint8Array;
  signal?: AbortSignal;
}

/**
 * Dedicated handoff client. This deliberately does not implement NotificationSink:
 * a valid 202 means durable service acceptance, not vendor delivery.
 */
export class NotificationServiceClient {
  private readonly intakeUrl: string;
  private readonly credentialRef: string;
  private readonly expectedDeploymentDigest: `sha256:${string}`;
  private readonly credentialStore: Pick<CredentialStore, 'withSecret'>;
  private readonly fetch: NotificationServiceFetch;
  private readonly now: () => number;

  constructor(options: NotificationServiceClientOptions) {
    const origin = normalizeNotificationServiceOrigin(options.endpoint, {
      allowInsecureLoopback: options.allowInsecureLoopback,
    });
    this.intakeUrl = `${origin}/v1/notifications`;
    this.credentialRef = parseSecretReference(options.credentialRef).canonical;
    if (!isNotificationDeploymentDigest(options.expectedDeploymentDigest)) {
      throw new TypeError('Expected deployment digest must be sha256:<64 lowercase hex>.');
    }
    this.expectedDeploymentDigest = options.expectedDeploymentDigest;
    this.credentialStore = options.credentialStore;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async handoff(request: NotificationServiceHandoffRequest): Promise<HandoffResult> {
    if (!isValidHandoffRequest(request)) {
      return permanentProtocolError('HANDOFF_REQUEST_INVALID');
    }

    const requestBody = JSON.stringify({
      vendor_id: request.vendorId,
      payload_base64: Buffer.from(request.payloadBytes).toString('base64'),
    });

    let responsePromise: Promise<Response>;
    try {
      responsePromise = this.credentialStore.withSecret(this.credentialRef, (secret) => {
        if (typeof secret !== 'string' || secret.length === 0) {
          throw new Error('Credential is unavailable.');
        }
        return this.fetch(this.intakeUrl, {
          method: 'POST',
          redirect: 'manual',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${secret}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': request.idempotencyKey,
          },
          body: requestBody,
          signal: request.signal,
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

    if (response.status === 202) {
      return this.parseAcceptedResponse(response);
    }

    void cancelResponseBody(response);
    const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'), this.now());
    if (response.status >= 200 && response.status < 300) {
      return permanentProtocolError('UNEXPECTED_SUCCESS_STATUS', response.status);
    }
    if (response.status >= 300 && response.status < 400) {
      return { kind: 'rejected', code: 'PROTOCOL_REDIRECT', status: response.status };
    }
    if (response.status === 409) {
      return { kind: 'conflict', code: 'IDEMPOTENCY_CONFLICT', status: 409 };
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return {
        kind: 'retryable',
        code: retryableStatusCode(response.status),
        status: response.status,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    }
    if (response.status >= 400 && response.status < 500) {
      return {
        kind: 'rejected',
        code: deterministicRejectionCode(response.status),
        status: response.status,
      };
    }
    return { kind: 'retryable', code: 'NETWORK_ERROR' };
  }

  private async parseAcceptedResponse(response: Response): Promise<HandoffResult> {
    const boundedBody = await readBoundedResponseBody(
      response,
      NOTIFICATION_HANDOFF_POLICY.maxResponseBodyBytes,
    );
    if (boundedBody.kind === 'read_error') {
      return retryableProtocolError('ACCEPTED_RECEIPT_READ_ERROR', 202);
    }
    if (boundedBody.kind === 'overflow') {
      return retryableProtocolError('ACCEPTED_RECEIPT_TOO_LARGE', 202);
    }

    const receipt = parseAcceptedReceipt(boundedBody.bytes);
    if (!receipt) return retryableProtocolError('ACCEPTED_RECEIPT_INVALID', 202);

    const deploymentDigest = response.headers.get(NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST_HEADER);
    if (!isNotificationDeploymentDigest(deploymentDigest)) {
      return retryableProtocolError('DEPLOYMENT_DIGEST_INVALID', 202);
    }
    if (deploymentDigest !== this.expectedDeploymentDigest) {
      return permanentProtocolError('DEPLOYMENT_DIGEST_MISMATCH', 202);
    }
    return {
      kind: 'accepted',
      receipt: { ...receipt, deploymentDigest },
    };
  }
}

export function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value === null || !Number.isFinite(nowMs)) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isSafeInteger(seconds) || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
      return undefined;
    }
    return seconds * 1_000;
  }
  if (
    !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
      trimmed,
    )
  ) {
    return undefined;
  }
  const date = Date.parse(trimmed);
  if (!Number.isFinite(date) || new Date(date).toUTCString() !== trimmed) return undefined;
  return Math.max(0, date - nowMs);
}

function isValidHandoffRequest(
  request: NotificationServiceHandoffRequest,
): request is NotificationServiceHandoffRequest {
  return (
    isNotificationHandoffVendorId(request.vendorId) &&
    isNotificationHandoffIdempotencyKey(request.idempotencyKey) &&
    request.payloadBytes instanceof Uint8Array &&
    request.payloadBytes.byteLength <= NOTIFICATION_HANDOFF_POLICY.maxVendorBodyBytes
  );
}

function retryableStatusCode(status: number): string {
  if (status === 408) return 'REQUEST_TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  return 'SERVICE_UNAVAILABLE';
}

function deterministicRejectionCode(status: number): string {
  if ([400, 401, 403, 404, 413].includes(status)) return 'DETERMINISTIC_REJECTION';
  return 'UNEXPECTED_CLIENT_ERROR';
}

function retryableProtocolError(code: string, status: number): HandoffResult {
  return { kind: 'protocol_error', retryable: true, code, status };
}

function permanentProtocolError(code: string, status?: number): HandoffResult {
  return {
    kind: 'protocol_error',
    retryable: false,
    code,
    ...(status === undefined ? {} : { status }),
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status classification is authoritative; cancellation failure is not exposed.
  }
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
): Promise<{ kind: 'ok'; bytes: Uint8Array } | { kind: 'overflow' } | { kind: 'read_error' }> {
  if (!response.body) return { kind: 'ok', bytes: new Uint8Array() };
  const declaredLength = response.headers.get('Content-Length');
  if (declaredLength && /^\d+$/u.test(declaredLength)) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > maxBytes) {
      await cancelResponseBody(response);
      return { kind: 'overflow' };
    }
  }

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

function parseAcceptedReceipt(bytes: Uint8Array): Omit<AcceptedReceipt, 'deploymentDigest'> | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
    assertNoDuplicateJsonKeys(text);
  } catch {
    return null;
  }
  if (!hasExactKeys(parsed, ['request_id', 'data']) || !isReceiptId(parsed.request_id)) {
    return null;
  }
  const data = parsed.data;
  if (
    !hasExactKeys(data, ['notification_id', 'state', 'accepted_at', 'idempotent_replay']) ||
    !isReceiptId(data.notification_id) ||
    data.state !== 'pending' ||
    !isRfc3339Timestamp(data.accepted_at) ||
    typeof data.idempotent_replay !== 'boolean'
  ) {
    return null;
  }
  return {
    requestId: parsed.request_id,
    notificationId: data.notification_id,
    state: 'pending',
    acceptedAt: data.accepted_at,
    idempotentReplay: data.idempotent_replay,
  };
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isReceiptId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isRfc3339Timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/u,
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
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** JSON.parse accepts duplicate member names; the frozen receipt envelope does not. */
export function assertNoDuplicateJsonKeys(text: string): void {
  const scanner = new JsonKeyScanner(text);
  scanner.scan();
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
      if (token === '"') {
        this.cursor += 1;
        return JSON.parse(this.text.slice(start, this.cursor)) as string;
      }
      if (token === '\\') this.cursor += 1;
      this.cursor += 1;
    }
    throw new SyntaxError('Unterminated JSON string.');
  }

  private whitespace(): void {
    while (/\s/u.test(this.text[this.cursor] ?? '')) this.cursor += 1;
  }
}
