// ── JSON Schema type (lightweight inline to avoid external dep) ────────────────

/**
 * Minimal JSON Schema definition used by AgentOptions.schema.
 * Matches the JSONSchema7 subset needed for agent result validation.
 */
export interface JSONSchemaDefinition {
  type?: string | string[]
  properties?: Record<string, JSONSchemaDefinition>
  items?: JSONSchemaDefinition | JSONSchemaDefinition[]
  required?: string[]
  enum?: unknown[]
  description?: string
  [key: string]: unknown
}

// ── Manifest ──────────────────────────────────────────────────────────────────

export interface WorkflowPhase {
  title: string
  detail: string
}

export interface WorkflowInput {
  type: 'string' | 'number' | 'boolean'
  default?: unknown
  description: string
}

export interface WorkflowPermissions {
  github?: string[]
  git?: string[]
  filesystem?: string[]
  openslack?: string[]
}

export interface WorkflowMeta {
  name: string
  version?: string
  description: string
  whenToUse?: string
  phases: WorkflowPhase[]
  inputs?: Record<string, WorkflowInput>
  permissions?: WorkflowPermissions
  sideEffects?: string[]
  forbidden?: string[]
  risk?: 'low' | 'medium' | 'high'
}

// ── Runtime ───────────────────────────────────────────────────────────────────

export interface BudgetState {
  tokensUsed: number
  tokensRemaining: number | null   // null = unlimited
  costUsd: number
  agentCalls: number
}

export interface AgentOptions {
  label: string
  phase: string
  schema?: JSONSchemaDefinition
  isolation?: 'none' | 'worktree'
  budget?: { tokens: number }
}

export interface ParallelOptions {
  concurrency?: number
}

export interface PhaseCheckpoint {
  phase: string
  timestamp: string
  status: 'completed' | 'failed' | 'skipped'
  result?: unknown
  cacheKey?: string
}

export interface RunStatus {
  runId: string
  workflowName: string
  mode: ExecutionMode
  status: 'running' | 'paused' | 'completed' | 'failed'
  startedAt: string
  updatedAt: string
  currentPhase?: string
  phases: PhaseCheckpoint[]
  args: Record<string, unknown>
}

/**
 * Execution mode for a workflow run.
 *
 * - 'validate': Schema and manifest validation only. No side effects.
 * - 'preview': Read-only exploration. No side effects.
 * - 'dry-run': Simulated side effects. Nothing is written externally.
 * - 'execute': Real side effects. REQUIRES human confirmation via onConfirm
 *   callback or explicit allowUnattended flag. Never proceeds without one.
 *
 * @see docs/product/approval-vocabulary.md for the full approval/confirmation vocabulary
 */
export type ExecutionMode = 'validate' | 'preview' | 'dry-run' | 'execute'

// ── PRMS ──────────────────────────────────────────────────────────────────────

export interface PrmsDoctorBlocker {
  gate: string
  reason: string
  zone?: 'green' | 'yellow' | 'red'
  owner?: string
}

export interface PrmsDoctorResult {
  status: 'READY_TO_MERGE' | 'BLOCKED' | 'ERROR'
  blockers: PrmsDoctorBlocker[]
  zone: 'green' | 'yellow' | 'red'
  why: string
  next: string
  gates: Record<string, { passed: boolean; detail: string }>
}

export interface WorkflowRuntime {
  readonly runId: string
  readonly mode: ExecutionMode
  readonly budget: BudgetState
  readonly args: Record<string, unknown>

  phase(name: string): void
  log(message: string): void
  agent<T>(prompt: string, options: AgentOptions): Promise<T>
  parallel<T>(tasks: Array<() => Promise<T>>, options?: ParallelOptions): Promise<T[]>
  pipeline<T, R>(items: T[], fn: (item: T, index: number) => Promise<R>): Promise<R[]>
  workflow(name: string, args?: Record<string, unknown>): Promise<unknown>

  openslack: {
    task: {
      createPreview(issueData: unknown): Promise<unknown>
      createIssue(issueData: unknown): Promise<{ issueUrl: string; issueNumber: number }>
      checkout(issueNumber: number, agentId: string): Promise<{ worktreePath: string; branchName: string }>
      sync(issueNumber: number): Promise<{ pushed: boolean; prUrl?: string }>
    }
    prms: {
      classify(paths: string[]): Promise<{ green: string[]; yellow: string[]; red: string[] }>
      doctor(prNumber: number): Promise<PrmsDoctorResult>
      queue(): Promise<Array<{ prNumber: number; title: string; status: string }>>
      requestMerge(prNumber: number): Promise<{ merged: boolean; prmsStatus: string }>
    }
    collaboration: {
      recordEvent(event: unknown): Promise<void>
      createHandoff(details: unknown): Promise<unknown>
      recordDecision(details: unknown): Promise<unknown>
    }
    governance: {
      audit(action: string, details?: unknown): Promise<void>
    }
  }
}

// ── Results ───────────────────────────────────────────────────────────────────

export interface PreviewResult {
  preview: true
  findings?: unknown[]
  triaged?: unknown[]
  [key: string]: unknown
}

export interface RunResult {
  status: string
  [key: string]: unknown
}

// ── Workflow Module ───────────────────────────────────────────────────────────

export interface OpenSlackWorkflow {
  meta: WorkflowMeta
  preview?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<PreviewResult>
  run?: (ctx: WorkflowRuntime, args: Record<string, unknown>) => Promise<RunResult>
}

// ── Permissions ───────────────────────────────────────────────────────────────

export type TrustLevel = 'untrusted' | 'trusted' | 'core'

export interface PermissionDeclaration {
  declared: WorkflowPermissions
  granted: WorkflowPermissions
  trustLevel: TrustLevel
}

// ── Loader types ──────────────────────────────────────────────────────────────

export type WorkflowFormat = 'openslack-native' | 'anthropic-compatible' | 'invalid'

export interface WorkflowModule {
  meta: WorkflowMeta
  preview?: OpenSlackWorkflow['preview']
  run?: OpenSlackWorkflow['run']
  format: WorkflowFormat
  hash: string
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

export interface PipelineOptions {
  concurrency?: number
}

// ── Run Info ──────────────────────────────────────────────────────────────────

export interface WorkflowRunInfo {
  runId: string
  workflowName: string
  mode: ExecutionMode
  status: RunStatus['status']
  startedAt: string
  updatedAt: string
}

// ── Agent Result ──────────────────────────────────────────────────────────────

export interface AgentResult<T = unknown> {
  data: T
  tokenUsage?: number
  schemaVersion?: string
}
