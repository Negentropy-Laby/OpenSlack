import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationBlobStore } from '../notification-blob-store.js';
import { NotificationReceiptStore } from '../notification-receipt-store.js';
import type { NotificationServiceClient } from '../notification-service-client.js';
import { toPersistableRepositoryEvent, type IssueRepositoryEvent } from '../repository-event.js';
import type { GitHubWatchConfigV2 } from '../watch-config-v2.js';
import { WatchDaemon, parseNotificationServiceAdmission } from '../watch-daemon.js';
import { WatchDeliveryQueueV2 } from '../watch-delivery-queue-v2.js';
import { WatchDeliveryQueue } from '../watch-delivery-queue.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WatchDaemon v2 composition', () => {
  it('prepares migration, fences v1 admission, and commits service acceptance', async () => {
    const fixture = createDaemon(true);
    await fixture.daemon.once(issueEvent(), 'github.watch.webhook', true);

    expect(fixture.queueV2.getStats()).toMatchObject({ accepted: 1, pendingReceiptLedgers: 0 });
    expect(fixture.handoff).toHaveBeenCalledOnce();
    expect(fixture.events.map((event) => event.type)).toContain('notification.accepted');
    expect(fixture.events.map((event) => event.type)).not.toContain('notification.sent');
    expect(() =>
      fixture.queueV1.claimAndEnqueue(toPersistableRepositoryEvent(issueEvent()), [
        { sink: 'webhook' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'QUEUE_MIGRATED' }));
  });

  it('does not durably accept a new service route while admission is disabled', async () => {
    const fixture = createDaemon(false);

    await expect(
      fixture.daemon.once(issueEvent(), 'github.watch.webhook', true),
    ).rejects.toMatchObject({ code: 'QUEUE_TRANSITION_INVALID' });
    expect(fixture.queueV2.listRoutes()).toEqual([]);
    expect(fixture.handoff).not.toHaveBeenCalled();
  });

  it('parses the admission gate strictly and defaults it off', () => {
    expect(parseNotificationServiceAdmission({})).toBe(false);
    expect(
      parseNotificationServiceAdmission({
        OPENSLACK_NOTIFICATION_SERVICE_NEW_RECORDS: 'false',
      }),
    ).toBe(false);
    expect(
      parseNotificationServiceAdmission({
        OPENSLACK_NOTIFICATION_SERVICE_NEW_RECORDS: 'true',
      }),
    ).toBe(true);
    expect(() =>
      parseNotificationServiceAdmission({
        OPENSLACK_NOTIFICATION_SERVICE_NEW_RECORDS: 'TRUE',
      }),
    ).toThrowError('OPENSLACK_NOTIFICATION_SERVICE_NEW_RECORDS must be exactly true or false.');
  });
});

function createDaemon(allowNewNotificationServiceRecords: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'openslack-daemon-v2-'));
  roots.push(root);
  const stateDir = join(root, 'daemon');
  const queueV1 = new WatchDeliveryQueue(stateDir);
  const queueV2 = new WatchDeliveryQueueV2(stateDir);
  const blobStore = new NotificationBlobStore({
    rootPath: join(root, 'daemon', 'blobs', 'sha256'),
  });
  const receiptStore = new NotificationReceiptStore({
    rootPath: join(root, 'daemon', 'notification-acceptance'),
  });
  const handoff = vi.fn().mockResolvedValue({
    kind: 'accepted',
    receipt: {
      requestId: 'request-daemon-v2',
      notificationId: 'notification-daemon-v2',
      state: 'pending',
      acceptedAt: '2026-07-23T00:00:01.000Z',
      idempotentReplay: false,
      deploymentDigest: `sha256:${'a'.repeat(64)}`,
    },
  });
  const events: Array<{ type?: unknown }> = [];
  const daemon = new WatchDaemon(
    configV2(),
    '',
    queueV1,
    undefined,
    undefined,
    (event) => {
      events.push(event as { type?: unknown });
      return {
        id: `event-${events.length}`,
        ...(event as Record<string, unknown>),
        timestamp: '2026-07-23T00:00:02.000Z',
      } as ReturnType<NonNullable<ConstructorParameters<typeof WatchDaemon>[5]>>;
    },
    {},
    {
      deliveryQueueV2: queueV2,
      notificationBlobStore: blobStore,
      notificationReceiptStore: receiptStore,
      notificationServiceClient: { handoff } as unknown as NotificationServiceClient,
      allowNewNotificationServiceRecords,
      workspaceRoot: root,
    },
  );
  return { daemon, queueV1, queueV2, handoff, events };
}

function configV2(): GitHubWatchConfigV2 {
  return {
    schema: 'openslack.github_watch.v2',
    notification_service: {
      endpoint: 'https://notifications.example.test',
      credential_ref: 'env:OPENSLACK_NOTIFICATION_SERVICE_KEY',
      expected_deployment_digest: `sha256:${'a'.repeat(64)}`,
    },
    repositories: [
      {
        owner: 'Acme',
        repo: 'Project',
        events: ['issues.opened'],
        routes: [
          {
            id: 'webhook-primary',
            sink: 'webhook',
            delivery: {
              backend: 'notification_service',
              routing_epoch: 1,
              vendor_id: 'webhook-canary',
            },
          },
        ],
      },
    ],
  };
}

function issueEvent(): IssueRepositoryEvent & { owner: string; repo: string } {
  return {
    kind: 'issue',
    eventKey: 'issues.opened',
    action: 'opened',
    owner: 'Acme',
    repo: 'Project',
    repository: {
      owner: 'Acme',
      repo: 'Project',
      fullName: 'Acme/Project',
      canonicalFullName: 'acme/project',
    },
    object: { kind: 'issue', id: 'acme/project#42', number: 42 },
    source: 'webhook',
    deliveryId: 'delivery-v2-42',
    observedAt: '2026-07-23T00:00:00.000Z',
    metadata: { informational: false, senderLogin: 'octocat' },
    issueNumber: 42,
    title: 'Notification delivery integration',
    url: 'https://github.com/Acme/Project/issues/42',
    labels: ['openslack:task'],
    body: 'Sensitive prose stays out of queue state.',
    senderLogin: 'octocat',
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
}
