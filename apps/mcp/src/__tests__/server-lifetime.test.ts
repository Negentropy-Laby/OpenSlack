import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createOpenSlackMcpContext, type OperatorApplicationContextPort } from '../context.js';
import { createOpenSlackMcpServer } from '../server.js';

describe('MCP transport and owned execution lifetime', () => {
  it('connect readiness does not mean transport exit; EOF drains resources exactly once', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const context = createOpenSlackMcpContext({ workspaceRoot: process.cwd(), operator: {} as OperatorApplicationContextPort });
    let drained!: () => void;
    const gate = new Promise<void>(resolve => { drained = resolve; });
    const closeOwnedResources = vi.fn(async () => { await gate; });
    const server = createOpenSlackMcpServer(context, {}, { input, output, closeOwnedResources });
    let closed = false;
    void server.whenClosed?.then(() => { closed = true; });
    await server.serveStdio();
    expect(closed).toBe(false);
    input.end();
    await vi.waitFor(() => expect(closeOwnedResources).toHaveBeenCalledTimes(1));
    expect(closed).toBe(false);
    drained();
    await server.whenClosed;
    await server.close();
    expect(closed).toBe(true);
    expect(closeOwnedResources).toHaveBeenCalledTimes(1);
  });
});
