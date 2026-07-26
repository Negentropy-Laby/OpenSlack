import { describe, expect, it, vi } from 'vitest';
import type { OpenSlackMcpServer } from '@openslack/mcp';
import { mcpCommands } from '../commands/mcp.js';

function operatorContext() {
  return Object.freeze({}) as never;
}

describe('mcp command', () => {
  it('registers only the explicit serve --stdio route', () => {
    const command = mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
    });

    expect(command.commands.map((child) => child.name())).toEqual(['serve']);
    expect(command.commands[0].options.map((option) => option.long)).toEqual(['--stdio']);
    expect(command.commands[0].options[0].mandatory).toBe(true);
  });

  it('passes the injected application context to a stdio-only server', async () => {
    const serveStdio = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const createServer = vi.fn(
      () =>
        ({
          core: {},
          sdkServer: {},
          serveStdio,
          close,
        }) as unknown as OpenSlackMcpServer,
    );
    const command = mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createServer,
    });

    await command.parseAsync(['node', 'test', 'serve', '--stdio']);

    expect(createServer).toHaveBeenCalledOnce();
    expect(serveStdio).toHaveBeenCalledOnce();
  });
});
