import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { OpenSlackMcpContext } from './context.js';
import { OpenSlackMcpCore, type OpenSlackMcpCoreOptions } from './core.js';
import { OpenSlackMcpProtocolError } from './errors.js';

export interface OpenSlackMcpServer {
  readonly core: OpenSlackMcpCore;
  readonly sdkServer: Server;
  serveStdio(): Promise<void>;
  close(): Promise<void>;
}

function writableSchema(schema: unknown): Record<string, unknown> {
  return structuredClone(schema) as Record<string, unknown>;
}

export function createOpenSlackMcpServer(
  context: OpenSlackMcpContext,
  options: OpenSlackMcpCoreOptions = {},
): OpenSlackMcpServer {
  const core = new OpenSlackMcpCore(context, options);
  const sdkServer = new Server(
    { name: 'openslack-qoder', version: '0.2.0' },
    {
      capabilities: {
        tools: { listChanged: false },
      },
    },
  );

  sdkServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: core.listTools().map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: writableSchema(tool.inputSchema),
      annotations: { ...tool.annotations },
    })),
  }));

  sdkServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await core.callTool(request.params.name, request.params.arguments ?? {});
      return {
        content: [...result.content],
        structuredContent: { ...result.structuredContent },
        isError: result.isError,
      };
    } catch (error) {
      if (error instanceof OpenSlackMcpProtocolError) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }
      throw new McpError(ErrorCode.InternalError, 'OpenSlack MCP request failed safely.');
    }
  });

  let transport: StdioServerTransport | undefined;
  return Object.freeze({
    core,
    sdkServer,
    async serveStdio(): Promise<void> {
      if (transport) throw new Error('MCP_STDIO_ALREADY_CONNECTED');
      transport = new StdioServerTransport();
      await sdkServer.connect(transport);
    },
    async close(): Promise<void> {
      await sdkServer.close();
      transport = undefined;
    },
  });
}
