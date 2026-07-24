import { CredentialStore, MemoryKeychainBackend } from '@openslack/credentials';
import { describe, expect, it } from 'vitest';
import { NotificationServiceOpsClient } from '../notification-service-ops-client.js';

const EXPECTED_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const CREDENTIAL_REF = 'keychain:openslack/canary-auditor';

describe('NotificationServiceOpsClient', () => {
  it('queries only read-only ops endpoints with a per-request auditor credential', async () => {
    const requests: Array<{ url: string; authorization: string | null; method?: string }> = [];
    const backend = new MemoryKeychainBackend();
    const store = new CredentialStore([backend]);
    store.put(CREDENTIAL_REF, 'auditor-key-one');
    const client = new NotificationServiceOpsClient({
      endpoint: 'https://notification.internal',
      credentialRef: CREDENTIAL_REF,
      expectedDeploymentDigest: EXPECTED_DIGEST,
      credentialStore: store,
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get('Authorization'),
          method: init?.method,
        });
        if (url.endsWith('/health/version')) {
          return jsonResponse({ ready: true, deployment_digest: EXPECTED_DIGEST }, 200);
        }
        if (url.includes('/attempts?')) {
          return jsonResponse({
            request_id: 'request-attempts',
            data: {
              items: [
                {
                  attempt_seq: 1,
                  event_kind: 'outcome',
                  config_version: 2,
                  result_kind: 'http_response',
                  outcome_class: 'success',
                  http_status: 200,
                  recorded_at: '2026-07-23T00:00:02Z',
                },
              ],
            },
          });
        }
        return jsonResponse({
          request_id: 'request-status',
          data: {
            notification_id: 'notification-1',
            vendor_id: 'openslack-webhook',
            state: 'delivered',
            version: 3,
            attempt_count: 1,
            delivery_cycle_started_at: '2026-07-23T00:00:00Z',
            replay_count: 0,
            last_outcome_class: 'success',
            created_at: '2026-07-23T00:00:00Z',
            delivered_at: '2026-07-23T00:00:02Z',
          },
        });
      },
    });

    await expect(client.version()).resolves.toEqual({
      kind: 'ok',
      ready: true,
      deploymentDigest: EXPECTED_DIGEST,
    });
    await expect(client.notification('notification-1')).resolves.toMatchObject({
      kind: 'ok',
      data: {
        notificationId: 'notification-1',
        vendorId: 'openslack-webhook',
        state: 'delivered',
      },
    });
    store.delete(CREDENTIAL_REF);
    store.put(CREDENTIAL_REF, 'auditor-key-two');
    await expect(client.attempts('notification-1')).resolves.toMatchObject({
      kind: 'ok',
      data: [{ attemptSeq: 1, configVersion: 2, outcomeClass: 'success' }],
    });

    expect(requests.map((request) => request.method)).toEqual(['GET', 'GET', 'GET']);
    expect(requests[0]!.authorization).toBeNull();
    expect(requests[1]!.authorization).toBe('Bearer auditor-key-one');
    expect(requests[2]!.authorization).toBe('Bearer auditor-key-two');
    expect(requests.every((request) => !request.url.includes('/replay'))).toBe(true);
  });

  it.each([
    [200, false],
    [503, true],
  ])('fails closed when readiness %s disagrees with HTTP status %s', async (status, ready) => {
    const client = clientWithFetch(async () =>
      jsonResponse({ ready, deployment_digest: EXPECTED_DIGEST }, status),
    );
    await expect(client.version()).resolves.toEqual({
      kind: 'protocol_error',
      code: 'VERSION_READINESS_STATUS_MISMATCH',
      status,
    });
  });

  it('rejects unknown fields and state-dependent timestamp drift', async () => {
    const unknown = clientWithFetch(async () =>
      jsonResponse({
        request_id: 'request-status',
        data: {
          notification_id: 'notification-1',
          vendor_id: 'openslack-webhook',
          state: 'pending',
          version: 1,
          attempt_count: 0,
          delivery_cycle_started_at: '2026-07-23T00:00:00Z',
          replay_count: 0,
          created_at: '2026-07-23T00:00:00Z',
          payload: 'forbidden',
        },
      }),
    );
    await expect(unknown.notification('notification-1')).resolves.toEqual({
      kind: 'protocol_error',
      code: 'NOTIFICATION_STATUS_INVALID',
      status: 200,
    });

    const missingDeliveredAt = clientWithFetch(async () =>
      jsonResponse({
        request_id: 'request-status',
        data: {
          notification_id: 'notification-1',
          vendor_id: 'openslack-webhook',
          state: 'delivered',
          version: 2,
          attempt_count: 1,
          delivery_cycle_started_at: '2026-07-23T00:00:00Z',
          replay_count: 0,
          created_at: '2026-07-23T00:00:00Z',
        },
      }),
    );
    await expect(missingDeliveredAt.notification('notification-1')).resolves.toMatchObject({
      kind: 'protocol_error',
      code: 'NOTIFICATION_STATUS_INVALID',
    });
  });

  it('bounds response bytes and rejects duplicate JSON members', async () => {
    const oversized = clientWithFetch(
      async () =>
        new Response('x'.repeat(65 * 1024), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(oversized.notification('notification-1')).resolves.toMatchObject({
      kind: 'protocol_error',
      code: 'OPS_ENVELOPE_INVALID',
    });

    const duplicate = clientWithFetch(
      async () =>
        new Response('{"request_id":"request-1","request_id":"request-2","data":{}}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(duplicate.notification('notification-1')).resolves.toMatchObject({
      kind: 'protocol_error',
      code: 'OPS_ENVELOPE_INVALID',
    });
  });
});

function clientWithFetch(
  request: NonNullable<ConstructorParameters<typeof NotificationServiceOpsClient>[0]['fetch']>,
): NotificationServiceOpsClient {
  const backend = new MemoryKeychainBackend();
  const store = new CredentialStore([backend]);
  store.put(CREDENTIAL_REF, 'auditor-key');
  return new NotificationServiceOpsClient({
    endpoint: 'https://notification.internal',
    credentialRef: CREDENTIAL_REF,
    expectedDeploymentDigest: EXPECTED_DIGEST,
    credentialStore: store,
    fetch: request,
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
