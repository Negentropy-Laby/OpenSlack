import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { GitHubWatchRoute } from './watch-config.js';
import {
  canonicalizeRepositoryName,
  canonicalWatchRouteKey,
  type PersistableRepositoryEvent,
} from './repository-event.js';
import { withNotificationStorageLock } from './notification-storage-fs.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_WATCH_DELIVERY_POLICY = Object.freeze({
  leaseMs: 60_000,
  maxAttempts: 5,
  baseBackoffMs: 1_000,
  maxBackoffMs: 5 * 60_000,
  completedRetentionMs: 7 * DAY_MS,
  failedRetentionMs: 14 * DAY_MS,
  maxRecords: 10_000,
  maxStateBytes: 16 * 1024 * 1024,
  lockTimeoutMs: 5_000,
  lockStaleMs: 30_000,
});

export type WatchDeliveryState = 'pending' | 'processing' | 'retryable' | 'completed' | 'failed';

export interface WatchDeliveryDiagnostic {
  code: string;
  message: string;
  retryable: boolean;
  recordedAt: string;
}

export interface WatchDeliveryLease {
  token: string;
  workerId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface WatchRouteDelivery {
  routeKey: string;
  idempotencyKey: string;
  route: GitHubWatchRoute;
  state: WatchDeliveryState;
  attempts: number;
  availableAt: string;
  updatedAt: string;
  completedAt?: string;
  terminalAt?: string;
  lastDiagnostic?: WatchDeliveryDiagnostic;
}

export interface WatchDeliveryRecord {
  id: string;
  stableKey: string;
  deliveryId: string;
  deliveryIds: string[];
  event: PersistableRepositoryEvent;
  state: WatchDeliveryState;
  attempts: number;
  refreshAttempts: number;
  createdAt: string;
  updatedAt: string;
  availableAt: string;
  completedAt?: string;
  terminalAt?: string;
  lease?: WatchDeliveryLease;
  routes: WatchRouteDelivery[];
  lastDiagnostic?: WatchDeliveryDiagnostic;
}

interface LegacyTombstone {
  deliveryId: string;
  stableKey: string;
  recordedAt: string;
}

interface WatchDeliveryQueueState {
  schema: 'openslack.watch_delivery_queue.v1';
  updatedAt: string;
  deliveries: WatchDeliveryRecord[];
  legacyTombstones: LegacyTombstone[];
}

export interface WatchDeliveryPolicy {
  leaseMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  completedRetentionMs: number;
  failedRetentionMs: number;
  maxRecords: number;
  maxStateBytes: number;
  lockTimeoutMs: number;
  lockStaleMs: number;
}

export interface WatchDeliveryQueueOptions {
  policy?: Partial<WatchDeliveryPolicy>;
  now?: () => Date;
  nonce?: () => string;
}

export type ClaimAndEnqueueResult =
  | { outcome: 'enqueued'; delivery: WatchDeliveryRecord }
  | {
      outcome: 'duplicate';
      delivery: WatchDeliveryRecord | null;
      duplicateState: WatchDeliveryState | 'legacy';
    }
  | {
      outcome: 'conflict';
      code: 'DELIVERY_ID_CONFLICT';
      existingStableKey: string;
    };

export interface ClaimedWatchDelivery {
  delivery: WatchDeliveryRecord;
  lease: WatchDeliveryLease;
}

export interface WatchDeliveryStats {
  count: number;
  pending: number;
  processing: number;
  retryable: number;
  completed: number;
  failed: number;
  exhausted: number;
  activeLeases: number;
  legacyTombstones: number;
  oldestPendingAt?: string;
  nextRetryAt?: string;
  lastTimestamp?: string;
  lastFailure?: WatchDeliveryDiagnostic;
}

export interface WatchDeliveryQueueSnapshotV1 {
  schema: 'openslack.watch_delivery_queue.v1';
  updatedAt: string;
  deliveries: WatchDeliveryRecord[];
  legacyTombstones: Array<{
    deliveryId: string;
    stableKey: string;
    recordedAt: string;
  }>;
}

export interface WatchDeliveryV2MigrationMarker {
  schema: 'openslack.watch_delivery_v2_migration.v1';
  state: 'draining' | 'finalized';
  startedAt: string;
  updatedAt: string;
  v2StatePath: string;
  backupPath?: string;
  backupDigest?: `sha256:${string}`;
}

export interface WatchDeliveryV1FinalizationResult {
  backupPath: string;
  backupDigest: `sha256:${string}`;
}

export class WatchDeliveryQueueError extends Error {
  readonly code:
    | 'QUEUE_LOCK_TIMEOUT'
    | 'QUEUE_STATE_INVALID'
    | 'QUEUE_CAPACITY_EXCEEDED'
    | 'QUEUE_STATE_TOO_LARGE'
    | 'QUEUE_TRANSITION_INVALID'
    | 'QUEUE_MIGRATED';

  constructor(code: WatchDeliveryQueueError['code'], message: string) {
    super(message);
    this.name = 'WatchDeliveryQueueError';
    this.code = code;
  }
}

export class WatchDeliveryQueue {
  private readonly stateDir: string;
  private readonly statePath: string;
  private readonly legacyPath: string;
  private readonly migrationMarkerPath: string;
  private readonly policy: WatchDeliveryPolicy;
  private readonly now: () => Date;
  private readonly nonce: () => string;

  constructor(stateDir?: string, options: WatchDeliveryQueueOptions = {}) {
    this.stateDir = stateDir ?? join(process.cwd(), '.openslack.local', 'daemon');
    this.statePath = join(this.stateDir, 'delivery-state.v1.json');
    this.legacyPath = join(this.stateDir, 'dedupe.jsonl');
    this.migrationMarkerPath = join(this.stateDir, 'delivery-state.v2-migration.json');
    this.policy = {
      ...DEFAULT_WATCH_DELIVERY_POLICY,
      ...options.policy,
    };
    validatePolicy(this.policy);
    this.now = options.now ?? (() => new Date());
    this.nonce = options.nonce ?? randomUUID;
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
  }

  claimAndEnqueue(
    event: PersistableRepositoryEvent,
    routes: GitHubWatchRoute[],
  ): ClaimAndEnqueueResult {
    return this.mutate((state, now) => {
      if (existsSync(this.migrationMarkerPath)) {
        throw new WatchDeliveryQueueError(
          'QUEUE_MIGRATED',
          'GitHub watch delivery v1 admission is fenced after v2 migration starts.',
        );
      }
      const conflictingDelivery = event.deliveryId
        ? (state.deliveries.find((delivery) => delivery.deliveryIds.includes(event.deliveryId)) ??
          null)
        : null;
      if (conflictingDelivery && conflictingDelivery.stableKey !== event.stableKey) {
        return {
          outcome: 'conflict',
          code: 'DELIVERY_ID_CONFLICT',
          existingStableKey: conflictingDelivery.stableKey,
        };
      }

      const duplicate =
        conflictingDelivery ??
        state.deliveries.find((delivery) => delivery.stableKey === event.stableKey);
      if (duplicate) {
        if (
          event.deliveryId.length > 0 &&
          !duplicate.deliveryIds.includes(event.deliveryId) &&
          duplicate.deliveryIds.length < 64
        ) {
          duplicate.deliveryIds.push(event.deliveryId);
          duplicate.updatedAt = now.toISOString();
        }
        return {
          outcome: 'duplicate',
          delivery: cloneDelivery(duplicate),
          duplicateState: duplicate.state,
        };
      }

      const legacy = state.legacyTombstones.find(
        (entry) =>
          entry.stableKey === event.stableKey ||
          (event.deliveryId.length > 0 && entry.deliveryId === event.deliveryId),
      );
      if (legacy) {
        if (
          event.deliveryId.length > 0 &&
          legacy.deliveryId === event.deliveryId &&
          legacy.stableKey !== event.stableKey
        ) {
          return {
            outcome: 'conflict',
            code: 'DELIVERY_ID_CONFLICT',
            existingStableKey: legacy.stableKey,
          };
        }
        return {
          outcome: 'duplicate',
          delivery: null,
          duplicateState: 'legacy',
        };
      }

      if (state.deliveries.length >= this.policy.maxRecords) {
        throw new WatchDeliveryQueueError(
          'QUEUE_CAPACITY_EXCEEDED',
          'GitHub watch delivery queue capacity is exhausted.',
        );
      }

      const canonicalRoutes = canonicalizeRoutes(event, routes);
      const timestamp = now.toISOString();
      const delivery: WatchDeliveryRecord = {
        id: deliveryRecordId(event.stableKey),
        stableKey: event.stableKey,
        deliveryId: event.deliveryId,
        deliveryIds: event.deliveryId ? [event.deliveryId] : [],
        event: structuredClone(event),
        state: canonicalRoutes.length === 0 ? 'completed' : 'pending',
        attempts: 0,
        refreshAttempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        availableAt: timestamp,
        ...(canonicalRoutes.length === 0 ? { completedAt: timestamp, terminalAt: timestamp } : {}),
        routes: canonicalRoutes.map(({ routeKey, route }) => ({
          routeKey,
          idempotencyKey: routeIdempotencyKey(event.stableKey, routeKey),
          route,
          state: 'pending',
          attempts: 0,
          availableAt: timestamp,
          updatedAt: timestamp,
        })),
      };
      state.deliveries.push(delivery);
      return { outcome: 'enqueued', delivery: cloneDelivery(delivery) };
    });
  }

