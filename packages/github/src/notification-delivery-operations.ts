import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CredentialStore } from '@openslack/credentials';
import { createDefaultCredentialStore } from '@openslack/credentials';
import { NotificationBlobStore, notificationBlobStorePath } from './notification-blob-store.js';
import {
  NotificationReceiptStore,
  NotificationReceiptStoreError,
  notificationReceiptStorePath,
} from './notification-receipt-store.js';
import {
  WatchDeliveryQueueV2,
  type WatchDeliveryQueueV2Stats,
  type WatchRouteRecordV2,
  type WatchRouteRecoveryEntryV2,
  type WatchRouteRecoveryRequestV2,
} from './watch-delivery-queue-v2.js';
import { WatchDeliveryQueue } from './watch-delivery-queue.js';
import { loadGitHubWatchConfigV2 } from './watch-config-v2.js';

export interface NotificationDeliveryRouteView {
  id: string;
  repository: string;
  routeId: string;
  routingEpoch: number;
  backend: WatchRouteRecordV2['backend'];
  vendorId?: string;
  state: WatchRouteRecordV2['state'];
  authority: WatchRouteRecordV2['authority'];
  attemptCount: number;
  deadlineAt?: string;
  receiptLedger?: WatchRouteRecordV2['receiptLedger'];
  remoteDeliveryState: WatchRouteRecordV2['remoteDeliveryState'];
  terminalReason?: WatchRouteRecordV2['terminalReason'];
  recoveryCycle: number;
}

export interface NotificationDeliveryDoctorCheck {
  name: string;
  passed: boolean;
  code: string;
  detail: string;
}

export interface NotificationDeliveryDoctorReport {
  ready: boolean;
  checks: NotificationDeliveryDoctorCheck[];
}

export type NotificationDeliveryReconciliation =
  | {
      outcome: 'consistent';
      checkedAt: string;
      notificationId: string;
      remoteDeliveryState: WatchRouteRecordV2['remoteDeliveryState'];
    }
  | {
      outcome: 'remote_required';
      checkedAt: string;
      code: 'REMOTE_RECONCILIATION_REQUIRED';
    }
  | {
      outcome: 'conflict';
      checkedAt: string;
      code: 'LOCAL_RECEIPT_CONFLICT' | 'LOCAL_RECEIPT_MISSING';
    };

export interface NotificationDeliveryOperationsOptions {
  workspaceRoot?: string;
  credentialStore?: Pick<CredentialStore, 'withSecret'>;
  now?: () => Date;
}

/**
 * Local, payload-blind operational surface for queue inspection and governed recovery.
 * Remote service reconciliation is deliberately added by IB4 rather than inferred here.
 */
export class NotificationDeliveryOperations {
  readonly workspaceRoot: string;
  readonly queueV1: WatchDeliveryQueue;
  readonly queueV2: WatchDeliveryQueueV2;
  readonly blobStore: NotificationBlobStore;
  readonly receiptStore: NotificationReceiptStore;
  private readonly credentialStore: Pick<CredentialStore, 'withSecret'>;
  private readonly now: () => Date;

  constructor(options: NotificationDeliveryOperationsOptions = {}) {
    this.workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    const daemonRoot = join(this.workspaceRoot, '.openslack.local', 'daemon');
    this.queueV1 = new WatchDeliveryQueue(daemonRoot);
    this.queueV2 = new WatchDeliveryQueueV2(daemonRoot);
    this.blobStore = new NotificationBlobStore({
      rootPath: notificationBlobStorePath(this.workspaceRoot),
    });
    this.receiptStore = new NotificationReceiptStore({
      rootPath: notificationReceiptStorePath(this.workspaceRoot),
    });
    this.credentialStore = options.credentialStore ?? createDefaultCredentialStore(process.env);
    this.now = options.now ?? (() => new Date());
  }

  status(): {
    queue: WatchDeliveryQueueV2Stats;
    legacy: ReturnType<WatchDeliveryQueue['getStats']>;
  } {
    return { queue: this.queueV2.getStats(), legacy: this.queueV1.getStats() };
  }

  listRoutes(): NotificationDeliveryRouteView[] {
    return this.queueV2.listRoutes().map(routeView);
  }

  getRoute(id: string): NotificationDeliveryRouteView | null {
    const route = this.queueV2.getRoute(id);
    return route ? routeView(route) : null;
  }

