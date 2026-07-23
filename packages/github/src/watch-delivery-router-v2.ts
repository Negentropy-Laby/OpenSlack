import type { NotificationPayload } from './notification-payload.js';
import {
  attachRepositoryLiveState,
  createNotificationPayload,
  createPersistedNotificationPayload,
} from './notification-payload.js';
import {
  materializeSlackNotificationBody,
  materializeWebhookNotificationBody,
  validateNotificationBodyForHandoff,
} from './notification-body.js';
import { NotificationBlobStore, NotificationBlobStoreError } from './notification-blob-store.js';
import type { NotificationAcceptanceReceiptV1 } from './notification-receipt-store.js';
import type { NotificationReceiptStore } from './notification-receipt-store.js';
import type { NotificationServiceClient } from './notification-service-client.js';
import type { NotificationSink, SinkResult } from './notification-sinks.js';
import {
  createNotificationHandoffKeyV2,
  createNotificationRouteRecordIdV2,
  type HandoffResult,
} from './notification-handoff-contracts.js';
import {
  RepositoryAuthorityResolver,
  type RepositoryAuthorityDiagnostic,
} from './repository-authority.js';
import {
  fetchRepositoryEventLiveState,
  RepositoryLiveStateError,
  type RepositoryLiveStateProjection,
} from './repository-live-state.js';
import {
  repositoryEventStableKey,
  toPersistableRepositoryEvent,
  type RepositoryEvent,
} from './repository-event.js';
import type { GitHubWatchRouteV2 } from './watch-config-v2.js';
import {
  WatchDeliveryQueueV2,
  WatchDeliveryQueueV2Error,
  type ClaimedWatchRouteV2,
  type WatchRouteEnqueueInputV2,
  type WatchRouteEnqueueResultV2,
  type WatchRouteRecordV2,
} from './watch-delivery-queue-v2.js';

export type WatchDeliveryV2RecordEventFn = (event: unknown) => unknown;

export interface WatchDeliveryRouterV2Options {
  queue: WatchDeliveryQueueV2;
  blobStore: NotificationBlobStore;
  receiptStore: NotificationReceiptStore;
  notificationClient?: NotificationServiceClient;
  sinks: Map<string, NotificationSink>;
  watchConfigDigest: `sha256:${string}`;
  allowNewServiceRecords: boolean;
  recordEvent?: WatchDeliveryV2RecordEventFn;
  authorityResolver?: RepositoryAuthorityResolver;
  refreshLiveState?: (event: WatchRouteRecordV2['event']) => Promise<RepositoryLiveStateProjection>;
  workerId?: string;
  intervalMs?: number;
  sinkTimeoutMs?: number;
  maxRoutesPerDrain?: number;
  now?: () => Date;
}

export interface WatchDeliveryV2AdmissionResult {
  outcome: WatchRouteEnqueueResultV2['outcome'];
  routeRecordIds: string[];
}

export interface WatchDeliveryV2DrainResult {
  claimed: number;
  accepted: number;
  completed: number;
  retryable: number;
  rejected: number;
  quarantined: number;
  dead: number;
  failed: number;
}

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_SINK_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ROUTES_PER_DRAIN = 100;

/**
 * Route-centric delivery worker. A service acceptance is deliberately distinct from a direct
 * vendor success: only a valid, durably committed 202 receipt transfers authority.
 */
export class WatchDeliveryRouterV2 {
  private readonly queue: WatchDeliveryQueueV2;
  private readonly blobStore: NotificationBlobStore;
  private readonly receiptStore: NotificationReceiptStore;
  private readonly notificationClient?: NotificationServiceClient;
  private readonly sinks: Map<string, NotificationSink>;
  private readonly watchConfigDigest: `sha256:${string}`;
  private readonly allowNewServiceRecords: boolean;
  private readonly recordEvent?: WatchDeliveryV2RecordEventFn;
  private readonly authorityResolver: RepositoryAuthorityResolver;
  private readonly refreshLiveStateFn?: WatchDeliveryRouterV2Options['refreshLiveState'];
  private readonly workerId: string;
  private readonly intervalMs: number;
  private readonly sinkTimeoutMs: number;
  private readonly maxRoutesPerDrain: number;
  private readonly now: () => Date;
  private readonly transientEvents = new Map<string, RepositoryEvent>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeDrain: Promise<WatchDeliveryV2DrainResult> | null = null;

