import type {
  WorkflowMeta,
  WorkflowRuntime,
  RunResult,
  AgentOptions,
  ExecutionMode,
  WorkflowFormat,
  ConfirmationPolicy,
} from './types.js';
import {
  createRuntime,
  ExecuteDeniedError,
  WorkflowExecutionCancelledError,
  WorkflowPausedError,
} from './runtime.js';
import type { ConfirmCallback } from './runtime.js';
import { validateEffectAgainstManifest } from './manifest-validator.js';
import type { AgentLauncher, AgentCacheStore, AgentEventEmitter } from './agent-shim.js';
import type { PipelineCacheStore } from './pipeline-runner.js';
import { RunStore, encodeRunMetaArguments } from './run-store.js';
import type { RuntimeWithPersistence } from './runtime.js';
import { WorkflowBudgetPausedError } from './agent-shim.js';
import { join } from 'node:path';
import type { WorkflowEffectBoundary } from './workflow-runner-effect-boundary.js';
import {
  WORKFLOW_ARGUMENTS_SCHEMA,
  decodeValidatedWorkflowArguments,
  encodeWorkflowArguments,
  type EncodedWorkflowArguments,
  type WorkflowArgumentsEnvelope,
} from './internal/workflow-arguments.js';
import { resolveWorkflowIdentityHash } from './internal/workflow-identity.js';
import { isWorkflowResumeStatus } from './internal/workflow-resume-state.js';

/**
 * Error thrown when a dry-run validation encounters issues.
 */
export class DryRunError extends Error {
  readonly violations: string[];

  constructor(violations: string[]) {
    super(`Dry-run validation failed: ${violations.join('; ')}`);
    this.name = 'DryRunError';
    this.violations = violations;
  }
}

export class WorkflowResumeRecoveryRequiredError extends Error {
  readonly code = 'WORKFLOW_RESUME_RECOVERY_REQUIRED' as const;

  constructor(
    readonly runId: string,
    reason: string,
    options?: ErrorOptions,
  ) {
    super(`Workflow run ${runId} requires operator recovery: ${reason}`, options);
    this.name = 'WorkflowResumeRecoveryRequiredError';
  }
}

export class WorkflowRunInputInvalidError extends TypeError {
  readonly code = 'WORKFLOW_RUN_INPUT_INVALID' as const;

  constructor(cause?: unknown) {
    super('Workflow arguments contain unsupported or out-of-bounds data.', { cause });
    this.name = 'WorkflowRunInputInvalidError';
  }
}

/**
 * Result of a dry-run execution.
 */
export interface DryRunResult {
  /** Always true for dry-run results. */
  dryRun: true;
  /** The run ID for this dry-run. */
  runId: string;
  /** Workflow name. */
  workflowName: string;
  /** List of simulated side effects that would have been performed. */
  simulatedEffects: SimulatedEffect[];
  /** The workflow result (if the workflow completed successfully). */
  result?: RunResult;
  /** Errors that occurred during dry-run. */
  errors: string[];
}

/**
 * A simulated side effect recorded during dry-run.
 */
export interface SimulatedEffect {
  operation: string;
  detail: string;
  timestamp: string;
}

/**
 * Options for executeDryRun.
 */
export interface DryRunOptions {
  /** Workflow manifest */
  manifest: WorkflowMeta;
  /** Workflow arguments */
  args?: Record<string, unknown>;
  /** Budget limits */
  budget?: { tokens: number; costUsd: number };
  /** Agent launcher for agent calls */
  agentLauncher?: AgentLauncher;
  /** Agent cache store */
  agentCache?: AgentCacheStore;
  /** Pipeline cache store */
  pipelineCache?: PipelineCacheStore;
}

/**
 * Options for executeRun.
 */
