import type {
  ExecutionMode,
  PhaseCheckpoint,
  RunStatus,
  RunStatusState,
  PendingApproval,
  WorkflowBudgetPolicy,
  WorkflowRunInfo,
} from './types.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile, appendFile as fsAppendFile, access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { scanValue } from '@openslack/collaboration'

// ── Directory layout ──────────────────────────────────────────────────────────
//
// .openslack.local/workflows/
//   runs/
//     <runId>/
//       meta.json            # Run metadata
//       status.json          # Current status, phase index
//       phases/
//         <phaseName>.json   # Phase result and checkpoint
//       agents/
//         <cacheKey>.json    # Agent call result cache
//       pipeline/
//         <phaseName>/
//           <index>.json     # Pipeline item checkpoint
//       log.jsonl            # Structured log entries
//       output.json          # Final workflow output (on completion)

/**
 * Valid run statuses and their allowed transitions.
 *
 *   running -> paused    (interrupted, resumable)
 *   running -> completed (successful finish)
 *   running -> failed    (unrecoverable error)
 *   paused  -> running   (resumed)
 */
const VALID_TRANSITIONS: Record<string, Set<string>> = {
  created: new Set(['previewed', 'confirmed', 'running']),
  previewed: new Set(['confirmed', 'running']),
  confirmed: new Set(['running']),
  running: new Set(['paused', 'paused_waiting_approval', 'resuming', 'completed', 'failed', 'cancelled']),
  paused: new Set(['running']),
  paused_waiting_approval: new Set(['resuming', 'cancelled']),
  resuming: new Set(['running', 'failed', 'cancelled']),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
}

/**
 * Run metadata persisted to meta.json.
 */
export interface RunMeta {
  runId: string
  workflowName: string
  mode: ExecutionMode
  manifestHash: string
  args: Record<string, unknown>
  startedAt: string
  budget?: { tokens: number; costUsd?: number }
  budgetPolicy?: WorkflowBudgetPolicy
}

/**
 * Run status persisted to status.json.
 */
export interface RunStatusFile {
  runId: string
  status: RunStatus['status']
  currentPhase?: string
  updatedAt: string
  phases: PhaseCheckpoint[]
  budgetWarnings?: BudgetWarning[]
  controlEvents?: Array<Record<string, unknown>>
  pendingAgentControls?: Array<Record<string, unknown>>
}

/**
 * A single JSONL log line.
 */
export interface LogEntry {
  ts: string
  phase?: string
  message: string
  runId: string
}

export interface BudgetWarning {
  timestamp: string
  kind: 'threshold' | 'exceeded'
  message: string
  tokensUsed: number
  tokenBudget: number
  percent: number
  costUsd?: number
}

export interface AgentReplayInput {
  schema: 'openslack.workflow_agent_replay_input.v1'
  workflowRunId: string
  agentRunId: string
  prompt: string
  options: Record<string, unknown>
  resolvedAgentConfig?: unknown
  phase: string
  label: string
  cacheKey: string
  attempt: number
  createdAt: string
}

export type AgentReplayInputLoadResult =
  | { available: true; input: AgentReplayInput }
  | { available: false; reason: string }

export interface AgentReplayInputPersistenceResult {
  available: boolean
  reason?: string
  path: string
}

/**
 * Abstraction over the filesystem operations the run store needs.
 * Tests inject an in-memory implementation; production uses real fs.
 */
export interface RunStoreFs {
  /** Ensure a directory exists (recursive mkdir). */
  mkdir(dir: string): Promise<void>
  /** Write a file with UTF-8 text content. */
  writeFile(path: string, content: string): Promise<void>
  /** Read a file as UTF-8 text. Returns null if file does not exist. */
  readFile(path: string): Promise<string | null>
  /** Append a line to a file (creates if missing). */
  appendFile(path: string, line: string): Promise<void>
  /** Check if a path exists. */
  exists(path: string): Promise<boolean>
}

/**
 * Options for creating a RunStore.
 */
