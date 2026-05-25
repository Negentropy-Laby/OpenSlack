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
import { recordEvent } from '@openslack/collaboration';
import type { CollaborationEvent } from '@openslack/collaboration';

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
  success: boolean,
  route: GitHubWatchRoute,
  payload: NotificationPayload,
  error?: string,
): void {
  try {
    recordEvent({
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
  private server: Server | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: GitHubWatchConfig,
    secret: string,
    dedupe?: WatchDedupeStore,
    sinkOptions?: { slackBotToken?: string; webhookUrl?: string },
    autoClaimFn?: AutoClaimFn,
  ) {
    this.config = config;
    this.secret = secret;
    this.dedupe = dedupe ?? new WatchDedupeStore();
    this.sinks = createSinks(sinkOptions ?? {});
    this.cursorStore = new WatchCursorStore();
    this.autoClaimFn = autoClaimFn ?? null;
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

  async once(event: NormalizedIssueEvent, sourceRef: string = 'github.watch.webhook'): Promise<CollaborationEvent | null> {
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

    let collabEvent: CollaborationEvent | null = null;
    try {
      collabEvent = recordEvent({
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
          recordNotificationEvent(false, route, payload, `No sink configured: ${route.sink}`);
          continue;
        }
        try {
          const result = await sink.send(payload, route);
          recordNotificationEvent(result.ok, route, payload, result.error);
        } catch (err) {
          recordNotificationEvent(false, route, payload, (err as Error).message);
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
    if (gitHubEvent !== 'issues') {
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
  }
}
