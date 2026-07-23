import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  NOTIFICATION_HANDOFF_POLICY,
  createNotificationHandoffKeyV2,
  createNotificationRouteRecordIdV2,
  isNotificationDeploymentDigest,
  isNotificationHandoffIdempotencyKey,
  isNotificationHandoffRouteId,
  isNotificationHandoffVendorId,
  isNotificationRouteRecordId,
  type HandoffRouteState,
  type HandoffTerminalReason,
  type NotificationBodyEncoderVersion,
  type NotificationDeliveryBackend,
  type RemoteDeliveryState,
} from './notification-handoff-contracts.js';
import type {
  NotificationAcceptanceReceiptV1,
  NotificationReceiptStore,
} from './notification-receipt-store.js';
import type { PersistableRepositoryEvent } from './repository-event.js';
import type { GitHubWatchRouteV2 } from './watch-config-v2.js';
import {
  validatePersistableRepositoryEvent,
  type WatchDeliveryQueue,
  type WatchDeliveryQueueSnapshotV1,
  type WatchDeliveryState,
} from './watch-delivery-queue.js';

export const WATCH_DELIVERY_QUEUE_V2_SCHEMA = 'openslack.watch_delivery_queue.v2' as const;
export const WATCH_DELIVERY_QUEUE_V2_RELATIVE_PATH = join(
  '.openslack.local',
  'daemon',
  'delivery-state.v2.json',
);

const DIRECT_MAX_ATTEMPTS = 5;
const DIRECT_BASE_RETRY_MS = 1_000;
const DIRECT_RETRY_CAP_MS = 5 * 60_000;

export type WatchRouteStateV2 = HandoffRouteState | 'completed' | 'failed';
export type WatchRouteAuthorityV2 = 'openslack' | 'notification_service' | 'legacy_v1' | 'terminal';
export type WatchRouteReceiptLedgerStateV2 = 'pending' | 'committed';
export type WatchRouteMigrationDispositionV2 =
  | 'legacy_owned'
  | 'completed_tombstone'
  | 'terminal_archive';

export interface WatchRouteLeaseV2 {
  token: string;
  workerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface WatchRouteDiagnosticV2 {
  code: string;
  message: string;
  retryable: boolean;
  recordedAt: string;
  status?: number;
}

export interface WatchRouteBlobReferenceV2 {
  digest: `sha256:${string}`;
  size: number;
  mediaType: 'application/json';
  encoderVersion: NotificationBodyEncoderVersion;
}

export interface WatchRouteRecordV2 {
  id: string;
  canonicalRepository: string;
  stableKey: string;
  deliveryIds: string[];
  event: PersistableRepositoryEvent;
  routeId: string;
  routingEpoch: number;
  backend: Exclude<NotificationDeliveryBackend, 'local'>;
  route: GitHubWatchRouteV2;
  vendorId?: string;
  idempotencyKey: string;
  blob?: WatchRouteBlobReferenceV2;
  watchConfigDigest?: `sha256:${string}`;
  state: WatchRouteStateV2;
  authority: WatchRouteAuthorityV2;
  attemptCount: number;
  availableAt: string;
  firstPersistedAt: string;
  deadlineAt?: string;
  updatedAt: string;
  lease?: WatchRouteLeaseV2;
  receipt?: NotificationAcceptanceReceiptV1;
  receiptLedger?: WatchRouteReceiptLedgerStateV2;
  remoteDeliveryState: RemoteDeliveryState;
  terminalReason?: HandoffTerminalReason;
  terminalAt?: string;
  completedAt?: string;
  lastDiagnostic?: WatchRouteDiagnosticV2;
  recoveryCycle: number;
  migrationDisposition?: WatchRouteMigrationDispositionV2;
}

export interface WatchDeliveryQueueV2State {
  schema: typeof WATCH_DELIVERY_QUEUE_V2_SCHEMA;
  updatedAt: string;
  routes: WatchRouteRecordV2[];
  legacyEventTombstones: Array<{
    deliveryId: string;
    stableKey: string;
    recordedAt: string;
  }>;
}

export interface WatchRouteEnqueueInputV2 {
  route: GitHubWatchRouteV2;
  blob?: WatchRouteBlobReferenceV2;
  watchConfigDigest?: `sha256:${string}`;
}

export type WatchRouteEnqueueResultV2 =
  | { outcome: 'enqueued'; routes: WatchRouteRecordV2[] }
  | { outcome: 'duplicate'; routes: WatchRouteRecordV2[] }
  | { outcome: 'conflict'; code: 'DELIVERY_ID_CONFLICT'; existingStableKey: string };

export interface ClaimedWatchRouteV2 {
  route: WatchRouteRecordV2;
  lease: WatchRouteLeaseV2;
}

export interface WatchDeliveryQueueV2Policy {
  leaseMs: number;
  maxRecords: number;
  maxStateBytes: number;
  lockTimeoutMs: number;
  lockStaleMs: number;
}

export interface WatchDeliveryQueueV2Options {
  policy?: Partial<WatchDeliveryQueueV2Policy>;
  now?: () => Date;
  nonce?: () => string;
  acceptanceCheckpoint?: (
    checkpoint: 'embedded_receipt_persisted' | 'receipt_file_persisted',
    route: WatchRouteRecordV2,
  ) => void;
}

export interface WatchDeliveryQueueV2Stats {
  count: number;
  pending: number;
  processing: number;
  retryable: number;
  accepted: number;
  rejected: number;
  quarantined: number;
  handoffDead: number;
  completed: number;
  failed: number;
  legacyOwned: number;
  pendingReceiptLedgers: number;
  oldestPendingAt?: string;
  nextRetryAt?: string;
}

export interface LegacyWatchRouteBindingV2 {
  routeKey: string;
  routeId: string;
  routingEpoch: number;
}

export interface WatchDeliveryMigrationV2Report {
  dryRun: boolean;
  changed: boolean;
  imported: number;
  refreshed: number;
  completedTombstones: number;
  terminalArchives: number;
  legacyOwned: number;
  legacyEventTombstones: number;
}

export class WatchDeliveryQueueV2Error extends Error {
  readonly code:
    | 'QUEUE_LOCK_TIMEOUT'
    | 'QUEUE_STATE_INVALID'
    | 'QUEUE_CAPACITY_EXCEEDED'
    | 'QUEUE_STATE_TOO_LARGE'
    | 'QUEUE_TRANSITION_INVALID'
    | 'QUEUE_IMMUTABLE_CONFLICT'
    | 'QUEUE_RECEIPT_CONFLICT';

