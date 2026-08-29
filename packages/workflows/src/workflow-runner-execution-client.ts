import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfirmationPolicy, RunResult, WorkflowMeta, WorkflowSource } from './types.js';
import { canonicalWorkflowEffectJson } from './workflow-effect-json.js';
import { RunStore } from './run-store.js';
import {
  createWorkflowRunnerExecutionDescriptor,
  hashWorkflowRunnerResult,
} from './workflow-runner-descriptor.js';
import type { WorkflowControlAuthorityPort } from './workflow-control-authority-client.js';
import {
  WorkflowRunRouteJournal,
  WorkflowRunRouter,
  type WorkflowRunRouteReceipt,
} from './workflow-run-routing.js';
import { loadWorkflowRunRoutingExecutionConfig } from './workflow-run-routing-config.js';
import {
  createWorkflowRunnerV2ExecutionDescriptor,
  hashWorkflowRunnerV2Input,
  hashWorkflowRunnerV2Manifest,
  hashWorkflowRunnerV2Source,
  WORKFLOW_RUNNER_V2_DESCRIPTOR_CODEC,
  type WorkflowRunnerV2BudgetPolicyBinding,
} from './workflow-runner-v2-descriptor.js';
import {
  prepareWorkflowRunnerV2JobSpec,
  WorkflowRunnerV2ControlClient,
  WORKFLOW_RUNNER_V2_JOB_SPEC_SCHEMA,
  type WorkflowRunnerV2ControlPort,
} from './workflow-runner-v2-control-client.js';
import { WORKFLOW_RUNNER_CAPABILITIES } from './workflow-runner-contract.js';
import { WorkflowRunnerDescriptorStore } from './workflow-runner-descriptor-store.js';
import {
  loadWorkflowRunnerControlConfig,
  prepareWorkflowRunnerJobSpec,
  WorkflowRunnerControlClient,
  WorkflowRunnerControlError,
  WORKFLOW_RUNNER_JOB_SPEC_SCHEMA,
  type WorkflowRunnerControlConfig,
  type WorkflowRunnerControlPort,
  type WorkflowRunnerJobView,
} from './workflow-runner-control-client.js';

export interface ExecuteWorkflowThroughRunnerInput {
  readonly workspaceRoot: string;
  readonly workflowRunId?: string;
  readonly correlationId?: string;
  readonly workflowSource: WorkflowSource;
  readonly workflowSourceBytes: Uint8Array;
  readonly manifest: WorkflowMeta;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly budget?: { readonly tokens: number; readonly costUsd: number };
  readonly confirmationPolicy: ConfirmationPolicy;
  readonly wholeTimeoutMs?: number;
  readonly descriptorLifetimeMs?: number;
  readonly signal?: AbortSignal;
  readonly config?: WorkflowRunnerControlConfig;
  readonly client?: WorkflowRunnerControlPort;
  readonly now?: () => Date;
  readonly routing?: {
    readonly router: WorkflowRunRouter;
    readonly journal?: Pick<WorkflowRunRouteJournal, 'commit'>;
    readonly authority?: WorkflowControlAuthorityPort;
    readonly v2Client?: WorkflowRunnerV2ControlPort;
    readonly v2BudgetPolicy?: WorkflowRunnerV2BudgetPolicyBinding;
  };
}

export interface WorkflowRunnerPausedResult extends RunResult {
  readonly status: 'paused' | 'paused_waiting_approval';
  readonly runId: string;
}

export async function readWorkflowRunnerSourceBytes(input: {
  readonly workflowName: string;
  readonly discoveredPath: string;
  readonly source: WorkflowSource;
}): Promise<Uint8Array> {
  let path = input.discoveredPath;
  if (input.source === 'builtin') {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.workflowName)) {
      throw new WorkflowRunnerControlError(
        'WORKFLOW_RUNNER_CONTROL_INPUT_INVALID',
        'Runner builtin workflow identity is invalid.',
      );
    }
    const root = join(import.meta.dirname, 'builtins');
    const names = new Set(await readdir(root));
    const candidates = ['.js', '.mjs', '.ts']
      .filter((extension) => names.has(`${input.workflowName}${extension}`))
      .map((extension) => join(root, `${input.workflowName}${extension}`));
    if (candidates.length !== 1) {
      throw new WorkflowRunnerControlError(
        'WORKFLOW_RUNNER_CONTROL_INPUT_INVALID',
        'Runner builtin workflow source is missing or ambiguous.',
      );
    }
    path = candidates[0]!;
  }
  return readFile(path);
}

