import { sanitizeTerminalText } from '../sanitize.js'

export interface LifecycleStage {
  name: string
  label: string
  status: string
  icon: string
  issueNumber?: number
  issueUrl?: string
  detail: string
}

export interface PhaseIssueItem {
  phase: string
  issueNumber?: number
  status: string
  blockedBy?: string[]
}

export interface WorkflowLifecycleViewModel {
  workflowName: string
  workflowHash: string
  trustLevel: string
  risk: string
  sourcePath: string
  stages: LifecycleStage[]
  phaseIssues: PhaseIssueItem[]
  currentRun?: {
    runId: string
    status: string
    startedAt: string
    phaseIndex: number
  }
  prNumber?: number
  prStatus?: string
  nextAction?: string
  subIssueMode?: 'native' | 'fallback' | 'mixed' | 'unknown'
  dependencyMode?: 'native' | 'fallback' | 'none'
}

export function mapWorkflowLifecycleToViewModel(data?: {
  workflowName?: string
  workflowHash?: string
  trustLevel?: string
  risk?: string
  sourcePath?: string
  stages?: Array<{
    name?: string
    label?: string
    status?: string
    icon?: string
    issueNumber?: number
    issueUrl?: string
    detail?: string
  }>
  phaseIssues?: Array<{
    phase?: string
    issueNumber?: number
    status?: string
    blockedBy?: string[]
  }>
  currentRun?: {
    runId?: string
    status?: string
    startedAt?: string
    phaseIndex?: number
  }
  prNumber?: number
  prStatus?: string
  nextAction?: string
  subIssueMode?: 'native' | 'fallback' | 'mixed' | 'unknown'
  dependencyMode?: 'native' | 'fallback' | 'none'
}): WorkflowLifecycleViewModel {
  const s = sanitizeTerminalText

  const stages: LifecycleStage[] = (data?.stages ?? []).map(stage => ({
    name: s(stage.name ?? ''),
    label: s(stage.label ?? ''),
    status: s(stage.status ?? 'pending'),
    icon: s(stage.icon ?? '●'),
    issueNumber: stage.issueNumber,
    issueUrl: stage.issueUrl ? s(stage.issueUrl) : undefined,
    detail: s(stage.detail ?? ''),
  }))

  const phaseIssues: PhaseIssueItem[] = (data?.phaseIssues ?? []).map(pi => ({
    phase: s(pi.phase ?? ''),
    issueNumber: pi.issueNumber,
    status: s(pi.status ?? 'open'),
    blockedBy: (pi.blockedBy ?? []).map(s),
  }))

  return {
    workflowName: s(data?.workflowName ?? ''),
    workflowHash: s(data?.workflowHash ?? ''),
    trustLevel: s(data?.trustLevel ?? 'untrusted'),
    risk: s(data?.risk ?? 'unknown'),
    sourcePath: s(data?.sourcePath ?? ''),
    stages,
    phaseIssues,
    currentRun: data?.currentRun
      ? {
          runId: s(data.currentRun.runId ?? ''),
          status: s(data.currentRun.status ?? ''),
          startedAt: s(data.currentRun.startedAt ?? ''),
          phaseIndex: data.currentRun.phaseIndex ?? 0,
        }
      : undefined,
    prNumber: data?.prNumber,
    prStatus: data?.prStatus ? s(data.prStatus) : undefined,
    nextAction: data?.nextAction ? s(data.nextAction) : undefined,
    subIssueMode: data?.subIssueMode,
    dependencyMode: data?.dependencyMode,
  }
}