  constructor(code: WatchDeliveryQueueV2Error['code'], message: string) {
    super(message);
    this.name = 'WatchDeliveryQueueV2Error';
    this.code = code;
  }
}

const DEFAULT_POLICY: WatchDeliveryQueueV2Policy = Object.freeze({
  leaseMs: 60_000,
  maxRecords: 10_000,
  maxStateBytes: NOTIFICATION_HANDOFF_POLICY.queueStateMaxBytes,
  lockTimeoutMs: 5_000,
  lockStaleMs: 30_000,
});

export class WatchDeliveryQueueV2 {
  readonly statePath: string;
  private readonly stateDir: string;
  private readonly lockPath: string;
  private readonly policy: WatchDeliveryQueueV2Policy;
  private readonly now: () => Date;
  private readonly nonce: () => string;
  private readonly acceptanceCheckpoint?: WatchDeliveryQueueV2Options['acceptanceCheckpoint'];

  constructor(stateDir?: string, options: WatchDeliveryQueueV2Options = {}) {
    this.stateDir = resolve(stateDir ?? join(process.cwd(), '.openslack.local', 'daemon'));
    this.statePath = join(this.stateDir, 'delivery-state.v2.json');
    this.lockPath = `${this.statePath}.lock`;
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    validatePolicy(this.policy);
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? randomUUID;
    this.acceptanceCheckpoint = options.acceptanceCheckpoint;
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
  }

  enqueueRoutes(
    event: PersistableRepositoryEvent,
    inputs: WatchRouteEnqueueInputV2[],
  ): WatchRouteEnqueueResultV2 {
    validatePersistableRepositoryEvent(event);
    if (inputs.length === 0) return { outcome: 'enqueued', routes: [] };
    return this.mutate((state, now) => {
      const conflict = findDeliveryIdConflict(state, event);
      if (conflict) {
        return {
          outcome: 'conflict',
          code: 'DELIVERY_ID_CONFLICT',
          existingStableKey: conflict,
        };
      }

      const candidates = inputs.map((input) => buildRouteRecord(event, input, now));
      assertDistinctRouteInputs(candidates);
      const existing = candidates.map((candidate) =>
        state.routes.find(
          (record) =>
            record.id === candidate.id ||
            (record.stableKey === candidate.stableKey && record.routeId === candidate.routeId),
        ),
      );
      if (existing.some(Boolean)) {
        if (!existing.every(Boolean)) {
          throw queueError(
            'QUEUE_IMMUTABLE_CONFLICT',
            'A logical delivery already owns only part of the requested route set.',
          );
        }
        const duplicates = existing as WatchRouteRecordV2[];
        for (let index = 0; index < duplicates.length; index += 1) {
          assertImmutableRouteMatch(duplicates[index]!, candidates[index]!);
          rememberDeliveryId(duplicates[index]!, event.deliveryId, now.toISOString());
        }
        return { outcome: 'duplicate', routes: cloneRoutes(duplicates) };
      }

      if (state.routes.length + candidates.length > this.policy.maxRecords) {
        throw queueError(
          'QUEUE_CAPACITY_EXCEEDED',
          'Watch delivery v2 queue capacity is exhausted.',
        );
      }
      state.routes.push(...candidates);
      state.routes.sort(compareRoutes);
      return { outcome: 'enqueued', routes: cloneRoutes(candidates) };
    });
  }

  claimNext(
    workerId: string,
    backend: Exclude<NotificationDeliveryBackend, 'local'>,
  ): ClaimedWatchRouteV2 | null {
    if (!workerId.trim()) {
      throw queueError(
        'QUEUE_TRANSITION_INVALID',
        'A non-empty route worker identity is required.',
      );
    }
    return this.mutate((state, now) => {
      expireProcessingLeases(state, now);
      exhaustUnclaimableServiceRoutes(state, now);
      const record = state.routes
        .filter(
          (candidate) =>
            candidate.authority === 'openslack' &&
            candidate.backend === backend &&
            (candidate.state === 'pending' || candidate.state === 'retryable') &&
            Date.parse(candidate.availableAt) <= now.getTime() &&
            mayAttempt(candidate, now),
        )
        .sort(compareAvailableRoutes)[0];
      if (!record) return null;

      const timestamp = now.toISOString();
      const lease: WatchRouteLeaseV2 = {
        token: this.nonce(),
        workerId,
        acquiredAt: timestamp,
        expiresAt: new Date(now.getTime() + this.policy.leaseMs).toISOString(),
      };
      record.state = 'processing';
      record.attemptCount += 1;
      record.updatedAt = timestamp;
      record.lease = lease;
      return { route: cloneRoute(record), lease: { ...lease } };
    });
  }

  confirmAttemptMaySend(id: string, leaseToken: string): WatchRouteRecordV2 | null {
    return this.mutate((state, now) => {
      const record = requireLease(state, id, leaseToken);
      if (record.backend === 'notification_service' && deadlineReached(record, now)) {
        markHandoffDead(record, 'deadline_exhausted', now);
        return null;
      }
      return cloneRoute(record);
    });
  }

  markRetryable(
    id: string,
    leaseToken: string,
    diagnostic: Omit<WatchRouteDiagnosticV2, 'retryable' | 'recordedAt'>,
    retryAfterMs?: number,
  ): WatchRouteRecordV2 {
    return this.mutate((state, now) => {
      const record = requireLease(state, id, leaseToken);
      const exhausted =
        record.backend === 'notification_service'
          ? record.attemptCount >= NOTIFICATION_HANDOFF_POLICY.maxAttempts ||
            deadlineReached(record, now)
          : record.attemptCount >= DIRECT_MAX_ATTEMPTS;
      if (exhausted && record.backend === 'notification_service') {
        markHandoffDead(
          record,
          deadlineReached(record, now) ? 'deadline_exhausted' : 'attempts_exhausted',
          now,
          diagnostic,
        );
        return cloneRoute(record);
      }
      if (exhausted) {
        markDirectFailed(record, now, diagnostic);
        return cloneRoute(record);
      }

      const recorded = sanitizeDiagnostic(diagnostic, true, now);
      const delay = retryDelay(record, retryAfterMs);
      record.state = 'retryable';
      record.availableAt = new Date(
        record.deadlineAt
          ? Math.min(now.getTime() + delay, Date.parse(record.deadlineAt))
          : now.getTime() + delay,
      ).toISOString();
      record.updatedAt = now.toISOString();
      record.lastDiagnostic = recorded;
      delete record.lease;
      return cloneRoute(record);
    });
  }

  markDirectCompleted(id: string, leaseToken: string): WatchRouteRecordV2 {
    return this.mutate((state, now) => {
      const record = requireLease(state, id, leaseToken, 'direct');
      const timestamp = now.toISOString();
      record.state = 'completed';
      record.authority = 'terminal';
      record.completedAt = timestamp;
      record.terminalAt = timestamp;
      record.updatedAt = timestamp;
      record.availableAt = timestamp;
      delete record.lease;
      delete record.lastDiagnostic;
      return cloneRoute(record);
    });
  }

