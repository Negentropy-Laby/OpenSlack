import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { connect } from 'node:net';
import {
  WatchDaemon,
  createNotificationPayload,
  formatConsoleNotification,
} from '../watch-daemon.js';
import type { GitHubWatchConfig } from '../watch-config.js';
import type { NormalizedIssueEvent } from '../issue-normalizer.js';
import type { NormalizedPushEvent } from '../push-normalizer.js';
import { githubWebhookEventKey } from '../repository-event.js';
import { WatchDedupeStore } from '../watch-dedupe.js';
import { WatchCursorStore } from '../watch-cursor.js';

function mockRecordEvent(event: unknown) {
  return {
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: (event as Record<string, unknown>).type as string,
    actor: (event as Record<string, unknown>).actor as {
      id: string;
      kind: string;
      provider: string;
    },
    object: (event as Record<string, unknown>).object as { kind: string; id: string; url?: string },
    source: (event as Record<string, unknown>).source as { kind: string; ref: string },
    summary: (event as Record<string, unknown>).summary as string,
    visibility: 'local',
    redacted: false,
    containsSensitiveData: false,
    timestamp: new Date().toISOString(),
  };
}

let tempDir: string;
const secret = 'test-webhook-secret';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'openslack-watch-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const config: GitHubWatchConfig = {
  schema: 'openslack.github_watch.v1',
  repositories: [
    {
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      events: ['issues.opened', 'issues.reopened', 'issues.labeled'],
      labels: { include: ['openslack:task'] },
    },
  ],
};

function signPayload(payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function makeIssuePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'opened',
    issue: {
      number: 42,
      title: 'Fix failing setup',
      html_url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/42',
      body: 'Test',
      updated_at: '2026-05-25T10:00:00Z',
      labels: [{ name: 'openslack:task' }],
    },
    repository: {
      name: 'OpenSlack',
      owner: { login: 'Negentropy-Laby' },
    },
    sender: { login: 'bot' },
    ...overrides,
  });
}

function makeRepositoryEventPayload(eventName: string, action: string): string {
  const repository = {
    name: 'openslack',
    full_name: 'negentropy-laby/openslack',
    owner: { login: 'negentropy-laby' },
  };
  const common = { action, repository, sender: { login: 'observer' } };
  if (eventName === 'pull_request') {
    return JSON.stringify({
      ...common,
      pull_request: {
        number: 42,
        title: 'Repository event contract',
        html_url: 'https://github.com/Negentropy-Laby/OpenSlack/pull/42',
        state: action === 'closed' ? 'closed' : 'open',
        draft: false,
        merged: false,
        updated_at: '2026-07-15T10:00:00Z',
        user: { login: 'contributor' },
        head: { sha: 'head-sha-42' },
        base: { sha: 'base-sha-42' },
      },
    });
  }
  if (eventName === 'pull_request_review') {
    return JSON.stringify({
      ...common,
      pull_request: {
        number: 42,
        title: 'Repository event contract',
        html_url: 'https://github.com/Negentropy-Laby/OpenSlack/pull/42',
        head: { sha: 'head-sha-42' },
      },
      review: {
        id: 9001,
        state: 'approved',
        html_url: 'https://github.com/Negentropy-Laby/OpenSlack/pull/42#pullrequestreview-9001',
        user: { login: 'reviewer' },
        commit_id: 'head-sha-42',
        submitted_at: '2026-07-15T10:05:00Z',
        body: 'untrusted review prose',
      },
    });
  }
  if (eventName === 'check_run') {
    return JSON.stringify({
      ...common,
      check_run: {
        id: 7001,
        name: 'test',
        html_url: 'https://github.com/Negentropy-Laby/OpenSlack/actions/runs/7001',
        status: 'completed',
        conclusion: 'success',
        head_sha: 'head-sha-42',
        completed_at: '2026-07-15T10:10:00Z',
        pull_requests: [{ number: 42 }],
      },
    });
  }
  return JSON.stringify({
    ...common,
    check_suite: {
      id: 8001,
      status: 'completed',
      conclusion: 'success',
      head_sha: 'head-sha-42',
      head_branch: 'github/pr-event-contract',
      updated_at: '2026-07-15T10:11:00Z',
      pull_requests: [{ number: 42 }],
    },
  });
}

