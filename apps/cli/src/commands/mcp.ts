import { Command } from 'commander';
import {
  createOpenSlackMcpContext,
  createOpenSlackMcpServer,
  type OpenSlackMcpServer,
  type OperatorApplicationContextPort,
} from '@openslack/mcp';

export interface McpCommandDependencies {
  readonly workspaceRoot: string;
  readonly operator: OperatorApplicationContextPort;
  readonly createServer?: typeof createOpenSlackMcpServer;
}

export function mcpCommands(dependencies: McpCommandDependencies): Command {
  const command = new Command('mcp').description(
    'Qoder/OpenSlack Model Context Protocol integration',
  );

  command
    .command('serve')
    .description('Serve the frozen read-only OpenSlack business tools over stdio')
    .requiredOption('--stdio', 'Use the local stdio transport')
    .action(async () => {
      let server: OpenSlackMcpServer | undefined;
      try {
        const context = createOpenSlackMcpContext({
          workspaceRoot: dependencies.workspaceRoot,
          operator: dependencies.operator,
        });
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
        await server.serveStdio();
      } catch {
        // stdout is reserved for protocol frames for the full lifetime of this command.
        console.error('OPENSLACK_MCP_START_FAILED: the read-only stdio server did not start.');
        process.exitCode = 1;
      }
    });

  return command;
}
