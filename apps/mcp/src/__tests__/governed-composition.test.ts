import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readEvents } from '@openslack/collaboration';
import { LocalGraphStore } from '@openslack/organization-graph';
import { resolveAgentPrincipal } from '@openslack/runtime';
import { createRunStore, createRunRecorder, buildPermissionProfile, ToolGuard, RepositoryToolExecutor, type AdapterExecutionContext } from '@openslack/agent-runtime';
import { HarnessTaskHost, createHarnessTaskAuthority,
  createConfiguredHarnessTaskHost, hashHarnessDeployment, hashHarnessRuntimeArtifacts, hashHarnessInput,
  buildHarnessTaskPermissionProfile, inspectHarnessTaskExecution, reconcileHarnessTask,
  hashHarnessPluginArtifacts, hashHarnessNodeExecutable,
  type ApprovedHarnessTask } from '@openslack/agent-runtime/internal/harness';
import {
  canonicalGovernedJson,
  createCanonicalGovernedPlan,
  createRoutedGovernedPlanStore,
  governedPlanAuthorityRoot,
  governedPlanStoreRoot,
  hashGovernedValue,
  hashOpaqueValue,
  LocalGovernedPlanStore,
  registerGovernanceAuthorityGoPort,
  validateGovernedPlanRecord,
  type GovernedPlanAuditEvent,
  type GovernedPlanRecord,
} from '@openslack/operator';
import {
  OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES,
  OPENSLACK_READ_TOOL_NAMES,
} from '@openslack/qoder-adapter';
import { LocalScenarioInstanceStore } from '@openslack/scenario-runtime';
import {
  CONTRACT_DELIVERY_LITE_FIXTURE_ID,
  CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
} from '@openslack/workflows';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assembleContractDeliveryLiteRehearsalSource,
  createOpenSlackAgentBoundMutationComposition,
  createOpenSlackMcpContext,
  createOpenSlackMcpServer,
  OpenSlackMcpCore,
  publishContractDeliveryLiteRehearsalSnapshot,
  type OperatorApplicationContextPort,
} from '../index.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const sourcePack = join(repositoryRoot, 'scenarios', 'software-delivery');
const contractDeliverySourcePack = join(repositoryRoot, 'scenarios', 'contract-to-delivery-lite');
const PRINCIPAL_REF = 'agent-bound';
const WORKSPACE_ID = 'workspace-governed-composition';
const roots: string[] = [];
const GOVERNANCE_BUILD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

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
    readonly workflowAction?: 'allow' | 'ask' | 'deny';
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
    `    openslack.collaboration.recordEvent: ${options.workflowAction ?? 'deny'}`,
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
    readonly contractDelivery?: boolean;
    readonly workflowAction?: 'allow' | 'ask' | 'deny';
    readonly noScenarios?: boolean;
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
  if (!options.noScenarios) {
    mkdirSync(join(root, 'scenarios'));
    cpSync(sourcePack, join(root, 'scenarios', 'software-delivery'), { recursive: true });
  }
  if (options.contractDelivery) {
    cpSync(contractDeliverySourcePack, join(root, 'scenarios', 'contract-to-delivery-lite'), {
      recursive: true,
    });
  }
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