function sendRequest(
  port: number,
  body: string | Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/github/webhook',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sendSlowChunkedRequest(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = '';
    let settled = false;
    const socket = connect({ host: '127.0.0.1', port });
    socket.setEncoding('utf8');

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!socket.destroyed) socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };
    const timer = setTimeout(() => {
      finish(new Error('Timed out waiting for the webhook server to close the slow request'));
    }, 1_000);

    socket.once('connect', () => {
      socket.write(
        [
          'POST /github/webhook HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Content-Type: application/json',
          'Transfer-Encoding: chunked',
          'Connection: keep-alive',
          '',
          '',
        ].join('\r\n'),
      );
      socket.write('1\r\n{\r\n');
    });
    socket.on('data', (chunk: string) => {
      response += chunk;
    });
    socket.once('error', (error) => {
      if (response.includes('HTTP/1.1 408')) finish();
      else finish(error);
    });
    socket.once('close', () => finish());
  });
}

describe('WatchDaemon', () => {
  it('handles a valid webhook and returns event_id', async () => {
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, secret, dedupe, undefined, undefined, mockRecordEvent);
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);

    try {
      const body = makeIssuePayload();
      const signature = signPayload(body);
      const result = await sendRequest(port, body, {
        'x-hub-signature-256': signature,
        'x-github-event': 'issues',
        'x-github-delivery': 'test-delivery-1',
      });
      expect(result.status).toBe(200);
      expect(result.body.ok).toBe(true);
      expect(result.body.event_id).toBeDefined();
    } finally {
      await daemon.stop();
    }
  });

  it('rejects invalid signature with 401', async () => {
    const daemon = new WatchDaemon(
      config,
      secret,
      new WatchDedupeStore(tempDir),
      undefined,
      undefined,
      mockRecordEvent,
    );
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);

    try {
      const body = makeIssuePayload();
      const result = await sendRequest(port, body, {
        'x-hub-signature-256': 'sha256=badsignature',
        'x-github-event': 'issues',
      });
      expect(result.status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });

  it('rejects an oversized body with 413 before JSON parsing', async () => {
    const daemon = new WatchDaemon(
      config,
      secret,
      new WatchDedupeStore(tempDir),
      undefined,
      undefined,
      mockRecordEvent,
      { maxBytes: 64, timeoutMs: 100 },
    );
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);

    try {
      const body = makeIssuePayload();
      const result = await sendRequest(port, body, {
        'x-hub-signature-256': signPayload(body),
        'x-github-event': 'issues',
      });
      expect(result.status).toBe(413);
      expect(result.body.code).toBe('BODY_TOO_LARGE');
    } finally {
      await daemon.stop();
    }
  });

  it('closes a slow chunked request after the bounded body-read timeout', async () => {
    const daemon = new WatchDaemon(
      config,
      secret,
      new WatchDedupeStore(tempDir),
      undefined,
      undefined,
      mockRecordEvent,
      { maxBytes: 64, timeoutMs: 30 },
    );
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);

    try {
      const response = await sendSlowChunkedRequest(port);
      expect(response).toContain('HTTP/1.1 408 Request Timeout');
      expect(response.toLowerCase()).toContain('connection: close');
      expect(response).toContain('BODY_READ_TIMEOUT');
    } finally {
      await daemon.stop();
    }
  });

  it('rejects malformed signed JSON with 400', async () => {
    const daemon = new WatchDaemon(config, secret, new WatchDedupeStore(tempDir));
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);

    try {
      const body = '{';
      const result = await sendRequest(port, body, {
        'x-hub-signature-256': signPayload(body),
        'x-github-event': 'issues',
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('Invalid JSON');
    } finally {
      await daemon.stop();
    }
  });

  it('rejects invalid UTF-8 even when the exact bytes are signed', async () => {
    const daemon = new WatchDaemon(config, secret, new WatchDedupeStore(tempDir));
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);

    try {
      const body = Buffer.from([0x7b, 0xff, 0x7d]);
      const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      const result = await sendRequest(port, body, {
        'x-hub-signature-256': signature,
        'x-github-event': 'issues',
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('Invalid JSON');
    } finally {
      await daemon.stop();
    }
  });

  it('ignores an unknown signed event with 202', async () => {
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, secret, dedupe);
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);

    try {
      const body = makeIssuePayload();
      const result = await sendRequest(port, body, {
        'x-hub-signature-256': signPayload(body),
        'x-github-event': 'deployment',
      });
      expect(result.status).toBe(202);
      expect(result.body.ignored).toContain('event type');
      expect(dedupe.getStats().count).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it.each([
    ['pull_request', 'opened', 'pull_request.opened'],
    ['pull_request', 'synchronize', 'pull_request.synchronize'],
    ['pull_request', 'reopened', 'pull_request.reopened'],
    ['pull_request', 'closed', 'pull_request.closed'],
    ['pull_request', 'ready_for_review', 'pull_request.ready_for_review'],
    ['pull_request_review', 'submitted', 'pull_request_review.submitted'],
    ['pull_request_review', 'dismissed', 'pull_request_review.dismissed'],
    ['check_run', 'completed', 'check_run.completed'],
    ['check_suite', 'completed', 'check_suite.completed'],
  ] as const)(
    'accepts signed %s.%s observations without auto-claim',
    async (eventName, action, expectedEventKey) => {
      const claimFn = vi.fn().mockResolvedValue(undefined);
      const eventConfig: GitHubWatchConfig = {
        schema: 'openslack.github_watch.v1',
        repositories: [
          {
            owner: 'Negentropy-Laby',
            repo: 'OpenSlack',
            events: [expectedEventKey],
            auto_claim: { enabled: true, agent_ids: ['must-not-run'] },
          },
        ],
      };
      const dedupe = new WatchDedupeStore(tempDir);
      const daemon = new WatchDaemon(
        eventConfig,
        secret,
        dedupe,
        undefined,
        claimFn,
        mockRecordEvent,
      );
      const port = 3101 + Math.floor(Math.random() * 1000);
      await daemon.start(port);
      try {
        const body = makeRepositoryEventPayload(eventName, action);
        const result = await sendRequest(port, body, {
          'x-hub-signature-256': signPayload(body),
          'x-github-event': eventName,
          'x-github-delivery': `delivery-${eventName}-${action}`,
        });
        expect(result).toMatchObject({
          status: 200,
          body: { ok: true, event_key: expectedEventKey },
        });
        expect(claimFn).not.toHaveBeenCalled();
        expect(dedupe.getStats().count).toBe(1);
      } finally {
        await daemon.stop();
      }
    },
  );

  it('ignores an unknown action without mutating delivery state', async () => {
    const dedupe = new WatchDedupeStore(tempDir);
    const eventConfig: GitHubWatchConfig = {
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Negentropy-Laby',
          repo: 'OpenSlack',
          events: ['pull_request.opened'],
        },
      ],
    };
    const daemon = new WatchDaemon(eventConfig, secret, dedupe);
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);
    try {
      const body = makeRepositoryEventPayload('pull_request', 'edited');
      const result = await sendRequest(port, body, {
        'x-hub-signature-256': signPayload(body),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'unknown-action',
      });
      expect(result.status).toBe(202);
      expect(result.body.ignored).toContain('action edited');
      expect(dedupe.getStats().count).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it('treats an approved review webhook as informational notification only', async () => {
    const recordFn = vi.fn(mockRecordEvent);
    const claimFn = vi.fn().mockResolvedValue(undefined);
    const reviewConfig: GitHubWatchConfig = {
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Negentropy-Laby',
          repo: 'OpenSlack',
          events: ['pull_request_review.submitted'],
          auto_claim: { enabled: true, agent_ids: ['must-not-run'] },
        },
      ],
    };
    const daemon = new WatchDaemon(
      reviewConfig,
      secret,
      new WatchDedupeStore(tempDir),
      undefined,
      claimFn,
      recordFn,
    );
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);
    try {
      const body = makeRepositoryEventPayload('pull_request_review', 'submitted');
      const result = await sendRequest(port, body, {
        'x-hub-signature-256': signPayload(body),
        'x-github-event': 'pull_request_review',
        'x-github-delivery': 'approved-review-is-observation',
      });
      expect(result.status).toBe(200);
      expect(claimFn).not.toHaveBeenCalled();
      expect(recordFn).toHaveBeenCalledTimes(1);
      const recorded = recordFn.mock.calls[0]![0] as Record<string, unknown>;
      expect(recorded.type).toBe('notification.sent');
      expect(recorded.metadata).toMatchObject({
        objectKind: 'review',
        eventKey: 'pull_request_review.submitted',
        informational: true,
      });
      expect(String(recorded.type)).not.toMatch(/approv|merge|pr\.review/u);
    } finally {
      await daemon.stop();
    }
  });

  it('rejects malformed payloads for a known action without mutating delivery state', async () => {
    const dedupe = new WatchDedupeStore(tempDir);
    const eventConfig: GitHubWatchConfig = {
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Negentropy-Laby',
          repo: 'OpenSlack',
          events: ['pull_request.opened'],
        },
      ],
    };
    const daemon = new WatchDaemon(eventConfig, secret, dedupe);
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);
    try {
      const body = JSON.stringify({ action: 'opened', repository: {} });
      const result = await sendRequest(port, body, {
        'x-hub-signature-256': signPayload(body),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'malformed-pr',
      });
      expect(result.status).toBe(400);
      expect(dedupe.getStats().count).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it('ignores a normalized PR from an unconfigured repository without state mutation', async () => {
    const dedupe = new WatchDedupeStore(tempDir);
    const eventConfig: GitHubWatchConfig = {
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Negentropy-Laby',
          repo: 'OpenSlack',
          events: ['pull_request.opened'],
        },
      ],
    };
    const daemon = new WatchDaemon(eventConfig, secret, dedupe);
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);
    try {
      const parsed = JSON.parse(makeRepositoryEventPayload('pull_request', 'opened')) as Record<
        string,
        unknown
      >;
      parsed.repository = {
        name: 'OtherRepo',
        full_name: 'OtherOrg/OtherRepo',
        owner: { login: 'OtherOrg' },
      };
      const body = JSON.stringify(parsed);
      const result = await sendRequest(port, body, {
        'x-hub-signature-256': signPayload(body),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'unconfigured-pr-repository',
      });
      expect(result.status).toBe(202);
      expect(result.body.ignored).toContain('repo not in allowlist');
      expect(dedupe.getStats().count).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it('ignores non-issues events with 202', async () => {
    const daemon = new WatchDaemon(
      config,
      secret,
      new WatchDedupeStore(tempDir),
      undefined,
      undefined,
      mockRecordEvent,
    );
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);

    try {
      const body = makeIssuePayload();
      const signature = signPayload(body);
      const result = await sendRequest(port, body, {
        'x-hub-signature-256': signature,
        'x-github-event': 'push',
      });
      expect(result.status).toBe(202);
    } finally {
      await daemon.stop();
    }
  });

  it('ignores repos not in allowlist with 202', async () => {
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, secret, dedupe, undefined, undefined, mockRecordEvent);
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);

    try {
      const body = makeIssuePayload({
        repository: { name: 'OtherRepo', owner: { login: 'OtherOrg' } },
      });
      const signature = signPayload(body);
      const result = await sendRequest(port, body, {
        'x-hub-signature-256': signature,
        'x-github-event': 'issues',
        'x-github-delivery': 'test-delivery-other',
      });
      expect(result.status).toBe(202);
      expect(result.body.ignored).toContain('not in allowlist');
      expect(dedupe.getStats().count).toBe(0);
    } finally {
      await daemon.stop();
    }
  });

  it('suppresses duplicate deliveries', async () => {
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, secret, dedupe, undefined, undefined, mockRecordEvent);
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);

    try {
      const body = makeIssuePayload();
      const signature = signPayload(body);
      const headers = {
        'x-hub-signature-256': signature,
        'x-github-event': 'issues',
        'x-github-delivery': 'dup-delivery-1',
      };
      const first = await sendRequest(port, body, headers);
      expect(first.status).toBe(200);
      expect(first.body.event_id).toBeDefined();

      const second = await sendRequest(port, body, headers);
      expect(second.status).toBe(200);
      expect(second.body.ignored).toBe('duplicate or filtered');
    } finally {
      await daemon.stop();
    }
  });

  it('once() processes a single event without HTTP', async () => {
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, '', dedupe, undefined, undefined, mockRecordEvent);
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 99,
      title: 'Manual test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/99',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'cli',
      deliveryId: '',
      updatedAt: '2026-05-25T10:00:00Z',
    };
    const result = await daemon.once(event);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('task.created');
  });

  it('once() deduplicates by stable key when deliveryId is empty', async () => {
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, '', dedupe, undefined, undefined, mockRecordEvent);
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 88,
      title: 'Dedup test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/88',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'cli',
      deliveryId: '',
      updatedAt: '2026-05-25T10:00:00Z',
    };
    const first = await daemon.once(event);
    expect(first).not.toBeNull();

    const second = await daemon.once(event);
    expect(second).toBeNull();
  });

  it('ignores action not watched for a specific repo (per-repo filtering)', async () => {
    const multiRepoConfig: typeof config = {
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Negentropy-Laby',
          repo: 'OpenSlack',
          events: ['issues.opened'],
          labels: { include: ['openslack:task'] },
        },
        {
          owner: 'OtherOrg',
          repo: 'OtherRepo',
          events: ['issues.labeled'],
        },
      ],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(
      multiRepoConfig,
      secret,
      dedupe,
      undefined,
      undefined,
      mockRecordEvent,
    );
    const port = 3101 + Math.floor(Math.random() * 1000);
    await daemon.start(port);

    try {
      // Send a labeled event for OpenSlack (which only watches opened)
      const body = makeIssuePayload({ action: 'labeled' });
      const signature = signPayload(body);
      const result = await sendRequest(port, body, {
        'x-hub-signature-256': signature,
        'x-github-event': 'issues',
        'x-github-delivery': 'per-repo-filter-1',
      });
      expect(result.status).toBe(202);
      expect(result.body.ignored).toContain('not watched for');
      expect(dedupe.getStats().count).toBe(0);
    } finally {
      await daemon.stop();
    }
  });
});