  constructor(options: WatchDeliveryRouterV2Options) {
    this.queue = options.queue;
    this.blobStore = options.blobStore;
    this.receiptStore = options.receiptStore;
    this.notificationClient = options.notificationClient;
    this.sinks = options.sinks;
    this.watchConfigDigest = options.watchConfigDigest;
    this.allowNewServiceRecords = options.allowNewServiceRecords;
    this.recordEvent = options.recordEvent;
    this.authorityResolver = options.authorityResolver ?? new RepositoryAuthorityResolver();
    this.refreshLiveStateFn = options.refreshLiveState;
    this.workerId = options.workerId ?? `github-watch-v2-${process.pid}`;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.sinkTimeoutMs = options.sinkTimeoutMs ?? DEFAULT_SINK_TIMEOUT_MS;
    this.maxRoutesPerDrain = options.maxRoutesPerDrain ?? DEFAULT_MAX_ROUTES_PER_DRAIN;
    this.now = options.now ?? (() => new Date());
    for (const [name, value] of [
      ['intervalMs', this.intervalMs],
      ['sinkTimeoutMs', this.sinkTimeoutMs],
      ['maxRoutesPerDrain', this.maxRoutesPerDrain],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`Invalid watch delivery v2 router option: ${name}.`);
      }
    }
  }

  async admit(
    event: RepositoryEvent,
    routes: GitHubWatchRouteV2[],
  ): Promise<WatchDeliveryV2AdmissionResult> {
    const externalRoutes = routes.filter((route) => route.delivery.backend !== 'local');
    const serviceRoutes = externalRoutes.filter(
      (route) => route.delivery.backend === 'notification_service',
    );
    const persisted = toPersistableRepositoryEvent(event);

    if (!this.allowNewServiceRecords && serviceRoutes.length > 0) {
      const allExisting = serviceRoutes.every((route) => {
        const key = createNotificationHandoffKeyV2(
          persisted.stableKey,
          route.id,
          route.delivery.routing_epoch,
        );
        const id = createNotificationRouteRecordIdV2(persisted.repository.canonicalFullName, key);
        return this.queue.getRoute(id) !== null;
      });
      if (!allExisting) {
        throw new WatchDeliveryQueueV2Error(
          'QUEUE_TRANSITION_INVALID',
          'Notification-service admission is disabled for new route records.',
        );
      }
    }

    const payload = routes.length > 0 ? await this.materializePayload(event, persisted) : undefined;
    const inputs: WatchRouteEnqueueInputV2[] = [];
    for (const route of externalRoutes) {
      if (route.delivery.backend === 'direct') {
        inputs.push({ route });
        continue;
      }
      const existing = this.existingServiceRecord(persisted, route);
      if (!this.allowNewServiceRecords && existing) {
        inputs.push({
          route,
          blob: structuredClone(existing.blob!),
          watchConfigDigest: existing.watchConfigDigest!,
        });
        continue;
      }
      if (!payload) {
        throw new WatchDeliveryQueueV2Error(
          'QUEUE_TRANSITION_INVALID',
          'Notification-service materialization requires a notification payload.',
        );
      }
      const body =
        route.sink === 'slack'
          ? materializeSlackNotificationBody(
              payload,
              route.channel!,
              createNotificationHandoffKeyV2(
                persisted.stableKey,
                route.id,
                route.delivery.routing_epoch,
              ),
            )
          : materializeWebhookNotificationBody(payload);
      const validation = validateNotificationBodyForHandoff(body);
      if (!validation.valid) {
        throw new WatchDeliveryQueueV2Error(
          'QUEUE_TRANSITION_INVALID',
          `Notification body failed handoff validation: ${validation.code}.`,
        );
      }
      this.blobStore.put({ bytes: body.bytes, digest: body.digest, size: body.size });
      inputs.push({
        route,
        blob: {
          digest: body.digest,
          size: body.size,
          mediaType: body.mediaType,
          encoderVersion: body.encoderVersion,
        },
        watchConfigDigest: this.watchConfigDigest,
      });
    }

    const enqueue = this.queue.enqueueRoutes(persisted, inputs);
    if (enqueue.outcome === 'conflict') {
      throw new WatchDeliveryQueueV2Error(
        'QUEUE_TRANSITION_INVALID',
        'A GitHub delivery identity was reused for a different event.',
      );
    }
    if (enqueue.outcome === 'duplicate') {
      return { outcome: 'duplicate', routeRecordIds: enqueue.routes.map((route) => route.id) };
    }

    this.transientEvents.set(repositoryEventStableKey(event), event);
    if (payload) {
      for (const route of routes.filter((candidate) => candidate.delivery.backend === 'local')) {
        await this.sendLocal(route, payload, persisted.stableKey);
      }
    }
    return { outcome: 'enqueued', routeRecordIds: enqueue.routes.map((route) => route.id) };
  }

  start(): void {
    if (this.timer) return;
    this.scheduleDrain();
    this.timer = setInterval(() => this.scheduleDrain(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.activeDrain) await this.activeDrain;
  }

  scheduleDrain(): void {
    queueMicrotask(() => {
      void this.drainOnce().catch((error) => {
        console.error(`[GitHub Watch] V2 delivery drain failed safely: ${safeCode(error)}`);
      });
    });
  }

  async drainOnce(): Promise<WatchDeliveryV2DrainResult> {
    if (this.activeDrain) return this.activeDrain;
    const drain = this.runDrain();
    this.activeDrain = drain;
    try {
      return await drain;
    } finally {
      if (this.activeDrain === drain) this.activeDrain = null;
    }
  }

  private async runDrain(): Promise<WatchDeliveryV2DrainResult> {
    this.queue.recoverAcceptedReceipts(this.receiptStore);
    const result: WatchDeliveryV2DrainResult = {
      claimed: 0,
      accepted: 0,
      completed: 0,
      retryable: 0,
      rejected: 0,
      quarantined: 0,
      dead: 0,
      failed: 0,
    };
    for (let index = 0; index < this.maxRoutesPerDrain; index += 1) {
      const backend = index % 2 === 0 ? 'notification_service' : 'direct';
      const claim =
        this.queue.claimNext(this.workerId, backend) ??
        this.queue.claimNext(
          this.workerId,
          backend === 'direct' ? 'notification_service' : 'direct',
        );
      if (!claim) break;
      result.claimed += 1;
      const outcome =
        claim.route.backend === 'notification_service'
          ? await this.processServiceClaim(claim)
          : await this.processDirectClaim(claim);
      result[outcome] += 1;
      this.forgetIfSettled(claim.route.stableKey);
    }
    return result;
  }

  private async processServiceClaim(
    claim: ClaimedWatchRouteV2,
  ): Promise<'accepted' | 'retryable' | 'rejected' | 'quarantined' | 'dead'> {
    const confirmed = this.queue.confirmAttemptMaySend(claim.route.id, claim.lease.token);
    if (!confirmed) {
      this.recordRouteEvent('notification.handoff_dead', claim.route, 'DEADLINE_EXHAUSTED');
      return 'dead';
    }
    const blob = confirmed.blob!;
    let bytes: Uint8Array;
    try {
      const read = this.blobStore.read(blob.digest);
      if (read.size !== blob.size) {
        return this.quarantineBlob(claim, 'blob_size_mismatch', 'BLOB_SIZE_MISMATCH');
      }
      bytes = read.bytes;
    } catch (error) {
      if (error instanceof NotificationBlobStoreError) {
        const reason =
          error.code === 'BLOB_SIZE_MISMATCH'
            ? 'blob_size_mismatch'
            : error.code === 'BLOB_DIGEST_MISMATCH'
              ? 'blob_digest_mismatch'
              : 'blob_not_available';
        return this.quarantineBlob(claim, reason, error.code);
      }
      return this.quarantineBlob(claim, 'blob_not_available', 'BLOB_NOT_AVAILABLE');
    }

    if (!this.notificationClient) {
      return this.retry(claim, 'SERVICE_CLIENT_UNAVAILABLE');
    }
    let result: HandoffResult;
    try {
      result = await this.notificationClient.handoff({
        vendorId: confirmed.vendorId!,
        idempotencyKey: confirmed.idempotencyKey,
        payloadBytes: bytes,
        signal: AbortSignal.timeout(this.sinkTimeoutMs),
      });
    } catch {
      return this.retry(claim, 'SERVICE_CLIENT_UNHANDLED_ERROR');
    }
    return this.applyHandoffResult(claim, confirmed, result);
  }

  private async applyHandoffResult(
    claim: ClaimedWatchRouteV2,
    route: WatchRouteRecordV2,
    result: HandoffResult,
  ): Promise<'accepted' | 'retryable' | 'rejected' | 'quarantined' | 'dead'> {
    if (result.kind === 'accepted') {
      const receipt: NotificationAcceptanceReceiptV1 = {
        schema: 'openslack.notification_acceptance.v1',
        route_record_id: route.id,
        canonical_repository: route.canonicalRepository,
        route_id: route.routeId,
        routing_epoch: route.routingEpoch,
        vendor_id: route.vendorId!,
        idempotency_key: route.idempotencyKey,
        notification_id: result.receipt.notificationId,
        remote_request_id: result.receipt.requestId,
        accepted_at: result.receipt.acceptedAt,
        idempotent_replay: result.receipt.idempotentReplay,
        deployment_digest: result.receipt.deploymentDigest,
        watch_config_digest: route.watchConfigDigest!,
        recorded_at: this.now().toISOString(),
      };
      try {
        this.queue.acceptServiceRoute(route.id, claim.lease.token, receipt, this.receiptStore);
      } catch (error) {
        if (error instanceof WatchDeliveryQueueV2Error && error.code === 'QUEUE_RECEIPT_CONFLICT') {
          this.queue.markQuarantined(
            route.id,
            claim.lease.token,
            'receipt_conflict',
            diagnostic('RECEIPT_CONFLICT', error.code),
          );
          this.recordRouteEvent('notification.quarantined', route, 'RECEIPT_CONFLICT');
          return 'quarantined';
        }
        throw error;
      }
      this.recordRouteEvent('notification.accepted', route);
      return 'accepted';
    }
    if (result.kind === 'retryable' || (result.kind === 'protocol_error' && result.retryable)) {
      return this.retry(
        claim,
        result.code,
        result.status,
        result.kind === 'retryable' ? result.retryAfterMs : undefined,
      );
    }
    if (result.kind === 'conflict') {
      this.queue.markQuarantined(
        route.id,
        claim.lease.token,
        'idempotency_conflict',
        diagnostic(result.code, 'Notification service rejected the immutable identity.', 409),
      );
      this.recordRouteEvent('notification.quarantined', route, result.code);
      return 'quarantined';
    }
    if (result.kind === 'rejected') {
      const reason =
        result.code === 'PROTOCOL_REDIRECT'
          ? 'protocol_redirect'
          : result.code === 'UNEXPECTED_CLIENT_ERROR'
            ? 'unexpected_client_error'
            : 'deterministic_rejection';
      this.queue.markRejected(
        route.id,
        claim.lease.token,
        reason,
        diagnostic(result.code, 'Notification service rejected the handoff.', result.status),
      );
      this.recordRouteEvent('notification.rejected', route, result.code);
      return 'rejected';
    }

    const reason =
      result.code === 'DEPLOYMENT_DIGEST_MISMATCH'
        ? 'deployment_digest_mismatch'
        : result.code === 'UNEXPECTED_SUCCESS_STATUS'
          ? 'unexpected_success_status'
          : 'receipt_conflict';
    this.queue.markQuarantined(
      route.id,
      claim.lease.token,
      reason,
      diagnostic(result.code, 'Notification handoff protocol validation failed.', result.status),
    );
    this.recordRouteEvent('notification.quarantined', route, result.code);
    return 'quarantined';
  }

  private retry(
    claim: ClaimedWatchRouteV2,
    code: string,
    status?: number,
    retryAfterMs?: number,
  ): 'retryable' | 'dead' {
    const settled = this.queue.markRetryable(
      claim.route.id,
      claim.lease.token,
      diagnostic(code, 'Notification handoff will be retried.', status),
      retryAfterMs,
    );
    if (settled.state === 'handoff_dead') {
      this.recordRouteEvent('notification.handoff_dead', settled, code);
      return 'dead';
    }
    this.recordRouteEvent('notification.handoff_retry', settled, code);
    return 'retryable';
  }

  private quarantineBlob(
    claim: ClaimedWatchRouteV2,
    reason: 'blob_digest_mismatch' | 'blob_size_mismatch' | 'blob_not_available',
    code: string,
  ): 'quarantined' {
    this.queue.markQuarantined(
      claim.route.id,
      claim.lease.token,
      reason,
      diagnostic(code, 'Notification Blob verification failed.'),
    );
    this.recordRouteEvent('notification.quarantined', claim.route, code);
    return 'quarantined';
  }

  private async processDirectClaim(
    claim: ClaimedWatchRouteV2,
  ): Promise<'completed' | 'retryable' | 'failed'> {
    const confirmed = this.queue.confirmAttemptMaySend(claim.route.id, claim.lease.token);
    if (!confirmed) return 'failed';
    const sink = this.sinks.get(confirmed.route.sink);
    if (!sink) {
      this.queue.markDirectFailed(
        confirmed.id,
        claim.lease.token,
        diagnostic('SINK_NOT_CONFIGURED', 'The direct notification sink is not configured.'),
      );
      this.recordRouteEvent('notification.failed', confirmed, 'SINK_NOT_CONFIGURED');
      return 'failed';
    }

    let payload: NotificationPayload;
    try {
      payload = await this.materializePayloadFromRecord(confirmed);
    } catch (error) {
      const refresh = watchDeliveryV2LiveStateDiagnostic(error);
      if (refresh.retryable) {
        const settled = this.queue.markRetryable(
          confirmed.id,
          claim.lease.token,
          diagnostic(refresh.code, 'Repository live state refresh will be retried.'),
        );
        this.recordRouteEvent('notification.failed', settled, refresh.code);
        return settled.state === 'failed' ? 'failed' : 'retryable';
      }
      this.queue.markDirectFailed(
        confirmed.id,
        claim.lease.token,
        diagnostic(refresh.code, 'Repository live state refresh failed.'),
      );
      this.recordRouteEvent('notification.failed', confirmed, refresh.code);
      return 'failed';
    }
    let result: SinkResult;
    try {
      result = await sink.send(payload, directRoute(confirmed.route), {
        idempotencyKey: confirmed.idempotencyKey,
        attempt: confirmed.attemptCount,
        signal: AbortSignal.timeout(this.sinkTimeoutMs),
      });
    } catch {
      result = {
        ok: false,
        outcome: 'retryable',
        code: 'SINK_UNHANDLED_ERROR',
        error: 'Notification delivery failed safely.',
      };
    }
    if (result.ok) {
      this.queue.markDirectCompleted(confirmed.id, claim.lease.token);
      this.recordRouteEvent('notification.sent', confirmed);
      return 'completed';
    }
    if (result.outcome === 'retryable') {
      const settled = this.queue.markRetryable(
        confirmed.id,
        claim.lease.token,
        diagnostic(result.code, result.error),
        result.retryAfterMs,
      );
      this.recordRouteEvent('notification.failed', settled, result.code);
      return settled.state === 'failed' ? 'failed' : 'retryable';
    }
    this.queue.markDirectFailed(
      confirmed.id,
      claim.lease.token,
      diagnostic(result.code, result.error),
    );
    this.recordRouteEvent('notification.failed', confirmed, result.code);
    return 'failed';
  }

  private async sendLocal(
    route: GitHubWatchRouteV2,
    payload: NotificationPayload,
    stableKey: string,
  ): Promise<void> {
    const sink = this.sinks.get(route.sink);
    if (!sink) return;
    const result = await sink.send(payload, directRoute(route), {
      idempotencyKey: createNotificationHandoffKeyV2(
        stableKey,
        route.id,
        route.delivery.routing_epoch,
      ),
      attempt: 1,
    });
    if (result.ok) {
      const idempotencyKey = createNotificationHandoffKeyV2(
        stableKey,
        route.id,
        route.delivery.routing_epoch,
      );
      this.recordRouteEvent('notification.sent', {
        id: createNotificationRouteRecordIdV2(
          payload.repo.toLocaleLowerCase('en-US'),
          idempotencyKey,
        ),
        routeId: route.id,
        canonicalRepository: payload.repo.toLocaleLowerCase('en-US'),
        stableKey,
        backend: 'direct',
      });
    }
  }

  private existingServiceRecord(
    event: WatchRouteRecordV2['event'],
    route: GitHubWatchRouteV2,
  ): WatchRouteRecordV2 | null {
    const key = createNotificationHandoffKeyV2(
      event.stableKey,
      route.id,
      route.delivery.routing_epoch,
    );
    return this.queue.getRoute(
      createNotificationRouteRecordIdV2(event.repository.canonicalFullName, key),
    );
  }

  private async materializePayload(
    event: RepositoryEvent,
    persisted: WatchRouteRecordV2['event'],
  ): Promise<NotificationPayload> {
    if (event.kind === 'issue' || event.kind === 'push') return createNotificationPayload(event);
    const liveState = await this.refreshLiveState(persisted);
    return attachRepositoryLiveState(createNotificationPayload(event), liveState);
  }

  private async materializePayloadFromRecord(
    route: WatchRouteRecordV2,
  ): Promise<NotificationPayload> {
    const transient = this.transientEvents.get(route.stableKey);
    if (transient) {
      return this.materializePayload(transient, route.event);
    }
    const liveState =
      route.event.kind === 'issue' || route.event.kind === 'push'
        ? undefined
        : await this.refreshLiveState(route.event);
    return createPersistedNotificationPayload(route.event, liveState);
  }

  private async refreshLiveState(
    event: WatchRouteRecordV2['event'],
  ): Promise<RepositoryLiveStateProjection> {
    if (this.refreshLiveStateFn) return this.refreshLiveStateFn(event);
    const resolution = await this.authorityResolver.resolve(event.repository);
    if (!resolution.ok) throw new RepositoryAuthorityFailure(resolution.diagnostic);
    return fetchRepositoryEventLiveState(resolution.client, event);
  }

  private recordRouteEvent(
    type: string,
    route: Pick<WatchRouteRecordV2, 'routeId' | 'canonicalRepository' | 'stableKey' | 'backend'> & {
      id?: string;
    },
    code?: string,
  ): void {
    if (!this.recordEvent) return;
    try {
      this.recordEvent({
        type,
        actor: { id: 'github-watch', kind: 'github', provider: 'github' },
        object: { kind: 'notification_route', id: route.id ?? route.routeId },
        source: { kind: 'github', ref: 'github.watch.delivery.v2' },
        summary: `${type} for ${route.canonicalRepository} route ${route.routeId}`,
        visibility: 'local',
        redacted: true,
        containsSensitiveData: false,
        metadata: {
          routeRecordId: route.id,
          routeId: route.routeId,
          repository: route.canonicalRepository,
          backend: route.backend,
          ...(code ? { code } : {}),
        },
      });
    } catch {
      // Delivery authority never depends on projection recording.
    }
  }

  private forgetIfSettled(stableKey: string): void {
    const active = this.queue
      .listRoutes()
      .some(
        (route) =>
          route.stableKey === stableKey &&
          route.authority === 'openslack' &&
          ['pending', 'processing', 'retryable'].includes(route.state),
      );
    if (!active) this.transientEvents.delete(stableKey);
  }
}

