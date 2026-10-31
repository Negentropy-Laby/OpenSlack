import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { HarnessTaskHost } from '@openslack/agent-runtime/internal/harness';
import { createOpenSlackMcpContext, type OperatorApplicationContextPort } from '../context.js';
import { createOpenSlackMcpServer } from '../server.js';
import { createOpenSlackMcpStdioHost, McpStdioLifecycleError } from '../stdio-host.js';

describe('owned MCP stdio orchestration', () => {
  it('drains the owned host and removes listeners when the real SDK transport fails to start', async () => {
    const input = new PassThrough(), output = new PassThrough();
    const originalOn = input.on.bind(input);
    vi.spyOn(input, 'on').mockImplementation((event, listener) => {
      if (event === 'data') throw new Error('Private transport startup detail');
      return originalOn(event, listener);
    });
    const close = vi.fn(async () => ({ stopped: true }));
    const host = await createOpenSlackMcpStdioHost({ workspaceRoot: process.cwd(), profile: 'agent-bound',
      harnessTaskHost: { close } as unknown as HarnessTaskHost,
      createContext: async () => createOpenSlackMcpContext({ workspaceRoot: process.cwd(), operator: {} as OperatorApplicationContextPort }),
      createServer: (context, options, lifecycle) => createOpenSlackMcpServer(context, options, { ...lifecycle, input, output }),
    });
    await expect(host.serve()).rejects.toMatchObject({ phase: 'start' });
    expect(close).toHaveBeenCalledOnce();
    expect(host.state).toBe('failed');
    for (const event of ['end', 'close', 'error']) expect(input.listenerCount(event)).toBe(0);
    await host.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves both startup and cleanup failures without classifying the startup as shutdown', async () => {
    const input = new PassThrough(), output = new PassThrough();
    const originalOn = input.on.bind(input);
    vi.spyOn(input, 'on').mockImplementation((event, listener) => {
      if (event === 'data') throw new Error('Private transport startup detail');
      return originalOn(event, listener);
    });
    const close = vi.fn(async () => { throw new Error('Private owned cleanup detail'); });
    const host = await createOpenSlackMcpStdioHost({ workspaceRoot: process.cwd(), profile: 'agent-bound',
      harnessTaskHost: { close } as unknown as HarnessTaskHost,
      createContext: async () => createOpenSlackMcpContext({ workspaceRoot: process.cwd(), operator: {} as OperatorApplicationContextPort }),
      createServer: (context, options, lifecycle) => createOpenSlackMcpServer(context, options, { ...lifecycle, input, output }),
    });
    const error = await host.serve().catch(error => error);
    expect(error).toBeInstanceOf(McpStdioLifecycleError);
    expect(error.phase).toBe('start');
    expect(error.cause).toBeInstanceOf(AggregateError);
    expect(error.cause.errors).toHaveLength(2);
    expect(close).toHaveBeenCalledOnce();
    await expect(host.close()).rejects.toMatchObject({ phase: 'start' });
    expect(close).toHaveBeenCalledOnce();
  });
});