function safeGeneratedId(prefix: string): string {
  return `${prefix}.${randomUUID()}`;
}

const ZERO_BUILD_HASH = '0'.repeat(64);
const DEFAULT_TS_ROUTE_EXPIRES_AT = '9999-12-31T23:59:59.999Z';
const defaultRouters = new Map<string, WorkflowRunRouter>();

function defaultTsRouter(workspaceId: string): WorkflowRunRouter {
  const existing = defaultRouters.get(workspaceId);
  if (existing) return existing;
  const router = new WorkflowRunRouter({
    schema: 'openslack.workflow_run_routing_policy.v1',
    workspaceId,
    backend: 'ts-local',
    authority: 'typescript',
    routingEpoch: 1,
    authorityBuildHash: ZERO_BUILD_HASH,
    qualificationEnvironmentId: 'local-default',
    workflowAllowlist: [],
    runAllowlist: [],
    // This policy is the deterministic legacy default, not a canary lease.
    // Its bytes must survive process restarts so epoch 1 never acquires a
    // second policy hash merely because the process start time changed.
    expiresAt: DEFAULT_TS_ROUTE_EXPIRES_AT,
  });
  defaultRouters.set(workspaceId, router);
  return router;
}

async function freezeRunRoute(input: {
  readonly execution: ExecuteWorkflowThroughRunnerInput;
  readonly routing?: ExecuteWorkflowThroughRunnerInput['routing'];
  readonly workspaceId: string;
  readonly workflowRunId: string;
  readonly correlationId: string;
  readonly descriptor: ReturnType<typeof createWorkflowRunnerExecutionDescriptor>;
  readonly selectedAt: string;
}): Promise<WorkflowRunRouteReceipt> {
  const router = input.routing?.router ?? defaultTsRouter(input.workspaceId);
  const go = router.policy.backend === 'go';
  const args = input.execution.args ?? {};
  const route = router.select({
    workspaceId: input.workspaceId,
    runId: input.workflowRunId,
    workflowId: input.descriptor.workflowId,
    workflowVersion: input.descriptor.workflowVersion,
    workflowSourceHash: go
      ? hashWorkflowRunnerV2Source(input.execution.workflowSourceBytes)
      : input.descriptor.workflowSourceHash,
    manifestHash: go
      ? hashWorkflowRunnerV2Manifest(input.execution.manifest)
      : input.descriptor.manifestHash,
    inputHash: go ? hashWorkflowRunnerV2Input(args) : input.descriptor.inputHash,
    correlationId: input.correlationId,
    selectedAt: input.selectedAt,
  });
  const journal =
    input.routing?.journal ??
    new WorkflowRunRouteJournal(
      join(input.execution.workspaceRoot, '.openslack.local', 'workflows', 'routes'),
    );
  const committed = await journal.commit(route);
  if (canonicalWorkflowEffectJson(committed) !== canonicalWorkflowEffectJson(route)) {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID',
      'Route journal returned a receipt that differs from the selected immutable route.',
    );
  }
  return committed;
}

function assertGoAuthorityHead(
  route: WorkflowRunRouteReceipt,
  head: Awaited<ReturnType<WorkflowControlAuthorityPort['read']>>,
): void {
  if (
    head.workspaceId !== route.workspaceId ||
    head.runId !== route.runId ||
    head.workflowId !== route.workflowId ||
    head.workflowVersion !== route.workflowVersion ||
    head.workflowSourceHash !== route.workflowSourceHash ||
    head.manifestHash !== route.manifestHash ||
    head.inputHash !== route.inputHash ||
    head.route.backend !== route.route.backend ||
    head.route.authority !== route.route.authority ||
    head.route.routingEpoch !== route.route.routingEpoch ||
    head.route.authorityBuildHash !== route.route.authorityBuildHash ||
    head.record.workspaceId !== head.workspaceId ||
    head.record.runId !== head.runId ||
    head.record.revision !== head.revision ||
    head.record.state !== head.state
  ) {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID',
      'Workflow Control authority head does not bind the immutable route receipt.',
    );
  }
}

