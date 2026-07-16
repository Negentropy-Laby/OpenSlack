import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NotificationSink } from '../notification-sinks.js';
import { RepositoryLiveStateError } from '../repository-live-state.js';
import {
  canonicalizeRepositoryName,
  toPersistableRepositoryEvent,
  type IssueRepositoryEvent,
  type PullRequestReviewRepositoryEvent,
} from '../repository-event.js';
import { WatchDeliveryQueue } from '../watch-delivery-queue.js';
import { WatchDeliveryRouter } from '../watch-delivery-router.js';

let tempDir: string;
let now: Date;
let nonce = 0;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'openslack-delivery-router-'));
  now = new Date('2026-07-17T00:00:00.000Z');
  nonce = 0;
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function repository() {
  const value = canonicalizeRepositoryName('Acme', 'Project');
  if (!value) throw new Error('Expected repository');
  return value;
}

function issue(): IssueRepositoryEvent {
  return {
    kind: 'issue',
    eventKey: 'issues.opened',
    action: 'opened',
    repository: repository(),
    object: { kind: 'issue', id: 'acme/project#42', number: 42 },
    source: 'webhook',
    deliveryId: 'issue-delivery',
    observedAt: '2026-07-17T00:00:00.000Z',
    metadata: { informational: false, senderLogin: 'sender' },
    issueNumber: 42,
    title: 'Current issue title',
    url: 'https://github.com/Acme/Project/issues/42',
    labels: ['openslack:task'],
    body: 'body',
    senderLogin: 'sender',
    updatedAt: '2026-07-17T00:00:00.000Z',
  };
}

function review(): PullRequestReviewRepositoryEvent {
  return {
    kind: 'pull_request_review',
    eventKey: 'pull_request_review.submitted',
    action: 'submitted',
    repository: repository(),
    object: {
      kind: 'pull_request_review',
      id: 'acme/project#42:review:9001',
      number: 42,
    },
    source: 'webhook',
    deliveryId: 'review-delivery',
    observedAt: '2026-07-17T00:00:00.000Z',
    metadata: { informational: true, senderLogin: 'reviewer' },
    pullRequestNumber: 42,
    pullRequestTitle: 'Review title',
    pullRequestUrl: 'https://github.com/Acme/Project/pull/42',
    headSha: 'webhook-head',
    reviewId: 9001,
    reviewState: 'approved',
    reviewUrl: 'https://github.com/Acme/Project/pull/42#pullrequestreview-9001',
    reviewerLogin: 'reviewer',
    commitId: 'webhook-head',
    submittedAt: '2026-07-17T00:00:00.000Z',
  };
}

function queue(): WatchDeliveryQueue {
  return new WatchDeliveryQueue(tempDir, {
    now: () => new Date(now),
    nonce: () => `nonce-${++nonce}`,
    policy: {
      leaseMs: 1_000,
      baseBackoffMs: 1_000,
      maxBackoffMs: 8_000,
    },
  });
}

function sink(send: NotificationSink['send']): NotificationSink {
  return { name: 'test', send };
}

const liveState = {
  schema: 'openslack.repository_live_state.v1' as const,
  repository: repository(),
  fetchedAt: '2026-07-17T00:01:00.000Z',
  triggerHeadSha: 'webhook-head',
  pullRequests: [
    {
      pullRequestNumber: 42,
      title: 'Current PR title',
      url: 'https://github.com/Acme/Project/pull/42',
      state: 'open',
      draft: false,
      merged: false,
      headSha: 'live-head',
      baseSha: 'live-base',
      updatedAt: '2026-07-17T00:01:00.000Z',
      reviews: {
        total: 1,
        approvedObserved: 1,
        changesRequestedObserved: 0,
        commentedObserved: 0,
        dismissedObserved: 0,
        otherObserved: 0,
        informational: true as const,
        authoritativeApproval: false as const,
      },
      checks: {
        total: 1,
        pending: 0,
        successful: 1,
        failed: 0,
        neutral: 0,
        runs: [],
      },
    },
  ],
  authority: {
    humanApproval: 'not_evaluated' as const,
    mergeReadiness: 'not_evaluated' as const,
  },
  informational: true as const,
};

