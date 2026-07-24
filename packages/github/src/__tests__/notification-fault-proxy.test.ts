import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { NotificationFaultProxy } from '../notification-fault-proxy.js';
import { NotificationServiceClient } from '../notification-service-client.js';

const EXPECTED_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const DRIFT_DIGEST = `sha256:${'b'.repeat(64)}` as const;
const IDEMPOTENCY_KEY = '01234567-89ab-5cde-8fab-0123456789ab';
const fixture = {
  requestId: 'request-1',
  notificationId: 'notification-1',
  conflictingNotificationId: 'notification-conflict',
  acceptedAt: '2026-07-23T00:00:00Z',
  deploymentDigest: EXPECTED_DIGEST,
  driftDeploymentDigest: DRIFT_DIGEST,
};
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('NotificationFaultProxy', () => {
  it('passes exact intake bytes and credentials without retaining them', async () => {
    const received: Array<{ body: string; authorization?: string; idempotencyKey?: string }> = [];
    const upstream = await upstreamServer(async (request) => {
      received.push(request);
      return acceptedResponse();
    });
    const proxy = await faultProxy(upstream.origin, 'passthrough');
    const result = await client(proxy.origin).handoff(handoffRequest());

    expect(result).toMatchObject({
      kind: 'accepted',
      receipt: { notificationId: 'notification-1' },
    });
    expect(received).toEqual([
      {
        body: JSON.stringify({
          vendor_id: 'openslack-webhook',
          payload_base64: 'eyJjYW5hcnkiOnRydWV9',
        }),
        authorization: 'Bearer caller-key',
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    ]);
    const observations = proxy.proxy.observations();
    expect(observations).toMatchObject([
      { scenario: 'passthrough', outcomeCode: 'PASSTHROUGH', upstreamCalled: true },
    ]);
    expect(JSON.stringify(observations)).not.toContain('caller-key');
    expect(JSON.stringify(observations)).not.toContain('canary');
    expect(JSON.stringify(observations)).not.toContain(upstream.origin);
  });

  it('drops a committed upstream 202 and makes the client retry the same key', async () => {
    const acceptedKeys: string[] = [];
    const upstream = await upstreamServer(async (request) => {
      acceptedKeys.push(request.idempotencyKey ?? '');
      return acceptedResponse();
    });
    const proxy = await faultProxy(upstream.origin, 'response_loss_after_upstream');
    await expect(client(proxy.origin).handoff(handoffRequest())).resolves.toEqual({
      kind: 'retryable',
      code: 'NETWORK_ERROR',
    });
    expect(acceptedKeys).toEqual([IDEMPOTENCY_KEY]);
    expect(proxy.proxy.observations()).toMatchObject([
      {
        scenario: 'response_loss_after_upstream',
        outcomeCode: 'RESPONSE_LOST_AFTER_UPSTREAM',
        upstreamCalled: true,
      },
    ]);
  });

  it('does not arm response loss when the upstream did not durably accept', async () => {
    const upstream = await upstreamServer(async () => new Response(null, { status: 503 }));
    const proxy = await faultProxy(upstream.origin, 'response_loss_after_upstream');
    await expect(client(proxy.origin).handoff(handoffRequest())).resolves.toEqual({
      kind: 'retryable',
      code: 'SERVICE_UNAVAILABLE',
      status: 503,
    });
    expect(proxy.proxy.observations()).toMatchObject([
      {
        outcomeCode: 'RESPONSE_LOSS_NOT_ARMED_STATUS_503',
        upstreamCalled: true,
      },
    ]);
  });

  it.each([
    [
      'malformed_202',
      {
        kind: 'protocol_error',
        retryable: true,
        code: 'ACCEPTED_RECEIPT_INVALID',
        status: 202,
      },
    ],
    [
      'extra_field_202',
      {
        kind: 'protocol_error',
        retryable: true,
        code: 'ACCEPTED_RECEIPT_INVALID',
        status: 202,
      },
    ],
    [
      'deployment_digest_drift_202',
      {
        kind: 'protocol_error',
        retryable: false,
        code: 'DEPLOYMENT_DIGEST_MISMATCH',
        status: 202,
      },
    ],
    [
      'unexpected_success_200',
      {
        kind: 'protocol_error',
        retryable: false,
        code: 'UNEXPECTED_SUCCESS_STATUS',
        status: 200,
      },
    ],
    ['redirect_302', { kind: 'rejected', code: 'PROTOCOL_REDIRECT', status: 302 }],
    ['rejected_401', { kind: 'rejected', code: 'DETERMINISTIC_REJECTION', status: 401 }],
    ['conflict_409', { kind: 'conflict', code: 'IDEMPOTENCY_CONFLICT', status: 409 }],
    [
      'retryable_429',
      { kind: 'retryable', code: 'RATE_LIMITED', status: 429, retryAfterMs: 5_000 },
    ],
    ['retryable_503', { kind: 'retryable', code: 'SERVICE_UNAVAILABLE', status: 503 }],
  ] as const)('injects %s exactly once', async (scenario, expected) => {
    let upstreamCalls = 0;
    const upstream = await upstreamServer(async () => {
      upstreamCalls += 1;
      return acceptedResponse();
    });
    const proxy = await faultProxy(upstream.origin, scenario);
    const serviceClient = client(proxy.origin);
    await expect(serviceClient.handoff(handoffRequest())).resolves.toEqual(expected);
    await expect(serviceClient.handoff(handoffRequest())).resolves.toMatchObject({
      kind: 'accepted',
    });
    expect(upstreamCalls).toBe(1);
  });
});

function client(endpoint: string): NotificationServiceClient {
  return new NotificationServiceClient({
    endpoint,
    credentialRef: 'env:OPENSLACK_NOTIFICATION_SERVICE_KEY',
    expectedDeploymentDigest: EXPECTED_DIGEST,
    credentialStore: {
      withSecret: (_reference, operation) => operation('caller-key'),
    },
    allowInsecureLoopback: true,
  });
}

function handoffRequest() {
  return {
    vendorId: 'openslack-webhook',
    idempotencyKey: IDEMPOTENCY_KEY,
    payloadBytes: Buffer.from('{"canary":true}', 'utf8'),
  };
}

async function faultProxy(
  upstreamOrigin: string,
  scenario: ConstructorParameters<typeof NotificationFaultProxy>[0]['scenario'],
): Promise<{ proxy: NotificationFaultProxy; origin: string }> {
  const proxy = new NotificationFaultProxy({
    upstreamOrigin,
    scenario,
    acceptedFixture: fixture,
    allowInsecureLoopbackUpstream: true,
  });
  const origin = await proxy.start();
  servers.push({ close: () => proxy.stop() });
  return { proxy, origin };
}

async function upstreamServer(
  responder: (request: {
    body: string;
    authorization?: string;
    idempotencyKey?: string;
  }) => Promise<Response>,
): Promise<{ origin: string }> {
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
      const upstream = await responder({
        body: Buffer.concat(chunks).toString('utf8'),
        ...(typeof request.headers.authorization === 'string'
          ? { authorization: request.headers.authorization }
          : {}),
        ...(typeof request.headers['idempotency-key'] === 'string'
          ? { idempotencyKey: request.headers['idempotency-key'] }
          : {}),
      });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
      response.end(Buffer.from(await upstream.arrayBuffer()));
    })();
  });
  const origin = await listen(server);
  servers.push({ close: () => close(server) });
  return { origin };
}

function acceptedResponse(): Response {
  return new Response(
    JSON.stringify({
      request_id: fixture.requestId,
      data: {
        notification_id: fixture.notificationId,
        state: 'pending',
        accepted_at: fixture.acceptedAt,
        idempotent_replay: false,
      },
    }),
    {
      status: 202,
      headers: { 'X-Notification-Service-Deployment-Digest': EXPECTED_DIGEST },
    },
  );
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address.');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
