import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  NOTIFICATION_HANDOFF_POLICY,
  isNotificationDeploymentDigest,
  isNotificationHandoffIdempotencyKey,
  isNotificationHandoffVendorId,
  isNotificationRouteRecordId,
} from './notification-handoff-contracts.js';
import type { NotificationReceiptStore } from './notification-receipt-store.js';
import { ensureSecureNotificationDirectory, isNodeError } from './notification-storage-fs.js';
import type {
  NotificationServiceAttempt,
  NotificationServiceOpsClient,
} from './notification-service-ops-client.js';
import type { WatchDeliveryQueueV2 } from './watch-delivery-queue-v2.js';

export const NOTIFICATION_VENDOR_EVIDENCE_SCHEMA = 'openslack.notification_vendor_evidence.v1';

export interface NotificationVendorEvidence {
  schema: typeof NOTIFICATION_VENDOR_EVIDENCE_SCHEMA;
  route_record_id: string;
  vendor_id: string;
  idempotency_key: string;
  body_digest: `sha256:${string}`;
  body_size: number;
  source: 'slack' | 'webhook';
  delivered_at: string;
  recorded_at: string;
}

export interface NotificationVendorEvidenceSource {
  read(routeRecordId: string): NotificationVendorEvidence | null;
}

export class NotificationVendorEvidenceStore implements NotificationVendorEvidenceSource {
  readonly rootPath: string;

  constructor(rootPath: string) {
    this.rootPath = ensureSecureNotificationDirectory(resolve(rootPath));
  }

  read(routeRecordId: string): NotificationVendorEvidence | null {
    if (!isNotificationRouteRecordId(routeRecordId)) return null;
    const path = join(this.rootPath, `${routeRecordId}.json`);
    let pathStatus;
    try {
      pathStatus = lstatSync(path, { bigint: true });
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }
    if (
      !pathStatus.isFile() ||
      pathStatus.isSymbolicLink() ||
      pathStatus.size <= 0 ||
      pathStatus.size > BigInt(16 * 1024) ||
      (process.platform !== 'win32' && (Number(pathStatus.mode) & 0o777) !== 0o600)
    ) {
      throw new Error('VENDOR_EVIDENCE_FILE_UNSAFE');
    }
    const descriptor = openSync(path, 'r');
    let bytes: Buffer;
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (!before.isFile() || before.dev !== pathStatus.dev || before.ino !== pathStatus.ino) {
        throw new Error('VENDOR_EVIDENCE_READ_RACE');
      }
      bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      const afterPath = lstatSync(path, { bigint: true });
      if (
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        afterPath.isSymbolicLink() ||
        !afterPath.isFile() ||
        afterPath.dev !== before.dev ||
        afterPath.ino !== before.ino
      ) {
        throw new Error('VENDOR_EVIDENCE_READ_RACE');
      }
    } finally {
      closeSync(descriptor);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('VENDOR_EVIDENCE_INVALID');
    }
    const evidence = parseVendorEvidence(parsed);
    if (!evidence) throw new Error('VENDOR_EVIDENCE_INVALID');
    return evidence;
  }
}

export type NotificationReconciliationReport =
  | {
      schema: 'openslack.notification_reconciliation.v1';
      outcome: 'consistent';
      checkedAt: string;
      routeRecordId: string;
      notificationId: string;
      vendorId: string;
      remoteDeliveryState: 'delivered';
      vendorEvidenceSource: 'slack' | 'webhook';
      vendorConfigVersion: number;
    }
  | {
      schema: 'openslack.notification_reconciliation.v1';
      outcome: 'pending' | 'dead';
      checkedAt: string;
      routeRecordId: string;
      notificationId: string;
      vendorId: string;
      remoteDeliveryState: 'pending' | 'dead';
    }
  | {
      schema: 'openslack.notification_reconciliation.v1';
      outcome: 'conflict' | 'unavailable' | 'vendor_evidence_required';
      checkedAt: string;
      routeRecordId: string;
      code: string;
    };

export interface NotificationDeliveryReconcilerOptions {
  queue: WatchDeliveryQueueV2;
  receiptStore: NotificationReceiptStore;
  opsClient: NotificationServiceOpsClient;
  vendorEvidence: NotificationVendorEvidenceSource;
  now?: () => Date;
}

/**
 * Reconciles local authority receipt, service status/attempt snapshot, and
 * metadata-only vendor evidence. It never reads or renders vendor body bytes.
 */
export class NotificationDeliveryReconciler {
  private readonly queue: WatchDeliveryQueueV2;
  private readonly receiptStore: NotificationReceiptStore;
  private readonly opsClient: NotificationServiceOpsClient;
  private readonly vendorEvidence: NotificationVendorEvidenceSource;
  private readonly now: () => Date;

  constructor(options: NotificationDeliveryReconcilerOptions) {
    this.queue = options.queue;
    this.receiptStore = options.receiptStore;
    this.opsClient = options.opsClient;
    this.vendorEvidence = options.vendorEvidence;
    this.now = options.now ?? (() => new Date());
  }

