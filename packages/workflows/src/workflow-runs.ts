import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { RunStatus, WorkflowRunControlAction, WorkflowRunControlResult } from './types.js'

const TERMINAL_RUN_STATUSES = new Set<RunStatus['status']>(['completed', 'failed', 'cancelled'])

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
  options: { rootDir?: string } = {},
): Promise<WorkflowRunControlResult> {
  const rootDir = options.rootDir ?? process.cwd()
  const dir = join(runsDir(rootDir), runId)
  const statusPath = join(dir, 'status.json')
  const status = await readJson<{ status: RunStatus['status']; updatedAt: string; controlEvents?: unknown[] }>(statusPath)
  if (!status) {
    return { runId, action, status: 'rejected', message: `Workflow run not found: ${runId}` }
  }
  const nextStatus = nextStatusForAction(status.status, action)
  if (nextStatus === undefined) {
    return {
      runId,
      action,
      status: 'rejected',
      message: `${action} is not valid while workflow run ${runId} is ${status.status}.`,
    }
  }
  status.status = nextStatus as RunStatus['status']
  status.updatedAt = new Date().toISOString()
  status.controlEvents = [
    ...(Array.isArray(status.controlEvents) ? status.controlEvents : []),
    { action, timestamp: status.updatedAt },
  ]
  await writeFile(statusPath, JSON.stringify(status, null, 2), 'utf-8')
  const message = action === 'restartAgent' || action === 'stopAgent' || action === 'saveScript'
    ? `${action} recorded for ${runId}; full agent-level execution control is handled by a later runtime controller.`
    : `${action} applied to ${runId}.`
  return { runId, action, status: 'applied', message }
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