export interface RunStoreOptions {
  /** Root directory for all runs, e.g. `.openslack.local/workflows` */
  baseDir: string
  /** Filesystem abstraction. Defaults to Node.js fs if not provided. */
  fs?: RunStoreFs
}

/**
 * Run store manages the on-disk state for a single workflow run.
 *
 * All paths are derived from `baseDir/runs/<runId>/`.
 */
export class RunStore {
  private readonly baseDir: string
  private readonly fs: RunStoreFs

  constructor(options: RunStoreOptions) {
    this.baseDir = options.baseDir
    this.fs = options.fs ?? createNodeFs()
  }

  // ── Path helpers ──────────────────────────────────────────────────────────

  /** Path to the run directory. */
  runDir(runId: string): string {
    return `${this.baseDir}/runs/${runId}`
  }

  /** Path to meta.json. */
  metaPath(runId: string): string {
    return `${this.runDir(runId)}/meta.json`
  }

  /** Path to status.json. */
  statusPath(runId: string): string {
    return `${this.runDir(runId)}/status.json`
  }

  /** Path to the phases directory. */
  phasesDir(runId: string): string {
    return `${this.runDir(runId)}/phases`
  }

  /** Path to a specific phase file. */
  phasePath(runId: string, phaseName: string): string {
    return `${this.phasesDir(runId)}/${phaseName}.json`
  }

  /** Path to the agents directory. */
  agentsDir(runId: string): string {
    return `${this.runDir(runId)}/agents`
  }

  /** Path to an agent cache file. */
  agentPath(runId: string, cacheKey: string): string {
    return `${this.agentsDir(runId)}/${safeFileName(cacheKey)}.json`
  }

  /** Path to the replay input directory. */
  replayDir(runId: string): string {
    return `${this.runDir(runId)}/replay/agents`
  }

  /** Path to a replay input file. */
  replayInputPath(runId: string, agentRunId: string): string {
    return `${this.replayDir(runId)}/${safeFileName(agentRunId)}.json`
  }

  /** Path to a replay-unavailable marker. */
  replayUnavailablePath(runId: string, agentRunId: string): string {
    return `${this.replayDir(runId)}/${safeFileName(agentRunId)}.unavailable.json`
  }

  /** Path to the pipeline directory. */
  pipelineDir(runId: string, phaseName: string): string {
    return `${this.runDir(runId)}/pipeline/${phaseName}`
  }

  /** Path to a pipeline item file. */
  pipelineItemPath(runId: string, phaseName: string, index: number): string {
    return `${this.pipelineDir(runId, phaseName)}/${index}.json`
  }

  /** Path to log.jsonl. */
  logPath(runId: string): string {
    return `${this.runDir(runId)}/log.jsonl`
  }

  /** Path to output.json. */
  outputPath(runId: string): string {
    return `${this.runDir(runId)}/output.json`
  }

  /** Path to pending-approvals.json. */
  pendingApprovalsPath(runId: string): string {
    return `${this.runDir(runId)}/pending-approvals.json`
  }

  // ── Initialization ────────────────────────────────────────────────────────

  /**
   * Initialize a new run: create directory structure and write meta + status.
   */
  async initRun(runId: string, meta: RunMeta): Promise<void> {
    const dir = this.runDir(runId)
    await this.fs.mkdir(dir)
    await this.fs.mkdir(this.phasesDir(runId))
    await this.fs.mkdir(this.agentsDir(runId))
    await this.fs.mkdir(this.replayDir(runId))

    // Write meta.json
    await this.fs.writeFile(this.metaPath(runId), JSON.stringify(meta, null, 2))

    // Write initial status.json
    const status: RunStatusFile = {
      runId,
      status: 'running',
      updatedAt: meta.startedAt,
      phases: [],
    }
    await this.fs.writeFile(this.statusPath(runId), JSON.stringify(status, null, 2))
  }

  // ── Status management ─────────────────────────────────────────────────────

