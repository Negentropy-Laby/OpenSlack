import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGovernedActionExecutionRegistry,
  createGovernedPlanService,
  LocalGovernedPlanStore,
  type GovernedActionExecutorDefinition,
} from '@openslack/operator';
import {
  createWorkflowEffectDecisionAuthority,
  LocalWorkflowEffectApprovalStore,
} from '@openslack/workflows';
import { readEvents } from '@openslack/collaboration';
import {
  OPENSLACK_MUTATION_TOOL_NAMES,
  OPENSLACK_READ_TOOL_NAMES,
  validateOpenSlackMcpResultV2,
} from '@openslack/qoder-adapter';
import {
  createOpenSlackGovernedMutationPort,
  createOpenSlackMcpContext,
  createOpenSlackWorkflowApprovalPort,
  createOpenSlackWorkflowApprovalAttestationPort,
  createGovernedPlanCollaborationAuditSink,
  createOpenSlackMcpServer,
  type OperatorApplicationContextPort,
} from '../index.js';
import { OpenSlackMcpCore } from '../core.js';

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'openslack-mcp-mutation-'));
  roots.push(value);
  return value;
}

function operator(): OperatorApplicationContextPort {
  return Object.freeze({}) as unknown as OperatorApplicationContextPort;
}

function harness(workspaceRoot: string, definitions?: readonly GovernedActionExecutorDefinition[]) {
  const execute = vi.fn(async () => ({
    status: 'succeeded' as const,
    summary: 'Created the governed object.',
    data: { objectId: 'scenario-instance-1' },
    evidenceRefs: ['artifact:scenario-instance-1'],
  }));
  const registry = createGovernedActionExecutionRegistry(
    definitions ?? [
      {
        actionId: 'scenario.instantiate',
        version: '1.0.0',
        bindingId: 'local-scenario-instance-store:v1',
        description: 'Persist one sealed Scenario instance.',
        execute,
      },
      {
        actionId: 'workflow.start',
        version: '1.0.0',
        bindingId: 'sealed-workflow-executor:v1',
        description: 'Start one sealed Workflow plan.',
        execute,
      },
    ],
  );
  const service = createGovernedPlanService({
    store: new LocalGovernedPlanStore(join(workspaceRoot, 'governed-plans')),
    registry,
    getBindingSnapshot: () => ({
      sourceVersions: { scenarioLockHash: 'a'.repeat(64), githubHead: 'b'.repeat(40) },
      permissionSnapshot: { capabilities: ['scenario.project.instantiate'] },
      buildNonce: 'qg5-test-build-nonce-0123456789',
    }),
    audit: async () => undefined,
    executionTimeoutMs: 1_000,
  });
  const mutations = createOpenSlackGovernedMutationPort({
    service,
    authority: {
      actorId: 'qoder.human.interviewer',
      workspaceId: 'workspace.contract-demo',
    },
    compileScenario: ({ input, compilation }) => ({
      kind: 'scenario.instantiate',
      goal: `Instantiate ${String(input.scenarioId)}.`,
      input: {
        scenarioId: input.scenarioId,
        businessInput: input.input,
        correlationId: compilation.correlationId,
      },
      actions: [
        {
          actionId: 'scenario.instantiate',
          input: {
            scenarioId: input.scenarioId,
            businessInput: input.input,
            correlationId: compilation.correlationId,
          },
        },
      ],
      effects: [
        {
          type: 'scenario.instantiate',
          summary: `Create ${String(input.scenarioId)} Scenario instance.`,
          risk: 'medium',
          target: String(input.scenarioId),
        },
      ],
    }),
    compileWorkflow: ({ input, compilation }) => ({
      kind: 'workflow.start',
      goal: `Start ${String(input.workflowId)}.`,
      input: {
        workflowId: input.workflowId,
        businessInput: input.input,
        correlationId: compilation.correlationId,
      },
      actions: [
        {
          actionId: 'workflow.start',
          input: {
            workflowId: input.workflowId,
            businessInput: input.input,
            correlationId: compilation.correlationId,
          },
        },
      ],
      effects: [
        {
          type: 'workflow.start',
          summary: `Start sealed Workflow ${String(input.workflowId)}.`,
          risk: 'medium',
          target: String(input.workflowId),
        },
      ],
    }),
  });
  const context = createOpenSlackMcpContext({
    workspaceRoot,
    operator: operator(),
    governedMutations: mutations,
    correlationIdFactory: () => 'mcp:transport-call',
  });
  return {
    core: new OpenSlackMcpCore(context),
    execute,
    mutations,
  };
}

