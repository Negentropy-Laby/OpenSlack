import type {
  BudgetState,
  ExecutionMode,
  WorkflowMeta,
  WorkflowRuntime,
  AgentOptions,
  ParallelOptions,
  PipelineOptions,
  PhaseCheckpoint,
  PrmsDoctorResult,
} from './types.js'
import { resolvePermissions } from './permission-checker.js'
import { executeAgentCall, computeAgentCacheKey, SchemaValidationError } from './agent-shim.js'
import type { AgentCacheStore, AgentLauncher } from './agent-shim.js'
import { runParallel } from './parallel-runner.js'
import { runPipeline } from './pipeline-runner.js'
import type { PipelineCacheStore } from './pipeline-runner.js'

/**
 * Maximum nesting depth for ctx.workflow() calls.
 * A child workflow at depth 1 cannot call ctx.workflow() again.
 */
const MAX_NESTING_DEPTH = 1

/**
 * Minimal log entry structure.
 */
interface LogEntry {
  ts: string
  phase?: string
  message: string
  runId: string
}

/**
 * Confirmation callback for execute mode.
 * Called before performing any real side effect.
 * Return true to proceed, false to abort the operation.
 */
export type ConfirmCallback = (operation: string, detail: string) => Promise<boolean>

/**
 * Options for creating a runtime instance.
 */
export interface RuntimeOptions {
  runId: string
  mode: ExecutionMode
  manifest: WorkflowMeta
  budget?: { tokens: number; costUsd: number }
  permissions?: {
    declared: WorkflowMeta['permissions']
    granted: WorkflowMeta['permissions']
    trustLevel: 'untrusted' | 'trusted' | 'core'
  }
  agentLauncher?: AgentLauncher
  agentCache?: AgentCacheStore
  pipelineCache?: PipelineCacheStore
  nestingDepth?: number
  parentPermissions?: Set<string>
  onWorkflowCall?: (name: string, args?: Record<string, unknown>) => Promise<unknown>
  /** Confirmation gate for execute mode. Required when mode is 'execute'. */
  onConfirm?: ConfirmCallback
}

/**
 * Create a WorkflowRuntime instance with phase tracking, budget enforcement,
 * permission checks, agent shim, and parallel/pipeline runners.
 */
/**
 * Error thrown when an execute-mode operation is denied by the confirmation gate.
 */
export class ExecuteDeniedError extends Error {
  readonly operation: string
  readonly detail: string

  constructor(operation: string, detail: string) {
    super(`Execute denied: ${operation} — ${detail}`)
    this.name = 'ExecuteDeniedError'
    this.operation = operation
    this.detail = detail
  }
}