  claimNext(workerId: string): ClaimedWatchDelivery | null {
    if (!workerId.trim()) {
      throw new WatchDeliveryQueueError(
        'QUEUE_TRANSITION_INVALID',
        'A non-empty delivery worker identity is required.',
      );
    }
    return this.mutate((state, now) => {
      const nowMs = now.getTime();
      const delivery = state.deliveries
        .filter(
          (candidate) =>
            (candidate.state === 'pending' || candidate.state === 'retryable') &&
            Date.parse(candidate.availableAt) <= nowMs &&
            candidate.attempts < maxDeliveryClaims(candidate, this.policy) &&
            candidate.routes.some(
              (route) =>
                (route.state === 'pending' || route.state === 'retryable') &&
                Date.parse(route.availableAt) <= nowMs &&
                route.attempts < this.policy.maxAttempts,
            ),
        )
        .sort(compareAvailableDeliveries)[0];
      if (!delivery) return null;

      const timestamp = now.toISOString();
      const lease: WatchDeliveryLease = {
        token: this.nonce(),
        workerId,
        acquiredAt: timestamp,
        expiresAt: new Date(nowMs + this.policy.leaseMs).toISOString(),
      };
      delivery.state = 'processing';
      delivery.attempts += 1;
      delivery.updatedAt = timestamp;
      delivery.lease = lease;
      return {
        delivery: cloneDelivery(delivery),
        lease: { ...lease },
      };
    });
  }

  beginRouteAttempt(
    deliveryId: string,
    leaseToken: string,
    routeKey: string,
  ): WatchRouteDelivery | null {
    return this.mutate((state, now) => {
      const delivery = requireLease(state, deliveryId, leaseToken);
      const route = delivery.routes.find((candidate) => candidate.routeKey === routeKey);
      if (!route) {
        throw new WatchDeliveryQueueError(
          'QUEUE_TRANSITION_INVALID',
          'The claimed delivery route does not exist.',
        );
      }
      if (
        (route.state !== 'pending' && route.state !== 'retryable') ||
        route.attempts >= this.policy.maxAttempts ||
        Date.parse(route.availableAt) > now.getTime()
      ) {
        return null;
      }
      route.state = 'processing';
      route.attempts += 1;
      route.updatedAt = now.toISOString();
      delivery.updatedAt = route.updatedAt;
      return cloneRoute(route);
    });
  }

  markRouteCompleted(
    deliveryId: string,
    leaseToken: string,
    routeKey: string,
  ): WatchDeliveryRecord {
    return this.mutate((state, now) => {
      const delivery = requireLease(state, deliveryId, leaseToken);
      const route = requireProcessingRoute(delivery, routeKey);
      const timestamp = now.toISOString();
      route.state = 'completed';
      route.completedAt = timestamp;
      route.terminalAt = timestamp;
      route.updatedAt = timestamp;
      delete route.lastDiagnostic;
      delivery.updatedAt = timestamp;
      return cloneDelivery(delivery);
    });
  }

  markRouteRetryable(
    deliveryId: string,
    leaseToken: string,
    routeKey: string,
    diagnostic: Omit<WatchDeliveryDiagnostic, 'retryable' | 'recordedAt'>,
    retryAfterMs?: number,
  ): WatchDeliveryRecord {
    return this.mutate((state, now) => {
      const delivery = requireLease(state, deliveryId, leaseToken);
      const route = requireProcessingRoute(delivery, routeKey);
      const timestamp = now.toISOString();
      const exhausted = route.attempts >= this.policy.maxAttempts;
      const recorded: WatchDeliveryDiagnostic = {
        ...sanitizeDiagnostic(diagnostic, exhausted ? false : true),
        recordedAt: timestamp,
      };
      route.state = exhausted ? 'failed' : 'retryable';
      route.availableAt = exhausted
        ? timestamp
        : new Date(now.getTime() + this.retryDelayMs(route.attempts, retryAfterMs)).toISOString();
      route.updatedAt = timestamp;
      route.lastDiagnostic = recorded;
      if (exhausted) route.terminalAt = timestamp;
      delivery.updatedAt = timestamp;
      delivery.lastDiagnostic = recorded;
      return cloneDelivery(delivery);
    });
  }

  markRouteFailed(
    deliveryId: string,
    leaseToken: string,
    routeKey: string,
    diagnostic: Omit<WatchDeliveryDiagnostic, 'retryable' | 'recordedAt'>,
  ): WatchDeliveryRecord {
    return this.mutate((state, now) => {
      const delivery = requireLease(state, deliveryId, leaseToken);
      const route = requireProcessingRoute(delivery, routeKey);
      const timestamp = now.toISOString();
      const recorded: WatchDeliveryDiagnostic = {
        ...sanitizeDiagnostic(diagnostic, false),
        recordedAt: timestamp,
      };
      route.state = 'failed';
      route.availableAt = timestamp;
      route.updatedAt = timestamp;
      route.terminalAt = timestamp;
      route.lastDiagnostic = recorded;
      delivery.updatedAt = timestamp;
      delivery.lastDiagnostic = recorded;
      return cloneDelivery(delivery);
    });
  }

  retryDelivery(
    deliveryId: string,
    leaseToken: string,
    diagnostic: Omit<WatchDeliveryDiagnostic, 'retryable' | 'recordedAt'>,
  ): WatchDeliveryRecord {
    return this.mutate((state, now) => {
      const delivery = requireLease(state, deliveryId, leaseToken);
      const timestamp = now.toISOString();
      delivery.refreshAttempts += 1;
      const exhausted = delivery.refreshAttempts >= this.policy.maxAttempts;
      const recorded: WatchDeliveryDiagnostic = {
        ...sanitizeDiagnostic(diagnostic, exhausted ? false : true),
        recordedAt: timestamp,
      };
      delivery.state = exhausted ? 'failed' : 'retryable';
      delivery.availableAt = exhausted
        ? timestamp
        : new Date(now.getTime() + this.backoffMs(delivery.attempts)).toISOString();
      delivery.updatedAt = timestamp;
      delivery.lastDiagnostic = recorded;
      if (exhausted) {
        delivery.terminalAt = timestamp;
        failIncompleteRoutes(delivery, recorded, timestamp);
      }
      delete delivery.lease;
      return cloneDelivery(delivery);
    });
  }

