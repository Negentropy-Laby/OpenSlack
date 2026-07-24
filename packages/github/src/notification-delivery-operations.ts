import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { CredentialStore } from '@openslack/credentials';
import { createDefaultCredentialStore } from '@openslack/credentials';
import {
  NotificationBlobStore,
  NotificationBlobStoreError,
  notificationBlobStorePath,
} from './notification-blob-store.js';
import {
  NotificationReceiptStore,
  notificationReceiptStorePath,
} from './notification-receipt-store.js';
import {
  WatchDeliveryQueueV2,
  WatchDeliveryQueueV2Error,
  type WatchDeliveryQueueV2Stats,
  type WatchRouteRecordV2,
  type WatchRouteRecoveryEntryV2,
  type WatchRouteRecoveryRequestV2,
} from './watch-delivery-queue-v2.js';
import { WatchDeliveryQueue } from './watch-delivery-queue.js';
import { loadGitHubWatchConfigV2 } from './watch-config-v2.js';
import {
  NotificationServiceOpsClient,
  type NotificationServiceOpsClientOptions,
} from './notification-service-ops-client.js';
import {
  NotificationDeliveryReconciler,
  NotificationVendorEvidenceStore,
  type NotificationReconciliationReport,
  type NotificationVendorEvidenceSource,
} from './notification-reconciliation.js';
import {
  readNotificationImportQualificationReport,
  type NotificationImportQualificationReport,
} from './notification-import-qualification.js';
import { ensureSecureNotificationDirectory } from './notification-storage-fs.js';

export const NOTIFICATION_AUDITOR_CREDENTIAL_REF_ENV =
  'OPENSLACK_NOTIFICATION_SERVICE_AUDITOR_CREDENTIAL_REF';
export const NOTIFICATION_VENDOR_EVIDENCE_DIR_ENV = 'OPENSLACK_NOTIFICATION_VENDOR_EVIDENCE_DIR';

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
  | NotificationReconciliationReport
  | {
      schema: 'openslack.notification_reconciliation.v1';
      outcome: 'unavailable' | 'conflict';
      checkedAt: string;
      routeRecordId: string;
      code:
        | 'WATCH_CONFIG_V2_INVALID'
        | 'NOTIFICATION_SERVICE_NOT_CONFIGURED'
        | 'AUDITOR_CREDENTIAL_REF_NOT_CONFIGURED'
        | 'VENDOR_EVIDENCE_NOT_CONFIGURED';
    };

export interface NotificationDeliveryOperationsOptions {
  workspaceRoot?: string;
  credentialStore?: Pick<CredentialStore, 'withSecret'>;
  now?: () => Date;
  auditorCredentialRef?: string;
  vendorEvidenceRoot?: string;
  opsClient?: NotificationServiceOpsClient;
  vendorEvidence?: NotificationVendorEvidenceSource;
  canaryReadCheckpoint?: (checkpoint: 'opened', path: string) => void;
}

/**
 * Payload-blind operational surface for local queue governance and explicitly
 * configured IB4 read-only reconciliation. It never reuses the handoff caller
 * credential for service status.
 */