async function claimedLeaseBoundaryFixture() {
  const root = createWorkspace({ action: 'deny', noScenarios: true });
  const registry = join(root, '.openslack/agents/registry', `${PRINCIPAL_REF}.yaml`);
  writeFileSync(registry, readFileSync(registry, 'utf8').replace('  github:', '    harness.task.dispatch: allow\n    harness.task.report: allow\n  github:'));
  const resolved = resolveAgentPrincipal({ root, agentId: PRINCIPAL_REF, provider: 'cli' });
  if ('error' in resolved) throw new Error('Synthetic production fixture principal did not resolve');
  const expired = join(root, 'lease-expired.flag'), base = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => existsSync(expired) ? base + 200 : base);
  let onLease = async () => {};
  const leaseReads = vi.fn(async () => { await onLease(); return { owners: [resolved.principal],
    expiresAt: new Date(base + 100).toISOString(), claimRef: 'refs/heads/openslack/claims/fixture' }; });
  const config = { agentId: PRINCIPAL_REF, source: 'fixture', runtimeProvider: 'deepseek-harness', tools: ['Read', 'Write', 'Edit'], permissionMode: 'acceptEdits' as const };
  const definition = { taskId: 'TASK-LEASE-1', baseline: 'b'.repeat(40), timeoutMs: 60_000,
    request: { agentId: PRINCIPAL_REF, prompt: 'Update the approved fixture.', resolvedConfig: config, permissionProfile: buildHarnessTaskPermissionProfile(config) },
    scope: { readPaths: ['fixture.txt'], writePaths: ['fixture.txt'], forbiddenPaths: ['.git/**'] }, outputSchema: { type: 'object' } };
  const authority = createHarnessTaskAuthority({ identityRoot: root, agentId: PRINCIPAL_REF, uid: `${PRINCIPAL_REF}-uid`, principalId: `principal:${PRINCIPAL_REF}`,
    runtimeRunId: 'RUN-governed-composition-001', provider: 'cli', claimMode: 'required', source: {
      read: async () => ({ task: definition, allowedPaths: ['fixture.txt'], forbiddenPaths: ['.git/**'], claimRequired: true, sourceDigest: 'c'.repeat(64) }), readLease: leaseReads,
    } });
  const task = await authority.readTask(definition.taskId);
  const store = createRunStore(root, { sweepOrphans: false }), runId = 'RUN-LEASE-TEST';
  const worktree = join(root, 'workspace'); mkdirSync(worktree); writeFileSync(join(worktree, 'fixture.txt'), 'before');
  store.createRun({ ...task.request, runId });
  store.updateRun(runId, { status: 'running', startedAt: new Date(base).toISOString(), worktreePath: worktree,
    harnessExecution: { schema: 'openslack.harness_execution.v1', taskId: task.taskId,
      requestHash: hashHarnessInput({ ...task, idempotencyKey: task.taskId }), principalHash: task.principalHash,
      baseline: task.baseline, acceptance: 'pending', summary: 'fixture', reports: {}, evidenceRefs: [],
      lifecycle: { phase: 'started', ownerGeneration: 'fixture-owner', deadlineAt: new Date(base + task.timeoutMs).toISOString() }, evidence: { calls: {}, reservedBytes: 0 } } });
  const recorder = createRunRecorder(store, root), guard = new ToolGuard(task.request.permissionProfile, recorder, runId);
  const context: AdapterExecutionContext = { ...task.request, runId, runState: store.getRun(runId)!, worktreePath: worktree,
    signal: new AbortController().signal, executionDeadline: base + task.timeoutMs, recorder, toolGuard: guard,
    toolExecutor: new RepositoryToolExecutor({ rootPath: worktree, recorder, toolGuard: guard, runId }) };
  const control = join(root, 'lock-control'); mkdirSync(control);
  const module = pathToFileURL(join(repositoryRoot, 'packages/agent-runtime/dist/run-store.js')).href;
  const script = `import{createRunStore}from${JSON.stringify(module)};import{existsSync,readFileSync,writeFileSync,writeSync}from'node:fs';import{join}from'node:path';
    const[root,defaultId,control,expired]=process.argv.slice(1),store=createRunStore(root,{sweepOrphans:false});
    writeSync(1,'ready\\n');while(!existsSync(join(control,'start')))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
    const id=existsSync(join(control,'run-id'))?readFileSync(join(control,'run-id'),'utf8'):defaultId;
    store.withRunTransaction(id,s=>{writeFileSync(join(control,'locked'),'1');while(!existsSync(join(control,'release')))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);writeFileSync(expired,'1');return{patch:{toolCalls:s.toolCalls+1}};});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, runId, control, expired], { stdio: ['ignore', 'pipe', 'pipe'] });
  let error = ''; child.stderr.on('data', bytes => { error += bytes; });
  const closed = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(error || `Lock child exit ${code}`))); });
  await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
  const hold = async (targetRunId = runId) => {
    writeFileSync(join(control, 'run-id'), targetRunId);
    writeFileSync(join(control, 'start'), '1');
    await vi.waitFor(() => expect(existsSync(join(control, 'locked'))).toBe(true));
    expect(existsSync(join(root, '.openslack.local/agents/runs', targetRunId, 'run.transaction.lock'))).toBe(true);
  };
  const release = () => { writeFileSync(join(control, 'release'), '1'); };
  const holdSynchronously = (targetRunId: string) => {
    writeFileSync(join(control, 'run-id'), targetRunId); writeFileSync(join(control, 'start'), '1');
    const until = performance.now() + 1000;
    while (!existsSync(join(control, 'locked'))) { if (performance.now() >= until) throw new Error('Fixture canonical writer did not acquire its lock'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
    expect(existsSync(join(root, '.openslack.local/agents/runs', targetRunId, 'run.transaction.lock'))).toBe(true);
  };
  return { root, runId, task, authority, store, recorder, context, leaseReads, hold, holdSynchronously, release,
    setLeaseHook(hook: () => Promise<void>) { onLease = hook; leaseReads.mockClear(); },
    revokeSourceWriteScope() { definition.scope.writePaths = []; },
    async close() { writeFileSync(join(control, 'start'), '1'); release(); await closed; clock.mockRestore(); },
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

function pendingGovernedRecord(): GovernedPlanRecord {
  const plan = createCanonicalGovernedPlan({
    kind: 'scenario.instantiate',
    goal: 'Instantiate scenario',
    input: { scenarioId: 'software-delivery' },
    actions: [{ actionId: 'scenario.instantiate', input: { scenarioId: 'software-delivery' } }],
    effects: [{ type: 'scenario.instance', summary: 'Create instance', risk: 'medium' }],
  });
  return validateGovernedPlanRecord({
    schema: 'openslack.governed_plan.v1',
    revision: 1,
    planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174090',
    state: 'pending',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    expiresAt: '2026-08-03T00:15:00.000Z',
    canonicalPlan: plan,
    bindings: {
      actorId: 'agent.test',
      workspaceId: WORKSPACE_ID,
      correlationId: 'CORR-123e4567-e89b-42d3-a456-426614174091',
      inputHash: hashGovernedValue(plan.input),
      planHash: hashGovernedValue(plan),
      sourceVersionHash: hashGovernedValue({ source: 'v1' }),
      permissionSnapshotHash: hashGovernedValue({ allowed: true }),
      actionCatalogHash: hashGovernedValue(['scenario.instantiate']),
      executorBindingHash: hashGovernedValue(['scenario.instantiate@v1']),
      buildNonceHash: hashOpaqueValue('build-nonce-0123456789'),
      processNonceHash: hashOpaqueValue('process-nonce-0123456789'),
    },
    confirmationTokenHash: hashOpaqueValue('confirmation-token-0123456789'),
  });
}

async function seedCollaborationRecordedJournal(workspaceRoot: string): Promise<void> {
  const records = new Map<string, GovernedPlanRecord>();
  const go = registerGovernanceAuthorityGoPort({
    async accept(record) {
      records.set(record.planId, record);
      return record;
    },
    async load(planId) {
      return records.get(planId) ?? null;
    },
    async transition(_operation, target) {
      records.set(target.planId, target);
      return target;
    },
    async pendingAudit() {
      return null;
    },
    async recordAudit() {
      throw new Error('seed response loss');
    },
  });
  const store = await createRoutedGovernedPlanStore({
    routeRoot: governedPlanAuthorityRoot(workspaceRoot),
    localStore: new LocalGovernedPlanStore(governedPlanStoreRoot(workspaceRoot)),
    backend: 'go',
    routingEpoch: 40,
    go,
    now: () => new Date('2026-08-03T00:00:00.000Z'),
  });
  const record = await store.create(pendingGovernedRecord());
  const event: GovernedPlanAuditEvent = Object.freeze({
    schema: 'openslack.governed_plan_audit.v1',
    eventId: 'GAUDIT-123e4567-e89b-42d3-a456-426614174092',
    type: 'plan.previewed',
    occurredAt: '2026-08-03T00:00:00.000Z',
    planId: record.planId,
    kind: record.canonicalPlan.kind,
    actorId: record.bindings.actorId,
    workspaceId: record.bindings.workspaceId,
    correlationId: record.bindings.correlationId,
    state: record.state,
    revision: record.revision,
    evidenceRefs: Object.freeze([]),
  });
  await store.prepareAudit?.(event);
  await expect(store.recordAudit?.(event)).rejects.toThrow('seed response loss');
}

async function listenAuthority(mode: 'ack' | 'fail'): Promise<{
  readonly origin: string;
  readonly requests: string[];
  readonly close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server: Server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '/';
      requests.push(`${request.method ?? 'GET'} ${path}`);
      if (mode === 'fail') {
        response.writeHead(503).end();
        return;
      }
      if (request.method === 'GET') {
        response.writeHead(404).end();
        return;
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const event = JSON.parse(body) as GovernedPlanAuditEvent;
      const eventHash = createHash('sha256').update(body, 'utf8').digest('hex');
      const idempotencyKey = `openslack.governance-authority-audit.v1.${eventHash}`;
      const requestFingerprint = `sha256:${createHash('sha256')
        .update(
          `POST\n${path}\nqoder.mcp\n${WORKSPACE_ID}\n40\n${GOVERNANCE_BUILD}\n${body}`,
          'utf8',
        )
        .digest('hex')}`;
      const receipt = {
        schema: 'openslack.governance_authority_audit_receipt.v1',
        status: 'duplicate',
        workspaceId: WORKSPACE_ID,
        planId: event.planId,
        revision: event.revision,
        eventId: event.eventId,
        eventHash,
        idempotencyKey,
        requestFingerprint,
        recordedAt: '2026-08-03T00:01:00.000Z',
      };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(`${canonicalGovernedJson(receipt)}\n`);
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolvePromise) => server.close(() => resolvePromise())),
  };
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

  it('rehearses Contract-to-Delivery through governed plans, explicit build, query, and explain', async () => {
    const workspaceRoot = createWorkspace({
      contractDelivery: true,
      workflowAction: 'allow',
    });
    const composition = await createOpenSlackAgentBoundMutationComposition({
      workspaceRoot,
      principalRef: PRINCIPAL_REF,
    });
    expect(composition.scenarioIds).toEqual(['contract-to-delivery-lite', 'software-delivery']);
    const server = createOpenSlackMcpServer(context(workspaceRoot, composition.governedMutations));
    const client = new Client({ name: 'contract-delivery-local-rehearsal', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.sdkServer.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        ...OPENSLACK_READ_TOOL_NAMES,
        ...OPENSLACK_GOVERNED_MUTATION_TOOL_NAMES,
      ]);

      const scenarioPreview = await client.callTool({
        name: 'openslack_preview_scenario',
        arguments: {
          scenarioId: 'contract-to-delivery-lite',
          input: {
            mode: 'local_rehearsal',
            fixtureId: CONTRACT_DELIVERY_LITE_FIXTURE_ID,
          },
        },
      });
      const scenarioMetadata = previewMetadata(
        scenarioPreview.structuredContent as Record<string, unknown>,
      );
      const scenarioConfirmation = await client.callTool({
        name: 'openslack_confirm_plan',
        arguments: {
          planId: scenarioMetadata.planId,
          confirmationToken: scenarioMetadata.confirmationToken,
        },
      });
      expect(scenarioConfirmation.structuredContent).toMatchObject({
        status: 'completed',
        data: {
          state: 'succeeded',
          outcomes: [{ data: { state: 'active' } }],
        },
      });
      const scenarioInstanceId = String(
        (
          scenarioConfirmation.structuredContent as {
            data: { outcomes: Array<{ data: { scenarioInstanceId: string } }> };
          }
        ).data.outcomes[0]!.data.scenarioInstanceId,
      );

      const workflowPreview = await client.callTool({
        name: 'openslack_preview_workflow',
        arguments: {
          workflowId: CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
          input: {
            mode: 'local_rehearsal',
            fixtureId: CONTRACT_DELIVERY_LITE_FIXTURE_ID,
            scenarioInstanceId,
            scenarioCorrelationId: scenarioMetadata.correlationId,
          },
        },
      });
      const workflowMetadata = previewMetadata(
        workflowPreview.structuredContent as Record<string, unknown>,
      );
      expect(workflowPreview.structuredContent).toMatchObject({
        status: 'needs_confirmation',
        data: {
          kind: 'workflow.start',
          effects: [{ type: 'workflow.start', target: scenarioInstanceId }],
        },
      });
      const workflowConfirmation = await client.callTool({
        name: 'openslack_confirm_plan',
        arguments: {
          planId: workflowMetadata.planId,
          confirmationToken: workflowMetadata.confirmationToken,
        },
      });
      expect(workflowConfirmation.structuredContent).toMatchObject({
        status: 'completed',
        data: {
          state: 'succeeded',
          outcomes: [
            {
              status: 'succeeded',
              data: {
                evidenceLevel: 'LOCAL_REHEARSAL_PASS',
                origins: {
                  workflow: 'governed_local_store',
                  workItem: 'demo_fixture',
                  deliverable: 'demo_fixture',
                  acceptance: 'demo_fixture',
                  outcome: 'demo_fixture',
                  notificationIntent: 'not_created',
                  notificationDelivery: 'blocked_not_configured',
                  liveGitHub: 'not_run',
                  liveCapstone: 'LIVE_CAPSTONE_PENDING',
                  qoderDesktop: 'not_run',
                },
              },
            },
          ],
        },
      });
      const completedInstance = await new LocalScenarioInstanceStore(
        composition.scenarioInstanceRoot,
        scenarioMetadata.correlationId,
      ).readWithRevision(scenarioInstanceId);
      expect(completedInstance).toMatchObject({
        instance: {
          state: 'completed',
          workflowRunIds: [expect.stringMatching(/^workflow-run:sha256:[0-9a-f]{64}$/)],
        },
      });

      const source = await assembleContractDeliveryLiteRehearsalSource({
        governedPlanRoot: composition.governedPlanRoot,
        scenarioInstanceRoot: composition.scenarioInstanceRoot,
        workflowPlanId: workflowMetadata.planId,
        scenarioInstanceId,
        scenarioCorrelationId: scenarioMetadata.correlationId,
      });
      const published = await publishContractDeliveryLiteRehearsalSnapshot({
        workspaceRoot,
        source,
        expectedCursor: null,
      });
      const graphStore = new LocalGraphStore(join(workspaceRoot, '.openslack.local', 'graph'));
      const snapshot = await graphStore.readCurrentSnapshot(scenarioInstanceId);
      const customer = snapshot.nodes.find((node) => node.type === 'business.customer');
      const compositeEdge = snapshot.edges.find(
        (edge) => edge.projectorVersion === 'openslack.contract_to_delivery.v1',
      );
      expect(customer).toBeDefined();
      expect(compositeEdge).toBeDefined();
      expect(
        source.softwareDelivery.sources.workflowRuns.items.some(
          (item) =>
            item.workflowId === CONTRACT_DELIVERY_LITE_WORKFLOW_ID &&
            item.observationKind === 'local_store',
        ),
      ).toBe(true);

      const query = await client.callTool({
        name: 'openslack_query_graph',
        arguments: {
          scenarioInstanceId,
          rootNodeIds: [customer!.id],
          direction: 'both',
          depth: 3,
          maxNodes: 200,
          maxEdges: 500,
          includeEvidence: true,
        },
      });
      expect(query.structuredContent).toMatchObject({
        status: 'completed',
        authority: {
          mode: 'projection',
          sources: ['openslack.organization_graph_snapshot'],
        },
        data: {
          scenarioInstanceId,
          snapshotCursor: published.cursor,
          truncation: { truncated: false },
        },
      });
      const explanation = await client.callTool({
        name: 'openslack_explain_graph',
        arguments: {
          scenarioInstanceId,
          targetId: compositeEdge!.id,
          depth: 3,
        },
      });
      expect(explanation.structuredContent).toMatchObject({
        status: 'completed',
        authority: {
          mode: 'projection',
          sources: ['openslack.organization_graph_snapshot'],
        },
        data: {
          targetId: compositeEdge!.id,
          snapshotCursor: published.cursor,
        },
      });
      expect(readEvents(workspaceRoot).some((event) => event.type === 'workflow.started')).toBe(
        true,
      );
    } finally {
      await client.close();
      await server.close();
    }
  }, 15_000);

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

  it('keeps the Workflow preview pending when its capability changes before confirmation', async () => {
    const workspaceRoot = createWorkspace({
      contractDelivery: true,
      workflowAction: 'allow',
    });
    const composition = await createOpenSlackAgentBoundMutationComposition({
      workspaceRoot,
      principalRef: PRINCIPAL_REF,
    });
    const core = new OpenSlackMcpCore(context(workspaceRoot, composition.governedMutations));
    const scenarioPreview = await core.callTool('openslack_preview_scenario', {
      scenarioId: 'contract-to-delivery-lite',
      input: {
        mode: 'local_rehearsal',
        fixtureId: CONTRACT_DELIVERY_LITE_FIXTURE_ID,
      },
    });
    const scenarioMetadata = previewMetadata(scenarioPreview.structuredContent);
    const scenarioConfirmation = await core.callTool('openslack_confirm_plan', {
      planId: scenarioMetadata.planId,
      confirmationToken: scenarioMetadata.confirmationToken,
    });
    const scenarioInstanceId = String(
      (
        scenarioConfirmation.structuredContent as {
          data: { outcomes: Array<{ data: { scenarioInstanceId: string } }> };
        }
      ).data.outcomes[0]!.data.scenarioInstanceId,
    );
    const workflowPreview = await core.callTool('openslack_preview_workflow', {
      workflowId: CONTRACT_DELIVERY_LITE_WORKFLOW_ID,
      input: {
        mode: 'local_rehearsal',
        fixtureId: CONTRACT_DELIVERY_LITE_FIXTURE_ID,
        scenarioInstanceId,
        scenarioCorrelationId: scenarioMetadata.correlationId,
      },
    });
    const workflowMetadata = previewMetadata(workflowPreview.structuredContent);
    writeFileSync(
      join(workspaceRoot, '.openslack', 'agents', 'registry', `${PRINCIPAL_REF}.yaml`),
      registryYaml({ action: 'allow', workflowAction: 'deny' }),
      'utf8',
    );

    const confirmed = await core.callTool('openslack_confirm_plan', {
      planId: workflowMetadata.planId,
      confirmationToken: workflowMetadata.confirmationToken,
    });
    expect(confirmed.structuredContent).toMatchObject({
      status: 'blocked',
      governance: { blocker: 'GOVERNED_ACTION_NOT_AUTHORIZED' },
    });
    expect(
      await new LocalGovernedPlanStore(composition.governedPlanRoot).load(workflowMetadata.planId),
    ).toMatchObject({ state: 'pending', revision: 1 });
    expect(
      await new LocalScenarioInstanceStore(
        composition.scenarioInstanceRoot,
        scenarioMetadata.correlationId,
      ).readWithRevision(scenarioInstanceId),
    ).toMatchObject({ instance: { state: 'active', workflowRunIds: [] } });
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

  it('fails rollback composition before server construction when Go history has no transport', async () => {
    const workspaceRoot = createWorkspace();
    await expect(
      createOpenSlackAgentBoundMutationComposition({
        workspaceRoot,
        principalRef: PRINCIPAL_REF,
        governanceAuthority: {
          backend: 'go',
          routingEpoch: 40,
          tenantId: WORKSPACE_ID,
          origin: 'http://127.0.0.1:18082',
          expectedBuildSha: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          callerId: 'qoder.mcp',
          expiresAt: '2099-08-03T00:00:00.000Z',
        },
      }),
    ).resolves.toBeDefined();

    await expect(
      createOpenSlackAgentBoundMutationComposition({
        workspaceRoot,
        principalRef: PRINCIPAL_REF,
        governanceAuthority: {
          backend: 'ts-local',
          routingEpoch: 41,
          tenantId: WORKSPACE_ID,
        },
      }),
    ).rejects.toMatchObject({ code: 'GOVERNED_COMPOSITION_STORAGE_UNAVAILABLE' });
  });

  it('reports the exact missing fields for a partial governance-control transport', async () => {
    await expect(
      createOpenSlackAgentBoundMutationComposition({
        workspaceRoot: createWorkspace(),
        principalRef: PRINCIPAL_REF,
        governanceAuthority: {
          backend: 'ts-local',
          routingEpoch: 41,
          tenantId: WORKSPACE_ID,
          origin: 'http://127.0.0.1:18082',
        },
      }),
    ).rejects.toMatchObject({
      code: 'GOVERNED_COMPOSITION_INPUT_INVALID',
      message:
        'Governance authority transport is incomplete; missing governanceAuthority.expectedBuildSha, governanceAuthority.callerId, governanceAuthority.expiresAt.',
    });

    await expect(
      createOpenSlackAgentBoundMutationComposition({
        workspaceRoot: createWorkspace(),
        principalRef: PRINCIPAL_REF,
        governanceAuthority: {
          backend: 'go',
          routingEpoch: 41,
          tenantId: WORKSPACE_ID,
        },
      }),
    ).rejects.toMatchObject({
      code: 'GOVERNED_COMPOSITION_INPUT_INVALID',
      message:
        'Governance authority transport is incomplete; missing governanceAuthority.origin, governanceAuthority.expectedBuildSha, governanceAuthority.callerId, governanceAuthority.expiresAt.',
    });
  });

  it('drains a historical Go audit before completing a higher-epoch ts-local composition', async () => {
    const workspaceRoot = createWorkspace();
    await seedCollaborationRecordedJournal(workspaceRoot);
    const authority = await listenAuthority('ack');
    try {
      await expect(
        createOpenSlackAgentBoundMutationComposition({
          workspaceRoot,
          principalRef: PRINCIPAL_REF,
          governanceAuthority: {
            backend: 'ts-local',
            routingEpoch: 41,
            tenantId: WORKSPACE_ID,
            origin: authority.origin,
            expectedBuildSha: GOVERNANCE_BUILD,
            callerId: 'qoder.mcp',
            expiresAt: '2099-08-03T00:00:00.000Z',
          },
        }),
      ).resolves.toBeDefined();
      expect(authority.requests).toEqual([
        expect.stringMatching(/^POST \/v1\/governance\/plans\/.+\/authority-events\/1:record$/),
        expect.stringMatching(/^GET \/v1\/governance\/plans\/.+$/),
      ]);
      expect(
        readFileSync(join(governedPlanAuthorityRoot(workspaceRoot), 'policy.json'), 'utf8'),
      ).toContain('"routingEpoch":41');
      expect(readdirSync(join(governedPlanAuthorityRoot(workspaceRoot), 'audit-journal'))).toEqual(
        [],
      );
    } finally {
      await authority.close();
    }
  });

  it('rejects the composition factory when startup audit recovery cannot acknowledge Go', async () => {
    const workspaceRoot = createWorkspace();
    await seedCollaborationRecordedJournal(workspaceRoot);
    const authority = await listenAuthority('fail');
    try {
      await expect(
        createOpenSlackAgentBoundMutationComposition({
          workspaceRoot,
          principalRef: PRINCIPAL_REF,
          governanceAuthority: {
            backend: 'ts-local',
            routingEpoch: 41,
            tenantId: WORKSPACE_ID,
            origin: authority.origin,
            expectedBuildSha: GOVERNANCE_BUILD,
            callerId: 'qoder.mcp',
            expiresAt: '2099-08-03T00:00:00.000Z',
          },
        }),
      ).rejects.toMatchObject({ code: 'GOVERNED_COMPOSITION_STORAGE_UNAVAILABLE' });
      expect(authority.requests).toEqual([
        expect.stringMatching(/^POST \/v1\/governance\/plans\/.+\/authority-events\/1:record$/),
        expect.stringMatching(/^POST \/v1\/governance\/plans\/.+\/authority-events\/1:record$/),
      ]);
    } finally {
      await authority.close();
    }
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

  it('admits through the unchanged MCP tools, records only current-task progress, accepts, and reads the same run', async () => {
    const confirmation = (value: Readonly<Record<string, unknown>>) => {
      const metadata = previewMetadata(value);
      return { planId: metadata.planId, confirmationToken: metadata.confirmationToken };
    };
    const workspaceRoot = createWorkspace({ action: 'deny', noScenarios: true });
    const registryPath = join(workspaceRoot, '.openslack/agents/registry', `${PRINCIPAL_REF}.yaml`);
    writeFileSync(registryPath, readFileSync(registryPath, 'utf8').replace('  github:',
      '    harness.task.dispatch: allow\n    harness.task.report: allow\n  github:'));
    writeFileSync(join(workspaceRoot, 'fixture.txt'), 'before');
    const config = { agentId: PRINCIPAL_REF, source: 'fixture', runtimeProvider: 'deepseek-harness', tools: ['Read', 'Write', 'Edit'], permissionMode: 'acceptEdits' as const };
    const task: ApprovedHarnessTask = {
      taskId: 'TASK-HARNESS-1', principalHash: '', baseline: 'b'.repeat(40), timeoutMs: 10_000,
      request: { agentId: PRINCIPAL_REF, prompt: 'Update the approved text fixture only.',
        resolvedConfig: config, permissionProfile: buildPermissionProfile(config) },
      scope: { readPaths: ['fixture.txt'], writePaths: ['fixture.txt'], forbiddenPaths: ['.openslack/**', '.git/**'] },
      outputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
    };
    const authority = createHarnessTaskAuthority({ identityRoot: workspaceRoot, agentId: PRINCIPAL_REF,
      uid: `${PRINCIPAL_REF}-uid`, principalId: `principal:${PRINCIPAL_REF}`, runtimeRunId: 'RUN-governed-composition-001',
      provider: 'cli', claimMode: 'not_applicable', source: {
        async read() {
          const input = { ...task };
          delete (input as Partial<ApprovedHarnessTask>).principalHash;
          return { task: input, allowedPaths: ['fixture.txt'], forbiddenPaths: ['.git/**'], claimRequired: false, sourceDigest: 'c'.repeat(64) };
        },
      } });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const execute = vi.fn(async () => {
      writeFileSync(join(workspaceRoot, 'fixture.txt'), 'after');
      await gate;
      return { data: { summary: 'Updated fixture.' }, exitConfirmed: true as const };
    });
    const options = {
      identityRoot: workspaceRoot, workspaceId: WORKSPACE_ID, store: createRunStore(workspaceRoot),
      ...authority,
      prepare: async () => ({ execute, accept: async () => {
        expect(readFileSync(join(workspaceRoot, 'fixture.txt'), 'utf8')).toBe('after');
        return { outcome: 'verified' as const, summary: 'Host verified text fixture.', evidenceRefs: ['artifact:fixture'] };
      } }),
      publish: async (state: { runId: string; agentId: string }) => {
        const path = join(workspaceRoot, '.openslack.local/collaboration/events.jsonl');
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify({ schema: 'openslack.collaboration_event.v1', id: `EVT-${state.runId}`,
          timestamp: new Date().toISOString(), type: 'workflow.started', actor: { kind: 'agent', id: state.agentId },
          object: { kind: 'workflow', id: state.runId }, source: { kind: 'openslack', ref: `run:${state.runId}` },
          summary: 'Harness task admitted; business acceptance pending.', visibility: 'workspace', redacted: true, containsSensitiveData: false,
        })}\n`);
      },
    };
    const host = new HarnessTaskHost(options);
    try {
      const composition = await createOpenSlackAgentBoundMutationComposition({ workspaceRoot, principalRef: PRINCIPAL_REF, harnessTaskHost: host });
      const core = new OpenSlackMcpCore(context(workspaceRoot, composition.governedMutations));
      expect(core.listTools()).toHaveLength(16);
      expect(existsSync(join(workspaceRoot, '.openslack.local/scenario-instances'))).toBe(false);
      const deniedScenario = await core.callTool('openslack_preview_scenario', { scenarioId: 'software-delivery', input: {} });
      expect(deniedScenario.structuredContent).toMatchObject({ status: 'blocked', governance: { blocker: 'GOVERNED_ACTION_NOT_AUTHORIZED' } });
      expect(execute).not.toHaveBeenCalled();
      expect(existsSync(join(workspaceRoot, '.openslack.local/scenario-instances'))).toBe(false);
      const preview = await core.callTool('openslack_preview_workflow', { workflowId: 'harness.task.dispatch', input: { taskId: task.taskId, requestId: 'request-1' } });
      expect(preview.structuredContent.status).toBe('needs_confirmation');
      // An unrelated, unavailable legacy domain must not become Harness input.
      mkdirSync(join(workspaceRoot, 'scenarios', 'unrelated-invalid-pack'), { recursive: true });
      writeFileSync(join(workspaceRoot, 'scenarios', 'unrelated-invalid-pack', 'manifest.yaml'), 'not a locked pack');
      const confirmed = await core.callTool('openslack_confirm_plan', confirmation(preview.structuredContent));
      expect(confirmed.structuredContent.status).toBe('completed');
      const receipt = (confirmed.structuredContent.data as { outcomes: Array<{ data: { runId: string; status: string } }> }).outcomes[0]!.data;
      expect(receipt.status).toBe('pending');
      const runId = receipt.runId;
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      const worker = new HarnessTaskHost({ ...options, callbackRunId: runId });
      const callbackComposition = await createOpenSlackAgentBoundMutationComposition({ workspaceRoot, principalRef: PRINCIPAL_REF, harnessTaskHost: worker });
      const callback = new OpenSlackMcpCore(context(workspaceRoot, callbackComposition.governedMutations));
      expect((await callback.callTool('openslack_preview_workflow', { workflowId: 'harness.task.dispatch', input: { taskId: task.taskId, requestId: 'wrong-worker-role' } })).structuredContent.status).toBe('blocked');
      expect((await core.callTool('openslack_preview_workflow', { workflowId: 'harness.task.report', input: { runId, reportId: 'wrong-initiator-role', summary: 'must not record', evidenceRefs: [] } })).structuredContent.status).toBe('blocked');
      expect(host.read(runId)?.harnessExecution?.reports).toEqual({});
      expect(execute).toHaveBeenCalledOnce();
      const report = await callback.callTool('openslack_preview_workflow', { workflowId: 'harness.task.report',
        input: { runId, reportId: 'report-1', summary: 'Text changed; host acceptance pending.', evidenceRefs: ['artifact:fixture'] } });
      expect(report.structuredContent.status).toBe('needs_confirmation');
      const reported = await callback.callTool('openslack_confirm_plan', confirmation(report.structuredContent));
      expect(reported.structuredContent.status).toBe('completed');
      expect(host.read(runId)?.harnessExecution?.acceptance).toBe('pending');
      release();
      await vi.waitFor(() => expect(host.read(runId)?.status).toBe('completed'));
      const activity = await core.callTool('openslack_get_activity', { objectKind: 'workflow', objectId: runId });
      expect(activity.structuredContent.data).toMatchObject({ execution: { taskId: task.taskId, runId, status: 'completed', acceptance: 'verified' } });
      const second = await core.callTool('openslack_preview_workflow', { workflowId: 'harness.task.dispatch', input: { taskId: task.taskId, requestId: 'request-2' } });
      await core.callTool('openslack_confirm_plan', confirmation(second.structuredContent));
      expect(execute).toHaveBeenCalledTimes(1);
      await worker.close(100);
      const resolvedTask = await authority.readTask(task.taskId);
      writeFileSync(registryPath, readFileSync(registryPath, 'utf8').replace('harness.task.dispatch: allow', 'harness.task.dispatch: deny'));
      await expect(authority.authorize(resolvedTask, 'execute')).rejects.toThrow('snapshot changed');
    } finally {
      release();
      await host.close(1_000);
    }
  });

  it('preserves the exact admission route through governed MCP when visibility publication takes longer than the duplicate wait', async () => {
    const workspaceRoot = createWorkspace({ action: 'deny', noScenarios: true });
    const registryPath = join(workspaceRoot, '.openslack/agents/registry', `${PRINCIPAL_REF}.yaml`);
    writeFileSync(registryPath, readFileSync(registryPath, 'utf8').replace('  github:', '    harness.task.dispatch: allow\n  github:'));
    const config = { agentId: PRINCIPAL_REF, source: 'fixture', runtimeProvider: 'deepseek-harness', tools: ['Read'] };
    const task: ApprovedHarnessTask = { taskId: 'TASK-SLOW-1', principalHash: '', baseline: 'b'.repeat(40), timeoutMs: 10_000,
      request: { agentId: PRINCIPAL_REF, prompt: 'Observe the approved fixture.', resolvedConfig: config, permissionProfile: buildPermissionProfile(config) },
      scope: { readPaths: [], writePaths: [], forbiddenPaths: ['.git/**'] }, outputSchema: { type: 'object' } };
    const authority = createHarnessTaskAuthority({ identityRoot: workspaceRoot, agentId: PRINCIPAL_REF,
      uid: `${PRINCIPAL_REF}-uid`, principalId: `principal:${PRINCIPAL_REF}`, runtimeRunId: 'RUN-governed-composition-001', provider: 'cli', claimMode: 'not_applicable',
      source: { read: async () => {
        const input = { ...task }; delete (input as Partial<ApprovedHarnessTask>).principalHash;
        return { task: input, allowedPaths: [], forbiddenPaths: [], claimRequired: false, sourceDigest: 'c'.repeat(64) };
      } } });
    const publication = Promise.withResolvers<void>();
    const started = Promise.withResolvers<string>();
    const execute = vi.fn(async () => ({ data: {}, exitConfirmed: true as const }));
    const host = new HarnessTaskHost({ identityRoot: workspaceRoot, workspaceId: WORKSPACE_ID, store: createRunStore(workspaceRoot), ...authority,
      prepare: async () => ({ execute, accept: async () => ({ outcome: 'verified', summary: 'fixture', evidenceRefs: [] }) }),
      publish: async state => {
        started.resolve(state.runId); await publication.promise;
        const events = join(workspaceRoot, '.openslack.local/collaboration/events.jsonl'); mkdirSync(dirname(events), { recursive: true });
        appendFileSync(events, `${JSON.stringify({ schema: 'openslack.collaboration_event.v1', id: `EVT-${state.runId}`, timestamp: new Date().toISOString(),
          type: 'workflow.started', actor: { kind: 'agent', id: state.agentId }, object: { kind: 'workflow', id: state.runId },
          source: { kind: 'openslack', ref: `run:${state.runId}` }, summary: 'Visible admission.', visibility: 'workspace', redacted: true, containsSensitiveData: false })}\n`);
      },
    });
    try {
      const composition = await createOpenSlackAgentBoundMutationComposition({ workspaceRoot, principalRef: PRINCIPAL_REF, harnessTaskHost: host });
      const core = new OpenSlackMcpCore(context(workspaceRoot, composition.governedMutations));
      const preview = async (requestId: string) => {
        const result = await core.callTool('openslack_preview_workflow', { workflowId: 'harness.task.dispatch', input: { taskId: task.taskId, requestId } });
        expect(result.structuredContent.status, JSON.stringify(result.structuredContent)).toBe('needs_confirmation');
        const metadata = previewMetadata(result.structuredContent);
        return { planId: metadata.planId, confirmationToken: metadata.confirmationToken };
      };
      const first = core.callTool('openslack_confirm_plan', await preview('first'));
      const runId = await started.promise;
      const duplicate = await core.callTool('openslack_confirm_plan', await preview('second'));
      expect(duplicate.structuredContent.status).toBe('blocked');
      expect(duplicate.structuredContent.data).toMatchObject({ outcomes: [{ data: { taskId: task.taskId,
        admission: { kind: 'admission', runId, canonicalRunPresent: true, disposition: 'in_progress' } } }] });
      expect(JSON.stringify(duplicate)).not.toContain('do not redispatch');
      const invisible = await core.callTool('openslack_get_activity', { objectKind: 'workflow', objectId: runId });
      expect(invisible.structuredContent.data).not.toHaveProperty('execution');
      expect(execute).not.toHaveBeenCalled();
      publication.resolve();
      expect((await first).structuredContent.status).toBe('completed');
      await vi.waitFor(() => expect(host.read(runId)?.status).toBe('completed'));
      expect(execute).toHaveBeenCalledOnce();
      const visible = await core.callTool('openslack_get_activity', { objectKind: 'workflow', objectId: runId });
      expect(visible.structuredContent.data).toMatchObject({ execution: { taskId: task.taskId, runId, acceptance: 'verified' } });
    } finally { publication.resolve(); await host.close(1000); }
  });

  it('does not let an injected unusable or differently bound Harness host bypass startup authority', async () => {
    const workspaceRoot = createWorkspace({ action: 'deny', noScenarios: true });
    const host = new HarnessTaskHost({ identityRoot: workspaceRoot, workspaceId: WORKSPACE_ID, principalId: `principal:${PRINCIPAL_REF}`, store: createRunStore(workspaceRoot),
      readTask: async () => { throw new Error('No task should be resolved'); }, authorize: async () => {},
      prepare: async () => { throw new Error('No process should start'); }, publish: async () => {},
    });
    try {
      await expect(createOpenSlackAgentBoundMutationComposition({ workspaceRoot, principalRef: PRINCIPAL_REF, harnessTaskHost: host }))
        .rejects.toMatchObject({ code: 'GOVERNED_COMPOSITION_PERMISSION_DENIED' });
      const foreign = new HarnessTaskHost({ identityRoot: workspaceRoot, workspaceId: WORKSPACE_ID, principalId: 'principal:another-agent', store: createRunStore(workspaceRoot),
        readTask: async () => { throw new Error('No task should be resolved'); }, authorize: async () => {}, prepare: async () => { throw new Error('No process should start'); }, publish: async () => {},
      });
      try { await expect(createOpenSlackAgentBoundMutationComposition({ workspaceRoot, principalRef: PRINCIPAL_REF, harnessTaskHost: foreign }))
        .rejects.toMatchObject({ code: 'GOVERNED_COMPOSITION_PRINCIPAL_MISMATCH' }); }
      finally { await foreign.close(100); }
    } finally { await host.close(100); }
  });

  it('requires governed admission for a real principal and reads its verified history after lease expiry without reauthorizing execution', async () => {
    const workspaceRoot = createWorkspace({ action: 'deny', noScenarios: true });
    const registry = join(workspaceRoot, '.openslack/agents/registry', `${PRINCIPAL_REF}.yaml`);
    writeFileSync(registry, readFileSync(registry, 'utf8').replace('  github:', '    harness.task.dispatch: allow\n  github:'));
    const resolved = resolveAgentPrincipal({ root: workspaceRoot, agentId: PRINCIPAL_REF, provider: 'cli' });
    if ('error' in resolved) throw new Error('Fixture principal must resolve through production parser');
    const config = { agentId: PRINCIPAL_REF, source: 'fixture', runtimeProvider: 'deepseek-harness', tools: ['Read'] };
    const task: ApprovedHarnessTask = { taskId: 'TASK-HISTORY-1', principalHash: '', baseline: 'b'.repeat(40), timeoutMs: 10_000,
      request: { agentId: PRINCIPAL_REF, prompt: 'Observe only.', resolvedConfig: config, permissionProfile: buildPermissionProfile(config) },
      scope: { readPaths: [], writePaths: [], forbiddenPaths: [] }, outputSchema: { type: 'object' } };
    let expired = false;
    const readLease = vi.fn(async () => ({ owners: [resolved.principal], claimRef: 'refs/heads/openslack/claims/fixture',
      expiresAt: new Date(Date.now() + (expired ? -1000 : 60_000)).toISOString() }));
    const authority = createHarnessTaskAuthority({ identityRoot: workspaceRoot, agentId: PRINCIPAL_REF, uid: `${PRINCIPAL_REF}-uid`,
      principalId: `principal:${PRINCIPAL_REF}`, runtimeRunId: 'RUN-governed-composition-001', provider: 'cli', claimMode: 'required', source: {
        read: async () => {
          const input = { ...task }; delete (input as Partial<ApprovedHarnessTask>).principalHash;
          return { task: input, allowedPaths: [], forbiddenPaths: [], claimRequired: true, sourceDigest: 'c'.repeat(64) };
        }, readLease,
      } });
    const prepare = vi.fn(async () => ({ execute: async () => ({ data: {}, exitConfirmed: true as const }),
      accept: async () => ({ outcome: 'verified' as const, summary: 'fixture', evidenceRefs: [] }) }));
    const options = { identityRoot: workspaceRoot, workspaceId: WORKSPACE_ID, store: createRunStore(workspaceRoot), ...authority, prepare,
      publish: async () => {},
    };
    const host = new HarnessTaskHost(options);
    const taskBoundOnly = new HarnessTaskHost({ ...options, principalId: undefined });
    try {
      const currentTask = await authority.readTask(task.taskId);
      await expect(host.dispatch(task.taskId, 'direct-bypass')).rejects.toThrow('requires its originating governed confirmation binding');
      await expect(taskBoundOnly.dispatch(task.taskId, 'task-principal-bypass')).rejects.toThrow('requires its originating governed confirmation binding');
      expect(readdirSync(join(workspaceRoot, '.openslack.local/agents/harness-admissions'))).toEqual([]);
      expect(options.store.listRuns()).toEqual([]);
      expect(prepare).not.toHaveBeenCalled();
      const composition = await createOpenSlackAgentBoundMutationComposition({ workspaceRoot, principalRef: PRINCIPAL_REF, harnessTaskHost: host });
      const core = new OpenSlackMcpCore(context(workspaceRoot, composition.governedMutations));
      const preview = await core.callTool('openslack_preview_workflow', { workflowId: 'harness.task.dispatch', input: { taskId: task.taskId, requestId: 'before-expiry' } });
      expect(preview.structuredContent.status).toBe('needs_confirmation');
      const { planId, confirmationToken } = previewMetadata(preview.structuredContent);
      const confirmed = await core.callTool('openslack_confirm_plan', { planId, confirmationToken });
      expect(confirmed.structuredContent.status).toBe('completed');
      const runId = (confirmed.structuredContent.data as { outcomes: Array<{ data: { runId: string } }> }).outcomes[0]!.data.runId;
      await vi.waitFor(() => expect(host.read(runId)?.status).toBe('completed'));
      expect(prepare).toHaveBeenCalledOnce();
      const path = join(workspaceRoot, '.openslack.local/agents/runs', runId, 'run.json');
      const before = readFileSync(path), transcript = readFileSync(host.read(runId)!.transcriptPath);
      expired = true;
      await expect(authority.readTask(task.taskId)).rejects.toThrow('lease');
      await expect(authority.authorize(currentTask, 'execute')).rejects.toThrow('lease');
      readLease.mockClear();
      expect((await authority.readTaskForReconciliation(task.taskId)).principalHash).toBe(currentTask.principalHash);
      expect(readLease).not.toHaveBeenCalled();
      const result = await reconcileHarnessTask({ identityRoot: workspaceRoot, ...authority,
        inspect: async () => ({ deployment: 'matched', workspace: 'matched', process: 'exited' }) }, runId);
      expect(result).toMatchObject({ disposition: 'existing_verified_result', authority: 'matched', currentExecutionEligibility: 'ineligible' });
      expect(readFileSync(path)).toEqual(before);
      expect(readFileSync(host.read(runId)!.transcriptPath)).toEqual(transcript);
    } finally { await taskBoundOnly.close(100); await host.close(100); }
  });

  it('rejects a required lease that expires during the final canonical read wait before native authorization', async () => {
    const value = await claimedLeaseBoundaryFixture();
    let calls = 0;
    value.setLeaseHook(async () => { if (++calls === 2) { await value.hold(); value.release(); } });
    try {
      await expect(value.authority.authorizeTool(value.context, 'Write', { file_path: join(value.context.worktreePath!, 'fixture.txt') })).rejects.toThrow(/lease|eligibility/i);
      expect(readFileSync(join(value.context.worktreePath!, 'fixture.txt'), 'utf8')).toBe('before');
      expect(value.store.getRun(value.runId)?.harnessExecution?.evidence?.calls).toEqual({});
    } finally { await value.close(); }
  });

  it('rejects an expired required lease inside the native evidence reservation transaction after waiting for its writer', async () => {
    const value = await claimedLeaseBoundaryFixture();
    try {
      const eligibility = await value.authority.authorizeTool(value.context, 'Write', { file_path: join(value.context.worktreePath!, 'fixture.txt') });
      await value.hold(); value.release();
      const reservation = { callId: 'lease-native', toolName: 'Write', input: { file_path: 'fixture.txt', content: 'after' },
        targetPath: join(value.context.worktreePath!, 'fixture.txt'), generation: 'fixture-owner', maxResultBytes: 2048 };
      expect(() => value.recorder.reserveToolEvidence!(value.runId, reservation, eligibility)).toThrow(/lease|eligibility/i);
      expect(value.store.getRun(value.runId)?.harnessExecution?.evidence?.calls).toEqual({});
      expect(readFileSync(join(value.context.worktreePath!, 'fixture.txt'), 'utf8')).toBe('before');
    } finally { await value.close(); }
  });

  it('rejects a required lease that expires while the report CAS waits for a healthy writer', async () => {
    const value = await claimedLeaseBoundaryFixture();
    const worker = new HarnessTaskHost({ identityRoot: value.root, workspaceId: WORKSPACE_ID, store: value.store, ...value.authority, callbackRunId: value.runId,
      prepare: async () => { throw new Error('A callback must not start execution'); }, publish: async () => {} });
    let calls = 0;
    value.setLeaseHook(async () => { if (++calls === 2) { await value.hold(); value.release(); } });
    try {
      await expect(worker.report({ runId: value.runId, reportId: 'expired', summary: 'must not publish', evidenceRefs: [] })).rejects.toThrow(/lease|eligibility/i);
      expect(value.store.getRun(value.runId)?.harnessExecution?.reports).toEqual({});
      const before = readFileSync(join(value.root, '.openslack.local/agents/runs', value.runId, 'run.json'));
      value.leaseReads.mockClear();
      expect((await value.authority.readTaskForReconciliation(value.task.taskId)).principalHash).toBe(value.task.principalHash);
      expect(value.leaseReads).not.toHaveBeenCalled();
      expect(readFileSync(join(value.root, '.openslack.local/agents/runs', value.runId, 'run.json'))).toEqual(before);
    } finally { await value.close(); await worker.close(100); }
  });

  it('retains the second source read when approved scope changes during the first lease await without a principal change', async () => {
    const value = await claimedLeaseBoundaryFixture();
    let reads = 0;
    value.setLeaseHook(async () => { if (++reads === 1) value.revokeSourceWriteScope(); });
    try {
      const staleTask = await value.authority.readTask(value.task.taskId);
      expect(staleTask.scope.writePaths).toEqual(['fixture.txt']);
      expect(staleTask.principalHash).toBe(value.task.principalHash);
      await expect(value.authority.authorize(staleTask, 'execute')).rejects.toThrow('differs from the formal source');
      expect(readFileSync(join(value.context.worktreePath!, 'fixture.txt'), 'utf8')).toBe('before');
    } finally { await value.close(); }
  });

  it.each(['start', 'complete'] as const)('keeps the required lease effective inside the final %s CAS after a different process held its canonical lock', async phase => {
    const value = await claimedLeaseBoundaryFixture();
    const execute = vi.fn(async () => { writeFileSync(join(value.context.worktreePath!, 'fixture.txt'), 'after'); return { data: {}, exitConfirmed: true as const }; });
    let executeChecks = 0, acceptanceChecks = 0, gated = false;
    const host = new HarnessTaskHost({ identityRoot: value.root, workspaceId: WORKSPACE_ID, store: value.store, ...value.authority,
      authorize: async (task, checkpoint) => {
        const eligibility = await value.authority.authorize(task, checkpoint);
        if (checkpoint === 'execute') executeChecks++;
        if (checkpoint === 'accept') acceptanceChecks++;
        return eligibility;
      },
      prepare: async () => ({ execute, accept: async () => ({ outcome: 'verified', summary: 'fixture', evidenceRefs: [] }),
        revalidateAccepted: () => { if (readFileSync(join(value.context.worktreePath!, 'fixture.txt'), 'utf8') !== 'after') throw new Error('Fixture changed'); } }),
      publish: async () => {},
    });
    const original = value.store.withRunTransaction;
    const transaction = vi.spyOn(value.store, 'withRunTransaction').mockImplementation((runId, update) => {
      if (!gated && runId !== value.runId && (phase === 'start' ? executeChecks === 2 : acceptanceChecks === 2)) {
        gated = true; value.holdSynchronously(runId); value.release();
      }
      return original(runId, update);
    });
    try {
      const composition = await createOpenSlackAgentBoundMutationComposition({ workspaceRoot: value.root, principalRef: PRINCIPAL_REF, harnessTaskHost: host });
      const core = new OpenSlackMcpCore(context(value.root, composition.governedMutations));
      const preview = await core.callTool('openslack_preview_workflow', { workflowId: 'harness.task.dispatch', input: { taskId: value.task.taskId, requestId: `lease-${phase}` } });
      expect(preview.structuredContent.status).toBe('needs_confirmation');
      const { planId, confirmationToken } = previewMetadata(preview.structuredContent);
      const confirmed = await core.callTool('openslack_confirm_plan', { planId, confirmationToken });
      expect(confirmed.structuredContent.status).toBe('completed');
      const runId = (confirmed.structuredContent.data as { outcomes: Array<{ data: { runId: string } }> }).outcomes[0]!.data.runId;
      await vi.waitFor(() => expect(host.read(runId)?.status).toBe('failed'), { timeout: 2500 });
      expect(gated).toBe(true);
      expect(execute).toHaveBeenCalledTimes(phase === 'start' ? 0 : 1);
      expect(host.read(runId)?.harnessExecution?.acceptance).not.toBe('verified');
      expect(readFileSync(join(value.context.worktreePath!, 'fixture.txt'), 'utf8')).toBe(phase === 'start' ? 'before' : 'after');
    } finally { transaction.mockRestore(); await value.close(); await host.close(100); }
  });

  it.runIf(process.env.DEEPSEEK_HARNESS_CHECKOUT)('executes the configured host through the real peer, SDK, native files and callback MCP, then reads verified acceptance', async () => {
    const harnessRoot = resolve(process.env.DEEPSEEK_HARNESS_CHECKOUT!);
    const pluginRoot = join(repositoryRoot, 'integrations/deepseek-harness');
    const { prepareSdkFixture } = await import(pathToFileURL(join(pluginRoot, 'tests/fixtures/sdk-profile.ts')).href) as {
      prepareSdkFixture(root: string, script: Array<string | { name: string; args: object; poll?: boolean }>): { home: string; patch: string; workspace: string; runtimeEntries: string };
    };
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'openslack-harness-compatibility-'));
    roots.push(fixtureRoot);
    const fixture = prepareSdkFixture(fixtureRoot, [
      { name: 'read', args: { file_path: 'fixture.txt' } },
      { name: 'write', args: { file_path: 'fixture.txt', content: 'after' } },
      { name: 'mcp__openslack__openslack_preview_workflow', args: { workflowId: 'harness.task.report', input: {
        runId: '$runId', reportId: 'progress-1', summary: 'Changed the approved fixture.', evidenceRefs: ['artifact:fixture'] } } },
      { name: 'mcp__openslack__openslack_confirm_plan', args: { planId: '$planId' } },
      'fixture complete',
    ]);
    const workspaceRoot = createWorkspace({ action: 'deny', noScenarios: true });
    const registry = join(workspaceRoot, '.openslack/agents/registry', `${PRINCIPAL_REF}.yaml`);
    writeFileSync(registry, readFileSync(registry, 'utf8').replace('  github:',
      '    harness.task.dispatch: allow\n    harness.task.report: allow\n  github:'));
    writeFileSync(join(workspaceRoot, 'fixture.txt'), 'before');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: workspaceRoot, encoding: 'utf8' }).trim();
    git('init', '--initial-branch=main');
    git('add', 'fixture.txt');
    git('-c', 'user.name=Keyless Harness Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture baseline');
    const baseline = git('rev-parse', 'HEAD');
    const deployment = { harnessRoot, pluginRoot, pluginBuildHash: hashHarnessPluginArtifacts(pluginRoot),
      nodeExecutable: process.execPath, nodeVersion: '24.18.1' as const, nodeSha256: hashHarnessNodeExecutable(process.execPath),
      dshHome: fixture.home, agentId: PRINCIPAL_REF, provider: 'openslack-fixture', model: 'fixture',
      workerPatch: fixture.patch, exitGraceMs: 10_000,
      callbackMcp: { cliModule: join(repositoryRoot, 'apps/cli/dist/index.js'), workspaceRoot, principalRef: PRINCIPAL_REF } };
    const verification = { resultMode: 'text' as const, requireReport: true, checks: [{ path: 'fixture.txt', expectedText: 'after' }] };
    const resolvedConfig = { agentId: PRINCIPAL_REF, source: 'fixture', runtimeProvider: 'deepseek-harness', model: 'fixture',
      tools: ['Read', 'Write', 'Edit', ...['openslack_get_activity', 'openslack_preview_workflow', 'openslack_confirm_plan', 'openslack_cancel_plan']
        .map(name => `mcp.openslack.${name}`)], permissionMode: 'acceptEdits' as const };
    const task = { taskId: 'TASK-2026-100001', principalId: `principal:${PRINCIPAL_REF}`, baseline, timeoutMs: 240_000,
      executionBuildHash: hashHarnessRuntimeArtifacts(harnessRoot), verificationHash: hashHarnessInput(verification), deploymentHash: hashHarnessDeployment(deployment),
      request: { agentId: PRINCIPAL_REF, prompt: 'Change only fixture.txt, report current-task progress, then answer fixture complete.',
        resolvedConfig, permissionProfile: buildHarnessTaskPermissionProfile(resolvedConfig) },
      scope: { readPaths: ['fixture.txt'], writePaths: ['fixture.txt'], forbiddenPaths: ['.git/**', '.openslack*/**'] },
      outputSchema: { type: 'string', const: 'fixture complete' },
    };
    const descriptor = { schema: 'openslack.harness_workspace_task.v1', sourceKind: 'approved-workspace-task', claimRequired: false,
      task, allowedPaths: ['fixture.txt'], forbiddenPaths: ['.git/**', '.openslack*/**'], verification };
    const directory = join(workspaceRoot, '.openslack.local/harness/tasks');
    mkdirSync(directory, { recursive: true });
    mkdirSync(join(workspaceRoot, '.openslack.local/collaboration'), { recursive: true });
    const path = join(directory, 'fixture.json');
    writeFileSync(path, JSON.stringify(descriptor));
    writeFileSync(join(workspaceRoot, '.openslack.local/harness/deployment.json'), JSON.stringify({
      schema: 'openslack.harness_deployment.v1', workspaceId: WORKSPACE_ID, identityRoot: workspaceRoot,
      principal: { agentId: PRINCIPAL_REF, uid: `${PRINCIPAL_REF}-uid`, principalId: `principal:${PRINCIPAL_REF}`,
        runtimeRunId: 'RUN-governed-composition-001', provider: 'cli' }, execution: deployment,
      tasks: { [task.taskId]: { path, sha256: hashHarnessInput(descriptor) } },
    }));
    const host = createConfiguredHarnessTaskHost(workspaceRoot, PRINCIPAL_REF)!;
    const callerRoot = join(fixtureRoot, 'caller');
    mkdirSync(callerRoot);
    const caller = prepareSdkFixture(callerRoot, [
      { name: 'mcp__openslack__openslack_preview_workflow', args: { workflowId: 'harness.task.dispatch', input: { taskId: task.taskId, requestId: 'first' } } },
      { name: 'mcp__openslack__openslack_confirm_plan', args: { planId: '$planId' } },
      { name: 'mcp__openslack__openslack_get_activity', args: { objectKind: 'workflow', objectId: '$runId' }, poll: true },
      'end-to-end verified',
    ]);
    const callerProfile = join(caller.home, 'profiles/sdk/cordis.patch.yml');
    const rows = JSON.parse(readFileSync(callerProfile, 'utf8')) as Array<{ insert: object[] }>;
    const callerSdk = rows[0]!.insert.find(row => 'id' in row && row.id === 'sdk-jsonrpc-server') as { disabled?: boolean };
    callerSdk.disabled = true;
    rows[0]!.insert.push({ id: 'openslack-sdk-host', name: '@openslack/deepseek-harness-plugin/sdk-host', config: {
      generation: 'fixture-caller', runtimeEntries: caller.runtimeEntries, startEligibility: JSON.stringify({ mode: 'not_applicable' }),
      mcp: { mode: 'task', workspaceRoot, cliModule: deployment.callbackMcp.cliModule,
        principalRef: PRINCIPAL_REF, timeoutMs: 240_000 },
    } }, { id: 'openslack-initiator', name: '@openslack/deepseek-harness-plugin/initiator', config: {
      taskId: task.taskId, principalId: `principal:${PRINCIPAL_REF}`, generation: 'fixture-caller', sessionId: 'openslack-caller',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    } });
    writeFileSync(callerProfile, JSON.stringify(rows));
    let passed = false;
    try {
      await host.observe('harness.task.dispatch', { taskId: task.taskId, requestId: 'compatibility-1' });
      const output = execFileSync(process.execPath, [join(pluginRoot, 'tests/fixtures/sdk-caller.mjs'),
        harnessRoot, caller.home, caller.workspace, caller.patch], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 270_000, maxBuffer: 32 * 1024 * 1024 });
      const result = JSON.parse(output) as { finalResponse: string; events: unknown[] };
      expect(result.finalResponse, JSON.stringify(result.events.slice(-5))).toBe('end-to-end verified');
      const runIds = readdirSync(join(workspaceRoot, '.openslack.local/agents/runs')).filter(name => name.startsWith('RUN-'));
      expect(runIds).toHaveLength(1);
      const runId = runIds[0]!;
      const state = host.read(runId)!;
      expect(state.harnessExecution?.reports).toHaveProperty('progress-1');
      expect(state.harnessExecution?.acceptance).toBe('verified');
      expect(readFileSync(join(state.worktreePath!, 'fixture.txt'), 'utf8')).toBe('after');
      const core = new OpenSlackMcpCore(createOpenSlackMcpContext({ workspaceRoot, operator: operator() }));
      const activity = await core.callTool('openslack_get_activity', { objectKind: 'workflow', objectId: runId });
      expect(activity.structuredContent.data).toMatchObject({ execution: { taskId: task.taskId, runId, status: 'completed', acceptance: 'verified' } });
      const requests = readFileSync(join(fixtureRoot, 'requests.jsonl'), 'utf8');
      expect(requests.split('\n').filter(Boolean)).toHaveLength(5);
      expect(requests).not.toContain('confirmationToken');
      const beforeReconnect = readFileSync(join(workspaceRoot, '.openslack.local/agents/runs', runId, 'run.json'));
      await expect(host.dispatch(task.taskId, 'reconnect')).rejects.toThrow('requires its originating governed confirmation binding');
      const reconnected = await core.callTool('openslack_get_activity', { objectKind: 'workflow', objectId: runId });
      expect(reconnected.structuredContent.data).toMatchObject({ execution: { taskId: task.taskId, runId, acceptance: 'verified' } });
      expect(readFileSync(join(workspaceRoot, '.openslack.local/agents/runs', runId, 'run.json'))).toEqual(beforeReconnect);
      expect(readdirSync(join(workspaceRoot, '.openslack.local/agents/runs')).filter(name => name.startsWith('RUN-'))).toEqual([runId]);
      expect(readFileSync(join(fixtureRoot, 'requests.jsonl'), 'utf8')).toBe(requests);
      const callerRequests = readFileSync(join(callerRoot, 'requests.jsonl'), 'utf8');
      expect(callerRequests).not.toContain('confirmationToken');
      expect(JSON.stringify(result.events)).not.toContain('confirmationToken');
      expect(callerRequests).toContain('verified');
      const authority = createHarnessTaskAuthority({ identityRoot: workspaceRoot, agentId: PRINCIPAL_REF,
        uid: `${PRINCIPAL_REF}-uid`, principalId: `principal:${PRINCIPAL_REF}`,
        runtimeRunId: 'RUN-governed-composition-001', provider: 'cli', claimMode: 'not_applicable',
        source: { read: async () => ({ ...descriptor, sourceDigest: hashHarnessInput(descriptor) }) },
      });
      const runFile = join(workspaceRoot, '.openslack.local/agents/runs', runId, 'run.json');
      const beforeRecovery = readFileSync(runFile);
      const readonlyRoot = join(fixtureRoot, 'readonly-caller');
      mkdirSync(readonlyRoot);
      const readonly = prepareSdkFixture(readonlyRoot, [
        { name: 'mcp__openslack__openslack_get_activity', args: { objectKind: 'workflow', objectId: runId } },
        'read-only verified',
      ]);
      const readonlyProfile = join(readonly.home, 'profiles/sdk/cordis.patch.yml');
      const readonlyRows = JSON.parse(readFileSync(readonlyProfile, 'utf8')) as Array<{ insert: object[] }>;
      const readonlySdk = readonlyRows[0]!.insert.find(row => 'id' in row && row.id === 'sdk-jsonrpc-server') as { disabled?: boolean };
      readonlySdk.disabled = true;
      readonlyRows[0]!.insert.push({ id: 'openslack-sdk-host', name: '@openslack/deepseek-harness-plugin/sdk-host',
        config: { generation: 'fixture-readonly', runtimeEntries: readonly.runtimeEntries, startEligibility: JSON.stringify({ mode: 'not_applicable' }) } });
      (readonlyRows as object[]).push({ id: 'openslack-readonly', disabled: false,
        config: { workspaceRoot, cliModule: deployment.callbackMcp.cliModule, timeoutMs: 120_000, runtimeEntries: readonly.runtimeEntries } });
      writeFileSync(readonlyProfile, JSON.stringify(readonlyRows));
      const readonlyOutput = execFileSync(process.execPath, [join(pluginRoot, 'tests/fixtures/sdk-caller.mjs'),
        harnessRoot, readonly.home, readonly.workspace, readonly.patch, `Read the existing workflow ${runId}; do not dispatch.`, 'fixture-readonly'],
      { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 150_000, maxBuffer: 32 * 1024 * 1024 });
      const readonlyResult = JSON.parse(readonlyOutput) as { finalResponse: string; events: Array<{ type: string;
        data: { message?: { isError?: boolean; content: Array<{ text?: string }> } } }> };
      expect(readonlyResult.finalResponse).toBe('read-only verified');
      const readResults = readonlyResult.events.filter(event => event.type === 'tool/result');
      expect(readResults).toHaveLength(1);
      expect(readResults[0]!.data.message?.isError).not.toBe(true);
      const readText = readResults[0]!.data.message!.content.map(block => block.text ?? '').join('\n');
      expect(readText).toContain(runId);
      expect(readText).toContain('verified');
      const readonlyRequests = readFileSync(join(readonlyRoot, 'requests.jsonl'), 'utf8');
      const readonlyTools = [...new Set([...readonlyRequests.matchAll(/"name":"(mcp__openslack__[^\"]+)"/g)].map(match => match[1]))].sort();
      expect(readonlyTools).toEqual(OPENSLACK_READ_TOOL_NAMES.map(name => `mcp__openslack__${name}`).sort());
      expect(await reconcileHarnessTask({ identityRoot: workspaceRoot, ...authority,
        inspect: (approvedTask, run) => inspectHarnessTaskExecution({ workspaceRoot, identityRoot: workspaceRoot,
          deployment, verification: () => verification }, approvedTask, run),
      }, runId)).toMatchObject({ disposition: 'existing_verified_result', process: 'exited', workspace: 'matched' });
      expect(readFileSync(runFile)).toEqual(beforeRecovery);
      expect(readFileSync(join(fixtureRoot, 'requests.jsonl'), 'utf8')).toBe(requests);
      expect(readFileSync(state.transcriptPath, 'utf8')).not.toContain('confirmationToken');
      for (const logRoot of [fixtureRoot, callerRoot, readonlyRoot]) {
        const logs = readdirSync(join(logRoot, 'logs'), { recursive: true, withFileTypes: true })
          .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'));
        expect(logs.length).toBeGreaterThan(0);
        for (const entry of logs) expect(readFileSync(join(entry.parentPath, entry.name), 'utf8')).not.toContain('confirmationToken');
      }
      passed = true;
    } finally {
      expect((await host.close(15_000)).stopped).toBe(true);
      if (!passed || process.env.OPENSLACK_HARNESS_KEEP_EVIDENCE === '1') {
        roots.splice(roots.indexOf(fixtureRoot), 1); roots.splice(roots.indexOf(workspaceRoot), 1);
        console.info(`Keyless closed-loop ${passed ? 'evidence' : 'failure'} retained: ${fixtureRoot}, ${workspaceRoot}`);
      }
    }
  }, 300_000);
});
