import { describe, it, expect, vi } from 'vitest';
import {
  materializeSlackNotificationBody,
  materializeWebhookNotificationBody,
} from '../notification-body.js';
import { ConsoleSink, SlackSink, WebhookSink, createSinks } from '../notification-sinks.js';
import type { NotificationPayload } from '../watch-daemon.js';
import type { GitHubWatchRoute } from '../watch-config.js';

const testPayload: NotificationPayload = {
  schema: 'openslack.github_watch_notification.v1',
  type: 'openslack.issue.detected',
  objectKind: 'issue',
  eventKey: 'issues.opened',
  eventStableKey: 'github:issues.opened:negentropy-laby/openslack:issue:42:2026-05-25T10:00:00Z',
  repo: 'Negentropy-Laby/OpenSlack',
  objectId: 'negentropy-laby/openslack#42',
  issueNumber: 42,
  title: 'Fix failing setup',
  url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/42',
  labels: ['openslack:task'],
  nextAction: 'openslack agent tick --agent-id test',
  informational: false,
  observedAt: '2026-05-25T10:00:00Z',
};

const consoleRoute: GitHubWatchRoute = { sink: 'console' };
const slackRoute: GitHubWatchRoute = { sink: 'slack', channel: '#test' };
const webhookRoute: GitHubWatchRoute = { sink: 'webhook' };
const deliveryContext = {
  idempotencyKey: 'openslack-watch-v1:test-idempotency-key',
  attempt: 2,
};

describe('ConsoleSink', () => {
  it('logs notification and returns ok', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sink = new ConsoleSink();
    const result = await sink.send(testPayload, consoleRoute, deliveryContext);
    expect(result.ok).toBe(true);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('GitHub Watch');
    expect(output).toContain('Negentropy-Laby/OpenSlack#42');
    logSpy.mockRestore();
  });
});

describe('SlackSink', () => {
  it('POSTs to Slack API with correct headers and body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const sink = new SlackSink('xoxb-test-token');
    const result = await sink.send(testPayload, slackRoute, deliveryContext);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer xoxb-test-token',
          'Content-Type': 'application/json',
        },
      }),
    );
    const requestBody = requestBodyBytes((mockFetch.mock.calls[0][1] as RequestInit).body);
    const expectedBody = materializeSlackNotificationBody(
      testPayload,
      '#test',
      deliveryContext.idempotencyKey,
    );
    expect(requestBody.equals(Buffer.from(expectedBody.bytes))).toBe(true);
    const body = JSON.parse(requestBody.toString('utf8')) as Record<string, unknown>;
    expect(body.channel).toBe('#test');
    expect(body.text).toContain('Negentropy-Laby/OpenSlack#42');
    expect(body.client_msg_id).toBe(deliveryContext.idempotencyKey);
    vi.restoreAllMocks();
  });

  it('preserves direct delivery behavior above the future handoff body limit', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);
    const oversizedPayload = { ...testPayload, title: 'x'.repeat(262_145) };

    const result = await new SlackSink('xoxb-test-token').send(
      oversizedPayload,
      slackRoute,
      deliveryContext,
    );

    expect(result.ok).toBe(true);
    expect(
      requestBodyBytes((mockFetch.mock.calls[0][1] as RequestInit).body).byteLength,
    ).toBeGreaterThan(262_144);
    vi.restoreAllMocks();
  });

  it('returns error on non-2xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    vi.stubGlobal('fetch', mockFetch);

    const sink = new SlackSink('xoxb-test-token');
    const result = await sink.send(testPayload, slackRoute, deliveryContext);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      outcome: 'retryable',
      code: 'SLACK_HTTP_ERROR_500',
    });
    vi.restoreAllMocks();
  });

  it('returns error when Slack API returns ok: false', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const sink = new SlackSink('xoxb-test-token');
    const result = await sink.send(testPayload, slackRoute, deliveryContext);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('channel_not_found');
    vi.restoreAllMocks();
  });

  it('returns error on network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const sink = new SlackSink('xoxb-test-token');
    const result = await sink.send(testPayload, slackRoute, deliveryContext);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      outcome: 'retryable',
      code: 'SLACK_NETWORK_ERROR',
    });
    vi.restoreAllMocks();
  });

  it('returns error when route has no channel', async () => {
    const sink = new SlackSink('xoxb-test-token');
    const result = await sink.send(testPayload, { sink: 'slack' }, deliveryContext);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('channel');
  });
});

