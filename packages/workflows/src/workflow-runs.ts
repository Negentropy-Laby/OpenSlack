import type { RunStatus } from './types.js';
import {
  openWorkflowRunReadOnly,
  locateWorkflowRunProjection,
  WorkflowRunReadContext,
  withWorkflowRunRead,
  retryWorkflowRunRead,
} from './workflow-run-projection.js';
import {
  WorkflowRunReadError,
  asWorkflowRunReadError,
  workflowRunReadDiagnostic,
  renderWorkflowRunReadDiagnostic,
  renderWorkflowRunReadDiagnostics,
  type WorkflowRunReadDiagnostic,
} from './workflow-run-read-errors.js';

export interface ListWorkflowRunsOptions {
  rootDir?: string;
  status?: RunStatus['status'];
  /** @internal Shared only by one read query. */
  readContext?: WorkflowRunReadContext;
}

export type { WorkflowRunReadDiagnostic } from './workflow-run-read-errors.js';
export type WorkflowRunList = RunStatus[] & { readonly diagnostics: WorkflowRunReadDiagnostic[] };

export async function listWorkflowRuns(
  options: ListWorkflowRunsOptions = {},
): Promise<WorkflowRunList> {
  const rootDir = options.rootDir ?? process.cwd();
  const readContext = options.readContext ?? new WorkflowRunReadContext(rootDir);
  await readContext.assertRoot(rootDir);
  const diagnostics: WorkflowRunReadDiagnostic[] = [];
  const roots = await Promise.all([readContext.entries('ts-local'), readContext.entries('go')]);
  diagnostics.push(...roots.flatMap((root) => root.diagnostics));
  const entries = new Set(roots.flatMap((root) => root.names));
  const runs = Object.assign([] as RunStatus[], { diagnostics });
  for (const entry of entries) {
    try {
      const run = await showWorkflowRun(entry, { rootDir, readContext });
      if (!run) {
        diagnostics.push({ scope: 'run', runId: entry, code: 'WORKFLOW_RUN_PROJECTION_MISSING' });
        continue;
      }
      if (!options.status || run.status === options.status) {
        runs.push(run);
        diagnostics.push(...(run.readDiagnostics ?? []));
      }
    } catch (error) {
      diagnostics.push(
        ...(error instanceof WorkflowRunReadError
          ? error.diagnostics
          : [workflowRunReadDiagnostic(error, { scope: 'run', runId: entry })]),
      );
    }
  }
  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function showWorkflowRun(
  runId: string,
  options: { rootDir?: string; readContext?: WorkflowRunReadContext } = {},
): Promise<RunStatus | null> {
  const rootDir = options.rootDir ?? process.cwd();
  const readContext = options.readContext ?? new WorkflowRunReadContext(rootDir);
  return retryWorkflowRunRead(() =>
    showWorkflowRunOnce(runId, { ...options, rootDir, readContext }),
  );
}

async function showWorkflowRunOnce(
  runId: string,
  options: { rootDir?: string; readContext?: WorkflowRunReadContext } = {},
): Promise<RunStatus | null> {
  const rootDir = options.rootDir ?? process.cwd();
  const readContext = options.readContext ?? new WorkflowRunReadContext(rootDir);
  const location = await locateWorkflowRunProjection(rootDir, runId, {
    readContext,
  });
  if (location.state === 'missing') return null;
  if (location.state !== 'found')
    throw new WorkflowRunReadError(location.diagnostics, { primaryCode: location.primaryCode });
  const { backend, diagnostics } = location;
  let run: RunStatus | null;
  try {
    run = await withWorkflowRunRead(
      runId,
      location,
      () => openWorkflowRunReadOnly(rootDir, backend, readContext).getRunStatus(runId),
      readContext,
    );
  } catch (error) {
    throw asWorkflowRunReadError(error, { scope: 'run', runId, backend });
  }
  if (
    run &&
    (run.runId !== runId ||
      typeof run.updatedAt !== 'string' ||
      typeof run.status !== 'string' ||
      !Array.isArray(run.phases))
  ) {
    throw new WorkflowRunReadError([
      { scope: 'run', runId, backend, code: 'WORKFLOW_RUN_EVIDENCE_INVALID' },
    ]);
  }
  return run
    ? {
        ...run,
        provenance: location.provenance,
        degraded: location.degraded,
        evidenceSource: backend === 'go' ? 'go-recovery-projection' : 'typescript-historical',
        ...(diagnostics.length ? { readDiagnostics: diagnostics } : {}),
      }
    : null;
}

export function renderWorkflowRuns(
  runs: RunStatus[] & { diagnostics?: WorkflowRunReadDiagnostic[] },
): string {
  const diagnostics = renderWorkflowRunReadDiagnostics(runs.diagnostics ?? []);
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
  lines.push(...(run.readDiagnostics ?? []).map(renderWorkflowRunReadDiagnostic));
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