export function createRuntime(options: RuntimeOptions): WorkflowRuntime {
  const {
    runId,
    mode,
    manifest,
    nestingDepth = 0,
    onWorkflowCall,
    onConfirm,
  } = options

  // --- State ---
  let currentPhase: string | undefined
  let currentPhaseIndex = -1
  const phaseCheckpoints: PhaseCheckpoint[] = []
  const logEntries: LogEntry[] = []
  const phaseStatusMap = new Map<string, 'running' | 'completed' | 'failed'>()

  // --- Budget ---
  const budget: BudgetState = {
    tokensUsed: 0,
    tokensRemaining: options.budget?.tokens ?? null,
    costUsd: options.budget?.costUsd ?? 0,
    agentCalls: 0,
  }

  // --- Permissions ---
  const declaredPerms = options.permissions?.declared ?? {}
  const grantedPerms = options.permissions?.granted ?? {}
  const trustLevel = options.permissions?.trustLevel ?? 'untrusted'
  let effectivePermissions = resolvePermissions(
    declaredPerms ?? {},
    grantedPerms ?? {},
    trustLevel,
  )

  // If this is a child workflow, intersect with parent permissions
  if (options.parentPermissions) {
    const parent = options.parentPermissions
    const child = effectivePermissions
    effectivePermissions = new Set<string>()
    for (const perm of child) {
      if (parent.has(perm)) {
        effectivePermissions.add(perm)
      }
    }
  }

  // --- Default stubs for agent/cache ---
  const agentCache: AgentCacheStore = options.agentCache ?? {
    async load() { return null },
    async save() {},
  }

  const defaultLauncher: AgentLauncher = async () => {
    throw new Error('No agent launcher configured')
  }
  const launcher: AgentLauncher = options.agentLauncher ?? defaultLauncher

  const pipelineCache: PipelineCacheStore = options.pipelineCache ?? {
    async loadItem() { return null },
    async saveItem() {},
  }

  // --- Readonly budget proxy (external consumers see a snapshot) ---
  const readonlyBudget: BudgetState = {
    get tokensUsed() { return budget.tokensUsed },
    get tokensRemaining() { return budget.tokensRemaining },
    get costUsd() { return budget.costUsd },
    get agentCalls() { return budget.agentCalls },
  }

  // --- Runtime interface ---
  const runtime: WorkflowRuntime = {
    get runId() { return runId },
    get mode() { return mode },
    get budget() { return readonlyBudget },
    get args() { return {} },

    phase(name: string): void {
      // 1. Validate name exists in manifest.phases
      const phaseDef = manifest.phases.find(p => p.title === name)
      if (!phaseDef) {
        throw new Error(`Unknown phase: "${name}"`)
      }

      // 2. Check sequential ordering
      const phaseIndex = manifest.phases.indexOf(phaseDef)
      if (phaseIndex < currentPhaseIndex) {
        throw new Error(`Phase "${name}" already completed (current: ${currentPhase})`)
      }

      // 3. Check if a previous phase was skipped (gap)
      if (phaseIndex > currentPhaseIndex + 1) {
        throw new Error(
          `Cannot jump to phase "${name}" (index ${phaseIndex}) from current index ${currentPhaseIndex}. ` +
          'Phases must execute in declared order.',
        )
      }

      // 4. Update state
      currentPhase = name
      currentPhaseIndex = phaseIndex

      // 5. Record checkpoint
      const checkpoint: PhaseCheckpoint = {
        phase: name,
        timestamp: new Date().toISOString(),
        status: 'completed',
      }
      phaseCheckpoints.push(checkpoint)
      phaseStatusMap.set(name, 'completed')
    },

    log(message: string): void {
      const entry: LogEntry = {
        ts: new Date().toISOString(),
        phase: currentPhase,
        message,
        runId,
      }
      logEntries.push(entry)
    },

    async agent<T>(prompt: string, agentOptions: AgentOptions): Promise<T> {
      const cacheKey = computeAgentCacheKey(
        manifest.name,
        agentOptions.phase,
        agentOptions.label,
        prompt,
      )

      return executeAgentCall<T>(prompt, agentOptions, {
        runId,
        mode,
        budget,
        permissions: effectivePermissions,
        cache: agentCache,
        launcher: launcher as AgentLauncher<T>,
        log: runtime.log.bind(runtime),
        cacheKey,
      })
    },

    async parallel<T>(
      tasks: Array<() => Promise<T>>,
      parallelOptions?: ParallelOptions,
    ): Promise<T[]> {
      if (mode === 'validate') {
        throw new Error('Parallel execution not allowed in validate mode')
      }
      return runParallel(tasks, parallelOptions, budget)
    },

    async pipeline<T, R>(
      items: T[],
      fn: (item: T, index: number) => Promise<R>,
      pipelineOptions?: PipelineOptions,
    ): Promise<R[]> {
      if (mode === 'validate') {
        throw new Error('Pipeline execution not allowed in validate mode')
      }
      return runPipeline(
        runId,
        currentPhase ?? 'unknown',
        items,
        fn,
        pipelineOptions,
        pipelineCache,
        budget,
        runtime.log.bind(runtime),
      ) as Promise<R[]>
    },

    async workflow(
      name: string,
      args?: Record<string, unknown>,
    ): Promise<unknown> {
      // Check nesting depth
      if (nestingDepth >= MAX_NESTING_DEPTH) {
        throw new Error(
          `Workflow nesting depth limit (${MAX_NESTING_DEPTH}) exceeded. ` +
          'Child workflows cannot call ctx.workflow() again.',
        )
      }

      if (mode === 'validate') {
        throw new Error('Nested workflow calls not allowed in validate mode')
      }

      if (onWorkflowCall) {
        return onWorkflowCall(name, args)
      }

      throw new Error(`No workflow loader configured to resolve "${name}"`)
    },

    openslack: {
      task: {
        async createPreview(issueData: unknown) {
          runtime.log('openslack.task.createPreview called')
          return { preview: true, data: issueData }
        },
        async createIssue(issueData: unknown) {
          if (mode === 'preview') {
            throw new Error('openslack.task.createIssue is not allowed in preview mode')
          }
          if (mode === 'dry-run') {
            runtime.log(`[DRY-RUN] openslack.task.createIssue: would create issue`)
            return {
              issueUrl: `https://github.com/example/issue/dry-run`,
              issueNumber: -1,
            }
          }
          // execute mode: confirmation gate
          if (onConfirm) {
            const detail = typeof issueData === 'object' && issueData !== null
              ? JSON.stringify(issueData)
              : String(issueData)
            const approved = await onConfirm('openslack.task.createIssue', detail)
            if (!approved) {
              throw new ExecuteDeniedError('openslack.task.createIssue', 'User denied issue creation')
            }
          }
          runtime.log('openslack.task.createIssue called')
          return {
            issueUrl: `https://github.com/example/issue/1`,
            issueNumber: 1,
          }
        },
        async checkout(issueNumber: number, agentId: string) {
          if (mode === 'preview') {
            throw new Error('openslack.task.checkout is not allowed in preview mode')
          }
          if (mode === 'dry-run') {
            runtime.log(`[DRY-RUN] openslack.task.checkout: would checkout #${issueNumber} for ${agentId}`)
            return {
              worktreePath: `.openslack.local/worktrees/dry-run-${issueNumber}`,
              branchName: `agent/${agentId}/dry-run-${issueNumber}`,
            }
          }
          if (onConfirm) {
            const approved = await onConfirm(
              'openslack.task.checkout',
              `Checkout issue #${issueNumber} for agent ${agentId}`,
            )
            if (!approved) {
              throw new ExecuteDeniedError('openslack.task.checkout', 'User denied checkout')
            }
          }
          runtime.log(`openslack.task.checkout called for #${issueNumber}`)
          return {
            worktreePath: `.openslack.local/worktrees/${issueNumber}`,
            branchName: `agent/${agentId}/${issueNumber}`,
          }
        },
        async sync(issueNumber: number) {
          if (mode === 'preview') {
            throw new Error('openslack.task.sync is not allowed in preview mode')
          }
          if (mode === 'dry-run') {
            runtime.log(`[DRY-RUN] openslack.task.sync: would sync #${issueNumber}`)
            return { pushed: false }
          }
          if (onConfirm) {
            const approved = await onConfirm(
              'openslack.task.sync',
              `Sync issue #${issueNumber}`,
            )
            if (!approved) {
              throw new ExecuteDeniedError('openslack.task.sync', 'User denied sync')
            }
          }
          runtime.log(`openslack.task.sync called for #${issueNumber}`)
          return { pushed: false }
        },
      },
      prms: {
        async classify(paths: string[]) {
          runtime.log(`openslack.prms.classify called with ${paths.length} paths`)
          return { green: paths, yellow: [], red: [] }
        },
        async doctor(prNumber: number): Promise<PrmsDoctorResult> {
          runtime.log(`openslack.prms.doctor called for PR #${prNumber}`)
          return {
            status: 'BLOCKED',
            blockers: [],
            zone: 'yellow',
            why: 'PR not yet checked',
            next: 'Run checks',
            gates: {},
          }
        },
        async queue() {
          runtime.log('openslack.prms.queue called')
          return []
        },
        async requestMerge(prNumber: number) {
          if (mode === 'preview') {
            throw new Error('openslack.prms.requestMerge is not allowed in preview mode')
          }
          if (mode === 'dry-run') {
            runtime.log(`[DRY-RUN] openslack.prms.requestMerge: would request merge for PR #${prNumber}`)
            return { merged: false, prmsStatus: 'dry-run' }
          }
          if (onConfirm) {
            const approved = await onConfirm(
              'openslack.prms.requestMerge',
              `Request merge for PR #${prNumber}`,
            )
            if (!approved) {
              throw new ExecuteDeniedError('openslack.prms.requestMerge', 'User denied merge request')
            }
          }
          runtime.log(`openslack.prms.requestMerge called for PR #${prNumber}`)
          return { merged: false, prmsStatus: 'pending' }
        },
      },
      collaboration: {
        async recordEvent(event: unknown) {
          if (mode === 'preview') {
            throw new Error('openslack.collaboration.recordEvent is not allowed in preview mode')
          }
          if (mode === 'dry-run') {
            runtime.log(`[DRY-RUN] openslack.collaboration.recordEvent: would record event`)
            return
          }
          if (onConfirm) {
            const detail = typeof event === 'object' && event !== null
              ? JSON.stringify(event)
              : String(event)
            const approved = await onConfirm('openslack.collaboration.recordEvent', detail)
            if (!approved) {
              throw new ExecuteDeniedError('openslack.collaboration.recordEvent', 'User denied event recording')
            }
          }
          runtime.log('openslack.collaboration.recordEvent called')
        },
        async createHandoff(details: unknown) {
          if (mode === 'preview') {
            throw new Error('openslack.collaboration.createHandoff is not allowed in preview mode')
          }
          if (mode === 'dry-run') {
            runtime.log(`[DRY-RUN] openslack.collaboration.createHandoff: would create handoff`)
            return details
          }
          if (onConfirm) {
            const detail = typeof details === 'object' && details !== null
              ? JSON.stringify(details)
              : String(details)
            const approved = await onConfirm('openslack.collaboration.createHandoff', detail)
            if (!approved) {
              throw new ExecuteDeniedError('openslack.collaboration.createHandoff', 'User denied handoff creation')
            }
          }
          runtime.log('openslack.collaboration.createHandoff called')
          return details
        },
        async recordDecision(details: unknown) {
          if (mode === 'preview') {
            throw new Error('openslack.collaboration.recordDecision is not allowed in preview mode')
          }
          if (mode === 'dry-run') {
            runtime.log(`[DRY-RUN] openslack.collaboration.recordDecision: would record decision`)
            return details
          }
          if (onConfirm) {
            const detail = typeof details === 'object' && details !== null
              ? JSON.stringify(details)
              : String(details)
            const approved = await onConfirm('openslack.collaboration.recordDecision', detail)
            if (!approved) {
              throw new ExecuteDeniedError('openslack.collaboration.recordDecision', 'User denied decision recording')
            }
          }
          runtime.log('openslack.collaboration.recordDecision called')
          return details
        },
      },
      governance: {
        async audit(action: string, details?: unknown) {
          if (mode === 'preview') {
            throw new Error('openslack.governance.audit is not allowed in preview mode')
          }
          if (mode === 'dry-run') {
            runtime.log(`[DRY-RUN] openslack.governance.audit: ${action}`)
            return
          }
          if (onConfirm) {
            const detail = details !== undefined ? String(details) : action
            const approved = await onConfirm('openslack.governance.audit', detail)
            if (!approved) {
              throw new ExecuteDeniedError('openslack.governance.audit', 'User denied audit')
            }
          }
          runtime.log(`openslack.governance.audit: ${action}`)
        },
      },
    },
  }

  return runtime
}

/**
 * Export internals for testing and advanced use.
 */
export interface RuntimeInternals {
  logEntries: LogEntry[]
  phaseCheckpoints: PhaseCheckpoint[]
  currentPhase: string | undefined
  currentPhaseIndex: number
}
