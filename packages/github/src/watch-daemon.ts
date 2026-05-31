import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { GitHubWatchConfig, GitHubWatchRoute } from './watch-config.js';
import { verifyGitHubWebhookSignature } from './webhook-verify.js';
import { normalizeIssueEvent, matchesRepoConfig, type NormalizedIssueEvent } from './issue-normalizer.js';
import { WatchDedupeStore } from './watch-dedupe.js';
import { createSinks, type NotificationSink } from './notification-sinks.js';
import { WatchCursorStore, type RepoCursor } from './watch-cursor.js';
import { pollRepoIssues } from './watch-poller.js';
import { normalizePollIssue } from './poll-normalizer.js';
import { getClient } from './client.js';

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

export interface NotificationPayload {
  type: string;
  repo: string;
  issueNumber: number;
  title: string;
  url: string;
  labels: string[];
  nextAction: string;
}

export type AutoClaimFn = (
  event: NormalizedIssueEvent,
  agentIds: string[],
) => Promise<void>;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: string | Buffer) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function createNotificationPayload(event: NormalizedIssueEvent): NotificationPayload {
  return {
    type: 'openslack.issue.detected',
    repo: `${event.owner}/${event.repo}`,
    issueNumber: event.issueNumber,
    title: event.title,
    url: event.url,
    labels: event.labels,
    nextAction: `openslack agent tick --agent-id <id> --source github-issues`,
  };
}

