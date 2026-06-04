import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { requestAgentRunCancellation } from '@openslack/agent-runtime'
import type {
  RunStatus,
  WorkflowRunControlAction,
  WorkflowRunControlResult,
  WorkflowRunControlTarget,
} from './types.js'

const TERMINAL_RUN_STATUSES = new Set<RunStatus['status']>(['completed', 'failed', 'cancelled'])

interface ControlEvent {
  action?: WorkflowRunControlAction
  timestamp?: string
  target?: WorkflowRunControlTarget
  status?: 'applied' | 'recorded' | 'rejected'
  message?: string
}

interface RunStatusWithControls {
  status: RunStatus['status']
  updatedAt: string
  controlEvents?: ControlEvent[]
  pendingAgentControls?: ControlEvent[]
}

export interface ListWorkflowRunsOptions {
  rootDir?: string
  status?: RunStatus['status']
}

function runsDir(rootDir: string): string {
  return resolve(rootDir, '.openslack.local', 'workflows', 'runs')
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T
  } catch {
    return null
  }
}

function nextStatusForAction(
  current: RunStatus['status'],
  action: WorkflowRunControlAction,
): RunStatus['status'] | undefined {
  if (action === 'saveScript') return current
  if (action === 'pause') {
    return current === 'running' ? 'paused' : undefined
  }
  if (action === 'resume') {
    if (current === 'paused') return 'running'
    if (current === 'paused_waiting_approval') return 'resuming'
    return undefined
  }
  if (action === 'stopRun') {
    return TERMINAL_RUN_STATUSES.has(current) ? undefined : 'cancelled'
  }
  if (action === 'stopAgent') {
    return current === 'running' || current === 'resuming' ? current : undefined
  }
  if (action === 'restartAgent') {
    return current === 'running' || current === 'resuming' || current === 'paused' ? current : undefined
  }
  return undefined
}

