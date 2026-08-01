import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OpenSlackAgentBoundMutationComposition,
  OpenSlackMcpContext,
  OpenSlackMcpServer,
} from '@openslack/mcp';
import type { OpenSlackHumanAttestedMcpComposition } from '../mcp-human-attested-composition.js';
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

  it('registers the local attestation routes, explicit stdio route, and three exact profiles', () => {
    const command = mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
    });

    expect(command.commands.map((child) => child.name())).toEqual(['attestation', 'serve']);
    expect(command.commands[0].commands.map((child) => child.name())).toEqual([
      'status',
      'bind-local-subject',
    ]);
    expect(command.commands[0].commands[1].options.map((option) => option.long)).toEqual([
      '--human-principal',
      '--confirm',
    ]);
    expect(command.commands[1].options.map((option) => option.long)).toEqual([
      '--stdio',
      '--profile',
      '--principal-ref',
      '--human-principal',
      '--workspace-id',
      '--graph-read-mirror-origin',
      '--graph-read-mirror-network',
    ]);
    expect(command.commands[1].options[0].mandatory).toBe(true);
    expect(command.commands[1].options[1]).toMatchObject({
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
    const createGraphReadMirror = vi.fn();
    const createdServer = server();
    const createServer = vi.fn(() => createdServer);
    const command = mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createContext,
      createAgentBoundComposition,
      createGraphReadMirror,
      createServer,
    });

    await command.parseAsync(['node', 'test', 'serve', '--stdio', ...args]);

    expect(createContext).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      operator: expect.anything(),
    });
    expect(createAgentBoundComposition).not.toHaveBeenCalled();
    expect(createGraphReadMirror).not.toHaveBeenCalled();
    expect(createServer).toHaveBeenCalledWith(context);
    expect(createdServer.serveStdio).toHaveBeenCalledOnce();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('binds agent-bound through the production composition before creating the server', async () => {
    const governedMutations = Object.freeze({}) as never;
    const graphReadMirror = Object.freeze({}) as never;
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
    const createGraphReadMirror = vi.fn(() => graphReadMirror);
    const createdServer = server();
    const createServer = vi.fn(() => createdServer);

    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createAgentBoundComposition,
      createGraphReadMirror,
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
      '--graph-read-mirror-origin',
      'http://127.0.0.1:18181',
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
      graphReadMirror,
      governedMutations,
    });
    expect(createGraphReadMirror).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      origin: 'http://127.0.0.1:18181',
      networkMode: 'loopback',
    });
    expect(createServer).toHaveBeenCalledWith(context);
    expect(createdServer.serveStdio).toHaveBeenCalledOnce();
  });

  it('binds an explicit internal Go read mirror without changing the selected profile', async () => {
    const graphReadMirror = Object.freeze({}) as never;
    const createGraphReadMirror = vi.fn(() => graphReadMirror);
    const context = Object.freeze({}) as OpenSlackMcpContext;
    const createContext = vi.fn(() => context);
    const createdServer = server();

    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createGraphReadMirror,
      createContext,
      createServer: vi.fn(() => createdServer),
    }).parseAsync([
      'node',
      'test',
      'serve',
      '--stdio',
      '--profile',
      'read-only',
      '--graph-read-mirror-origin',
      'http://10.20.30.40:18181',
      '--graph-read-mirror-network',
      'internal',
    ]);

    expect(createGraphReadMirror).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      origin: 'http://10.20.30.40:18181',
      networkMode: 'internal',
    });
    expect(createContext).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      operator: expect.anything(),
      graphReadMirror,
    });
    expect(createdServer.serveStdio).toHaveBeenCalledOnce();
    expect(stderr).not.toHaveBeenCalled();
  });

  it('rejects a read-mirror network mode without an explicit origin before composition', async () => {
    const createGraphReadMirror = vi.fn();
    const createContext = vi.fn();
    const createServer = vi.fn();

    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createGraphReadMirror,
      createContext,
      createServer,
    }).parseAsync(['node', 'test', 'serve', '--stdio', '--graph-read-mirror-network', 'internal']);

    expect(stderr).toHaveBeenLastCalledWith(
      'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: --graph-read-mirror-network requires --graph-read-mirror-origin.',
    );
    expect(createGraphReadMirror).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('rejects an unsafe mirror origin before binding agent authority or audit state', async () => {
    const createAgentBoundComposition = vi.fn();
    const createGraphReadMirror = vi.fn();
    const createContext = vi.fn();
    const createServer = vi.fn();

    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createAgentBoundComposition,
      createGraphReadMirror,
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
      '--graph-read-mirror-origin',
      'http://8.8.8.8:18181',
    ]);

    expect(createAgentBoundComposition).not.toHaveBeenCalled();
    expect(createGraphReadMirror).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('binds human-attested through a separate composition and exposes exactly its approval port', async () => {
    const governedMutations = Object.freeze({}) as never;
    const workflowApprovalAuthority = Object.freeze({}) as never;
    const graphReadMirror = Object.freeze({}) as never;
    const composition = Object.freeze({
      authority: Object.freeze({
        actorId: 'agent-principal:sha256:test',
        workspaceId: 'workspace-test',
      }),
      governedMutations,
      governedPlanRoot: 'plan-root',
      scenarioInstanceRoot: 'scenario-root',
      scenarioIds: Object.freeze(['software-delivery']),
      humanPrincipalId: 'human.interviewer',
      workflowApprovalAuthority,
      workflowApprovalStoreRoot: 'approval-root',
    }) as OpenSlackHumanAttestedMcpComposition;
    const context = Object.freeze({}) as OpenSlackMcpContext;
    const createHumanAttestedComposition = vi.fn(async () => composition);
    const createAgentBoundComposition = vi.fn();
    const createGraphReadMirror = vi.fn(() => graphReadMirror);
    const createContext = vi.fn(() => context);
    const createdServer = server();

    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createAgentBoundComposition,
      createHumanAttestedComposition,
      createGraphReadMirror,
      createContext,
      createServer: vi.fn(() => createdServer),
    }).parseAsync([
      'node',
      'test',
      'serve',
      '--stdio',
      '--profile',
      'human-attested',
      '--principal-ref',
      'agent-1',
      '--human-principal',
      'human.interviewer',
      '--workspace-id',
      'workspace-test',
      '--graph-read-mirror-origin',
      'http://127.0.0.1:18181',
    ]);

    expect(createAgentBoundComposition).not.toHaveBeenCalled();
    expect(createHumanAttestedComposition).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      principalRef: 'agent-1',
      humanPrincipalAssertion: 'human.interviewer',
      workspaceIdAssertion: 'workspace-test',
    });
    expect(createContext).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      operator: expect.anything(),
      graphReadMirror,
      governedMutations,
      workflowApprovalAuthority,
    });
    expect(createGraphReadMirror).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      origin: 'http://127.0.0.1:18181',
      networkMode: 'loopback',
    });
    expect(createdServer.serveStdio).toHaveBeenCalledOnce();
  });

  it('reports and binds local attestation without exposing an OS subject', async () => {
    const status = Object.freeze({
      schema: 'openslack.local_human_attestation_status.v1' as const,
      state: 'ready' as const,
      version: 1 as const,
      humanPrincipalId: 'human.interviewer',
      ttyAvailable: true,
    });
    const getAttestationStatus = vi.fn(() => status);
    const bindLocalSubject = vi.fn(() => status);
    const command = mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      getAttestationStatus,
      bindLocalSubject,
    });

    await command.parseAsync(['node', 'test', 'attestation', 'status']);
    await command.parseAsync([
      'node',
      'test',
      'attestation',
      'bind-local-subject',
      '--human-principal',
      'human.interviewer',
      '--confirm',
    ]);

    expect(getAttestationStatus).toHaveBeenCalledWith(process.cwd());
    expect(bindLocalSubject).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      humanPrincipalId: 'human.interviewer',
      confirmed: true,
    });
    expect(stdout).toHaveBeenCalledTimes(2);
    expect(stdout.mock.calls.flat().join('\n')).not.toMatch(/subjectHash|windows-sid|posix:/i);
    expect(stderr).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'principal authority on read-only',
      args: [
        '--profile',
        'read-only',
        '--principal-ref',
        'agent-1',
        '--graph-read-mirror-origin',
        'http://127.0.0.1:18181',
      ],
      message:
        'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: read-only does not accept authority-binding arguments.',
    },
    {
      name: 'workspace authority on read-only',
      args: ['--workspace-id', 'workspace-test'],
      message:
        'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: read-only does not accept authority-binding arguments.',
    },
    {
      name: 'human authority on read-only',
      args: ['--human-principal', 'human.interviewer'],
      message:
        'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: read-only does not accept authority-binding arguments.',
    },
    {
      name: 'missing principal on agent-bound',
      args: ['--profile', 'agent-bound'],
      message: 'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: agent-bound requires --principal-ref.',
    },
    {
      name: 'human principal on agent-bound',
      args: [
        '--profile',
        'agent-bound',
        '--principal-ref',
        'agent-1',
        '--human-principal',
        'human.interviewer',
      ],
      message:
        'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: agent-bound does not accept --human-principal.',
    },
    {
      name: 'missing agent principal on human-attested',
      args: ['--profile', 'human-attested', '--human-principal', 'human.interviewer'],
      message: 'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: human-attested requires --principal-ref.',
    },
    {
      name: 'missing human principal on human-attested',
      args: ['--profile', 'human-attested', '--principal-ref', 'agent-1'],
      message: 'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: human-attested requires --human-principal.',
    },
  ])('rejects $name before composition or server creation', async ({ args, message }) => {
    const createAgentBoundComposition = vi.fn();
    const createHumanAttestedComposition = vi.fn();
    const createGraphReadMirror = vi.fn();
    const createContext = vi.fn();
    const createServer = vi.fn();

    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createAgentBoundComposition,
      createHumanAttestedComposition,
      createGraphReadMirror,
      createContext,
      createServer,
    }).parseAsync(['node', 'test', 'serve', '--stdio', ...args]);

    expect(stderr).toHaveBeenLastCalledWith(message);
    expect(stdout).not.toHaveBeenCalled();
    expect(createAgentBoundComposition).not.toHaveBeenCalled();
    expect(createHumanAttestedComposition).not.toHaveBeenCalled();
    expect(createGraphReadMirror).not.toHaveBeenCalled();
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