  failDelivery(
    deliveryId: string,
    leaseToken: string,
    diagnostic: Omit<WatchDeliveryDiagnostic, 'retryable' | 'recordedAt'>,
  ): WatchDeliveryRecord {
    return this.mutate((state, now) => {
      const delivery = requireLease(state, deliveryId, leaseToken);
      const timestamp = now.toISOString();
      const recorded: WatchDeliveryDiagnostic = {
        ...sanitizeDiagnostic(diagnostic, false),
        recordedAt: timestamp,
      };
      delivery.state = 'failed';
      delivery.availableAt = timestamp;
      delivery.updatedAt = timestamp;
      delivery.terminalAt = timestamp;
      delivery.lastDiagnostic = recorded;
      failIncompleteRoutes(delivery, recorded, timestamp);
      delete delivery.lease;
      return cloneDelivery(delivery);
    });
  }

  finishDelivery(deliveryId: string, leaseToken: string): WatchDeliveryRecord {
    return this.mutate((state, now) => {
      const delivery = requireLease(state, deliveryId, leaseToken);
      const timestamp = now.toISOString();
      const incomplete = delivery.routes.filter(
        (route) => route.state !== 'completed' && route.state !== 'failed',
      );
      if (incomplete.some((route) => route.state === 'processing')) {
        throw new WatchDeliveryQueueError(
          'QUEUE_TRANSITION_INVALID',
          'A delivery cannot finish while a route attempt is still processing.',
        );
      }

      if (delivery.routes.every((route) => route.state === 'completed')) {
        delivery.state = 'completed';
        delivery.completedAt = timestamp;
        delivery.terminalAt = timestamp;
        delivery.availableAt = timestamp;
      } else if (incomplete.length === 0) {
        delivery.state = 'failed';
        delivery.terminalAt = timestamp;
        delivery.availableAt = timestamp;
      } else {
        delivery.state = 'retryable';
        delivery.availableAt = earliestAvailableAt(incomplete);
      }
      delivery.updatedAt = timestamp;
      delete delivery.lease;
      return cloneDelivery(delivery);
    });
  }

  recoverExpiredLeases(): number {
    let recovered = 0;
    this.mutate((state, now) => {
      recovered = recoverExpired(state, now, this.policy);
      return recovered;
    }, false);
    return recovered;
  }

  compact(): number {
    let removed = 0;
    this.mutate((state, now) => {
      removed = compactState(state, now, this.policy);
      return removed;
    }, false);
    return removed;
  }

  getDelivery(id: string): WatchDeliveryRecord | null {
    return this.read((state) => {
      const delivery = state.deliveries.find((candidate) => candidate.id === id);
      return delivery ? cloneDelivery(delivery) : null;
    });
  }

  getStats(): WatchDeliveryStats {
    return this.read((state) => {
      const stats: WatchDeliveryStats = {
        count: state.deliveries.length + state.legacyTombstones.length,
        pending: 0,
        processing: 0,
        retryable: 0,
        completed: 0,
        failed: 0,
        exhausted: 0,
        activeLeases: 0,
        legacyTombstones: state.legacyTombstones.length,
      };
      const pendingTimes: string[] = [];
      const retryTimes: string[] = [];
      const timestamps: string[] = [];
      const failures: WatchDeliveryDiagnostic[] = [];
      for (const delivery of state.deliveries) {
        stats[delivery.state] += 1;
        if (delivery.lease) stats.activeLeases += 1;
        if (
          (delivery.state === 'retryable' || delivery.state === 'failed') &&
          (delivery.refreshAttempts >= this.policy.maxAttempts ||
            delivery.attempts >= maxDeliveryClaims(delivery, this.policy))
        ) {
          stats.exhausted += 1;
        }
        if (delivery.state === 'pending') pendingTimes.push(delivery.createdAt);
        if (delivery.state === 'retryable') retryTimes.push(delivery.availableAt);
        timestamps.push(delivery.updatedAt);
        if (delivery.lastDiagnostic) failures.push(delivery.lastDiagnostic);
      }
      timestamps.push(...state.legacyTombstones.map((entry) => entry.recordedAt));
      stats.oldestPendingAt = earliestOptional(pendingTimes);
      stats.nextRetryAt = earliestOptional(retryTimes);
      stats.lastTimestamp = latestOptional(timestamps);
      stats.lastFailure = failures.sort((left, right) =>
        right.recordedAt.localeCompare(left.recordedAt),
      )[0];
      return stats;
    });
  }

  isDuplicate(deliveryId: string): boolean {
    if (!deliveryId) return false;
    return this.read((state) => findByDeliveryId(state, deliveryId) !== null);
  }

  isDuplicateByStableKey(stableKey: string): boolean {
    if (!stableKey) return false;
    return this.read(
      (state) =>
        state.deliveries.some((delivery) => delivery.stableKey === stableKey) ||
        state.legacyTombstones.some((entry) => entry.stableKey === stableKey),
    );
  }

  record(deliveryId: string | undefined, stableKey: string): void {
    if (!stableKey) {
      throw new WatchDeliveryQueueError(
        'QUEUE_TRANSITION_INVALID',
        'A non-empty stable key is required.',
      );
    }
    this.mutate((state, now) => {
      if (
        state.legacyTombstones.some(
          (entry) =>
            entry.stableKey === stableKey || (deliveryId && entry.deliveryId === deliveryId),
        ) ||
        state.deliveries.some(
          (entry) =>
            entry.stableKey === stableKey || (deliveryId && entry.deliveryIds.includes(deliveryId)),
        )
      ) {
        return;
      }
      state.legacyTombstones.push({
        deliveryId: deliveryId ?? '',
        stableKey,
        recordedAt: now.toISOString(),
      });
      state.legacyTombstones = newestTombstones(state.legacyTombstones, this.policy.maxRecords);
    });
  }

  clearCache(): void {
    // Compatibility no-op. Every operation re-reads the authoritative state under a lock.
  }

  readV2MigrationSnapshot(): WatchDeliveryQueueSnapshotV1 {
    return this.withLock(() => cloneQueueState(this.loadState(this.now())));
  }

  startOrRefreshV2Migration<T>(
    v2StatePath: string,
    operation: (snapshot: WatchDeliveryQueueSnapshotV1) => T,
  ): T {
    if (!v2StatePath.trim()) {
      throw new WatchDeliveryQueueError(
        'QUEUE_TRANSITION_INVALID',
        'A non-empty v2 queue state path is required for migration.',
      );
    }
    return this.withLock(() => {
      const now = this.now();
      const snapshot = cloneQueueState(this.loadState(now));
      const result = operation(snapshot);
      const existing = this.loadV2MigrationMarker();
      const timestamp = now.toISOString();
      if (existing && existing.v2StatePath !== v2StatePath) {
        throw new WatchDeliveryQueueError(
          'QUEUE_TRANSITION_INVALID',
          'The v1 queue is already bound to a different v2 migration target.',
        );
      }
      if (!existing) {
        this.persistV2MigrationMarker({
          schema: 'openslack.watch_delivery_v2_migration.v1',
          state: 'draining',
          startedAt: timestamp,
          updatedAt: timestamp,
          v2StatePath,
        });
      }
      return result;
    });
  }

  finalizeV2Migration(v2StatePath: string): WatchDeliveryV1FinalizationResult {
    return this.withLock(() => {
      const marker = this.loadV2MigrationMarker();
      if (!marker || marker.v2StatePath !== v2StatePath) {
        throw new WatchDeliveryQueueError(
          'QUEUE_TRANSITION_INVALID',
          'The v1 queue cannot be finalized without its matching v2 migration marker.',
        );
      }
      if (marker.state === 'finalized' && marker.backupPath && marker.backupDigest) {
        this.verifyFinalizedV2Migration(marker, v2StatePath, false);
        this.persistMigratedSentinel(marker.backupPath, marker.backupDigest);
        return { backupPath: marker.backupPath, backupDigest: marker.backupDigest };
      }

      const state = this.loadState(this.now());
      if (
        state.deliveries.some((delivery) =>
          delivery.routes.some((route) =>
            ['pending', 'processing', 'retryable'].includes(route.state),
          ),
        )
      ) {
        throw new WatchDeliveryQueueError(
          'QUEUE_TRANSITION_INVALID',
          'The v1 queue still contains active route ownership and cannot be finalized.',
        );
      }

      const bytes = existsSync(this.statePath)
        ? readFileSync(this.statePath)
        : Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      const backupDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
      const backupPath = join(
        this.stateDir,
        `delivery-state.v1.${backupDigest.slice('sha256:'.length)}.readonly.json`,
      );
      publishCreateOnlyFile(backupPath, bytes, this.nonce);
      if (process.platform !== 'win32') chmodSync(backupPath, 0o400);

      const timestamp = this.now().toISOString();
      this.persistV2MigrationMarker({
        ...marker,
        state: 'finalized',
        updatedAt: timestamp,
        backupPath,
        backupDigest,
      });
      this.persistMigratedSentinel(backupPath, backupDigest);
      return { backupPath, backupDigest };
    });
  }

