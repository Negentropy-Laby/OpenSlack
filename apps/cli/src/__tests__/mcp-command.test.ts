import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OpenSlackAgentBoundMutationComposition,
  OpenSlackMcpContext,
  OpenSlackMcpServer,
} from '@openslack/mcp';
import { mcpCommands, OPENSLACK_MCP_CLI_PROFILES } from '../commands/mcp.js';

function operatorContext() {
  return Object.freeze({}) as never;
}

function server() {
  return {
    core: {},
    sdkServer: {},
    serveStdio: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as OpenSlackMcpServer;
}

describe('mcp command', () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('registers only the explicit stdio route and two exact profiles', () => {
    const command = mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
    });

    expect(command.commands.map((child) => child.name())).toEqual(['serve']);
    expect(command.commands[0].options.map((option) => option.long)).toEqual([
      '--stdio',
      '--profile',
      '--principal-ref',
      '--workspace-id',
    ]);
    expect(command.commands[0].options[0].mandatory).toBe(true);
    expect(command.commands[0].options[1]).toMatchObject({
      argChoices: [...OPENSLACK_MCP_CLI_PROFILES],
      defaultValue: 'read-only',
    });
  });

  it.each([
    { name: 'default', args: [] as string[] },
    { name: 'explicit', args: ['--profile', 'read-only'] },
  ])('keeps the $name read-only profile free of mutation authority', async ({ args }) => {
    const context = Object.freeze({}) as OpenSlackMcpContext;
    const createContext = vi.fn(() => context);
    const createAgentBoundComposition = vi.fn();
    const createdServer = server();
    const createServer = vi.fn(() => createdServer);
    const command = mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createContext,
      createAgentBoundComposition,
      createServer,
    });

    await command.parseAsync(['node', 'test', 'serve', '--stdio', ...args]);

    expect(createContext).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      operator: expect.anything(),
    });
    expect(createAgentBoundComposition).not.toHaveBeenCalled();
    expect(createServer).toHaveBeenCalledWith(context);
    expect(createdServer.serveStdio).toHaveBeenCalledOnce();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('binds agent-bound through the production composition before creating the server', async () => {
    const governedMutations = Object.freeze({}) as never;
    const composition = Object.freeze({
      authority: Object.freeze({
        actorId: 'agent-principal:sha256:test',
        workspaceId: 'workspace-test',
      }),
      governedMutations,
      governedPlanRoot: 'plan-root',
      scenarioInstanceRoot: 'scenario-root',
      scenarioIds: Object.freeze(['software-delivery']),
    }) as OpenSlackAgentBoundMutationComposition;
    const context = Object.freeze({}) as OpenSlackMcpContext;
    const createAgentBoundComposition = vi.fn(async () => composition);
    const createContext = vi.fn(() => context);
    const createdServer = server();
    const createServer = vi.fn(() => createdServer);

    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createAgentBoundComposition,
      createContext,
      createServer,
    }).parseAsync([
      'node',
      'test',
      'serve',
      '--stdio',
      '--profile',
      'agent-bound',
      '--principal-ref',
      'agent-1',
      '--workspace-id',
      'workspace-test',
    ]);

    expect(createAgentBoundComposition).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      principalRef: 'agent-1',
      provider: 'cli',
      workspaceIdAssertion: 'workspace-test',
    });
    expect(createContext).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      operator: expect.anything(),
      governedMutations,
    });
    expect(createServer).toHaveBeenCalledWith(context);
    expect(createdServer.serveStdio).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: 'principal authority on read-only',
      args: ['--profile', 'read-only', '--principal-ref', 'agent-1'],
      message:
        'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: read-only does not accept --principal-ref or --workspace-id.',
    },
    {
      name: 'workspace authority on read-only',
      args: ['--workspace-id', 'workspace-test'],
      message:
        'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: read-only does not accept --principal-ref or --workspace-id.',
    },
    {
      name: 'missing principal on agent-bound',
      args: ['--profile', 'agent-bound'],
      message: 'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: agent-bound requires --principal-ref.',
    },
  ])('rejects $name before composition or server creation', async ({ args, message }) => {
    const createAgentBoundComposition = vi.fn();
    const createContext = vi.fn();
    const createServer = vi.fn();

    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createAgentBoundComposition,
      createContext,
      createServer,
    }).parseAsync(['node', 'test', 'serve', '--stdio', ...args]);

    expect(stderr).toHaveBeenLastCalledWith(message);
    expect(stdout).not.toHaveBeenCalled();
    expect(createAgentBoundComposition).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('fails closed without exposing composition diagnostics or a partial catalog', async () => {
    const createAgentBoundComposition = vi.fn(async () => {
      throw new Error('sensitive local path');
    });
    const createContext = vi.fn();
    const createServer = vi.fn();

    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createAgentBoundComposition,
      createContext,
      createServer,
    }).parseAsync([
      'node',
      'test',
      'serve',
      '--stdio',
      '--profile',
      'agent-bound',
      '--principal-ref',
      'agent-1',
    ]);

    expect(stderr).toHaveBeenLastCalledWith(
      'OPENSLACK_MCP_START_FAILED: the requested stdio profile did not start.',
    );
    expect(String(stderr.mock.calls[0]?.[0])).not.toContain('sensitive local path');
    expect(stdout).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