  async reconcile(
    routeRecordId: string,
    signal?: AbortSignal,
  ): Promise<NotificationReconciliationReport> {
    const checkedAt = this.now().toISOString();
    const base = {
      schema: 'openslack.notification_reconciliation.v1' as const,
      checkedAt,
      routeRecordId,
    };
    const route = this.queue.getRoute(routeRecordId);
    if (
      !route ||
      route.backend !== 'notification_service' ||
      route.state !== 'accepted' ||
      route.authority !== 'notification_service' ||
      route.receiptLedger !== 'committed' ||
      !route.receipt ||
      !route.blob ||
      !route.vendorId
    ) {
      return { ...base, outcome: 'conflict', code: 'LOCAL_ACCEPTANCE_INVALID' };
    }
    try {
      this.receiptStore.verify(route.receipt);
    } catch {
      return { ...base, outcome: 'conflict', code: 'LOCAL_RECEIPT_INVALID' };
    }

    const version = await this.opsClient.version(signal);
    if (version.kind !== 'ok') {
      return {
        ...base,
        outcome: version.kind === 'protocol_error' ? 'conflict' : 'unavailable',
        code:
          version.kind === 'protocol_error'
            ? version.code
            : version.kind === 'not_ready'
              ? 'SERVICE_NOT_READY'
              : version.code,
      };
    }

    const remote = await this.opsClient.notification(route.receipt.notification_id, signal);
    if (remote.kind !== 'ok') {
      return {
        ...base,
        outcome: remote.kind === 'retryable' ? 'unavailable' : 'conflict',
        code: remote.code,
      };
    }
    if (
      remote.data.notificationId !== route.receipt.notification_id ||
      remote.data.vendorId !== route.vendorId
    ) {
      return { ...base, outcome: 'conflict', code: 'REMOTE_IDENTITY_CONFLICT' };
    }

    if (remote.data.state === 'pending' || remote.data.state === 'in_flight') {
      this.queue.projectRemoteDelivery(route.id, remote.data.notificationId, 'pending');
      return {
        ...base,
        outcome: 'pending',
        notificationId: remote.data.notificationId,
        vendorId: remote.data.vendorId,
        remoteDeliveryState: 'pending',
      };
    }
    if (remote.data.state === 'dead') {
      this.queue.projectRemoteDelivery(route.id, remote.data.notificationId, 'dead');
      return {
        ...base,
        outcome: 'dead',
        notificationId: remote.data.notificationId,
        vendorId: remote.data.vendorId,
        remoteDeliveryState: 'dead',
      };
    }

    const attempts = await this.opsClient.attempts(remote.data.notificationId, signal);
    if (attempts.kind !== 'ok') {
      return {
        ...base,
        outcome: attempts.kind === 'retryable' ? 'unavailable' : 'conflict',
        code: attempts.code,
      };
    }
    const successful = latestSuccessfulAttempt(attempts.data);
    if (!successful?.configVersion) {
      return { ...base, outcome: 'conflict', code: 'SUCCESS_CONFIG_VERSION_MISSING' };
    }
    let vendor: NotificationVendorEvidence | null;
    try {
      vendor = this.vendorEvidence.read(route.id);
    } catch {
      return { ...base, outcome: 'conflict', code: 'VENDOR_EVIDENCE_INVALID' };
    }
    if (!vendor) {
      return { ...base, outcome: 'vendor_evidence_required', code: 'VENDOR_EVIDENCE_MISSING' };
    }
    const expectedSource =
      route.blob.encoderVersion === 'openslack.slack_chat_post_message.v1' ? 'slack' : 'webhook';
    if (
      vendor.route_record_id !== route.id ||
      vendor.vendor_id !== route.vendorId ||
      vendor.idempotency_key !== route.idempotencyKey ||
      vendor.body_digest !== route.blob.digest ||
      vendor.body_size !== route.blob.size ||
      vendor.source !== expectedSource ||
      Date.parse(vendor.delivered_at) < Date.parse(route.receipt.accepted_at) ||
      Date.parse(vendor.recorded_at) < Date.parse(vendor.delivered_at)
    ) {
      return { ...base, outcome: 'conflict', code: 'VENDOR_EVIDENCE_CONFLICT' };
    }

    this.queue.projectRemoteDelivery(route.id, remote.data.notificationId, 'delivered');
    return {
      ...base,
      outcome: 'consistent',
      notificationId: remote.data.notificationId,
      vendorId: remote.data.vendorId,
      remoteDeliveryState: 'delivered',
      vendorEvidenceSource: vendor.source,
      vendorConfigVersion: successful.configVersion,
    };
  }
}

function latestSuccessfulAttempt(
  attempts: readonly NotificationServiceAttempt[],
): NotificationServiceAttempt | undefined {
  return [...attempts]
    .sort((left, right) => right.attemptSeq - left.attemptSeq)
    .find((attempt) => attempt.eventKind === 'outcome' && attempt.outcomeClass === 'success');
}

function parseVendorEvidence(value: unknown): NotificationVendorEvidence | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schema',
      'route_record_id',
      'vendor_id',
      'idempotency_key',
      'body_digest',
      'body_size',
      'source',
      'delivered_at',
      'recorded_at',
    ]) ||
    value.schema !== NOTIFICATION_VENDOR_EVIDENCE_SCHEMA ||
    !isNotificationRouteRecordId(value.route_record_id) ||
    !isNotificationHandoffVendorId(value.vendor_id) ||
    !isNotificationHandoffIdempotencyKey(value.idempotency_key) ||
    !isNotificationDeploymentDigest(value.body_digest) ||
    !Number.isSafeInteger(value.body_size) ||
    (value.body_size as number) < 0 ||
    (value.body_size as number) > 262_144 ||
    (value.body_size as number) > NOTIFICATION_HANDOFF_POLICY.maxVendorBodyBytes ||
    (value.source !== 'slack' && value.source !== 'webhook') ||
    !isTimestamp(value.delivered_at) ||
    !isTimestamp(value.recorded_at)
  ) {
    return null;
  }
  return value as unknown as NotificationVendorEvidence;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