  /**
   * New v2-aware runtimes use the finalized marker to skip legacy reads. The
   * v1 APIs intentionally continue parsing the non-JSON sentinel and fail
   * closed when called by an older binary.
   */
  isV2MigrationFinalized(v2StatePath: string): boolean {
    if (!v2StatePath.trim()) {
      throw new WatchDeliveryQueueError(
        'QUEUE_TRANSITION_INVALID',
        'A non-empty v2 queue state path is required for migration status.',
      );
    }
    return this.withLock(() => {
      const marker = this.loadV2MigrationMarker();
      if (!marker) return false;
      if (marker.v2StatePath !== v2StatePath) {
        throw new WatchDeliveryQueueError(
          'QUEUE_TRANSITION_INVALID',
          'The v1 queue is bound to a different v2 migration target.',
        );
      }
      if (marker.state !== 'finalized') return false;
      this.verifyFinalizedV2Migration(marker, v2StatePath, true);
      return true;
    });
  }

  private backoffMs(attempt: number): number {
    return Math.min(
      this.policy.maxBackoffMs,
      this.policy.baseBackoffMs * 2 ** Math.max(0, attempt - 1),
    );
  }

  private retryDelayMs(attempt: number, retryAfterMs: number | undefined): number {
    const backoffMs = this.backoffMs(attempt);
    if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      return backoffMs;
    }
    return Math.min(this.policy.maxBackoffMs, Math.max(backoffMs, Math.round(retryAfterMs)));
  }

  private mutate<T>(
    operation: (state: WatchDeliveryQueueState, now: Date) => T,
    runMaintenance = true,
  ): T {
    return this.withLock(() => {
      const now = this.now();
      const state = this.loadState(now);
      if (runMaintenance) {
        recoverExpired(state, now, this.policy);
        compactState(state, now, this.policy);
      }
      const result = operation(state, now);
      state.updatedAt = now.toISOString();
      validateQueueState(state);
      this.persistState(state);
      return result;
    });
  }

  private read<T>(operation: (state: WatchDeliveryQueueState) => T): T {
    return this.withLock(() => {
      const state = this.loadState(this.now());
      validateQueueState(state);
      return operation(state);
    });
  }

  private loadState(now: Date): WatchDeliveryQueueState {
    if (!existsSync(this.statePath)) {
      return {
        schema: 'openslack.watch_delivery_queue.v1',
        updatedAt: now.toISOString(),
        deliveries: [],
        legacyTombstones: this.loadLegacyTombstones(now),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.statePath, 'utf-8'));
    } catch {
      throw new WatchDeliveryQueueError(
        'QUEUE_STATE_INVALID',
        'GitHub watch delivery queue state is not valid JSON.',
      );
    }
    validateQueueState(parsed);
    return parsed;
  }

  private loadLegacyTombstones(now: Date): LegacyTombstone[] {
    if (!existsSync(this.legacyPath)) return [];
    const tombstones: LegacyTombstone[] = [];
    const cutoff = now.getTime() - this.policy.completedRetentionMs;
    for (const line of readFileSync(this.legacyPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const deliveryId = typeof entry.deliveryId === 'string' ? entry.deliveryId : '';
        const stableKey =
          typeof entry.stableKey === 'string' ? currentStableKeyFromLegacy(entry.stableKey) : '';
        const recordedAt =
          typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp))
            ? entry.timestamp
            : '';
        if (!stableKey || !recordedAt || Date.parse(recordedAt) < cutoff) {
          continue;
        }
        tombstones.push({ deliveryId, stableKey, recordedAt });
      } catch {
        // Invalid legacy lines were never reliable delivery evidence and are not imported.
      }
    }
    return newestTombstones(tombstones, this.policy.maxRecords);
  }

  private persistState(state: WatchDeliveryQueueState): void {
    const body = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(body) > this.policy.maxStateBytes) {
      throw new WatchDeliveryQueueError(
        'QUEUE_STATE_TOO_LARGE',
        'GitHub watch delivery queue state exceeds the configured byte limit.',
      );
    }
    const temporaryPath = `${this.statePath}.${process.pid}.${this.nonce()}.tmp`;
    let fd: number | null = null;
    try {
      fd = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(fd, body, 'utf-8');
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      renameSync(temporaryPath, this.statePath);
      fsyncDirectoryBestEffort(dirname(this.statePath));
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // best effort
        }
      }
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  private loadV2MigrationMarker(): WatchDeliveryV2MigrationMarker | null {
    if (!existsSync(this.migrationMarkerPath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.migrationMarkerPath, 'utf8')) as unknown;
    } catch {
      throw new WatchDeliveryQueueError(
        'QUEUE_STATE_INVALID',
        'GitHub watch delivery v2 migration marker is not valid JSON.',
      );
    }
    validateV2MigrationMarker(parsed);
    return parsed;
  }

  private persistV2MigrationMarker(marker: WatchDeliveryV2MigrationMarker): void {
    validateV2MigrationMarker(marker);
    persistAtomicFile(
      this.migrationMarkerPath,
      Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, 'utf8'),
      this.nonce,
    );
  }

  private persistMigratedSentinel(backupPath: string, backupDigest: `sha256:${string}`): void {
    const body = migratedSentinelBytes(backupPath, backupDigest);
    persistAtomicFile(this.statePath, body, this.nonce);
  }

  private verifyFinalizedV2Migration(
    marker: WatchDeliveryV2MigrationMarker,
    v2StatePath: string,
    requireSentinel: boolean,
  ): void {
    if (
      marker.state !== 'finalized' ||
      marker.v2StatePath !== v2StatePath ||
      !marker.backupPath ||
      !marker.backupDigest
    ) {
      throw new WatchDeliveryQueueError(
        'QUEUE_STATE_INVALID',
        'GitHub watch delivery v2 finalization evidence is incomplete.',
      );
    }
    const expectedBackupPath = join(
      this.stateDir,
      `delivery-state.v1.${marker.backupDigest.slice('sha256:'.length)}.readonly.json`,
    );
    if (marker.backupPath !== expectedBackupPath || !existsSync(marker.backupPath)) {
      throw new WatchDeliveryQueueError(
        'QUEUE_STATE_INVALID',
        'GitHub watch delivery v1 migration backup path is invalid.',
      );
    }
    const backup = readFileSync(marker.backupPath);
    verifyMigrationBackup(marker.backupPath, backup);
    if (`sha256:${createHash('sha256').update(backup).digest('hex')}` !== marker.backupDigest) {
      throw new WatchDeliveryQueueError(
        'QUEUE_STATE_INVALID',
        'GitHub watch delivery v1 migration backup digest is invalid.',
      );
    }
    if (
      requireSentinel &&
      (!existsSync(this.statePath) ||
        !readFileSync(this.statePath).equals(
          migratedSentinelBytes(marker.backupPath, marker.backupDigest),
        ))
    ) {
      throw new WatchDeliveryQueueError(
        'QUEUE_STATE_INVALID',
        'GitHub watch delivery v1 migrated sentinel is missing or invalid.',
      );
    }
  }

  private withLock<T>(operation: () => T): T {
    try {
      return withNotificationStorageLock(
        this.stateDir,
        basename(`${this.statePath}.lock`),
        {
          lockTimeoutMs: this.policy.lockTimeoutMs,
          lockStaleMs: this.policy.lockStaleMs,
          nonce: this.nonce,
        },
        operation,
      );
    } catch (error) {
      if ((error as { code?: unknown }).code === 'STORAGE_LOCK_TIMEOUT') {
        throw new WatchDeliveryQueueError(
          'QUEUE_LOCK_TIMEOUT',
          'Timed out waiting for the GitHub watch delivery queue lock.',
        );
      }
      if ((error as { code?: unknown }).code === 'STORAGE_PATH_UNSAFE') {
        throw new WatchDeliveryQueueError(
          'QUEUE_STATE_INVALID',
          'GitHub watch delivery queue lock path is unsafe.',
        );
      }
      throw error;
    }
  }
}