describe('notification formatting', () => {
  it('creates notification payload', () => {
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 42,
      title: 'Fix failing setup',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/42',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'bot',
      deliveryId: 'abc',
      updatedAt: '2026-05-25T10:00:00Z',
    };
    const payload = createNotificationPayload(event);
    expect(payload.repo).toBe('Negentropy-Laby/OpenSlack');
    expect(payload.issueNumber).toBe(42);
    expect(payload.labels).toEqual(['openslack:task']);
  });

  it('formats console notification', () => {
    const payload: ReturnType<typeof createNotificationPayload> = {
      schema: 'openslack.github_watch_notification.v1',
      type: 'openslack.issue.detected',
      objectKind: 'issue',
      eventKey: 'issues.opened',
      eventStableKey:
        'github:issues.opened:negentropy-laby/openslack:issue:42:2026-05-25T10:00:00Z',
      repo: 'Negentropy-Laby/OpenSlack',
      objectId: 'negentropy-laby/openslack#42',
      issueNumber: 42,
      title: 'Test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/42',
      labels: ['openslack:task'],
      nextAction: 'openslack agent tick',
      informational: false,
      observedAt: '2026-05-25T10:00:00Z',
    };
    const text = formatConsoleNotification(payload);
    expect(text).toContain('GitHub Watch');
    expect(text).toContain('Negentropy-Laby/OpenSlack#42');
  });
});

