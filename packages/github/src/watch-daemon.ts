import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { GitHubWatchConfig } from './watch-config.js';
import { verifyGitHubWebhookSignature } from './webhook-verify.js';
import {
  normalizeIssueEvent,
  matchesRepoConfig,
  type NormalizedIssueEvent,
  type NormalizedIssueRepositoryEvent,
} from './issue-normalizer.js';
import { WatchDeliveryQueue, WatchDeliveryQueueError } from './watch-delivery-queue.js';
import { createSinks, type NotificationSink } from './notification-sinks.js';
import { WatchDeliveryRouter } from './watch-delivery-router.js';
import { WatchCursorStore } from './watch-cursor.js';
import { pollRepoIssues } from './watch-poller.js';
import { normalizePollIssue } from './poll-normalizer.js';
import type { NormalizedPushEvent } from './push-normalizer.js';
import type { ProfileSyncConfig } from './profile-sync-config.js';
import type { ProfileSyncWorker } from './profile-sync-worker.js';
import { RepositoryAuthorityResolver } from './repository-authority.js';
import type { RepositoryLiveStateProjection } from './repository-live-state.js';
import {
  readWebhookBody,
  WebhookBodyReadError,
  type WebhookBodyReadOptions,
} from './webhook-body.js';
import { formatNotification, type NotificationPayload } from './notification-payload.js';
import { normalizeRepositoryEvent } from './repository-normalizer.js';
import {
  githubWebhookEventKey,
  isGitHubWebhookEventName,
  canonicalizeRepositoryName,
  repositoriesMatch,
  toPersistableRepositoryEvent,
  type IssueRepositoryEvent,
  type PushRepositoryEvent,
  type RepositoryEvent,
} from './repository-event.js';

export { createNotificationPayload } from './notification-payload.js';
export type { NotificationPayload } from './notification-payload.js';

export interface CollaborationEventRecord {
  id: string;
  type: string;
  actor: { id: string; kind: string; provider: string };
  object: { kind: string; id: string; url?: string };
  source: { kind: string; ref: string };
  summary: string;
  visibility: string;
  redacted: boolean;
  containsSensitiveData: boolean;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export type RecordEventFn = (event: unknown) => CollaborationEventRecord;

export type AutoClaimFn = (
  event: NormalizedIssueRepositoryEvent,
  agentIds: string[],
) => Promise<void>;

export interface WatchDaemonDependencies {
  sinks?: Map<string, NotificationSink>;
  cursorStore?: WatchCursorStore;
  authorityResolver?: RepositoryAuthorityResolver;
  refreshLiveState?: (
    event: ReturnType<typeof toPersistableRepositoryEvent>,
  ) => Promise<RepositoryLiveStateProjection>;
  deliveryWorkerIntervalMs?: number;
  deliverySinkTimeoutMs?: number;
}

function jsonResponse(res: ServerResponse, status: number, data: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function closingJsonResponse(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  data: Record<string, unknown>,
): void {
  res.shouldKeepAlive = false;
  res.once('finish', () => {
    if (!req.destroyed) req.destroy();
  });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    Connection: 'close',
  });
  res.end(JSON.stringify(data));
}

export function formatConsoleNotification(payload: NotificationPayload): string {
  return formatNotification(payload);
}

export class WatchDaemon {
  private config: GitHubWatchConfig;
  private secret: string;
  private deliveryQueue: WatchDeliveryQueue;
  private deliveryRouter: WatchDeliveryRouter;
  private sinks: Map<string, NotificationSink>;
  private cursorStore: WatchCursorStore;
  private authorityResolver: RepositoryAuthorityResolver;
  private autoClaimFn: AutoClaimFn | null;
  private recordEventFn: RecordEventFn | null;
  private webhookBodyReadOptions: WebhookBodyReadOptions;
  private server: Server | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private profileSyncWorker: ProfileSyncWorker | null = null;