function validatePolicy(policy: WatchDeliveryPolicy): void {
  const positiveIntegers: Array<[string, number]> = [
    ['leaseMs', policy.leaseMs],
    ['maxAttempts', policy.maxAttempts],
    ['baseBackoffMs', policy.baseBackoffMs],
    ['maxBackoffMs', policy.maxBackoffMs],
    ['completedRetentionMs', policy.completedRetentionMs],
    ['failedRetentionMs', policy.failedRetentionMs],
    ['maxRecords', policy.maxRecords],
    ['maxStateBytes', policy.maxStateBytes],
    ['lockTimeoutMs', policy.lockTimeoutMs],
    ['lockStaleMs', policy.lockStaleMs],
  ];
  for (const [name, value] of positiveIntegers) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`Invalid GitHub watch delivery policy: ${name}.`);
    }
  }
  if (policy.maxBackoffMs < policy.baseBackoffMs) {
    throw new TypeError('Invalid GitHub watch delivery policy: maxBackoffMs.');
  }
}

function canonicalizeRoutes(
  event: PersistableRepositoryEvent,
  routes: GitHubWatchRoute[],
): Array<{ routeKey: string; route: GitHubWatchRoute }> {
  const canonical = new Map<string, GitHubWatchRoute>();
  for (const input of routes) {
    const route: GitHubWatchRoute = {
      sink: input.sink,
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.name ? { name: input.name } : {}),
    };
    const routeKey = canonicalWatchRouteKey(event.repository, route);
    if (!routeKey) {
      throw new WatchDeliveryQueueError(
        'QUEUE_TRANSITION_INVALID',
        'A GitHub watch delivery route has no canonical identity.',
      );
    }
    if (canonical.has(routeKey)) {
      throw new WatchDeliveryQueueError(
        'QUEUE_TRANSITION_INVALID',
        'A GitHub watch delivery contains duplicate canonical routes.',
      );
    }
    canonical.set(routeKey, route);
  }
  return [...canonical.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([routeKey, route]) => ({ routeKey, route }));
}

function routeIdempotencyKey(stableKey: string, routeKey: string): string {
  const digest = createHash('sha256')
    .update('openslack.watch.route.v1\0')
    .update(stableKey)
    .update('\0')
    .update(routeKey)
    .digest('hex');
  const hex = digest.slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8).join(''),
    hex.slice(8, 12).join(''),
    hex.slice(12, 16).join(''),
    hex.slice(16, 20).join(''),
    hex.slice(20, 32).join(''),
  ].join('-');
}

function deliveryRecordId(stableKey: string): string {
  return createHash('sha256')
    .update('openslack.watch.delivery.v1\0')
    .update(stableKey)
    .digest('hex');
}

function findByDeliveryId(
  state: WatchDeliveryQueueState,
  deliveryId: string,
): { deliveryId: string; stableKey: string } | null {
  const delivery = state.deliveries.find((candidate) => candidate.deliveryIds.includes(deliveryId));
  if (delivery) return delivery;
  return state.legacyTombstones.find((candidate) => candidate.deliveryId === deliveryId) ?? null;
}

function compareAvailableDeliveries(left: WatchDeliveryRecord, right: WatchDeliveryRecord): number {
  return (
    left.availableAt.localeCompare(right.availableAt) ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function maxDeliveryClaims(
  delivery: Pick<WatchDeliveryRecord, 'routes'>,
  policy: WatchDeliveryPolicy,
): number {
  return policy.maxAttempts * (delivery.routes.length + 1);
}

function requireLease(
  state: WatchDeliveryQueueState,
  deliveryId: string,
  leaseToken: string,
): WatchDeliveryRecord {
  const delivery = state.deliveries.find((candidate) => candidate.id === deliveryId);
  if (
    !delivery ||
    delivery.state !== 'processing' ||
    !delivery.lease ||
    delivery.lease.token !== leaseToken
  ) {
    throw new WatchDeliveryQueueError(
      'QUEUE_TRANSITION_INVALID',
      'The GitHub watch delivery lease is missing or stale.',
    );
  }
  return delivery;
}

function requireProcessingRoute(
  delivery: WatchDeliveryRecord,
  routeKey: string,
): WatchRouteDelivery {
  const route = delivery.routes.find((candidate) => candidate.routeKey === routeKey);
  if (!route || route.state !== 'processing') {
    throw new WatchDeliveryQueueError(
      'QUEUE_TRANSITION_INVALID',
      'The GitHub watch delivery route is not processing.',
    );
  }
  return route;
}

function recoverExpired(
  state: WatchDeliveryQueueState,
  now: Date,
  policy: WatchDeliveryPolicy,
): number {
  const nowMs = now.getTime();
  const timestamp = now.toISOString();
  let recovered = 0;
  for (const delivery of state.deliveries) {
    if (
      delivery.state !== 'processing' ||
      !delivery.lease ||
      Date.parse(delivery.lease.expiresAt) > nowMs
    ) {
      continue;
    }
    recovered += 1;
    for (const route of delivery.routes) {
      if (route.state !== 'processing') continue;
      const exhausted = route.attempts >= policy.maxAttempts;
      route.state = exhausted ? 'failed' : 'retryable';
      route.availableAt = timestamp;
      route.updatedAt = timestamp;
      if (exhausted) route.terminalAt = timestamp;
    }
    const exhausted = delivery.attempts >= maxDeliveryClaims(delivery, policy);
    delivery.state = exhausted ? 'failed' : 'retryable';
    delivery.availableAt = timestamp;
    delivery.updatedAt = timestamp;
    if (exhausted) {
      delivery.terminalAt = timestamp;
      const diagnostic: WatchDeliveryDiagnostic = {
        code: 'DELIVERY_ATTEMPTS_EXHAUSTED',
        message: 'The delivery exhausted its processing attempts.',
        retryable: false,
        recordedAt: timestamp,
      };
      delivery.lastDiagnostic = diagnostic;
      failIncompleteRoutes(delivery, diagnostic, timestamp);
    }
    delete delivery.lease;
  }
  return recovered;
}

function compactState(
  state: WatchDeliveryQueueState,
  now: Date,
  policy: WatchDeliveryPolicy,
): number {
  const nowMs = now.getTime();
  const before = state.deliveries.length + state.legacyTombstones.length;
  state.deliveries = state.deliveries.filter((delivery) => {
    if (!delivery.terminalAt) return true;
    const retention =
      delivery.state === 'completed'
        ? policy.completedRetentionMs
        : delivery.state === 'failed'
          ? policy.failedRetentionMs
          : Number.POSITIVE_INFINITY;
    return nowMs - Date.parse(delivery.terminalAt) <= retention;
  });
  state.legacyTombstones = state.legacyTombstones.filter(
    (entry) => nowMs - Date.parse(entry.recordedAt) <= policy.completedRetentionMs,
  );
  return before - state.deliveries.length - state.legacyTombstones.length;
}

function failIncompleteRoutes(
  delivery: WatchDeliveryRecord,
  diagnostic: WatchDeliveryDiagnostic,
  timestamp: string,
): void {
  for (const route of delivery.routes) {
    if (route.state === 'completed' || route.state === 'failed') continue;
    route.state = 'failed';
    route.availableAt = timestamp;
    route.updatedAt = timestamp;
    route.terminalAt = timestamp;
    route.lastDiagnostic = diagnostic;
  }
}

function earliestAvailableAt(routes: WatchRouteDelivery[]): string {
  return routes
    .map((route) => route.availableAt)
    .sort((left, right) => left.localeCompare(right))[0]!;
}

function earliestOptional(values: string[]): string | undefined {
  return values.sort((left, right) => left.localeCompare(right))[0];
}

function latestOptional(values: string[]): string | undefined {
  return values.sort((left, right) => right.localeCompare(left))[0];
}

function sanitizeDiagnostic(
  diagnostic: Omit<WatchDeliveryDiagnostic, 'retryable' | 'recordedAt'>,
  retryable: boolean,
): Omit<WatchDeliveryDiagnostic, 'recordedAt'> {
  const code = /^[A-Z0-9_]{1,80}$/u.test(diagnostic.code) ? diagnostic.code : 'DELIVERY_FAILED';
  const message = diagnostic.message.replace(/[\r\n]+/gu, ' ').slice(0, 300);
  return {
    code,
    message: message || 'The delivery failed safely.',
    retryable,
  };
}

function validateQueueState(value: unknown): asserts value is WatchDeliveryQueueState {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['schema', 'updatedAt', 'deliveries', 'legacyTombstones']) ||
    value.schema !== 'openslack.watch_delivery_queue.v1'
  ) {
    throw new WatchDeliveryQueueError(
      'QUEUE_STATE_INVALID',
      'GitHub watch delivery queue schema is invalid.',
    );
  }
  if (
    !isTimestamp(value.updatedAt) ||
    !Array.isArray(value.deliveries) ||
    !Array.isArray(value.legacyTombstones)
  ) {
    throw new WatchDeliveryQueueError(
      'QUEUE_STATE_INVALID',
      'GitHub watch delivery queue structure is invalid.',
    );
  }

  const deliveryIds = new Set<string>();
  const stableKeys = new Set<string>();
  const recordIds = new Set<string>();
  for (const delivery of value.deliveries) {
    validateDelivery(delivery);
    if (recordIds.has(delivery.id) || stableKeys.has(delivery.stableKey)) {
      throw new WatchDeliveryQueueError(
        'QUEUE_STATE_INVALID',
        'GitHub watch delivery queue contains duplicate identities.',
      );
    }
    recordIds.add(delivery.id);
    stableKeys.add(delivery.stableKey);
    for (const deliveryId of delivery.deliveryIds) {
      if (deliveryIds.has(deliveryId)) {
        throw new WatchDeliveryQueueError(
          'QUEUE_STATE_INVALID',
          'GitHub watch delivery queue contains duplicate delivery ids.',
        );
      }
      deliveryIds.add(deliveryId);
    }
  }
  for (const entry of value.legacyTombstones) {
    if (
      !isRecord(entry) ||
      !hasOnlyKeys(entry, ['deliveryId', 'stableKey', 'recordedAt']) ||
      typeof entry.deliveryId !== 'string' ||
      typeof entry.stableKey !== 'string' ||
      entry.stableKey.length === 0 ||
      !isTimestamp(entry.recordedAt)
    ) {
      throw new WatchDeliveryQueueError(
        'QUEUE_STATE_INVALID',
        'GitHub watch delivery queue contains an invalid legacy tombstone.',
      );
    }
    if (
      stableKeys.has(entry.stableKey) ||
      (entry.deliveryId.length > 0 && deliveryIds.has(entry.deliveryId))
    ) {
      throw new WatchDeliveryQueueError(
        'QUEUE_STATE_INVALID',
        'GitHub watch delivery queue contains duplicate legacy identities.',
      );
    }
    stableKeys.add(entry.stableKey);
    if (entry.deliveryId.length > 0) deliveryIds.add(entry.deliveryId);
  }
}