  /**
   * Load the current run status. Returns null if run does not exist.
   */
  async loadStatus(runId: string): Promise<RunStatusFile | null> {
    const raw = await this.fs.readFile(this.statusPath(runId))
    if (raw === null) return null
    return JSON.parse(raw) as RunStatusFile
  }

  /**
   * Transition run status. Throws if the transition is invalid.
   */
  async transitionStatus(
    runId: string,
    newStatus: RunStatus['status'],
  ): Promise<void> {
    const current = await this.loadStatus(runId)
    if (current === null) {
      throw new Error(`Run ${runId} not found`)
    }

    const allowed = VALID_TRANSITIONS[current.status]
    if (!allowed || !allowed.has(newStatus)) {
      throw new Error(
        `Invalid status transition: ${current.status} -> ${newStatus}`,
      )
    }

    current.status = newStatus
    current.updatedAt = new Date().toISOString()
    await this.fs.writeFile(
      this.statusPath(runId),
      JSON.stringify(current, null, 2),
    )
  }

  /**
   * Update the current phase name in the status file.
   */
  async setCurrentPhase(runId: string, phase: string): Promise<void> {
    const current = await this.loadStatus(runId)
    if (current === null) {
      throw new Error(`Run ${runId} not found`)
    }
    current.currentPhase = phase
    current.updatedAt = new Date().toISOString()
    await this.fs.writeFile(
      this.statusPath(runId),
      JSON.stringify(current, null, 2),
    )
  }

  // ── Phase checkpoints ─────────────────────────────────────────────────────

  /**
   * Save a phase checkpoint to the phases directory.
   */
  async savePhaseCheckpoint(
    runId: string,
    checkpoint: PhaseCheckpoint,
  ): Promise<void> {
    await this.fs.writeFile(
      this.phasePath(runId, checkpoint.phase),
      JSON.stringify(checkpoint, null, 2),
    )

    // Also update the phases array in status.json
    const status = await this.loadStatus(runId)
    if (status !== null) {
      const idx = status.phases.findIndex(p => p.phase === checkpoint.phase)
      if (idx >= 0) {
        status.phases[idx] = checkpoint
      } else {
        status.phases.push(checkpoint)
      }
      status.updatedAt = new Date().toISOString()
      await this.fs.writeFile(
        this.statusPath(runId),
        JSON.stringify(status, null, 2),
      )
    }
  }

  /**
   * Load a phase checkpoint. Returns null if not found.
   */
  async loadPhaseCheckpoint(
    runId: string,
    phaseName: string,
  ): Promise<PhaseCheckpoint | null> {
    const raw = await this.fs.readFile(this.phasePath(runId, phaseName))
    if (raw === null) return null
    return JSON.parse(raw) as PhaseCheckpoint
  }

  // ── Agent result cache ────────────────────────────────────────────────────

  /**
   * Save an agent call result to the cache.
   */
  async saveAgentResult(
    runId: string,
    cacheKey: string,
    result: unknown,
  ): Promise<void> {
    await this.fs.writeFile(
      this.agentPath(runId, cacheKey),
      JSON.stringify(result, null, 2),
    )
  }

  async saveAgentReplayInput(
    runId: string,
    agentRunId: string,
    input: AgentReplayInput,
  ): Promise<AgentReplayInputPersistenceResult> {
    await this.fs.mkdir(this.replayDir(runId))
    const targetPath = this.replayInputPath(runId, agentRunId)
    const scan = scanValue(input, 'replayInput')
    if (scan.found) {
      const reason = `Replay input contains ${scan.name} at ${scan.path}. Restart unavailable.`
      await this.markAgentReplayUnavailable(runId, agentRunId, reason)
      return { available: false, reason, path: this.replayUnavailablePath(runId, agentRunId) }
    }
    await this.fs.writeFile(targetPath, JSON.stringify(input, null, 2))
    return { available: true, path: targetPath }
  }

