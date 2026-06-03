/**
 * Bridge Factory — creates bridge adapters based on mode configuration.
 *
 * AR-2.7: Workflow/Conversation Enablement
 */

import type { AgentExecutionAdapter } from './adapter.js';
import {
  LocalExecutionAdapter,
} from './adapter.js';
import { ExternalCommandAdapter } from './external-command-adapter.js';
import {
  BridgeProcessAdapter,
  FakeBridgeAdapter,
} from './bridge-adapter.js';

export type BridgeMode = 'local' | 'external-command' | 'process' | 'fake';

export interface BridgeFactoryOptions {
  /** Bridge mode to create. */
  bridgeMode?: BridgeMode;
  /** Command for external-command or process mode. */
  command?: string;
  /** Arguments for the command. */
  args?: string[];
  /** Environment variables. */
  env?: Record<string, string>;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** List of available MCP server names. */
  availableMcpServers?: string[];
  /** Fake adapter options for CI/testing. */
  fakeOptions?: {
    responseDelayMs?: number;
    shouldFail?: boolean;
    customResponseTemplate?: (prompt: string) => Record<string, unknown>;
  };
  /** Aby root path for process mode. */
  abyRoot?: string;
}

/**
 * Create an execution adapter based on bridge mode.
 *
 * Mode mapping:
 * - 'local' → LocalExecutionAdapter (default)
 * - 'external-command' → ExternalCommandAdapter
 * - 'process' → BridgeProcessAdapter
 * - 'fake' → FakeBridgeAdapter
 *
 * Unknown mode throws a descriptive error.
 */
export function createBridgeAdapter(options: BridgeFactoryOptions = {}): AgentExecutionAdapter {
  const mode = options.bridgeMode ?? 'local';

  switch (mode) {
    case 'local':
      return new LocalExecutionAdapter();

    case 'external-command': {
      if (!options.command) {
        throw new BridgeFactoryError(
          'external-command mode requires a command option',
        );
      }
      return new ExternalCommandAdapter({
        command: options.command,
        args: options.args,
        env: options.env,
        timeoutMs: options.timeoutMs,
      });
    }

    case 'process': {
      if (!options.command) {
        throw new BridgeFactoryError(
          'process mode requires a command option',
        );
      }
      return new BridgeProcessAdapter({
        command: options.command,
        args: options.args,
        env: options.env,
        timeoutMs: options.timeoutMs,
        availableMcpServers: options.availableMcpServers,
        abyRoot: options.abyRoot,
      });
    }

    case 'fake': {
      return new FakeBridgeAdapter({
        responseDelayMs: options.fakeOptions?.responseDelayMs,
        shouldFail: options.fakeOptions?.shouldFail,
        customResponseTemplate: options.fakeOptions?.customResponseTemplate,
        availableMcpServers: options.availableMcpServers,
      });
    }

    default: {
      // Exhaustive check: unknown mode
      const unknownMode = mode as string;
      throw new BridgeFactoryError(
        `Unknown bridge mode: "${unknownMode}". ` +
          `Valid modes are: local, external-command, process, fake`,
      );
    }
  }
}

/**
 * Factory class for creating bridge adapters.
 */
export class BridgeFactory {
  /**
   * Create an adapter for the given bridge mode.
   */
  static create(mode: BridgeMode, options?: Omit<BridgeFactoryOptions, 'bridgeMode'>): AgentExecutionAdapter {
    return createBridgeAdapter({ bridgeMode: mode, ...options });
  }

  /**
   * Create a fake bridge adapter for CI/testing.
   */
  static createFake(options?: BridgeFactoryOptions['fakeOptions']): FakeBridgeAdapter {
    return new FakeBridgeAdapter({
      responseDelayMs: options?.responseDelayMs,
      shouldFail: options?.shouldFail,
      customResponseTemplate: options?.customResponseTemplate,
    });
  }

  /**
   * Create a process bridge adapter for external runtime integration.
   */
  static createProcess(
    command: string,
    options?: Omit<BridgeFactoryOptions, 'bridgeMode' | 'command'>,
  ): BridgeProcessAdapter {
    return new BridgeProcessAdapter({
      command,
      args: options?.args,
      env: options?.env,
      timeoutMs: options?.timeoutMs,
      availableMcpServers: options?.availableMcpServers,
      abyRoot: options?.abyRoot,
    });
  }
}

/**
 * Error thrown by the bridge factory for invalid configuration.
 */
export class BridgeFactoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BridgeFactoryError';
  }
}
