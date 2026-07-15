import type { GitHubWatchRoute } from './watch-config.js';
import { formatNotification, type NotificationPayload } from './notification-payload.js';

export interface SinkResult {
  ok: boolean;
  error?: string;
}

export interface NotificationSink {
  readonly name: string;
  send(payload: NotificationPayload, route: GitHubWatchRoute): Promise<SinkResult>;
}

export class ConsoleSink implements NotificationSink {
  readonly name = 'console';

  async send(payload: NotificationPayload, _route: GitHubWatchRoute): Promise<SinkResult> {
    console.log(formatNotification(payload));
    return { ok: true };
  }
}

export class SlackSink implements NotificationSink {
  readonly name = 'slack';
  private botToken: string;

  constructor(botToken: string) {
    this.botToken = botToken;
  }

  async send(payload: NotificationPayload, route: GitHubWatchRoute): Promise<SinkResult> {
    const channel = route.channel;
    if (!channel) {
      return { ok: false, error: 'Slack route missing channel' };
    }
    const text = formatNotification(payload);
    try {
      const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel, text }),
      });
      if (!resp.ok) {
        return { ok: false, error: `Slack API HTTP ${resp.status}` };
      }
      const data = (await resp.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        return { ok: false, error: `Slack API error: ${data.error ?? 'unknown'}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Slack send failed: ${(err as Error).message}` };
    }
  }
}

export class WebhookSink implements NotificationSink {
  readonly name = 'webhook';
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async send(payload: NotificationPayload, _route: GitHubWatchRoute): Promise<SinkResult> {
    try {
      const resp = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenSlack-Notification': 'v1',
        },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        return { ok: false, error: `Webhook HTTP ${resp.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `Webhook send failed: ${(err as Error).message}` };
    }
  }
}

export function createSinks(options: {
  slackBotToken?: string;
  webhookUrl?: string;
}): Map<string, NotificationSink> {
  const sinks = new Map<string, NotificationSink>();
  sinks.set('console', new ConsoleSink());
  if (options.slackBotToken) {
    sinks.set('slack', new SlackSink(options.slackBotToken));
  }
  if (options.webhookUrl) {
    sinks.set('webhook', new WebhookSink(options.webhookUrl));
  }
  return sinks;
}
