import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createNotificationRouteRecordIdV2 } from '../notification-handoff-contracts.js';
import { NotificationReceiptStore } from '../notification-receipt-store.js';
import {
  WatchDeliveryQueueV2,
  migrateWatchDeliveryQueueV1ToV2,
  type LegacyWatchRouteBindingV2,
  type WatchDeliveryQueueV2Options,
  type WatchRouteBlobReferenceV2,
} from '../watch-delivery-queue-v2.js';
import { WatchDeliveryQueue } from '../watch-delivery-queue.js';
import {
  canonicalizeRepositoryName,
  canonicalWatchRouteKey,
  toPersistableRepositoryEvent,
  type IssueRepositoryEvent,
} from '../repository-event.js';
import type { GitHubWatchRouteV2 } from '../watch-config-v2.js';

let root: string;
let now: Date;
let nonce: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openslack-watch-v2-'));
  now = new Date('2026-07-23T00:00:00.000Z');
  nonce = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function queueV2(
  options: {
    acceptanceCheckpoint?: WatchDeliveryQueueV2Options['acceptanceCheckpoint'];
  } = {},
): WatchDeliveryQueueV2 {
  return new WatchDeliveryQueueV2(root, {
    now: () => new Date(now),
    nonce: () => `v2-${++nonce}`,
    policy: { leaseMs: 1_000, lockTimeoutMs: 100, lockStaleMs: 10_000 },
    ...(options.acceptanceCheckpoint ? { acceptanceCheckpoint: options.acceptanceCheckpoint } : {}),
  });
}

function queueV1(): WatchDeliveryQueue {
  return new WatchDeliveryQueue(root, {
    now: () => new Date(now),
    nonce: () => `v1-${++nonce}`,
    policy: {
      leaseMs: 1_000,
      lockTimeoutMs: 100,
      lockStaleMs: 10_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 8_000,
    },
  });
}

function issueEvent(number = 42, deliveryId = `delivery-${number}`): IssueRepositoryEvent {
  const repository = canonicalizeRepositoryName('Acme', 'Project');
  if (!repository) throw new Error('Expected repository');
  return {
    kind: 'issue',
    eventKey: 'issues.opened',
    action: 'opened',
    repository,
    object: { kind: 'issue', id: `acme/project#${number}`, number },
    source: 'webhook',
    deliveryId,
    observedAt: '2026-07-23T00:00:00.000Z',
    metadata: { informational: false, senderLogin: 'sender' },
    issueNumber: number,
    title: 'Title is not persisted',
    url: `https://github.com/Acme/Project/issues/${number}`,
    labels: [],
    body: 'Body is not persisted',
    senderLogin: 'sender',
    updatedAt: `2026-07-23T00:00:${String(number % 60).padStart(2, '0')}.000Z`,
  };
}

const serviceRoute: GitHubWatchRouteV2 = {
  id: 'slack-primary',
  sink: 'slack',
  channel: '#canary',
  delivery: {
    backend: 'notification_service',
    vendor_id: 'openslack-slack',
    routing_epoch: 1,
  },
};

const directRoute: GitHubWatchRouteV2 = {
  id: 'webhook-direct',
  sink: 'webhook',
  name: 'canary',
  delivery: { backend: 'direct', routing_epoch: 1 },
};

const blob: WatchRouteBlobReferenceV2 = {
  digest: `sha256:${'a'.repeat(64)}`,
  size: 128,
  mediaType: 'application/json',
  encoderVersion: 'openslack.slack_chat_post_message.v1',
};

const watchConfigDigest = `sha256:${'b'.repeat(64)}` as const;
const queueSchema = JSON.parse(
  readFileSync(new URL('../watch-delivery-queue-v2.schema.json', import.meta.url), 'utf8'),
) as object;
const validateQueueSchema = new Ajv2020({ strict: false, validateFormats: false }).compile(
  queueSchema,
);

function enqueueService(store = queueV2()) {
  const event = toPersistableRepositoryEvent(issueEvent());
  const result = store.enqueueRoutes(event, [{ route: serviceRoute, blob, watchConfigDigest }]);
  if (result.outcome === 'conflict' || result.routes.length !== 1) {
    throw new Error('Expected one route');
  }
  return { store, event, record: result.routes[0]! };
}

