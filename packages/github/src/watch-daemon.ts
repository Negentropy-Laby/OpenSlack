import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { GitHubWatchConfig, GitHubWatchRoute } from './watch-config.js';
import { verifyGitHubWebhookSignature } from './webhook-verify.js';
import {
  normalizeIssueEvent,
  matchesRepoConfig,
  type NormalizedIssueEvent,
} from './issue-normalizer.js';
import { WatchDedupeStore } from './watch-dedupe.js';
import { createSinks, type NotificationSink } from './notification-sinks.js';
import { WatchCursorStore, type RepoCursor } from './watch-cursor.js';
import { pollRepoIssues } from './watch-poller.js';
import { normalizePollIssue } from './poll-normalizer.js';
import { getClient } from './client.js';
import {
  readWebhookBody,
  WebhookBodyReadError,
  type WebhookBodyReadOptions,
} from './webhook-body.js';
import {
  createNotificationPayload,
  formatNotification,
  type NotificationPayload,
} from './notification-payload.js';
import { normalizeRepositoryEvent } from './repository-normalizer.js';
import {
  githubWebhookEventKey,
  isGitHubWebhookEventName,
  repositoriesMatch,
  repositoryEventStableKey,
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

export type AutoClaimFn = (event: NormalizedIssueEvent, agentIds: string[]) => Promise<void>;

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

function recordNotificationEvent(
  recordFn: RecordEventFn | null,
  success: boolean,
  route: GitHubWatchRoute,
  payload: NotificationPayload,
  error?: string,
): void {
  if (!recordFn) return;
  try {
    const subject = notificationSubject(payload);
    recordFn({
      type: success ? 'notification.sent' : 'notification.failed',
      actor: { id: 'github-watch', kind: 'github', provider: 'github' },
      object: {
        kind: notificationCollaborationObjectKind(payload),
        id: payload.objectId,
        url: payload.url,
      },
      source: { kind: 'github', ref: 'github.watch.notification' },
      summary: success
        ? `Notification sent via ${route.sink} for ${subject}`
        : `Notification failed via ${route.sink} for ${subject}: ${error ?? 'unknown'}`,
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      metadata: {
        sink: route.sink,
        channel: route.channel,
        error,
        objectKind: payload.objectKind,
        eventKey: payload.eventKey,
        eventStableKey: payload.eventStableKey,
        informational: payload.informational,
      },
    });
  } catch {
    // best-effort event recording
  }
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

function notificationCollaborationObjectKind(
  payload: NotificationPayload,
): 'issue' | 'pr' | 'workspace' {
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

export class WatchDaemon {
  private config: GitHubWatchConfig;
  private secret: string;
  private dedupe: WatchDedupeStore;
  private sinks: Map<string, NotificationSink>;
  private cursorStore: WatchCursorStore;
  private autoClaimFn: AutoClaimFn | null;
  private recordEventFn: RecordEventFn | null;
  private webhookBodyReadOptions: WebhookBodyReadOptions;
  private server: Server | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private profileSyncWorker: import('./profile-sync-worker.js').ProfileSyncWorker | null = null;

  constructor(
    config: GitHubWatchConfig,
    secret: string,
    dedupe?: WatchDedupeStore,
    sinkOptions?: { slackBotToken?: string; webhookUrl?: string },
    autoClaimFn?: AutoClaimFn,
    recordEventFn?: RecordEventFn,
    webhookBodyReadOptions: WebhookBodyReadOptions = {},
  ) {
    this.config = config;
    this.secret = secret;
    this.dedupe = dedupe ?? new WatchDedupeStore();
    this.sinks = createSinks(sinkOptions ?? {});
    this.cursorStore = new WatchCursorStore();
    this.autoClaimFn = autoClaimFn ?? null;
    this.recordEventFn = recordEventFn ?? null;
    this.webhookBodyReadOptions = webhookBodyReadOptions;
  }

  async start(port: number): Promise<void> {
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
      this.server = createServer(async (req, res) => {
        await this.handleRequest(req, res);
      });
      this.server.listen(port, () => {
        console.log(`GitHub Watch Daemon listening on port ${port}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.stopPolling();
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
  ): Promise<CollaborationEventRecord | null> {
    const repoConfig = this.config.repositories.find((r) => repositoriesMatch(event, r));
    if (!repoConfig) return null;

    const matches = matchesRepoConfig(event, repoConfig);
    const stableKey = this.dedupe.buildStableKey(event);

    if (event.deliveryId && this.dedupe.isDuplicate(event.deliveryId)) return null;
    if (this.dedupe.isDuplicateByStableKey(stableKey)) return null;

    this.dedupe.record(event.deliveryId || undefined, stableKey);

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

    if (matches) {
      const payload = createNotificationPayload(event);
      const routes = repoConfig.routes ?? [{ sink: 'console' as const }];
      await this.dispatchNotification(payload, routes);
    }

    if (matches && repoConfig.auto_claim?.enabled && this.autoClaimFn) {
      const agentIds = repoConfig.auto_claim.agent_ids ?? [];
      if (agentIds.length > 0) {
        try {
          await this.autoClaimFn(event, agentIds);
        } catch (err) {
          console.error(
            `[Auto-Claim] Error for ${event.owner}/${event.repo}#${event.issueNumber}: ${(err as Error).message}`,
          );
        }
      }
    }

    return collabEvent;
  }

  async observeRepositoryEvent(
    event: Exclude<RepositoryEvent, { kind: 'issue' | 'push' }>,
    repoConfig: GitHubWatchConfig['repositories'][number],
  ): Promise<boolean> {
    const stableKey = repositoryEventStableKey(event);
    if (event.deliveryId && this.dedupe.isDuplicate(event.deliveryId)) return false;
    if (this.dedupe.isDuplicateByStableKey(stableKey)) return false;

    // P3-PR2 replaces this check-then-record compatibility store with an atomic,
    // lease-backed delivery queue. PR1 keeps the old delivery semantics while
    // establishing the event and projection contracts.
    this.dedupe.record(event.deliveryId || undefined, stableKey);
    const payload = createNotificationPayload(event);
    await this.dispatchNotification(payload, repoConfig.routes ?? [{ sink: 'console' as const }]);
    return true;
  }

  private async dispatchNotification(
    payload: NotificationPayload,
    routes: GitHubWatchRoute[],
  ): Promise<void> {
    for (const route of routes) {
      const sink = this.sinks.get(route.sink);
      if (!sink) {
        console.warn(`No sink configured for: ${route.sink}`);
        recordNotificationEvent(
          this.recordEventFn,
          false,
          route,
          payload,
          `No sink configured: ${route.sink}`,
        );
        continue;
      }
      try {
        const result = await sink.send(payload, route);
        recordNotificationEvent(this.recordEventFn, result.ok, route, payload, result.error);
      } catch (error) {
        recordNotificationEvent(
          this.recordEventFn,
          false,
          route,
          payload,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async pollAll(): Promise<{ reposPolled: number; eventsDispatched: number; errors: string[] }> {
    const result = { reposPolled: 0, eventsDispatched: 0, errors: [] as string[] };

    const client = await getClient();
    if (client.isDryRun) {
      result.errors.push('Dry-run mode: no GitHub credentials. Cannot poll.');
      return result;
    }

    for (const repoConfig of this.config.repositories) {
      const repoKey = `${repoConfig.owner}/${repoConfig.repo}`;
      result.reposPolled++;

      const cursor = this.cursorStore.getCursor(repoKey);
      const since = cursor?.lastSeenAt ?? new Date(Date.now() - 5 * 60_000).toISOString();

      const pollResult = await pollRepoIssues(
        client.octokit,
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
        const eventKey = `issues.${normalized.action}`;
        if (!repoConfig.events.includes(eventKey)) continue;
        const event = await this.once(normalized, 'github.watch.poll');
        if (event) result.eventsDispatched++;
      }

      this.cursorStore.updateCursor(repoKey, pollResult.newCursor);
    }

    return result;
  }

  async startPolling(intervalSeconds: number = 300): Promise<void> {
    const firstResult = await this.pollAll();
    console.log(
      `[Poll] Initial poll complete: ${firstResult.reposPolled} repos, ${firstResult.eventsDispatched} events`,
    );

    this.pollTimer = setInterval(async () => {
      try {
        const pollResult = await this.pollAll();
        if (pollResult.eventsDispatched > 0 || pollResult.errors.length > 0) {
          console.log(
            `[Poll] ${pollResult.reposPolled} repos, ${pollResult.eventsDispatched} events${pollResult.errors.length > 0 ? `, ${pollResult.errors.length} errors` : ''}`,
          );
        }
      } catch (err) {
        console.error(`[Poll] Error: ${(err as Error).message}`);
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

      const result = await this.once(normalized);
      if (result) {
        jsonResponse(res, 200, { ok: true, event_id: result.id });
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

      const result = await this.handlePushEvent(normalized);
      if (result) {
        jsonResponse(res, 200, { ok: true, event_id: result.id });
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
    event: import('./push-normalizer.js').NormalizedPushEvent,
  ): Promise<CollaborationEventRecord | null> {
    const stableKey = this.dedupe.buildPushStableKey(event);

    if (event.deliveryId && this.dedupe.isDuplicate(event.deliveryId)) return null;
    if (this.dedupe.isDuplicateByStableKey(stableKey)) return null;

    this.dedupe.record(event.deliveryId || undefined, stableKey);

    const hasPostChanges = event.commits.length > 0;

    // Load profile-sync config to determine mode
    let psConfig: import('./profile-sync-config.js').ProfileSyncConfig | null = null;
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
            id: `${event.owner}/${event.repo}@${event.after.substring(0, 7)}`,
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
      return collabEvent;
    }

    // Mode: manual — record triggered event only (already done above)
    if (psConfig.mode === 'manual') {
      return collabEvent;
    }

    // Mode: watch — record triggered + console notification
    if (psConfig.mode === 'watch') {
      console.log(
        `[Profile Sync Watch] Push to ${pushRepo} detected ${event.commits.length} post change(s). Run 'openslack collaboration workflow profile-sync run' to create PR.`,
      );
      return collabEvent;
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
          return collabEvent;
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

    return collabEvent;
  }
}
