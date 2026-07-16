import type { NotificationPayload } from './notification-payload.js';
import {
  attachRepositoryLiveState,
  createNotificationPayload,
  createPersistedNotificationPayload,
} from './notification-payload.js';
import type { NotificationSink, SinkResult } from './notification-sinks.js';
import {
  RepositoryAuthorityResolver,
  type RepositoryAuthorityDiagnostic,
} from './repository-authority.js';
import {
  fetchRepositoryEventLiveState,
  RepositoryLiveStateError,
  type RepositoryLiveStateProjection,
} from './repository-live-state.js';
import { repositoryEventStableKey, type RepositoryEvent } from './repository-event.js';
import type {
  ClaimedWatchDelivery,
  WatchDeliveryDiagnostic,
  WatchDeliveryQueue,
  WatchDeliveryRecord,
  WatchRouteDelivery,
} from './watch-delivery-queue.js';

export type WatchDeliveryRecordEventFn = (event: unknown) => unknown;

export interface WatchDeliveryRouterOptions {
  queue: WatchDeliveryQueue;
  sinks: Map<string, NotificationSink>;
  recordEvent?: WatchDeliveryRecordEventFn;
  authorityResolver?: RepositoryAuthorityResolver;
  refreshLiveState?: (
    event: WatchDeliveryRecord['event'],
  ) => Promise<RepositoryLiveStateProjection>;
  workerId?: string;
  intervalMs?: number;
  sinkTimeoutMs?: number;
  maxDeliveriesPerDrain?: number;
}

export interface WatchDeliveryDrainResult {
  claimed: number;
  completed: number;
  retryable: number;
  failed: number;
}

const DEFAULT_DELIVERY_INTERVAL_MS = 1_000;
const DEFAULT_SINK_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_DELIVERIES_PER_DRAIN = 100;

export class WatchDeliveryRouter {
  private readonly queue: WatchDeliveryQueue;
  private readonly sinks: Map<string, NotificationSink>;
  private readonly recordEvent?: WatchDeliveryRecordEventFn;
  private readonly authorityResolver: RepositoryAuthorityResolver;
  private readonly refreshLiveStateFn?: WatchDeliveryRouterOptions['refreshLiveState'];
  private readonly workerId: string;
  private readonly intervalMs: number;
  private readonly sinkTimeoutMs: number;
  private readonly maxDeliveriesPerDrain: number;
  private readonly transientEvents = new Map<string, RepositoryEvent>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeDrain: Promise<WatchDeliveryDrainResult> | null = null;