async function approvalHarness(workspaceRoot: string) {
  const base = harness(workspaceRoot);
  const approvalRoot = join(workspaceRoot, 'workflow-effect-approvals');
  mkdirSync(approvalRoot);
  const authority = createWorkflowEffectDecisionAuthority({
    workspaceId: 'workspace.contract-demo',
    humanPrincipalIds: ['human.interviewer'],
    capabilities: ['workflow.effect.decide'],
    maxBindingTtlMs: 60_000,
  });
  const attest = vi.fn(
    (
      request: Parameters<
        ReturnType<typeof createOpenSlackWorkflowApprovalAttestationPort>['attest']
      >[0],
    ) =>
      authority.issueHumanDecisionBinding({
        principalId: 'human.interviewer',
        capability: request.requiredCapability,
        runId: request.runId,
        approvalId: request.approvalId,
        decision: request.decision,
        reasonHash: request.reasonHash,
        expiresAt: new Date(
          Math.min(Date.now() + 30_000, Date.parse(request.approvalExpiresAt)),
        ).toISOString(),
      }),
  );
  const attestation = createOpenSlackWorkflowApprovalAttestationPort(attest);
  const store = new LocalWorkflowEffectApprovalStore(approvalRoot, authority);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.parse(createdAt) + 120_000).toISOString();
  const effectHash = 'c'.repeat(64);
  await store.createPending({
    runId: 'run-contract-001',
    approvalId: 'approval-security-review',
    correlationId: 'business-correlation-001',
    workflowId: 'contract.delivery',
    workflowVersion: '1.0.0',
    workflowHash: 'd'.repeat(64),
    inputHash: 'e'.repeat(64),
    effectId: `workflow-effect:sha256:${effectHash}`,
    effectHash,
    requiredCapability: 'workflow.effect.decide',
    createdAt,
    expiresAt,
  });
  const workflowApprovalAuthority = createOpenSlackWorkflowApprovalPort({
    store,
    attestation,
    audit: createGovernedPlanCollaborationAuditSink(workspaceRoot),
  });
  const context = createOpenSlackMcpContext({
    workspaceRoot,
    operator: operator(),
    governedMutations: base.mutations,
    workflowApprovalAuthority,
    correlationIdFactory: () => 'mcp:approval-transport-call',
  });
  const core = new OpenSlackMcpCore(context);
  return { ...base, attest, context, core, store, workflowApprovalAuthority };
}