export interface ExecuteRunOptions {
  /** Workflow manifest */
  manifest: WorkflowMeta;
  /** Workflow arguments */
  args?: Record<string, unknown>;
  /** Budget limits */
  budget?: { tokens: number; costUsd: number };
  /** Agent launcher for agent calls */
  agentLauncher?: AgentLauncher;
  /** Agent cache store */
  agentCache?: AgentCacheStore;
  /** Pipeline cache store */
  pipelineCache?: PipelineCacheStore;
  /**
   * Confirmation callback for execute mode. Required unless allowUnattended is set.
   * Called before each side-effect operation; returning false aborts with ExecuteDeniedError.
   */
  onConfirm?: ConfirmCallback;
  /**
   * Allow non-interactive execution without a confirmation callback.
   * This is the programmatic equivalent of --yes. Only use in trusted
   * automation contexts (CI, tests) where human confirmation is not feasible.
   * When set, operations proceed without prompting but are still logged.
   */
  allowUnattended?: boolean;
  /**
   * Manifest-based confirmation policy. Preferred over legacy onConfirm/allowUnattended.
   * When provided, the runtime validates each side effect against the approved manifest
   * and either auto-confirms known effects or pauses on unexpected ones.
   */
  confirmationPolicy?: ConfirmationPolicy;
  /**
   * Optional event emitter for agent conversation lifecycle events.
   * When provided, the runtime emits started/completed/failed events during
   * agent calls in execute mode. The collaboration bridge emitter converts
   * these into CollaborationEvent records via recordEvent().
   */
  agentEventEmitter?: AgentEventEmitter;
  /**
   * Root directory for resolving agent types and collaboration paths.
   * Defaults to process.cwd().
   */
  rootDir?: string;
  /** Exact host-selected run identity. Must match confirmationPolicy.runId when both are present. */
  runId?: string;
  /** Cooperative cancellation for the default-off GS8-B worker path. */
  signal?: AbortSignal;
  /** Durable runner intent/outcome observation; never an approval or execution authority. */
  effectBoundary?: WorkflowEffectBoundary;
}

function throwIfExecutionAborted(
  signal: AbortSignal | undefined,
  runId: string,
  boundary: 'pre_javascript' | 'terminal_commit' = 'pre_javascript',
): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  throw new WorkflowExecutionCancelledError(
    runId,
    reason instanceof Error ? reason.message : String(reason ?? 'workflow control cancelled'),
    boundary,
  );
}

function workflowRunStore(rootDir: string): RunStore {
  return new RunStore({ baseDir: join(rootDir, '.openslack.local', 'workflows') });
}

function canonicalArguments(value: Record<string, unknown>): EncodedWorkflowArguments {
  try {
    return encodeWorkflowArguments(value);
  } catch (error) {
    throw new WorkflowRunInputInvalidError(error);
  }
}

function createRunStoreAgentCache(store: RunStore, delegate?: AgentCacheStore): AgentCacheStore {
  return {
    async load(runId: string, cacheKey: string) {
      const stored = await store.loadAgentResult(runId, cacheKey);
      if (stored !== null) return stored as Awaited<ReturnType<AgentCacheStore['load']>>;
      return delegate ? delegate.load(runId, cacheKey) : null;
    },
    async save(runId: string, cacheKey: string, result) {
      if (delegate) await delegate.save(runId, cacheKey, result);
      await store.saveAgentResult(runId, cacheKey, result);
    },
  };
}

function createRunStorePipelineCache(
  store: RunStore,
  delegate?: PipelineCacheStore,
): PipelineCacheStore {
  return {
    async loadItem(runId: string, phase: string, index: number) {
      const stored = await store.loadPipelineItem(runId, phase, index);
      if (stored !== null) return stored;
      return delegate ? delegate.loadItem(runId, phase, index) : null;
    },
    async saveItem(runId: string, phase: string, index: number, result: unknown) {
      if (delegate) await delegate.saveItem(runId, phase, index, result);
      await store.savePipelineItem(runId, phase, index, result);
    },
  };
}

async function safeTransition(
  store: RunStore,
  runId: string,
  status: import('./types.js').RunStatus['status'],
): Promise<void> {
  try {
    const current = await store.loadStatus(runId);
    if (!current || current.status === status) return;
    await store.transitionStatus(runId, status);
  } catch {
    // Failure handling must not mask the workflow error/result.
  }
}

async function initializeRun(options: {
  store: RunStore;
  runId: string;
  manifest: WorkflowMeta;
  mode: ExecutionMode;
  args: WorkflowArgumentsEnvelope;
  startedAt?: string;
  manifestHash: string;
  budget?: { tokens: number; costUsd: number };
}): Promise<void> {
  if (await options.store.runExists(options.runId)) {
    throw new Error(`Workflow run ${options.runId} already exists; use the strict resume path.`);
  }
  const startedAt = options.startedAt ?? new Date().toISOString();
  await options.store.initRun(options.runId, {
    runId: options.runId,
    workflowName: options.manifest.name,
    mode: options.mode,
    manifestHash: options.manifestHash,
    argsEncoding: WORKFLOW_ARGUMENTS_SCHEMA,
    args: options.args,
    startedAt,
    budget: options.budget,
    budgetPolicy: options.manifest.budgetPolicy,
  });
}

