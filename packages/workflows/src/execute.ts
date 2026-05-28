import type {
  WorkflowMeta,
  WorkflowRuntime,
  RunResult,
  AgentOptions,
  ExecutionMode,
} from './types.js'
import { createRuntime, ExecuteDeniedError } from './runtime.js'
import type { ConfirmCallback } from './runtime.js'
import type { AgentLauncher, AgentCacheStore } from './agent-shim.js'
import type { PipelineCacheStore } from './pipeline-runner.js'

/**
 * Error thrown when a dry-run validation encounters issues.
 */
export class DryRunError extends Error {
  readonly violations: string[]

  constructor(violations: string[]) {
    super(`Dry-run validation failed: ${violations.join('; ')}`)
    this.name = 'DryRunError'
    this.violations = violations
  }
}

/**
 * Result of a dry-run execution.
 */
export interface DryRunResult {
  /** Always true for dry-run results. */
  dryRun: true
  /** The run ID for this dry-run. */
  runId: string
  /** Workflow name. */
  workflowName: string
  /** List of simulated side effects that would have been performed. */
  simulatedEffects: SimulatedEffect[]
  /** The workflow result (if the workflow completed successfully). */
  result?: RunResult
  /** Errors that occurred during dry-run. */
  errors: string[]
}

/**
 * A simulated side effect recorded during dry-run.
 */
export interface SimulatedEffect {
  operation: string
  detail: string
  timestamp: string
}

/**
 * Options for executeDryRun.
 */
export interface DryRunOptions {
  /** Workflow manifest */
  manifest: WorkflowMeta
  /** Workflow arguments */
  args?: Record<string, unknown>
  /** Budget limits */
  budget?: { tokens: number; costUsd: number }
  /** Agent launcher for agent calls */
  agentLauncher?: AgentLauncher
  /** Agent cache store */
  agentCache?: AgentCacheStore
  /** Pipeline cache store */
  pipelineCache?: PipelineCacheStore
}

/**
 * Options for executeRun.
 */