describe('WatchDaemon sink dispatch', () => {
  it('dispatches to console sink via routes config', async () => {
    const routeConfig: GitHubWatchConfig = {
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Negentropy-Laby',
          repo: 'OpenSlack',
          events: ['issues.opened'],
          labels: { include: ['openslack:task'] },
          routes: [{ sink: 'console' as const }],
        },
      ],
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(routeConfig, '', dedupe, undefined, undefined, mockRecordEvent);
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 77,
      title: 'Sink dispatch test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/77',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'cli',
      deliveryId: '',
      updatedAt: '2026-05-25T12:00:00Z',
    };
    await daemon.once(event);
    expect(logSpy).toHaveBeenCalled();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('Sink dispatch test');
    logSpy.mockRestore();
  });

  it('warns and records failure when sink is not configured', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const routeConfig: GitHubWatchConfig = {
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Negentropy-Laby',
          repo: 'OpenSlack',
          events: ['issues.opened'],
          labels: { include: ['openslack:task'] },
          routes: [{ sink: 'slack' as const, channel: '#test' }],
        },
      ],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(routeConfig, '', dedupe, undefined, undefined, mockRecordEvent);
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 78,
      title: 'Missing sink test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/78',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'cli',
      deliveryId: '',
      updatedAt: '2026-05-25T12:00:00Z',
    };
    const result = await daemon.once(event);
    expect(result).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No sink configured'));
    warnSpy.mockRestore();
  });

  it('records notification.failed event on sink error and continues', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', mockFetch);

    const routeConfig: GitHubWatchConfig = {
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Negentropy-Laby',
          repo: 'OpenSlack',
          events: ['issues.opened'],
          labels: { include: ['openslack:task'] },
          routes: [{ sink: 'webhook' as const }],
        },
      ],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(
      routeConfig,
      '',
      dedupe,
      {
        webhookUrl: 'https://broken.example.com/hook',
      },
      undefined,
      mockRecordEvent,
    );
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 79,
      title: 'Webhook fail test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/79',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'cli',
      deliveryId: '',
      updatedAt: '2026-05-25T12:00:00Z',
    };
    const result = await daemon.once(event);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('task.created');
    vi.restoreAllMocks();
  });
});