function assertTerminalIdentity(input: {
  readonly terminal: WorkflowRunnerJobView;
  readonly workspaceId: string;
  readonly jobId: string;
  readonly workflowRunId: string;
  readonly correlationId: string;
}): void {
  if (
    input.terminal.workspaceId !== input.workspaceId ||
    input.terminal.jobId !== input.jobId ||
    input.terminal.workflowRunId !== input.workflowRunId ||
    input.terminal.correlationId !== input.correlationId
  ) {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID',
      'Runner terminal view does not bind the submitted job.',
    );
  }
}

function terminalError(view: WorkflowRunnerJobView): never {
  const status = view.terminalStatus ?? view.state;
  const reconciliation =
    status === 'reconciliation_required' || view.state === 'reconciliation_required';
  throw new WorkflowRunnerControlError(
    reconciliation
      ? 'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED'
      : status === 'timed_out'
        ? 'WORKFLOW_RUNNER_CONTROL_TIMEOUT'
        : 'WORKFLOW_RUNNER_CONTROL_REJECTED',
    `Workflow runner job terminated with status ${status}.`,
  );
}

/**
 * Freeze one immutable run route and submit through its bound runner protocol.
 * TypeScript and rollback routes use v1; an explicitly allowlisted Go
 * new-record route durably accepts the run before using v2. Direct
 * executeRun/executeResume remain fail-closed without worker authorities.
 */