async function flushRuntime(runtime: WorkflowRuntime): Promise<void> {
  const flush = (runtime as Partial<RuntimeWithPersistence>).flushPersistence;
  if (flush) await flush();
}

async function pauseForUnexpectedEffect(
  store: RunStore,
  runId: string,
  error: WorkflowPausedError,
): Promise<void> {
  await store.savePendingApproval(runId, {
    operation: error.operation,
    detail: error.detail,
    timestamp: new Date().toISOString(),
  });
  await safeTransition(store, runId, 'paused_waiting_approval');
}

/**
 * A dry-run agent launcher that simulates agent calls without executing them.
 * Returns placeholder data and records zero token usage.
 */
function createDryRunAgentLauncher(): AgentLauncher {
  return async <T>(prompt: string, options: AgentOptions) => {
    return {
      data: {
        _dryRun: true,
        label: options.label,
        phase: options.phase,
        promptLength: prompt.length,
        message: 'Dry-run mode: agent call simulated',
      } as T,
      tokenUsage: 0,
    };
  };
}

/**
 * Execute a workflow in dry-run mode.
 *
 * Dry-run simulates all side effects: openslack APIs return simulated data,
 * agent calls return placeholder results, and all write operations are logged
 * but not performed. This allows operators to preview what a workflow would do
 * without any real side effects.
 *
 * The runtime tracks all simulated effects in the result for review.
 */