function diagnostic(code: string, message: string, status?: number) {
  return { code: safeCodeValue(code), message, ...(status === undefined ? {} : { status }) };
}

function directRoute(route: GitHubWatchRouteV2) {
  return {
    sink: route.sink,
    ...(route.channel ? { channel: route.channel } : {}),
    ...(route.name ? { name: route.name } : {}),
  };
}

function safeCode(error: unknown): string {
  return error instanceof Error ? safeCodeValue(error.name) : 'UNKNOWN_ERROR';
}

function safeCodeValue(value: string): string {
  const normalized = value.toLocaleUpperCase('en-US').replace(/[^A-Z0-9_]+/gu, '_');
  return normalized.slice(0, 80) || 'UNKNOWN_ERROR';
}

class RepositoryAuthorityFailure extends Error {
  constructor(readonly diagnostic: RepositoryAuthorityDiagnostic) {
    super(diagnostic.message);
    this.name = 'RepositoryAuthorityFailure';
  }
}

export function watchDeliveryV2LiveStateDiagnostic(error: unknown): {
  code: string;
  retryable: boolean;
} {
  if (error instanceof RepositoryLiveStateError) {
    return { code: error.code, retryable: error.retryable };
  }
  if (error instanceof RepositoryAuthorityFailure) {
    return { code: error.diagnostic.code, retryable: error.diagnostic.retryable };
  }
  return { code: 'LIVE_STATE_REFRESH_FAILED', retryable: true };
}