  constructor(
    config: GitHubWatchConfig,
    secret: string,
    deliveryQueue?: WatchDeliveryQueue,
    sinkOptions?: { slackBotToken?: string; webhookUrl?: string },
    autoClaimFn?: AutoClaimFn,
    recordEventFn?: RecordEventFn,
    webhookBodyReadOptions: WebhookBodyReadOptions = {},
    dependencies: WatchDaemonDependencies = {},
  ) {
    this.config = config;
    this.secret = secret;
    this.deliveryQueue = deliveryQueue ?? new WatchDeliveryQueue();
    this.sinks = dependencies.sinks ?? createSinks(sinkOptions ?? {});
    this.cursorStore = dependencies.cursorStore ?? new WatchCursorStore();
    this.authorityResolver = dependencies.authorityResolver ?? new RepositoryAuthorityResolver();
    this.autoClaimFn = autoClaimFn ?? null;
    this.recordEventFn = recordEventFn ?? null;
    this.webhookBodyReadOptions = webhookBodyReadOptions;
    this.deliveryRouter = new WatchDeliveryRouter({
      queue: this.deliveryQueue,
      sinks: this.sinks,
      recordEvent: this.recordEventFn ?? undefined,
      authorityResolver: this.authorityResolver,
      refreshLiveState: dependencies.refreshLiveState,
      intervalMs: dependencies.deliveryWorkerIntervalMs,
      sinkTimeoutMs: dependencies.deliverySinkTimeoutMs,
    });
  }