export async function executeDryRun(
  workflow: {
    meta: WorkflowMeta;
    hash?: string;
    run?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<RunResult>;
    format?: WorkflowFormat;
    sourceBody?: string;
  },
  options: DryRunOptions,
): Promise<DryRunResult> {
  const { manifest, budget } = options;
  const encodedArgs = canonicalArguments(options.args ?? {});
  const runtimeArgs = decodeValidatedWorkflowArguments(encodedArgs.envelope);
  const positionalArgs = decodeValidatedWorkflowArguments(encodedArgs.envelope);

  const runId = `dryrun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const simulatedEffects: SimulatedEffect[] = [];
  const errors: string[] = [];

  // Track simulated effects by wrapping log
  const originalLog = (message: string) => {};
  const effectTracker = {
    log(message: string) {
      // Detect [DRY-RUN] messages and track them as simulated effects
      if (message.startsWith('[DRY-RUN]')) {
        const match = message.match(/^\[DRY-RUN\]\s+(\S+):\s+(.*)$/);
        if (match) {
          simulatedEffects.push({
            operation: match[1],
            detail: match[2],
            timestamp: new Date().toISOString(),
          });
        }
      }
    },
  };

  const runtime = createRuntime({
    runId,
    mode: 'dry-run' as ExecutionMode,
    manifest,
    args: runtimeArgs,
    budget: budget ?? { tokens: 50000, costUsd: 0 },
    permissions: {
      declared: manifest.permissions ?? {},
      granted: manifest.permissions ?? {},
      trustLevel: 'trusted',
    },
    agentLauncher: options.agentLauncher ?? createDryRunAgentLauncher(),
    agentCache: options.agentCache,
    pipelineCache: options.pipelineCache,
  });

  let result: RunResult | undefined;

  // Handle claude-ambient workflows
  if (workflow.format === 'claude-ambient' && workflow.sourceBody) {
    try {
      const { executeAmbientWorkflow } = await import('./ambient-runner.js');
      const ambientResult = await executeAmbientWorkflow(
        workflow.sourceBody,
        runtime,
        positionalArgs,
      );
      result = {
        status: 'completed',
        ...(typeof ambientResult === 'object' && ambientResult !== null
          ? (ambientResult as Record<string, unknown>)
          : { result: ambientResult }),
      } as RunResult;
    } catch (err) {
      if (err instanceof ExecuteDeniedError) {
        errors.push(`Execute denied: ${err.operation} — ${err.detail}`);
      } else {
        errors.push((err as Error).message);
      }
    }
  } else if (workflow.run) {
    try {
      result = await workflow.run(runtime, positionalArgs);
    } catch (err) {
      if (err instanceof ExecuteDeniedError) {
        // Should not happen in dry-run mode, but handle gracefully
        errors.push(`Execute denied: ${err.operation} — ${err.detail}`);
      } else {
        errors.push((err as Error).message);
      }
    }
  } else {
    errors.push('Workflow has no run function');
  }

  return {
    dryRun: true,
    runId,
    workflowName: manifest.name,
    simulatedEffects,
    result,
    errors,
  };
}

/**
 * Create a confirmation callback from a confirmation policy.
 *
 * Auto-confirms effects that are in the approved manifest.
 * Throws WorkflowPausedError when an unexpected effect is encountered
 * and onUnexpectedEffect is set to 'pause'.
 * Returns false (deny) for always-forbidden effects.
 */
export function createOnConfirmFromPolicy(policy: ConfirmationPolicy): ConfirmCallback {
  return async (operation: string, detail: string): Promise<boolean> => {
    const validation = validateEffectAgainstManifest(operation, detail, policy);

    if (validation.allowed) {
      return true;
    }

    if (policy.onUnexpectedEffect === 'pause') {
      throw new WorkflowPausedError(operation, detail, policy.runId);
    }

    return false;
  };
}

/**
 * Execute a workflow in execute mode with real side effects.
 *
 * SAFETY: Execute mode requires either a confirmation callback (onConfirm)
 * or an explicit allowUnattended flag. Without either, the function throws
 * immediately to prevent unattended execution with real side effects.
 *
 * When a callback is provided, it is called before each side-effect operation;
 * returning false aborts the operation with ExecuteDeniedError. When
 * allowUnattended is set, operations proceed without prompting (for CI/test use).
 */
export async function executeRun(
  workflow: {
    meta: WorkflowMeta;
    hash?: string;
    run?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<RunResult>;
    format?: WorkflowFormat;
    sourceBody?: string;
  },
  options: ExecuteRunOptions,
): Promise<RunResult> {
  return executeRunWithStore(workflow, options);
}

/** @internal Worker authority path; not exported from the package root. */
export async function executeRunWithStore(
  workflow: Parameters<typeof executeRun>[0],
  options: ExecuteRunOptions,
  storeOverride?: RunStore,
): Promise<RunResult> {
  const { manifest, budget } = options;
  const encodedArgs = canonicalArguments(options.args ?? {});
  const runtimeArgs = decodeValidatedWorkflowArguments(encodedArgs.envelope);
  const positionalArgs = decodeValidatedWorkflowArguments(encodedArgs.envelope);

  if (
    options.runId !== undefined &&
    options.confirmationPolicy !== undefined &&
    options.runId !== options.confirmationPolicy.runId
  ) {
    throw new Error('Execute runId must match confirmationPolicy.runId.');
  }
  const runId =
    options.runId ??
    options.confirmationPolicy?.runId ??
    `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const rootDir = options.rootDir ?? process.cwd();
  const store = storeOverride ?? workflowRunStore(rootDir);
  const effectiveBudget = budget ?? { tokens: 100000, costUsd: 1.0 };
  throwIfExecutionAborted(options.signal, runId);

  await initializeRun({
    store,
    runId,
    manifest,
    mode: 'execute',
    args: encodedArgs.envelope,
    manifestHash: resolveWorkflowIdentityHash(workflow, manifest),
    budget: effectiveBudget,
  });

  // Resolve confirmation callback: confirmationPolicy takes precedence over legacy options
  let effectiveOnConfirm: ConfirmCallback | undefined;
  if (options.confirmationPolicy) {
    effectiveOnConfirm = createOnConfirmFromPolicy(options.confirmationPolicy);
  } else {
    effectiveOnConfirm =
      options.onConfirm ?? (options.allowUnattended ? async () => true : undefined);
  }

  // Safety gate: execute mode MUST have either a confirmation callback
  // or an explicit allowUnattended flag to prevent silent side effects.
  if (!effectiveOnConfirm) {
    throw new Error(
      'Execute mode requires a confirmation callback (onConfirm) or explicit --yes flag (allowUnattended). ' +
        'Without human confirmation, workflows with real side effects will not execute.',
    );
  }

  const runtime = createRuntime({
    runId,
    mode: 'execute' as ExecutionMode,
    manifest,
    args: runtimeArgs,
    budget: effectiveBudget,
    permissions: {
      declared: manifest.permissions ?? {},
      granted: manifest.permissions ?? {},
      trustLevel: manifest.risk === 'low' ? 'trusted' : 'core',
    },
    agentLauncher: options.agentLauncher,
    agentCache: createRunStoreAgentCache(store, options.agentCache),
    pipelineCache: createRunStorePipelineCache(store, options.pipelineCache),
    onConfirm: effectiveOnConfirm,
    agentEventEmitter: options.agentEventEmitter,
    rootDir,
    runStore: store,
    signal: options.signal,
    effectBoundary: options.effectBoundary,
    onBudgetChange: async (state) => {
      await store.persistBudgetState(runId, state);
    },
  });

  try {
    throwIfExecutionAborted(options.signal, runId);
    // Handle claude-ambient workflows
    if (workflow.format === 'claude-ambient' && workflow.sourceBody) {
      const { executeAmbientWorkflow } = await import('./ambient-runner.js');
      const ambientResult = await executeAmbientWorkflow(
        workflow.sourceBody,
        runtime,
        positionalArgs,
      );
      const result = {
        status: 'completed',
        ...(typeof ambientResult === 'object' && ambientResult !== null
          ? (ambientResult as Record<string, unknown>)
          : { result: ambientResult }),
      } as RunResult;
      const output = { ...result, runId };
      throwIfExecutionAborted(options.signal, runId, 'terminal_commit');
      await flushRuntime(runtime);
      throwIfExecutionAborted(options.signal, runId, 'terminal_commit');
      await store.saveOutput(runId, output);
      await safeTransition(store, runId, 'completed');
      return output;
    }

    if (!workflow.run) {
      throw new Error(`Workflow "${manifest.name}" has no run function`);
    }

    const result = await workflow.run(runtime, positionalArgs);
    const output = { ...result, runId };
    throwIfExecutionAborted(options.signal, runId, 'terminal_commit');
    await flushRuntime(runtime);
    throwIfExecutionAborted(options.signal, runId, 'terminal_commit');
    await store.saveOutput(runId, output);
    await safeTransition(store, runId, 'completed');
    return output;
  } catch (err) {
    await flushRuntime(runtime);
    if (err instanceof WorkflowPausedError) {
      await pauseForUnexpectedEffect(store, runId, err);
      throw err;
    }
    if (err instanceof WorkflowBudgetPausedError) {
      await safeTransition(store, runId, 'paused_waiting_approval');
      throw err;
    }
    if (err instanceof WorkflowExecutionCancelledError || options.signal?.aborted) {
      await safeTransition(store, runId, 'cancelled');
      throw err instanceof WorkflowExecutionCancelledError
        ? err
        : new WorkflowExecutionCancelledError(runId, 'workflow control cancelled');
    }
    await safeTransition(store, runId, 'failed');
    throw err;
  }
}

