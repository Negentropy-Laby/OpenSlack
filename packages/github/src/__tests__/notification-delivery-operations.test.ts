import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotificationDeliveryOperations } from '../notification-delivery-operations.js';
import type { NotificationVendorEvidence } from '../notification-reconciliation.js';
import type { NotificationAcceptanceReceiptV1 } from '../notification-receipt-store.js';
import { NotificationServiceOpsClient } from '../notification-service-ops-client.js';
import { WatchDeliveryQueueV2 } from '../watch-delivery-queue-v2.js';
import {
  canonicalizeRepositoryName,
  toPersistableRepositoryEvent,
  type IssueRepositoryEvent,
  type PersistableRepositoryEvent,
} from '../repository-event.js';
import type { GitHubWatchRouteV2 } from '../watch-config-v2.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-notification-operations-'));
  roots.push(root);
  mkdirSync(join(root, '.openslack', 'monitors'), { recursive: true });
  return root;
}

function event(): PersistableRepositoryEvent {
  const repository = canonicalizeRepositoryName('Negentropy-Laby', 'canary');
  if (!repository) throw new Error('Expected repository');
  const source: IssueRepositoryEvent = {
    kind: 'issue',
    eventKey: 'issues.opened',
    action: 'opened',
    repository,
    object: { kind: 'issue', id: 'negentropy-laby/canary#1', number: 1 },
    source: 'webhook',
    deliveryId: 'delivery-1',
    observedAt: '2026-07-23T00:00:00.000Z',
    metadata: { informational: false, senderLogin: 'canary' },
    issueNumber: 1,
    title: 'Canary',
    url: 'https://github.com/Negentropy-Laby/canary/issues/1',
    labels: [],
    body: 'Not persisted',
    senderLogin: 'canary',
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
  return toPersistableRepositoryEvent(source);
}

const route: GitHubWatchRouteV2 = {
  id: 'webhook-primary',
  sink: 'webhook',
  delivery: {
    backend: 'notification_service',
    vendor_id: 'openslack-webhook',
    routing_epoch: 1,
  },
};

function enqueue(operations: NotificationDeliveryOperations, persistBlob = true) {
  const bytes = Buffer.from('{"canary":true}', 'utf8');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
  if (persistBlob) operations.blobStore.put({ bytes, digest, size: bytes.byteLength });
  const result = operations.queueV2.enqueueRoutes(event(), [
    {
      route,
      blob: {
        digest,
        size: bytes.byteLength,
        mediaType: 'application/json',
        encoderVersion: 'openslack.webhook_notification.v1',
      },
      watchConfigDigest: `sha256:${'b'.repeat(64)}`,
    },
  ]);
  if (result.outcome === 'conflict') throw new Error('Expected route');
  return result.routes[0]!;
}

describe('NotificationDeliveryOperations', () => {
  it('previews and applies retry without exposing or replacing immutable fields', () => {
    const operations = new NotificationDeliveryOperations({ workspaceRoot: workspace() });
    const record = enqueue(operations);
    const claim = operations.queueV2.claimNext('worker', 'notification_service');
    if (!claim) throw new Error('Expected claim');
    operations.queueV2.markRejected(record.id, claim.lease.token, 'deterministic_rejection', {
      code: 'UNAUTHORIZED',
      message: 'Rejected.',
      status: 401,
    });

    const preview = operations.retry(record.id, {
      operator: 'operator-1',
      reason: 'Credential rotation verified.',
      apply: false,
    });
    expect(preview.state).toBe('rejected');
    expect(operations.queueV2.getRoute(record.id)?.state).toBe('rejected');

    const applied = operations.retry(record.id, {
      operator: 'operator-1',
      reason: 'Credential rotation verified.',
      apply: true,
    });
    expect(applied).toMatchObject({
      id: record.id,
      idempotencyKey: record.idempotencyKey,
      vendorId: record.vendorId,
      blob: record.blob,
      state: 'pending',
      recoveryCycle: 1,
    });
    expect(JSON.stringify(operations.listRoutes())).not.toContain('stableKey');
    expect(JSON.stringify(operations.listRoutes())).not.toContain('idempotencyKey');
  });

  it('fails retry closed when the original Blob is unavailable', () => {
    const operations = new NotificationDeliveryOperations({ workspaceRoot: workspace() });
    const record = enqueue(operations, false);
    const claim = operations.queueV2.claimNext('worker', 'notification_service');
    if (!claim) throw new Error('Expected claim');
    operations.queueV2.markRejected(record.id, claim.lease.token, 'deterministic_rejection', {
      code: 'BAD_REQUEST',
      message: 'Rejected.',
      status: 400,
    });

    expect(() =>
      operations.retry(record.id, {
        operator: 'operator-1',
        reason: 'Attempted recovery.',
        apply: true,
      }),
    ).toThrow('BLOB_NOT_AVAILABLE');
    expect(operations.queueV2.getRoute(record.id)?.state).toBe('rejected');
  });

  it('reports Blob integrity failure without exposing storage diagnostics', () => {
    const operations = new NotificationDeliveryOperations({ workspaceRoot: workspace() });
    const record = enqueue(operations);
    const claim = operations.queueV2.claimNext('worker', 'notification_service');
    if (!claim) throw new Error('Expected claim');
    operations.queueV2.markRejected(record.id, claim.lease.token, 'deterministic_rejection', {
      code: 'BAD_REQUEST',
      message: 'Rejected.',
      status: 400,
    });
    writeFileSync(operations.blobStore.pathFor(record.blob!.digest), '{"canary":null}', 'utf8');

    expect(() =>
      operations.retry(record.id, {
        operator: 'operator-1',
        reason: 'Attempted recovery.',
        apply: true,
      }),
    ).toThrow('BLOB_INTEGRITY_FAILED');
    expect(operations.queueV2.getRoute(record.id)).toMatchObject({
      state: 'rejected',
      authority: 'terminal',
      recoveryCycle: 0,
    });
  });

  it('reconciles accepted receipt, remote state and vendor metadata without reading payload bytes', async () => {
    const root = workspace();
    writeWatchConfig(root, `sha256:${'c'.repeat(64)}`);
    let evidence: NotificationVendorEvidence | null = null;
    const operations = new NotificationDeliveryOperations({
      workspaceRoot: root,
      opsClient: deliveredOpsClient(`sha256:${'c'.repeat(64)}`),
      vendorEvidence: { read: () => evidence },
    });
    const record = enqueue(operations);
    const claim = operations.queueV2.claimNext('worker', 'notification_service');
    if (!claim) throw new Error('Expected claim');
    const receipt: NotificationAcceptanceReceiptV1 = {
      schema: 'openslack.notification_acceptance.v1',
      route_record_id: record.id,
      canonical_repository: record.canonicalRepository,
      route_id: record.routeId,
      routing_epoch: record.routingEpoch,
      vendor_id: record.vendorId!,
      idempotency_key: record.idempotencyKey,
      notification_id: 'notification-1',
      remote_request_id: 'request-1',
      accepted_at: '2026-07-23T00:00:00.000Z',
      idempotent_replay: false,
      deployment_digest: `sha256:${'c'.repeat(64)}`,
      watch_config_digest: record.watchConfigDigest!,
      recorded_at: '2026-07-23T00:00:00.000Z',
    };
    operations.queueV2.acceptServiceRoute(
      record.id,
      claim.lease.token,
      receipt,
      operations.receiptStore,
    );
    evidence = {
      schema: 'openslack.notification_vendor_evidence.v1',
      route_record_id: record.id,
      vendor_id: record.vendorId!,
      idempotency_key: record.idempotencyKey,
      body_digest: record.blob!.digest,
      body_size: record.blob!.size,
      source: 'webhook',
      delivered_at: '2026-07-23T00:00:02.000Z',
      recorded_at: '2026-07-23T00:00:03.000Z',
    };

    await expect(operations.reconcile(record.id)).resolves.toMatchObject({
      outcome: 'consistent',
      notificationId: 'notification-1',
      remoteDeliveryState: 'delivered',
    });
  });

  it('validates v2 config, queue, Blob, receipt and credential reference in doctor', async () => {
    const root = workspace();
    writeWatchConfig(root);
    const operations = new NotificationDeliveryOperations({
      workspaceRoot: root,
      credentialStore: {
        withSecret: (_reference, operation) => operation('fixture-secret'),
      },
      auditorCredentialRef: 'env:OPENSLACK_CANARY_AUDITOR_KEY',
      opsClient: deliveredOpsClient(`sha256:${'d'.repeat(64)}`),
      vendorEvidence: { read: () => null },
    });
    enqueue(operations);

    const report = await operations.doctor();
    expect(report.ready).toBe(true);
    expect(report.checks.every((check) => check.passed)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('fixture-secret');
  });

  it('fails doctor closed when queue references cannot be enumerated', async () => {
    const root = workspace();
    writeWatchConfig(root);
    const operations = new NotificationDeliveryOperations({
      workspaceRoot: root,
      credentialStore: {
        withSecret: (_reference, operation) => operation('fixture-secret'),
      },
    });
    writeFileSync(operations.queueV2.statePath, '{"schema":', 'utf8');

    const report = await operations.doctor();

    expect(report.ready).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'queue_v2', code: 'QUEUE_V2_INVALID', passed: false }),
        expect.objectContaining({
          name: 'active_blobs',
          code: 'ACTIVE_BLOBS_UNAVAILABLE',
          passed: false,
        }),
        expect.objectContaining({
          name: 'accepted_receipts',
          code: 'ACCEPTED_RECEIPTS_UNAVAILABLE',
          passed: false,
        }),
      ]),
    );
    expect(JSON.stringify(report)).not.toContain('fixture-secret');
  });

  it('requires accepted receipt crash recovery before doctor can pass', async () => {
    const root = workspace();
    writeWatchConfig(root);
    const operations = new NotificationDeliveryOperations({
      workspaceRoot: root,
      credentialStore: {
        withSecret: (_reference, operation) => operation('fixture-secret'),
      },
    });
    const record = enqueue(operations);
    const crashingQueue = new WatchDeliveryQueueV2(join(root, '.openslack.local', 'daemon'), {
      acceptanceCheckpoint: (checkpoint) => {
        if (checkpoint === 'embedded_receipt_persisted') throw new Error('CRASH');
      },
    });
    const claim = crashingQueue.claimNext('worker', 'notification_service');
    if (!claim) throw new Error('Expected claim');
    expect(() =>
      crashingQueue.acceptServiceRoute(
        record.id,
        claim.lease.token,
        acceptanceReceipt(record),
        operations.receiptStore,
      ),
    ).toThrow('CRASH');

    const beforeRecovery = await operations.doctor();
    expect(beforeRecovery.ready).toBe(false);
    expect(beforeRecovery.checks).toContainEqual(
      expect.objectContaining({
        name: 'accepted_receipts',
        code: 'ACCEPTED_RECEIPT_RECOVERY_REQUIRED',
        passed: false,
      }),
    );

    expect(operations.queueV2.recoverAcceptedReceipts(operations.receiptStore)).toBe(1);
    const afterRecovery = await operations.doctor();
    expect(afterRecovery.checks).toContainEqual(
      expect.objectContaining({
        name: 'accepted_receipts',
        code: 'ACCEPTED_RECEIPTS_VALID',
        passed: true,
      }),
    );
  });

  it('detects same-size active Blob corruption instead of trusting metadata size', async () => {
    const root = workspace();
    writeWatchConfig(root);
    const operations = new NotificationDeliveryOperations({
      workspaceRoot: root,
      credentialStore: {
        withSecret: (_reference, operation) => operation('fixture-secret'),
      },
    });
    const record = enqueue(operations);
    writeFileSync(operations.blobStore.pathFor(record.blob!.digest), '{"canary":null}', 'utf8');

    const report = await operations.doctor();

    expect(report.ready).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: 'active_blobs',
        code: 'ACTIVE_BLOBS_INVALID',
        passed: false,
      }),
    );
  });

  it('rejects Canary artifacts that could expose payload fields', () => {
    const root = workspace();
    const artifactRoot = join(root, '.openslack.local', 'daemon', 'notification-canary');
    mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(artifactRoot, 'status.json'),
      JSON.stringify({
        schema: 'openslack.notification_canary_status.v1',
        status: 'running',
        payload: 'must-not-be-rendered',
      }),
      'utf8',
    );
    if (process.platform !== 'win32') chmodSync(join(artifactRoot, 'status.json'), 0o600);
    const operations = new NotificationDeliveryOperations({ workspaceRoot: root });

    expect(() => operations.readCanaryArtifact('status')).toThrow('CANARY_ARTIFACT_INVALID');
  });
  it('reads a bounded regular Canary artifact and rejects a symlink', () => {
    const root = workspace();
    const artifactRoot = join(root, '.openslack.local', 'daemon', 'notification-canary');
    mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
    const target = join(artifactRoot, 'sealed.json');
    const statusPath = join(artifactRoot, 'status.json');
    writeFileSync(
      target,
      JSON.stringify({
        schema: 'openslack.notification_canary_status.v1',
        status: 'running',
        distinct_accepted: 8,
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    try {
      symlinkSync(target, statusPath, 'file');
    } catch {
      return;
    }

    const operations = new NotificationDeliveryOperations({ workspaceRoot: root });
    expect(() => operations.readCanaryArtifact('status')).toThrow('CANARY_ARTIFACT_INVALID');
  });

  it('rejects a Canary artifact that grows after its descriptor is opened', () => {
    const root = workspace();
    const artifactRoot = join(root, '.openslack.local', 'daemon', 'notification-canary');
    mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
    const statusPath = join(artifactRoot, 'status.json');
    writeFileSync(
      statusPath,
      JSON.stringify({
        schema: 'openslack.notification_canary_status.v1',
        status: 'running',
      }),
      { encoding: 'utf8', mode: 0o600 },
    );
    const operations = new NotificationDeliveryOperations({
      workspaceRoot: root,
      canaryReadCheckpoint: () => {
        writeFileSync(statusPath, Buffer.alloc(64 * 1024 + 1, 'x'), { mode: 0o600 });
      },
    });

    expect(() => operations.readCanaryArtifact('status')).toThrow('CANARY_ARTIFACT_INVALID');
  });
});

function acceptanceReceipt(record: ReturnType<typeof enqueue>): NotificationAcceptanceReceiptV1 {
  return {
    schema: 'openslack.notification_acceptance.v1',
    route_record_id: record.id,
    canonical_repository: record.canonicalRepository,
    route_id: record.routeId,
    routing_epoch: record.routingEpoch,
    vendor_id: record.vendorId!,
    idempotency_key: record.idempotencyKey,
    notification_id: 'notification-crash-recovery',
    remote_request_id: 'request-crash-recovery',
    accepted_at: '2026-07-23T00:00:00.000Z',
    idempotent_replay: false,
    deployment_digest: `sha256:${'c'.repeat(64)}`,
    watch_config_digest: record.watchConfigDigest!,
    recorded_at: '2026-07-23T00:00:00.000Z',
  };
}

function writeWatchConfig(
  root: string,
  deploymentDigest: `sha256:${string}` = `sha256:${'d'.repeat(64)}`,
): void {
  writeFileSync(
    join(root, '.openslack', 'monitors', 'github-watch.yaml'),
    `schema: openslack.github_watch.v2
notification_service:
  endpoint: https://notifications.example.test
  credential_ref: env:OPENSLACK_NOTIFICATION_SERVICE_KEY
  expected_deployment_digest: ${deploymentDigest}
repositories:
  - owner: Negentropy-Laby
    repo: canary
    events: [issues.opened]
    routes:
      - id: webhook-primary
        sink: webhook
        delivery:
          backend: notification_service
          vendor_id: openslack-webhook
          routing_epoch: 1
`,
    'utf8',
  );
}

function deliveredOpsClient(deploymentDigest: `sha256:${string}`): NotificationServiceOpsClient {
  return new NotificationServiceOpsClient({
    endpoint: 'https://notifications.example.test',
    credentialRef: 'env:OPENSLACK_CANARY_AUDITOR_KEY',
    expectedDeploymentDigest: deploymentDigest,
    credentialStore: {
      withSecret: (_reference, operation) => operation('fixture-auditor-key'),
    },
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/health/version')) {
        return response({ ready: true, deployment_digest: deploymentDigest });
      }
      if (url.includes('/attempts?')) {
        return response({
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
                recorded_at: '2026-07-23T00:00:02.000Z',
              },
            ],
          },
        });
      }
      return response({
        request_id: 'request-status',
        data: {
          notification_id: 'notification-1',
          vendor_id: 'openslack-webhook',
          state: 'delivered',
          version: 3,
          attempt_count: 1,
          delivery_cycle_started_at: '2026-07-23T00:00:00.000Z',
          replay_count: 0,
          last_outcome_class: 'success',
          created_at: '2026-07-23T00:00:00.000Z',
          delivered_at: '2026-07-23T00:00:02.000Z',
        },
      });
    },
  });
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
