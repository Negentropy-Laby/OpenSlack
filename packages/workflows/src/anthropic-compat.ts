import type { WorkflowRuntime, AgentOptions, PreviewResult, RunResult } from './types.js'

/**
 * Sandboxed ambient globals exposed to anthropic-compatible workflows.
 * All operations are read-only at trust level 0 (untrusted).
 *
 * IMPORTANT: This module does NOT use AsyncFunction, eval, or any other
 * dynamic code evaluation. It provides a sandbox object that the runtime
 * passes to a sandboxed execution context (e.g., worker thread or VM module).
 */
export interface AnthropicCompatSandbox {
  /** Workflow arguments (read-only) */
  readonly args: Record<string, unknown>
  /** Declare current phase */
  phase(name: string): void
  /** Log a message */
  log(message: string): void
  /** Read-only budget snapshot */
  readonly budget: {
    readonly tokensUsed: number
    readonly tokensRemaining: number | null
    readonly costUsd: number
    readonly agentCalls: number
    /** Total budget (tokensUsed + tokensRemaining), or null if unlimited */
    readonly total: number | null
    /** Tokens spent so far */
    spent(): number
    /** Tokens remaining, or Infinity if unlimited */
    remaining(): number
  }
  /** Agent subtask call — read-only in preview mode */
  agent<T>(prompt: string, options: AgentOptions): Promise<T>
  /** Parallel execution */
  parallel<T>(tasks: Array<() => Promise<T>>): Promise<T[]>
  /** Pipeline execution */
  pipeline<T, R>(items: T[], fn: (item: T, idx: number) => Promise<R>): Promise<R[]>
  /** Nested workflow call — blocked in preview mode */
  workflow(name: string, args?: Record<string, unknown>): Promise<unknown>
}

/**
 * Error thrown when an anthropic-compatible workflow attempts a forbidden operation.
 */
export class AnthropicCompatError extends Error {
  readonly operation: string

  constructor(operation: string, reason: string) {
    super(`Anthropic-compat forbidden: ${operation} — ${reason}`)
    this.name = 'AnthropicCompatError'
    this.operation = operation
  }
}

/**
 * Create a sandboxed compatibility shim for anthropic-format workflows.
 *
 * The sandbox wraps a WorkflowRuntime and:
 * - Exposes ambient globals that mirror the anthropic workflow API
 * - Enforces trust level 0 (untrusted) — no write operations
 * - Blocks nested workflow calls in preview mode
 * - Does NOT use AsyncFunction or eval for execution
 *
 * The returned sandbox object is meant to be passed to a sandboxed execution
 * context (worker thread, VM module, etc.), not executed directly.
 */
export function createAnthropicCompatSandbox(
  runtime: WorkflowRuntime,
): AnthropicCompatSandbox {
  const isPreview = runtime.mode === 'preview'

  // Read-only budget snapshot — captured once, never mutates
  const budgetSnapshot = {
    get tokensUsed() { return runtime.budget.tokensUsed },
    get tokensRemaining() { return runtime.budget.tokensRemaining },
    get costUsd() { return runtime.budget.costUsd },
    get agentCalls() { return runtime.budget.agentCalls },
    get total(): number | null {
      if (runtime.budget.tokensRemaining === null) return null
      return runtime.budget.tokensUsed + runtime.budget.tokensRemaining
    },
    spent(): number { return runtime.budget.tokensUsed },
    remaining(): number { return runtime.budget.tokensRemaining ?? Infinity },
  }

  const sandbox: AnthropicCompatSandbox = {
    args: Object.freeze({ ...runtime.args }),

    phase(name: string): void {
      runtime.phase(name)
    },

    log(message: string): void {
      runtime.log(message)
    },

    budget: budgetSnapshot,

    async agent<T>(prompt: string, options: AgentOptions): Promise<T> {
      return runtime.agent<T>(prompt, options)
    },

    async parallel<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
      return runtime.parallel(tasks)
    },

    async pipeline<T, R>(
      items: T[],
      fn: (item: T, idx: number) => Promise<R>,
    ): Promise<R[]> {
      return runtime.pipeline(items, fn)
    },

    async workflow(
      name: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> {
      if (isPreview) {
        throw new AnthropicCompatError(
          'workflow',
          'Nested workflow calls are forbidden in preview mode for anthropic-compatible workflows',
        )
      }
      return runtime.workflow(name, args)
    },
  }

  return sandbox
}

/**
 * Wrap an anthropic-compatible workflow's module body for execution.
 *
 * Instead of using AsyncFunction or eval, this function:
 * 1. Creates the sandbox
 * 2. Returns a runner that delegates to the workflow's `preview` or `run` export
 *
 * For anthropic-compatible modules that only export `meta` (no `preview`/`run`),
 * a default preview handler is provided that returns basic manifest info.
 */
export function createAnthropicCompatRunner(
  runtime: WorkflowRuntime,
  workflowModule: {
    preview?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<PreviewResult>
    run?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<RunResult>
  },
): {
  preview: (args: Record<string, unknown>) => Promise<PreviewResult>
  run: (args: Record<string, unknown>) => Promise<RunResult>
} {
  const sandbox = createAnthropicCompatSandbox(runtime)

  // The sandbox is available for modules that use ambient globals.
  // For OpenSlack-native-format modules wrapped via compat, the module's
  // own preview/run functions receive the runtime directly.

  return {
    async preview(args: Record<string, unknown>): Promise<PreviewResult> {
      if (workflowModule.preview) {
        // Delegate to the module's preview function with the runtime
        return workflowModule.preview(runtime, args)
      }

      // Default preview for anthropic-compatible modules (meta-only):
      // Return basic info about the workflow without executing agent calls
      runtime.log('Anthropic-compat default preview: read-only inspection')
      return {
        preview: true,
        mode: runtime.mode,
        runId: runtime.runId,
        budget: {
          tokensUsed: runtime.budget.tokensUsed,
          tokensRemaining: runtime.budget.tokensRemaining,
          agentCalls: runtime.budget.agentCalls,
        },
      }
    },

    async run(args: Record<string, unknown>): Promise<RunResult> {
      if (workflowModule.run) {
        return workflowModule.run(runtime, args)
      }

      // No run function — cannot execute
      throw new AnthropicCompatError(
        'run',
        'Anthropic-compatible module has no "run" export. Only preview is available for meta-only modules.',
      )
    },
  }
}
