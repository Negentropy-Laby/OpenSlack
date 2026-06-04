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

export interface WorkflowRunDecisionSummary {
  status: string
  owner: 'workflow' | 'human' | 'agent/operator' | 'none'
  blocker: string
  nextAction: string
}

export function deriveWorkflowRunDecisionSummary(run: WorkflowRunProgressItem): WorkflowRunDecisionSummary {
  const failedPhase = run.phases.find((phase) => phase.status === 'failed')
  const currentPhase = run.currentPhase ?? failedPhase?.phase ?? 'current phase'

  if (run.status === 'failed' || run.status === 'cancelled' || failedPhase) {
    return {
      status: run.status,
      owner: 'agent/operator',
      blocker: failedPhase ? `failed phase: ${failedPhase.phase}` : run.status,
      nextAction: 'inspect failed phase',
    }
  }

  if ((run.status === 'paused' || run.status === 'paused_waiting_approval') && run.pendingApprovalCount > 0) {
    return {
      status: run.status,
      owner: 'human',
      blocker: `${run.pendingApprovalCount} pending approval${run.pendingApprovalCount === 1 ? '' : 's'}`,
      nextAction: 'open approvals',
    }
  }

  if (run.budget.status === 'exceeded') {
    // Older run evidence may omit onExceeded; keep the summary useful without inventing a policy.
    const nextAction = run.budget.onExceeded === 'pause'
      ? 'open approvals or increase budget'
      : run.budget.onExceeded === 'fail'
        ? 'inspect failed budget stop'
        : 'review budget policy'
    return {
      status: run.status,
      owner: run.budget.onExceeded === 'pause' ? 'human' : 'agent/operator',
      blocker: 'budget exceeded',
      nextAction,
    }
  }

  if (run.budget.status === 'warning') {
    return {
      status: run.status,
      owner: 'workflow',
      blocker: 'budget warning',
      nextAction: 'review budget / pause / continue',
    }
  }

  if (run.status === 'running' || run.status === 'resuming') {
    return {
      status: run.status,
      owner: 'workflow',
      blocker: 'none',
      nextAction: `watch ${currentPhase}`,
    }
  }

  if (run.status === 'completed') {
    return {
      status: run.status,
      owner: 'none',
      blocker: 'none',
      nextAction: 'save/share or publish',
    }
  }

  return {
    status: run.status,
    owner: 'workflow',
    blocker: 'none',
    nextAction: 'inspect workflow run evidence',
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