function validateV2MigrationMarker(
  value: unknown,
): asserts value is WatchDeliveryV2MigrationMarker {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schema',
      'state',
      'startedAt',
      'updatedAt',
      'v2StatePath',
      'backupPath',
      'backupDigest',
    ]) ||
    value.schema !== 'openslack.watch_delivery_v2_migration.v1' ||
    (value.state !== 'draining' && value.state !== 'finalized') ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.updatedAt) ||
    typeof value.v2StatePath !== 'string' ||
    value.v2StatePath.length === 0 ||
    (value.backupPath !== undefined && typeof value.backupPath !== 'string') ||
    (value.backupDigest !== undefined &&
      (typeof value.backupDigest !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/u.test(value.backupDigest))) ||
    (value.state === 'finalized' &&
      (typeof value.backupPath !== 'string' || typeof value.backupDigest !== 'string'))
  ) {
    throw new WatchDeliveryQueueError(
      'QUEUE_STATE_INVALID',
      'GitHub watch delivery v2 migration marker is invalid.',
    );
  }
}

function validateDelivery(value: unknown): asserts value is WatchDeliveryRecord {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'id',
      'stableKey',
      'deliveryId',
      'deliveryIds',
      'event',
      'state',
      'attempts',
      'refreshAttempts',
      'createdAt',
      'updatedAt',
      'availableAt',
      'completedAt',
      'terminalAt',
      'lease',
      'routes',
      'lastDiagnostic',
    ]) ||
    typeof value.id !== 'string' ||
    typeof value.stableKey !== 'string' ||
    typeof value.deliveryId !== 'string' ||
    !Array.isArray(value.deliveryIds) ||
    !value.deliveryIds.every((deliveryId: unknown) => typeof deliveryId === 'string') ||
    value.deliveryIds.length > 64 ||
    (value.deliveryId.length > 0 && value.deliveryIds[0] !== value.deliveryId) ||
    !isDeliveryState(value.state) ||
    typeof value.attempts !== 'number' ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 0 ||
    typeof value.refreshAttempts !== 'number' ||
    !Number.isSafeInteger(value.refreshAttempts) ||
    value.refreshAttempts < 0 ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    !isTimestamp(value.availableAt) ||
    (value.completedAt !== undefined && !isTimestamp(value.completedAt)) ||
    (value.terminalAt !== undefined && !isTimestamp(value.terminalAt)) ||
    !Array.isArray(value.routes)
  ) {
    throw new WatchDeliveryQueueError(
      'QUEUE_STATE_INVALID',
      'GitHub watch delivery queue contains an invalid delivery record.',
    );
  }
  validatePersistableRepositoryEvent(value.event);
  if (value.event.stableKey !== value.stableKey) {
    throw new WatchDeliveryQueueError(
      'QUEUE_STATE_INVALID',
      'A GitHub watch delivery event does not match its stable identity.',
    );
  }
  if (value.id !== deliveryRecordId(value.stableKey)) {
    throw new WatchDeliveryQueueError(
      'QUEUE_STATE_INVALID',
      'A GitHub watch delivery record id does not match its stable identity.',
    );
  }
  if (value.state === 'processing') {
    if (
      !isRecord(value.lease) ||
      !hasOnlyKeys(value.lease, ['token', 'workerId', 'acquiredAt', 'expiresAt']) ||
      typeof value.lease.token !== 'string' ||
      typeof value.lease.workerId !== 'string' ||
      !isTimestamp(value.lease.acquiredAt) ||
      !isTimestamp(value.lease.expiresAt)
    ) {
      throw new WatchDeliveryQueueError(
        'QUEUE_STATE_INVALID',
        'A processing GitHub watch delivery has no valid lease.',
      );
    }
  } else if (value.lease !== undefined) {
    throw new WatchDeliveryQueueError(
      'QUEUE_STATE_INVALID',
      'A non-processing GitHub watch delivery retains a lease.',
    );
  }
  if (value.lastDiagnostic !== undefined) validateDiagnostic(value.lastDiagnostic);
  const routeKeys = new Set<string>();
  for (const route of value.routes) {
    validateRoute(route);
    const canonicalRouteKey = canonicalWatchRouteKey(value.event.repository, route.route);
    if (
      canonicalRouteKey !== route.routeKey ||
      route.idempotencyKey !== routeIdempotencyKey(value.stableKey, route.routeKey)
    ) {
      throw new WatchDeliveryQueueError(
        'QUEUE_STATE_INVALID',
        'A GitHub watch delivery route identity is inconsistent.',
      );
    }
    if (routeKeys.has(route.routeKey)) {
      throw new WatchDeliveryQueueError(
        'QUEUE_STATE_INVALID',
        'A GitHub watch delivery contains duplicate route identities.',
      );
    }
    routeKeys.add(route.routeKey);
  }
}