describe('WatchDeliveryQueueV2', () => {
  it('atomically enqueues route records with immutable service handoff identity', () => {
    const store = queueV2();
    const event = toPersistableRepositoryEvent(issueEvent());
    const first = store.enqueueRoutes(event, [
      { route: serviceRoute, blob, watchConfigDigest },
      { route: directRoute },
    ]);
    const duplicate = store.enqueueRoutes({ ...event, deliveryId: 'redelivery-42' }, [
      { route: serviceRoute, blob, watchConfigDigest },
      { route: directRoute },
    ]);

    expect(first).toMatchObject({ outcome: 'enqueued', routes: [{ state: 'pending' }, {}] });
    expect(duplicate).toMatchObject({ outcome: 'duplicate' });
    expect(store.getStats()).toMatchObject({ count: 2, pending: 2 });
    expect(store.listRoutes().every((route) => route.deliveryIds.includes('redelivery-42'))).toBe(
      true,
    );
    expect(readFileSync(store.statePath, 'utf8')).not.toContain('Title is not persisted');
    expect(validateQueueSchema(JSON.parse(readFileSync(store.statePath, 'utf8')))).toBe(true);
  });

  it('publishes a closed queue JSON schema', () => {
    const { store } = enqueueService();
    const state = JSON.parse(readFileSync(store.statePath, 'utf8')) as Record<string, unknown>;
    expect(validateQueueSchema(state)).toBe(true);
    expect(validateQueueSchema({ ...state, payload: 'must-not-be-accepted' })).toBe(false);
  });

  it('fails closed on partial duplicate route sets and delivery id conflicts', () => {
    const store = queueV2();
    const event = toPersistableRepositoryEvent(issueEvent());
    store.enqueueRoutes(event, [{ route: serviceRoute, blob, watchConfigDigest }]);
    expect(() =>
      store.enqueueRoutes(event, [
        { route: serviceRoute, blob, watchConfigDigest },
        { route: directRoute },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'QUEUE_IMMUTABLE_CONFLICT' }));

    expect(
      store.enqueueRoutes(toPersistableRepositoryEvent(issueEvent(43, 'delivery-42')), [
        { route: directRoute },
      ]),
    ).toMatchObject({ outcome: 'conflict', code: 'DELIVERY_ID_CONFLICT' });
  });

  it('persists processing intent before POST and applies deterministic 5-second retry', () => {
    const { store, record } = enqueueService();
    const claim = store.claimNext('handoff-worker', 'notification_service');
    expect(claim?.route).toMatchObject({ id: record.id, state: 'processing', attemptCount: 1 });
    expect(queueV2().getRoute(record.id)).toMatchObject({ state: 'processing', attemptCount: 1 });
    expect(store.confirmAttemptMaySend(record.id, claim!.lease.token)).toMatchObject({
      state: 'processing',
    });
    const retried = store.markRetryable(
      record.id,
      claim!.lease.token,
      { code: 'SERVICE_UNAVAILABLE', message: 'Temporary failure.' },
      1_000,
    );
    expect(retried).toMatchObject({
      state: 'retryable',
      availableAt: '2026-07-23T00:00:05.000Z',
      attemptCount: 1,
    });
  });

  it('caps retry delay at one hour and terminates after attempt 25', () => {
    const { store, record } = enqueueService();
    for (let attempt = 1; attempt <= 25; attempt += 1) {
      const claim = store.claimNext('worker', 'notification_service');
      if (!claim) throw new Error(`Expected attempt ${attempt}`);
      const settled = store.markRetryable(
        record.id,
        claim.lease.token,
        { code: 'SERVICE_UNAVAILABLE', message: 'Retry.' },
        attempt === 1 ? Number.MAX_SAFE_INTEGER : undefined,
      );
      if (attempt === 25) {
        expect(settled).toMatchObject({
          state: 'handoff_dead',
          terminalReason: 'attempts_exhausted',
          attemptCount: 25,
        });
        break;
      }
      const delay = Date.parse(settled.availableAt) - now.getTime();
      expect(delay).toBe(
        attempt === 1
          ? 60 * 60 * 1_000
          : Math.min(60 * 60 * 1_000, 5_000 * 2 ** Math.max(0, attempt - 1)),
      );
      now = new Date(settled.availableAt);
    }
    expect(store.claimNext('worker', 'notification_service')).toBeNull();
  });

  it('terminates at the exact 24-hour deadline before a new POST', () => {
    const { store, record } = enqueueService();
    now = new Date('2026-07-24T00:00:00.000Z');
    expect(store.claimNext('worker', 'notification_service')).toBeNull();
    expect(store.getRoute(record.id)).toMatchObject({
      state: 'handoff_dead',
      terminalReason: 'deadline_exhausted',
      attemptCount: 0,
    });
  });

  it('consumes a crashed processing attempt and recovers it as retryable', () => {
    const { store, record } = enqueueService();
    store.claimNext('crashed', 'notification_service');
    now = new Date(now.getTime() + 1_001);
    expect(queueV2().claimNext('recovery', 'notification_service')).toBeNull();
    expect(queueV2().getRoute(record.id)).toMatchObject({
      state: 'retryable',
      attemptCount: 1,
      availableAt: '2026-07-23T00:00:06.001Z',
    });
    now = new Date('2026-07-23T00:00:06.001Z');
    expect(queueV2().claimNext('recovery', 'notification_service')).toMatchObject({
      route: { attemptCount: 2, state: 'processing' },
    });
  });

  it('recovers an accepted embedded receipt without another POST', () => {
    const crashing = queueV2({
      acceptanceCheckpoint: (checkpoint) => {
        if (checkpoint === 'embedded_receipt_persisted') throw new Error('simulated crash');
      },
    });
    const { record } = enqueueService(crashing);
    const claim = crashing.claimNext('worker', 'notification_service');
    if (!claim) throw new Error('Expected claim');
    const receiptStore = new NotificationReceiptStore({
      rootPath: join(root, 'notification-acceptance'),
      nonce: () => `receipt-${++nonce}`,
    });
    const receipt = {
      schema: 'openslack.notification_acceptance.v1' as const,
      route_record_id: record.id,
      canonical_repository: record.canonicalRepository,
      route_id: record.routeId,
      routing_epoch: record.routingEpoch,
      vendor_id: record.vendorId!,
      idempotency_key: record.idempotencyKey,
      notification_id: 'notification-42',
      remote_request_id: 'request-42',
      accepted_at: now.toISOString(),
      idempotent_replay: false,
      deployment_digest: `sha256:${'c'.repeat(64)}` as const,
      watch_config_digest: watchConfigDigest,
      recorded_at: now.toISOString(),
    };

    expect(() =>
      crashing.acceptServiceRoute(record.id, claim.lease.token, receipt, receiptStore),
    ).toThrowError('simulated crash');
    expect(queueV2().getRoute(record.id)).toMatchObject({
      state: 'accepted',
      authority: 'notification_service',
      receiptLedger: 'pending',
    });
    expect(queueV2().claimNext('worker', 'notification_service')).toBeNull();
    expect(queueV2().recoverAcceptedReceipts(receiptStore)).toBe(1);
    expect(queueV2().getRoute(record.id)).toMatchObject({ receiptLedger: 'committed' });
    expect(receiptStore.read(record.id)).toEqual(receipt);
  });

  it('rejects conflicting accepted receipt identity without transferring authority', () => {
    const { store, record } = enqueueService();
    const claim = store.claimNext('worker', 'notification_service');
    if (!claim) throw new Error('Expected claim');
    const receiptStore = new NotificationReceiptStore({
      rootPath: join(root, 'notification-acceptance'),
    });
    expect(() =>
      store.acceptServiceRoute(
        record.id,
        claim.lease.token,
        {
          schema: 'openslack.notification_acceptance.v1',
          route_record_id: createNotificationRouteRecordIdV2(
            record.canonicalRepository,
            record.idempotencyKey,
          ),
          canonical_repository: record.canonicalRepository,
          route_id: record.routeId,
          routing_epoch: record.routingEpoch,
          vendor_id: 'different-vendor',
          idempotency_key: record.idempotencyKey,
          notification_id: 'notification-42',
          remote_request_id: 'request-42',
          accepted_at: now.toISOString(),
          idempotent_replay: false,
          deployment_digest: `sha256:${'c'.repeat(64)}`,
          watch_config_digest: watchConfigDigest,
          recorded_at: now.toISOString(),
        },
        receiptStore,
      ),
    ).toThrowError(expect.objectContaining({ code: 'QUEUE_RECEIPT_CONFLICT' }));
    expect(store.getRoute(record.id)).toMatchObject({
      state: 'processing',
      authority: 'openslack',
    });
  });
});