describe('WatchDeliveryRouter', () => {
  it('passes one stable idempotency key to each sink and completes the delivery', async () => {
    const store = queue();
    const event = issue();
    const accepted = store.claimAndEnqueue(toPersistableRepositoryEvent(event), [
      { sink: 'console' },
      { sink: 'slack', channel: '#tasks' },
    ]);
    if (accepted.outcome !== 'enqueued') throw new Error('Expected enqueue');
    const send = vi.fn().mockResolvedValue({ ok: true, outcome: 'delivered' });
    const router = new WatchDeliveryRouter({
      queue: store,
      sinks: new Map([
        ['console', sink(send)],
        ['slack', sink(send)],
      ]),
    });
    router.remember(event);

    await expect(router.drainOnce()).resolves.toMatchObject({
      claimed: 1,
      completed: 1,
    });
    expect(send).toHaveBeenCalledTimes(2);
    const keys = send.mock.calls.map((call) => call[2].idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys.sort()).toEqual(
      accepted.delivery.routes.map((route) => route.idempotencyKey).sort(),
    );
    expect(store.getDelivery(accepted.delivery.id)?.state).toBe('completed');
  });

  it('does not redeliver a completed route when another route is retried after restart', async () => {
    const store = queue();
    const event = issue();
    const accepted = store.claimAndEnqueue(toPersistableRepositoryEvent(event), [
      { sink: 'console' },
      { sink: 'webhook', name: 'outbound' },
    ]);
    if (accepted.outcome !== 'enqueued') throw new Error('Expected enqueue');
    const consoleSend = vi.fn().mockResolvedValue({ ok: true, outcome: 'delivered' });
    const webhookSend = vi.fn().mockResolvedValue({
      ok: false,
      outcome: 'retryable',
      code: 'WEBHOOK_HTTP_ERROR_503',
      error: 'Webhook delivery returned HTTP 503.',
      retryAfterMs: 5_000,
    });
    const firstRouter = new WatchDeliveryRouter({
      queue: store,
      sinks: new Map([
        ['console', sink(consoleSend)],
        ['webhook', sink(webhookSend)],
      ]),
    });
    firstRouter.remember(event);
    expect((await firstRouter.drainOnce()).retryable).toBe(1);
    expect(consoleSend).toHaveBeenCalledTimes(1);
    expect(webhookSend).toHaveBeenCalledTimes(1);
    expect(store.getDelivery(accepted.delivery.id)).toMatchObject({
      state: 'retryable',
      routes: expect.arrayContaining([
        expect.objectContaining({
          route: { sink: 'webhook', name: 'outbound' },
          availableAt: '2026-07-17T00:00:05.000Z',
        }),
      ]),
    });

    now = new Date(now.getTime() + 5_000);
    webhookSend.mockResolvedValue({ ok: true, outcome: 'delivered' });
    const restarted = new WatchDeliveryRouter({
      queue: queue(),
      sinks: new Map([
        ['console', sink(consoleSend)],
        ['webhook', sink(webhookSend)],
      ]),
    });
    expect((await restarted.drainOnce()).completed).toBe(1);
    expect(consoleSend).toHaveBeenCalledTimes(1);
    expect(webhookSend).toHaveBeenCalledTimes(2);
    expect(webhookSend.mock.calls[0]![2].idempotencyKey).toBe(
      webhookSend.mock.calls[1]![2].idempotencyKey,
    );
  });

  it('recovers a persisted event without retaining raw webhook prose', async () => {
    const store = queue();
    const accepted = store.claimAndEnqueue(toPersistableRepositoryEvent(issue()), [
      { sink: 'console' },
    ]);
    if (accepted.outcome !== 'enqueued') throw new Error('Expected enqueue');
    const send = vi.fn().mockResolvedValue({ ok: true, outcome: 'delivered' });
    const restarted = new WatchDeliveryRouter({
      queue: queue(),
      sinks: new Map([['console', sink(send)]]),
    });

    await restarted.drainOnce();

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKind: 'issue',
        title: 'Issue #42 observed',
        labels: [],
      }),
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: accepted.delivery.routes[0]!.idempotencyKey,
      }),
    );
  });

  it('fails an out-of-scope live refresh without invoking any sink', async () => {
    const store = queue();
    const event = review();
    const accepted = store.claimAndEnqueue(toPersistableRepositoryEvent(event), [
      { sink: 'console' },
    ]);
    if (accepted.outcome !== 'enqueued') throw new Error('Expected enqueue');
    const send = vi.fn();
    const recordEvent = vi.fn();
    const router = new WatchDeliveryRouter({
      queue: store,
      sinks: new Map([['console', sink(send)]]),
      recordEvent,
      refreshLiveState: async () => {
        throw new RepositoryLiveStateError(
          'LIVE_STATE_NOT_FOUND',
          false,
          'The referenced pull request was not found.',
        );
      },
    });
    router.remember(event);

    await expect(router.drainOnce()).resolves.toMatchObject({ failed: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(store.getDelivery(accepted.delivery.id)).toMatchObject({
      state: 'failed',
      lastDiagnostic: { code: 'LIVE_STATE_NOT_FOUND', retryable: false },
    });
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'notification.failed',
        metadata: expect.objectContaining({
          errorCode: 'LIVE_STATE_NOT_FOUND',
          informational: true,
        }),
      }),
    );
  });

  it('keeps transient live refresh failures retryable', async () => {
    const store = queue();
    const event = review();
    const accepted = store.claimAndEnqueue(toPersistableRepositoryEvent(event), [
      { sink: 'console' },
    ]);
    if (accepted.outcome !== 'enqueued') throw new Error('Expected enqueue');
    const send = vi.fn();
    const router = new WatchDeliveryRouter({
      queue: store,
      sinks: new Map([['console', sink(send)]]),
      refreshLiveState: async () => {
        throw new RepositoryLiveStateError(
          'LIVE_STATE_UNAVAILABLE',
          true,
          'Live evidence is temporarily unavailable.',
        );
      },
    });
    router.remember(event);

    await expect(router.drainOnce()).resolves.toMatchObject({ retryable: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(store.getDelivery(accepted.delivery.id)).toMatchObject({
      state: 'retryable',
      availableAt: '2026-07-17T00:00:01.000Z',
    });
  });

  it('routes an approved review only as an informational live observation', async () => {
    const store = queue();
    const event = review();
    store.claimAndEnqueue(toPersistableRepositoryEvent(event), [{ sink: 'console' }]);
    const send = vi.fn().mockResolvedValue({ ok: true, outcome: 'delivered' });
    const router = new WatchDeliveryRouter({
      queue: store,
      sinks: new Map([['console', sink(send)]]),
      refreshLiveState: async () => liveState,
    });
    router.remember(event);

    await router.drainOnce();

    const payload = send.mock.calls[0]![0];
    expect(payload).toMatchObject({
      objectKind: 'review',
      reviewState: 'approved',
      informational: true,
      headSha: 'live-head',
      liveState: {
        informational: true,
        authority: {
          humanApproval: 'not_evaluated',
          mergeReadiness: 'not_evaluated',
        },
        pullRequests: [
          {
            reviews: {
              approvedObserved: 1,
              authoritativeApproval: false,
            },
          },
        ],
      },
    });
    expect(JSON.stringify(payload)).not.toContain('"approved":true');
    expect(JSON.stringify(payload)).not.toContain('READY_TO_MERGE');
  });
});