function validateRoute(value: unknown): asserts value is WatchRouteDelivery {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'routeKey',
      'idempotencyKey',
      'route',
      'state',
      'attempts',
      'availableAt',
      'updatedAt',
      'completedAt',
      'terminalAt',
      'lastDiagnostic',
    ]) ||
    typeof value.routeKey !== 'string' ||
    typeof value.idempotencyKey !== 'string' ||
    !isRecord(value.route) ||
    !hasOnlyKeys(value.route, ['sink', 'channel', 'name']) ||
    (value.route.channel !== undefined && typeof value.route.channel !== 'string') ||
    (value.route.name !== undefined && typeof value.route.name !== 'string') ||
    !isDeliveryState(value.state) ||
    typeof value.attempts !== 'number' ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 0 ||
    !isTimestamp(value.availableAt) ||
    !isTimestamp(value.updatedAt) ||
    (value.completedAt !== undefined && !isTimestamp(value.completedAt)) ||
    (value.terminalAt !== undefined && !isTimestamp(value.terminalAt))
  ) {
    throw new WatchDeliveryQueueError(
      'QUEUE_STATE_INVALID',
      'A GitHub watch delivery route is invalid.',
    );
  }
  if (!['console', 'slack', 'webhook'].includes(String(value.route.sink))) {
    throw new WatchDeliveryQueueError(
      'QUEUE_STATE_INVALID',
      'A GitHub watch delivery route sink is invalid.',
    );
  }
  if (value.lastDiagnostic !== undefined) validateDiagnostic(value.lastDiagnostic);
}

function validateDiagnostic(value: unknown): asserts value is WatchDeliveryDiagnostic {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['code', 'message', 'retryable', 'recordedAt']) ||
    typeof value.code !== 'string' ||
    !/^[A-Z0-9_]{1,80}$/u.test(value.code) ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    value.message.length > 300 ||
    typeof value.retryable !== 'boolean' ||
    !isTimestamp(value.recordedAt)
  ) {
    throw new WatchDeliveryQueueError(
      'QUEUE_STATE_INVALID',
      'A GitHub watch delivery diagnostic is invalid.',
    );
  }
}

export function validatePersistableRepositoryEvent(
  value: unknown,
): asserts value is PersistableRepositoryEvent {
  if (
    !isRecord(value) ||
    value.schema !== 'openslack.repository_event.v1' ||
    typeof value.kind !== 'string' ||
    typeof value.eventKey !== 'string' ||
    typeof value.action !== 'string' ||
    !isRecord(value.repository) ||
    !isRecord(value.object) ||
    (value.source !== 'webhook' && value.source !== 'poll') ||
    typeof value.deliveryId !== 'string' ||
    typeof value.stableKey !== 'string' ||
    !isTimestamp(value.observedAt) ||
    !isRecord(value.metadata) ||
    !hasOnlyKeys(value.metadata, ['informational']) ||
    typeof value.metadata.informational !== 'boolean'
  ) {
    invalidPersistableEvent();
  }

  const repository = canonicalizeRepositoryName(
    stringField(value.repository, 'owner'),
    stringField(value.repository, 'repo'),
  );
  if (
    !repository ||
    !hasOnlyKeys(value.repository, ['owner', 'repo', 'fullName', 'canonicalFullName']) ||
    value.repository.fullName !== repository.fullName ||
    value.repository.canonicalFullName !== repository.canonicalFullName
  ) {
    invalidPersistableEvent();
  }
  if (
    !hasOnlyKeys(value.object, ['kind', 'id', 'number']) ||
    value.object.kind !== value.kind ||
    typeof value.object.id !== 'string' ||
    value.object.id.length === 0 ||
    (value.object.number !== undefined && !isPositiveInteger(value.object.number))
  ) {
    invalidPersistableEvent();
  }

  const commonKeys = [
    'schema',
    'kind',
    'eventKey',
    'action',
    'repository',
    'object',
    'source',
    'deliveryId',
    'stableKey',
    'observedAt',
    'metadata',
  ];
  let expectedStableKey: string;
  let expectedObjectId: string;
  let expectedObjectNumber: number | undefined;
  switch (value.kind) {
    case 'issue': {
      const issueNumber = positiveIntegerField(value, 'issueNumber');
      const updatedAt = timestampField(value, 'updatedAt');
      if (
        !['opened', 'reopened', 'labeled'].includes(value.action) ||
        value.eventKey !== `issues.${value.action}` ||
        (value.source !== 'webhook' && value.source !== 'poll') ||
        value.metadata.informational !== false ||
        !hasOnlyKeys(value, [...commonKeys, 'issueNumber', 'updatedAt'])
      ) {
        invalidPersistableEvent();
      }
      expectedStableKey = `github:${value.eventKey}:${repository.canonicalFullName}:issue:${issueNumber}:${updatedAt}`;
      expectedObjectId = `${repository.canonicalFullName}#${issueNumber}`;
      expectedObjectNumber = issueNumber;
      break;
    }
    case 'push': {
      const ref = nonEmptyStringField(value, 'ref');
      const before = nonEmptyStringField(value, 'before');
      const after = nonEmptyStringField(value, 'after');
      if (
        value.eventKey !== 'push' ||
        value.action !== 'push' ||
        value.source !== 'webhook' ||
        value.metadata.informational !== false ||
        !hasOnlyKeys(value, [...commonKeys, 'ref', 'before', 'after'])
      ) {
        invalidPersistableEvent();
      }
      expectedStableKey = `github:push:${repository.canonicalFullName}:${ref}:${after}`;
      expectedObjectId = `${repository.canonicalFullName}@${after}`;
      expectedObjectNumber = undefined;
      void before;
      break;
    }
    case 'pull_request': {
      const pullRequestNumber = positiveIntegerField(value, 'pullRequestNumber');
      const headSha = nonEmptyStringField(value, 'headSha');
      nonEmptyStringField(value, 'baseSha');
      const updatedAt = timestampField(value, 'updatedAt');
      if (
        !['opened', 'synchronize', 'reopened', 'closed', 'ready_for_review'].includes(
          value.action,
        ) ||
        value.eventKey !== `pull_request.${value.action}` ||
        value.source !== 'webhook' ||
        value.metadata.informational !== true ||
        !hasOnlyKeys(value, [...commonKeys, 'pullRequestNumber', 'headSha', 'baseSha', 'updatedAt'])
      ) {
        invalidPersistableEvent();
      }
      expectedStableKey = `github:${value.eventKey}:${repository.canonicalFullName}:pr:${pullRequestNumber}:${headSha}:${updatedAt}`;
      expectedObjectId = `${repository.canonicalFullName}#${pullRequestNumber}`;
      expectedObjectNumber = pullRequestNumber;
      break;
    }
    case 'pull_request_review': {
      const pullRequestNumber = positiveIntegerField(value, 'pullRequestNumber');
      const reviewId = positiveIntegerField(value, 'reviewId');
      nonEmptyStringField(value, 'headSha');
      const commitId = nonEmptyStringField(value, 'commitId');
      timestampField(value, 'submittedAt');
      if (
        !['submitted', 'dismissed'].includes(value.action) ||
        value.eventKey !== `pull_request_review.${value.action}` ||
        value.source !== 'webhook' ||
        value.metadata.informational !== true ||
        !hasOnlyKeys(value, [
          ...commonKeys,
          'pullRequestNumber',
          'reviewId',
          'headSha',
          'commitId',
          'submittedAt',
        ])
      ) {
        invalidPersistableEvent();
      }
      expectedStableKey = `github:${value.eventKey}:${repository.canonicalFullName}:pr:${pullRequestNumber}:review:${reviewId}:${commitId}`;
      expectedObjectId = `${repository.canonicalFullName}#${pullRequestNumber}:review:${reviewId}`;
      expectedObjectNumber = pullRequestNumber;
      break;
    }
    case 'check_run': {
      const checkRunId = positiveIntegerField(value, 'checkRunId');
      const headSha = nonEmptyStringField(value, 'headSha');
      const completedAt = timestampField(value, 'completedAt');
      positiveIntegerArrayField(value, 'pullRequestNumbers');
      if (
        value.eventKey !== 'check_run.completed' ||
        value.action !== 'completed' ||
        value.source !== 'webhook' ||
        value.metadata.informational !== true ||
        !hasOnlyKeys(value, [
          ...commonKeys,
          'checkRunId',
          'headSha',
          'completedAt',
          'pullRequestNumbers',
        ])
      ) {
        invalidPersistableEvent();
      }
      expectedStableKey = `github:check_run.completed:${repository.canonicalFullName}:check-run:${checkRunId}:${headSha}:${completedAt}`;
      expectedObjectId = `${repository.canonicalFullName}:check-run:${checkRunId}`;
      expectedObjectNumber = undefined;
      break;
    }
    case 'check_suite': {
      const checkSuiteId = positiveIntegerField(value, 'checkSuiteId');
      const headSha = nonEmptyStringField(value, 'headSha');
      const updatedAt = timestampField(value, 'updatedAt');
      positiveIntegerArrayField(value, 'pullRequestNumbers');
      if (
        value.eventKey !== 'check_suite.completed' ||
        value.action !== 'completed' ||
        value.source !== 'webhook' ||
        value.metadata.informational !== true ||
        !hasOnlyKeys(value, [
          ...commonKeys,
          'checkSuiteId',
          'headSha',
          'updatedAt',
          'pullRequestNumbers',
        ])
      ) {
        invalidPersistableEvent();
      }
      expectedStableKey = `github:check_suite.completed:${repository.canonicalFullName}:check-suite:${checkSuiteId}:${headSha}:${updatedAt}`;
      expectedObjectId = `${repository.canonicalFullName}:check-suite:${checkSuiteId}`;
      expectedObjectNumber = undefined;
      break;
    }
    default:
      invalidPersistableEvent();
  }

  if (
    value.stableKey !== expectedStableKey ||
    value.object.id !== expectedObjectId ||
    value.object.number !== expectedObjectNumber
  ) {
    invalidPersistableEvent();
  }
}