  markDirectFailed(
    id: string,
    leaseToken: string,
    diagnostic: Omit<WatchRouteDiagnosticV2, 'retryable' | 'recordedAt'>,
  ): WatchRouteRecordV2 {
    return this.mutate((state, now) => {
      const record = requireLease(state, id, leaseToken, 'direct');
      markDirectFailed(record, now, diagnostic);
      return cloneRoute(record);
    });
  }

  markRejected(
    id: string,
    leaseToken: string,
    reason: Extract<
      HandoffTerminalReason,
      'deterministic_rejection' | 'protocol_redirect' | 'unexpected_client_error'
    >,
    diagnostic: Omit<WatchRouteDiagnosticV2, 'retryable' | 'recordedAt'>,
  ): WatchRouteRecordV2 {
    return this.markServiceTerminal(id, leaseToken, 'rejected', reason, diagnostic);
  }

  markQuarantined(
    id: string,
    leaseToken: string,
    reason: Extract<
      HandoffTerminalReason,
      | 'unexpected_success_status'
      | 'deployment_digest_mismatch'
      | 'idempotency_conflict'
      | 'receipt_conflict'
      | 'blob_digest_mismatch'
      | 'blob_size_mismatch'
      | 'blob_not_available'
    >,
    diagnostic: Omit<WatchRouteDiagnosticV2, 'retryable' | 'recordedAt'>,
  ): WatchRouteRecordV2 {
    return this.markServiceTerminal(id, leaseToken, 'quarantined', reason, diagnostic);
  }

  acceptServiceRoute(
    id: string,
    leaseToken: string,
    receipt: NotificationAcceptanceReceiptV1,
    receiptStore: NotificationReceiptStore,
  ): WatchRouteRecordV2 {
    return this.withLock(() => {
      const now = this.now();
      const state = this.loadState(now);
      const record = requireLease(state, id, leaseToken, 'notification_service');
      assertReceiptMatches(record, receipt);
      const existingReceipt = record.receipt;
      if (existingReceipt && !receiptsEqual(existingReceipt, receipt)) {
        throw queueError(
          'QUEUE_RECEIPT_CONFLICT',
          'Acceptance receipt conflicts with queue state.',
        );
      }

      const timestamp = now.toISOString();
      record.state = 'accepted';
      record.authority = 'notification_service';
      record.receipt = structuredClone(receipt);
      record.receiptLedger = 'pending';
      record.remoteDeliveryState = 'pending';
      record.updatedAt = timestamp;
      record.terminalAt = timestamp;
      record.availableAt = timestamp;
      delete record.lease;
      delete record.lastDiagnostic;
      this.persistUpdatedState(state, now);
      this.acceptanceCheckpoint?.('embedded_receipt_persisted', cloneRoute(record));

      receiptStore.ensureFromEmbeddedReceipt(receipt);
      this.acceptanceCheckpoint?.('receipt_file_persisted', cloneRoute(record));
      record.receiptLedger = 'committed';
      record.updatedAt = timestamp;
      this.persistUpdatedState(state, now);
      return cloneRoute(record);
    });
  }

  recoverAcceptedReceipts(receiptStore: NotificationReceiptStore): number {
    return this.withLock(() => {
      const now = this.now();
      const state = this.loadState(now);
      let recovered = 0;
      for (const record of state.routes) {
        if (
          record.state !== 'accepted' ||
          record.authority !== 'notification_service' ||
          record.receiptLedger !== 'pending' ||
          !record.receipt
        ) {
          continue;
        }
        receiptStore.ensureFromEmbeddedReceipt(record.receipt);
        record.receiptLedger = 'committed';
        record.updatedAt = now.toISOString();
        recovered += 1;
      }
      if (recovered > 0) this.persistUpdatedState(state, now);
      return recovered;
    });
  }

  getRoute(id: string): WatchRouteRecordV2 | null {
    return this.read((state) => {
      const record = state.routes.find((candidate) => candidate.id === id);
      return record ? cloneRoute(record) : null;
    });
  }

  listRoutes(): WatchRouteRecordV2[] {
    return this.read((state) => cloneRoutes(state.routes));
  }

  getStats(): WatchDeliveryQueueV2Stats {
    return this.read((state) => {
      const stats: WatchDeliveryQueueV2Stats = {
        count: state.routes.length + state.legacyEventTombstones.length,
        pending: 0,
        processing: 0,
        retryable: 0,
        accepted: 0,
        rejected: 0,
        quarantined: 0,
        handoffDead: 0,
        completed: 0,
        failed: 0,
        legacyOwned: 0,
        pendingReceiptLedgers: 0,
      };
      const pending: string[] = [];
      const retries: string[] = [];
      for (const record of state.routes) {
        switch (record.state) {
          case 'pending':
            stats.pending += 1;
            pending.push(record.firstPersistedAt);
            break;
          case 'processing':
            stats.processing += 1;
            break;
          case 'retryable':
            stats.retryable += 1;
            retries.push(record.availableAt);
            break;
          case 'accepted':
            stats.accepted += 1;
            break;
          case 'rejected':
            stats.rejected += 1;
            break;
          case 'quarantined':
            stats.quarantined += 1;
            break;
          case 'handoff_dead':
            stats.handoffDead += 1;
            break;
          case 'completed':
            stats.completed += 1;
            break;
          case 'failed':
            stats.failed += 1;
            break;
        }
        if (record.authority === 'legacy_v1') stats.legacyOwned += 1;
        if (record.receiptLedger === 'pending') stats.pendingReceiptLedgers += 1;
      }
      stats.oldestPendingAt = pending.sort()[0];
      stats.nextRetryAt = retries.sort()[0];
      return stats;
    });
  }

  planV1Migration(
    snapshot: WatchDeliveryQueueSnapshotV1,
    bindings: LegacyWatchRouteBindingV2[],
  ): WatchDeliveryMigrationV2Report {
    return this.read((state) => migrateSnapshot(structuredClone(state), snapshot, bindings, true));
  }

  applyV1Migration(
    snapshot: WatchDeliveryQueueSnapshotV1,
    bindings: LegacyWatchRouteBindingV2[],
  ): WatchDeliveryMigrationV2Report {
    return this.withLock(() => {
      const now = this.now();
      const state = this.loadState(now);
      const before = JSON.stringify(state);
      const report = migrateSnapshot(state, snapshot, bindings, false);
      const comparable = JSON.stringify(state);
      if (before === comparable) return { ...report, changed: false };
      this.persistUpdatedState(state, now);
      return { ...report, changed: true };
    });
  }