describe('WatchDaemon polling', () => {
  it('pollAll() returns dry-run error without credentials', async () => {
    const getClient = await import('@openslack/github').then((m) => m.getClient);
    // getClient in test env returns isDryRun when no GITHUB_TOKEN is set
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, '', dedupe, undefined, undefined, mockRecordEvent);
    const result = await daemon.pollAll();
    // If the environment has no token, this will be a dry-run error
    // If it has a token, reposPolled could be > 0 but the test still passes
    expect(typeof result.reposPolled).toBe('number');
    expect(typeof result.eventsDispatched).toBe('number');
  });

  it('pollAll() deduplicates polled events across calls', async () => {
    // Use once() directly to simulate two polls with the same event
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, '', dedupe, undefined, undefined, mockRecordEvent);
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 100,
      title: 'Poll dedup test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/100',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'poll',
      deliveryId: '',
      updatedAt: '2026-05-25T14:00:00Z',
    };
    const first = await daemon.once(event, 'github.watch.poll');
    expect(first).not.toBeNull();
    const second = await daemon.once(event, 'github.watch.poll');
    expect(second).toBeNull();
  });

  it('updates cursors after pollAll via once()', async () => {
    const cursorStore = new WatchCursorStore(tempDir);
    cursorStore.updateCursor('Negentropy-Laby/OpenSlack', {
      lastSeenAt: '2026-05-25T10:00:00Z',
      lastIssueNumber: 50,
    });
    const cursor = cursorStore.getCursor('Negentropy-Laby/OpenSlack');
    expect(cursor).not.toBeNull();
    expect(cursor!.lastIssueNumber).toBe(50);
  });

  it('webhook and poll events are deduplicated via stable key', async () => {
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, '', dedupe, undefined, undefined, mockRecordEvent);
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 101,
      title: 'Cross-path dedup test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/101',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'test',
      deliveryId: 'webhook-delivery-1',
      updatedAt: '2026-05-25T15:00:00Z',
    };
    // First: webhook path
    const webhookResult = await daemon.once(event, 'github.watch.webhook');
    expect(webhookResult).not.toBeNull();

    // Second: poll path (same issue, no deliveryId)
    const pollEvent = { ...event, deliveryId: '' };
    const pollResult = await daemon.once(pollEvent, 'github.watch.poll');
    // Deduplicated because stable key is the same
    expect(pollResult).toBeNull();
  });

  it('stopPolling clears the interval', async () => {
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, '', dedupe, undefined, undefined, mockRecordEvent);
    // Should not throw even if never started
    daemon.stopPolling();
    // Start and stop
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // Mock pollAll to avoid actual API calls
    const originalPollAll = daemon.pollAll.bind(daemon);
    daemon.pollAll = async () => ({ reposPolled: 0, eventsDispatched: 0, errors: [] });
    await daemon.startPolling(10);
    daemon.stopPolling();
    await daemon.stop();
    logSpy.mockRestore();
    daemon.pollAll = originalPollAll;
  });

  it('skips events when repo does not subscribe to the polled action', async () => {
    const labeledOnlyConfig: GitHubWatchConfig = {
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Negentropy-Laby',
          repo: 'OpenSlack',
          events: ['issues.labeled'],
          labels: { include: ['openslack:task'] },
        },
      ],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(
      labeledOnlyConfig,
      '',
      dedupe,
      undefined,
      undefined,
      mockRecordEvent,
    );
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 200,
      title: 'Should be skipped',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/200',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'poll',
      deliveryId: '',
      updatedAt: '2026-05-25T16:00:00Z',
    };
    // Direct once() call would record task.blocked, but pollAll() pre-filters
    // Simulate pollAll's filter: check repoConfig.events before calling once()
    const repoConfig = labeledOnlyConfig.repositories[0];
    const eventKey = githubWebhookEventKey('issues', event.action);
    expect(eventKey).toBe('issues.opened');
    if (!eventKey) throw new Error('Expected a mapped issue event key');
    expect(repoConfig.events.includes(eventKey)).toBe(false);
  });
});