  async markAgentReplayUnavailable(
    runId: string,
    agentRunId: string,
    reason: string,
  ): Promise<void> {
    await this.fs.mkdir(this.replayDir(runId))
    await this.fs.writeFile(
      this.replayUnavailablePath(runId, agentRunId),
      JSON.stringify({ agentRunId, available: false, reason, timestamp: new Date().toISOString() }, null, 2),
    )
  }

  async loadAgentReplayInput(
    runId: string,
    agentRunId: string,
  ): Promise<AgentReplayInputLoadResult | null> {
    const unavailable = await this.fs.readFile(this.replayUnavailablePath(runId, agentRunId))
    if (unavailable !== null) {
      try {
        const parsed = JSON.parse(unavailable) as { reason?: string }
        return { available: false, reason: parsed.reason ?? 'Replay input is unavailable.' }
      } catch {
        return { available: false, reason: 'Replay input availability marker could not be parsed.' }
      }
    }
    const raw = await this.fs.readFile(this.replayInputPath(runId, agentRunId))
    if (raw === null) return null
    return { available: true, input: JSON.parse(raw) as AgentReplayInput }
  }

  /**
   * Load a cached agent result. Returns null if not found.
   */
  async loadAgentResult(
    runId: string,
    cacheKey: string,
  ): Promise<unknown | null> {
    const raw = await this.fs.readFile(this.agentPath(runId, cacheKey))
    if (raw === null) return null
    return JSON.parse(raw)
  }

  // ── Pipeline item cache ───────────────────────────────────────────────────

  /**
   * Save a pipeline item result.
   */
  async savePipelineItem(
    runId: string,
    phase: string,
    index: number,
    result: unknown,
  ): Promise<void> {
    await this.fs.mkdir(this.pipelineDir(runId, phase))
    await this.fs.writeFile(
      this.pipelineItemPath(runId, phase, index),
      JSON.stringify(result, null, 2),
    )
  }

  /**
   * Load a pipeline item result. Returns null if not found.
   */
  async loadPipelineItem(
    runId: string,
    phase: string,
    index: number,
  ): Promise<unknown | null> {
    const raw = await this.fs.readFile(
      this.pipelineItemPath(runId, phase, index),
    )
    if (raw === null) return null
    return JSON.parse(raw)
  }

  // ── Logging ───────────────────────────────────────────────────────────────

  /**
   * Append a structured log entry to log.jsonl.
   */
  async appendLog(runId: string, entry: LogEntry): Promise<void> {
    await this.fs.appendFile(this.logPath(runId), JSON.stringify(entry) + '\n')
  }

  async appendBudgetWarning(runId: string, warning: BudgetWarning): Promise<void> {
    const status = await this.loadStatus(runId)
    if (status === null) return
    status.budgetWarnings = [...(status.budgetWarnings ?? []), warning]
    status.updatedAt = new Date().toISOString()
    await this.fs.writeFile(this.statusPath(runId), JSON.stringify(status, null, 2))
  }

