import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isNotificationDeploymentDigest } from './notification-handoff-contracts.js';
import { normalizeNotificationServiceOrigin } from './notification-service-endpoint.js';

const MAX_PROXY_REQUEST_BYTES = 512 * 1024;
const MAX_PROXY_RESPONSE_BYTES = 64 * 1024;
const DEPLOYMENT_DIGEST_HEADER = 'X-Notification-Service-Deployment-Digest';

export type NotificationFaultScenario =
  | 'passthrough'
  | 'response_loss_after_upstream'
  | 'malformed_202'
  | 'extra_field_202'
  | 'conflicting_notification_id_202'
  | 'unexpected_success_200'
  | 'redirect_302'
  | 'rejected_400'
  | 'rejected_401'
  | 'rejected_403'
  | 'rejected_404'
  | 'rejected_413'
  | 'conflict_409'
  | 'retryable_429'
  | 'retryable_500'
  | 'retryable_503'
  | 'deployment_digest_drift_202';

export interface NotificationFaultAcceptedFixture {
  requestId: string;
  notificationId: string;
  conflictingNotificationId: string;
  acceptedAt: string;
  deploymentDigest: `sha256:${string}`;
  driftDeploymentDigest: `sha256:${string}`;
}

export interface NotificationFaultProxyOptions {
  upstreamOrigin: string;
  scenario: NotificationFaultScenario;
  acceptedFixture: NotificationFaultAcceptedFixture;
  injections?: number;
  allowInsecureLoopbackUpstream?: boolean;
  fetch?: typeof fetch;
}

export interface NotificationFaultProxyObservation {
  sequence: number;
  scenario: NotificationFaultScenario;
  outcomeCode: string;
  upstreamCalled: boolean;
  recordedAt: string;
}

/**
 * Loopback-only one-shot fault proxy for the G4 harness. It forwards bounded
 * bytes in memory and records closed outcome codes only; request/response
 * bodies, credentials, endpoints, and headers are never retained.
 */
export class NotificationFaultProxy {
  private readonly upstreamOrigin: string;
  private readonly scenario: NotificationFaultScenario;
  private readonly fixture: NotificationFaultAcceptedFixture;
  private readonly fetch: typeof fetch;
  private remaining: number;
  private sequence = 0;
  private server: Server | null = null;
  private readonly observationLog: NotificationFaultProxyObservation[] = [];

  constructor(options: NotificationFaultProxyOptions) {
    this.upstreamOrigin = normalizeNotificationServiceOrigin(options.upstreamOrigin, {
      allowInsecureLoopback: options.allowInsecureLoopbackUpstream,
    });
    this.scenario = options.scenario;
    this.fixture = validateFixture(options.acceptedFixture);
    this.remaining = options.injections ?? 1;
    if (!Number.isSafeInteger(this.remaining) || this.remaining < 0 || this.remaining > 100) {
      throw new TypeError('Fault injection count must be an integer from 0 through 100.');
    }
    this.fetch = options.fetch ?? fetch;
  }

