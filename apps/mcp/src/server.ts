import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { OpenSlackMcpContext } from './context.js';
import type { Readable, Writable } from 'node:stream';
import { OpenSlackMcpCore, type OpenSlackMcpCoreOptions } from './core.js';
import { OpenSlackMcpProtocolError } from './errors.js';

export interface OpenSlackMcpServer {
  readonly core: OpenSlackMcpCore;
  readonly sdkServer: Server;
  /** Transport lifetime, distinct from serveStdio's connection readiness. */
  readonly whenClosed?: Promise<void>;
  serveStdio(): Promise<void>;
  close(): Promise<void>;
}

export interface OpenSlackMcpServerLifecycle {
  /** Stop and drain instance-owned task execution before releasing the transport. */
  closeOwnedResources?: () => Promise<void>;
  input?: Readable;
  output?: Writable;
}

function writableSchema(schema: unknown): Record<string, unknown> {
  return structuredClone(schema) as Record<string, unknown>;
}

export function createOpenSlackMcpServer(
  context: OpenSlackMcpContext,
  options: OpenSlackMcpCoreOptions = {},
  lifecycle: OpenSlackMcpServerLifecycle = {},
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
  const input = lifecycle.input ?? process.stdin;
  let resolveClosed!: () => void;
  let rejectClosed!: (error: unknown) => void;
  const whenClosed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  // Direct programmatic users may use close() without awaiting whenClosed.
  void whenClosed.catch(() => {});
  let closeTask: Promise<void> | undefined;
  const onEnd = (): void => { void close().catch(rejectClosed); };
  const close = (): Promise<void> => closeTask ??= (async () => {
    input.off('end', onEnd);
    input.off('close', onEnd);
    input.off('error', onEnd);
    try {
      await lifecycle.closeOwnedResources?.();
    } finally {
      await sdkServer.close();
      transport = undefined;
    }
  })().then(resolveClosed, error => { rejectClosed(error); throw error; });
  sdkServer.onclose = onEnd;
  return Object.freeze({
    core,
    sdkServer,
    whenClosed,
    async serveStdio(): Promise<void> {
      if (transport) throw new Error('MCP_STDIO_ALREADY_CONNECTED');
      if (closeTask) throw new Error('MCP_STDIO_CLOSED');
      transport = new StdioServerTransport(input, lifecycle.output ?? process.stdout);
      input.once('end', onEnd);
      input.once('close', onEnd);
      input.once('error', onEnd);
      await sdkServer.connect(transport);
    },
    close,
  });
}
