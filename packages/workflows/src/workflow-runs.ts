import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunStatus } from './types.js';
import {
  openWorkflowRunReadOnly,
  locateWorkflowRunProjection,
  resolveWorkflowRunProjectionRoot,
} from './workflow-run-projection.js';

export interface ListWorkflowRunsOptions {
  rootDir?: string;
  status?: RunStatus['status'];
}

export interface WorkflowRunReadDiagnostic {
  runId: string;
  code: 'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED';
}
export type WorkflowRunList = RunStatus[] & { readonly diagnostics: WorkflowRunReadDiagnostic[] };

export async function listWorkflowRuns(
  options: ListWorkflowRunsOptions = {},
): Promise<WorkflowRunList> {
  const rootDir = options.rootDir ?? process.cwd();
  const readEntries = async (backend: 'ts-local' | 'go') => {
    try {
      return (
        await readdir(join(resolveWorkflowRunProjectionRoot(rootDir, backend), 'runs'), {
          withFileTypes: true,
        })
      )
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  const entries = new Set((await Promise.all([readEntries('ts-local'), readEntries('go')])).flat());
  const runs = Object.assign([] as RunStatus[], { diagnostics: [] as WorkflowRunReadDiagnostic[] });
  Object.defineProperty(runs, 'diagnostics', { enumerable: false });
  for (const entry of entries) {
    try {
      const run = await showWorkflowRun(entry, { rootDir });
      if (!run) throw new Error('Selected evidence is missing.');
      if (!options.status || run.status === options.status) runs.push(run);
    } catch {
      runs.diagnostics.push({
        runId: entry,
        code: 'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED',
      });
    }
  }
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function showWorkflowRun(
  runId: string,
  options: { rootDir?: string } = {},
): Promise<RunStatus | null> {
  const rootDir = options.rootDir ?? process.cwd();
  const { backend } = await locateWorkflowRunProjection(rootDir, runId);
  const run = await openWorkflowRunReadOnly(rootDir, backend).getRunStatus(runId);
  return run
    ? {
        ...run,
        evidenceSource: backend === 'go' ? 'go-recovery-projection' : 'typescript-historical',
      }
    : null;
}

export function renderWorkflowRuns(
  runs: RunStatus[] & { diagnostics?: WorkflowRunReadDiagnostic[] },
): string {
  const diagnostics = (runs.diagnostics ?? []).map(
    (item) =>
      `Run ${JSON.stringify(item.runId)}: ${item.code}. Use runs inspect to reconcile its evidence.`,
  );
  if (runs.length === 0)
    return [
      diagnostics.length ? 'No readable workflow runs found.' : 'No workflow runs found.',
      ...diagnostics,
    ].join('\n');
  return [
    '| Run ID | Workflow | Status | Phase | Updated | Evidence source |',
    '|--------|----------|--------|-------|---------|-----------------|',
    ...runs.map(
      (run) =>
        `| ${run.runId} | ${run.workflowName} | ${run.status} | ${run.currentPhase ?? '-'} | ${run.updatedAt} | ${run.evidenceSource ?? 'local evidence'} |`,
    ),
    ...diagnostics,
  ].join('\n');
}

export function renderWorkflowRun(run: RunStatus): string {
  const lines: string[] = [];
  lines.push(`Run: ${run.runId}`);
  lines.push(`Workflow: ${run.workflowName}`);
  lines.push(`Evidence source: ${run.evidenceSource ?? 'local evidence'}`);
  if (run.evidenceSource === 'go-recovery-projection')
    lines.push(
      'Status is a local recovery snapshot; inspect Workflow Control for the authoritative head.',
    );
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