  async start(port: number): Promise<void> {
    this.deliveryRouter.start();
    // Start profile-sync worker if auto-pr mode may be used
    try {
      const { ProfileSyncWorker } = await import('./profile-sync-worker.js');
      this.profileSyncWorker = new ProfileSyncWorker({
        intervalMs: 5000,
        recordEvent: this.recordEventFn
          ? async (event) => {
              this.recordEventFn!(event);
            }
          : undefined,
      });
      this.profileSyncWorker.start();
    } catch {
      // Worker start is best-effort
    }

    return new Promise((resolve) => {
      this.server = createServer((req, res) => {
        void this.handleRequest(req, res).catch((error) => {
          if (res.headersSent) {
            if (!req.destroyed) req.destroy();
            return;
          }
          const code =
            error instanceof WatchDeliveryQueueError ? error.code : 'WATCH_DELIVERY_FAILED';
          jsonResponse(res, 503, {
            error: 'Repository event could not be durably accepted.',
            code,
          });
        });
      });
      this.server.listen(port, () => {
        console.log(`GitHub Watch Daemon listening on port ${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopPolling();
    await this.deliveryRouter.stop();
    if (this.profileSyncWorker) {
      this.profileSyncWorker.stop();
      this.profileSyncWorker = null;
    }
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  async once(
    event: NormalizedIssueEvent,
    sourceRef: string = 'github.watch.webhook',
    awaitDelivery = true,
  ): Promise<CollaborationEventRecord | null> {
    return (await this.processIssueEvent(event, sourceRef, awaitDelivery)).collabEvent;
  }

  private async processIssueEvent(
    event: NormalizedIssueEvent,
    sourceRef: string,
    awaitDelivery: boolean,
  ): Promise<{
    accepted: boolean;
    deliveryId?: string;
    collabEvent: CollaborationEventRecord | null;
  }> {
    const repoConfig = this.config.repositories.find((r) => repositoriesMatch(event, r));
    if (!repoConfig) return { accepted: false, collabEvent: null };

    const matches = matchesRepoConfig(event, repoConfig);
    const repositoryEvent = asIssueRepositoryEvent(event, sourceRef);
    const routes = matches ? (repoConfig.routes ?? [{ sink: 'console' as const }]) : [];
    const enqueue = this.deliveryQueue.claimAndEnqueue(
      toPersistableRepositoryEvent(repositoryEvent),
      routes,
    );
    if (enqueue.outcome === 'conflict') {
      throw new WatchDeliveryQueueError(
        'QUEUE_TRANSITION_INVALID',
        'A GitHub delivery identity was reused for a different event.',
      );
    }
    if (enqueue.outcome === 'duplicate') {
      return {
        accepted: false,
        deliveryId: enqueue.delivery?.id,
        collabEvent: null,
      };
    }
    if (routes.length > 0) {
      this.deliveryRouter.remember(repositoryEvent);
      if (awaitDelivery) await this.deliveryRouter.drainOnce();
      else this.deliveryRouter.scheduleDrain();
    }

    const eventType = matches ? 'task.created' : 'task.blocked';
    const summary = matches
      ? `Issue ${event.owner}/${event.repo}#${event.issueNumber} matches watch filters: ${event.title}`
      : `Issue ${event.owner}/${event.repo}#${event.issueNumber} did not match watch filters`;

    let collabEvent: CollaborationEventRecord | null = null;
    try {
      if (this.recordEventFn) {
        collabEvent = this.recordEventFn({
          type: eventType,
          actor: { id: 'github-watch', kind: 'github', provider: 'github' },
          object: {
            kind: 'issue',
            id: `${event.owner}/${event.repo}#${event.issueNumber}`,
            url: event.url,
          },
          source: { kind: 'github', ref: sourceRef },
          summary,
          visibility: 'local',
          redacted: false,
          containsSensitiveData: false,
          metadata: {
            labels: event.labels,
            action: event.action,
            deliveryId: event.deliveryId || undefined,
          },
        });
      }
    } catch {
      // best-effort event recording
    }

    if (
      repositoryEvent.kind === 'issue' &&
      matches &&
      repoConfig.auto_claim?.enabled &&
      this.autoClaimFn
    ) {
      const agentIds = repoConfig.auto_claim.agent_ids ?? [];
      if (agentIds.length > 0) {
        const autoClaim = async () => {
          try {
            await this.autoClaimFn!(repositoryEvent, agentIds);
          } catch (err) {
            console.error(
              `[Auto-Claim] Error for ${event.owner}/${event.repo}#${event.issueNumber}: ${(err as Error).message}`,
            );
          }
        };
        if (awaitDelivery) await autoClaim();
        else queueMicrotask(() => void autoClaim());
      }
    }

    return {
      accepted: true,
      deliveryId: enqueue.delivery.id,
      collabEvent,
    };
  }

  async observeRepositoryEvent(
    event: Exclude<RepositoryEvent, { kind: 'issue' | 'push' }>,
    repoConfig: GitHubWatchConfig['repositories'][number],
    awaitDelivery = false,
  ): Promise<boolean> {
    const enqueue = this.deliveryQueue.claimAndEnqueue(
      toPersistableRepositoryEvent(event),
      repoConfig.routes ?? [{ sink: 'console' as const }],
    );
    if (enqueue.outcome === 'conflict') {
      throw new WatchDeliveryQueueError(
        'QUEUE_TRANSITION_INVALID',
        'A GitHub delivery identity was reused for a different event.',
      );
    }
    if (enqueue.outcome === 'duplicate') return false;
    this.deliveryRouter.remember(event);
    if (awaitDelivery) await this.deliveryRouter.drainOnce();
    else this.deliveryRouter.scheduleDrain();
    return true;
  }

  async pollAll(): Promise<{ reposPolled: number; eventsDispatched: number; errors: string[] }> {
    const result = { reposPolled: 0, eventsDispatched: 0, errors: [] as string[] };

    for (const repoConfig of this.config.repositories) {
      const repoKey = `${repoConfig.owner}/${repoConfig.repo}`;
      result.reposPolled++;
      const repository = canonicalizeRepositoryName(repoConfig.owner, repoConfig.repo);
      if (!repository) {
        result.errors.push(`Invalid configured repository: ${repoKey}`);
        continue;
      }
      const resolution = await this.authorityResolver.resolve(repository);
      if (!resolution.ok) {
        result.errors.push(`${resolution.diagnostic.code}: ${resolution.diagnostic.repository}`);
        continue;
      }

      const cursor = this.cursorStore.getCursor(repoKey);
      const since = cursor?.lastSeenAt ?? new Date(Date.now() - 5 * 60_000).toISOString();

      const pollResult = await pollRepoIssues(
        resolution.client.octokit,
        repoConfig.owner,
        repoConfig.repo,
        since,
      );

      if (pollResult.error) {
        result.errors.push(pollResult.error);
        continue;
      }

      for (const issue of pollResult.issues) {
        const normalized = normalizePollIssue(issue, repoConfig.owner, repoConfig.repo);
        const eventKey = githubWebhookEventKey('issues', normalized.action);
        if (!eventKey || !repoConfig.events.includes(eventKey)) continue;
        const event = await this.once(normalized, 'github.watch.poll', false);
        if (event) result.eventsDispatched++;
      }

      this.cursorStore.updateCursor(repoKey, pollResult.newCursor);
    }

    await this.deliveryRouter.drainOnce();

    return result;
  }

  async startPolling(intervalSeconds: number = 300): Promise<void> {
    this.deliveryRouter.start();
    const firstResult = await this.pollAll();
    console.log(
      `[Poll] Initial poll complete: ${firstResult.reposPolled} repos, ${firstResult.eventsDispatched} events`,
    );

    this.pollTimer = setInterval(async () => {
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      try {
        const pollResult = await this.pollAll();
        if (pollResult.eventsDispatched > 0 || pollResult.errors.length > 0) {
          console.log(
            `[Poll] ${pollResult.reposPolled} repos, ${pollResult.eventsDispatched} events${pollResult.errors.length > 0 ? `, ${pollResult.errors.length} errors` : ''}`,
          );
        }
      } catch (err) {
        console.error(`[Poll] Error: ${(err as Error).message}`);
      } finally {
        this.pollInFlight = false;
      }
    }, intervalSeconds * 1000);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/github/webhook') {
      jsonResponse(res, 404, { error: 'Not found' });
      return;
    }

    const headers: Record<string, string | undefined> = {};
    for (const key of Object.keys(req.headers)) {
      headers[key] = req.headers[key] as string | undefined;
    }

    let rawBody: Buffer;
    try {
      rawBody = await readWebhookBody(req, this.webhookBodyReadOptions);
    } catch (error) {
      if (error instanceof WebhookBodyReadError) {
        closingJsonResponse(req, res, error.statusCode, {
          error: error.message,
          code: error.code,
        });
      } else {
        closingJsonResponse(req, res, 400, { error: 'Could not read webhook body' });
      }
      return;
    }

    const signature = headers['x-hub-signature-256'];
    if (!verifyGitHubWebhookSignature(rawBody, signature, this.secret)) {
      jsonResponse(res, 401, { error: 'Invalid signature' });
      return;
    }

    const gitHubEvent = headers['x-github-event'];
    if (!isGitHubWebhookEventName(gitHubEvent)) {
      jsonResponse(res, 202, { ok: true, ignored: `event type: ${gitHubEvent}` });
      return;
    }

    let payload: unknown;
    try {
      const body = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
      payload = JSON.parse(body);
    } catch {
      jsonResponse(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const root =
      payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;
    const action = typeof root?.action === 'string' ? root.action : undefined;
    const eventKey = githubWebhookEventKey(gitHubEvent, action);
    if (!eventKey) {
      jsonResponse(res, 202, {
        ok: true,
        ignored: `action ${action ?? '(missing)'} for ${gitHubEvent}`,
      });
      return;
    }

    if (gitHubEvent === 'issues') {
      const normalized = normalizeIssueEvent(payload, headers);
      if (!normalized) {
        jsonResponse(res, 400, { error: 'Could not normalize issue event' });
        return;
      }

      const repoConfig = this.config.repositories.find((r) => repositoriesMatch(normalized, r));
      if (!repoConfig) {
        jsonResponse(res, 202, {
          ok: true,
          ignored: `repo not in allowlist: ${normalized.owner}/${normalized.repo}`,
        });
        return;
      }

      if (!repoConfig.events.includes(eventKey)) {
        jsonResponse(res, 202, {
          ok: true,
          ignored: `action ${normalized.action} not watched for ${normalized.owner}/${normalized.repo}`,
        });
        return;
      }

      const result = await this.processIssueEvent(normalized, 'github.watch.webhook', false);
      if (result.accepted) {
        jsonResponse(res, 200, {
          ok: true,
          delivery_id: result.deliveryId,
          ...(result.collabEvent ? { event_id: result.collabEvent.id } : {}),
        });
      } else {
        jsonResponse(res, 200, { ok: true, ignored: 'duplicate or filtered' });
      }
      return;
    }

    if (gitHubEvent === 'push') {
      const { normalizePushEvent } = await import('./push-normalizer.js');
      const normalized = normalizePushEvent(payload, headers);
      if (!normalized) {
        jsonResponse(res, 202, { ok: true, ignored: 'no relevant commits' });
        return;
      }

      const repoConfig = this.config.repositories.find((r) => repositoriesMatch(normalized, r));
      if (!repoConfig) {
        jsonResponse(res, 202, {
          ok: true,
          ignored: `repo not in allowlist: ${normalized.owner}/${normalized.repo}`,
        });
        return;
      }

      if (!repoConfig.events.includes('push')) {
        jsonResponse(res, 202, {
          ok: true,
          ignored: `push not watched for ${normalized.owner}/${normalized.repo}`,
        });
        return;
      }

      const result = await this.processPushEvent(normalized, false);
      if (result.accepted) {
        jsonResponse(res, 200, {
          ok: true,
          delivery_id: result.deliveryId,
          ...(result.collabEvent ? { event_id: result.collabEvent.id } : {}),
        });
      } else {
        jsonResponse(res, 200, { ok: true, ignored: 'duplicate or filtered' });
      }
      return;
    }

    const normalized = normalizeRepositoryEvent(gitHubEvent, payload, headers);
    if (!normalized || normalized.kind === 'issue' || normalized.kind === 'push') {
      jsonResponse(res, 400, { error: `Could not normalize ${gitHubEvent} event` });
      return;
    }

    const repoConfig = this.config.repositories.find((repository) =>
      repositoriesMatch(normalized.repository, repository),
    );
    if (!repoConfig) {
      jsonResponse(res, 202, {
        ok: true,
        ignored: `repo not in allowlist: ${normalized.repository.fullName}`,
      });
      return;
    }
    if (!repoConfig.events.includes(normalized.eventKey)) {
      jsonResponse(res, 202, {
        ok: true,
        ignored: `${normalized.eventKey} not watched for ${normalized.repository.fullName}`,
      });
      return;
    }

    const dispatched = await this.observeRepositoryEvent(normalized, repoConfig);
    jsonResponse(
      res,
      200,
      dispatched
        ? { ok: true, event_key: normalized.eventKey }
        : { ok: true, ignored: 'duplicate or filtered' },
    );
  }

  async handlePushEvent(
    event: NormalizedPushEvent,
    awaitDelivery = true,
  ): Promise<CollaborationEventRecord | null> {
    return (await this.processPushEvent(event, awaitDelivery)).collabEvent;
  }

  private async processPushEvent(
    event: NormalizedPushEvent,
    awaitDelivery: boolean,
  ): Promise<{
    accepted: boolean;
    deliveryId?: string;
    collabEvent: CollaborationEventRecord | null;
  }> {
    const repositoryEvent = asPushRepositoryEvent(event);
    const repoConfig = this.config.repositories.find((repository) =>
      repositoriesMatch(repositoryEvent.repository, repository),
    );
    const routes =
      repoConfig?.events.includes('push') === true
        ? (repoConfig.routes ?? [{ sink: 'console' as const }])
        : [];
    const enqueue = this.deliveryQueue.claimAndEnqueue(
      toPersistableRepositoryEvent(repositoryEvent),
      routes,
    );
    if (enqueue.outcome === 'conflict') {
      throw new WatchDeliveryQueueError(
        'QUEUE_TRANSITION_INVALID',
        'A GitHub delivery identity was reused for a different event.',
      );
    }
    if (enqueue.outcome === 'duplicate') {
      return {
        accepted: false,
        deliveryId: enqueue.delivery?.id,
        collabEvent: null,
      };
    }
    if (routes.length > 0) {
      this.deliveryRouter.remember(repositoryEvent);
      if (awaitDelivery) await this.deliveryRouter.drainOnce();
      else this.deliveryRouter.scheduleDrain();
    }

    const hasPostChanges = event.commits.length > 0;

    // Load profile-sync config to determine mode
    let psConfig: ProfileSyncConfig | null = null;
    try {
      const { loadProfileSyncConfig } = await import('./profile-sync-config.js');
      psConfig = loadProfileSyncConfig();
    } catch {
      // config missing or invalid — fall through to default behavior
    }

    // Determine if this push matches the configured source repo
    const pushRepo = `${event.owner}/${event.repo}`;
    const configMatches = psConfig && psConfig.source.repo === pushRepo;

    let collabEvent: CollaborationEventRecord | null = null;
    try {
      if (this.recordEventFn) {
        collabEvent = this.recordEventFn({
          type: hasPostChanges && configMatches ? 'profile_sync.triggered' : 'push.detected',
          actor: { id: 'github-watch', kind: 'github', provider: 'github' },
          object: {
            kind: 'push',
            id: `${event.owner}/${event.repo}@${event.after}`,
          },
          source: { kind: 'github', ref: 'github.watch.webhook' },
          summary: hasPostChanges
            ? `Push to ${event.owner}/${event.repo} contains whitepaper changes (${event.commits.length} commit(s))`
            : `Push to ${event.owner}/${event.repo} (no whitepaper changes)`,
          visibility: 'local',
          redacted: false,
          containsSensitiveData: false,
          metadata: {
            ref: event.ref,
            commits: event.commits.length,
            hasPostChanges,
            configMatches: configMatches ?? false,
            mode: psConfig?.mode ?? 'none',
          },
        });
      }
    } catch {
      // best-effort event recording
    }

    // If no profile-sync config or repo doesn't match, stop here
    if (!configMatches || !psConfig) {
      return {
        accepted: true,
        deliveryId: enqueue.delivery.id,
        collabEvent,
      };
    }

    // Mode: manual — record triggered event only (already done above)
    if (psConfig.mode === 'manual') {
      return {
        accepted: true,
        deliveryId: enqueue.delivery.id,
        collabEvent,
      };
    }

    // Mode: watch — record triggered + console notification
    if (psConfig.mode === 'watch') {
      console.log(
        `[Profile Sync Watch] Push to ${pushRepo} detected ${event.commits.length} post change(s). Run 'openslack collaboration workflow profile-sync run' to create PR.`,
      );
      return {
        accepted: true,
        deliveryId: enqueue.delivery.id,
        collabEvent,
      };
    }

    // Mode: auto-pr — enqueue job for worker
    if (psConfig.mode === 'auto-pr') {
      try {
        const { enqueueProfileSyncJob } = await import('./profile-sync-queue.js');

        const job = enqueueProfileSyncJob({
          deliveryId: event.deliveryId || `${event.owner}/${event.repo}@${event.after}`,
          sourceRepo: psConfig.source.repo,
          sourceSha: event.after,
          targetRepo: psConfig.target.repo,
          marker: psConfig.target.marker,
          config: psConfig,
        });

        if (!job) {
          console.log(`[Profile Sync Auto-PR] Duplicate delivery ${event.deliveryId}, skipping.`);
          return {
            accepted: true,
            deliveryId: enqueue.delivery.id,
            collabEvent,
          };
        }

        if (this.recordEventFn) {
          try {
            this.recordEventFn({
              type: 'profile_sync.queued',
              actor: { id: 'github-watch', kind: 'github', provider: 'github' },
              object: { kind: 'job', id: job.id },
              source: { kind: 'github', ref: 'profile-sync.queue' },
              summary: `Enqueued profile-sync job ${job.id} for ${pushRepo}`,
              visibility: 'local',
              redacted: false,
              containsSensitiveData: false,
              metadata: {
                jobId: job.id,
                sourceRepo: psConfig.source.repo,
                sourceSha: event.after,
                deliveryId: event.deliveryId,
                correlationId: job.id,
              },
            });
          } catch {
            // best-effort
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Profile Sync Auto-PR] Failed to enqueue: ${msg}`);
      }
    }

    return {
      accepted: true,
      deliveryId: enqueue.delivery.id,
      collabEvent,
    };
  }
}

function asIssueRepositoryEvent(
  event: NormalizedIssueEvent,
  sourceRef: string,
): NormalizedIssueEvent & IssueRepositoryEvent {
  if ('kind' in event && event.kind === 'issue') {
    return event as NormalizedIssueEvent & IssueRepositoryEvent;
  }
  const repository = canonicalizeRepositoryName(event.owner, event.repo);
  const eventKey = githubWebhookEventKey('issues', event.action);
  if (!repository || !eventKey || !eventKey.startsWith('issues.')) {
    throw new TypeError('The issue event cannot be normalized for durable delivery.');
  }
  return {
    ...event,
    kind: 'issue',
    eventKey: eventKey as IssueRepositoryEvent['eventKey'],
    action: event.action as IssueRepositoryEvent['action'],
    repository,
    object: {
      kind: 'issue',
      id: `${repository.canonicalFullName}#${event.issueNumber}`,
      number: event.issueNumber,
    },
    source: sourceRef === 'github.watch.poll' ? 'poll' : 'webhook',
    observedAt: event.updatedAt,
    metadata: {
      informational: false,
      senderLogin: event.senderLogin,
    },
  };
}

function asPushRepositoryEvent(
  event: NormalizedPushEvent,
): NormalizedPushEvent & PushRepositoryEvent {
  if ('kind' in event && event.kind === 'push') {
    return event as NormalizedPushEvent & PushRepositoryEvent;
  }
  const repository = canonicalizeRepositoryName(event.owner, event.repo);
  if (!repository) {
    throw new TypeError('The push event cannot be normalized for durable delivery.');
  }
  return {
    ...event,
    kind: 'push',
    eventKey: 'push',
    action: 'push',
    repository,
    object: {
      kind: 'push',
      id: `${repository.canonicalFullName}@${event.after}`,
    },
    source: 'webhook',
    observedAt: event.commits[event.commits.length - 1]?.timestamp ?? new Date().toISOString(),
    metadata: {
      informational: false,
      senderLogin: event.pusher,
    },
  };
}
