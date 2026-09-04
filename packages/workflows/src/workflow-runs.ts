import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { RunStatus } from './types.js';
import { RunStore } from './run-store.js';

export interface ListWorkflowRunsOptions {
  rootDir?: string;
  status?: RunStatus['status'];
}

function runsDir(rootDir: string): string {
  return resolve(rootDir, '.openslack.local', 'workflows', 'runs');
}

export async function listWorkflowRuns(
  options: ListWorkflowRunsOptions = {},
): Promise<RunStatus[]> {
  const rootDir = options.rootDir ?? process.cwd();
  let entries: string[] = [];
  try {
    entries = await readdir(runsDir(rootDir));
  } catch {
    return [];
  }
  const store = new RunStore({
    baseDir: resolve(rootDir, '.openslack.local', 'workflows'),
  });
  const runs: RunStatus[] = [];
  for (const entry of entries) {
    const run = await store.getRunStatus(entry);
    if (!run) continue;
    if (!options.status || run.status === options.status) runs.push(run);
  }
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function showWorkflowRun(
  runId: string,
  options: { rootDir?: string } = {},
): Promise<RunStatus | null> {
  const runs = await listWorkflowRuns({ rootDir: options.rootDir });
  return runs.find((run) => run.runId === runId) ?? null;
}

export async function isAgentLaunchBlockedByWorkflowControl(options: {
  rootDir?: string;
  runId: string;
  phase: string;
  label: string;
  agentRunId: string;
  agentType?: string;
}): Promise<string | null> {
  const store = new RunStore({
    baseDir: join(options.rootDir ?? process.cwd(), '.openslack.local', 'workflows'),
  });
  const status = await store.loadStatus(options.runId);
  const pending = status?.pendingAgentControls;
  if (!Array.isArray(pending)) return null;
  const blocked = pending.find((event) => {
    if (event.action !== 'stopAgent') return false;
    const target = event.target;
    if (!target) return false;
    if (target.agentRunId === options.agentRunId) return true;
    const samePhase = !target.phase || target.phase === options.phase;
    const targetAgent = target.agentId;
    return (
      samePhase &&
      !!targetAgent &&
      (targetAgent === options.label || targetAgent === options.agentType)
    );
  });
  return blocked ? (blocked.message ?? 'Agent launch blocked by pending stopAgent control.') : null;
}

export function renderWorkflowRuns(runs: RunStatus[]): string {
  if (runs.length === 0) return 'No workflow runs found.';
  return [
    '| Run ID | Workflow | Status | Phase | Updated |',
    '|--------|----------|--------|-------|---------|',
    ...runs.map(
      (run) =>
        `| ${run.runId} | ${run.workflowName} | ${run.status} | ${run.currentPhase ?? '-'} | ${run.updatedAt} |`,
    ),
  ].join('\n');
}

export function renderWorkflowRun(run: RunStatus): string {
  const lines: string[] = [];
  lines.push(`Run: ${run.runId}`);
  lines.push(`Workflow: ${run.workflowName}`);
  lines.push(`Status: ${run.status}`);
  lines.push(`Mode: ${run.mode}`);
  lines.push(`Current phase: ${run.currentPhase ?? 'not recorded'}`);
  lines.push(`Started: ${run.startedAt}`);
  lines.push(`Updated: ${run.updatedAt}`);
  lines.push('');
  lines.push('Phases:');
  if (run.phases.length === 0) lines.push('  none recorded');
  for (const phase of run.phases)
    lines.push(`  - ${phase.phase}: ${phase.status} at ${phase.timestamp}`);
  return lines.join('\n');
}