export function formatConsoleNotification(payload: NotificationPayload): string {
  const lines: string[] = [
    `[GitHub Watch] New issue detected`,
    `  ${payload.repo}#${payload.issueNumber}: ${payload.title}`,
    `  ${payload.url}`,
    `  Labels: ${payload.labels.join(', ') || '(none)'}`,
    `  Next: ${payload.nextAction}`,
  ];
  return lines.join('\n');
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
    recordFn({
      type: success ? 'notification.sent' : 'notification.failed',
      actor: { id: 'github-watch', kind: 'github', provider: 'github' },
      object: { kind: 'issue', id: `${payload.repo}#${payload.issueNumber}`, url: payload.url },
      source: { kind: 'github', ref: 'github.watch.notification' },
      summary: success
        ? `Notification sent via ${route.sink} for ${payload.repo}#${payload.issueNumber}`
        : `Notification failed via ${route.sink} for ${payload.repo}#${payload.issueNumber}: ${error ?? 'unknown'}`,
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      metadata: { sink: route.sink, channel: route.channel, error },
    });
  } catch {
    // best-effort event recording
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
  private server: Server | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: GitHubWatchConfig,
    secret: string,
    dedupe?: WatchDedupeStore,
    sinkOptions?: { slackBotToken?: string; webhookUrl?: string },
    autoClaimFn?: AutoClaimFn,
    recordEventFn?: RecordEventFn,
  ) {
    this.config = config;
    this.secret = secret;
    this.dedupe = dedupe ?? new WatchDedupeStore();
    this.sinks = createSinks(sinkOptions ?? {});
    this.cursorStore = new WatchCursorStore();
    this.autoClaimFn = autoClaimFn ?? null;
    this.recordEventFn = recordEventFn ?? null;
  }

  async start(port: number): Promise<void> {
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
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  async once(event: NormalizedIssueEvent, sourceRef: string = 'github.watch.webhook'): Promise<CollaborationEventRecord | null> {
    const repoConfig = this.config.repositories.find(
      (r) => r.owner === event.owner && r.repo === event.repo,
    );
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
          object: { kind: 'issue', id: `${event.owner}/${event.repo}#${event.issueNumber}`, url: event.url },
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
      for (const route of routes) {
        const sink = this.sinks.get(route.sink);
        if (!sink) {
          console.warn(`No sink configured for: ${route.sink}`);
          recordNotificationEvent(this.recordEventFn, false, route, payload, `No sink configured: ${route.sink}`);
          continue;
        }
        try {
          const result = await sink.send(payload, route);
          recordNotificationEvent(this.recordEventFn, result.ok, route, payload, result.error);
        } catch (err) {
          recordNotificationEvent(this.recordEventFn, false, route, payload, (err as Error).message);
        }
      }
    }

    if (matches && repoConfig.auto_claim?.enabled && this.autoClaimFn) {
      const agentIds = repoConfig.auto_claim.agent_ids ?? [];
      if (agentIds.length > 0) {
        try {
          await this.autoClaimFn(event, agentIds);
        } catch (err) {
          console.error(`[Auto-Claim] Error for ${event.owner}/${event.repo}#${event.issueNumber}: ${(err as Error).message}`);
        }
      }
    }

    return collabEvent;
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
      const since = cursor?.lastSeenAt
        ?? new Date(Date.now() - 5 * 60_000).toISOString();

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
    console.log(`[Poll] Initial poll complete: ${firstResult.reposPolled} repos, ${firstResult.eventsDispatched} events`);

    this.pollTimer = setInterval(async () => {
      try {
        const pollResult = await this.pollAll();
        if (pollResult.eventsDispatched > 0 || pollResult.errors.length > 0) {
          console.log(`[Poll] ${pollResult.reposPolled} repos, ${pollResult.eventsDispatched} events${pollResult.errors.length > 0 ? `, ${pollResult.errors.length} errors` : ''}`);
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

    const body = await readBody(req);
    const headers: Record<string, string | undefined> = {};
    for (const key of Object.keys(req.headers)) {
      headers[key] = req.headers[key] as string | undefined;
    }

    const signature = headers['x-hub-signature-256'];
    if (!verifyGitHubWebhookSignature(body, signature, this.secret)) {
      jsonResponse(res, 401, { error: 'Invalid signature' });
      return;
    }

    const gitHubEvent = headers['x-github-event'];
    if (gitHubEvent !== 'issues' && gitHubEvent !== 'push') {
      jsonResponse(res, 202, { ok: true, ignored: `event type: ${gitHubEvent}` });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      jsonResponse(res, 400, { error: 'Invalid JSON' });
      return;
    }

    if (gitHubEvent === 'issues') {
      const normalized = normalizeIssueEvent(payload, headers);
      if (!normalized) {
        jsonResponse(res, 400, { error: 'Could not normalize issue event' });
        return;
      }

      const repoConfig = this.config.repositories.find(
        (r) => r.owner === normalized.owner && r.repo === normalized.repo,
      );
      if (!repoConfig) {
        jsonResponse(res, 202, { ok: true, ignored: `repo not in allowlist: ${normalized.owner}/${normalized.repo}` });
        return;
      }

      const eventKey = `issues.${normalized.action}`;
      if (!repoConfig.events.includes(eventKey)) {
        jsonResponse(res, 202, { ok: true, ignored: `action ${normalized.action} not watched for ${normalized.owner}/${normalized.repo}` });
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
      const { normalizePushEvent, matchesPushRepoConfig } = await import('./push-normalizer.js');
      const normalized = normalizePushEvent(payload, headers);
      if (!normalized) {
        jsonResponse(res, 202, { ok: true, ignored: 'no relevant commits' });
        return;
      }

      const repoConfig = this.config.repositories.find(
        (r) => r.owner === normalized.owner && r.repo === normalized.repo,
      );
      if (!repoConfig) {
        jsonResponse(res, 202, { ok: true, ignored: `repo not in allowlist: ${normalized.owner}/${normalized.repo}` });
        return;
      }

      if (!repoConfig.events.includes('push')) {
        jsonResponse(res, 202, { ok: true, ignored: `push not watched for ${normalized.owner}/${normalized.repo}` });
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
  }

  async handlePushEvent(event: import('./push-normalizer.js').NormalizedPushEvent): Promise<CollaborationEventRecord | null> {
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
          object: { kind: 'push', id: `${event.owner}/${event.repo}@${event.after.substring(0, 7)}` },
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
      console.log(`[Profile Sync Watch] Push to ${pushRepo} detected ${event.commits.length} post change(s). Run 'openslack collaboration workflow profile-sync run' to create PR.`);
      return collabEvent;
    }

    // Mode: auto-pr — enqueue job for worker
    if (psConfig.mode === 'auto-pr') {
      try {
        const { enqueueProfileSyncJob, isDuplicate: isJobDuplicate, recordDedupe } = await import('./profile-sync-queue.js');

        const dedupeKey = `${event.deliveryId}:${psConfig.source.repo}:${event.after}:${psConfig.target.repo}:${psConfig.target.marker}`;

        if (isJobDuplicate(dedupeKey)) {
          console.log(`[Profile Sync Auto-PR] Duplicate delivery ${event.deliveryId}, skipping.`);
          return collabEvent;
        }

        recordDedupe(dedupeKey);

        const job = enqueueProfileSyncJob({
          deliveryId: event.deliveryId || `${event.owner}/${event.repo}@${event.after}`,
          sourceRepo: psConfig.source.repo,
          sourceSha: event.after,
          targetRepo: psConfig.target.repo,
          marker: psConfig.target.marker,
          config: psConfig,
        });

        if (job && this.recordEventFn) {
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
