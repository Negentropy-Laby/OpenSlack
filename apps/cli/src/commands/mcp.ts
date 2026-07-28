import { Command, Option } from 'commander';
import {
  createOpenSlackAgentBoundMutationComposition,
  createOpenSlackMcpContext,
  createOpenSlackMcpServer,
  type OpenSlackMcpContext,
  type OpenSlackMcpServer,
  type OperatorApplicationContextPort,
} from '@openslack/mcp';

export const OPENSLACK_MCP_CLI_PROFILES = Object.freeze(['read-only', 'agent-bound'] as const);
export type OpenSlackMcpCliProfile = (typeof OPENSLACK_MCP_CLI_PROFILES)[number];

export interface McpCommandDependencies {
  readonly workspaceRoot: string;
  readonly operator: OperatorApplicationContextPort;
  readonly createContext?: typeof createOpenSlackMcpContext;
  readonly createAgentBoundComposition?: typeof createOpenSlackAgentBoundMutationComposition;
  readonly createServer?: typeof createOpenSlackMcpServer;
}

interface McpServeOptions {
  readonly stdio: true;
  readonly profile: OpenSlackMcpCliProfile;
  readonly principalRef?: string;
  readonly workspaceId?: string;
}

class McpProfileArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpProfileArgumentError';
  }
}

async function createProfileContext(
  dependencies: McpCommandDependencies,
  options: McpServeOptions,
): Promise<OpenSlackMcpContext> {
  const createContext = dependencies.createContext ?? createOpenSlackMcpContext;
  if (options.profile === 'read-only') {
    if (options.principalRef !== undefined || options.workspaceId !== undefined) {
      throw new McpProfileArgumentError(
        'read-only does not accept --principal-ref or --workspace-id.',
      );
    }
    return createContext({
      workspaceRoot: dependencies.workspaceRoot,
      operator: dependencies.operator,
    });
  }
  if (options.profile !== 'agent-bound') {
    throw new McpProfileArgumentError('The requested MCP profile is not registered.');
  }
  if (options.principalRef === undefined) {
    throw new McpProfileArgumentError('agent-bound requires --principal-ref.');
  }
  const composition = await (
    dependencies.createAgentBoundComposition ?? createOpenSlackAgentBoundMutationComposition
  )({
    workspaceRoot: dependencies.workspaceRoot,
    principalRef: options.principalRef,
    provider: 'cli',
    ...(options.workspaceId === undefined ? {} : { workspaceIdAssertion: options.workspaceId }),
  });
  return createContext({
    workspaceRoot: dependencies.workspaceRoot,
    operator: dependencies.operator,
    governedMutations: composition.governedMutations,
  });
}

export function mcpCommands(dependencies: McpCommandDependencies): Command {
  const command = new Command('mcp').description(
    'Qoder/OpenSlack Model Context Protocol integration',
  );

  command
    .command('serve')
    .description('Serve one exact OpenSlack MCP profile over stdio')
    .requiredOption('--stdio', 'Use the local stdio transport')
    .addOption(
      new Option('--profile <profile>', 'Select one exact production MCP profile')
        .choices([...OPENSLACK_MCP_CLI_PROFILES])
        .default('read-only'),
    )
    .option(
      '--principal-ref <agent-id>',
      'Resolve an active registry/runtime principal for agent-bound',
    )
    .option('--workspace-id <workspace-id>', 'Assert the canonical workspace ID for agent-bound')
    .action(async (options: McpServeOptions) => {
      let server: OpenSlackMcpServer | undefined;
      try {
        const context = await createProfileContext(dependencies, options);
        server = (dependencies.createServer ?? createOpenSlackMcpServer)(context);

        const close = async (): Promise<void> => {
          try {
            await server?.close();
          } finally {
            process.exitCode = 0;
          }
        };
        process.once('SIGINT', close);
        process.once('SIGTERM', close);
        try {
          await server.serveStdio();
        } finally {
          process.off('SIGINT', close);
          process.off('SIGTERM', close);
        }
      } catch (error) {
        // stdout is reserved for protocol frames for the full lifetime of this command.
        if (error instanceof McpProfileArgumentError) {
          console.error(`OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: ${error.message}`);
        } else {
          console.error('OPENSLACK_MCP_START_FAILED: the requested stdio profile did not start.');
        }
        process.exitCode = 1;
      }
    });

  return command;
}