export class NotificationDeliveryOperations {
  readonly workspaceRoot: string;
  readonly queueV1: WatchDeliveryQueue;
  readonly queueV2: WatchDeliveryQueueV2;
  readonly blobStore: NotificationBlobStore;
  readonly receiptStore: NotificationReceiptStore;
  private readonly credentialStore: Pick<CredentialStore, 'withSecret'>;
  private readonly now: () => Date;
  private readonly auditorCredentialRef?: string;
  private readonly vendorEvidenceRoot?: string;
  private readonly injectedOpsClient?: NotificationServiceOpsClient;
  private readonly injectedVendorEvidence?: NotificationVendorEvidenceSource;
  private readonly canaryReadCheckpoint?: NotificationDeliveryOperationsOptions['canaryReadCheckpoint'];

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
    this.auditorCredentialRef =
      options.auditorCredentialRef ?? process.env[NOTIFICATION_AUDITOR_CREDENTIAL_REF_ENV]?.trim();
    this.vendorEvidenceRoot =
      options.vendorEvidenceRoot ?? process.env[NOTIFICATION_VENDOR_EVIDENCE_DIR_ENV]?.trim();
    this.injectedOpsClient = options.opsClient;
    this.injectedVendorEvidence = options.vendorEvidence;
    this.canaryReadCheckpoint = options.canaryReadCheckpoint;
  }

  status(): {
    queue: WatchDeliveryQueueV2Stats;
    legacy: ReturnType<WatchDeliveryQueue['getStats']>;
    legacyMigration: 'active' | 'finalized';
  } {
    const finalized = this.queueV1.isV2MigrationFinalized(this.queueV2.statePath);
    return {
      queue: this.queueV2.getStats(),
      legacy: finalized ? emptyLegacyStats() : this.queueV1.getStats(),
      legacyMigration: finalized ? 'finalized' : 'active',
    };
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

    let routes: WatchRouteRecordV2[] = [];
    let queueReadable = false;
    let pendingReceiptLedgers = 0;
    try {
      const stats = this.queueV2.getStats();
      routes = this.queueV2.listRoutes();
      queueReadable = true;
      pendingReceiptLedgers = stats.pendingReceiptLedgers;
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
    for (const route of routes) {
      if (
        route.backend === 'notification_service' &&
        route.blob &&
        route.authority === 'openslack'
      ) {
        try {
          this.blobStore.verify(route.blob.digest, route.blob.size);
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
      passed: queueReadable && blobFailures === 0,
      code: !queueReadable
        ? 'ACTIVE_BLOBS_UNAVAILABLE'
        : blobFailures === 0
          ? 'ACTIVE_BLOBS_VALID'
          : 'ACTIVE_BLOBS_INVALID',
      detail: queueReadable
        ? `${blobFailures} active Blob verification failure(s).`
        : 'Active Blob references could not be enumerated from queue v2.',
    });
    checks.push({
      name: 'accepted_receipts',
      passed: queueReadable && pendingReceiptLedgers === 0 && receiptFailures === 0,
      code: !queueReadable
        ? 'ACCEPTED_RECEIPTS_UNAVAILABLE'
        : pendingReceiptLedgers > 0
          ? 'ACCEPTED_RECEIPT_RECOVERY_REQUIRED'
          : receiptFailures === 0
            ? 'ACCEPTED_RECEIPTS_VALID'
            : 'ACCEPTED_RECEIPTS_INVALID',
      detail: !queueReadable
        ? 'Committed receipt references could not be enumerated from queue v2.'
        : pendingReceiptLedgers > 0
          ? `${pendingReceiptLedgers} accepted receipt ledger(s) require local crash recovery.`
          : `${receiptFailures} committed receipt verification failure(s).`,
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

      let auditorResolved = false;
      if (this.auditorCredentialRef) {
        try {
          await this.credentialStore.withSecret(this.auditorCredentialRef, (secret) => {
            auditorResolved = secret.trim().length > 0;
          });
        } catch {
          auditorResolved = false;
        }
      }
      checks.push({
        name: 'status_auditor_credential',
        passed: auditorResolved,
        code: auditorResolved
          ? 'STATUS_AUDITOR_CREDENTIAL_VALID'
          : 'STATUS_AUDITOR_CREDENTIAL_UNAVAILABLE',
        detail: auditorResolved
          ? 'Independent read-only auditor credential resolved without exposing its value.'
          : `Set ${NOTIFICATION_AUDITOR_CREDENTIAL_REF_ENV} to an env: or keychain: reference.`,
      });

      let versionCheck: NotificationDeliveryDoctorCheck;
      try {
        const opsClient = this.createOpsClient(parsed.config.notification_service);
        const version = opsClient ? await opsClient.version() : null;
        versionCheck =
          version?.kind === 'ok'
            ? {
                name: 'service_version',
                passed: true,
                code: 'SERVICE_VERSION_VALID',
                detail: `Ready deployment ${version.deploymentDigest}.`,
              }
            : {
                name: 'service_version',
                passed: false,
                code:
                  version?.kind === 'protocol_error'
                    ? version.code
                    : version?.kind === 'not_ready'
                      ? 'SERVICE_NOT_READY'
                      : 'SERVICE_VERSION_UNAVAILABLE',
                detail: 'Read-only service version evidence is unavailable or inconsistent.',
              };
      } catch {
        versionCheck = {
          name: 'service_version',
          passed: false,
          code: 'SERVICE_VERSION_UNAVAILABLE',
          detail: 'Read-only service version evidence could not be verified safely.',
        };
      }
      checks.push(versionCheck);

      const vendorEvidenceConfigured = Boolean(
        this.injectedVendorEvidence ?? this.vendorEvidenceRoot,
      );
      checks.push({
        name: 'vendor_evidence',
        passed: vendorEvidenceConfigured,
        code: vendorEvidenceConfigured
          ? 'VENDOR_EVIDENCE_CONFIGURED'
          : 'VENDOR_EVIDENCE_NOT_CONFIGURED',
        detail: vendorEvidenceConfigured
          ? 'Metadata-only vendor evidence source is configured.'
          : `Set ${NOTIFICATION_VENDOR_EVIDENCE_DIR_ENV} to a protected metadata-only directory.`,
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

  async reconcile(
    id: string,
    configPath: string = join(this.workspaceRoot, '.openslack', 'monitors', 'github-watch.yaml'),
  ): Promise<NotificationDeliveryReconciliation> {
    const checkedAt = this.now().toISOString();
    const base = {
      schema: 'openslack.notification_reconciliation.v1' as const,
      checkedAt,
      routeRecordId: id,
    };
    const parsed = loadGitHubWatchConfigV2(configPath);
    if (!parsed.valid || !parsed.config) {
      return { ...base, outcome: 'conflict', code: 'WATCH_CONFIG_V2_INVALID' };
    }
    const service = parsed.config.notification_service;
    if (!service) {
      return {
        ...base,
        outcome: 'conflict',
        code: 'NOTIFICATION_SERVICE_NOT_CONFIGURED',
      };
    }
    const opsClient = this.createOpsClient(service);
    if (!opsClient) {
      return {
        ...base,
        outcome: 'unavailable',
        code: 'AUDITOR_CREDENTIAL_REF_NOT_CONFIGURED',
      };
    }
    const vendorEvidence = this.createVendorEvidence();
    if (!vendorEvidence) {
      return {
        ...base,
        outcome: 'unavailable',
        code: 'VENDOR_EVIDENCE_NOT_CONFIGURED',
      };
    }
    return new NotificationDeliveryReconciler({
      queue: this.queueV2,
      receiptStore: this.receiptStore,
      opsClient,
      vendorEvidence,
      now: this.now,
    }).reconcile(id);
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
    let route: WatchRouteRecordV2 | null;
    try {
      route = this.queueV2.getRoute(id);
    } catch (error) {
      if (error instanceof WatchDeliveryQueueV2Error) {
        throw new Error('NOTIFICATION_LOCAL_STATE_INVALID');
      }
      throw error;
    }
    if (!route?.blob) throw new Error('BLOB_NOT_AVAILABLE');
    const request: WatchRouteRecoveryRequestV2 = {
      decision: 'retry',
      operator: options.operator,
      reason: options.reason,
      ...(options.reconciliation ? { reconciliation: options.reconciliation } : {}),
    };
    if (!options.apply) {
      try {
        this.blobStore.verify(route.blob.digest, route.blob.size);
      } catch (error) {
        throw safeBlobRecoveryError(error);
      }
      return this.queueV2.planRecovery(id, request);
    }
    try {
      return this.queueV2.applyRecovery(id, request, this.blobStore);
    } catch (error) {
      if (error instanceof NotificationBlobStoreError) throw safeBlobRecoveryError(error);
      throw error;
    }
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
    try {
      const bytes = readSecureCanaryArtifact(path, 64 * 1024, this.canaryReadCheckpoint);
      if (bytes === null) return null;
      return sanitizeCanaryArtifact(JSON.parse(bytes.toString('utf8')) as unknown, name);
    } catch {
      throw new Error('CANARY_ARTIFACT_INVALID');
    }
  }

  readImportQualificationReport(): NotificationImportQualificationReport | null {
    const root = join(
      this.workspaceRoot,
      '.openslack.local',
      'daemon',
      'notification-import-qualification',
    );
    if (!existsSync(root)) return null;
    return readNotificationImportQualificationReport(root);
  }

  private createOpsClient(service: {
    endpoint: string;
    expected_deployment_digest: `sha256:${string}`;
    allow_insecure_loopback?: boolean;
  }): NotificationServiceOpsClient | null {
    if (this.injectedOpsClient) return this.injectedOpsClient;
    if (!this.auditorCredentialRef) return null;
    const options: NotificationServiceOpsClientOptions = {
      endpoint: service.endpoint,
      credentialRef: this.auditorCredentialRef,
      expectedDeploymentDigest: service.expected_deployment_digest,
      credentialStore: this.credentialStore,
      ...(service.allow_insecure_loopback === undefined
        ? {}
        : { allowInsecureLoopback: service.allow_insecure_loopback }),
    };
    return new NotificationServiceOpsClient(options);
  }

  private createVendorEvidence(): NotificationVendorEvidenceSource | null {
    if (this.injectedVendorEvidence) return this.injectedVendorEvidence;
    return this.vendorEvidenceRoot
      ? new NotificationVendorEvidenceStore(this.vendorEvidenceRoot)
      : null;
  }
}

function readSecureCanaryArtifact(
  path: string,
  maximumBytes: number,
  checkpoint?: NotificationDeliveryOperationsOptions['canaryReadCheckpoint'],
): Buffer | null {
  let pathBefore: ReturnType<typeof lstatSync>;
  try {
    pathBefore = lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (
    pathBefore.isSymbolicLink() ||
    !pathBefore.isFile() ||
    (process.platform !== 'win32' && (Number(pathBefore.mode) & 0o777) !== 0o600)
  ) {
    throw new Error('CANARY_ARTIFACT_UNSAFE');
  }
  ensureSecureNotificationDirectory(dirname(path));
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      before.size > BigInt(maximumBytes)
    ) {
      throw new Error('CANARY_ARTIFACT_UNSAFE');
    }
    checkpoint?.('opened', path);
    const bytes = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    if (
      offset > maximumBytes ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino
    ) {
      throw new Error('CANARY_ARTIFACT_READ_RACE');
    }
    return bytes.subarray(0, offset);
  } finally {
    closeSync(descriptor);
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

function safeBlobRecoveryError(error: unknown): Error {
  if (!(error instanceof NotificationBlobStoreError)) {
    return new Error('BLOB_STORAGE_UNSAFE');
  }
  switch (error.code) {
    case 'BLOB_NOT_FOUND':
      return new Error('BLOB_NOT_AVAILABLE');
    case 'BLOB_SIZE_MISMATCH':
    case 'BLOB_DIGEST_MISMATCH':
      return new Error('BLOB_INTEGRITY_FAILED');
    case 'BLOB_LOCK_TIMEOUT':
      return new Error('BLOB_STORAGE_BUSY');
    case 'BLOB_DIGEST_INVALID':
    case 'BLOB_FILE_UNSAFE':
    case 'BLOB_PATH_UNSAFE':
    case 'BLOB_READ_RACE':
    case 'BLOB_QUOTA_EXCEEDED':
      return new Error('BLOB_STORAGE_UNSAFE');
  }
}

function emptyLegacyStats(): ReturnType<WatchDeliveryQueue['getStats']> {
  return {
    count: 0,
    pending: 0,
    processing: 0,
    retryable: 0,
    completed: 0,
    failed: 0,
    exhausted: 0,
    activeLeases: 0,
    legacyTombstones: 0,
  };
}
