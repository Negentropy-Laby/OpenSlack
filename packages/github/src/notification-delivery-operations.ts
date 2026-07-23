import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CredentialStore } from '@openslack/credentials';
import { createDefaultCredentialStore } from '@openslack/credentials';
import { NotificationBlobStore, notificationBlobStorePath } from './notification-blob-store.js';
import {
  NotificationReceiptStore,
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
