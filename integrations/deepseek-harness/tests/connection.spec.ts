import { Context } from '@deepseek-ai/cordis';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as Connection from '../src/connection.ts';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';

describe('externally owned native MCP over a real server process', () => {
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