/**
 * Execute a workflow in resume mode using an existing run store.
 *
 * Re-enters the workflow from its function boundary with the original args,
 * immutable workflow identity, cumulative budget, and persisted caches. A
 * workflow must place replay-safe cached work before any approval pause; this
 * function does not claim arbitrary JavaScript can resume mid-function.
 *
 * SAFETY: Like executeRun, resume mode in execute requires either onConfirm
 * or allowUnattended to prevent unattended side effects.
 */
export async function executeResume(
  workflow: {
    meta: WorkflowMeta;
    run?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<RunResult>;
    format?: WorkflowFormat;
    sourceBody?: string;
  },
  options: {
    runId: string;
    manifest: WorkflowMeta;
    args?: Record<string, unknown>;
    budget?: { tokens: number; costUsd: number };
    agentLauncher?: AgentLauncher;
    agentCache?: AgentCacheStore;
    pipelineCache?: PipelineCacheStore;
    onConfirm?: ConfirmCallback;
    /** Allow non-interactive execution without confirmation (CI/test use). */
    allowUnattended?: boolean;
    confirmationPolicy?: ConfirmationPolicy;
    /** Optional event emitter for agent conversation lifecycle events. */
    agentEventEmitter?: AgentEventEmitter;
    /** Root directory for resolving agent types and collaboration paths. */
    rootDir?: string;
    signal?: AbortSignal;
    effectBoundary?: WorkflowEffectBoundary;
  },
): Promise<RunResult> {
  return executeResumeWithStore(workflow, options);
}

