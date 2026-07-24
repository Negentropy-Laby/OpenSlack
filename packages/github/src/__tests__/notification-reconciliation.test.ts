import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NotificationDeliveryReconciler,
  NotificationVendorEvidenceStore,
  type NotificationVendorEvidence,
} from '../notification-reconciliation.js';
import { NotificationReceiptStore } from '../notification-receipt-store.js';
import { NotificationServiceOpsClient } from '../notification-service-ops-client.js';
import {
  canonicalizeRepositoryName,
  toPersistableRepositoryEvent,
  type IssueRepositoryEvent,
} from '../repository-event.js';
import {
  WatchDeliveryQueueV2,
  type WatchRouteBlobReferenceV2,
} from '../watch-delivery-queue-v2.js';
import type { GitHubWatchRouteV2 } from '../watch-config-v2.js';

const roots: string[] = [];
const EXPECTED_DIGEST = `sha256:${'c'.repeat(64)}` as const;
const WATCH_CONFIG_DIGEST = `sha256:${'b'.repeat(64)}` as const;
const BLOB: WatchRouteBlobReferenceV2 = {
  digest: `sha256:${'a'.repeat(64)}`,
  size: 128,
  mediaType: 'application/json',
  encoderVersion: 'openslack.slack_chat_post_message.v1',
};
const ROUTE: GitHubWatchRouteV2 = {
  id: 'slack-primary',
  sink: 'slack',
  channel: '#canary',
  delivery: {
    backend: 'notification_service',
    vendor_id: 'openslack-slack',
    routing_epoch: 1,
  },
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('NotificationDeliveryReconciler', () => {
  it('publishes a closed vendor evidence schema matching the runtime contract', () => {
    const schema = JSON.parse(
      readFileSync(new URL('../notification-vendor-evidence.schema.json', import.meta.url), 'utf8'),
    ) as object;
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
    const fixture = acceptedFixture();
    const evidence = vendorEvidence(fixture.route.id, fixture.route.idempotencyKey);
    expect(validate(evidence)).toBe(true);
    expect(validate({ ...evidence, payload: 'forbidden' })).toBe(false);
    expect(validate({ ...evidence, body_size: 262_145 })).toBe(false);
    writeEvidence(fixture.vendorRoot, { ...evidence, body_size: 262_145 });
    expect(() =>
      new NotificationVendorEvidenceStore(fixture.vendorRoot).read(fixture.route.id),
    ).toThrow('VENDOR_EVIDENCE_INVALID');
  });

  it('projects delivered only after receipt, service and vendor evidence agree', async () => {
    const fixture = acceptedFixture();
    writeEvidence(
      fixture.vendorRoot,
      vendorEvidence(fixture.route.id, fixture.route.idempotencyKey),
    );
    const reconciler = new NotificationDeliveryReconciler({
      queue: fixture.queue,
      receiptStore: fixture.receiptStore,
      opsClient: opsClient(),
      vendorEvidence: new NotificationVendorEvidenceStore(fixture.vendorRoot),
      now: () => new Date('2026-07-23T00:00:04Z'),
    });

    await expect(reconciler.reconcile(fixture.route.id)).resolves.toEqual({
      schema: 'openslack.notification_reconciliation.v1',
      outcome: 'consistent',
      checkedAt: '2026-07-23T00:00:04.000Z',
      routeRecordId: fixture.route.id,
      notificationId: 'notification-42',
      vendorId: 'openslack-slack',
      remoteDeliveryState: 'delivered',
      vendorEvidenceSource: 'slack',
      vendorConfigVersion: 2,
    });
    expect(fixture.queue.getRoute(fixture.route.id)?.remoteDeliveryState).toBe('delivered');
  });

  it.each([
    ['wrong source', { source: 'webhook' }],
    ['wrong vendor', { vendor_id: 'other-vendor' }],
    ['delivery before acceptance', { delivered_at: '2026-07-22T23:59:59Z' }],
  ])('fails closed for %s vendor evidence', async (_name, patch) => {
    const fixture = acceptedFixture();
    writeEvidence(fixture.vendorRoot, {
      ...vendorEvidence(fixture.route.id, fixture.route.idempotencyKey),
      ...patch,
    } as NotificationVendorEvidence);
    const result = await new NotificationDeliveryReconciler({
      queue: fixture.queue,
      receiptStore: fixture.receiptStore,
      opsClient: opsClient(),
      vendorEvidence: new NotificationVendorEvidenceStore(fixture.vendorRoot),
    }).reconcile(fixture.route.id);
    expect(result).toMatchObject({ outcome: 'conflict', code: 'VENDOR_EVIDENCE_CONFLICT' });
    expect(fixture.queue.getRoute(fixture.route.id)?.remoteDeliveryState).toBe('pending');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects permissive or linked vendor evidence files',
    async () => {
      const fixture = acceptedFixture();
      const path = writeEvidence(
        fixture.vendorRoot,
        vendorEvidence(fixture.route.id, fixture.route.idempotencyKey),
      );
      chmodSync(path, 0o644);
      const result = await new NotificationDeliveryReconciler({
        queue: fixture.queue,
        receiptStore: fixture.receiptStore,
        opsClient: opsClient(),
        vendorEvidence: new NotificationVendorEvidenceStore(fixture.vendorRoot),
      }).reconcile(fixture.route.id);
      expect(result).toMatchObject({ outcome: 'conflict', code: 'VENDOR_EVIDENCE_INVALID' });
    },
  );

  it('does not allow a delivered remote projection to regress', async () => {
    const fixture = acceptedFixture();
    fixture.queue.projectRemoteDelivery(fixture.route.id, 'notification-42', 'delivered');
    expect(() =>
      fixture.queue.projectRemoteDelivery(fixture.route.id, 'notification-42', 'pending'),
    ).toThrowError(expect.objectContaining({ code: 'QUEUE_TRANSITION_INVALID' }));
  });
});

function acceptedFixture() {
  const root = temporaryRoot('openslack-reconcile-');
  const daemonRoot = join(root, 'daemon');
  const receiptRoot = join(root, 'receipts');
  const vendorRoot = join(root, 'vendor-evidence');
  const queue = new WatchDeliveryQueueV2(daemonRoot, {
    now: () => new Date('2026-07-23T00:00:00Z'),
    nonce: () => 'reconcile-nonce',
  });
  const event = toPersistableRepositoryEvent(issueEvent());
  const enqueue = queue.enqueueRoutes(event, [
    { route: ROUTE, blob: BLOB, watchConfigDigest: WATCH_CONFIG_DIGEST },
  ]);
  if (enqueue.outcome === 'conflict') throw new Error('Unexpected enqueue conflict.');
  const route = enqueue.routes[0]!;
  const claim = queue.claimNext('worker-1', 'notification_service');
  if (!claim) throw new Error('Expected service claim.');
  const receiptStore = new NotificationReceiptStore({ rootPath: receiptRoot });
  queue.acceptServiceRoute(
    route.id,
    claim.lease.token,
    {
      schema: 'openslack.notification_acceptance.v1',
      route_record_id: route.id,
      canonical_repository: route.canonicalRepository,
      route_id: route.routeId,
      routing_epoch: route.routingEpoch,
      vendor_id: route.vendorId!,
      idempotency_key: route.idempotencyKey,
      notification_id: 'notification-42',
      remote_request_id: 'request-42',
      accepted_at: '2026-07-23T00:00:00Z',
      idempotent_replay: false,
      deployment_digest: EXPECTED_DIGEST,
      watch_config_digest: WATCH_CONFIG_DIGEST,
      recorded_at: '2026-07-23T00:00:01Z',
    },
    receiptStore,
  );
  return { queue, receiptStore, route, vendorRoot };
}

function opsClient(): NotificationServiceOpsClient {
  return new NotificationServiceOpsClient({
    endpoint: 'https://notification.internal',
    credentialRef: 'keychain:openslack/canary-auditor',
    expectedDeploymentDigest: EXPECTED_DIGEST,
    credentialStore: {
      withSecret: (_reference, consumer) => consumer('auditor-key'),
    },
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/health/version')) {
        return jsonResponse({ ready: true, deployment_digest: EXPECTED_DIGEST });
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
          notification_id: 'notification-42',
          vendor_id: 'openslack-slack',
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
}

function vendorEvidence(routeRecordId: string, idempotencyKey: string): NotificationVendorEvidence {
  return {
    schema: 'openslack.notification_vendor_evidence.v1',
    route_record_id: routeRecordId,
    vendor_id: 'openslack-slack',
    idempotency_key: idempotencyKey,
    body_digest: BLOB.digest,
    body_size: BLOB.size,
    source: 'slack',
    delivered_at: '2026-07-23T00:00:02Z',
    recorded_at: '2026-07-23T00:00:03Z',
  };
}

function writeEvidence(root: string, evidence: NotificationVendorEvidence): string {
  const store = new NotificationVendorEvidenceStore(root);
  const path = join(store.rootPath, `${evidence.route_record_id}.json`);
  writeFileSync(path, JSON.stringify(evidence), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return path;
}

function issueEvent(): IssueRepositoryEvent {
  const repository = canonicalizeRepositoryName('Negentropy-Laby', 'Canary');
  if (!repository) throw new Error('Expected canonical repository.');
  return {
    kind: 'issue',
    eventKey: 'issues.opened',
    action: 'opened',
    repository,
    object: { kind: 'issue', id: 'negentropy-laby/canary#42', number: 42 },
    source: 'webhook',
    deliveryId: 'delivery-42',
    observedAt: '2026-07-23T00:00:00Z',
    metadata: { informational: false, senderLogin: 'canary' },
    issueNumber: 42,
    title: 'Canary event',
    url: 'https://github.com/Negentropy-Laby/Canary/issues/42',
    labels: [],
    body: '',
    senderLogin: 'canary',
    updatedAt: '2026-07-23T00:00:00Z',
  };
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