  async start(port = 0): Promise<string> {
    if (this.server) throw new Error('FAULT_PROXY_ALREADY_STARTED');
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) {
          response.writeHead(502, { 'Content-Type': 'application/json' });
          response.end('{"error":"FAULT_PROXY_UPSTREAM_UNAVAILABLE"}');
        } else {
          response.destroy();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => {
        this.server!.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('FAULT_PROXY_ADDRESS_INVALID');
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  observations(): NotificationFaultProxyObservation[] {
    return this.observationLog.map((observation) => ({ ...observation }));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!request.url?.startsWith('/') || request.url.startsWith('//')) {
      response.writeHead(400).end();
      return;
    }
    const body = await readBoundedRequest(request);
    const applies =
      request.method === 'POST' &&
      new URL(request.url, 'http://127.0.0.1').pathname === '/v1/notifications' &&
      this.remaining > 0 &&
      this.scenario !== 'passthrough';
    if (applies) this.remaining -= 1;
    const scenario = applies ? this.scenario : 'passthrough';

    if (scenario === 'response_loss_after_upstream') {
      const upstream = await this.forward(request, body);
      if (upstream.status !== 202) {
        const upstreamBytes = await readBoundedResponse(upstream);
        this.record(scenario, `RESPONSE_LOSS_NOT_ARMED_STATUS_${upstream.status}`, true);
        response.writeHead(upstream.status, safeResponseHeaders(upstream.headers));
        response.end(upstreamBytes);
        return;
      }
      await upstream.body?.cancel();
      this.record(scenario, 'RESPONSE_LOST_AFTER_UPSTREAM', true);
      response.destroy();
      return;
    }
    const synthetic = syntheticResponse(scenario, this.fixture);
    if (synthetic) {
      this.record(scenario, synthetic.code, false);
      response.writeHead(synthetic.status, synthetic.headers);
      response.end(synthetic.body);
      return;
    }

    const upstream = await this.forward(request, body);
    const upstreamBytes = await readBoundedResponse(upstream);
    this.record(scenario, 'PASSTHROUGH', true);
    response.writeHead(upstream.status, safeResponseHeaders(upstream.headers));
    response.end(upstreamBytes);
  }

  private forward(request: IncomingMessage, body: Uint8Array): Promise<Response> {
    const headers = new Headers();
    for (const name of [
      'accept',
      'authorization',
      'content-type',
      'idempotency-key',
      'x-openslack-idempotency-key',
    ]) {
      const value = request.headers[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    const method = request.method ?? 'GET';
    return this.fetch(`${this.upstreamOrigin}${request.url}`, {
      method,
      redirect: 'manual',
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
    });
  }

  private record(
    scenario: NotificationFaultScenario,
    outcomeCode: string,
    upstreamCalled: boolean,
  ): void {
    this.observationLog.push({
      sequence: ++this.sequence,
      scenario,
      outcomeCode,
      upstreamCalled,
      recordedAt: new Date().toISOString(),
    });
  }
}

function validateFixture(
  fixture: NotificationFaultAcceptedFixture,
): NotificationFaultAcceptedFixture {
  for (const value of [
    fixture.requestId,
    fixture.notificationId,
    fixture.conflictingNotificationId,
  ]) {
    if (
      !value ||
      value.length > 128 ||
      value !== value.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new TypeError('Fault fixture identifiers must be bounded printable values.');
    }
  }
  if (
    !isTimestamp(fixture.acceptedAt) ||
    !isNotificationDeploymentDigest(fixture.deploymentDigest) ||
    !isNotificationDeploymentDigest(fixture.driftDeploymentDigest) ||
    fixture.deploymentDigest === fixture.driftDeploymentDigest
  ) {
    throw new TypeError('Fault fixture timestamps and deployment digests must be valid.');
  }
  return { ...fixture };
}

function syntheticResponse(
  scenario: NotificationFaultScenario,
  fixture: NotificationFaultAcceptedFixture,
): { status: number; headers: Record<string, string>; body: string; code: string } | null {
  const accepted = (notificationId: string, extra = false): string =>
    JSON.stringify({
      request_id: fixture.requestId,
      data: {
        notification_id: notificationId,
        state: 'pending',
        accepted_at: fixture.acceptedAt,
        idempotent_replay: false,
        ...(extra ? { unexpected: true } : {}),
      },
    });
  const response = (
    status: number,
    code: string,
    body = '',
    headers: Record<string, string> = {},
  ) => ({ status, code, body, headers });
  switch (scenario) {
    case 'malformed_202':
      return response(202, 'MALFORMED_202', '{"request_id":', {
        [DEPLOYMENT_DIGEST_HEADER]: fixture.deploymentDigest,
      });
    case 'extra_field_202':
      return response(202, 'EXTRA_FIELD_202', accepted(fixture.notificationId, true), {
        [DEPLOYMENT_DIGEST_HEADER]: fixture.deploymentDigest,
      });
    case 'conflicting_notification_id_202':
      return response(
        202,
        'CONFLICTING_NOTIFICATION_ID_202',
        accepted(fixture.conflictingNotificationId),
        { [DEPLOYMENT_DIGEST_HEADER]: fixture.deploymentDigest },
      );
    case 'deployment_digest_drift_202':
      return response(202, 'DEPLOYMENT_DIGEST_DRIFT_202', accepted(fixture.notificationId), {
        [DEPLOYMENT_DIGEST_HEADER]: fixture.driftDeploymentDigest,
      });
    case 'unexpected_success_200':
      return response(200, 'UNEXPECTED_SUCCESS_200');
    case 'redirect_302':
      return response(302, 'REDIRECT_302', '', { Location: 'https://invalid.example.test/' });
    case 'rejected_400':
    case 'rejected_401':
    case 'rejected_403':
    case 'rejected_404':
    case 'rejected_413':
      return response(Number(scenario.slice(-3)), scenario.toUpperCase());
    case 'conflict_409':
      return response(409, 'CONFLICT_409');
    case 'retryable_429':
      return response(429, 'RETRYABLE_429', '', { 'Retry-After': '5' });
    case 'retryable_500':
      return response(500, 'RETRYABLE_500');
    case 'retryable_503':
      return response(503, 'RETRYABLE_503');
    case 'passthrough':
    case 'response_loss_after_upstream':
      return null;
  }
}

async function readBoundedRequest(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_PROXY_REQUEST_BYTES) {
      request.destroy();
      throw new Error('FAULT_PROXY_REQUEST_TOO_LARGE');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_PROXY_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('FAULT_PROXY_RESPONSE_TOO_LARGE');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function safeResponseHeaders(headers: Headers): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const name of ['content-type', 'retry-after', 'x-notification-service-deployment-digest']) {
    const value = headers.get(name);
    if (value !== null) safe[name] = value;
  }
  return safe;
}

function isTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