/** @internal Worker authority path; not exported from the package root. */
export async function executeResumeWithStore(
  workflow: Parameters<typeof executeResume>[0],
  options: Parameters<typeof executeResume>[1],
  storeOverride?: RunStore,
): Promise<RunResult> {
  const { runId, manifest } = options;
  const rootDir = options.rootDir ?? process.cwd();
  const store = storeOverride ?? workflowRunStore(rootDir);
  throwIfExecutionAborted(options.signal, runId);

  if (options.confirmationPolicy !== undefined && options.confirmationPolicy.runId !== runId) {
    throw new Error('Resume runId must match confirmationPolicy.runId.');
  }

  if (!(await store.runExists(runId))) {
    throw new WorkflowResumeRecoveryRequiredError(runId, 'durable run state is missing');
  }
  let meta: Awaited<ReturnType<RunStore['loadMeta']>>;
  let status: Awaited<ReturnType<RunStore['loadStatus']>>;
  let snapshot: Awaited<ReturnType<RunStore['loadBudgetSnapshot']>>;
  try {
    [meta, status, snapshot] = await Promise.all([
      store.loadMeta(runId),
      store.loadStatus(runId),
      store.loadBudgetSnapshot(runId),
    ]);
  } catch (error) {
    throw new WorkflowResumeRecoveryRequiredError(runId, 'durable resume state is invalid', {
      cause: error,
    });
  }
  if (meta === null || status === null || snapshot === null) {
    throw new WorkflowResumeRecoveryRequiredError(runId, 'durable resume state is incomplete');
  }
  if (!isWorkflowResumeStatus(status.status)) {
    throw new WorkflowResumeRecoveryRequiredError(
      runId,
      `status "${status.status}" cannot be replayed automatically`,
    );
  }
  let currentWorkflowHash: string;
  try {
    currentWorkflowHash = resolveWorkflowIdentityHash(workflow, manifest);
  } catch (error) {
    throw new WorkflowResumeRecoveryRequiredError(
      runId,
      'strong workflow identity is unavailable',
      {
        cause: error,
      },
    );
  }
  if (
    meta.runId !== runId ||
    meta.workflowName !== manifest.name ||
    meta.mode !== 'execute' ||
    meta.manifestHash !== currentWorkflowHash
  ) {
    throw new WorkflowResumeRecoveryRequiredError(runId, 'identity or workflow hash has drifted');
  }
  let persistedEncodedArgs: EncodedWorkflowArguments;
  let persistedArgsCanonical: string;
  try {
    persistedEncodedArgs = encodeRunMetaArguments(meta);
    persistedArgsCanonical = persistedEncodedArgs.canonical;
  } catch (error) {
    throw new WorkflowResumeRecoveryRequiredError(runId, 'durable workflow arguments are invalid', {
      cause: error,
    });
  }
  if (
    options.args !== undefined &&
    canonicalArguments(options.args).canonical !== persistedArgsCanonical
  ) {
    throw new Error(`Workflow run ${runId} resume arguments do not match the original run.`);
  }
  if (meta.budget === undefined) {
    const cause = new Error(`Workflow run ${runId} original budget is missing.`);
    throw new WorkflowResumeRecoveryRequiredError(runId, 'durable budget metadata is missing', {
      cause,
    });
  }
  const effectiveBudget = {
    tokens: meta.budget.tokens,
    costUsd: meta.budget.costUsd ?? 0,
  };
  if (
    options.budget !== undefined &&
    (options.budget.tokens !== effectiveBudget.tokens ||
      options.budget.costUsd !== effectiveBudget.costUsd)
  ) {
    throw new Error(`Workflow run ${runId} resume budget does not match the original run.`);
  }
  if (
    snapshot.budget.tokens !== effectiveBudget.tokens ||
    snapshot.budget.costUsd !== effectiveBudget.costUsd
  ) {
    const cause = new Error(`Workflow run ${runId} budget snapshot has drifted from metadata.`);
    throw new WorkflowResumeRecoveryRequiredError(
      runId,
      'durable budget snapshot has drifted from metadata',
      { cause },
    );
  }
  const runtimeArgs = decodeValidatedWorkflowArguments(persistedEncodedArgs.envelope);
  const positionalArgs = decodeValidatedWorkflowArguments(persistedEncodedArgs.envelope);

  // Resolve confirmation callback: confirmationPolicy takes precedence over legacy options
  let effectiveOnConfirm: ConfirmCallback | undefined;
  if (options.confirmationPolicy) {
    effectiveOnConfirm = createOnConfirmFromPolicy(options.confirmationPolicy);
  } else {
    effectiveOnConfirm =
      options.onConfirm ?? (options.allowUnattended ? async () => true : undefined);
  }

  // Safety gate: same as executeRun
  if (!effectiveOnConfirm) {
    throw new Error(
      'Execute mode requires a confirmation callback (onConfirm) or explicit --yes flag (allowUnattended). ' +
        'Without human confirmation, workflows with real side effects will not execute.',
    );
  }

  const runtime = createRuntime({
    runId,
    mode: 'execute' as ExecutionMode,
    manifest,
    args: runtimeArgs,
    budget: effectiveBudget,
    initialBudgetState: snapshot.usage,
    permissions: {
      declared: manifest.permissions ?? {},
      granted: manifest.permissions ?? {},
      trustLevel: manifest.risk === 'low' ? 'trusted' : 'core',
    },
    agentLauncher: options.agentLauncher,
    agentCache: createRunStoreAgentCache(store, options.agentCache),
    pipelineCache: createRunStorePipelineCache(store, options.pipelineCache),
    onConfirm: effectiveOnConfirm,
    agentEventEmitter: options.agentEventEmitter,
    rootDir,
    runStore: store,
    signal: options.signal,
    effectBoundary: options.effectBoundary,
    onBudgetChange: async (state) => {
      await store.persistBudgetState(runId, state);
    },
  });

  try {
    if (status.status === 'paused_waiting_approval') {
      await store.transitionStatus(runId, 'resuming');
      await store.transitionStatus(runId, 'running');
    } else {
      await store.transitionStatus(runId, 'running');
    }
    throwIfExecutionAborted(options.signal, runId);
    // Handle claude-ambient workflows
    if (workflow.format === 'claude-ambient' && workflow.sourceBody) {
      const { executeAmbientWorkflow } = await import('./ambient-runner.js');
      const ambientResult = await executeAmbientWorkflow(
        workflow.sourceBody,
        runtime,
        positionalArgs,
      );
      const result = {
        status: 'completed',
        ...(typeof ambientResult === 'object' && ambientResult !== null
          ? (ambientResult as Record<string, unknown>)
          : { result: ambientResult }),
      } as RunResult;
      const output = { ...result, runId };
      throwIfExecutionAborted(options.signal, runId, 'terminal_commit');
      await flushRuntime(runtime);
      throwIfExecutionAborted(options.signal, runId, 'terminal_commit');
      await store.saveOutput(runId, output);
      await safeTransition(store, runId, 'completed');
      return output;
    }

    if (!workflow.run) {
      throw new Error(`Workflow "${manifest.name}" has no run function`);
    }

    const result = await workflow.run(runtime, positionalArgs);
    const output = { ...result, runId };
    throwIfExecutionAborted(options.signal, runId, 'terminal_commit');
    await flushRuntime(runtime);
    throwIfExecutionAborted(options.signal, runId, 'terminal_commit');
    await store.saveOutput(runId, output);
    await safeTransition(store, runId, 'completed');
    return output;
  } catch (err) {
    await flushRuntime(runtime);
    if (err instanceof WorkflowPausedError) {
      await pauseForUnexpectedEffect(store, runId, err);
      throw err;
    }
    if (err instanceof WorkflowBudgetPausedError) {
      await safeTransition(store, runId, 'paused_waiting_approval');
      throw err;
    }
    if (err instanceof WorkflowExecutionCancelledError || options.signal?.aborted) {
      await safeTransition(store, runId, 'cancelled');
      throw err instanceof WorkflowExecutionCancelledError
        ? err
        : new WorkflowExecutionCancelledError(runId, 'workflow control cancelled');
    }
    await safeTransition(store, runId, 'failed');
    throw err;
  }
}
