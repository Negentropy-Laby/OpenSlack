import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createOpenSlackAgentBoundMutationComposition,
  createGovernedPlanCollaborationAuditSink,
  createOpenSlackMcpServer,
  createOpenSlackWorkflowApprovalAttestationPort,
  createOpenSlackWorkflowApprovalPort,
  type OpenSlackAgentBoundMutationComposition,
  type OpenSlackMcpContext,
  type OpenSlackMcpServer,
  type OperatorApplicationContextPort,
} from '@openslack/mcp';
import { LocalGovernedPlanStore } from '@openslack/operator';
import { LocalScenarioInstanceStore } from '@openslack/scenario-runtime';
import {
  createWorkflowEffectDecisionAuthority,
  LocalWorkflowEffectApprovalStore,
} from '@openslack/workflows';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mcpCommands, type McpCommandDependencies } from '../commands/mcp.js';
import type { OpenSlackHumanAttestedMcpComposition } from '../mcp-human-attested-composition.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sourcePack = join(repositoryRoot, 'scenarios', 'software-delivery');
const PRINCIPAL_REF = 'agent-bound-cli';
const WORKSPACE_ID = 'workspace-agent-bound-cli';
const READ_TOOL_NAMES = Object.freeze([
  'openslack_get_executive_overview',
  'openslack_list_work_items',
  'openslack_get_work_room',
  'openslack_get_activity',
  'openslack_get_workflow_progress',
  'openslack_get_pr_readiness',
  'openslack_list_pending_approvals',
  'openslack_get_business_outcomes',
  'openslack_get_notification_status',
  'openslack_list_scenarios',
  'openslack_query_graph',
  'openslack_explain_graph',
]);
const AGENT_BOUND_TOOL_NAMES = Object.freeze([
  ...READ_TOOL_NAMES,
  'openslack_preview_scenario',
  'openslack_preview_workflow',
  'openslack_confirm_plan',
  'openslack_cancel_plan',
]);
const HUMAN_ATTESTED_TOOL_NAMES = Object.freeze([
  ...AGENT_BOUND_TOOL_NAMES,
  'openslack_decide_workflow_approval',
]);
const READ_CANARY_ARGS = Object.freeze([
  '--graph-read-canary-backend',
  'ts-local',
  '--graph-read-canary-routing-epoch',
  '42',
  '--graph-read-canary-tenant',
  WORKSPACE_ID,
  '--graph-read-canary-scenarios',
  'software-delivery',
  '--graph-read-canary-expires-at',
  '2026-08-09T00:00:00.000Z',
]);
const roots: string[] = [];

function operator(): OperatorApplicationContextPort {
  return Object.freeze({}) as unknown as OperatorApplicationContextPort;
}

function registryYaml(
  options: {
    readonly action?: 'allow' | 'ask' | 'deny';
    readonly identityStatus?: 'active' | 'suspended' | 'retired';
  } = {},
): string {
  return [
    'schema: openslack.agent_registry.v2',
    `agent_id: ${PRINCIPAL_REF}`,
    'display_name: Agent Bound CLI Principal',
    'identity:',
    `  uid: ${PRINCIPAL_REF}-uid`,
    `  principal_id: principal:${PRINCIPAL_REF}`,
    '  public_key_jwk: null',
    '  key_id: null',
    '  key_rotation:',
    '    last_rotated_at: null',
    '    rotation_interval_days: 90',
    `  status: ${options.identityStatus ?? 'active'}`,
    'vendor:',
    '  provider: test',
    '  runtime: cli',
    'employment:',
    '  status: active',
    '  hired_at: "2026-01-01T00:00:00.000Z"',
    'capabilities:',
    '  primary:',
    '    - scenario_governance',
    '  secondary: []',
    'repositories:',
    '  workspace_repo:',
    '    owner: test',
    '    repo: OpenSlack',
    '    default_branch: main',
    'permissions:',
    '  paths:',
    '    allow:',
    '      - "**"',
    '    deny: []',
    '  actions:',
    `    scenario.instantiate: ${options.action ?? 'allow'}`,
    '  github:',
    '    can_create_pr: false',
    '    can_comment: false',
    '    can_approve: false',
    '    can_merge: false',
    '  max_risk_zone: yellow',
    'execution: {}',
    'output_contract:',
    '  must_create: []',
    '  may_create: []',
    '  must_not_create: []',
    'approval_rules:',
    '  require_human_approval_for: []',
    '',
  ].join('\n');
}