  private markServiceTerminal(
    id: string,
    leaseToken: string,
    stateValue: 'rejected' | 'quarantined',
    reason: HandoffTerminalReason,
    diagnostic: Omit<WatchRouteDiagnosticV2, 'retryable' | 'recordedAt'>,
  ): WatchRouteRecordV2 {
    return this.mutate((state, now) => {
      const record = requireLease(state, id, leaseToken, 'notification_service');
      const timestamp = now.toISOString();
      record.state = stateValue;
      record.authority = 'terminal';
      record.terminalReason = reason;
      record.terminalAt = timestamp;
      record.availableAt = timestamp;
      record.updatedAt = timestamp;
      record.lastDiagnostic = sanitizeDiagnostic(diagnostic, false, now);
      delete record.lease;
      return cloneRoute(record);
    });
  }

  private mutate<T>(operation: (state: WatchDeliveryQueueV2State, now: Date) => T): T {
    return this.withLock(() => {
      const now = this.now();
      const state = this.loadState(now);
      expireProcessingLeases(state, now);
      exhaustUnclaimableServiceRoutes(state, now);
      const result = operation(state, now);
      this.persistUpdatedState(state, now);
      return result;
    });
  }

  private read<T>(operation: (state: WatchDeliveryQueueV2State) => T): T {
    return this.withLock(() => operation(this.loadState(this.now())));
  }

