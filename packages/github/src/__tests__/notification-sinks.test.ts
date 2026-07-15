import { describe, it, expect, vi } from 'vitest';
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

describe('ConsoleSink', () => {
  it('logs notification and returns ok', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sink = new ConsoleSink();
    const result = await sink.send(testPayload, consoleRoute);
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
    const result = await sink.send(testPayload, slackRoute);

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
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.channel).toBe('#test');
    expect(body.text).toContain('Negentropy-Laby/OpenSlack#42');
    vi.restoreAllMocks();
  });

  it('returns error on non-2xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    vi.stubGlobal('fetch', mockFetch);

    const sink = new SlackSink('xoxb-test-token');
    const result = await sink.send(testPayload, slackRoute);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('500');
    vi.restoreAllMocks();
  });

  it('returns error when Slack API returns ok: false', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: 'channel_not_found' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const sink = new SlackSink('xoxb-test-token');
    const result = await sink.send(testPayload, slackRoute);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('channel_not_found');
    vi.restoreAllMocks();
  });

  it('returns error on network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const sink = new SlackSink('xoxb-test-token');
    const result = await sink.send(testPayload, slackRoute);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    vi.restoreAllMocks();
  });

  it('returns error when route has no channel', async () => {
    const sink = new SlackSink('xoxb-test-token');
    const result = await sink.send(testPayload, { sink: 'slack' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('channel');
  });
});

describe('WebhookSink', () => {
  it('POSTs JSON to configured URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const sink = new WebhookSink('https://example.com/hook');
    const result = await sink.send(testPayload, webhookRoute);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenSlack-Notification': 'v1',
        },
      }),
    );
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    expect(body.repo).toBe('Negentropy-Laby/OpenSlack');
    expect(body.issueNumber).toBe(42);
    vi.restoreAllMocks();
  });

  it('returns error on non-2xx response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 502 });
    vi.stubGlobal('fetch', mockFetch);

    const sink = new WebhookSink('https://example.com/hook');
    const result = await sink.send(testPayload, webhookRoute);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('502');
    vi.restoreAllMocks();
  });

  it('returns error on network failure', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('timeout'));
    vi.stubGlobal('fetch', mockFetch);

    const sink = new WebhookSink('https://example.com/hook');
    const result = await sink.send(testPayload, webhookRoute);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timeout');
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