function runtimeIdentityYaml(): string {
  return [
    'schema: openslack.agent_runtime_identity.v1',
    `agent_id: ${PRINCIPAL_REF}`,
    `agent_uid: ${PRINCIPAL_REF}-uid`,
    'run_id: RUN-agent-bound-cli-001',
    'public_key_jwk: null',
    'key_id: null',
    'key_generated_at: null',
    'provider: cli',
    'started_at: "2026-07-28T00:00:00.000Z"',
    '',
  ].join('\n');
}

function writeRegistry(root: string, options: Parameters<typeof registryYaml>[0] = {}): void {
  writeFileSync(
    join(root, '.openslack', 'agents', 'registry', `${PRINCIPAL_REF}.yaml`),
    registryYaml(options),
    'utf8',
  );
}

function createWorkspace(
  options: {
    readonly action?: 'allow' | 'ask' | 'deny';
    readonly identityStatus?: 'active' | 'suspended' | 'retired';
  } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-mcp-cli-profile-'));
  roots.push(root);
  writeFileSync(
    join(root, 'openslack.yaml'),
    [
      'schema: openslack.workspace.v1',
      `workspace_id: ${WORKSPACE_ID}`,
      'name: Agent Bound CLI Test',
      'mode: normal',
      'canonical_remote:',
      '  provider: github',
      '  owner: test',
      '  repo: OpenSlack',
      '  default_branch: main',
      'workspace:',
      '  root: "."',
      '  state_root: ".openslack"',
      'product:',
      '  repo_role: managed',
      '  source_roots: []',
      '  protected_roots: []',
      '',
    ].join('\n'),
    'utf8',
  );
  for (const directory of [
    'agents/registry',
    'agents/prompts',
    'policies',
    'tasks',
    'leases',
    'audit',
    'collaboration',
  ]) {
    mkdirSync(join(root, '.openslack', directory), { recursive: true });
  }
  writeRegistry(root, options);
  const identityDirectory = join(root, '.openslack.local', 'agents', PRINCIPAL_REF);
  mkdirSync(identityDirectory, { recursive: true });
  writeFileSync(join(identityDirectory, 'identity.yaml'), runtimeIdentityYaml(), 'utf8');
  mkdirSync(join(root, 'scenarios'));
  cpSync(sourcePack, join(root, 'scenarios', 'software-delivery'), { recursive: true });
  return root;
}

