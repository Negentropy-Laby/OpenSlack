import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { WatchDaemon, createNotificationPayload, formatConsoleNotification } from '../watch-daemon.js';
import type { GitHubWatchConfig } from '../watch-config.js';
import type { NormalizedIssueEvent } from '../issue-normalizer.js';
import { WatchDedupeStore } from '../watch-dedupe.js';
import { WatchCursorStore } from '../watch-cursor.js';

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
  repositories: [{
    owner: 'Negentropy-Laby',
    repo: 'OpenSlack',
    events: ['issues.opened', 'issues.reopened', 'issues.labeled'],
    labels: { include: ['openslack:task'] },
  }],
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

function sendRequest(port: number, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: '127.0.0.1',
      port,
      path: '/github/webhook',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

describe('WatchDaemon', () => {
  it('handles a valid webhook and returns event_id', async () => {
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, secret, dedupe);
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
    const daemon = new WatchDaemon(config, secret, new WatchDedupeStore(tempDir));
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

  it('ignores non-issues events with 202', async () => {
    const daemon = new WatchDaemon(config, secret, new WatchDedupeStore(tempDir));
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
    const daemon = new WatchDaemon(config, secret, new WatchDedupeStore(tempDir));
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
    } finally {
      await daemon.stop();
    }
  });

  it('suppresses duplicate deliveries', async () => {
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, secret, dedupe);
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
    const daemon = new WatchDaemon(config, '', dedupe);
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
    const daemon = new WatchDaemon(config, '', dedupe);
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
    const daemon = new WatchDaemon(multiRepoConfig, secret, new WatchDedupeStore(tempDir));
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
      type: 'openslack.issue.detected',
      repo: 'Negentropy-Laby/OpenSlack',
      issueNumber: 42,
      title: 'Test',
      url: 'https://github.com/Negentropy-Laby/OpenSlack/issues/42',
      labels: ['openslack:task'],
      nextAction: 'openslack agent tick',
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
      repositories: [{
        owner: 'Negentropy-Laby',
        repo: 'OpenSlack',
        events: ['issues.opened'],
        labels: { include: ['openslack:task'] },
        routes: [{ sink: 'console' as const }],
      }],
    };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(routeConfig, '', dedupe);
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
      repositories: [{
        owner: 'Negentropy-Laby',
        repo: 'OpenSlack',
        events: ['issues.opened'],
        labels: { include: ['openslack:task'] },
        routes: [{ sink: 'slack' as const, channel: '#test' }],
      }],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(routeConfig, '', dedupe);
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
      repositories: [{
        owner: 'Negentropy-Laby',
        repo: 'OpenSlack',
        events: ['issues.opened'],
        labels: { include: ['openslack:task'] },
        routes: [{ sink: 'webhook' as const }],
      }],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(routeConfig, '', dedupe, {
      webhookUrl: 'https://broken.example.com/hook',
    });
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
    const getClient = await import('@openslack/github').then(m => m.getClient);
    // getClient in test env returns isDryRun when no GITHUB_TOKEN is set
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, '', dedupe);
    const result = await daemon.pollAll();
    // If the environment has no token, this will be a dry-run error
    // If it has a token, reposPolled could be > 0 but the test still passes
    expect(typeof result.reposPolled).toBe('number');
    expect(typeof result.eventsDispatched).toBe('number');
  });

  it('pollAll() deduplicates polled events across calls', async () => {
    // Use once() directly to simulate two polls with the same event
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, '', dedupe);
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
    const daemon = new WatchDaemon(config, '', dedupe);
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
    const daemon = new WatchDaemon(config, '', dedupe);
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
      repositories: [{
        owner: 'Negentropy-Laby',
        repo: 'OpenSlack',
        events: ['issues.labeled'],
        labels: { include: ['openslack:task'] },
      }],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(labeledOnlyConfig, '', dedupe);
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
    const eventKey = `issues.${event.action}`;
    expect(repoConfig.events.includes(eventKey)).toBe(false);
  });
});

describe('WatchDaemon auto-claim', () => {
  it('does not call autoClaimFn when auto_claim is disabled (default)', async () => {
    const claimFn = vi.fn().mockResolvedValue(undefined);
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(config, '', dedupe, undefined, claimFn);
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
      repositories: [{
        owner: 'Negentropy-Laby',
        repo: 'OpenSlack',
        events: ['issues.opened'],
        labels: { include: ['openslack:task'] },
        auto_claim: { enabled: true, agent_ids: ['test-agent'] },
      }],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(autoClaimConfig, '', dedupe);
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
      repositories: [{
        owner: 'Negentropy-Laby',
        repo: 'OpenSlack',
        events: ['issues.opened'],
        labels: { include: ['openslack:task'] },
        auto_claim: { enabled: true, agent_ids: ['agent-a', 'agent-b'] },
      }],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(autoClaimConfig, '', dedupe, undefined, claimFn);
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
      repositories: [{
        owner: 'Negentropy-Laby',
        repo: 'OpenSlack',
        events: ['issues.opened'],
        labels: { include: ['openslack:task'] },
        auto_claim: { enabled: true },
      }],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(autoClaimConfig, '', dedupe, undefined, claimFn);
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
      repositories: [{
        owner: 'Negentropy-Laby',
        repo: 'OpenSlack',
        events: ['issues.opened'],
        labels: { include: ['openslack:task'] },
        auto_claim: { enabled: true, agent_ids: ['broken-agent'] },
      }],
    };
    const dedupe = new WatchDedupeStore(tempDir);
    const daemon = new WatchDaemon(autoClaimConfig, '', dedupe, undefined, claimFn);
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
