import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWorkspaceWatchDaemon, WorkspaceWatchDaemonStartError } from '../workspace-watch.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('typed workspace watch daemon startup', () => {
  it('starts webhook mode when an exact secret is provided', async () => {
    const configPath = watchConfig();
    const start = vi.fn().mockResolvedValue(undefined);
    const startPolling = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);

    const handle = await startWorkspaceWatchDaemon({
      configPath,
      webhookSecret: 'secret-reference-value',
      port: 4123,
      daemonFactory: () => ({ start, startPolling, stop }),
    });

    expect(start).toHaveBeenCalledWith(4123);
    expect(startPolling).not.toHaveBeenCalled();
    expect(handle).toMatchObject({
      mode: 'webhook',
      port: 4123,
      repositories: 1,
    });
    await handle.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('uses polling when no webhook secret is configured', async () => {
    const configPath = watchConfig();
    const start = vi.fn().mockResolvedValue(undefined);
    const startPolling = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);

    const handle = await startWorkspaceWatchDaemon({
      configPath,
      pollIntervalSeconds: 45,
      daemonFactory: () => ({ start, startPolling, stop }),
    });

    expect(startPolling).toHaveBeenCalledWith(45);
    expect(start).not.toHaveBeenCalled();
    expect(handle).toMatchObject({
      mode: 'poll',
      pollIntervalSeconds: 45,
      repositories: 1,
    });
  });

  it('loads explicit v2 config without creating an implicit backend', async () => {
    const configPath = watchConfigV2();
    const startPolling = vi.fn().mockResolvedValue(undefined);
    let schema = '';

    const handle = await startWorkspaceWatchDaemon({
      configPath,
      daemonFactory: (config) => {
        schema = config.schema;
        return {
          start: vi.fn(),
          startPolling,
          stop: vi.fn().mockResolvedValue(undefined),
        };
      },
    });

    expect(schema).toBe('openslack.github_watch.v2');
    expect(startPolling).toHaveBeenCalledWith(300);
    expect(handle.repositories).toBe(1);
  });

  it('loads the closed v2 config without silently falling back to v1', async () => {
    const root = temporaryRoot();
    const configPath = join(root, 'github-watch-v2.yaml');
    writeFileSync(
      configPath,
      stringifyYaml({
        schema: 'openslack.github_watch.v2',
        notification_service: {
          endpoint: 'https://notifications.example.test',
          credential_ref: 'env:OPENSLACK_NOTIFICATION_SERVICE_KEY',
          expected_deployment_digest: `sha256:${'a'.repeat(64)}`,
        },
        repositories: [
          {
            owner: 'Acme',
            repo: 'Project',
            events: ['issues.opened'],
            routes: [
              {
                id: 'service-primary',
                sink: 'webhook',
                delivery: {
                  backend: 'notification_service',
                  routing_epoch: 1,
                  vendor_id: 'webhook-canary',
                },
              },
            ],
          },
        ],
      }),
      'utf8',
    );
    const startPolling = vi.fn().mockResolvedValue(undefined);
    const handle = await startWorkspaceWatchDaemon({
      configPath,
      daemonFactory: (config) => {
        expect(config.schema).toBe('openslack.github_watch.v2');
        return {
          start: vi.fn(),
          startPolling,
          stop: vi.fn().mockResolvedValue(undefined),
        };
      },
    });

    expect(startPolling).toHaveBeenCalled();
    expect(handle.repositories).toBe(1);
  });

  it('fails with stable codes for invalid config and bounded numeric options', async () => {
    const root = temporaryRoot();
    const invalid = join(root, 'invalid.yaml');
    writeFileSync(invalid, 'schema: invalid\n', 'utf8');

    await expect(startWorkspaceWatchDaemon({ configPath: invalid })).rejects.toMatchObject({
      code: 'WATCH_CONFIG_INVALID',
    });
    await expect(
      startWorkspaceWatchDaemon({ configPath: watchConfig(), port: 0 }),
    ).rejects.toMatchObject({
      code: 'WATCH_PORT_INVALID',
    });
    await expect(
      startWorkspaceWatchDaemon({ configPath: watchConfig(), pollIntervalSeconds: 86_401 }),
    ).rejects.toMatchObject({
      code: 'WATCH_POLL_INTERVAL_INVALID',
    });
  });

  it('stops a partially started daemon and hides provider errors', async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    await expect(
      startWorkspaceWatchDaemon({
        configPath: watchConfig(),
        daemonFactory: () => ({
          start: vi.fn().mockRejectedValue(new Error('secret provider detail')),
          startPolling: vi.fn(),
          stop,
        }),
        webhookSecret: 'configured',
      }),
    ).rejects.toEqual(
      new WorkspaceWatchDaemonStartError(
        'WATCH_START_FAILED',
        'GitHub Watch daemon could not start.',
      ),
    );
    expect(stop).toHaveBeenCalledOnce();
  });
});

function watchConfig(): string {
  const root = temporaryRoot();
  const path = join(root, 'github-watch.yaml');
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path,
    stringifyYaml({
      schema: 'openslack.github_watch.v1',
      repositories: [
        {
          owner: 'Acme',
          repo: 'Project',
          events: ['issues.opened', 'pull_request.opened', 'check_run.completed'],
          routes: [{ sink: 'console' }],
          auto_claim: { enabled: false },
        },
      ],
    }),
    'utf8',
  );
  return path;
}

function watchConfigV2(): string {
  const root = temporaryRoot();
  const path = join(root, 'github-watch-v2.yaml');
  writeFileSync(
    path,
    stringifyYaml({
      schema: 'openslack.github_watch.v2',
      repositories: [
        {
          owner: 'Acme',
          repo: 'Project',
          events: ['issues.opened'],
          routes: [
            {
              id: 'console-local',
              sink: 'console',
              delivery: { backend: 'local', routing_epoch: 1 },
            },
          ],
        },
      ],
    }),
    'utf8',
  );
  return path;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-workspace-watch-'));
  roots.push(root);
  return root;
}
