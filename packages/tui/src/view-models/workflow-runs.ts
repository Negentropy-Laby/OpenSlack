import { sanitizeTerminalText } from '../sanitize.js'

export interface WorkflowToolEvidenceViewModel {
  type: 'tool_call' | 'tool_result' | 'progress'
  name: string
  timestamp?: string
  summary: string
}

export interface WorkflowAgentProgressItem {
  id: string
  label: string
  phase: string
  status: string
  cached: boolean
  agentRunId?: string
  model?: string
  runtimeProvider?: string
  bridgeMode?: string
  isolation?: 'none' | 'worktree'
  worktreePath?: string
  promptSummary: string
  transcriptPath?: string
  resultSummary?: string
  terminalReason?: string
  replayAvailable?: boolean
  replayUnavailableReason?: string
  tokensUsed: number
  tokensRemaining: number | null
  recentTools: WorkflowToolEvidenceViewModel[]
  warnings: string[]
}

export interface WorkflowPhaseProgressItem {
  phase: string
  status: 'not-started' | 'running' | 'completed' | 'failed' | 'skipped' | 'unknown'
  timestamp?: string
  elapsedMs?: number
  agentCount: number
  tokenTotal: number
  cachedCount: number
  liveCount: number
  failedCount: number
  agents: WorkflowAgentProgressItem[]
  resultSummary?: string
  warnings: string[]
}

export interface WorkflowRunProgressItem {
  runId: string
  workflowName: string
  mode: string
  status: string
  startedAt?: string
  updatedAt?: string
  elapsedMs?: number
  currentPhase?: string
  args: Record<string, unknown>
  phaseCount: number
  agentCount: number
  pendingApprovalCount: number
  budget: {
    tokenBudget: number | null
    tokensUsed: number
    tokensRemaining: number | null
    costUsd?: number
    costEstimateUsd?: number
    costSource?: string
    tokenBudgetPercent?: number
    warningThreshold?: number
    status?: 'ok' | 'warning' | 'exceeded' | 'unknown'
    warnings?: string[]
    agentCalls: number
    maxAgents?: number
    maxConcurrency?: number
    onExceeded?: 'pause' | 'fail'
    source: string
  }
  phases: WorkflowPhaseProgressItem[]
  outputSummary?: string
  logTail: string[]
  warnings: string[]
}

export interface WorkflowRunProgressViewModel {
  runs: WorkflowRunProgressItem[]
  selectedRun?: WorkflowRunProgressItem
  summary: {
    total: number
    running: number
    paused: number
    failed: number
    pendingApprovals: number
  }
}

export function mapWorkflowRunsToViewModel(runs: WorkflowRunProgressItem[]): WorkflowRunProgressViewModel {
  const s = sanitizeTerminalText
  const cleanRuns = runs.map((run) => ({
    ...run,
    workflowName: s(run.workflowName),
    currentPhase: run.currentPhase ? s(run.currentPhase) : undefined,
    logTail: run.logTail.map(s),
    warnings: run.warnings.map(s),
    phases: run.phases.map((phase) => ({
      ...phase,
      phase: s(phase.phase),
      resultSummary: phase.resultSummary ? s(phase.resultSummary) : undefined,
      warnings: phase.warnings.map(s),
      agents: phase.agents.map((agent) => ({
        ...agent,
        label: s(agent.label),
        phase: s(agent.phase),
        promptSummary: s(agent.promptSummary),
        resultSummary: agent.resultSummary ? s(agent.resultSummary) : undefined,
        terminalReason: agent.terminalReason ? s(agent.terminalReason) : undefined,
        replayUnavailableReason: agent.replayUnavailableReason ? s(agent.replayUnavailableReason) : undefined,
        warnings: agent.warnings.map(s),
        recentTools: agent.recentTools.map((tool) => ({
          ...tool,
          name: s(tool.name),
          summary: s(tool.summary),
        })),
      })),
    })),
    budget: {
      ...run.budget,
      warnings: (run.budget.warnings ?? []).map(s),
    },
  }))
  return {
    runs: cleanRuns,
    selectedRun: cleanRuns[0],
    summary: {
      total: cleanRuns.length,
      running: cleanRuns.filter((run) => run.status === 'running' || run.status === 'resuming').length,
      paused: cleanRuns.filter((run) => run.status === 'paused' || run.status === 'paused_waiting_approval').length,
      failed: cleanRuns.filter((run) => run.status === 'failed' || run.status === 'cancelled').length,
      pendingApprovals: cleanRuns.reduce((sum, run) => sum + run.pendingApprovalCount, 0),
    },
  }
}