export async function executeWorkflowThroughRunner(
  input: ExecuteWorkflowThroughRunnerInput,
): Promise<RunResult | WorkflowRunnerPausedResult> {
  const now = input.now ?? (() => new Date());
  const created = now();
  const wholeTimeoutMs = input.wholeTimeoutMs ?? 60 * 60_000;
  const descriptorLifetimeMs = input.descriptorLifetimeMs ?? wholeTimeoutMs;
  const workflowRunId = input.workflowRunId ?? safeGeneratedId('run');
  const correlationId = input.correlationId ?? safeGeneratedId('correlation');
  const jobId = safeGeneratedId('job');
  const descriptorRef = safeGeneratedId('descriptor');
  if (input.confirmationPolicy.runId !== workflowRunId) {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_INPUT_INVALID',
      'Runner confirmation policy must bind the workflow run identity.',
    );
  }
  if (
    !Number.isSafeInteger(wholeTimeoutMs) ||
    wholeTimeoutMs < 1_000 ||
    wholeTimeoutMs > 24 * 60 * 60_000 ||
    !Number.isSafeInteger(descriptorLifetimeMs) ||
    descriptorLifetimeMs < wholeTimeoutMs ||
    descriptorLifetimeMs > 24 * 60 * 60_000
  ) {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_INPUT_INVALID',
      'Runner execution time bounds are invalid.',
    );
  }
  const config = input.config ?? loadWorkflowRunnerControlConfig();
  const client = input.client ?? new WorkflowRunnerControlClient(config);
  if (client.descriptorRoot !== config.descriptorRoot) {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID',
      'Runner client and descriptor store roots do not match.',
    );
  }
  const routing = input.routing ?? loadWorkflowRunRoutingExecutionConfig(config);
  const selectedGo = routing?.router.policy.backend === 'go';
  const goAuthority = routing?.authority;
  const goBudgetPolicy = routing?.v2BudgetPolicy;
  const goV2Client =
    routing?.v2Client ?? (selectedGo ? new WorkflowRunnerV2ControlClient(config) : undefined);
  if (!selectedGo && (goAuthority || goBudgetPolicy || goV2Client)) {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID',
      'A TypeScript route cannot retain Go authority or v2 submission dependencies.',
    );
  }
  if (selectedGo && (!goAuthority || !goBudgetPolicy || !goV2Client)) {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID',
      'A selected Go route requires the Workflow Control authority and exact v2 budget policy.',
    );
  }
  if (goV2Client && goV2Client.descriptorRoot !== config.descriptorRoot) {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID',
      'V2 runner client and descriptor store roots do not match.',
    );
  }
  const args = input.args ?? {};
  const budget = input.budget ?? { tokens: 100_000, costUsd: 1 };
  const descriptor = createWorkflowRunnerExecutionDescriptor({
    descriptorRef,
    workspaceId: config.workspaceId,
    workflowRunId,
    correlationId,
    workflowId: input.manifest.name,
    workflowVersion: input.manifest.version ?? '0.0.0',
    workflowSource: input.workflowSource,
    workflowSourceBytes: input.workflowSourceBytes,
    manifest: input.manifest,
    input: args,
    budget,
    confirmationPolicy: input.confirmationPolicy,
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + descriptorLifetimeMs).toISOString(),
  });
  const route = await freezeRunRoute({
    execution: input,
    routing,
    workspaceId: config.workspaceId,
    workflowRunId,
    correlationId,
    descriptor,
    selectedAt: created.toISOString(),
  });
  if (route.route.backend === 'go') {
    const authority = goAuthority!;
    const budgetPolicy = goBudgetPolicy!;
    const v2Client = goV2Client!;
    const v2Descriptor = createWorkflowRunnerV2ExecutionDescriptor({
      descriptorRef,
      workspaceId: config.workspaceId,
      workflowRunId,
      correlationId,
      workflowId: input.manifest.name,
      workflowVersion: input.manifest.version ?? '0.0.0',
      workflowSource: input.workflowSource,
      workflowSourceBytes: input.workflowSourceBytes,
      manifest: input.manifest,
      input: args,
      confirmationPolicy: input.confirmationPolicy,
      requiredCapabilities: WORKFLOW_RUNNER_CAPABILITIES,
      authorityRoute: route.route,
      runRevision: 1,
      resumeGeneration: 0,
      budgetPolicy,
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + descriptorLifetimeMs).toISOString(),
    });
    if (
      v2Descriptor.workflowSourceHash !== route.workflowSourceHash ||
      v2Descriptor.manifestHash !== route.manifestHash ||
      v2Descriptor.inputHash !== route.inputHash
    ) {
      throw new WorkflowRunnerControlError(
        'WORKFLOW_RUNNER_CONTROL_INPUT_INVALID',
        'V2 descriptor content does not match the immutable route receipt.',
      );
    }
    const descriptorStore = new WorkflowRunnerDescriptorStore(
      config.descriptorRoot,
      undefined,
      WORKFLOW_RUNNER_V2_DESCRIPTOR_CODEC,
    );
    const sealed = await descriptorStore.create(v2Descriptor);
    await authority.accept(route, input.signal);
    const acceptedHead = await authority.read(workflowRunId, route.route, input.signal);
    assertGoAuthorityHead(route, acceptedHead);
    if (
      acceptedHead.state !== 'created' ||
      acceptedHead.revision !== 1 ||
      acceptedHead.resumeGeneration !== 0
    ) {
      throw new WorkflowRunnerControlError(
        'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
        'Go run accept did not produce the exact initial durable authority head.',
      );
    }
    const prepared = prepareWorkflowRunnerV2JobSpec({
      schema: WORKFLOW_RUNNER_V2_JOB_SPEC_SCHEMA,
      workspaceId: config.workspaceId,
      jobId,
      workflowRunId,
      correlationId,
      executionDescriptorRef: v2Descriptor.descriptorRef,
      executionDescriptorHash: sealed.descriptorHash,
      workflowId: v2Descriptor.workflowId,
      workflowVersion: v2Descriptor.workflowVersion,
      workflowSourceHash: v2Descriptor.workflowSourceHash,
      manifestHash: v2Descriptor.manifestHash,
      inputHash: v2Descriptor.inputHash,
      wholeTimeoutMs,
      submittedAt: created.toISOString(),
      requiredProtocolVersion: v2Descriptor.requiredProtocolVersion,
      requiredCapabilities: v2Descriptor.requiredCapabilities,
      authorityRoute: v2Descriptor.authorityRoute,
      runRevision: v2Descriptor.runRevision,
      resumeGeneration: v2Descriptor.resumeGeneration,
    });
    await v2Client.submit(prepared, input.signal);
    const terminal = await client.waitForTerminal(jobId, {
      timeoutMs: wholeTimeoutMs,
      signal: input.signal,
    });
    assertTerminalIdentity({
      terminal,
      workspaceId: config.workspaceId,
      jobId,
      workflowRunId,
      correlationId,
    });
    const head = await authority.read(workflowRunId, route.route, input.signal);
    assertGoAuthorityHead(route, head);
    const projection = new RunStore({
      baseDir: join(
        input.workspaceRoot,
        '.openslack.local',
        'workflows',
        'go-recovery-projections',
      ),
    });
    const status = await projection.loadStatus(workflowRunId);
    if (status?.status === 'paused' || status?.status === 'paused_waiting_approval') {
      if (head.state !== status.status) {
        throw new WorkflowRunnerControlError(
          'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
          'Go authority and recovery projection disagree on the paused terminal.',
        );
      }
      if (terminal.state === 'terminal' && terminal.terminalStatus === 'failed') {
        return Object.freeze({ status: status.status, runId: workflowRunId });
      }
      return terminalError(terminal);
    }
    if (terminal.terminalStatus !== 'completed' || terminal.resultHash === null) {
      if (head.state === 'created' || head.state === 'running' || head.state === 'resuming') {
        throw new WorkflowRunnerControlError(
          'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
          'Runner terminated before the Go authority reached a matching terminal state.',
        );
      }
      return terminalError(terminal);
    }
    if (head.state !== 'completed' || status?.status !== 'completed') {
      throw new WorkflowRunnerControlError(
        'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
        'Runner completed without a matching Go authority terminal state.',
      );
    }
    const output = await projection.loadOutput(workflowRunId);
    if (
      output === null ||
      typeof output !== 'object' ||
      hashWorkflowRunnerResult(output) !== terminal.resultHash
    ) {
      throw new WorkflowRunnerControlError(
        'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID',
        'Runner result does not match the Go recovery projection output artifact.',
      );
    }
    return output as RunResult;
  }
  const descriptorStore = new WorkflowRunnerDescriptorStore(config.descriptorRoot);
  const sealed = await descriptorStore.create(descriptor);
  const prepared = prepareWorkflowRunnerJobSpec({
    schema: WORKFLOW_RUNNER_JOB_SPEC_SCHEMA,
    workspaceId: config.workspaceId,
    jobId,
    workflowRunId,
    correlationId,
    executionDescriptorRef: descriptor.descriptorRef,
    executionDescriptorHash: sealed.descriptorHash,
    workflowId: descriptor.workflowId,
    workflowVersion: descriptor.workflowVersion,
    workflowSourceHash: descriptor.workflowSourceHash,
    manifestHash: descriptor.manifestHash,
    inputHash: descriptor.inputHash,
    wholeTimeoutMs,
    submittedAt: created.toISOString(),
  });
  const receipt = await client.submit(prepared, input.signal);
  if (receipt.status === 'reconciliation_required') {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
      'Workflow runner admission requires reconciliation.',
    );
  }
  const terminal = await client.waitForTerminal(jobId, {
    timeoutMs: wholeTimeoutMs,
    signal: input.signal,
  });
  assertTerminalIdentity({
    terminal,
    workspaceId: config.workspaceId,
    jobId,
    workflowRunId,
    correlationId,
  });
  const runStore = new RunStore({
    baseDir: join(input.workspaceRoot, '.openslack.local', 'workflows'),
  });
  const status = await runStore.loadStatus(workflowRunId);
  if (status?.status === 'paused' || status?.status === 'paused_waiting_approval') {
    if (terminal.state === 'terminal' && terminal.terminalStatus === 'failed') {
      return Object.freeze({ status: status.status, runId: workflowRunId });
    }
    return terminalError(terminal);
  }
  if (terminal.terminalStatus !== 'completed' || terminal.resultHash === null) {
    return terminalError(terminal);
  }
  if (status?.status !== 'completed') {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID',
      'Runner completed without a matching durable RunStore terminal state.',
    );
  }
  const output = await runStore.loadOutput(workflowRunId);
  if (
    output === null ||
    typeof output !== 'object' ||
    hashWorkflowRunnerResult(output) !== terminal.resultHash
  ) {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID',
      'Runner result does not match the durable RunStore output.',
    );
  }
  return output as RunResult;
}