async function runOverOfficialSdk(
  workspaceRoot: string,
  args: readonly string[],
  probe: (client: Client) => Promise<void>,
  dependencies: Partial<McpCommandDependencies> = {},
): Promise<void> {
  let probeError: unknown;
  const createServer = ((context: OpenSlackMcpContext): OpenSlackMcpServer => {
    const server = createOpenSlackMcpServer(context);
    return Object.freeze({
      core: server.core,
      sdkServer: server.sdkServer,
      async serveStdio(): Promise<void> {
        const client = new Client({ name: 'openslack-cli-profile-test', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.sdkServer.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          await probe(client);
        } catch (error) {
          probeError = error;
          throw error;
        } finally {
          try {
            await client.close();
            await server.close();
          } catch (error) {
            probeError ??= error;
            throw error;
          }
        }
      },
      close: () => server.close(),
    });
  }) as typeof createOpenSlackMcpServer;

  await mcpCommands({
    workspaceRoot,
    operator: operator(),
    ...dependencies,
    createServer,
  }).parseAsync(['node', 'test', 'serve', '--stdio', ...args]);
  if (probeError !== undefined) throw probeError;
}

function previewMetadata(result: unknown): {
  readonly planId: string;
  readonly confirmationToken: string;
  readonly correlationId: string;
} {
  const value = result as Record<string, unknown>;
  return {
    planId: String(value.planId),
    confirmationToken: String(value.confirmationToken),
    correlationId: String(value.correlationId),
  };
}

describe('MCP CLI production profiles over the official SDK', () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stdout = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it.each([
    { name: 'default', args: [] as string[] },
    { name: 'explicit', args: ['--profile', 'read-only'] },
  ])('lists exactly 12 tools for the $name read-only CLI profile', async ({ args }) => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openslack-mcp-read-only-cli-'));
    roots.push(workspaceRoot);
    await runOverOfficialSdk(workspaceRoot, args, async (client) => {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(READ_TOOL_NAMES);
    });

    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps exactly 12 read-only tools when an explicit read canary is configured', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'openslack-mcp-read-only-canary-cli-'));
    roots.push(workspaceRoot);
    const createGraphReadCanary = vi.fn(() => Object.freeze({}) as never);
    await runOverOfficialSdk(
      workspaceRoot,
      ['--profile', 'read-only', ...READ_CANARY_ARGS],
      async (client) => {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(READ_TOOL_NAMES);
      },
      { createGraphReadCanary },
    );

    expect(createGraphReadCanary).toHaveBeenCalledOnce();
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('runs the agent-bound CLI profile through preview, confirm, replay, and durable readback', async () => {
    const workspaceRoot = createWorkspace();
    let composition: OpenSlackAgentBoundMutationComposition | undefined;
    let correlationId = '';
    let scenarioInstanceId = '';
    const createAgentBoundComposition: typeof createOpenSlackAgentBoundMutationComposition = async (
      options,
    ) => {
      composition = await createOpenSlackAgentBoundMutationComposition(options);
      return composition;
    };

    await runOverOfficialSdk(
      workspaceRoot,
      [
        '--profile',
        'agent-bound',
        '--principal-ref',
        PRINCIPAL_REF,
        '--workspace-id',
        WORKSPACE_ID,
        ...READ_CANARY_ARGS,
      ],
      async (client) => {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
          AGENT_BOUND_TOOL_NAMES,
        );
        const unknown = await client.callTool({
          name: 'openslack_preview_scenario',
          arguments: { scenarioId: 'unknown-scenario', input: {} },
        });
        expect(unknown.structuredContent).toMatchObject({
          status: 'blocked',
          governance: { blocker: 'GOVERNED_SCENARIO_NOT_REGISTERED' },
        });

        const preview = await client.callTool({
          name: 'openslack_preview_scenario',
          arguments: { scenarioId: 'software-delivery', input: {} },
        });
        const metadata = previewMetadata(preview.structuredContent);
        correlationId = metadata.correlationId;
        const confirmed = await client.callTool({
          name: 'openslack_confirm_plan',
          arguments: {
            planId: metadata.planId,
            confirmationToken: metadata.confirmationToken,
          },
        });
        expect(confirmed.structuredContent).toMatchObject({
          status: 'completed',
          correlationId,
          data: {
            state: 'succeeded',
            outcomes: [
              {
                status: 'succeeded',
                data: {
                  state: 'active',
                  revision: expect.stringMatching(/^[0-9a-f]{64}$/),
                },
              },
            ],
          },
        });
        const output = confirmed.structuredContent as {
          data: { outcomes: Array<{ data: { scenarioInstanceId: string } }> };
        };
        scenarioInstanceId = output.data.outcomes[0]!.data.scenarioInstanceId;

        const replay = await client.callTool({
          name: 'openslack_confirm_plan',
          arguments: {
            planId: metadata.planId,
            confirmationToken: metadata.confirmationToken,
          },
        });
        expect(replay.structuredContent).toMatchObject({
          status: 'blocked',
          governance: { blocker: 'GOVERNED_PLAN_STATE_INVALID' },
        });
      },
      {
        createAgentBoundComposition,
        createGraphReadCanary: vi.fn(() => Object.freeze({}) as never),
      },
    );

    expect(composition).toBeDefined();
    expect(
      await new LocalScenarioInstanceStore(
        composition!.scenarioInstanceRoot,
        correlationId,
      ).readWithRevision(scenarioInstanceId),
    ).toMatchObject({
      revision: expect.stringMatching(/^[0-9a-f]{64}$/),
      instance: {
        id: scenarioInstanceId,
        state: 'active',
        correlationId,
      },
    });
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('keeps the CLI-created plan pending when permission drifts before confirmation', async () => {
    const workspaceRoot = createWorkspace();
    let composition: OpenSlackAgentBoundMutationComposition | undefined;
    let planId = '';
    const createAgentBoundComposition: typeof createOpenSlackAgentBoundMutationComposition = async (
      options,
    ) => {
      composition = await createOpenSlackAgentBoundMutationComposition(options);
      return composition;
    };

    await runOverOfficialSdk(
      workspaceRoot,
      ['--profile', 'agent-bound', '--principal-ref', PRINCIPAL_REF],
      async (client) => {
        const preview = await client.callTool({
          name: 'openslack_preview_scenario',
          arguments: { scenarioId: 'software-delivery', input: {} },
        });
        const metadata = previewMetadata(preview.structuredContent);
        planId = metadata.planId;
        writeRegistry(workspaceRoot, { action: 'deny' });
        const confirmed = await client.callTool({
          name: 'openslack_confirm_plan',
          arguments: {
            planId,
            confirmationToken: metadata.confirmationToken,
          },
        });
        expect(confirmed.structuredContent).toMatchObject({
          status: 'blocked',
          governance: { blocker: 'GOVERNED_ACTION_NOT_AUTHORIZED' },
        });
      },
      { createAgentBoundComposition },
    );

    expect(
      await new LocalGovernedPlanStore(composition!.governedPlanRoot).load(planId),
    ).toMatchObject({ state: 'pending', revision: 1 });
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it('exposes exactly 17 tools and records one separately attested decision over the official SDK', async () => {
    const workspaceRoot = createWorkspace();
    let approvalStore: LocalWorkflowEffectApprovalStore | undefined;
    const createHumanAttestedComposition = async (
      options: Parameters<NonNullable<McpCommandDependencies['createHumanAttestedComposition']>>[0],
    ): Promise<OpenSlackHumanAttestedMcpComposition> => {
      expect(options.governanceAuthority).toEqual({
        backend: 'go',
        routingEpoch: 7,
        tenantId: WORKSPACE_ID,
        origin: 'http://10.20.30.40:18082',
        networkMode: 'internal',
        expectedBuildSha: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        callerId: 'qoder.mcp',
        expiresAt: '2026-08-09T00:00:00.000Z',
      });
      const agent = await createOpenSlackAgentBoundMutationComposition({
        workspaceRoot: options.workspaceRoot,
        principalRef: options.principalRef,
        provider: 'cli',
        ...(options.workspaceIdAssertion === undefined
          ? {}
          : { workspaceIdAssertion: options.workspaceIdAssertion }),
      });
      const authority = createWorkflowEffectDecisionAuthority({
        workspaceId: agent.authority.workspaceId,
        humanPrincipalIds: [options.humanPrincipalAssertion],
        capabilities: ['workflow.effect.decide'],
        maxBindingTtlMs: 60_000,
      });
      const approvalRoot = join(workspaceRoot, 'workflow-effect-approvals');
      mkdirSync(approvalRoot);
      const store = new LocalWorkflowEffectApprovalStore(approvalRoot, authority);
      approvalStore = store;
      const now = Date.now();
      await store.createPending({
        runId: 'run-human-attested-001',
        approvalId: 'approval-human-attested-001',
        correlationId: 'correlation-human-attested-001',
        workflowId: 'delivery.create',
        workflowVersion: '1.0.0',
        workflowHash: 'a'.repeat(64),
        inputHash: 'b'.repeat(64),
        effectId: `workflow-effect:sha256:${'c'.repeat(64)}`,
        effectHash: 'c'.repeat(64),
        requiredCapability: 'workflow.effect.decide',
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 120_000).toISOString(),
      });
      const attestation = createOpenSlackWorkflowApprovalAttestationPort((request) =>
        authority.issueHumanDecisionBinding({
          principalId: options.humanPrincipalAssertion,
          capability: request.requiredCapability,
          runId: request.runId,
          approvalId: request.approvalId,
          correlationId: request.correlationId,
          approvalExpiresAt: request.approvalExpiresAt,
          decision: request.decision,
          reasonHash: request.reasonHash,
          expiresAt: new Date(
            Math.min(Date.now() + 30_000, Date.parse(request.approvalExpiresAt)),
          ).toISOString(),
        }),
      );
      return Object.freeze({
        ...agent,
        humanPrincipalId: options.humanPrincipalAssertion,
        workflowApprovalAuthority: createOpenSlackWorkflowApprovalPort({
          store,
          attestation,
          audit: createGovernedPlanCollaborationAuditSink(workspaceRoot),
        }),
        workflowApprovalStoreRoot: approvalRoot,
      });
    };

    await runOverOfficialSdk(
      workspaceRoot,
      [
        '--profile',
        'human-attested',
        '--principal-ref',
        PRINCIPAL_REF,
        '--human-principal',
        'human.interviewer',
        '--workspace-id',
        WORKSPACE_ID,
        '--governance-authority-backend',
        'go',
        '--governance-authority-routing-epoch',
        '7',
        '--governance-authority-tenant',
        WORKSPACE_ID,
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
        ...READ_CANARY_ARGS,
      ],
      async (client) => {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
          HUMAN_ATTESTED_TOOL_NAMES,
        );
        const decision = await client.callTool({
          name: 'openslack_decide_workflow_approval',
          arguments: {
            runId: 'run-human-attested-001',
            approvalId: 'approval-human-attested-001',
            decision: 'approved',
            reason: 'The local human reviewed the exact effect evidence.',
          },
        });
        expect(decision.structuredContent).toMatchObject({
          status: 'completed',
          correlationId: 'correlation-human-attested-001',
          governance: { owner: 'human.interviewer' },
          data: { status: 'approved', auditProjection: 'recorded' },
        });
        expect(JSON.stringify(decision.structuredContent)).not.toContain('attestationNonce');
        expect(
          await approvalStore!.read('run-human-attested-001', 'approval-human-attested-001'),
        ).toMatchObject({
          revision: 2,
          status: 'approved',
          auditProjection: { status: 'recorded' },
        });
      },
      {
        createHumanAttestedComposition,
        createGraphReadCanary: vi.fn(() => Object.freeze({}) as never),
      },
    );

    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'inactive principal',
      workspace: () => createWorkspace({ identityStatus: 'suspended' }),
      args: ['--profile', 'agent-bound', '--principal-ref', PRINCIPAL_REF],
    },
    {
      name: 'workspace assertion mismatch',
      workspace: () => createWorkspace(),
      args: [
        '--profile',
        'agent-bound',
        '--principal-ref',
        PRINCIPAL_REF,
        '--workspace-id',
        'other-workspace',
      ],
    },
  ])('fails $name before exposing any CLI catalog', async ({ workspace, args }) => {
    const createServer = vi.fn();
    await mcpCommands({
      workspaceRoot: workspace(),
      operator: operator(),
      createServer,
    }).parseAsync(['node', 'test', 'serve', '--stdio', ...args]);

    expect(createServer).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenLastCalledWith(
      'OPENSLACK_MCP_START_FAILED: the requested stdio profile did not start.',
    );
    expect(stdout).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