describe('v1 per-route migration', () => {
  function seedMixedV1() {
    const v1 = queueV1();
    const event = toPersistableRepositoryEvent(issueEvent());
    const routes = [
      { sink: 'slack' as const, channel: '#canary' },
      { sink: 'webhook' as const, name: 'canary' },
    ];
    const enqueued = v1.claimAndEnqueue(event, routes);
    if (enqueued.outcome !== 'enqueued') throw new Error('Expected v1 enqueue');
    const claim = v1.claimNext('legacy-worker');
    if (!claim) throw new Error('Expected v1 claim');
    const first = claim.delivery.routes[0]!;
    v1.beginRouteAttempt(claim.delivery.id, claim.lease.token, first.routeKey);
    v1.markRouteCompleted(claim.delivery.id, claim.lease.token, first.routeKey);
    v1.finishDelivery(claim.delivery.id, claim.lease.token);
    const bindings: LegacyWatchRouteBindingV2[] = routes.map((route, index) => ({
      routeKey: canonicalWatchRouteKey(event.repository, route)!,
      routeId: index === 0 ? 'legacy-slack' : 'legacy-webhook',
      routingEpoch: 1,
    }));
    return { v1, bindings, deliveryId: claim.delivery.id };
  }

  it('dry-runs without writes then migrates each route independently and byte-stably', () => {
    const { v1, bindings } = seedMixedV1();
    const v2 = queueV2();
    const dryRun = migrateWatchDeliveryQueueV1ToV2({ v1, v2, bindings, dryRun: true });
    expect(dryRun).toMatchObject({
      dryRun: true,
      changed: true,
      completedTombstones: 1,
      legacyOwned: 1,
    });
    expect(existsSync(v2.statePath)).toBe(false);

    const applied = migrateWatchDeliveryQueueV1ToV2({ v1, v2, bindings });
    expect(applied).toMatchObject({ dryRun: false, changed: true, imported: 2 });
    expect(v2.listRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: 'completed',
          authority: 'terminal',
          migrationDisposition: 'completed_tombstone',
        }),
        expect.objectContaining({
          state: 'pending',
          authority: 'legacy_v1',
          migrationDisposition: 'legacy_owned',
        }),
      ]),
    );
    const stateBytes = readFileSync(v2.statePath);
    const markerBytes = readFileSync(join(root, 'delivery-state.v2-migration.json'));
    expect(migrateWatchDeliveryQueueV1ToV2({ v1, v2, bindings })).toMatchObject({
      changed: false,
      imported: 0,
      refreshed: 0,
    });
    expect(readFileSync(v2.statePath)).toEqual(stateBytes);
    expect(readFileSync(join(root, 'delivery-state.v2-migration.json'))).toEqual(markerBytes);
  });

  it('fences new v1 admission, drains legacy ownership, and installs an old-binary sentinel', () => {
    const { v1, bindings } = seedMixedV1();
    const v2 = queueV2();
    migrateWatchDeliveryQueueV1ToV2({ v1, v2, bindings });
    expect(() =>
      v1.claimAndEnqueue(toPersistableRepositoryEvent(issueEvent(43)), [
        { sink: 'webhook', name: 'canary' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'QUEUE_MIGRATED' }));
    expect(() => v1.finalizeV2Migration(v2.statePath)).toThrowError(
      expect.objectContaining({ code: 'QUEUE_TRANSITION_INVALID' }),
    );

    const claim = v1.claimNext('legacy-drain');
    if (!claim) throw new Error('Expected legacy drain claim');
    const pending = claim.delivery.routes.find((route) => route.state === 'pending');
    if (!pending) throw new Error('Expected pending legacy route');
    v1.beginRouteAttempt(claim.delivery.id, claim.lease.token, pending.routeKey);
    v1.markRouteCompleted(claim.delivery.id, claim.lease.token, pending.routeKey);
    v1.finishDelivery(claim.delivery.id, claim.lease.token);
    migrateWatchDeliveryQueueV1ToV2({ v1, v2, bindings });
    expect(v2.getStats()).toMatchObject({ completed: 2, legacyOwned: 0 });

    const finalized = v1.finalizeV2Migration(v2.statePath);
    expect(finalized.backupDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(readFileSync(finalized.backupPath, 'utf8')).toContain(
      'openslack.watch_delivery_queue.v1',
    );
    if (process.platform !== 'win32')
      expect(statSync(finalized.backupPath).mode & 0o777).toBe(0o400);
    expect(readFileSync(join(root, 'delivery-state.v1.json'), 'utf8')).toContain(
      'OPENSLACK_DELIVERY_QUEUE_V1_MIGRATED',
    );
    expect(() => queueV1().getStats()).toThrowError(
      expect.objectContaining({ code: 'QUEUE_STATE_INVALID' }),
    );
  });
});