export interface ExecuteRunOptions {
  /** Workflow manifest */
  manifest: WorkflowMeta
  /** Workflow arguments */
  args?: Record<string, unknown>
  /** Budget limits */
  budget?: { tokens: number; costUsd: number }
  /** Agent launcher for agent calls */
  agentLauncher?: AgentLauncher
  /** Agent cache store */
  agentCache?: AgentCacheStore
  /** Pipeline cache store */
  pipelineCache?: PipelineCacheStore
  /**
   * Confirmation callback for execute mode. Required unless allowUnattended is set.
   * Called before each side-effect operation; returning false aborts with ExecuteDeniedError.
   */
  onConfirm?: ConfirmCallback
  /**
   * Allow non-interactive execution without a confirmation callback.
   * This is the programmatic equivalent of --yes. Only use in trusted
   * automation contexts (CI, tests) where human confirmation is not feasible.
   * When set, operations proceed without prompting but are still logged.
   */
  allowUnattended?: boolean
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
    }
  }
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
    meta: WorkflowMeta
    run?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<RunResult>
  },
  options: DryRunOptions,
): Promise<DryRunResult> {
  const {
    manifest,
    args = {},
    budget,
  } = options

  const runId = `dryrun-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const simulatedEffects: SimulatedEffect[] = []
  const errors: string[] = []

  // Track simulated effects by wrapping log
  const originalLog = (message: string) => {}
  const effectTracker = {
    log(message: string) {
      // Detect [DRY-RUN] messages and track them as simulated effects
      if (message.startsWith('[DRY-RUN]')) {
        const match = message.match(/^\[DRY-RUN\]\s+(\S+):\s+(.*)$/)
        if (match) {
          simulatedEffects.push({
            operation: match[1],
            detail: match[2],
            timestamp: new Date().toISOString(),
          })
        }
      }
    },
  }

  const runtime = createRuntime({
    runId,
    mode: 'dry-run' as ExecutionMode,
    manifest,
    budget: budget ?? { tokens: 50000, costUsd: 0 },
    permissions: {
      declared: manifest.permissions ?? {},
      granted: manifest.permissions ?? {},
      trustLevel: 'trusted',
    },
    agentLauncher: options.agentLauncher ?? createDryRunAgentLauncher(),
    agentCache: options.agentCache,
    pipelineCache: options.pipelineCache,
  })

  let result: RunResult | undefined

  if (workflow.run) {
    try {
      result = await workflow.run(runtime, args)
    } catch (err) {
      if (err instanceof ExecuteDeniedError) {
        // Should not happen in dry-run mode, but handle gracefully
        errors.push(`Execute denied: ${err.operation} — ${err.detail}`)
      } else {
        errors.push((err as Error).message)
      }
    }
  } else {
    errors.push('Workflow has no run function')
  }

  return {
    dryRun: true,
    runId,
    workflowName: manifest.name,
    simulatedEffects,
    result,
    errors,
  }
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
    meta: WorkflowMeta
    run?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<RunResult>
  },
  options: ExecuteRunOptions,
): Promise<RunResult> {
  const {
    manifest,
    args = {},
    budget,
  } = options

  // Synthesize auto-approve callback when allowUnattended is set without explicit onConfirm
  const effectiveOnConfirm = options.onConfirm ?? (options.allowUnattended
    ? async () => true
    : undefined)

  // Safety gate: execute mode MUST have either a confirmation callback
  // or an explicit allowUnattended flag to prevent silent side effects.
  if (!effectiveOnConfirm) {
    throw new Error(
      'Execute mode requires a confirmation callback (onConfirm) or explicit --yes flag (allowUnattended). ' +
      'Without human confirmation, workflows with real side effects will not execute.',
    )
  }

  const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const runtime = createRuntime({
    runId,
    mode: 'execute' as ExecutionMode,
    manifest,
    budget: budget ?? { tokens: 100000, costUsd: 1.0 },
    permissions: {
      declared: manifest.permissions ?? {},
      granted: manifest.permissions ?? {},
      trustLevel: manifest.risk === 'low' ? 'trusted' : 'core',
    },
    agentLauncher: options.agentLauncher,
    agentCache: options.agentCache,
    pipelineCache: options.pipelineCache,
    onConfirm: effectiveOnConfirm,
  })

  if (!workflow.run) {
    throw new Error(`Workflow "${manifest.name}" has no run function`)
  }

  return workflow.run(runtime, args)
}

/**
 * Execute a workflow in resume mode using an existing run store.
 *
 * Loads checkpoint state from the run store and re-executes from the
 * next uncompleted phase. The workflow's run function is called with
 * a runtime configured to resume from the checkpoint.
 *
 * SAFETY: Like executeRun, resume mode in execute requires either onConfirm
 * or allowUnattended to prevent unattended side effects.
 */
export async function executeResume(
  workflow: {
    meta: WorkflowMeta
    run?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<RunResult>
  },
  options: {
    runId: string
    manifest: WorkflowMeta
    args?: Record<string, unknown>
    budget?: { tokens: number; costUsd: number }
    agentLauncher?: AgentLauncher
    agentCache?: AgentCacheStore
    pipelineCache?: PipelineCacheStore
    onConfirm?: ConfirmCallback
    /** Allow non-interactive execution without confirmation (CI/test use). */
    allowUnattended?: boolean
  },
): Promise<RunResult> {
  const {
    runId,
    manifest,
    args = {},
    budget,
  } = options

  // Synthesize auto-approve callback when allowUnattended is set without explicit onConfirm
  const effectiveOnConfirm = options.onConfirm ?? (options.allowUnattended
    ? async () => true
    : undefined)

  // Safety gate: same as executeRun
  if (!effectiveOnConfirm) {
    throw new Error(
      'Execute mode requires a confirmation callback (onConfirm) or explicit --yes flag (allowUnattended). ' +
      'Without human confirmation, workflows with real side effects will not execute.',
    )
  }

  const runtime = createRuntime({
    runId,
    mode: 'execute' as ExecutionMode,
    manifest,
    budget: budget ?? { tokens: 100000, costUsd: 1.0 },
    permissions: {
      declared: manifest.permissions ?? {},
      granted: manifest.permissions ?? {},
      trustLevel: manifest.risk === 'low' ? 'trusted' : 'core',
    },
    agentLauncher: options.agentLauncher,
    agentCache: options.agentCache,
    pipelineCache: options.pipelineCache,
    onConfirm: effectiveOnConfirm,
  })

  if (!workflow.run) {
    throw new Error(`Workflow "${manifest.name}" has no run function`)
  }

  return workflow.run(runtime, args)
}