describe('governed MCP mutation profile', () => {
  it('rejects forged ports, Proxy values, and option accessors without invoking traps', () => {
    const workspaceRoot = root();
    expect(() =>
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        governedMutations: Object.freeze({}) as never,
      }),
    ).toThrow(/composition boundary/);

    let traps = 0;
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          traps += 1;
          throw new Error('trap');
        },
      },
    );
    expect(() =>
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        governedMutations: proxy as never,
      }),
    ).toThrow(/composition boundary/);
    expect(traps).toBe(0);

    let getterHits = 0;
    const options = Object.defineProperty(
      {
        service: {},
        authority: {},
        compileWorkflow: () => ({}),
      },
      'compileScenario',
      {
        enumerable: true,
        get() {
          getterHits += 1;
          return () => ({});
        },
      },
    );
    expect(() => createOpenSlackGovernedMutationPort(options as never)).toThrow(
      /missing or unknown fields/,
    );
    expect(getterHits).toBe(0);
  });

  it('adds exactly four governed tools while the default server remains exact-read-12', () => {
    const workspaceRoot = root();
    const readCore = new OpenSlackMcpCore(
      createOpenSlackMcpContext({ workspaceRoot, operator: operator() }),
    );
    expect(readCore.listTools().map((tool) => tool.name)).toEqual(OPENSLACK_READ_TOOL_NAMES);

    const { core } = harness(workspaceRoot);
    expect(core.listTools().map((tool) => tool.name)).toEqual([
      ...OPENSLACK_READ_TOOL_NAMES,
      ...OPENSLACK_MUTATION_TOOL_NAMES.slice(0, 4),
    ]);
    expect(core.listTools()).toHaveLength(16);
    expect(core.listTools().map((tool) => tool.name)).not.toContain(
      'openslack_decide_workflow_approval',
    );
  });

  it('previews without side effects and returns one root-only confirmation capability', async () => {
    const workspaceRoot = root();
    const { core, execute } = harness(workspaceRoot);
    const preview = await core.callTool('openslack_preview_scenario', {
      scenarioId: 'software-delivery',
      input: { objective: 'Explain delivery state.' },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(preview.isError).toBe(false);
    expect(JSON.parse(preview.content[0]!.text)).toEqual(preview.structuredContent);
    expect(validateOpenSlackMcpResultV2(preview.structuredContent)).toBe(true);
    expect(preview.structuredContent).toMatchObject({
      schema: 'openslack.mcp_result.v2',
      correlationId: expect.stringMatching(/^CORR-/),
      status: 'needs_confirmation',
      planId: expect.stringMatching(/^GPLAN-/),
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      confirmationToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      authority: { mode: 'governed_mutation' },
      governance: {
        risk: 'medium',
        approvalRequired: true,
        approvalKind: 'openslack_confirm',
      },
    });
    expect(preview.structuredContent.correlationId).not.toBe('mcp:transport-call');
    expect(preview.structuredContent.nextActions).toEqual([
      expect.objectContaining({
        tool: 'openslack_confirm_plan',
        requiresConfirmation: true,
      }),
      expect.objectContaining({
        tool: 'openslack_cancel_plan',
        requiresConfirmation: false,
      }),
    ]);
    expect(JSON.stringify(preview.structuredContent.nextActions)).not.toContain(
      String(preview.structuredContent.confirmationToken),
    );

    const records = readdirSync(join(workspaceRoot, 'governed-plans', 'records'));
    expect(records).toHaveLength(1);
    const bytes = readFileSync(
      join(workspaceRoot, 'governed-plans', 'records', records[0]!),
      'utf8',
    );
    expect(bytes).not.toContain(String(preview.structuredContent.confirmationToken));
  });

  it('requires the token and executes one stored plan with its original correlation', async () => {
    const workspaceRoot = root();
    const { core, execute } = harness(workspaceRoot);
    const preview = await core.callTool('openslack_preview_workflow', {
      workflowId: 'contract.delivery',
      input: { objective: 'Prepare the delivery.' },
    });
    const planId = String(preview.structuredContent.planId);
    const confirmationToken = String(preview.structuredContent.confirmationToken);
    await expect(core.callTool('openslack_confirm_plan', { planId })).rejects.toThrow(
      /confirmationToken is required/,
    );

    const confirmed = await core.callTool('openslack_confirm_plan', {
      planId,
      confirmationToken,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(confirmed.isError).toBe(false);
    expect(confirmed.structuredContent).toMatchObject({
      status: 'completed',
      correlationId: preview.structuredContent.correlationId,
      planId,
      planHash: preview.structuredContent.planHash,
      executionId: expect.stringMatching(/^GEXEC-/),
      governance: { approvalRequired: false },
    });
    expect(confirmed.structuredContent).not.toHaveProperty('confirmationToken');
    expect(JSON.parse(confirmed.content[0]!.text)).toEqual(confirmed.structuredContent);
  });

  it('allows only one executor invocation across one hundred concurrent confirmations', async () => {
    const workspaceRoot = root();
    const { core, execute } = harness(workspaceRoot);
    const preview = await core.callTool('openslack_preview_scenario', {
      scenarioId: 'software-delivery',
      input: {},
    });
    const request = {
      planId: String(preview.structuredContent.planId),
      confirmationToken: String(preview.structuredContent.confirmationToken),
    };
    const results = await Promise.all(
      Array.from({ length: 100 }, () => core.callTool('openslack_confirm_plan', request)),
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(
      results.filter((result) => result.structuredContent.status === 'completed'),
    ).toHaveLength(1);
    expect(
      results.every(
        (result) => JSON.parse(result.content[0]!.text).schema === 'openslack.mcp_result.v2',
      ),
    ).toBe(true);
  });

  it('returns reconciliation_required on a claimed execution deadline and ignores late success', async () => {
    const workspaceRoot = root();
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = vi.fn(async () => {
      await delayed;
      return {
        status: 'succeeded' as const,
        summary: 'Late success must not overwrite reconciliation.',
        evidenceRefs: [],
      };
    });
    const { core, mutations } = harness(workspaceRoot, [
      {
        actionId: 'scenario.instantiate',
        version: '1.0.0',
        bindingId: 'delayed-scenario-store:v1',
        description: 'Delayed Scenario mutation.',
        execute,
      },
      {
        actionId: 'workflow.start',
        version: '1.0.0',
        bindingId: 'delayed-workflow:v1',
        description: 'Delayed Workflow mutation.',
        execute,
      },
    ]);
    const deadlineCore = new OpenSlackMcpCore(
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        governedMutations: mutations,
      }),
      { timeoutMs: 100 },
    );
    const preview = await deadlineCore.callTool('openslack_preview_scenario', {
      scenarioId: 'software-delivery',
      input: {},
    });
    const planId = String(preview.structuredContent.planId);
    const result = await deadlineCore.callTool('openslack_confirm_plan', {
      planId,
      confirmationToken: String(preview.structuredContent.confirmationToken),
    });
    expect(result.structuredContent).toMatchObject({
      status: 'blocked',
      planId,
      governance: { blocker: 'GOVERNED_MUTATION_RECONCILIATION_REQUIRED' },
      data: { state: 'reconciliation_required' },
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await mutations.get(planId))?.state).toBe('reconciliation_required');
    expect(execute).toHaveBeenCalledOnce();
    expect(core.listTools()).toHaveLength(16);
  });

  it('exposes the seventeenth tool only with per-decision human attestation and preserves business correlation', async () => {
    const workspaceRoot = root();
    const { attest, core, store } = await approvalHarness(workspaceRoot);
    expect(core.listTools().map((tool) => tool.name)).toEqual([
      ...OPENSLACK_READ_TOOL_NAMES,
      ...OPENSLACK_MUTATION_TOOL_NAMES,
    ]);
    expect(core.listTools()).toHaveLength(17);

    const decision = await core.callTool('openslack_decide_workflow_approval', {
      runId: 'run-contract-001',
      approvalId: 'approval-security-review',
      decision: 'approved',
      reason: 'Security review evidence is complete.',
    });
    expect(decision.isError).toBe(false);
    expect(decision.structuredContent).toMatchObject({
      status: 'completed',
      correlationId: 'business-correlation-001',
      authority: { mode: 'governed_mutation' },
      governance: { approvalRequired: false, owner: 'human.interviewer' },
      approval: {
        approvalId: 'approval-security-review',
        kind: 'openslack_workflow_effect',
      },
      data: {
        runId: 'run-contract-001',
        status: 'approved',
        revision: 2,
        auditProjection: 'recorded',
      },
    });
    expect(decision.structuredContent.correlationId).not.toBe('mcp:approval-transport-call');
    expect(decision.content[0]!.text).toContain('no GitHub review was created');
    expect(JSON.parse(decision.content[0]!.text)).toEqual(decision.structuredContent);
    expect((await store.read('run-contract-001', 'approval-security-review'))?.correlationId).toBe(
      'business-correlation-001',
    );
    expect(attest).toHaveBeenCalledOnce();
    expect(attest.mock.calls[0]?.[0]).toMatchObject({
      runId: 'run-contract-001',
      approvalId: 'approval-security-review',
      decision: 'approved',
      reasonHash: createHash('sha256')
        .update('Security review evidence is complete.', 'utf8')
        .digest('hex'),
      requiredCapability: 'workflow.effect.decide',
      correlationId: 'business-correlation-001',
    });
    expect(readEvents(workspaceRoot)).toEqual([
      expect.objectContaining({
        type: 'workflow.approval.decided',
        actor: { id: 'human.interviewer', kind: 'human' },
        object: { id: 'approval-security-review', kind: 'workflow' },
        correlationId: 'business-correlation-001',
      }),
    ]);
  });

  it('carries preview, confirmation, and human workflow decisions over the official MCP SDK transport', async () => {
    const workspaceRoot = root();
    const { context, execute } = await approvalHarness(workspaceRoot);
    const server = createOpenSlackMcpServer(context);
    const client = new Client({ name: 'qg5-governed-sdk-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.sdkServer.connect(serverTransport);
    await client.connect(clientTransport);
    let phase = 'tools/list';
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        ...OPENSLACK_READ_TOOL_NAMES,
        ...OPENSLACK_MUTATION_TOOL_NAMES,
      ]);
      phase = 'scenario preview';
      const preview = await client.callTool({
        name: 'openslack_preview_scenario',
        arguments: { scenarioId: 'software-delivery', input: {} },
      });
      const previewResult = preview.structuredContent as Record<string, unknown>;
      const sdkPlanId = String(previewResult.planId);
      const sdkConfirmationToken = String(previewResult.confirmationToken);
      expect(previewResult).toMatchObject({
        status: 'needs_confirmation',
      });
      expect(sdkPlanId).toMatch(/^GPLAN-/);
      expect(sdkConfirmationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      phase = 'plan confirmation';
      const confirmed = await client.callTool({
        name: 'openslack_confirm_plan',
        arguments: {
          planId: sdkPlanId,
          confirmationToken: sdkConfirmationToken,
        },
      });
      expect(confirmed.structuredContent).toMatchObject({
        status: 'completed',
        correlationId: previewResult.correlationId,
      });
      expect(execute).toHaveBeenCalledOnce();

      phase = 'workflow-effect decision';
      const decision = await client.callTool({
        name: 'openslack_decide_workflow_approval',
        arguments: {
          runId: 'run-contract-001',
          approvalId: 'approval-security-review',
          decision: 'approved',
          reason: 'The human reviewed the evidence.',
        },
      });
      expect(decision.structuredContent).toMatchObject({
        status: 'completed',
        correlationId: 'business-correlation-001',
        data: { status: 'approved', auditProjection: 'recorded' },
      });
      const text = decision.content as Array<{ type: string; text?: string }>;
      expect(JSON.parse(String(text[0]?.text))).toEqual(decision.structuredContent);
    } catch (error) {
      throw new Error(`Official MCP SDK phase failed: ${phase}: ${String(error)}`, {
        cause: error,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('keeps a terminal human decision authoritative when its audit projection needs reconciliation', async () => {
    const workspaceRoot = root();
    const base = harness(workspaceRoot);
    const approvalRoot = join(workspaceRoot, 'workflow-effect-approvals');
    mkdirSync(approvalRoot);
    const authority = createWorkflowEffectDecisionAuthority({
      workspaceId: 'workspace.contract-demo',
      humanPrincipalIds: ['human.interviewer'],
      capabilities: ['workflow.effect.decide'],
      maxBindingTtlMs: 60_000,
    });
    const attest = vi.fn(
      (
        request: Parameters<
          ReturnType<typeof createOpenSlackWorkflowApprovalAttestationPort>['attest']
        >[0],
      ) =>
        authority.issueHumanDecisionBinding({
          principalId: 'human.interviewer',
          capability: request.requiredCapability,
          runId: request.runId,
          approvalId: request.approvalId,
          decision: request.decision,
          reasonHash: request.reasonHash,
          expiresAt: new Date(
            Math.min(Date.now() + 30_000, Date.parse(request.approvalExpiresAt)),
          ).toISOString(),
        }),
    );
    const attestation = createOpenSlackWorkflowApprovalAttestationPort(attest);
    const store = new LocalWorkflowEffectApprovalStore(approvalRoot, authority);
    const createdAt = new Date().toISOString();
    await store.createPending({
      runId: 'run-audit-001',
      approvalId: 'approval-audit-001',
      correlationId: 'business-correlation-audit',
      workflowId: 'contract.delivery',
      workflowVersion: '1.0.0',
      workflowHash: 'd'.repeat(64),
      inputHash: 'e'.repeat(64),
      effectId: `workflow-effect:sha256:${'c'.repeat(64)}`,
      effectHash: 'c'.repeat(64),
      requiredCapability: 'workflow.effect.decide',
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + 120_000).toISOString(),
    });
    const workflowApprovalAuthority = createOpenSlackWorkflowApprovalPort({
      store,
      attestation,
      audit: async () => {
        throw new Error('projection unavailable');
      },
    });
    const core = new OpenSlackMcpCore(
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        governedMutations: base.mutations,
        workflowApprovalAuthority,
      }),
    );

    const result = await core.callTool('openslack_decide_workflow_approval', {
      runId: 'run-audit-001',
      approvalId: 'approval-audit-001',
      decision: 'rejected',
      reason: 'The evidence is incomplete.',
    });
    expect(result.structuredContent).toMatchObject({
      status: 'completed',
      correlationId: 'business-correlation-audit',
      governance: {
        approvalRequired: false,
        blocker: 'WORKFLOW_APPROVAL_AUDIT_PROJECTION_RECONCILIATION_REQUIRED',
      },
      data: {
        status: 'rejected',
        auditProjection: 'reconciliation_required',
      },
    });
    expect(await store.read('run-audit-001', 'approval-audit-001')).toMatchObject({
      status: 'rejected',
      revision: 1,
    });
    const retry = await core.callTool('openslack_decide_workflow_approval', {
      runId: 'run-audit-001',
      approvalId: 'approval-audit-001',
      decision: 'approved',
      reason: 'Do not retry a terminal decision.',
    });
    expect(retry.structuredContent).toMatchObject({
      status: 'failed',
      correlationId: 'business-correlation-audit',
      governance: { approvalRequired: false },
    });
    expect(await store.read('run-audit-001', 'approval-audit-001')).toMatchObject({
      status: 'rejected',
      revision: 1,
    });
    expect(attest).toHaveBeenCalledOnce();
  });

  it('does not expose or forge workflow approval authority through an agent-only context', async () => {
    const workspaceRoot = root();
    const { mutations } = harness(workspaceRoot);
    expect(() =>
      createOpenSlackMcpContext({
        workspaceRoot,
        operator: operator(),
        workflowApprovalAuthority: Object.freeze({}) as never,
      }),
    ).toThrow(/human-attested composition/);
    await expect(
      new OpenSlackMcpCore(
        createOpenSlackMcpContext({
          workspaceRoot,
          operator: operator(),
          governedMutations: mutations,
        }),
      ).callTool('openslack_decide_workflow_approval', {
        runId: 'run-contract-001',
        approvalId: 'approval-security-review',
        decision: 'approved',
        reason: 'Agent cannot decide.',
      }),
    ).rejects.toThrow(/Unknown tool/);
  });

  it('rejects client-supplied authority, correlation, capability, and command fields', async () => {
    const workspaceRoot = root();
    const { core, store } = await approvalHarness(workspaceRoot);
    for (const field of ['actorId', 'workspaceId', 'correlationId', 'capabilities', 'command']) {
      await expect(
        core.callTool('openslack_decide_workflow_approval', {
          runId: 'run-contract-001',
          approvalId: 'approval-security-review',
          decision: 'approved',
          reason: 'Attempted authority injection.',
          [field]: field === 'capabilities' ? ['workflow.effect.decide'] : 'forged',
        }),
      ).rejects.toThrow(/unexpected argument properties/);
    }
    expect(await store.read('run-contract-001', 'approval-security-review')).toMatchObject({
      status: 'pending',
      revision: 0,
    });
  });
});