describe('WebhookSink', () => {
  it('POSTs JSON to configured URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const sink = new WebhookSink('https://example.com/hook');
    const result = await sink.send(testPayload, webhookRoute, deliveryContext);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': deliveryContext.idempotencyKey,
          'X-OpenSlack-Idempotency-Key': deliveryContext.idempotencyKey,
          'X-OpenSlack-Notification': 'v1',
        },
      }),
    );
    const requestBody = requestBodyBytes((mockFetch.mock.calls[0][1] as RequestInit).body);
    const expectedBody = materializeWebhookNotificationBody(testPayload);
    expect(requestBody.equals(Buffer.from(expectedBody.bytes))).toBe(true);
    const body = JSON.parse(requestBody.toString('utf8')) as Record<string, unknown>;
    expect(body.repo).toBe('Negentropy-Laby/OpenSlack');
    expect(body.issueNumber).toBe(42);
    vi.restoreAllMocks();
  });

  it('preserves direct delivery behavior above the future handoff body limit', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);
    const oversizedPayload = { ...testPayload, title: 'x'.repeat(262_145) };

    const result = await new WebhookSink('https://example.com/hook').send(
      oversizedPayload,
      webhookRoute,
      deliveryContext,
    );

    expect(result.ok).toBe(true);
    expect(
      requestBodyBytes((mockFetch.mock.calls[0][1] as RequestInit).body).byteLength,
    ).toBeGreaterThan(262_144);
    vi.restoreAllMocks();
  });

  it('returns error on non-2xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    vi.stubGlobal('fetch', mockFetch);

    const sink = new WebhookSink('https://example.com/hook');
    const result = await sink.send(testPayload, webhookRoute, deliveryContext);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      outcome: 'retryable',
      code: 'WEBHOOK_HTTP_ERROR_502',
    });
    vi.restoreAllMocks();
  });

  it('returns error on network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('timeout'));
    vi.stubGlobal('fetch', mockFetch);

    const sink = new WebhookSink('https://example.com/hook');
    const result = await sink.send(testPayload, webhookRoute, deliveryContext);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      outcome: 'retryable',
      code: 'WEBHOOK_NETWORK_ERROR',
    });
    vi.restoreAllMocks();
  });
});

describe('createSinks', () => {
  it('returns console sink always', () => {
    const sinks = createSinks({});
    expect(sinks.has('console')).toBe(true);
    expect(sinks.has('slack')).toBe(false);
    expect(sinks.has('webhook')).toBe(false);
  });

  it('includes slack sink when botToken provided', () => {
    const sinks = createSinks({ slackBotToken: 'xoxb-test' });
    expect(sinks.has('console')).toBe(true);
    expect(sinks.has('slack')).toBe(true);
    expect(sinks.has('webhook')).toBe(false);
  });

  it('includes webhook sink when url provided', () => {
    const sinks = createSinks({ webhookUrl: 'https://example.com/hook' });
    expect(sinks.has('console')).toBe(true);
    expect(sinks.has('webhook')).toBe(true);
    expect(sinks.has('slack')).toBe(false);
  });

  it('includes all sinks when all options provided', () => {
    const sinks = createSinks({
      slackBotToken: 'xoxb-test',
      webhookUrl: 'https://example.com/hook',
    });
    expect(sinks.has('console')).toBe(true);
    expect(sinks.has('slack')).toBe(true);
    expect(sinks.has('webhook')).toBe(true);
  });
});

function requestBodyBytes(body: RequestInit['body']): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new TypeError('Expected an in-memory request body');
}
