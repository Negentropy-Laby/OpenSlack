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
      '--graph-read-canary-backend',
      '--graph-read-canary-routing-epoch',
      '--graph-read-canary-tenant',
      '--graph-read-canary-scenarios',
      '--graph-read-canary-expires-at',
      '--graph-read-canary-origin',
      '--graph-read-canary-network',
      '--graph-read-canary-build-sha',
      '--graph-read-authority-backend',
      '--graph-read-authority-routing-epoch',
      '--graph-read-authority-tenant',
      '--graph-read-authority-expires-at',
      '--graph-read-authority-origin',
      '--graph-read-authority-network',
      '--graph-read-authority-build-sha',
      '--governance-authority-backend',
      '--governance-authority-routing-epoch',
      '--governance-authority-tenant',
      '--governance-authority-origin',
      '--governance-authority-network',
      '--governance-authority-build-sha',
      '--governance-authority-caller',
      '--governance-authority-expires-at',
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

  it('binds the same host-only Go governance authority into agent-bound composition', async () => {
    const composition = Object.freeze({
      authority: Object.freeze({ actorId: 'agent.test', workspaceId: 'workspace-test' }),
      governedMutations: Object.freeze({}) as never,
      governedPlanRoot: 'plan-root',
      scenarioInstanceRoot: 'scenario-root',
      scenarioIds: Object.freeze(['software-delivery']),
    }) as OpenSlackAgentBoundMutationComposition;
    const createAgentBoundComposition = vi.fn(async () => composition);
    const context = Object.freeze({}) as OpenSlackMcpContext;
    const createdServer = server();

    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createAgentBoundComposition,
      createContext: vi.fn(() => context),
      createServer: vi.fn(() => createdServer),
    }).parseAsync([
      'node',
      'test',
      'serve',
      '--stdio',
      '--profile',
      'agent-bound',
      '--principal-ref',
      'agent-1',
      '--governance-authority-backend',
      'go',
      '--governance-authority-routing-epoch',
      '7',
      '--governance-authority-tenant',
      'workspace-test',
      '--governance-authority-origin',
      'http://10.20.30.40:18082',
      '--governance-authority-network',
      'internal',
      '--governance-authority-build-sha',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '--governance-authority-caller',
      'qoder.mcp',
      '--governance-authority-expires-at',
      '2026-08-04T00:00:00.000Z',
    ]);

    expect(createAgentBoundComposition).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      principalRef: 'agent-1',
      provider: 'cli',
      governanceAuthority: {
        backend: 'go',
        routingEpoch: 7,
        tenantId: 'workspace-test',
        origin: 'http://10.20.30.40:18082',
        networkMode: 'internal',
        expectedBuildSha: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        callerId: 'qoder.mcp',
        expiresAt: '2026-08-04T00:00:00.000Z',
      },
    });
    expect(createdServer.serveStdio).toHaveBeenCalledOnce();
  });

  it('reports exact missing governance-control transport flags before composition', async () => {
    const createAgentBoundComposition = vi.fn();
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
      '--governance-authority-backend',
      'go',
      '--governance-authority-routing-epoch',
      '7',
      '--governance-authority-tenant',
      'workspace-test',
      '--governance-authority-origin',
      'http://127.0.0.1:18082',
    ]);

    expect(stderr).toHaveBeenLastCalledWith(
      'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: Governance-control transport is incomplete; missing --governance-authority-build-sha, --governance-authority-caller, --governance-authority-expires-at.',
    );
    expect(createAgentBoundComposition).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
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

  it('binds one exact Go canary without changing the read-only tool profile', async () => {
    const graphReadCanary = Object.freeze({}) as never;
    const createGraphReadCanary = vi.fn(() => graphReadCanary);
    const context = Object.freeze({}) as OpenSlackMcpContext;
    const createContext = vi.fn(() => context);
    const createdServer = server();

    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createGraphReadCanary,
      createContext,
      createServer: vi.fn(() => createdServer),
    }).parseAsync([
      'node',
      'test',
      'serve',
      '--stdio',
      '--profile',
      'read-only',
      '--graph-read-canary-backend',
      'go',
      '--graph-read-canary-routing-epoch',
      '41',
      '--graph-read-canary-tenant',
      'openslack-self',
      '--graph-read-canary-scenarios',
      'scenario-a,scenario-b',
      '--graph-read-canary-expires-at',
      '2026-08-03T00:00:00.000Z',
      '--graph-read-canary-origin',
      'http://10.20.30.40:18181',
      '--graph-read-canary-network',
      'internal',
      '--graph-read-canary-build-sha',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ]);

    expect(createGraphReadCanary).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      backend: 'go',
      tenantId: 'openslack-self',
      scenarioInstanceIds: ['scenario-a', 'scenario-b'],
      routingEpoch: 41,
      expiresAt: '2026-08-03T00:00:00.000Z',
      origin: 'http://10.20.30.40:18181',
      networkMode: 'internal',
      expectedBuildSha: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
    expect(createContext).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      operator: expect.anything(),
      graphReadCanary,
    });
    expect(createdServer.serveStdio).toHaveBeenCalledOnce();
  });

  it('binds an explicit higher-epoch ts-local rollback without Go transport state', async () => {
    const graphReadCanary = Object.freeze({}) as never;
    const createGraphReadCanary = vi.fn(() => graphReadCanary);
    const context = Object.freeze({}) as OpenSlackMcpContext;
    const createContext = vi.fn(() => context);

    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createGraphReadCanary,
      createContext,
      createServer: vi.fn(() => server()),
    }).parseAsync([
      'node',
      'test',
      'serve',
      '--stdio',
      '--graph-read-canary-backend',
      'ts-local',
      '--graph-read-canary-routing-epoch',
      '42',
      '--graph-read-canary-tenant',
      'openslack-self',
      '--graph-read-canary-scenarios',
      'scenario-a',
      '--graph-read-canary-expires-at',
      '2026-08-03T00:00:00.000Z',
    ]);

    expect(createGraphReadCanary).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      backend: 'ts-local',
      tenantId: 'openslack-self',
      scenarioInstanceIds: ['scenario-a'],
      routingEpoch: 42,
      expiresAt: '2026-08-03T00:00:00.000Z',
    });
    expect(createContext).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      operator: expect.anything(),
      graphReadCanary,
    });
  });

  it('binds one global Go read authority without changing the exact tool profile', async () => {
    const graphReadAuthority = Object.freeze({}) as never;
    const createGraphReadAuthority = vi.fn(() => graphReadAuthority);
    const context = Object.freeze({}) as OpenSlackMcpContext;
    const createContext = vi.fn(() => context);

    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createGraphReadAuthority,
      createContext,
      createServer: vi.fn(() => server()),
    }).parseAsync([
      'node',
      'test',
      'serve',
      '--stdio',
      '--graph-read-authority-backend',
      'go',
      '--graph-read-authority-routing-epoch',
      '42',
      '--graph-read-authority-tenant',
      'openslack-self',
      '--graph-read-authority-expires-at',
      '2026-08-03T00:00:00.000Z',
      '--graph-read-authority-origin',
      'http://127.0.0.1:18181',
      '--graph-read-authority-build-sha',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    ]);

    expect(createGraphReadAuthority).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      backend: 'go',
      tenantId: 'openslack-self',
      routingEpoch: 42,
      expiresAt: '2026-08-03T00:00:00.000Z',
      origin: 'http://127.0.0.1:18181',
      expectedBuildSha: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
    expect(createContext).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      operator: expect.anything(),
      graphReadAuthority,
    });
  });

  it('rejects global authority combined with mirror or canary before composition', async () => {
    const createGraphReadAuthority = vi.fn();
    const createGraphReadCanary = vi.fn();
    const createGraphReadMirror = vi.fn();
    const createContext = vi.fn();
    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createGraphReadAuthority,
      createGraphReadCanary,
      createGraphReadMirror,
      createContext,
      createServer: vi.fn(),
    }).parseAsync([
      'node',
      'test',
      'serve',
      '--stdio',
      '--graph-read-authority-backend',
      'ts-local',
      '--graph-read-authority-routing-epoch',
      '43',
      '--graph-read-authority-tenant',
      'openslack-self',
      '--graph-read-authority-expires-at',
      '2026-08-03T00:00:00.000Z',
      '--graph-read-mirror-origin',
      'http://127.0.0.1:18181',
    ]);
    expect(stderr).toHaveBeenLastCalledWith(
      'OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: Graph read authority is mutually exclusive with mirror and canary routing.',
    );
    expect(createGraphReadAuthority).not.toHaveBeenCalled();
    expect(createGraphReadCanary).not.toHaveBeenCalled();
    expect(createGraphReadMirror).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'partial policy',
      args: ['--graph-read-canary-backend', 'go'],
      message: 'Graph read canary requires backend, routing epoch, tenant, scenarios, and expiry.',
    },
    {
      name: 'noncanonical epoch',
      args: [
        '--graph-read-canary-backend',
        'go',
        '--graph-read-canary-routing-epoch',
        '041',
        '--graph-read-canary-tenant',
        'openslack-self',
        '--graph-read-canary-scenarios',
        'scenario-a',
        '--graph-read-canary-expires-at',
        '2026-08-03T00:00:00.000Z',
      ],
      message: '--graph-read-canary-routing-epoch must be canonical.',
    },
    {
      name: 'Go without build and origin',
      args: [
        '--graph-read-canary-backend',
        'go',
        '--graph-read-canary-routing-epoch',
        '41',
        '--graph-read-canary-tenant',
        'openslack-self',
        '--graph-read-canary-scenarios',
        'scenario-a',
        '--graph-read-canary-expires-at',
        '2026-08-03T00:00:00.000Z',
      ],
      message: 'Go graph read canary requires origin and build SHA.',
    },
  ])('rejects $name before creating authority state', async ({ args, message }) => {
    const createGraphReadCanary = vi.fn();
    const createContext = vi.fn();
    const createServer = vi.fn();
    await mcpCommands({
      workspaceRoot: process.cwd(),
      operator: operatorContext(),
      createGraphReadCanary,
      createContext,
      createServer,
    }).parseAsync(['node', 'test', 'serve', '--stdio', ...args]);
    expect(stderr).toHaveBeenLastCalledWith(`OPENSLACK_MCP_PROFILE_ARGUMENT_INVALID: ${message}`);
    expect(createGraphReadCanary).not.toHaveBeenCalled();
    expect(createContext).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
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
      '--governance-authority-backend',
      'go',
      '--governance-authority-routing-epoch',
      '7',
      '--governance-authority-tenant',
      'workspace-test',
      '--governance-authority-origin',
      'http://10.20.30.40:18082',
      '--governance-authority-network',
      'internal',
      '--governance-authority-build-sha',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      '--governance-authority-caller',
      'qoder.mcp',
      '--governance-authority-expires-at',
      '2026-08-09T00:00:00.000Z',
    ]);

    expect(createAgentBoundComposition).not.toHaveBeenCalled();
    expect(createHumanAttestedComposition).toHaveBeenCalledWith({
      workspaceRoot: process.cwd(),
      principalRef: 'agent-1',
      humanPrincipalAssertion: 'human.interviewer',
      workspaceIdAssertion: 'workspace-test',
      governanceAuthority: {
        backend: 'go',
        routingEpoch: 7,
        tenantId: 'workspace-test',
        origin: 'http://10.20.30.40:18082',
        networkMode: 'internal',
        expectedBuildSha: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        callerId: 'qoder.mcp',
        expiresAt: '2026-08-09T00:00:00.000Z',
      },
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
      name: 'governance mutation authority on read-only',
      args: [
        '--governance-authority-backend',
        'ts-local',
        '--governance-authority-routing-epoch',
        '2',
        '--governance-authority-tenant',
        'workspace-test',
      ],
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

  it('does not construct a server when composition startup recovery rejects', async () => {
    const createAgentBoundComposition = vi.fn(async (input: unknown) => {
      expect(input).toMatchObject({
        governanceAuthority: {
          backend: 'ts-local',
          routingEpoch: 41,
          tenantId: 'workspace-test',
        },
      });
      throw Object.assign(new Error('startup audit recovery failed'), {
        code: 'GOVERNED_COMPOSITION_STORAGE_UNAVAILABLE',
      });
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
      '--governance-authority-backend',
      'ts-local',
      '--governance-authority-routing-epoch',
      '41',
      '--governance-authority-tenant',
      'workspace-test',
    ]);

    expect(createAgentBoundComposition).toHaveBeenCalledOnce();
    expect(createContext).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenLastCalledWith(
      'OPENSLACK_MCP_START_FAILED: the requested stdio profile did not start.',
    );
    expect(process.exitCode).toBe(1);
  });
});
