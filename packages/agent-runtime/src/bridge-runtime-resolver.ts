import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { BridgeFactoryOptions } from './bridge-factory.js';
import type { ResolvedAgentConfig } from './types.js';
import { buildSafeBridgeEnv } from './bridge-env.js';

export interface AbyBridgeRuntimeConfig {
  root?: string;
  command?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface BridgeRuntimeResolverOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

export interface BridgeRuntimeResolver {
  resolve(config: ResolvedAgentConfig): Omit<BridgeFactoryOptions, 'bridgeMode'> | null;
}

export class BridgeRuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeRuntimeConfigError';
  }
}

export function createBridgeRuntimeResolver(
  options: BridgeRuntimeResolverOptions = {},
): BridgeRuntimeResolver {
  return {
    resolve(config: ResolvedAgentConfig): Omit<BridgeFactoryOptions, 'bridgeMode'> | null {
      if (!isAbyRuntime(config)) return null;

      const runtimeConfig = loadAbyBridgeRuntimeConfig(options);
      if (!runtimeConfig.root) {
        throw new BridgeRuntimeConfigError(
          'Aby bridge runtime requested but no Aby root is configured. Set OPENSLACK_ABY_ROOT or .openslack.local/agent-runtime.json.',
        );
      }

      const abyRoot = resolveConfiguredPath(runtimeConfig.root, options.rootDir);
      const runEntrypoint = join(abyRoot, 'src', 'sidecar', 'entrypoints', 'runEntrypoint.ts');
      const agentRunBridge = join(abyRoot, 'src', 'sidecar', 'entrypoints', 'agentRunBridge.ts');

      if (!existsSync(runEntrypoint)) {
        throw new BridgeRuntimeConfigError(
          `Aby bridge runtime is missing runEntrypoint.ts at ${runEntrypoint}`,
        );
      }
      if (!existsSync(agentRunBridge)) {
        throw new BridgeRuntimeConfigError(
          `Aby bridge runtime is missing agentRunBridge.ts at ${agentRunBridge}`,
        );
      }

      return {
        command: runtimeConfig.command ?? 'bun',
        // Absolute paths keep the process launch compatible with worktree CWD.
        args: [runEntrypoint, agentRunBridge],
        timeoutMs: runtimeConfig.timeoutMs,
        env: buildSafeBridgeEnv(runtimeConfig.env),
        abyRoot,
      };
    },
  };
}

export function isAbyRuntime(config: ResolvedAgentConfig): boolean {
  return (
    config.runtimeProvider === 'aby' ||
    config.runtime === 'aby_assistant' ||
    config.runtime === 'aby' ||
    config.provider === 'aby'
  );
}

export function loadAbyBridgeRuntimeConfig(
  options: BridgeRuntimeResolverOptions = {},
): AbyBridgeRuntimeConfig {
  const env = options.env ?? process.env;
  const configFromFile = readAgentRuntimeConfig(options);
  const fileAby = readAbyConfig(configFromFile);

  return {
    ...fileAby,
    root: env.OPENSLACK_ABY_ROOT ?? fileAby.root,
    command: env.OPENSLACK_ABY_COMMAND ?? fileAby.command,
  };
}

function readAgentRuntimeConfig(options: BridgeRuntimeResolverOptions): unknown {
  const configPath =
    options.configPath ??
    join(options.rootDir ?? process.cwd(), '.openslack.local', 'agent-runtime.json');
  if (!existsSync(configPath)) return null;

  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
  } catch (err) {
    throw new BridgeRuntimeConfigError(
      `Failed to parse agent runtime config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function readAbyConfig(config: unknown): AbyBridgeRuntimeConfig {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
  const record = config as Record<string, unknown>;
  const source = typeof record.aby === 'object' && record.aby !== null
    ? record.aby as Record<string, unknown>
    : record;

  const env = typeof source.env === 'object' && source.env !== null && !Array.isArray(source.env)
    ? Object.fromEntries(
        Object.entries(source.env as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : undefined;

  return {
    root: readString(source.root) ?? readString(source.abyRoot),
    command: readString(source.command),
    timeoutMs: readPositiveInteger(source.timeoutMs),
    env,
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function resolveConfiguredPath(pathValue: string, rootDir?: string): string {
  if (isAbsolute(pathValue)) return resolve(pathValue);
  return resolve(rootDir ?? process.cwd(), pathValue);
}