export async function listWorkflowRuns(options: ListWorkflowRunsOptions = {}): Promise<RunStatus[]> {
  const rootDir = options.rootDir ?? process.cwd()
  let entries: string[] = []
  try {
    entries = await readdir(runsDir(rootDir))
  } catch {
    return []
  }
  const runs: RunStatus[] = []
  for (const entry of entries) {
    const dir = join(runsDir(rootDir), entry)
    const meta = await readJson<{ runId: string; workflowName: string; mode: RunStatus['mode']; args: Record<string, unknown>; startedAt: string }>(join(dir, 'meta.json'))
    const status = await readJson<{ status: RunStatus['status']; updatedAt: string; currentPhase?: string; phases: RunStatus['phases'] }>(join(dir, 'status.json'))
    if (!meta || !status) continue
    const run: RunStatus = {
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
    if (!options.status || run.status === options.status) runs.push(run)
  }
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function showWorkflowRun(runId: string, options: { rootDir?: string } = {}): Promise<RunStatus | null> {
  const runs = await listWorkflowRuns({ rootDir: options.rootDir })
  return runs.find((run) => run.runId === runId) ?? null
}

export async function controlWorkflowRun(
  runId: string,
  action: WorkflowRunControlAction,
  options: { rootDir?: string; target?: WorkflowRunControlTarget } = {},
): Promise<WorkflowRunControlResult> {
  const rootDir = options.rootDir ?? process.cwd()
  const dir = join(runsDir(rootDir), runId)
  const statusPath = join(dir, 'status.json')
  const status = await readJson<RunStatusWithControls>(statusPath)
  if (!status) {
    return { runId, action, status: 'rejected', message: `Workflow run not found: ${runId}`, target: options.target }
  }
  const nextStatus = nextStatusForAction(status.status, action)
  if (nextStatus === undefined) {
    return {
      runId,
      action,
      status: 'rejected',
      message: `${action} is not valid while workflow run ${runId} is ${status.status}.`,
      target: options.target,
    }
  }
  const timestamp = new Date().toISOString()
  let resultStatus: WorkflowRunControlResult['status'] = 'applied'
  let message = `${action} applied to ${runId}.`

  if (action === 'stopAgent') {
    const agentRunId = options.target?.agentRunId
    if (!agentRunId) {
      return {
        runId,
        action,
        status: 'rejected',
        message: 'stopAgent requires target.agentRunId so OpenSlack can cancel a selected live agent.',
        target: options.target,
      }
    }
    const cancel = requestAgentRunCancellation(agentRunId, `workflow ${runId} stopAgent`)
    if (cancel.status === 'cancelled' || cancel.status === 'already_cancelled') {
      message = cancel.message
    } else {
      resultStatus = 'recorded'
      message = `${cancel.message} Pending stop recorded and matching future launches for this run will be blocked.`
      status.pendingAgentControls = [
        ...(Array.isArray(status.pendingAgentControls) ? status.pendingAgentControls : []),
        { action, timestamp, target: options.target, status: 'recorded', message },
      ]
    }
  } else if (action === 'restartAgent') {
    const target = options.target
    if (!target?.agentRunId && !target?.agentId) {
      return {
        runId,
        action,
        status: 'rejected',
        message: 'restartAgent requires target.agentRunId or target.agentId.',
        target,
      }
    }
    resultStatus = 'recorded'
    message = 'restartAgent request recorded. Targeted replay requires persisted replay input and is refused for completed agents.'
    status.pendingAgentControls = [
      ...(Array.isArray(status.pendingAgentControls) ? status.pendingAgentControls : []),
      { action, timestamp, target, status: 'recorded', message },
    ]
  } else if (action === 'saveScript') {
    message = `saveScript recorded for ${runId}.`
  }

  status.status = nextStatus as RunStatus['status']
  status.updatedAt = timestamp
  status.controlEvents = [
    ...(Array.isArray(status.controlEvents) ? status.controlEvents : []),
    { action, timestamp, target: options.target, status: resultStatus, message },
  ]
  await writeFile(statusPath, JSON.stringify(status, null, 2), 'utf-8')
  return { runId, action, status: resultStatus, message, target: options.target }
}

export async function isAgentLaunchBlockedByWorkflowControl(options: {
  rootDir?: string
  runId: string
  phase: string
  label: string
  agentRunId: string
  agentType?: string
}): Promise<string | null> {
  const statusPath = join(runsDir(options.rootDir ?? process.cwd()), options.runId, 'status.json')
  const status = await readJson<RunStatusWithControls>(statusPath)
  const pending = status?.pendingAgentControls
  if (!Array.isArray(pending)) return null
  const blocked = pending.find((event) => {
    if (event.action !== 'stopAgent') return false
    const target = event.target
    if (!target) return false
    if (target.agentRunId === options.agentRunId) return true
    const samePhase = !target.phase || target.phase === options.phase
    const targetAgent = target.agentId
    return samePhase && !!targetAgent && (targetAgent === options.label || targetAgent === options.agentType)
  })
  return blocked ? blocked.message ?? 'Agent launch blocked by pending stopAgent control.' : null
}

export function renderWorkflowRuns(runs: RunStatus[]): string {
  if (runs.length === 0) return 'No workflow runs found.'
  return [
    '| Run ID | Workflow | Status | Phase | Updated |',
    '|--------|----------|--------|-------|---------|',
    ...runs.map((run) => `| ${run.runId} | ${run.workflowName} | ${run.status} | ${run.currentPhase ?? '-'} | ${run.updatedAt} |`),
  ].join('\n')
}

export function renderWorkflowRun(run: RunStatus): string {
  const lines: string[] = []
  lines.push(`Run: ${run.runId}`)
  lines.push(`Workflow: ${run.workflowName}`)
  lines.push(`Status: ${run.status}`)
  lines.push(`Mode: ${run.mode}`)
  lines.push(`Current phase: ${run.currentPhase ?? 'not recorded'}`)
  lines.push(`Started: ${run.startedAt}`)
  lines.push(`Updated: ${run.updatedAt}`)
  lines.push('')
  lines.push('Phases:')
  if (run.phases.length === 0) lines.push('  none recorded')
  for (const phase of run.phases) lines.push(`  - ${phase.phase}: ${phase.status} at ${phase.timestamp}`)
  return lines.join('\n')
}
