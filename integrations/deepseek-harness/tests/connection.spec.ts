import type * as CordisModule from '@deepseek-ai/cordis'
import type * as AgentLoopTestkitModule from '@deepseek-ai/dsh-agent-loop-testkit'
import type * as ConnectionModule from '../src/connection.ts'
import { beforeAll } from 'vitest';
let Context: typeof CordisModule.Context;

let mountAgentLoopTestDependencies: typeof AgentLoopTestkitModule.mountAgentLoopTestDependencies;

import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
let Connection: typeof ConnectionModule;
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';

describe('externally owned native MCP over a real server process', () => {
  it.each(['read-only', 'task'] as const)('bounds the %s catalog, including all pages, by the one startup budget', async mode => {
    const ctx = new Context();
    onTestFinished(() => ctx.fiber.dispose());
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
    let failure: string | undefined;
    try { await ctx.plugin(Connection, { mode,
      workspaceRoot: fileURLToPath(new URL('.', import.meta.url)),
      cliModule: fileURLToPath(new URL('./fixtures/mcp-server-catalog.js', import.meta.url)),
      principalRef: 'fixture-only', timeoutMs: mode === 'task' ? 6_000 : 5_000,
    }); } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    expect(failure ?? '<fulfilled>').toContain('OpenSlack MCP initialization failed');
    // Cordis removes a failed plugin's provided service during disposal.
    expect(ctx.get('openslackConnection')?.connected ?? false).toBe(false);
  }, 20_000);
  it('drains a full pre-initialize stderr pipe before awaiting the public MCP handshake', async () => {
    const ctx = new Context();
    onTestFinished(() => ctx.fiber.dispose());
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
    await ctx.plugin(Connection, { mode: 'read-only', workspaceRoot: fileURLToPath(new URL('.', import.meta.url)),
      cliModule: fileURLToPath(new URL('./fixtures/mcp-server-stderr.js', import.meta.url)), timeoutMs: 5_000 });
    expect(ctx.openslackConnection.connected).toBe(true);
    expect(ctx.tools.get('mcp__openslack__openslack_unreviewed_future_tool')).toBeUndefined();
    expect(ctx.openslackConnection.tool('mcp__openslack__openslack_unreviewed_future_tool')).toBeUndefined();
    expect(await ctx.openslackConnection.stop()).toMatchObject({ code: 0, signal: null, terminationRequested: false });
  }, 10_000);
  it.each(['read-only', 'task'] as const)('connects %s, keeps raw task writes private, and observes clean process close', async mode => {
    const ctx = new Context();
    onTestFinished(() => ctx.fiber.dispose());
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
    await ctx.plugin(Connection, { mode, workspaceRoot: fileURLToPath(new URL('.', import.meta.url)),
      cliModule: fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url)), principalRef: 'fixture-only', timeoutMs: 5_000 });
    expect(ctx.openslackConnection.connected).toBe(true);
    if (mode === 'task') expect(ctx.tools.get('mcp__openslack__openslack_confirm_plan')).toBeUndefined();
    const tool = ctx.openslackConnection.tool('mcp__openslack__openslack_get_activity')!;
    expect(await tool.execute({}, { signal: new AbortController().signal } as ToolRunContext)).toMatchObject({
      structuredContent: { status: 'completed' },
    });
    const receipt = await ctx.openslackConnection.stop();
    expect(receipt).toMatchObject({ code: 0, signal: null, terminationRequested: false });
    expect(ctx.openslackConnection.connected).toBe(false);
    await expect(tool.execute({}, { signal: new AbortController().signal } as ToolRunContext)).rejects.toThrow();
  });
  it('invalidates on unexpected clean server exit, refuses further calls and never reconnects', async () => {
    const ctx = new Context();
    onTestFinished(() => ctx.fiber.dispose());
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
    await ctx.plugin(Connection, { mode: 'task', workspaceRoot: fileURLToPath(new URL('.', import.meta.url)),
      cliModule: fileURLToPath(new URL('./fixtures/mcp-server.js', import.meta.url)), principalRef: 'fixture-only', timeoutMs: 5_000 });
    const tool = ctx.openslackConnection.tool('mcp__openslack__openslack_get_activity')!;
    await tool.execute({ disconnect: true }, { signal: new AbortController().signal } as ToolRunContext).catch(() => {});
    await vi.waitFor(() => expect(ctx.openslackConnection.connected).toBe(false));
    await expect(tool.execute({}, { signal: new AbortController().signal } as ToolRunContext)).rejects.toThrow();
    await expect(ctx.openslackConnection.stop()).rejects.toThrow('clean owned stop');
    expect(ctx.openslackConnection.connected).toBe(false);
  });
});

// Declaration collection loads no original runtime; execution still uses the pinned real peers.
beforeAll(async () => {
  const specifier1 = '@deepseek-ai/cordis';
  ({ Context } = await import(specifier1));
  const specifier2 = '@deepseek-ai/dsh-agent-loop-testkit';
  ({ mountAgentLoopTestDependencies } = await import(specifier2));
  const specifier3 = '../src/connection.ts';
  Connection = await import(specifier3);
});