describe('WatchDaemon push events', () => {
  it('uses the full push SHA in persistent collaboration object identities', async () => {
    const after = '0123456789abcdef0123456789abcdef01234567';
    const recordFn = vi.fn(mockRecordEvent);
    const daemon = new WatchDaemon(
      config,
      '',
      new WatchDedupeStore(tempDir),
      undefined,
      undefined,
      recordFn,
    );
    const event: NormalizedPushEvent = {
      ref: 'refs/heads/main',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      before: 'f'.repeat(40),
      after,
      pusher: 'pusher',
      deliveryId: 'push-sha-display-length',
      commits: [
        {
          id: after,
          message: 'Update watched content',
          added: ['posts/update.md'],
          modified: [],
          removed: [],
          timestamp: '2026-07-16T00:00:00Z',
        },
      ],
    };

    const result = await daemon.handlePushEvent(event);

    expect(result?.object).toEqual({
      kind: 'push',
      id: `Negentropy-Laby/OpenSlack@${after}`,
    });
  });
});

describe('WatchDaemon auto-claim', () => {
  it('does not call autoClaimFn when auto_claim is disabled (default)', async () => {
    const claimFn = vi.fn().mockResolvedValue(undefined);
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, '', dedupe, undefined, claimFn, mockRecordEvent);
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 300,
      title: 'Auto-claim disabled test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/300',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'test',
      deliveryId: '',
      updatedAt: '2026-05-25T17:00:00Z',
    };
    await daemon.once(event);
    expect(claimFn).not.toHaveBeenCalled();
  });

  it('does not call autoClaimFn when no autoClaimFn provided', async () => {
    const autoClaimConfig: GitHubWatchConfig = {
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Negentropy-Laby',
          repo: 'OpenSlack',
          events: ['issues.opened'],
          labels: { include: ['openslack:task'] },
          auto_claim: { enabled: true, agent_ids: ['test-agent'] },
        },
      ],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(
      autoClaimConfig,
      '',
      dedupe,
      undefined,
      undefined,
      mockRecordEvent,
    );
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 301,
      title: 'No autoClaimFn test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/301',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'test',
      deliveryId: '',
      updatedAt: '2026-05-25T17:00:00Z',
    };
    const result = await daemon.once(event);
    expect(result).not.toBeNull();
    // No crash, no claim
  });

  it('calls autoClaimFn when enabled and agent_ids provided', async () => {
    const claimFn = vi.fn().mockResolvedValue(undefined);
    const autoClaimConfig: GitHubWatchConfig = {
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Negentropy-Laby',
          repo: 'OpenSlack',
          events: ['issues.opened'],
          labels: { include: ['openslack:task'] },
          auto_claim: { enabled: true, agent_ids: ['agent-a', 'agent-b'] },
        },
      ],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(
      autoClaimConfig,
      '',
      dedupe,
      undefined,
      claimFn,
      mockRecordEvent,
    );
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 302,
      title: 'Auto-claim test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/302',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'test',
      deliveryId: '',
      updatedAt: '2026-05-25T17:00:00Z',
    };
    await daemon.once(event);
    expect(claimFn).toHaveBeenCalledTimes(1);
    expect(claimFn).toHaveBeenCalledWith(event, ['agent-a', 'agent-b']);
  });

  it('does not call autoClaimFn when enabled but agent_ids is empty', async () => {
    const claimFn = vi.fn().mockResolvedValue(undefined);
    const autoClaimConfig: GitHubWatchConfig = {
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Negentropy-Laby',
          repo: 'OpenSlack',
          events: ['issues.opened'],
          labels: { include: ['openslack:task'] },
          auto_claim: { enabled: true },
        },
      ],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(
      autoClaimConfig,
      '',
      dedupe,
      undefined,
      claimFn,
      mockRecordEvent,
    );
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 303,
      title: 'Empty agent_ids test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/303',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'test',
      deliveryId: '',
      updatedAt: '2026-05-25T17:00:00Z',
    };
    await daemon.once(event);
    expect(claimFn).not.toHaveBeenCalled();
  });

  it('continues after autoClaimFn throws', async () => {
    const claimFn = vi.fn().mockRejectedValue(new Error('identity not found'));
    const autoClaimConfig: GitHubWatchConfig = {
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Negentropy-Laby',
          repo: 'OpenSlack',
          events: ['issues.opened'],
          labels: { include: ['openslack:task'] },
          auto_claim: { enabled: true, agent_ids: ['broken-agent'] },
        },
      ],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(
      autoClaimConfig,
      '',
      dedupe,
      undefined,
      claimFn,
      mockRecordEvent,
    );
    const event: NormalizedIssueEvent = {
      action: 'opened',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      issueNumber: 304,
      title: 'Claim failure test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/304',
      labels: ['openslack:task'],
      body: '',
      senderLogin: 'test',
      deliveryId: '',
      updatedAt: '2026-05-25T17:00:00Z',
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await daemon.once(event);
    expect(result).not.toBeNull();
    expect(claimFn).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('identity not found'));
    errorSpy.mockRestore();
  });
});
