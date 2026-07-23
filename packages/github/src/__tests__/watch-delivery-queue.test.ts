import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WatchDeliveryQueue,
  WatchDeliveryQueueError,
  type WatchDeliveryPolicy,
} from '../watch-delivery-queue.js';
import {
  canonicalizeRepositoryName,
  toPersistableRepositoryEvent,
  type IssueRepositoryEvent,
} from '../repository-event.js';

let tempDir: string;
let now: Date;
let nonceSequence: number;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'openslack-delivery-queue-'));
  now = new Date('2026-07-17T00:00:00.000Z');
  nonceSequence = 0;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function queue(policy: Partial<WatchDeliveryPolicy> = {}): WatchDeliveryQueue {
  return new WatchDeliveryQueue(tempDir, {
    now: () => new Date(now),
    nonce: () => `nonce-${++nonceSequence}`,
    policy: {
      leaseMs: 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 8_000,
      lockTimeoutMs: 100,
      lockStaleMs: 10_000,
      ...policy,
    },
  });
}

function issueEvent(overrides: Partial<IssueRepositoryEvent> = {}): IssueRepositoryEvent {
  const repository = canonicalizeRepositoryName('Acme', 'Project');
  if (!repository) throw new Error('Expected a valid repository');
  return {
    kind: 'issue',
    eventKey: 'issues.opened',
    action: 'opened',
    repository,
    object: { kind: 'issue', id: 'acme/project#42', number: 42 },
    source: 'webhook',
    deliveryId: 'delivery-42',
    observedAt: '2026-07-17T00:00:00.000Z',
    metadata: { informational: false, senderLogin: 'untrusted-sender' },
    issueNumber: 42,
    title: 'Untrusted issue title',
    url: 'https://github.com/Acme/Project/issues/42',
    labels: ['secret-looking-label'],
    body: 'Untrusted issue body',
    senderLogin: 'untrusted-sender',
    updatedAt: '2026-07-17T00:00:00.000Z',
    ...overrides,
  };
}

const routes = [{ sink: 'console' as const }, { sink: 'slack' as const, channel: '#delivery' }];

