import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfirmationPolicy, RunResult, WorkflowMeta, WorkflowSource } from './types.js';
import { createWorkflowRunProjectionStore } from './workflow-run-projection.js';
import {
  createWorkflowRunnerExecutionDescriptor,
  hashWorkflowRunnerResult,
} from './workflow-runner-descriptor.js';
import {
  workflowControlAuthorityInitialRecord,
  type WorkflowControlAuthorityPort,
  type WorkflowControlAuthorityRunRead,
  type WorkflowControlAuthorityRunRecord,
} from './workflow-control-authority-client.js';
import { type WorkflowRunRouteReceipt } from './workflow-run-routing.js';
import type { WorkflowRunRoutingExecutionContext } from './workflow-run-routing-config.js';
import type { WorkflowRunRouteJournalEntry } from './workflow-run-routing.js';
import {
  createWorkflowRunnerV2ExecutionDescriptor,
  hashWorkflowRunnerV2Input,
  hashWorkflowRunnerV2Manifest,
  hashWorkflowRunnerV2Result,
  hashWorkflowRunnerV2Source,
  WORKFLOW_RUNNER_V2_DESCRIPTOR_CODEC,
} from './workflow-runner-v2-descriptor.js';
import {
  prepareWorkflowRunnerV2JobSpec,
  WORKFLOW_RUNNER_V2_JOB_SPEC_SCHEMA,
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
  readonly routing?: WorkflowRunRoutingExecutionContext;
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

async function resolveRunRoute(input: {
  readonly execution: ExecuteWorkflowThroughRunnerInput;
  readonly routing?: WorkflowRunRoutingExecutionContext;
  readonly existing?: WorkflowRunRouteReceipt | null;
  readonly workspaceId: string;
  readonly workflowRunId: string;
  readonly correlationId: string;
  readonly identity: {
    readonly workflowId: string;
    readonly workflowVersion: string;
    readonly workflowSourceHash: string;
    readonly manifestHash: string;
    readonly inputHash: string;
  };
  readonly selectedAt: string;
}): Promise<WorkflowRunRouteReceipt | null> {
  const existing =
    input.existing === undefined
      ? await input.routing?.journal.load(input.workflowRunId)
      : input.existing;
  if (existing) {
    if (
      existing.workspaceId !== input.workspaceId ||
      existing.workflowId !== input.identity.workflowId ||
      existing.workflowVersion !== input.identity.workflowVersion ||
      existing.workflowSourceHash !== input.identity.workflowSourceHash ||
      existing.manifestHash !== input.identity.manifestHash ||
      existing.inputHash !== input.identity.inputHash ||
      (input.execution.correlationId !== undefined &&
        input.execution.correlationId !== existing.correlationId)
    ) {
      throw new WorkflowRunnerControlError(
        'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
        'Existing routed run identity differs from the requested execution.',
      );
    }
    return existing;
  }
  if (!input.routing || input.routing.mode === 'disabled') return null;
  const router = input.routing.router!;
  const route = router.select({
    workspaceId: input.workspaceId,
    runId: input.workflowRunId,
    ...input.identity,
    correlationId: input.correlationId,
    selectedAt: input.selectedAt,
  });
  return input.routing.journal.commit(route);
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

function isExactInitialGoAuthorityHead(
  route: WorkflowRunRouteReceipt,
  head: WorkflowControlAuthorityRunRead,
  state: 'created' | 'running',
  revision: 1 | 2,
): boolean {
  try {
    assertGoAuthorityHead(route, head);
  } catch {
    return false;
  }
  const initial = workflowControlAuthorityInitialRecord(route);
  const expected: WorkflowControlAuthorityRunRecord = { ...initial, state, revision };
  const record = head.record;
  return (
    head.state === state &&
    head.revision === revision &&
    head.currentPhaseId === null &&
    head.currentPhaseIndex === null &&
    head.resumeGeneration === 0 &&
    record.schema === expected.schema &&
    record.workspaceId === expected.workspaceId &&
    record.runId === expected.runId &&
    record.workflowId === expected.workflowId &&
    record.workflowVersion === expected.workflowVersion &&
    record.workflowSourceHash === expected.workflowSourceHash &&
    record.manifestHash === expected.manifestHash &&
    record.inputHash === expected.inputHash &&
    record.route.backend === expected.route.backend &&
    record.route.authority === expected.route.authority &&
    record.route.routingEpoch === expected.route.routingEpoch &&
    record.route.authorityBuildHash === expected.route.authorityBuildHash &&
    record.state === expected.state &&
    record.revision === expected.revision &&
    record.currentPhaseId === null &&
    record.currentPhaseIndex === null &&
    record.resumeGeneration === 0
  );
}

function initialAuthorityReconciliation(
  message: string,
  mutationError: unknown,
  readError?: unknown,
): WorkflowRunnerControlError {
  return new WorkflowRunnerControlError(
    'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
    message,
    {
      cause:
        readError === undefined
          ? mutationError
          : new AggregateError(
              [mutationError, readError],
              'Authority mutation and reconciliation read both failed.',
            ),
    },
  );
}

async function establishInitialGoAuthority(input: {
  readonly authority: WorkflowControlAuthorityPort;
  readonly route: WorkflowRunRouteReceipt;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const { authority, route } = input;
  let recoveredHead: WorkflowControlAuthorityRunRead | null = null;
  try {
    await authority.accept(route, input.signal);
  } catch (acceptError) {
    try {
      recoveredHead = await authority.readIfExists(route.runId, route.route, input.signal);
    } catch (readError) {
      throw initialAuthorityReconciliation(
        'The initial Go authority accept outcome could not be reconciled.',
        acceptError,
        readError,
      );
    }
    if (
      recoveredHead === null ||
      (!isExactInitialGoAuthorityHead(route, recoveredHead, 'created', 1) &&
        !isExactInitialGoAuthorityHead(route, recoveredHead, 'running', 2))
    ) {
      throw initialAuthorityReconciliation(
        'The initial Go authority accept outcome does not match the requested run.',
        acceptError,
      );
    }
    if (isExactInitialGoAuthorityHead(route, recoveredHead, 'running', 2)) return;
  }

  const createdRecord = workflowControlAuthorityInitialRecord(route);
  try {
    await authority.transition(
      { ...createdRecord, state: 'running', revision: 2 },
      {
        revision: createdRecord.revision,
        state: createdRecord.state,
        currentPhaseId: createdRecord.currentPhaseId,
        currentPhaseIndex: createdRecord.currentPhaseIndex,
        resumeGeneration: createdRecord.resumeGeneration,
      },
      route.correlationId,
      input.signal,
    );
  } catch (transitionError) {
    let head: WorkflowControlAuthorityRunRead | null;
    try {
      head = await authority.readIfExists(route.runId, route.route, input.signal);
    } catch (readError) {
      throw initialAuthorityReconciliation(
        'The initial Go authority running transition could not be reconciled.',
        transitionError,
        readError,
      );
    }
    if (head !== null && isExactInitialGoAuthorityHead(route, head, 'running', 2)) return;
    throw initialAuthorityReconciliation(
      'The initial Go authority running transition was not durably committed.',
      transitionError,
    );
  }
}

async function preflightGoRouting(input: {
  readonly routing: WorkflowRunRoutingExecutionContext;
  readonly workspaceId: string;
  readonly route: WorkflowRunRouteReceipt['route'];
  readonly fresh: boolean;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const router = input.routing.router;
  const authority = input.routing.authority;
  const runner = input.routing.v2Client;
  const expected = input.routing.binding;
  if (!router || !authority || !runner || !expected) {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID',
      'Go routing requires complete authenticated startup bindings.',
    );
  }
  const [authorityBinding, runnerBinding] = await Promise.all([
    authority.inspectBinding(input.route.routingEpoch, input.signal),
    runner.inspectBinding(input.signal),
  ]);
  if (
    authorityBinding.workspaceId !== input.workspaceId ||
    authorityBinding.callerId !== expected.authorityCallerId ||
    authorityBinding.mode !== 'new-record-canary-v1' ||
    (authorityBinding.activeRoutingEpoch !== input.route.routingEpoch &&
      !authorityBinding.drainRoutingEpochs.includes(input.route.routingEpoch)) ||
    authorityBinding.buildSha !== input.route.authorityBuildHash ||
    (input.fresh &&
      (!authorityBinding.acceptNewRecords ||
        authorityBinding.activeRoutingEpoch !== input.route.routingEpoch)) ||
    runnerBinding.workspaceId !== expected.runnerWorkspaceId ||
    runnerBinding.buildSha !== expected.runnerBuildSha ||
    runnerBinding.runnerTokenSha256 !== expected.runnerTokenSha256 ||
    !runnerBinding.v2Enabled ||
    !runnerBinding.runtimeDeliveryEnabled ||
    !runnerBinding.newRecordCanary ||
    runnerBinding.authorityOrigin !== expected.authorityOrigin ||
    runnerBinding.authorityCallerId !== expected.authorityCallerId ||
    runnerBinding.authorityBuildSha !== expected.authorityBuildSha ||
    runnerBinding.authorityTokenSha256 !== expected.authorityTokenSha256
  ) {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID',
      'CLI, runner, and Workflow Control authority bindings do not match.',
    );
  }
}

async function replayClosedProjection(input: {
  readonly workspaceRoot: string;
  readonly entry: WorkflowRunRouteJournalEntry;
  readonly authority?: WorkflowControlAuthorityPort;
  readonly signal?: AbortSignal;
}): Promise<RunResult> {
  const { receipt } = input.entry;
  const store = createWorkflowRunProjectionStore(input.workspaceRoot, receipt.route.backend);
  const status = await store.loadStatus(receipt.runId);
  if (receipt.route.backend === 'go') {
    if (!input.authority) {
      throw new WorkflowRunnerControlError(
        'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID',
        'A closed Go route requires its matching authority configuration.',
      );
    }
    const head = await input.authority.readIfExists(receipt.runId, receipt.route, input.signal);
    if (!head || head.state !== status?.status) {
      throw new WorkflowRunnerControlError(
        'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
        'Closed Go route authority and projection do not agree.',
      );
    }
  }
  if (status?.status !== 'completed') {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_REJECTED',
      `Closed workflow run cannot be executed again (${status?.status ?? 'missing'}).`,
    );
  }
  const output = await store.loadOutput(receipt.runId);
  if (output === null || typeof output !== 'object') {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_RECONCILIATION_REQUIRED',
      'Closed completed workflow run is missing its output projection.',
    );
  }
  return output as RunResult;
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
  const routing = input.routing;
  const existingEntry = await routing?.journal.locate(workflowRunId);
  const existingRoute = existingEntry?.receipt ?? (routing ? null : undefined);
  const selectedGo =
    existingRoute?.route.backend === 'go' ||
    (existingRoute === null &&
      routing?.mode === 'explicit' &&
      routing.router?.policy.backend === 'go');
  const correlationId =
    existingRoute?.correlationId ?? input.correlationId ?? safeGeneratedId('correlation');
  const selectedAt = existingRoute?.selectedAt ?? created.toISOString();
  const goAuthority = routing?.authority;
  const goBudgetPolicy = routing?.v2BudgetPolicy;
  const goV2Client = routing?.v2Client;
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
  if (selectedGo) {
    const authority = goAuthority!;
    const budgetPolicy = goBudgetPolicy!;
    const v2Client = goV2Client!;
    if (routing?.mode === 'explicit') {
      const routeBinding = existingRoute?.route ?? {
        backend: 'go' as const,
        authority: 'workflow-control' as const,
        routingEpoch: routing.router!.policy.routingEpoch,
        authorityBuildHash: routing.router!.policy.authorityBuildHash,
      };
      await preflightGoRouting({
        routing,
        workspaceId: config.workspaceId,
        route: routeBinding,
        fresh: existingRoute === null,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }
    const route = await resolveRunRoute({
      execution: input,
      routing,
      existing: existingRoute,
      workspaceId: config.workspaceId,
      workflowRunId,
      correlationId,
      identity: {
        workflowId: input.manifest.name,
        workflowVersion: input.manifest.version ?? '0.0.0',
        workflowSourceHash: hashWorkflowRunnerV2Source(input.workflowSourceBytes),
        manifestHash: hashWorkflowRunnerV2Manifest(input.manifest),
        inputHash: hashWorkflowRunnerV2Input(args),
      },
      selectedAt,
    });
    if (!route || route.route.backend !== 'go') {
      throw new WorkflowRunnerControlError(
        'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID',
        'A Go-owned run requires its immutable Go route receipt.',
      );
    }
    if (existingEntry?.state === 'closed') {
      return replayClosedProjection({
        workspaceRoot: input.workspaceRoot,
        entry: existingEntry,
        authority,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }
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
      runRevision: 2,
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
    await establishInitialGoAuthority({
      authority,
      route,
      ...(input.signal ? { signal: input.signal } : {}),
    });
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
    const projection = createWorkflowRunProjectionStore(input.workspaceRoot, 'go');
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
      hashWorkflowRunnerV2Result(output) !== terminal.resultHash
    ) {
      throw new WorkflowRunnerControlError(
        'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID',
        'Runner result does not match the Go recovery projection output artifact.',
      );
    }
    await routing?.journal.close(workflowRunId);
    return output as RunResult;
  }
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
  const tsRoute = await resolveRunRoute({
    execution: input,
    routing,
    existing: existingRoute,
    workspaceId: config.workspaceId,
    workflowRunId,
    correlationId,
    identity: {
      workflowId: descriptor.workflowId,
      workflowVersion: descriptor.workflowVersion,
      workflowSourceHash: descriptor.workflowSourceHash,
      manifestHash: descriptor.manifestHash,
      inputHash: descriptor.inputHash,
    },
    selectedAt,
  });
  if (tsRoute?.route.backend === 'go') {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_CONFIG_INVALID',
      'An existing Go route cannot fall back to TypeScript execution.',
    );
  }
  if (existingEntry?.state === 'closed') {
    return replayClosedProjection({ workspaceRoot: input.workspaceRoot, entry: existingEntry });
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
  const runStore = createWorkflowRunProjectionStore(input.workspaceRoot, 'ts-local');
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
  await routing?.journal.close(workflowRunId);
  return output as RunResult;
}