  async doctor(
    configPath: string = join(this.workspaceRoot, '.openslack', 'monitors', 'github-watch.yaml'),
  ): Promise<NotificationDeliveryDoctorReport> {
    const checks: NotificationDeliveryDoctorCheck[] = [];
    const parsed = loadGitHubWatchConfigV2(configPath);
    checks.push({
      name: 'watch_config_v2',
      passed: parsed.valid && parsed.config !== undefined,
      code: parsed.valid ? 'WATCH_CONFIG_V2_VALID' : 'WATCH_CONFIG_V2_INVALID',
      detail: parsed.valid ? 'Explicit v2 schema selected.' : parsed.errors.join('; '),
    });

    try {
      const stats = this.queueV2.getStats();
      checks.push({
        name: 'queue_v2',
        passed: true,
        code: 'QUEUE_V2_VALID',
        detail: `${stats.count} route record(s); ${stats.pendingReceiptLedgers} pending receipt ledger(s).`,
      });
    } catch {
      checks.push({
        name: 'queue_v2',
        passed: false,
        code: 'QUEUE_V2_INVALID',
        detail: 'Queue v2 could not be validated.',
      });
    }

    let blobFailures = 0;
    let receiptFailures = 0;
    for (const route of this.queueV2.listRoutes()) {
      if (
        route.backend === 'notification_service' &&
        route.blob &&
        route.authority === 'openslack'
      ) {
        try {
          const blob = this.blobStore.read(route.blob.digest);
          if (blob.size !== route.blob.size) blobFailures += 1;
        } catch {
          blobFailures += 1;
        }
      }
      if (route.state === 'accepted' && route.receiptLedger === 'committed' && route.receipt) {
        try {
          this.receiptStore.verify(route.receipt);
        } catch {
          receiptFailures += 1;
        }
      }
    }
    checks.push({
      name: 'active_blobs',
      passed: blobFailures === 0,
      code: blobFailures === 0 ? 'ACTIVE_BLOBS_VALID' : 'ACTIVE_BLOBS_INVALID',
      detail: `${blobFailures} active Blob verification failure(s).`,
    });
    checks.push({
      name: 'accepted_receipts',
      passed: receiptFailures === 0,
      code: receiptFailures === 0 ? 'ACCEPTED_RECEIPTS_VALID' : 'ACCEPTED_RECEIPTS_INVALID',
      detail: `${receiptFailures} committed receipt verification failure(s).`,
    });

    if (parsed.valid && parsed.config?.notification_service) {
      let resolved = false;
      try {
        await this.credentialStore.withSecret(
          parsed.config.notification_service.credential_ref,
          (secret) => {
            resolved = secret.trim().length > 0;
          },
        );
      } catch {
        resolved = false;
      }
      checks.push({
        name: 'service_credential',
        passed: resolved,
        code: resolved ? 'SERVICE_CREDENTIAL_VALID' : 'SERVICE_CREDENTIAL_UNAVAILABLE',
        detail: resolved
          ? 'Credential reference resolved without exposing its value.'
          : 'Credential reference did not resolve.',
      });
    } else {
      checks.push({
        name: 'service_credential',
        passed: false,
        code: 'SERVICE_CREDENTIAL_NOT_CONFIGURED',
        detail: 'Notification service configuration is absent.',
      });
    }

    return { ready: checks.every((check) => check.passed), checks };
  }

  reconcile(id: string): NotificationDeliveryReconciliation {
    const checkedAt = this.now().toISOString();
    const route = this.queueV2.getRoute(id);
    if (!route) {
      return { outcome: 'conflict', checkedAt, code: 'LOCAL_RECEIPT_MISSING' };
    }
    if (route.state !== 'accepted' || !route.receipt || route.receiptLedger !== 'committed') {
      return {
        outcome: 'remote_required',
        checkedAt,
        code: 'REMOTE_RECONCILIATION_REQUIRED',
      };
    }
    try {
      this.receiptStore.verify(route.receipt);
      return {
        outcome: 'consistent',
        checkedAt,
        notificationId: route.receipt.notification_id,
        remoteDeliveryState: route.remoteDeliveryState,
      };
    } catch (error) {
      return {
        outcome: 'conflict',
        checkedAt,
        code:
          error instanceof NotificationReceiptStoreError && error.code === 'RECEIPT_NOT_FOUND'
            ? 'LOCAL_RECEIPT_MISSING'
            : 'LOCAL_RECEIPT_CONFLICT',
      };
    }
  }

