import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startWorkspaceWatchDaemon,
  WorkspaceWatchDaemonStartError,
} from '../workspace-watch.js';

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

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-workspace-watch-'));
  roots.push(root);
  return root;
}
