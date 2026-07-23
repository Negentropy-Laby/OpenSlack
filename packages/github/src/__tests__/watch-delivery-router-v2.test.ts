import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationBlobStore } from '../notification-blob-store.js';
import { createNotificationPayload } from '../notification-payload.js';
import { NotificationReceiptStore } from '../notification-receipt-store.js';
import type { NotificationServiceClient } from '../notification-service-client.js';
import type { NotificationSink } from '../notification-sinks.js';
import type { IssueRepositoryEvent } from '../repository-event.js';
import type { GitHubWatchRouteV2 } from '../watch-config-v2.js';
import { WatchDeliveryQueueV2 } from '../watch-delivery-queue-v2.js';
import { WatchDeliveryRouterV2 } from '../watch-delivery-router-v2.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WatchDeliveryRouterV2', () => {
  it('fails closed before Blob or queue admission while new service records are disabled', async () => {
    const fixture = createFixture(false);

    await expect(fixture.router.admit(issueEvent(), [serviceRoute()])).rejects.toMatchObject({
      code: 'QUEUE_TRANSITION_INVALID',
    });
    expect(fixture.queue.listRoutes()).toEqual([]);
    expect(fixture.blobStore.usage().usedBytes).toBe(0);
    expect(fixture.handoff).not.toHaveBeenCalled();
  });

  it('materializes once, commits a receipt, and never reports a 202 as notification.sent', async () => {
    const fixture = createFixture(true);
    const event = issueEvent();

    const admitted = await fixture.router.admit(event, [serviceRoute()]);
    expect(admitted.outcome).toBe('enqueued');
    expect(fixture.queue.getStats()).toMatchObject({ pending: 1, accepted: 0 });

    const drained = await fixture.router.drainOnce();
    expect(drained).toMatchObject({ claimed: 1, accepted: 1 });
    const route = fixture.queue.getRoute(admitted.routeRecordIds[0]!);
    expect(route).toMatchObject({
      state: 'accepted',
      authority: 'notification_service',
      receiptLedger: 'committed',
      remoteDeliveryState: 'pending',
      attemptCount: 1,
    });
    expect(fixture.receiptStore.read(route!.id)).toEqual(route!.receipt!);
    expect(Buffer.from(fixture.handoff.mock.calls[0]![0].payloadBytes).toString('utf8')).toBe(
      JSON.stringify(createNotificationPayload(event)),
    );
    expect(fixture.events.map((entry) => entry.type)).toContain('notification.accepted');
    expect(fixture.events.map((entry) => entry.type)).not.toContain('notification.sent');
    expect(fixture.directSend).not.toHaveBeenCalled();
  });

  it('keeps authority local and retries the same key after response loss', async () => {
    const fixture = createFixture(true, {
      kind: 'retryable',
      code: 'NETWORK_ERROR',
    });
    const admitted = await fixture.router.admit(issueEvent(), [serviceRoute()]);

    const drained = await fixture.router.drainOnce();
    expect(drained).toMatchObject({ claimed: 1, retryable: 1 });
    const route = fixture.queue.getRoute(admitted.routeRecordIds[0]!)!;
    expect(route).toMatchObject({
      state: 'retryable',
      authority: 'openslack',
      attemptCount: 1,
    });
    expect(route.idempotencyKey).toBe(fixture.handoff.mock.calls[0]![0].idempotencyKey);
    expect(fixture.events.map((entry) => entry.type)).toContain('notification.handoff_retry');
    expect(fixture.directSend).not.toHaveBeenCalled();
  });

  it('uses notification.sent only for a direct vendor success', async () => {
    const fixture = createFixture(false);
    const admitted = await fixture.router.admit(issueEvent(), [directRoute()]);

    const drained = await fixture.router.drainOnce();
    expect(drained).toMatchObject({ claimed: 1, completed: 1 });
    expect(fixture.queue.getRoute(admitted.routeRecordIds[0]!)).toMatchObject({
      state: 'completed',
      authority: 'terminal',
    });
    expect(fixture.directSend).toHaveBeenCalledOnce();
    expect(fixture.events.map((entry) => entry.type)).toContain('notification.sent');
    expect(fixture.handoff).not.toHaveBeenCalled();
  });
});

function createFixture(
  allowNewServiceRecords: boolean,
  handoffResult: Awaited<ReturnType<NotificationServiceClient['handoff']>> = {
    kind: 'accepted',
    receipt: {
      requestId: 'request-1',
      notificationId: 'notification-1',
      state: 'pending',
      acceptedAt: '2026-07-23T00:00:01.000Z',
      idempotentReplay: false,
      deploymentDigest: `sha256:${'a'.repeat(64)}`,
    },
  },
) {
  const root = mkdtempSync(join(tmpdir(), 'openslack-router-v2-'));
  roots.push(root);
  const queue = new WatchDeliveryQueueV2(join(root, 'daemon'), {
    now: () => new Date('2026-07-23T00:00:00.000Z'),
    nonce: () => '00000000-0000-4000-8000-000000000001',
  });
  const blobStore = new NotificationBlobStore({
    rootPath: join(root, 'daemon', 'blobs', 'sha256'),
  });
  const receiptStore = new NotificationReceiptStore({
    rootPath: join(root, 'daemon', 'notification-acceptance'),
  });
  const handoff = vi.fn().mockResolvedValue(handoffResult);
  const directSend = vi.fn().mockResolvedValue({ ok: true, outcome: 'delivered' });
  const sinks = new Map<string, NotificationSink>([
    ['webhook', { name: 'webhook', send: directSend }],
  ]);
  const events: Array<{ type?: unknown }> = [];
  const router = new WatchDeliveryRouterV2({
    queue,
    blobStore,
    receiptStore,
    notificationClient: { handoff } as unknown as NotificationServiceClient,
    sinks,
    watchConfigDigest: `sha256:${'b'.repeat(64)}`,
    allowNewServiceRecords,
    recordEvent: (event) => {
      events.push(event as { type?: unknown });
    },
    now: () => new Date('2026-07-23T00:00:02.000Z'),
  });
  return { router, queue, blobStore, receiptStore, handoff, directSend, events };
}

function serviceRoute(): GitHubWatchRouteV2 {
  return {
    id: 'webhook-primary',
    sink: 'webhook',
    delivery: {
      backend: 'notification_service',
      routing_epoch: 1,
      vendor_id: 'webhook-canary',
    },
  };
}

function directRoute(): GitHubWatchRouteV2 {
  return {
    id: 'webhook-direct',
    sink: 'webhook',
    delivery: {
      backend: 'direct',
      routing_epoch: 1,
    },
  };
}

function issueEvent(): IssueRepositoryEvent {
  return {
    kind: 'issue',
    eventKey: 'issues.opened',
    action: 'opened',
    repository: {
      owner: 'Acme',
      repo: 'Project',
      fullName: 'Acme/Project',
      canonicalFullName: 'acme/project',
    },
    object: { kind: 'issue', id: 'acme/project#42', number: 42 },
    source: 'webhook',
    deliveryId: 'delivery-42',
    observedAt: '2026-07-23T00:00:00.000Z',
    metadata: { informational: false, senderLogin: 'octocat' },
    issueNumber: 42,
    title: 'Notification delivery integration',
    url: 'https://github.com/Acme/Project/issues/42',
    labels: ['openslack:task'],
    body: 'Body is materialized into the protected Blob only.',
    senderLogin: 'octocat',
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
}
