import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ConfirmationPolicy, RunResult, WorkflowMeta, WorkflowSource } from './types.js';
import { RunStore } from './run-store.js';
import {
  createWorkflowRunnerExecutionDescriptor,
  hashWorkflowRunnerResult,
} from './workflow-runner-descriptor.js';
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
 * Seal and submit one Workflow Runner v1 job. This is the public execution
 * route; direct executeRun/executeResume remain fail-closed without worker
 * authorities.
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
  if (
    terminal.workspaceId !== config.workspaceId ||
    terminal.jobId !== jobId ||
    terminal.workflowRunId !== workflowRunId ||
    terminal.correlationId !== correlationId
  ) {
    throw new WorkflowRunnerControlError(
      'WORKFLOW_RUNNER_CONTROL_RESPONSE_INVALID',
      'Runner terminal view does not bind the submitted job.',
    );
  }
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
