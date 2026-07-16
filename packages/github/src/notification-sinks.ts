import type { GitHubWatchRoute } from './watch-config.js';
import { formatNotification, type NotificationPayload } from './notification-payload.js';

export type SinkResult =
  | {
      ok: true;
      outcome: 'delivered';
      code?: undefined;
      error?: undefined;
      retryAfterMs?: undefined;
    }
  | {
      ok: false;
      outcome: 'retryable' | 'permanent_failure';
      code: string;
      error: string;
      retryAfterMs?: number;
    };

export interface NotificationDeliveryContext {
  idempotencyKey: string;
  attempt: number;
  signal?: AbortSignal;
}

export interface NotificationSink {
  readonly name: string;
  send(
    payload: NotificationPayload,
    route: GitHubWatchRoute,
    context?: NotificationDeliveryContext,
  ): Promise<SinkResult>;
}

export class ConsoleSink implements NotificationSink {
  readonly name = 'console';

  async send(
    payload: NotificationPayload,
    _route: GitHubWatchRoute,
    context: NotificationDeliveryContext = fallbackContext(payload),
  ): Promise<SinkResult> {
    console.log(`${formatNotification(payload)}\nDelivery: ${context.idempotencyKey}`);
    return { ok: true, outcome: 'delivered' };
  }
}

export class SlackSink implements NotificationSink {
  readonly name = 'slack';
  private botToken: string;

  constructor(botToken: string) {
    this.botToken = botToken;
  }

  async send(
    payload: NotificationPayload,
    route: GitHubWatchRoute,
    context: NotificationDeliveryContext = fallbackContext(payload),
  ): Promise<SinkResult> {
    const channel = route.channel;
    if (!channel) {
      return permanentFailure('SLACK_CHANNEL_MISSING', 'Slack route missing channel.');
    }
    const text = formatNotification(payload);
    try {
      const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel,
          text,
          client_msg_id: context.idempotencyKey,
        }),
        signal: context.signal,
      });
      if (!resp.ok) {
        return httpFailure('SLACK_HTTP_ERROR', 'Slack API', resp);
      }
      const data = (await resp.json()) as { ok?: boolean; error?: string };
      if (!data.ok) {
        const code = normalizeFailureCode(data.error, 'SLACK_API_ERROR');
        return SLACK_RETRYABLE_ERRORS.has(data.error ?? '')
          ? retryableFailure(code, `Slack API error: ${data.error ?? 'unknown'}.`)
          : permanentFailure(code, `Slack API error: ${data.error ?? 'unknown'}.`);
      }
      return { ok: true, outcome: 'delivered' };
    } catch {
      return retryableFailure('SLACK_NETWORK_ERROR', 'Slack delivery failed safely.');
    }
  }
}

export class WebhookSink implements NotificationSink {
  readonly name = 'webhook';
  private url: string;

  constructor(url: string) {
    this.url = url;
  }

  async send(
    payload: NotificationPayload,
    _route: GitHubWatchRoute,
    context: NotificationDeliveryContext = fallbackContext(payload),
  ): Promise<SinkResult> {
    try {
      const resp = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenSlack-Notification': 'v1',
          'Idempotency-Key': context.idempotencyKey,
          'X-OpenSlack-Idempotency-Key': context.idempotencyKey,
        },
        body: JSON.stringify(payload),
        signal: context.signal,
      });
      if (!resp.ok) {
        return httpFailure('WEBHOOK_HTTP_ERROR', 'Webhook', resp);
      }
      return { ok: true, outcome: 'delivered' };
    } catch {
      return retryableFailure('WEBHOOK_NETWORK_ERROR', 'Webhook delivery failed safely.');
    }
  }
}

const SLACK_RETRYABLE_ERRORS = new Set([
  'fatal_error',
  'internal_error',
  'ratelimited',
  'request_timeout',
  'service_unavailable',
]);

function httpFailure(prefix: string, service: string, response: Response): SinkResult {
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  const retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after') ?? null);
  const code = `${prefix}_${response.status}`;
  return retryable
    ? retryableFailure(code, `${service} delivery returned HTTP ${response.status}.`, retryAfterMs)
    : permanentFailure(code, `${service} delivery returned HTTP ${response.status}.`);
}

function retryableFailure(code: string, error: string, retryAfterMs?: number): SinkResult {
  return {
    ok: false,
    outcome: 'retryable',
    code,
    error,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function permanentFailure(code: string, error: string): SinkResult {
  return {
    ok: false,
    outcome: 'permanent_failure',
    code,
    error,
  };
}

function normalizeFailureCode(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const code = value.toLocaleUpperCase('en-US').replace(/[^A-Z0-9]+/gu, '_');
  return code ? `SLACK_${code}`.slice(0, 80) : fallback;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
}

function fallbackContext(payload: NotificationPayload): NotificationDeliveryContext {
  return {
    idempotencyKey: payload.eventStableKey,
    attempt: 1,
  };
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