  constructor(options: WatchDeliveryRouterOptions) {
    this.queue = options.queue;
    this.sinks = options.sinks;
    this.recordEvent = options.recordEvent;
    this.authorityResolver = options.authorityResolver ?? new RepositoryAuthorityResolver();
    this.refreshLiveStateFn = options.refreshLiveState;
    this.workerId = options.workerId ?? `github-watch-${process.pid}`;
    this.intervalMs = options.intervalMs ?? DEFAULT_DELIVERY_INTERVAL_MS;
    this.sinkTimeoutMs = options.sinkTimeoutMs ?? DEFAULT_SINK_TIMEOUT_MS;
    this.maxDeliveriesPerDrain = options.maxDeliveriesPerDrain ?? DEFAULT_MAX_DELIVERIES_PER_DRAIN;
    for (const [name, value] of [
      ['intervalMs', this.intervalMs],
      ['sinkTimeoutMs', this.sinkTimeoutMs],
      ['maxDeliveriesPerDrain', this.maxDeliveriesPerDrain],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`Invalid watch delivery router option: ${name}.`);
      }
    }
  }

  remember(event: RepositoryEvent): void {
    this.transientEvents.set(repositoryEventStableKey(event), event);
  }

  scheduleDrain(): void {
    queueMicrotask(() => {
      void this.drainOnce().catch((error) => {
        console.error(`[GitHub Watch] Delivery drain failed safely: ${safeErrorCode(error)}`);
      });
    });
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

  async drainOnce(): Promise<WatchDeliveryDrainResult> {
    if (this.activeDrain) return this.activeDrain;
    const drain = this.runDrain();
    this.activeDrain = drain;
    try {
      return await drain;
    } finally {
      if (this.activeDrain === drain) this.activeDrain = null;
    }
  }

  private async runDrain(): Promise<WatchDeliveryDrainResult> {
    const result: WatchDeliveryDrainResult = {
      claimed: 0,
      completed: 0,
      retryable: 0,
      failed: 0,
    };
    for (let index = 0; index < this.maxDeliveriesPerDrain; index += 1) {
      const claim = this.queue.claimNext(this.workerId);
      if (!claim) break;
      result.claimed += 1;
      const final = await this.processClaim(claim);
      result[final] += 1;
    }
    return result;
  }

  private async processClaim(
    claim: ClaimedWatchDelivery,
  ): Promise<'completed' | 'retryable' | 'failed'> {
    const { delivery, lease } = claim;
    let liveState: RepositoryLiveStateProjection | undefined;
    if (delivery.event.kind !== 'issue' && delivery.event.kind !== 'push') {
      try {
        liveState = await this.refreshLiveState(delivery.event);
      } catch (error) {
        const diagnostic = liveStateDiagnostic(error);
        const settled = diagnostic.retryable
          ? this.queue.retryDelivery(delivery.id, lease.token, diagnostic)
          : this.queue.failDelivery(delivery.id, lease.token, diagnostic);
        this.recordDeliveryDiagnostic(settled, diagnostic);
        if (settled.state === 'failed') this.transientEvents.delete(delivery.stableKey);
        return settled.state === 'failed' ? 'failed' : 'retryable';
      }
    }

    const transient = this.transientEvents.get(delivery.stableKey);
    let payload = transient
      ? createNotificationPayload(transient)
      : createPersistedNotificationPayload(delivery.event, liveState);
    if (liveState && transient) {
      payload = attachRepositoryLiveState(payload, liveState);
    }

    for (const route of delivery.routes) {
      if (route.state !== 'pending' && route.state !== 'retryable') continue;
      const attempt = this.queue.beginRouteAttempt(delivery.id, lease.token, route.routeKey);
      if (!attempt) continue;
      await this.processRoute(delivery, lease.token, attempt, payload);
    }

    const settled = this.queue.finishDelivery(delivery.id, lease.token);
    if (settled.state === 'completed' || settled.state === 'failed') {
      this.transientEvents.delete(delivery.stableKey);
    }
    return settled.state === 'completed'
      ? 'completed'
      : settled.state === 'failed'
        ? 'failed'
        : 'retryable';
  }

  private async processRoute(
    delivery: WatchDeliveryRecord,
    leaseToken: string,
    route: WatchRouteDelivery,
    payload: NotificationPayload,
  ): Promise<void> {
    const sink = this.sinks.get(route.route.sink);
    if (!sink) {
      console.warn(`No sink configured for: ${route.route.sink}`);
      const diagnostic = {
        code: 'SINK_NOT_CONFIGURED',
        message: `The ${route.route.sink} notification sink is not configured.`,
      };
      const settled = this.queue.markRouteFailed(
        delivery.id,
        leaseToken,
        route.routeKey,
        diagnostic,
      );
      this.recordRouteResult(false, route, payload, diagnostic.code);
      this.recordDeliveryDiagnostic(settled, {
        ...diagnostic,
        retryable: false,
      });
      return;
    }

    let result: SinkResult;
    try {
      result = await sink.send(payload, route.route, {
        idempotencyKey: route.idempotencyKey,
        attempt: route.attempts,
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
      this.queue.markRouteCompleted(delivery.id, leaseToken, route.routeKey);
      this.recordRouteResult(true, route, payload);
      return;
    }
    if (result.outcome === 'retryable') {
      this.queue.markRouteRetryable(
        delivery.id,
        leaseToken,
        route.routeKey,
        {
          code: result.code,
          message: result.error,
        },
        result.retryAfterMs,
      );
    } else {
      this.queue.markRouteFailed(delivery.id, leaseToken, route.routeKey, {
        code: result.code,
        message: result.error,
      });
    }
    this.recordRouteResult(false, route, payload, result.code);
  }

  private async refreshLiveState(
    event: WatchDeliveryRecord['event'],
  ): Promise<RepositoryLiveStateProjection> {
    if (this.refreshLiveStateFn) return this.refreshLiveStateFn(event);
    const resolution = await this.authorityResolver.resolve(event.repository);
    if (!resolution.ok) throw new RepositoryAuthorityFailure(resolution.diagnostic);
    return fetchRepositoryEventLiveState(resolution.client, event);
  }

  private recordRouteResult(
    success: boolean,
    route: WatchRouteDelivery,
    payload: NotificationPayload,
    errorCode?: string,
  ): void {
    if (!this.recordEvent) return;
    try {
      this.recordEvent({
        type: success ? 'notification.sent' : 'notification.failed',
        actor: { id: 'github-watch', kind: 'github', provider: 'github' },
        object: {
          kind: collaborationObjectKind(payload),
          id: payload.objectId,
          url: payload.url,
        },
        source: { kind: 'github', ref: 'github.watch.delivery' },
        summary: success
          ? `Notification delivered via ${route.route.sink} for ${notificationSubject(payload)}`
          : `Notification delivery failed via ${route.route.sink} for ${notificationSubject(payload)} (${errorCode ?? 'DELIVERY_FAILED'})`,
        visibility: 'local',
        redacted: false,
        containsSensitiveData: false,
        metadata: {
          sink: route.route.sink,
          channel: route.route.channel,
          errorCode,
          objectKind: payload.objectKind,
          eventKey: payload.eventKey,
          eventStableKey: payload.eventStableKey,
          idempotencyKey: route.idempotencyKey,
          informational: payload.informational,
        },
      });
    } catch {
      // Collaboration recording is projection-only and best effort.
    }
  }

  private recordDeliveryDiagnostic(
    delivery: WatchDeliveryRecord,
    diagnostic: Omit<WatchDeliveryDiagnostic, 'recordedAt'>,
  ): void {
    console.error(
      `[GitHub Watch] ${diagnostic.code} for ${delivery.event.repository.fullName}: ${diagnostic.message}`,
    );
    if (!this.recordEvent) return;
    try {
      this.recordEvent({
        type: 'notification.failed',
        actor: { id: 'github-watch', kind: 'github', provider: 'github' },
        object: {
          kind:
            delivery.event.kind === 'pull_request' || delivery.event.kind === 'pull_request_review'
              ? 'pr'
              : 'workspace',
          id: delivery.event.object.id,
        },
        source: { kind: 'github', ref: 'github.watch.live_state' },
        summary: `Repository event delivery blocked safely (${diagnostic.code})`,
        visibility: 'local',
        redacted: false,
        containsSensitiveData: false,
        metadata: {
          repository: delivery.event.repository.fullName,
          eventKey: delivery.event.eventKey,
          errorCode: diagnostic.code,
          retryable: diagnostic.retryable,
          informational: true,
        },
      });
    } catch {
      // Collaboration recording is projection-only and best effort.
    }
  }
}

class RepositoryAuthorityFailure extends Error {
  readonly diagnostic: RepositoryAuthorityDiagnostic;

  constructor(diagnostic: RepositoryAuthorityDiagnostic) {
    super(diagnostic.message);
    this.name = 'RepositoryAuthorityFailure';
    this.diagnostic = diagnostic;
  }
}

function liveStateDiagnostic(error: unknown): Omit<WatchDeliveryDiagnostic, 'recordedAt'> {
  if (error instanceof RepositoryAuthorityFailure) {
    return {
      code: error.diagnostic.code,
      message: error.diagnostic.message,
      retryable: error.diagnostic.retryable,
    };
  }
  if (error instanceof RepositoryLiveStateError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: 'LIVE_STATE_UNAVAILABLE',
    message: 'Repository live-state evidence could not be refreshed safely.',
    retryable: true,
  };
}

function notificationSubject(payload: NotificationPayload): string {
  switch (payload.objectKind) {
    case 'issue':
      return `${payload.repo}#${payload.issueNumber}`;
    case 'pull_request':
    case 'review':
      return `${payload.repo}#${payload.pullRequestNumber}`;
    case 'push':
      return `${payload.repo}@${payload.after.slice(0, 12)}`;
    case 'check':
      return `${payload.repo} check ${payload.checkId}`;
  }
}

function collaborationObjectKind(payload: NotificationPayload): 'issue' | 'pr' | 'workspace' {
  switch (payload.objectKind) {
    case 'issue':
      return 'issue';
    case 'pull_request':
    case 'review':
      return 'pr';
    case 'push':
    case 'check':
      return 'workspace';
  }
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z0-9_]{1,80}$/u.test(code)) return code;
  }
  return 'DELIVERY_DRAIN_FAILED';
}