  private loadState(now: Date): WatchDeliveryQueueV2State {
    if (!existsSync(this.statePath)) {
      return {
        schema: WATCH_DELIVERY_QUEUE_V2_SCHEMA,
        updatedAt: now.toISOString(),
        routes: [],
        legacyEventTombstones: [],
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown;
    } catch {
      throw queueError('QUEUE_STATE_INVALID', 'Watch delivery v2 queue state is not valid JSON.');
    }
    validateState(parsed);
    return parsed;
  }

  private persistUpdatedState(state: WatchDeliveryQueueV2State, now: Date): void {
    state.updatedAt = now.toISOString();
    validateState(state);
    const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    if (bytes.byteLength > this.policy.maxStateBytes) {
      throw queueError('QUEUE_STATE_TOO_LARGE', 'Watch delivery v2 queue exceeds its byte limit.');
    }
    const temporaryPath = `${this.statePath}.${process.pid}.${this.nonce()}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporaryPath, this.statePath);
      fsyncDirectoryBestEffort(dirname(this.statePath));
    } finally {
      if (descriptor !== null) closeSync(descriptor);
      rmSync(temporaryPath, { force: true });
    }
  }

  private withLock<T>(operation: () => T): T {
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.policy.lockTimeoutMs;
    const owner = {
      pid: process.pid,
      nonce: this.nonce(),
      createdAt: new Date().toISOString(),
    };
    while (true) {
      try {
        const descriptor = openSync(this.lockPath, 'wx', 0o600);
        try {
          writeFileSync(descriptor, JSON.stringify(owner), 'utf8');
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        break;
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        isolateStaleLock(this.lockPath, this.policy.lockStaleMs);
        if (Date.now() >= deadline) {
          throw queueError('QUEUE_LOCK_TIMEOUT', 'Timed out waiting for the watch v2 queue lock.');
        }
        blockFor(Math.min(25, Math.max(1, deadline - Date.now())));
      }
    }
    try {
      return operation();
    } finally {
      try {
        const current = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { nonce?: unknown };
        if (current.nonce === owner.nonce) rmSync(this.lockPath, { force: true });
      } catch {
        // Never remove a lock whose ownership cannot be proven.
      }
    }
  }
}

export function migrateWatchDeliveryQueueV1ToV2(options: {
  v1: WatchDeliveryQueue;
  v2: WatchDeliveryQueueV2;
  bindings: LegacyWatchRouteBindingV2[];
  dryRun?: boolean;
}): WatchDeliveryMigrationV2Report {
  if (options.dryRun) {
    return options.v2.planV1Migration(options.v1.readV2MigrationSnapshot(), options.bindings);
  }
  return options.v1.startOrRefreshV2Migration(options.v2.statePath, (snapshot) =>
    options.v2.applyV1Migration(snapshot, options.bindings),
  );
}

function buildRouteRecord(
  event: PersistableRepositoryEvent,
  input: WatchRouteEnqueueInputV2,
  now: Date,
): WatchRouteRecordV2 {
  const route = structuredClone(input.route);
  if (route.delivery.backend === 'local') {
    throw queueError('QUEUE_TRANSITION_INVALID', 'Local routes do not enter delivery queue v2.');
  }
  const canonicalRepository = event.repository.canonicalFullName;
  const idempotencyKey = createNotificationHandoffKeyV2(
    event.stableKey,
    route.id,
    route.delivery.routing_epoch,
  );
  const timestamp = now.toISOString();
  if (route.delivery.backend === 'notification_service') {
    if (!input.blob || !input.watchConfigDigest || !route.delivery.vendor_id) {
      throw queueError(
        'QUEUE_TRANSITION_INVALID',
        'Notification-service routes require Blob, config digest and vendor identity.',
      );
    }
    validateBlob(input.blob);
    if (!isNotificationDeploymentDigest(input.watchConfigDigest)) {
      throw queueError('QUEUE_TRANSITION_INVALID', 'Watch config digest is invalid.');
    }
  } else if (input.blob || input.watchConfigDigest) {
    throw queueError(
      'QUEUE_TRANSITION_INVALID',
      'Direct routes cannot attach notification-service handoff metadata.',
    );
  }

  return {
    id: createNotificationRouteRecordIdV2(canonicalRepository, idempotencyKey),
    canonicalRepository,
    stableKey: event.stableKey,
    deliveryIds: event.deliveryId ? [event.deliveryId] : [],
    event: structuredClone(event),
    routeId: route.id,
    routingEpoch: route.delivery.routing_epoch,
    backend: route.delivery.backend,
    route,
    ...(route.delivery.vendor_id ? { vendorId: route.delivery.vendor_id } : {}),
    idempotencyKey,
    ...(input.blob ? { blob: structuredClone(input.blob) } : {}),
    ...(input.watchConfigDigest ? { watchConfigDigest: input.watchConfigDigest } : {}),
    state: 'pending',
    authority: 'openslack',
    attemptCount: 0,
    availableAt: timestamp,
    firstPersistedAt: timestamp,
    ...(route.delivery.backend === 'notification_service'
      ? {
          deadlineAt: new Date(
            now.getTime() + NOTIFICATION_HANDOFF_POLICY.deadlineMs,
          ).toISOString(),
        }
      : {}),
    updatedAt: timestamp,
    remoteDeliveryState: 'unknown',
    recoveryCycle: 0,
  };
}

function migrateSnapshot(
  state: WatchDeliveryQueueV2State,
  snapshot: WatchDeliveryQueueSnapshotV1,
  bindings: LegacyWatchRouteBindingV2[],
  dryRun: boolean,
): WatchDeliveryMigrationV2Report {
  const bindingByKey = new Map(bindings.map((binding) => [binding.routeKey, binding]));
  if (bindingByKey.size !== bindings.length) {
    throw queueError('QUEUE_TRANSITION_INVALID', 'Legacy migration route bindings are duplicated.');
  }
  for (const binding of bindings) validateLegacyBinding(binding);

  let imported = 0;
  let refreshed = 0;
  let completedTombstones = 0;
  let terminalArchives = 0;
  let legacyOwned = 0;
  for (const delivery of snapshot.deliveries) {
    for (const route of delivery.routes) {
      const binding = bindingByKey.get(route.routeKey);
      if (!binding) {
        throw queueError(
          'QUEUE_TRANSITION_INVALID',
          `Missing v2 route binding for legacy route ${route.routeKey}.`,
        );
      }
      const candidate = migratedRoute(delivery, route, binding);
      const existing = state.routes.find((record) => record.id === candidate.id);
      if (!existing) {
        if (!dryRun) state.routes.push(candidate);
        imported += 1;
      } else {
        if (existing.migrationDisposition === undefined) {
          throw queueError(
            'QUEUE_IMMUTABLE_CONFLICT',
            'Legacy migration conflicts with a non-migrated v2 route record.',
          );
        }
        assertLegacyImmutableMatch(existing, candidate);
        if (JSON.stringify(existing) !== JSON.stringify(candidate)) {
          if (!dryRun) Object.assign(existing, candidate);
          refreshed += 1;
        }
      }
      if (candidate.migrationDisposition === 'completed_tombstone') completedTombstones += 1;
      if (candidate.migrationDisposition === 'terminal_archive') terminalArchives += 1;
      if (candidate.migrationDisposition === 'legacy_owned') legacyOwned += 1;
    }
  }

  const existingTombstones = new Map(
    state.legacyEventTombstones.map((entry) => [legacyTombstoneKey(entry), entry]),
  );
  for (const tombstone of snapshot.legacyTombstones) {
    const key = legacyTombstoneKey(tombstone);
    if (!existingTombstones.has(key) && !dryRun) {
      state.legacyEventTombstones.push(structuredClone(tombstone));
    }
  }
  if (!dryRun) {
    state.routes.sort(compareRoutes);
    state.legacyEventTombstones.sort((left, right) =>
      legacyTombstoneKey(left).localeCompare(legacyTombstoneKey(right)),
    );
  }
  return {
    dryRun,
    changed:
      imported + refreshed > 0 ||
      snapshot.legacyTombstones.some((entry) => !existingTombstones.has(legacyTombstoneKey(entry))),
    imported,
    refreshed,
    completedTombstones,
    terminalArchives,
    legacyOwned,
    legacyEventTombstones: snapshot.legacyTombstones.length,
  };
}

function migratedRoute(
  delivery: WatchDeliveryQueueSnapshotV1['deliveries'][number],
  route: WatchDeliveryQueueSnapshotV1['deliveries'][number]['routes'][number],
  binding: LegacyWatchRouteBindingV2,
): WatchRouteRecordV2 {
  const disposition = migrationDisposition(route.state);
  const authority: WatchRouteAuthorityV2 =
    disposition === 'legacy_owned' ? 'legacy_v1' : 'terminal';
  const v2Route: GitHubWatchRouteV2 = {
    id: binding.routeId,
    sink: route.route.sink,
    ...(route.route.channel ? { channel: route.route.channel } : {}),
    ...(route.route.name ? { name: route.route.name } : {}),
    delivery: { backend: 'direct', routing_epoch: binding.routingEpoch },
  };
  return {
    id: createNotificationRouteRecordIdV2(
      delivery.event.repository.canonicalFullName,
      route.idempotencyKey,
    ),
    canonicalRepository: delivery.event.repository.canonicalFullName,
    stableKey: delivery.stableKey,
    deliveryIds: [...delivery.deliveryIds],
    event: structuredClone(delivery.event),
    routeId: binding.routeId,
    routingEpoch: binding.routingEpoch,
    backend: 'direct',
    route: v2Route,
    idempotencyKey: route.idempotencyKey,
    state: route.state,
    authority,
    attemptCount: route.attempts,
    availableAt: route.availableAt,
    firstPersistedAt: delivery.createdAt,
    updatedAt: route.updatedAt,
    remoteDeliveryState: route.state === 'completed' ? 'delivered' : 'unknown',
    recoveryCycle: 0,
    migrationDisposition: disposition,
    ...(route.completedAt ? { completedAt: route.completedAt } : {}),
    ...(route.terminalAt ? { terminalAt: route.terminalAt } : {}),
    ...(route.lastDiagnostic ? { lastDiagnostic: structuredClone(route.lastDiagnostic) } : {}),
  };
}

function migrationDisposition(state: WatchDeliveryState): WatchRouteMigrationDispositionV2 {
  if (state === 'completed') return 'completed_tombstone';
  if (state === 'failed') return 'terminal_archive';
  return 'legacy_owned';
}

function validateState(value: unknown): asserts value is WatchDeliveryQueueV2State {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['schema', 'updatedAt', 'routes', 'legacyEventTombstones']) ||
    value.schema !== WATCH_DELIVERY_QUEUE_V2_SCHEMA ||
    !isTimestamp(value.updatedAt) ||
    !Array.isArray(value.routes) ||
    !Array.isArray(value.legacyEventTombstones)
  ) {
    throw queueError('QUEUE_STATE_INVALID', 'Watch delivery v2 queue schema is invalid.');
  }
  const ids = new Set<string>();
  const logicalRoutes = new Set<string>();
  for (const record of value.routes) {
    validateRecord(record);
    const logical = `${record.stableKey}\0${record.routeId}`;
    if (ids.has(record.id) || logicalRoutes.has(logical)) {
      throw queueError('QUEUE_STATE_INVALID', 'Watch delivery v2 queue contains duplicate routes.');
    }
    ids.add(record.id);
    logicalRoutes.add(logical);
  }
  for (const tombstone of value.legacyEventTombstones) validateLegacyTombstone(tombstone);
}

function validateRecord(value: unknown): asserts value is WatchRouteRecordV2 {
  if (!isRecord(value) || !hasOnlyKeys(value, RECORD_KEYS)) invalidRecord();
  validatePersistableRepositoryEvent(value.event);
  if (
    !isNotificationRouteRecordId(value.id) ||
    value.canonicalRepository !== value.event.repository.canonicalFullName ||
    value.stableKey !== value.event.stableKey ||
    !Array.isArray(value.deliveryIds) ||
    !value.deliveryIds.every((entry: unknown) => typeof entry === 'string') ||
    value.deliveryIds.length > 64 ||
    !isNotificationHandoffRouteId(value.routeId) ||
    !Number.isSafeInteger(value.routingEpoch) ||
    (value.routingEpoch as number) <= 0 ||
    (value.backend !== 'direct' && value.backend !== 'notification_service') ||
    !isRecord(value.route) ||
    value.route.id !== value.routeId ||
    !isRecord(value.route.delivery) ||
    value.route.delivery.backend !== value.backend ||
    value.route.delivery.routing_epoch !== value.routingEpoch ||
    !isNotificationHandoffIdempotencyKey(value.idempotencyKey) ||
    createNotificationRouteRecordIdV2(value.canonicalRepository, value.idempotencyKey) !==
      value.id ||
    !isRouteState(value.state) ||
    !isAuthority(value.authority) ||
    !Number.isSafeInteger(value.attemptCount) ||
    (value.attemptCount as number) < 0 ||
    !isTimestamp(value.availableAt) ||
    !isTimestamp(value.firstPersistedAt) ||
    !isTimestamp(value.updatedAt) ||
    !isRemoteState(value.remoteDeliveryState) ||
    !Number.isSafeInteger(value.recoveryCycle) ||
    (value.recoveryCycle as number) < 0
  ) {
    invalidRecord();
  }
  if (value.backend === 'notification_service') {
    if (
      !isNotificationHandoffVendorId(value.vendorId) ||
      value.route.delivery.vendor_id !== value.vendorId ||
      !isRecord(value.blob) ||
      !isNotificationDeploymentDigest(value.watchConfigDigest) ||
      !isTimestamp(value.deadlineAt)
    ) {
      invalidRecord();
    }
    validateBlob(value.blob as unknown as WatchRouteBlobReferenceV2);
  } else if (
    value.vendorId !== undefined ||
    value.blob !== undefined ||
    value.watchConfigDigest !== undefined ||
    value.deadlineAt !== undefined ||
    value.route.delivery.vendor_id !== undefined
  ) {
    invalidRecord();
  }
  if (value.authority === 'openslack' && value.state === 'processing') {
    validateLease(value.lease);
  } else if (value.lease !== undefined) {
    invalidRecord();
  }
  if (value.state === 'accepted') {
    if (
      value.authority !== 'notification_service' ||
      !isRecord(value.receipt) ||
      (value.receiptLedger !== 'pending' && value.receiptLedger !== 'committed') ||
      !['pending', 'delivered', 'dead'].includes(value.remoteDeliveryState)
    ) {
      invalidRecord();
    }
    assertReceiptMatches(
      value as unknown as WatchRouteRecordV2,
      value.receipt as unknown as NotificationAcceptanceReceiptV1,
    );
  } else if (value.receipt !== undefined || value.receiptLedger !== undefined) {
    invalidRecord();
  }
  if (value.terminalReason !== undefined && !isTerminalReason(value.terminalReason))
    invalidRecord();
  if (value.terminalAt !== undefined && !isTimestamp(value.terminalAt)) invalidRecord();
  if (value.completedAt !== undefined && !isTimestamp(value.completedAt)) invalidRecord();
  if (value.lastDiagnostic !== undefined) validateDiagnostic(value.lastDiagnostic);
  if (
    value.migrationDisposition !== undefined &&
    !['legacy_owned', 'completed_tombstone', 'terminal_archive'].includes(
      String(value.migrationDisposition),
    )
  ) {
    invalidRecord();
  }
}

const RECORD_KEYS = [
  'id',
  'canonicalRepository',
  'stableKey',
  'deliveryIds',
  'event',
  'routeId',
  'routingEpoch',
  'backend',
  'route',
  'vendorId',
  'idempotencyKey',
  'blob',
  'watchConfigDigest',
  'state',
  'authority',
  'attemptCount',
  'availableAt',
  'firstPersistedAt',
  'deadlineAt',
  'updatedAt',
  'lease',
  'receipt',
  'receiptLedger',
  'remoteDeliveryState',
  'terminalReason',
  'terminalAt',
  'completedAt',
  'lastDiagnostic',
  'recoveryCycle',
  'migrationDisposition',
] as const;

function assertReceiptMatches(
  record: WatchRouteRecordV2,
  receipt: NotificationAcceptanceReceiptV1,
): void {
  if (
    receipt.route_record_id !== record.id ||
    receipt.canonical_repository !== record.canonicalRepository ||
    receipt.route_id !== record.routeId ||
    receipt.routing_epoch !== record.routingEpoch ||
    receipt.vendor_id !== record.vendorId ||
    receipt.idempotency_key !== record.idempotencyKey ||
    receipt.watch_config_digest !== record.watchConfigDigest
  ) {
    throw queueError('QUEUE_RECEIPT_CONFLICT', 'Acceptance receipt identity is inconsistent.');
  }
}

function requireLease(
  state: WatchDeliveryQueueV2State,
  id: string,
  token: string,
  backend?: WatchRouteRecordV2['backend'],
): WatchRouteRecordV2 {
  const record = state.routes.find((candidate) => candidate.id === id);
  if (
    !record ||
    record.authority !== 'openslack' ||
    record.state !== 'processing' ||
    !record.lease ||
    record.lease.token !== token ||
    (backend && record.backend !== backend)
  ) {
    throw queueError('QUEUE_TRANSITION_INVALID', 'The watch route lease is missing or stale.');
  }
  return record;
}

function expireProcessingLeases(state: WatchDeliveryQueueV2State, now: Date): void {
  for (const record of state.routes) {
    if (
      record.authority !== 'openslack' ||
      record.state !== 'processing' ||
      !record.lease ||
      Date.parse(record.lease.expiresAt) > now.getTime()
    ) {
      continue;
    }
    if (record.backend === 'notification_service') {
      if (
        deadlineReached(record, now) ||
        record.attemptCount >= NOTIFICATION_HANDOFF_POLICY.maxAttempts
      ) {
        markHandoffDead(
          record,
          deadlineReached(record, now) ? 'deadline_exhausted' : 'attempts_exhausted',
          now,
          { code: 'HANDOFF_PROCESSING_LEASE_EXPIRED', message: 'A handoff attempt lease expired.' },
        );
      } else {
        record.state = 'retryable';
        record.availableAt = new Date(
          Math.min(now.getTime() + retryDelay(record), Date.parse(record.deadlineAt!)),
        ).toISOString();
        record.updatedAt = now.toISOString();
        record.lastDiagnostic = sanitizeDiagnostic(
          { code: 'HANDOFF_PROCESSING_LEASE_EXPIRED', message: 'A handoff attempt lease expired.' },
          true,
          now,
        );
        delete record.lease;
      }
    } else if (record.attemptCount >= DIRECT_MAX_ATTEMPTS) {
      markDirectFailed(record, now, {
        code: 'DIRECT_PROCESSING_LEASE_EXPIRED',
        message: 'A direct delivery attempt lease expired.',
      });
    } else {
      record.state = 'retryable';
      record.availableAt = new Date(now.getTime() + retryDelay(record)).toISOString();
      record.updatedAt = now.toISOString();
      delete record.lease;
    }
  }
}

function exhaustUnclaimableServiceRoutes(state: WatchDeliveryQueueV2State, now: Date): void {
  for (const record of state.routes) {
    if (
      record.authority !== 'openslack' ||
      record.backend !== 'notification_service' ||
      (record.state !== 'pending' && record.state !== 'retryable')
    ) {
      continue;
    }
    if (deadlineReached(record, now)) markHandoffDead(record, 'deadline_exhausted', now);
    else if (record.attemptCount >= NOTIFICATION_HANDOFF_POLICY.maxAttempts) {
      markHandoffDead(record, 'attempts_exhausted', now);
    }
  }
}

function markHandoffDead(
  record: WatchRouteRecordV2,
  reason: Extract<HandoffTerminalReason, 'attempts_exhausted' | 'deadline_exhausted'>,
  now: Date,
  diagnostic?: Omit<WatchRouteDiagnosticV2, 'retryable' | 'recordedAt'>,
): void {
  const timestamp = now.toISOString();
  record.state = 'handoff_dead';
  record.authority = 'terminal';
  record.terminalReason = reason;
  record.terminalAt = timestamp;
  record.availableAt = timestamp;
  record.updatedAt = timestamp;
  record.lastDiagnostic = sanitizeDiagnostic(
    diagnostic ?? {
      code:
        reason === 'attempts_exhausted'
          ? 'HANDOFF_ATTEMPTS_EXHAUSTED'
          : 'HANDOFF_DEADLINE_EXHAUSTED',
      message:
        reason === 'attempts_exhausted'
          ? 'The handoff attempt limit was exhausted.'
          : 'The handoff deadline was exhausted.',
    },
    false,
    now,
  );
  delete record.lease;
}

function markDirectFailed(
  record: WatchRouteRecordV2,
  now: Date,
  diagnostic: Omit<WatchRouteDiagnosticV2, 'retryable' | 'recordedAt'>,
): void {
  const timestamp = now.toISOString();
  record.state = 'failed';
  record.authority = 'terminal';
  record.terminalAt = timestamp;
  record.availableAt = timestamp;
  record.updatedAt = timestamp;
  record.lastDiagnostic = sanitizeDiagnostic(diagnostic, false, now);
  delete record.lease;
}

function mayAttempt(record: WatchRouteRecordV2, now: Date): boolean {
  return record.backend === 'notification_service'
    ? record.attemptCount < NOTIFICATION_HANDOFF_POLICY.maxAttempts && !deadlineReached(record, now)
    : record.attemptCount < DIRECT_MAX_ATTEMPTS;
}

function deadlineReached(record: WatchRouteRecordV2, now: Date): boolean {
  return record.deadlineAt !== undefined && now.getTime() >= Date.parse(record.deadlineAt);
}

function retryDelay(record: WatchRouteRecordV2, retryAfterMs?: number): number {
  const base =
    record.backend === 'notification_service'
      ? NOTIFICATION_HANDOFF_POLICY.baseRetryMs
      : DIRECT_BASE_RETRY_MS;
  const cap =
    record.backend === 'notification_service'
      ? NOTIFICATION_HANDOFF_POLICY.retryCapMs
      : DIRECT_RETRY_CAP_MS;
  const exponential = Math.min(cap, base * 2 ** Math.max(0, record.attemptCount - 1));
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
    return exponential;
  }
  return Math.min(cap, Math.max(exponential, Math.round(retryAfterMs)));
}

function findDeliveryIdConflict(
  state: WatchDeliveryQueueV2State,
  event: PersistableRepositoryEvent,
): string | null {
  if (!event.deliveryId) return null;
  const record = state.routes.find((candidate) => candidate.deliveryIds.includes(event.deliveryId));
  if (record && record.stableKey !== event.stableKey) return record.stableKey;
  const tombstone = state.legacyEventTombstones.find(
    (candidate) => candidate.deliveryId === event.deliveryId,
  );
  if (tombstone && tombstone.stableKey !== event.stableKey) return tombstone.stableKey;
  return null;
}

function assertDistinctRouteInputs(records: WatchRouteRecordV2[]): void {
  if (new Set(records.map((record) => record.id)).size !== records.length) {
    throw queueError('QUEUE_TRANSITION_INVALID', 'A delivery contains duplicate v2 routes.');
  }
}

function assertImmutableRouteMatch(
  existing: WatchRouteRecordV2,
  candidate: WatchRouteRecordV2,
): void {
  const existingImmutable = immutableRoute(existing);
  const candidateImmutable = immutableRoute(candidate);
  if (JSON.stringify(existingImmutable) !== JSON.stringify(candidateImmutable)) {
    throw queueError('QUEUE_IMMUTABLE_CONFLICT', 'A route record immutable identity conflicts.');
  }
}

function assertLegacyImmutableMatch(
  existing: WatchRouteRecordV2,
  candidate: WatchRouteRecordV2,
): void {
  for (const key of [
    'id',
    'canonicalRepository',
    'stableKey',
    'routeId',
    'routingEpoch',
    'backend',
    'idempotencyKey',
    'firstPersistedAt',
  ] as const) {
    if (existing[key] !== candidate[key]) {
      throw queueError(
        'QUEUE_IMMUTABLE_CONFLICT',
        'A migrated route immutable identity conflicts.',
      );
    }
  }
}

function immutableRoute(record: WatchRouteRecordV2): unknown {
  return {
    id: record.id,
    canonicalRepository: record.canonicalRepository,
    stableKey: record.stableKey,
    event: { ...record.event, deliveryId: '' },
    routeId: record.routeId,
    routingEpoch: record.routingEpoch,
    backend: record.backend,
    route: record.route,
    vendorId: record.vendorId,
    idempotencyKey: record.idempotencyKey,
    blob: record.blob,
    watchConfigDigest: record.watchConfigDigest,
    firstPersistedAt: record.firstPersistedAt,
    deadlineAt: record.deadlineAt,
  };
}

function rememberDeliveryId(
  record: WatchRouteRecordV2,
  deliveryId: string,
  timestamp: string,
): void {
  if (!deliveryId || record.deliveryIds.includes(deliveryId)) return;
  if (record.deliveryIds.length >= 64) {
    throw queueError('QUEUE_CAPACITY_EXCEEDED', 'A route record exhausted delivery id aliases.');
  }
  record.deliveryIds.push(deliveryId);
  record.updatedAt = timestamp;
}

function validateBlob(blob: WatchRouteBlobReferenceV2): void {
  if (
    !isRecord(blob) ||
    !hasOnlyKeys(blob as unknown as Record<string, unknown>, [
      'digest',
      'size',
      'mediaType',
      'encoderVersion',
    ]) ||
    typeof blob.digest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/u.test(blob.digest) ||
    !Number.isSafeInteger(blob.size) ||
    blob.size < 0 ||
    blob.size > NOTIFICATION_HANDOFF_POLICY.maxVendorBodyBytes ||
    blob.mediaType !== 'application/json' ||
    !['openslack.slack_chat_post_message.v1', 'openslack.webhook_notification.v1'].includes(
      blob.encoderVersion,
    )
  ) {
    throw queueError('QUEUE_STATE_INVALID', 'A watch route Blob reference is invalid.');
  }
}

function validateLegacyBinding(binding: LegacyWatchRouteBindingV2): void {
  if (
    !binding.routeKey ||
    !isNotificationHandoffRouteId(binding.routeId) ||
    !Number.isSafeInteger(binding.routingEpoch) ||
    binding.routingEpoch <= 0
  ) {
    throw queueError('QUEUE_TRANSITION_INVALID', 'A legacy migration route binding is invalid.');
  }
}

function validateLease(value: unknown): asserts value is WatchRouteLeaseV2 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['token', 'workerId', 'acquiredAt', 'expiresAt']) ||
    typeof value.token !== 'string' ||
    !value.token ||
    typeof value.workerId !== 'string' ||
    !value.workerId ||
    !isTimestamp(value.acquiredAt) ||
    !isTimestamp(value.expiresAt)
  ) {
    invalidRecord();
  }
}

function validateDiagnostic(value: unknown): asserts value is WatchRouteDiagnosticV2 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['code', 'message', 'retryable', 'recordedAt', 'status']) ||
    typeof value.code !== 'string' ||
    !/^[A-Z0-9_]{1,80}$/u.test(value.code) ||
    typeof value.message !== 'string' ||
    !value.message ||
    value.message.length > 300 ||
    typeof value.retryable !== 'boolean' ||
    !isTimestamp(value.recordedAt) ||
    (value.status !== undefined &&
      (typeof value.status !== 'number' ||
        !Number.isSafeInteger(value.status) ||
        value.status < 100 ||
        value.status > 599))
  ) {
    invalidRecord();
  }
}

function validateLegacyTombstone(value: unknown): void {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['deliveryId', 'stableKey', 'recordedAt']) ||
    typeof value.deliveryId !== 'string' ||
    typeof value.stableKey !== 'string' ||
    !value.stableKey ||
    !isTimestamp(value.recordedAt)
  ) {
    throw queueError('QUEUE_STATE_INVALID', 'A legacy event tombstone is invalid.');
  }
}

function sanitizeDiagnostic(
  diagnostic: Omit<WatchRouteDiagnosticV2, 'retryable' | 'recordedAt'>,
  retryable: boolean,
  now: Date,
): WatchRouteDiagnosticV2 {
  const code = /^[A-Z0-9_]{1,80}$/u.test(diagnostic.code) ? diagnostic.code : 'DELIVERY_FAILED';
  const message = diagnostic.message.replace(/[\r\n]+/gu, ' ').slice(0, 300);
  return {
    code,
    message: message || 'The delivery failed safely.',
    retryable,
    recordedAt: now.toISOString(),
    ...(diagnostic.status === undefined ? {} : { status: diagnostic.status }),
  };
}

function receiptsEqual(
  left: NotificationAcceptanceReceiptV1,
  right: NotificationAcceptanceReceiptV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function legacyTombstoneKey(value: { deliveryId: string; stableKey: string }): string {
  return `${value.stableKey}\0${value.deliveryId}`;
}

function compareRoutes(left: WatchRouteRecordV2, right: WatchRouteRecordV2): number {
  return left.id.localeCompare(right.id);
}

function compareAvailableRoutes(left: WatchRouteRecordV2, right: WatchRouteRecordV2): number {
  return (
    left.availableAt.localeCompare(right.availableAt) ||
    left.firstPersistedAt.localeCompare(right.firstPersistedAt) ||
    left.id.localeCompare(right.id)
  );
}

function cloneRoute(record: WatchRouteRecordV2): WatchRouteRecordV2 {
  return structuredClone(record);
}

function cloneRoutes(records: WatchRouteRecordV2[]): WatchRouteRecordV2[] {
  return records.map(cloneRoute);
}

function validatePolicy(policy: WatchDeliveryQueueV2Policy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`Invalid watch delivery v2 queue policy: ${name}.`);
    }
  }
}

function isRouteState(value: unknown): value is WatchRouteStateV2 {
  return [
    'pending',
    'processing',
    'retryable',
    'accepted',
    'rejected',
    'quarantined',
    'handoff_dead',
    'completed',
    'failed',
  ].includes(String(value));
}

function isAuthority(value: unknown): value is WatchRouteAuthorityV2 {
  return ['openslack', 'notification_service', 'legacy_v1', 'terminal'].includes(String(value));
}

function isRemoteState(value: unknown): value is RemoteDeliveryState {
  return ['unknown', 'pending', 'delivered', 'dead'].includes(String(value));
}

function isTerminalReason(value: unknown): value is HandoffTerminalReason {
  return [
    'attempts_exhausted',
    'deadline_exhausted',
    'deterministic_rejection',
    'protocol_redirect',
    'unexpected_client_error',
    'unexpected_success_status',
    'deployment_digest_mismatch',
    'idempotency_conflict',
    'receipt_conflict',
    'blob_digest_mismatch',
    'blob_size_mismatch',
    'blob_not_available',
  ].includes(String(value));
}

function invalidRecord(): never {
  throw queueError('QUEUE_STATE_INVALID', 'A watch delivery v2 route record is invalid.');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function queueError(
  code: WatchDeliveryQueueV2Error['code'],
  message: string,
): WatchDeliveryQueueV2Error {
  return new WatchDeliveryQueueV2Error(code, message);
}

function isolateStaleLock(path: string, staleMs: number): void {
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  if (status.isSymbolicLink() || !status.isFile()) {
    throw queueError(
      'QUEUE_STATE_INVALID',
      'Watch delivery v2 queue lock is a link, junction or non-regular file.',
    );
  }
  if (process.platform !== 'win32' && (status.mode & 0o777) !== 0o600) {
    throw queueError(
      'QUEUE_STATE_INVALID',
      'Watch delivery v2 queue lock permissions must be 0600.',
    );
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    const age = Date.now() - status.mtimeMs;
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid < 1 ||
      isProcessAlive(parsed.pid) ||
      age <= staleMs
    ) {
      return;
    }
    rmSync(path, { force: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    // A malformed or concurrently changed lock is unknown ownership and must
    // remain in place so acquisition fails closed instead of risking split ownership.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function fsyncDirectoryBestEffort(path: string): void {
  if (process.platform === 'win32') return;
  try {
    const descriptor = openSync(path, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Some filesystems do not support directory fsync.
  }
}

function blockFor(milliseconds: number): void {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, milliseconds);
}