function isDeliveryState(value: unknown): value is WatchDeliveryState {
  return (
    value === 'pending' ||
    value === 'processing' ||
    value === 'retryable' ||
    value === 'completed' ||
    value === 'failed'
  );
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowlist = new Set(allowed);
  return Object.keys(value).every((key) => allowlist.has(key));
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') invalidPersistableEvent();
  return field;
}

function nonEmptyStringField(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key);
  if (field.length === 0) invalidPersistableEvent();
  return field;
}

function timestampField(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key);
  if (!isTimestamp(field)) invalidPersistableEvent();
  return field;
}

function positiveIntegerField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (!isPositiveInteger(field)) invalidPersistableEvent();
  return field;
}

function positiveIntegerArrayField(value: Record<string, unknown>, key: string): number[] {
  const field = value[key];
  if (!Array.isArray(field) || !field.every(isPositiveInteger)) invalidPersistableEvent();
  return field;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function invalidPersistableEvent(): never {
  throw new WatchDeliveryQueueError(
    'QUEUE_STATE_INVALID',
    'GitHub watch delivery queue contains an invalid persisted repository event.',
  );
}

function cloneDelivery(delivery: WatchDeliveryRecord): WatchDeliveryRecord {
  return structuredClone(delivery);
}

function cloneQueueState(state: WatchDeliveryQueueState): WatchDeliveryQueueSnapshotV1 {
  return structuredClone(state);
}

function publishCreateOnlyFile(path: string, bytes: Buffer, nonce: () => string): void {
  if (existsSync(path)) {
    verifyMigrationBackup(path, bytes);
    return;
  }
  const temporaryPath = `${path}.${process.pid}.${nonce()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      linkSync(temporaryPath, path);
    } catch (error) {
      if (!existsSync(path)) throw error;
    }
    verifyMigrationBackup(path, bytes);
    fsyncDirectoryBestEffort(dirname(path));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function verifyMigrationBackup(path: string, expected: Buffer): void {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || !readFileSync(path).equals(expected)) {
    throw new WatchDeliveryQueueError(
      'QUEUE_STATE_INVALID',
      'The v1 migration backup conflicts with existing bytes.',
    );
  }
}

function migratedSentinelBytes(backupPath: string, backupDigest: `sha256:${string}`): Buffer {
  return Buffer.from(
    [
      'OPENSLACK_DELIVERY_QUEUE_V1_MIGRATED',
      `backup=${backupPath}`,
      `digest=${backupDigest}`,
      'This sentinel is intentionally not JSON so older binaries fail closed.',
      '',
    ].join('\n'),
    'utf8',
  );
}

function persistAtomicFile(path: string, bytes: Buffer, nonce: () => string): void {
  const temporaryPath = `${path}.${process.pid}.${nonce()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, path);
    fsyncDirectoryBestEffort(dirname(path));
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function cloneRoute(route: WatchRouteDelivery): WatchRouteDelivery {
  return structuredClone(route);
}

function newestTombstones(tombstones: LegacyTombstone[], maxRecords: number): LegacyTombstone[] {
  const sorted = [...tombstones].sort(
    (left, right) =>
      right.recordedAt.localeCompare(left.recordedAt) ||
      right.stableKey.localeCompare(left.stableKey),
  );
  const bounded: LegacyTombstone[] = [];
  const stableKeys = new Set<string>();
  const deliveryIds = new Set<string>();
  for (const tombstone of sorted) {
    if (
      stableKeys.has(tombstone.stableKey) ||
      (tombstone.deliveryId.length > 0 && deliveryIds.has(tombstone.deliveryId))
    ) {
      continue;
    }
    bounded.push(tombstone);
    stableKeys.add(tombstone.stableKey);
    if (tombstone.deliveryId.length > 0) deliveryIds.add(tombstone.deliveryId);
    if (bounded.length >= maxRecords) break;
  }
  return bounded;
}

function currentStableKeyFromLegacy(stableKey: string): string {
  const issue = /^github:issue:([^/]+)\/([^#]+)#([1-9]\d*):(opened|reopened|labeled):(.+)$/u.exec(
    stableKey,
  );
  if (issue) {
    const repository = canonicalizeRepositoryName(issue[1]!, issue[2]!);
    if (repository) {
      return `github:issues.${issue[4]}:${repository.canonicalFullName}:issue:${issue[3]}:${issue[5]}`;
    }
  }

  if (stableKey.startsWith('github:push:')) {
    const identityAndPush = stableKey.slice('github:push:'.length);
    const slash = identityAndPush.indexOf('/');
    const refStart = identityAndPush.indexOf(':', slash + 1);
    const afterStart = identityAndPush.lastIndexOf(':');
    if (slash > 0 && refStart > slash && afterStart > refStart) {
      const repository = canonicalizeRepositoryName(
        identityAndPush.slice(0, slash),
        identityAndPush.slice(slash + 1, refStart),
      );
      const ref = identityAndPush.slice(refStart + 1, afterStart);
      const after = identityAndPush.slice(afterStart + 1);
      if (repository && ref.length > 0 && after.length > 0) {
        return `github:push:${repository.canonicalFullName}:${ref}:${after}`;
      }
    }
  }

  return stableKey;
}

function fsyncDirectoryBestEffort(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    fsyncSync(fd);
  } catch {
    // Windows and some filesystems do not support fsync on directories.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}
