import { resolve } from 'node:path';
import { loadGitHubWatchConfig } from './watch-config.js';
import {
  WatchDaemon,
  type AutoClaimFn,
  type RecordEventFn,
  type WatchDaemonDependencies,
} from './watch-daemon.js';

export type WorkspaceWatchDaemonMode = 'webhook' | 'poll';

export interface StartWorkspaceWatchDaemonOptions {
  configPath: string;
  webhookSecret?: string;
  port?: number;
  pollIntervalSeconds?: number;
  sinkOptions?: {
    slackBotToken?: string;
    webhookUrl?: string;
  };
  autoClaimFn?: AutoClaimFn;
  recordEvent?: RecordEventFn;
  daemonDependencies?: WatchDaemonDependencies;
  daemonFactory?: (
    config: NonNullable<ReturnType<typeof loadGitHubWatchConfig>['config']>,
    secret: string,
    options: StartWorkspaceWatchDaemonOptions,
  ) => Pick<WatchDaemon, 'start' | 'startPolling' | 'stop'>;
}

export interface WorkspaceWatchDaemonHandle {
  mode: WorkspaceWatchDaemonMode;
  configPath: string;
  repositories: number;
  port?: number;
  pollIntervalSeconds?: number;
  stop(): Promise<void>;
}

export class WorkspaceWatchDaemonStartError extends Error {
  constructor(
    readonly code:
      | 'WATCH_CONFIG_INVALID'
      | 'WATCH_PORT_INVALID'
      | 'WATCH_POLL_INTERVAL_INVALID'
      | 'WATCH_START_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceWatchDaemonStartError';
  }
}

export async function startWorkspaceWatchDaemon(
  options: StartWorkspaceWatchDaemonOptions,
): Promise<WorkspaceWatchDaemonHandle> {
  const configPath = resolve(options.configPath);
  const parsed = loadGitHubWatchConfig(configPath);
  if (!parsed.valid || !parsed.config) {
    throw new WorkspaceWatchDaemonStartError(
      'WATCH_CONFIG_INVALID',
      `GitHub Watch config is invalid: ${parsed.errors.join('; ')}`,
    );
  }
  const secret = options.webhookSecret?.trim() ?? '';
  const mode: WorkspaceWatchDaemonMode = secret ? 'webhook' : 'poll';
  const port = boundedInteger(options.port, 3100, 1, 65_535, 'WATCH_PORT_INVALID');
  const pollIntervalSeconds = boundedInteger(
    options.pollIntervalSeconds,
    300,
    1,
    86_400,
    'WATCH_POLL_INTERVAL_INVALID',
  );
  const daemon =
    options.daemonFactory?.(parsed.config, secret, options) ??
    new WatchDaemon(
      parsed.config,
      secret,
      undefined,
      options.sinkOptions,
      options.autoClaimFn,
      options.recordEvent,
      {},
      options.daemonDependencies,
    );
  try {
    if (mode === 'webhook') await daemon.start(port);
    else await daemon.startPolling(pollIntervalSeconds);
  } catch {
    await daemon.stop().catch(() => undefined);
    throw new WorkspaceWatchDaemonStartError(
      'WATCH_START_FAILED',
      'GitHub Watch daemon could not start.',
    );
  }
  return {
    mode,
    configPath,
    repositories: parsed.config.repositories.length,
    ...(mode === 'webhook' ? { port } : { pollIntervalSeconds }),
    stop: () => daemon.stop(),
  };
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  code: WorkspaceWatchDaemonStartError['code'],
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new WorkspaceWatchDaemonStartError(
      code,
      `${code === 'WATCH_PORT_INVALID' ? 'Watch port' : 'Polling interval'} is invalid.`,
    );
  }
  return resolved;
}