  /**
   * Read all log entries for a run.
   */
  async readLog(runId: string): Promise<LogEntry[]> {
    const raw = await this.fs.readFile(this.logPath(runId))
    if (raw === null) return []
    return raw
      .trim()
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as LogEntry)
  }

  // ── Output ────────────────────────────────────────────────────────────────

  /**
   * Save the final workflow output.
   */
  async saveOutput(runId: string, output: unknown): Promise<void> {
    await this.fs.writeFile(
      this.outputPath(runId),
      JSON.stringify(output, null, 2),
    )
  }

  /**
   * Load the final workflow output. Returns null if not found.
   */
  async loadOutput(runId: string): Promise<unknown | null> {
    const raw = await this.fs.readFile(this.outputPath(runId))
    if (raw === null) return null
    return JSON.parse(raw)
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  /**
   * Load run metadata. Returns null if not found.
   */
  async loadMeta(runId: string): Promise<RunMeta | null> {
    const raw = await this.fs.readFile(this.metaPath(runId))
    if (raw === null) return null
    return JSON.parse(raw) as RunMeta
  }

  /**
   * Check if a run directory exists.
   */
  async runExists(runId: string): Promise<boolean> {
    return this.fs.exists(this.runDir(runId))
  }

  /**
   * Build a full RunStatus object for external consumers.
   */
  async getRunStatus(runId: string): Promise<RunStatus | null> {
    const meta = await this.loadMeta(runId)
    const status = await this.loadStatus(runId)
    if (meta === null || status === null) return null

    return {
      runId: meta.runId,
      workflowName: meta.workflowName,
      mode: meta.mode,
      status: status.status,
      startedAt: meta.startedAt,
      updatedAt: status.updatedAt,
      currentPhase: status.currentPhase,
      phases: status.phases,
      args: meta.args,
    }
  }

  // ── Pending Approvals ─────────────────────────────────────────────────────

  /**
   * Save a pending approval to the run's pending-approvals.json.
   */
  async savePendingApproval(
    runId: string,
    approval: Omit<PendingApproval, 'id' | 'status'>,
  ): Promise<void> {
    const approvals = await this.loadPendingApprovals(runId)
    approvals.push({
      id: randomUUID(),
      status: 'pending',
      ...approval,
    })
    await this.fs.writeFile(
      this.pendingApprovalsPath(runId),
      JSON.stringify(approvals, null, 2),
    )
  }

  /**
   * Load all pending approvals for a run.
   */
  async loadPendingApprovals(runId: string): Promise<PendingApproval[]> {
    const raw = await this.fs.readFile(this.pendingApprovalsPath(runId))
    if (raw === null) return []
    return JSON.parse(raw) as PendingApproval[]
  }

  /**
   * Resolve a pending approval by id.
   */
  async resolvePendingApproval(
    runId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<void> {
    const approvals = await this.loadPendingApprovals(runId)
    const idx = approvals.findIndex(a => a.id === approvalId)
    if (idx < 0) {
      throw new Error(`Approval ${approvalId} not found for run ${runId}`)
    }
    approvals[idx].status = decision
    await this.fs.writeFile(
      this.pendingApprovalsPath(runId),
      JSON.stringify(approvals, null, 2),
    )
  }

  // ── Listing ───────────────────────────────────────────────────────────────

  /**
   * List all runs with a specific status.
   */
  async listRunsByStatus(status: RunStatusState): Promise<WorkflowRunInfo[]> {
    const runsDir = `${this.baseDir}/runs`
    let runIds: string[]
    try {
      // List run directories
      const entries = await this.fs.readFile(`${runsDir}/.index`)
      if (entries) {
        runIds = entries.trim().split('\n').filter(Boolean)
      } else {
        // Fallback: scan directories if no index file
        const { readdir } = await import('node:fs/promises')
        runIds = await readdir(runsDir).catch(() => [])
      }
    } catch {
      return []
    }

    const results: WorkflowRunInfo[] = []
    for (const runId of runIds) {
      const meta = await this.loadMeta(runId)
      const st = await this.loadStatus(runId)
      if (meta && st && st.status === status) {
        results.push({
          runId: meta.runId,
          workflowName: meta.workflowName,
          mode: meta.mode,
          status: st.status as RunStatusState,
          startedAt: meta.startedAt,
          updatedAt: st.updatedAt,
        })
      }
    }
    return results
  }
}

// ── Node.js fs adapter ─────────────────────────────────────────────────────

function createNodeFs(): RunStoreFs {
  return {
    async mkdir(dir: string) {
      await mkdir(dir, { recursive: true })
    },
    async writeFile(path: string, content: string) {
      await fsWriteFile(resolve(path), content, 'utf-8')
    },
    async readFile(path: string) {
      try {
        return await fsReadFile(resolve(path), 'utf-8')
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return null
        }
        throw err
      }
    },
    async appendFile(path: string, line: string) {
      await fsAppendFile(resolve(path), line, 'utf-8')
    },
    async exists(path: string) {
      try {
        await access(resolve(path))
        return true
      } catch {
        return false
      }
    },
  }
}

function safeFileName(value: string): string {
  return encodeURIComponent(value).replace(/\*/g, '%2A')
}
