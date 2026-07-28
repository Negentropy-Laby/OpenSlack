import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readEvents } from '@openslack/collaboration';
import { LocalGovernedPlanStore } from '@openslack/operator';
import {
  OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES,
  OPENSLACK_READ_TOOL_NAMES,
} from '@openslack/qoder-adapter';
import { LocalScenarioInstanceStore } from '@openslack/scenario-runtime';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createOpenSlackAgentBoundMutationComposition,
  createOpenSlackMcpContext,
  createOpenSlackMcpServer,
  OpenSlackMcpCore,
  type OperatorApplicationContextPort,
} from '../index.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sourcePack = join(repositoryRoot, 'scenarios', 'software-delivery');
const PRINCIPAL_REF = 'agent-bound';
const WORKSPACE_ID = 'workspace-governed-composition';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function operator(): OperatorApplicationContextPort {
  return Object.freeze({}) as unknown as OperatorApplicationContextPort;
}

function registryYaml(
  options: {
    readonly action?: 'allow' | 'ask' | 'deny';
    readonly identityStatus?: 'active' | 'suspended' | 'retired';
    readonly employmentStatus?: 'active' | 'paused' | 'onboarding' | 'retired';
    readonly maxRiskZone?: 'green' | 'yellow' | 'red' | 'black';
  } = {},
): string {
  return [
    'schema: openslack.agent_registry.v2',
    `agent_id: ${PRINCIPAL_REF}`,
    'display_name: Agent Bound Test Principal',
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
    `  status: ${options.employmentStatus ?? 'active'}`,
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
    `  max_risk_zone: ${options.maxRiskZone ?? 'yellow'}`,
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

function runtimeIdentityYaml(
  overrides: {
    readonly agentId?: string;
    readonly agentUid?: string;
    readonly provider?: 'cli' | 'slack' | 'github' | 'webhook';
  } = {},
): string {
  return [
    'schema: openslack.agent_runtime_identity.v1',
    `agent_id: ${overrides.agentId ?? PRINCIPAL_REF}`,
    `agent_uid: ${overrides.agentUid ?? `${PRINCIPAL_REF}-uid`}`,
    'run_id: RUN-governed-composition-001',
    'public_key_jwk: null',
    'key_id: null',
    'key_generated_at: null',
    `provider: ${overrides.provider ?? 'cli'}`,
    'started_at: "2026-07-28T00:00:00.000Z"',
    '',
  ].join('\n');
}

function createWorkspace(
  options: {
    readonly action?: 'allow' | 'ask' | 'deny';
    readonly identityStatus?: 'active' | 'suspended' | 'retired';
    readonly employmentStatus?: 'active' | 'paused' | 'onboarding' | 'retired';
    readonly maxRiskZone?: 'green' | 'yellow' | 'red' | 'black';
    readonly runtimeIdentity?: string | null;
  } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-governed-composition-'));
  roots.push(root);
  writeFileSync(
    join(root, 'openslack.yaml'),
    [
      'schema: openslack.workspace.v1',
      `workspace_id: ${WORKSPACE_ID}`,
      'name: Governed Composition Test',
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
  writeFileSync(
    join(root, '.openslack', 'agents', 'registry', `${PRINCIPAL_REF}.yaml`),
    registryYaml(options),
    'utf8',
  );
  if (options.runtimeIdentity !== null) {
    const identityDirectory = join(root, '.openslack.local', 'agents', PRINCIPAL_REF);
    mkdirSync(identityDirectory, { recursive: true });
    writeFileSync(
      join(identityDirectory, 'identity.yaml'),
      options.runtimeIdentity ?? runtimeIdentityYaml(),
      'utf8',
    );
  }
  mkdirSync(join(root, 'scenarios'));
  cpSync(sourcePack, join(root, 'scenarios', 'software-delivery'), { recursive: true });
  return root;
}

function context(
  workspaceRoot: string,
  governedMutations: Awaited<
    ReturnType<typeof createOpenSlackAgentBoundMutationComposition>
  >['governedMutations'],
) {
  return createOpenSlackMcpContext({
    workspaceRoot,
    operator: operator(),
    governedMutations,
  });
}

function previewMetadata(result: Readonly<Record<string, unknown>>): {
  readonly planId: string;
  readonly confirmationToken: string;
  readonly correlationId: string;
} {
  return {
    planId: String(result.planId),
    confirmationToken: String(result.confirmationToken),
    correlationId: String(result.correlationId),
  };
}

async function rewritePackLock(pack: string): Promise<void> {
  const lockPath = join(pack, 'scenario.lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  for (const entry of lock.files) {
    const bytes = readFileSync(join(pack, ...entry.path.split('/')));
    entry.bytes = bytes.length;
    entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  }
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

describe('production agent-bound governed mutation composition', () => {
  it('rejects Proxy, accessor, and unknown composition options without invoking traps', async () => {
    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps += 1;
          return Object.prototype;
        },
        ownKeys() {
          traps += 1;
          return [];
        },
      },
    );
    await expect(
      createOpenSlackAgentBoundMutationComposition(proxy as never),
    ).rejects.toMatchObject({ code: 'GOVERNED_COMPOSITION_INPUT_INVALID' });
    expect(traps).toBe(0);

    let getterHits = 0;
    const accessor = Object.defineProperty({ principalRef: PRINCIPAL_REF }, 'workspaceRoot', {
      enumerable: true,
      get() {
        getterHits += 1;
        return createWorkspace();
      },
    });
    await expect(
      createOpenSlackAgentBoundMutationComposition(accessor as never),
    ).rejects.toMatchObject({ code: 'GOVERNED_COMPOSITION_INPUT_INVALID' });
    expect(getterHits).toBe(0);

    await expect(
      createOpenSlackAgentBoundMutationComposition({
        workspaceRoot: createWorkspace(),
        principalRef: PRINCIPAL_REF,
        unexpected: true,
      } as never),
    ).rejects.toMatchObject({ code: 'GOVERNED_COMPOSITION_INPUT_INVALID' });
  });

  it('composes from an active registry/runtime principal and exposes exactly 16 tools', async () => {
    const workspaceRoot = createWorkspace();
    const composition = await createOpenSlackAgentBoundMutationComposition({
      workspaceRoot,
      principalRef: PRINCIPAL_REF,
      workspaceIdAssertion: WORKSPACE_ID,
    });
    const core = new OpenSlackMcpCore(context(workspaceRoot, composition.governedMutations));

    expect(composition.scenarioIds).toEqual(['software-delivery']);
    expect(composition.authority).toMatchObject({ workspaceId: WORKSPACE_ID });
    expect(composition.authority.actorId).toMatch(/^agent-principal:sha256:[0-9a-f]{64}$/);
    expect(core.listTools().map((tool) => tool.name)).toEqual([
      ...OPENSLACK_READ_TOOL_NAMES,
      ...OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES,
    ]);

    const workflow = await core.callTool('openslack_preview_workflow', {
      workflowId: 'not-registered',
      input: {},
    });
    expect(workflow.structuredContent).toMatchObject({
      status: 'blocked',
      governance: { blocker: 'GOVERNED_WORKFLOW_TARGET_NOT_REGISTERED' },
    });
    expect(await new LocalGovernedPlanStore(composition.governedPlanRoot).list()).toEqual([]);
  });

  it('runs preview, confirm, and durable Scenario readback over the official MCP SDK', async () => {
    const workspaceRoot = createWorkspace();
    const composition = await createOpenSlackAgentBoundMutationComposition({
      workspaceRoot,
      principalRef: PRINCIPAL_REF,
    });
    const server = createOpenSlackMcpServer(context(workspaceRoot, composition.governedMutations));
    const client = new Client({ name: 'production-governed-composition-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.sdkServer.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        ...OPENSLACK_READ_TOOL_NAMES,
        ...OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES,
      ]);
      const preview = await client.callTool({
        name: 'openslack_preview_scenario',
        arguments: { scenarioId: 'software-delivery', input: {} },
      });
      const metadata = previewMetadata(preview.structuredContent as Record<string, unknown>);
      expect(preview.structuredContent).toMatchObject({
        status: 'needs_confirmation',
        authority: { mode: 'governed_mutation' },
      });

      const confirmed = await client.callTool({
        name: 'openslack_confirm_plan',
        arguments: {
          planId: metadata.planId,
          confirmationToken: metadata.confirmationToken,
        },
      });
      expect(confirmed.structuredContent).toMatchObject({
        status: 'completed',
        correlationId: metadata.correlationId,
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
      const instanceId = output.data.outcomes[0]!.data.scenarioInstanceId;
      const readback = await new LocalScenarioInstanceStore(
        composition.scenarioInstanceRoot,
        metadata.correlationId,
      ).readWithRevision(instanceId);
      expect(readback).toMatchObject({
        revision: expect.stringMatching(/^[0-9a-f]{64}$/),
        instance: {
          id: instanceId,
          state: 'active',
          correlationId: metadata.correlationId,
        },
      });
      expect(readEvents(workspaceRoot).map((event) => event.type)).toEqual([
        'operator.plan.previewed',
        'operator.plan.confirmed',
        'operator.execution.started',
        'operator.execution.completed',
      ]);

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
      expect(
        await new LocalScenarioInstanceStore(
          composition.scenarioInstanceRoot,
          metadata.correlationId,
        ).readWithRevision(instanceId),
      ).toEqual(readback);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps the preview pending when permission changes before confirmation', async () => {
    const workspaceRoot = createWorkspace();
    const composition = await createOpenSlackAgentBoundMutationComposition({
      workspaceRoot,
      principalRef: PRINCIPAL_REF,
    });
    const core = new OpenSlackMcpCore(context(workspaceRoot, composition.governedMutations));
    const preview = await core.callTool('openslack_preview_scenario', {
      scenarioId: 'software-delivery',
      input: {},
    });
    const metadata = previewMetadata(preview.structuredContent);
    writeFileSync(
      join(workspaceRoot, '.openslack', 'agents', 'registry', `${PRINCIPAL_REF}.yaml`),
      registryYaml({ action: 'deny' }),
      'utf8',
    );

    const confirmed = await core.callTool('openslack_confirm_plan', {
      planId: metadata.planId,
      confirmationToken: metadata.confirmationToken,
    });
    expect(confirmed.structuredContent).toMatchObject({
      status: 'blocked',
      governance: { blocker: 'GOVERNED_ACTION_NOT_AUTHORIZED' },
    });
    expect(
      await new LocalGovernedPlanStore(composition.governedPlanRoot).load(metadata.planId),
    ).toMatchObject({ state: 'pending', revision: 1 });
  });

  it('keeps the preview pending when the bound runtime identity disappears', async () => {
    const workspaceRoot = createWorkspace();
    const composition = await createOpenSlackAgentBoundMutationComposition({
      workspaceRoot,
      principalRef: PRINCIPAL_REF,
    });
    const core = new OpenSlackMcpCore(context(workspaceRoot, composition.governedMutations));
    const preview = await core.callTool('openslack_preview_scenario', {
      scenarioId: 'software-delivery',
      input: {},
    });
    const metadata = previewMetadata(preview.structuredContent);
    rmSync(join(workspaceRoot, '.openslack.local', 'agents', PRINCIPAL_REF, 'identity.yaml'));

    const confirmed = await core.callTool('openslack_confirm_plan', {
      planId: metadata.planId,
      confirmationToken: metadata.confirmationToken,
    });
    expect(confirmed.structuredContent).toMatchObject({
      status: 'blocked',
      governance: { blocker: 'GOVERNED_PRINCIPAL_BINDING_CHANGED' },
    });
    expect(
      await new LocalGovernedPlanStore(composition.governedPlanRoot).load(metadata.planId),
    ).toMatchObject({ state: 'pending', revision: 1 });
  });

  it('keeps the preview pending when a valid locked Pack changes before confirmation', async () => {
    const workspaceRoot = createWorkspace();
    const composition = await createOpenSlackAgentBoundMutationComposition({
      workspaceRoot,
      principalRef: PRINCIPAL_REF,
    });
    const core = new OpenSlackMcpCore(context(workspaceRoot, composition.governedMutations));
    const preview = await core.callTool('openslack_preview_scenario', {
      scenarioId: 'software-delivery',
      input: {},
    });
    const metadata = previewMetadata(preview.structuredContent);
    const pack = join(workspaceRoot, 'scenarios', 'software-delivery');
    const capabilities = join(pack, 'capabilities.yaml');
    writeFileSync(
      capabilities,
      `${readFileSync(capabilities, 'utf8')}# definition drift\n`,
      'utf8',
    );
    await rewritePackLock(pack);

    const confirmed = await core.callTool('openslack_confirm_plan', {
      planId: metadata.planId,
      confirmationToken: metadata.confirmationToken,
    });
    expect(confirmed.structuredContent).toMatchObject({
      status: 'blocked',
      governance: { blocker: 'GOVERNED_SCENARIO_BINDING_CHANGED' },
    });
    expect(
      await new LocalGovernedPlanStore(composition.governedPlanRoot).load(metadata.planId),
    ).toMatchObject({ state: 'pending', revision: 1 });
  });

  it.each([
    {
      name: 'missing runtime identity',
      fixture: { runtimeIdentity: null },
      code: 'GOVERNED_COMPOSITION_PRINCIPAL_UNAVAILABLE',
    },
    {
      name: 'inactive registry identity',
      fixture: { identityStatus: 'suspended' as const },
      code: 'GOVERNED_COMPOSITION_PRINCIPAL_MISMATCH',
    },
    {
      name: 'inactive employment',
      fixture: { employmentStatus: 'paused' as const },
      code: 'GOVERNED_COMPOSITION_PRINCIPAL_MISMATCH',
    },
    {
      name: 'mismatched runtime identity',
      fixture: { runtimeIdentity: runtimeIdentityYaml({ agentUid: 'other-agent-uid' }) },
      code: 'GOVERNED_COMPOSITION_PRINCIPAL_MISMATCH',
    },
    {
      name: 'missing action grant',
      fixture: { action: 'ask' as const },
      code: 'GOVERNED_COMPOSITION_PERMISSION_DENIED',
    },
    {
      name: 'risk ceiling below the Scenario mutation policy',
      fixture: { maxRiskZone: 'green' as const },
      code: 'GOVERNED_COMPOSITION_PERMISSION_DENIED',
    },
  ])('fails composition for $name', async ({ fixture, code }) => {
    await expect(
      createOpenSlackAgentBoundMutationComposition({
        workspaceRoot: createWorkspace(fixture),
        principalRef: PRINCIPAL_REF,
      }),
    ).rejects.toMatchObject({ code });
  });

  it('fails composition for workspace assertion or audit-storage mismatch', async () => {
    const assertionRoot = createWorkspace();
    await expect(
      createOpenSlackAgentBoundMutationComposition({
        workspaceRoot: assertionRoot,
        principalRef: PRINCIPAL_REF,
        workspaceIdAssertion: 'other-workspace',
      }),
    ).rejects.toMatchObject({ code: 'GOVERNED_COMPOSITION_WORKSPACE_INVALID' });

    const storageRoot = createWorkspace();
    mkdirSync(join(storageRoot, '.openslack.local', 'collaboration', 'events.jsonl'), {
      recursive: true,
    });
    await expect(
      createOpenSlackAgentBoundMutationComposition({
        workspaceRoot: storageRoot,
        principalRef: PRINCIPAL_REF,
      }),
    ).rejects.toMatchObject({ code: 'GOVERNED_COMPOSITION_STORAGE_UNAVAILABLE' });
  });
});
