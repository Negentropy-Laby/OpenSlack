import { CredentialStore, MemoryKeychainBackend } from '@openslack/credentials';
import { describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST_HEADER,
  NotificationServiceClient,
  parseRetryAfterMs,
  type NotificationServiceClientOptions,
} from '../notification-service-client.js';

const EXPECTED_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}` as const;
const CREDENTIAL_REF = 'keychain:openslack/notification-service';
const IDEMPOTENCY_KEY = '01234567-89ab-5cde-8fab-0123456789ab';
const REQUEST = {
  vendorId: 'openslack-webhook',
  idempotencyKey: IDEMPOTENCY_KEY,
  payloadBytes: Uint8Array.from([0, 1, 2, 253, 254, 255]),
};

describe('NotificationServiceClient', () => {
  it('posts exact intake fields with a per-attempt credential lookup and returns accepted', async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const { client } = clientFixture({
      fetch: async (input, init) => {
        calls.push({ input, init });
        return acceptedResponse();
      },
    });

    await expect(client.handoff(REQUEST)).resolves.toEqual({
      kind: 'accepted',
      receipt: {
        requestId: 'request-1',
        notificationId: 'notification-1',
        state: 'pending',
        acceptedAt: '2026-07-23T00:00:00Z',
        idempotentReplay: false,
        deploymentDigest: EXPECTED_DIGEST,
      },
    });
    expect(calls).toHaveLength(1);
    expect(String(calls[0]!.input)).toBe('https://notification.internal/v1/notifications');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', redirect: 'manual' });
    const headers = new Headers(calls[0]!.init!.headers);
    expect(headers.get('Authorization')).toBe('Bearer caller-key-one');
    expect(headers.get('Idempotency-Key')).toBe(IDEMPOTENCY_KEY);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(calls[0]!.init!.body).toBe(
      JSON.stringify({
        vendor_id: 'openslack-webhook',
        payload_base64: 'AAEC/f7/',
      }),
    );
  });

  it('resolves the credential again after rotation', async () => {
    const authorizations: string[] = [];
    const fixture = clientFixture({
      fetch: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get('Authorization') ?? '');
        return acceptedResponse();
      },
    });
    await fixture.client.handoff(REQUEST);
    fixture.store.delete(CREDENTIAL_REF);
    fixture.store.put(CREDENTIAL_REF, 'caller-key-two');
    await fixture.client.handoff(REQUEST);
    expect(authorizations).toEqual(['Bearer caller-key-one', 'Bearer caller-key-two']);
  });

  it('returns safe no-status retryables for credential and network failures', async () => {
    const missing = clientFixture({ populateCredential: false });
    const credentialResult = await missing.client.handoff(REQUEST);
    expect(credentialResult).toEqual({ kind: 'retryable', code: 'CREDENTIAL_UNAVAILABLE' });
    expect(JSON.stringify(credentialResult)).not.toContain(CREDENTIAL_REF);

    const errorMarker = 'raw-network-body-and-token';
    const network = clientFixture({
      fetch: async () => {
        throw new Error(errorMarker);
      },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const networkResult = await network.client.handoff(REQUEST);
    expect(networkResult).toEqual({ kind: 'retryable', code: 'NETWORK_ERROR' });
    expect(JSON.stringify(networkResult)).not.toContain(errorMarker);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it.each([
    [200, 'UNEXPECTED_SUCCESS_STATUS'],
    [201, 'UNEXPECTED_SUCCESS_STATUS'],
    [204, 'UNEXPECTED_SUCCESS_STATUS'],
  ])('quarantines unexpected success status %i', async (status, code) => {
    const { client } = clientFixture({ fetch: async () => new Response(null, { status }) });
    await expect(client.handoff(REQUEST)).resolves.toEqual({
      kind: 'protocol_error',
      retryable: false,
      code,
      status,
    });
  });

  it.each([300, 301, 302, 307, 308])(
    'rejects redirect status %i without following',
    async (status) => {
      let redirect: RequestInit['redirect'];
      const { client } = clientFixture({
        fetch: async (_input, init) => {
          redirect = init?.redirect;
          return new Response(null, { status, headers: { Location: 'https://redirect.invalid' } });
        },
      });
      await expect(client.handoff(REQUEST)).resolves.toEqual({
        kind: 'rejected',
        code: 'PROTOCOL_REDIRECT',
        status,
      });
      expect(redirect).toBe('manual');
    },
  );

  it.each([
    [408, 'REQUEST_TIMEOUT'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVICE_UNAVAILABLE'],
    [503, 'SERVICE_UNAVAILABLE'],
  ])('retries status %i and accepts bounded Retry-After', async (status, code) => {
    const { client } = clientFixture({
      fetch: async () => new Response(null, { status, headers: { 'Retry-After': '17' } }),
    });
    await expect(client.handoff(REQUEST)).resolves.toEqual({
      kind: 'retryable',
      code,
      status,
      retryAfterMs: 17_000,
    });
  });

  it.each([400, 401, 403, 404, 413])('classifies deterministic rejection %i', async (status) => {
    const { client } = clientFixture({ fetch: async () => new Response(null, { status }) });
    await expect(client.handoff(REQUEST)).resolves.toEqual({
      kind: 'rejected',
      code: 'DETERMINISTIC_REJECTION',
      status,
    });
  });

  it('separates conflict and unexpected client errors', async () => {
    const conflict = clientFixture({ fetch: async () => new Response(null, { status: 409 }) });
    await expect(conflict.client.handoff(REQUEST)).resolves.toEqual({
      kind: 'conflict',
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    });
    const teapot = clientFixture({ fetch: async () => new Response(null, { status: 418 }) });
    await expect(teapot.client.handoff(REQUEST)).resolves.toEqual({
      kind: 'rejected',
      code: 'UNEXPECTED_CLIENT_ERROR',
      status: 418,
    });
  });

  it.each([
    ['empty', ''],
    ['invalid JSON', '{'],
    ['trailing JSON', `${JSON.stringify(acceptedEnvelope())}{}`],
    [
      'duplicate key',
      '{"request_id":"request-1","request_id":"request-2","data":{"notification_id":"notification-1","state":"pending","accepted_at":"2026-07-23T00:00:00Z","idempotent_replay":false}}',
    ],
    [
      'nested duplicate key',
      '{"request_id":"request-1","data":{"notification_id":"notification-1","notification_id":"notification-2","state":"pending","accepted_at":"2026-07-23T00:00:00Z","idempotent_replay":false}}',
    ],
    ['unknown top-level field', JSON.stringify({ ...acceptedEnvelope(), extra: true })],
    [
      'unknown data field',
      JSON.stringify({
        ...acceptedEnvelope(),
        data: { ...acceptedEnvelope().data, extra: true },
      }),
    ],
    [
      'missing field',
      JSON.stringify({
        request_id: 'request-1',
        data: {
          notification_id: 'notification-1',
          state: 'pending',
          accepted_at: '2026-07-23T00:00:00Z',
        },
      }),
    ],
    [
      'wrong type',
      JSON.stringify({
        ...acceptedEnvelope(),
        data: { ...acceptedEnvelope().data, idempotent_replay: 'false' },
      }),
    ],
    [
      'wrong state',
      JSON.stringify({
        ...acceptedEnvelope(),
        data: { ...acceptedEnvelope().data, state: 'delivered' },
      }),
    ],
    [
      'invalid calendar date',
      JSON.stringify({
        ...acceptedEnvelope(),
        data: { ...acceptedEnvelope().data, accepted_at: '2026-02-30T00:00:00Z' },
      }),
    ],
    ['invalid identifier', JSON.stringify({ ...acceptedEnvelope(), request_id: ' request-1' })],
  ])('treats %s in a 202 envelope as a retryable protocol error', async (_name, body) => {
    const { client } = clientFixture({ fetch: async () => acceptedResponse(body) });
    await expect(client.handoff(REQUEST)).resolves.toEqual({
      kind: 'protocol_error',
      retryable: true,
      code: 'ACCEPTED_RECEIPT_INVALID',
      status: 202,
    });
  });

  it('rejects invalid UTF-8 and a response stream loss without exposing body errors', async () => {
    const invalidUtf8 = clientFixture({
      fetch: async () => acceptedResponse(Uint8Array.from([0xff, 0xfe])),
    });
    await expect(invalidUtf8.client.handoff(REQUEST)).resolves.toMatchObject({
      kind: 'protocol_error',
      retryable: true,
      code: 'ACCEPTED_RECEIPT_INVALID',
    });

    const marker = 'raw-response-loss-marker';
    const lostStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('{"request_id":', 'utf8'));
        controller.error(new Error(marker));
      },
    });
    const responseLoss = clientFixture({
      fetch: async () =>
        new Response(lostStream, {
          status: 202,
          headers: { [NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST_HEADER]: EXPECTED_DIGEST },
        }),
    });
    const result = await responseLoss.client.handoff(REQUEST);
    expect(result).toMatchObject({
      kind: 'protocol_error',
      retryable: true,
      code: 'ACCEPTED_RECEIPT_READ_ERROR',
    });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('accepts exactly 16 KiB and rejects the 16385th response byte', async () => {
    const receipt = JSON.stringify(acceptedEnvelope());
    const exact = `${receipt}${' '.repeat(16_384 - Buffer.byteLength(receipt))}`;
    const accepted = clientFixture({ fetch: async () => acceptedResponse(exact) });
    await expect(accepted.client.handoff(REQUEST)).resolves.toMatchObject({ kind: 'accepted' });

    const overflow = clientFixture({ fetch: async () => acceptedResponse(`${exact} `) });
    await expect(overflow.client.handoff(REQUEST)).resolves.toEqual({
      kind: 'protocol_error',
      retryable: true,
      code: 'ACCEPTED_RECEIPT_TOO_LARGE',
      status: 202,
    });
  });

  it('requires a strict matching deployment digest after a valid envelope', async () => {
    for (const [header, expected] of [
      [undefined, 'DEPLOYMENT_DIGEST_INVALID'],
      [`sha256:${'A'.repeat(64)}`, 'DEPLOYMENT_DIGEST_INVALID'],
      [OTHER_DIGEST, 'DEPLOYMENT_DIGEST_MISMATCH'],
    ] as const) {
      const { client } = clientFixture({
        fetch: async () =>
          acceptedResponse(undefined, header === undefined ? {} : { deploymentDigest: header }),
      });
      await expect(client.handoff(REQUEST)).resolves.toMatchObject({
        kind: 'protocol_error',
        retryable: expected !== 'DEPLOYMENT_DIGEST_MISMATCH',
        code: expected,
        status: 202,
      });
    }
  });

  it('fails closed on invalid local input before credential or network access', async () => {
    const fetch = vi.fn(async () => acceptedResponse());
    const fixture = clientFixture({ fetch });
    const result = await fixture.client.handoff({
      ...REQUEST,
      payloadBytes: new Uint8Array(262_145),
    });
    expect(result).toEqual({
      kind: 'protocol_error',
      retryable: false,
      code: 'HANDOFF_REQUEST_INVALID',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows development HTTP only for explicit literal loopback origins', () => {
    const store = credentialStore();
    expect(
      () =>
        new NotificationServiceClient({
          ...baseOptions(store),
          endpoint: 'http://127.0.0.1:8080',
          allowInsecureLoopback: true,
        }),
    ).not.toThrow();
    expect(
      () =>
        new NotificationServiceClient({
          ...baseOptions(store),
          endpoint: 'http://[::1]:8080',
          allowInsecureLoopback: true,
        }),
    ).not.toThrow();
    for (const endpoint of [
      'http://127.0.0.1:8080',
      'http://localhost:8080',
      'http://notification.internal',
      'https://notification.internal/path',
    ]) {
      expect(
        () =>
          new NotificationServiceClient({
            ...baseOptions(store),
            endpoint,
          }),
      ).toThrowError(/credential-free HTTPS origin/u);
    }
    const credentialEndpoint = 'https://raw-user:raw-password@notification.internal';
    try {
      new NotificationServiceClient({ ...baseOptions(store), endpoint: credentialEndpoint });
      throw new Error('Expected endpoint validation to fail.');
    } catch (error) {
      expect((error as Error).message).not.toContain('raw-user');
      expect((error as Error).message).not.toContain('raw-password');
    }
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds and HTTP-date deterministically', () => {
    const now = Date.parse('2026-07-23T00:00:00Z');
    expect(parseRetryAfterMs('15', now)).toBe(15_000);
    expect(parseRetryAfterMs('Thu, 23 Jul 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfterMs('Wed, 22 Jul 2026 00:00:30 GMT', now)).toBe(0);
  });

  it('ignores invalid or unsafe values', () => {
    expect(parseRetryAfterMs('-1', 0)).toBeUndefined();
    expect(parseRetryAfterMs('1.5', 0)).toBeUndefined();
    expect(parseRetryAfterMs('not-a-date', 0)).toBeUndefined();
    expect(
      parseRetryAfterMs('Wed, 23 Jul 2026 00:00:30 GMT', Date.parse('2026-07-23T00:00:00Z')),
    ).toBeUndefined();
    expect(parseRetryAfterMs(null, 0)).toBeUndefined();
  });
});

function acceptedEnvelope() {
  return {
    request_id: 'request-1',
    data: {
      notification_id: 'notification-1',
      state: 'pending',
      accepted_at: '2026-07-23T00:00:00Z',
      idempotent_replay: false,
    },
  };
}

function acceptedResponse(
  body: string | Uint8Array | ReadableStream<Uint8Array> | null | undefined = JSON.stringify(
    acceptedEnvelope(),
  ),
  options: { deploymentDigest?: string } = { deploymentDigest: EXPECTED_DIGEST },
): Response {
  const headers = new Headers();
  if (options.deploymentDigest !== undefined) {
    headers.set(NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST_HEADER, options.deploymentDigest);
  }
  return new Response(body, { status: 202, headers });
}

function clientFixture(
  options: {
    fetch?: NonNullable<NotificationServiceClientOptions['fetch']>;
    populateCredential?: boolean;
  } = {},
): { client: NotificationServiceClient; store: CredentialStore } {
  const store = credentialStore(options.populateCredential ?? true);
  return {
    client: new NotificationServiceClient({
      ...baseOptions(store),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    store,
  };
}

function credentialStore(populate = true): CredentialStore {
  const store = new CredentialStore([new MemoryKeychainBackend()]);
  if (populate) store.put(CREDENTIAL_REF, 'caller-key-one');
  return store;
}

function baseOptions(
  store: CredentialStore,
): Omit<NotificationServiceClientOptions, 'fetch' | 'allowInsecureLoopback'> {
  return {
    endpoint: 'https://notification.internal',
    credentialRef: CREDENTIAL_REF,
    expectedDeploymentDigest: EXPECTED_DIGEST,
    credentialStore: store,
  };
}