describe('WatchDeliveryQueue', () => {
  it('atomically creates one logical delivery across independent store instances', () => {
    const first = queue();
    const second = queue();
    const event = toPersistableRepositoryEvent(issueEvent());

    const accepted = first.claimAndEnqueue(event, routes);
    const duplicate = second.claimAndEnqueue(event, routes);

    expect(accepted.outcome).toBe('enqueued');
    expect(duplicate).toMatchObject({
      outcome: 'duplicate',
      duplicateState: 'pending',
    });
    expect(second.getStats()).toMatchObject({ count: 1, pending: 1 });
  });

  it('fails closed when one GitHub delivery id is reused for another stable event', () => {
    const store = queue();
    const first = toPersistableRepositoryEvent(issueEvent());
    const second = toPersistableRepositoryEvent(
      issueEvent({
        issueNumber: 43,
        object: { kind: 'issue', id: 'acme/project#43', number: 43 },
      }),
    );
    expect(store.claimAndEnqueue(first, routes).outcome).toBe('enqueued');
    expect(store.claimAndEnqueue(second, routes)).toMatchObject({
      outcome: 'conflict',
      code: 'DELIVERY_ID_CONFLICT',
    });
    expect(store.getStats().count).toBe(1);
  });

  it('remembers alternate redelivery ids so later identity reuse still fails closed', () => {
    const store = queue();
    const original = toPersistableRepositoryEvent(issueEvent());
    const redelivery = { ...original, deliveryId: 'alternate-delivery' };
    expect(store.claimAndEnqueue(original, routes).outcome).toBe('enqueued');
    expect(store.claimAndEnqueue(redelivery, routes)).toMatchObject({
      outcome: 'duplicate',
    });

    const conflicting = toPersistableRepositoryEvent(
      issueEvent({
        deliveryId: 'alternate-delivery',
        issueNumber: 43,
        object: { kind: 'issue', id: 'acme/project#43', number: 43 },
      }),
    );
    expect(store.claimAndEnqueue(conflicting, routes)).toMatchObject({
      outcome: 'conflict',
      code: 'DELIVERY_ID_CONFLICT',
    });
  });

  it('derives stable per-route idempotency keys across restarts', () => {
    const accepted = queue().claimAndEnqueue(toPersistableRepositoryEvent(issueEvent()), routes);
    if (accepted.outcome !== 'enqueued') throw new Error('Expected enqueue');
    const restarted = queue().getDelivery(accepted.delivery.id);

    expect(restarted?.routes).toHaveLength(2);
    expect(restarted?.routes.map((route) => route.idempotencyKey)).toEqual(
      accepted.delivery.routes.map((route) => route.idempotencyKey),
    );
    expect(new Set(restarted?.routes.map((route) => route.idempotencyKey)).size).toBe(2);
  });

  it('retries only unfinished routes and preserves completed route identity', () => {
    const store = queue();
    const accepted = store.claimAndEnqueue(toPersistableRepositoryEvent(issueEvent()), routes);
    if (accepted.outcome !== 'enqueued') throw new Error('Expected enqueue');
    const firstClaim = store.claimNext('worker-a');
    if (!firstClaim) throw new Error('Expected claim');
    const [firstRoute, secondRoute] = firstClaim.delivery.routes;
    const firstAttempt = store.beginRouteAttempt(
      firstClaim.delivery.id,
      firstClaim.lease.token,
      firstRoute!.routeKey,
    );
    const secondAttempt = store.beginRouteAttempt(
      firstClaim.delivery.id,
      firstClaim.lease.token,
      secondRoute!.routeKey,
    );
    expect(firstAttempt?.idempotencyKey).toBe(firstRoute!.idempotencyKey);
    expect(secondAttempt?.idempotencyKey).toBe(secondRoute!.idempotencyKey);
    store.markRouteCompleted(firstClaim.delivery.id, firstClaim.lease.token, firstRoute!.routeKey);
    store.markRouteRetryable(
      firstClaim.delivery.id,
      firstClaim.lease.token,
      secondRoute!.routeKey,
      { code: 'TEMPORARY', message: 'Temporary failure.' },
    );
    expect(store.finishDelivery(firstClaim.delivery.id, firstClaim.lease.token)).toMatchObject({
      state: 'retryable',
    });

    now = new Date(now.getTime() + 1_000);
    const retry = queue().claimNext('worker-b');
    expect(retry?.delivery.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeKey: firstRoute!.routeKey,
          state: 'completed',
          attempts: 1,
        }),
        expect.objectContaining({
          routeKey: secondRoute!.routeKey,
          state: 'retryable',
          idempotencyKey: secondRoute!.idempotencyKey,
        }),
      ]),
    );
    expect(
      queue().beginRouteAttempt(retry!.delivery.id, retry!.lease.token, firstRoute!.routeKey),
    ).toBeNull();
  });

  it('recovers an expired processing lease after restart', () => {
    const store = queue();
    store.claimAndEnqueue(toPersistableRepositoryEvent(issueEvent()), routes);
    const claim = store.claimNext('crashed-worker');
    if (!claim) throw new Error('Expected claim');
    store.beginRouteAttempt(
      claim.delivery.id,
      claim.lease.token,
      claim.delivery.routes[0]!.routeKey,
    );

    now = new Date(now.getTime() + 1_001);
    const restarted = queue();
    expect(restarted.recoverExpiredLeases()).toBe(1);
    expect(restarted.getDelivery(claim.delivery.id)).toMatchObject({
      state: 'retryable',
      routes: expect.arrayContaining([
        expect.objectContaining({ state: 'retryable', attempts: 1 }),
      ]),
    });
  });

  it('enforces deterministic backoff and a bounded attempt limit', () => {
    const store = queue({ maxAttempts: 2 });
    store.claimAndEnqueue(toPersistableRepositoryEvent(issueEvent()), routes);
    const first = store.claimNext('worker');
    if (!first) throw new Error('Expected claim');
    const retry = store.retryDelivery(first.delivery.id, first.lease.token, {
      code: 'LIVE_STATE_UNAVAILABLE',
      message: 'Refresh failed.',
    });
    expect(retry).toMatchObject({
      state: 'retryable',
      attempts: 1,
      availableAt: '2026-07-17T00:00:01.000Z',
    });

    now = new Date('2026-07-17T00:00:01.000Z');
    const second = store.claimNext('worker');
    if (!second) throw new Error('Expected retry claim');
    expect(
      store.retryDelivery(second.delivery.id, second.lease.token, {
        code: 'LIVE_STATE_UNAVAILABLE',
        message: 'Refresh failed again.',
      }),
    ).toMatchObject({ state: 'failed', attempts: 2 });
    expect(store.claimNext('worker')).toBeNull();
    expect(store.getStats()).toMatchObject({ failed: 1, exhausted: 1 });
  });

  it('compacts only expired terminal records', () => {
    const store = queue({
      completedRetentionMs: 1_000,
      failedRetentionMs: 2_000,
    });
    store.claimAndEnqueue(toPersistableRepositoryEvent(issueEvent()), []);
    const active = toPersistableRepositoryEvent(
      issueEvent({
        deliveryId: 'delivery-43',
        issueNumber: 43,
        object: { kind: 'issue', id: 'acme/project#43', number: 43 },
        updatedAt: '2026-07-17T00:00:01.000Z',
      }),
    );
    store.claimAndEnqueue(active, routes);

    now = new Date(now.getTime() + 1_001);
    expect(store.compact()).toBe(1);
    expect(store.getStats()).toMatchObject({ count: 1, pending: 1 });
  });

  it('rejects enqueue when capacity is exhausted without deleting active work', () => {
    const store = queue({ maxRecords: 1 });
    store.claimAndEnqueue(toPersistableRepositoryEvent(issueEvent()), routes);
    const second = toPersistableRepositoryEvent(
      issueEvent({
        deliveryId: 'delivery-43',
        issueNumber: 43,
        object: { kind: 'issue', id: 'acme/project#43', number: 43 },
        updatedAt: '2026-07-17T00:00:01.000Z',
      }),
    );
    expect(() => store.claimAndEnqueue(second, routes)).toThrowError(
      expect.objectContaining({ code: 'QUEUE_CAPACITY_EXCEEDED' }),
    );
    expect(store.getStats()).toMatchObject({ count: 1, pending: 1 });
  });

  it('fails closed on corrupted durable state', () => {
    writeFileSync(
      join(tempDir, 'delivery-state.v1.json'),
      '{"schema":"openslack.watch_delivery_queue.v1","deliveries":',
      'utf-8',
    );
    expect(() => queue().getStats()).toThrowError(
      expect.objectContaining({ code: 'QUEUE_STATE_INVALID' }),
    );
  });

  it('times out on an active lock without mutating durable state', () => {
    writeFileSync(
      join(tempDir, 'delivery-state.v1.json.lock'),
      JSON.stringify({ pid: 1, nonce: 'active', createdAt: now.toISOString() }),
      { encoding: 'utf-8', mode: 0o600 },
    );
    const store = queue({ lockTimeoutMs: 5, lockStaleMs: 60_000 });
    expect(() =>
      store.claimAndEnqueue(toPersistableRepositoryEvent(issueEvent()), routes),
    ).toThrowError(expect.objectContaining({ code: 'QUEUE_LOCK_TIMEOUT' }));
    rmSync(join(tempDir, 'delivery-state.v1.json.lock'), { force: true });
    expect(store.getStats().count).toBe(0);
  });

  it('isolates a stale lock and recovers deterministically', () => {
    const lockPath = join(tempDir, 'delivery-state.v1.json.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999999, nonce: 'stale', createdAt: now.toISOString() }),
      { encoding: 'utf-8', mode: 0o600 },
    );
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);

    const store = queue({ lockStaleMs: 1_000 });
    expect(store.claimAndEnqueue(toPersistableRepositoryEvent(issueEvent()), routes)).toMatchObject(
      { outcome: 'enqueued' },
    );
  });

  it('migrates legacy dedupe tombstones and suppresses redelivery', () => {
    const event = toPersistableRepositoryEvent(issueEvent({ deliveryId: '' }));
    writeFileSync(
      join(tempDir, 'dedupe.jsonl'),
      [
        {
          deliveryId: '',
          stableKey: 'github:issue:Acme/Project#42:opened:2026-07-17T00:00:00.000Z',
          timestamp: '2026-07-17T00:00:00.000Z',
        },
        {
          deliveryId: '',
          stableKey: `github:push:Acme/Project:refs/heads/main:${'a'.repeat(40)}`,
          timestamp: '2026-07-17T00:00:00.000Z',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
      'utf-8',
    );
    const store = queue();
    expect(store.claimAndEnqueue(event, routes)).toMatchObject({
      outcome: 'duplicate',
      duplicateState: 'legacy',
    });
    expect(
      store.isDuplicateByStableKey(`github:push:acme/project:refs/heads/main:${'a'.repeat(40)}`),
    ).toBe(true);
  });

  it('retains only the newest in-window legacy tombstones', () => {
    writeFileSync(
      join(tempDir, 'dedupe.jsonl'),
      [
        {
          deliveryId: 'expired',
          stableKey: 'expired-key',
          timestamp: '2026-07-01T00:00:00.000Z',
        },
        {
          deliveryId: 'recent-1',
          stableKey: 'recent-key-1',
          timestamp: '2026-07-16T23:57:00.000Z',
        },
        {
          deliveryId: 'recent-2',
          stableKey: 'recent-key-2',
          timestamp: '2026-07-16T23:58:00.000Z',
        },
        {
          deliveryId: 'recent-3',
          stableKey: 'recent-key-3',
          timestamp: '2026-07-16T23:59:00.000Z',
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n'),
      'utf-8',
    );

    const store = queue({ maxRecords: 2, completedRetentionMs: 24 * 60 * 60 * 1_000 });

    expect(store.getStats()).toMatchObject({ count: 2, legacyTombstones: 2 });
    expect(store.isDuplicate('recent-3')).toBe(true);
    expect(store.isDuplicate('recent-2')).toBe(true);
    expect(store.isDuplicate('recent-1')).toBe(false);
    expect(store.isDuplicate('expired')).toBe(false);
  });

  it('fails closed when persisted route or event whitelist identity is tampered', () => {
    const store = queue();
    store.claimAndEnqueue(toPersistableRepositoryEvent(issueEvent()), routes);
    const statePath = join(tempDir, 'delivery-state.v1.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      deliveries: Array<{
        event: Record<string, unknown>;
        routes: Array<{ idempotencyKey: string }>;
      }>;
    };
    const idempotencyKey = state.deliveries[0]!.routes[0]!.idempotencyKey;
    state.deliveries[0]!.routes[0]!.idempotencyKey = 'tampered';
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');

    expect(() => queue().getStats()).toThrowError(
      expect.objectContaining({ code: 'QUEUE_STATE_INVALID' }),
    );

    state.deliveries[0]!.routes[0]!.idempotencyKey = idempotencyKey;
    state.deliveries[0]!.event.title = 'must-not-enter-persisted-dto';
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    expect(() => queue().getStats()).toThrowError(
      expect.objectContaining({ code: 'QUEUE_STATE_INVALID' }),
    );
  });

  it('persists only the whitelist event DTO and non-secret route identity', () => {
    const store = queue();
    store.claimAndEnqueue(toPersistableRepositoryEvent(issueEvent()), routes);
    const persisted = readFileSync(join(tempDir, 'delivery-state.v1.json'), 'utf-8');
    expect(persisted).not.toContain('Untrusted issue title');
    expect(persisted).not.toContain('Untrusted issue body');
    expect(persisted).not.toContain('secret-looking-label');
    expect(persisted).not.toContain('untrusted-sender');
    expect(persisted).toContain('"stableKey"');
    expect(persisted).toContain('"idempotencyKey"');
  });

  it('creates an immediately completed tombstone for filtered events with no routes', () => {
    const result = queue().claimAndEnqueue(toPersistableRepositoryEvent(issueEvent()), []);
    expect(result).toMatchObject({
      outcome: 'enqueued',
      delivery: { state: 'completed', routes: [] },
    });
    expect(queue().claimNext('worker')).toBeNull();
  });

  it('rejects duplicate canonical routes before mutating state', () => {
    const store = queue();
    expect(() =>
      store.claimAndEnqueue(toPersistableRepositoryEvent(issueEvent()), [
        { sink: 'slack', channel: '#delivery' },
        { sink: 'slack', channel: '#DELIVERY' },
      ]),
    ).toThrowError(WatchDeliveryQueueError);
    expect(store.getStats().count).toBe(0);
  });
});