  retry(
    id: string,
    options: {
      operator: string;
      reason: string;
      apply: boolean;
      reconciliation?: WatchRouteRecoveryEntryV2['reconciliation'];
    },
  ): WatchRouteRecordV2 {
    const route = this.queueV2.getRoute(id);
    if (!route?.blob) throw new Error('BLOB_NOT_AVAILABLE');
    const blob = this.blobStore.read(route.blob.digest);
    if (blob.size !== route.blob.size) throw new Error('BLOB_NOT_AVAILABLE');
    const request: WatchRouteRecoveryRequestV2 = {
      decision: 'retry',
      operator: options.operator,
      reason: options.reason,
      ...(options.reconciliation ? { reconciliation: options.reconciliation } : {}),
    };
    return options.apply
      ? this.queueV2.applyRecovery(id, request)
      : this.queueV2.planRecovery(id, request);
  }

  resolveQuarantine(
    id: string,
    options: {
      decision: 'retry' | 'archive';
      operator: string;
      reason: string;
      apply: boolean;
      reconciliation: NonNullable<WatchRouteRecoveryRequestV2['reconciliation']>;
    },
  ): WatchRouteRecordV2 {
    if (options.decision === 'retry') return this.retry(id, options);
    const request: WatchRouteRecoveryRequestV2 = {
      decision: 'archive',
      operator: options.operator,
      reason: options.reason,
      reconciliation: options.reconciliation,
    };
    return options.apply
      ? this.queueV2.applyRecovery(id, request)
      : this.queueV2.planRecovery(id, request);
  }

  finalizeLegacyMigration(
    apply: boolean,
  ):
    | { outcome: 'preview'; activeLegacyRoutes: number }
    | ReturnType<WatchDeliveryQueue['finalizeV2Migration']> {
    const activeLegacyRoutes = this.queueV2.getStats().legacyOwned;
    if (!apply) return { outcome: 'preview', activeLegacyRoutes };
    if (activeLegacyRoutes !== 0) throw new Error('LEGACY_ROUTES_ACTIVE');
    return this.queueV1.finalizeV2Migration(this.queueV2.statePath);
  }

  readCanaryArtifact(name: 'status' | 'report'): unknown | null {
    const path = join(
      this.workspaceRoot,
      '.openslack.local',
      'daemon',
      'notification-canary',
      `${name}.json`,
    );
    if (!existsSync(path)) return null;
    try {
      if (statSync(path).size > 64 * 1024) throw new Error('CANARY_ARTIFACT_INVALID');
      return sanitizeCanaryArtifact(JSON.parse(readFileSync(path, 'utf8')) as unknown, name);
    } catch {
      throw new Error('CANARY_ARTIFACT_INVALID');
    }
  }
}

function sanitizeCanaryArtifact(
  value: unknown,
  name: 'status' | 'report',
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('CANARY_ARTIFACT_INVALID');
  const schema =
    name === 'status'
      ? 'openslack.notification_canary_status.v1'
      : 'openslack.notification_canary_report.v1';
  if (value.schema !== schema) throw new Error('CANARY_ARTIFACT_INVALID');
  const allowed = new Set([
    'schema',
    'status',
    'correlation_id',
    'window_started_at',
    'window_ended_at',
    'continuous_hours',
    'distinct_accepted',
    'repositories',
    'vendor_ids',
    'last_reconciled_at',
    'generated_at',
    'report_sha256',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('CANARY_ARTIFACT_INVALID');
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      !(
        typeof entry === 'string' ||
        typeof entry === 'number' ||
        (Array.isArray(entry) && entry.every((item) => typeof item === 'string'))
      )
    ) {
      throw new Error(`CANARY_ARTIFACT_INVALID:${key}`);
    }
  }
  return { ...value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function routeView(route: WatchRouteRecordV2): NotificationDeliveryRouteView {
  return {
    id: route.id,
    repository: route.canonicalRepository,
    routeId: route.routeId,
    routingEpoch: route.routingEpoch,
    backend: route.backend,
    ...(route.vendorId ? { vendorId: route.vendorId } : {}),
    state: route.state,
    authority: route.authority,
    attemptCount: route.attemptCount,
    ...(route.deadlineAt ? { deadlineAt: route.deadlineAt } : {}),
    ...(route.receiptLedger ? { receiptLedger: route.receiptLedger } : {}),
    remoteDeliveryState: route.remoteDeliveryState,
    ...(route.terminalReason ? { terminalReason: route.terminalReason } : {}),
    recoveryCycle: route.recoveryCycle,
  };
}
