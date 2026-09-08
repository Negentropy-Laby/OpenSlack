import { WorkflowRunReadContext } from './workflow-run-projection.js';
import {
  listWorkflowRuns,
  showWorkflowRun,
  type ListWorkflowRunsOptions,
} from './workflow-runs.js';
import {
  getWorkflowRunProgress,
  loadWorkflowReadModule,
  type GetWorkflowRunProgressOptions,
} from './workflow-progress.js';

/** Create one query per request or TUI refresh, then discard it. No cross-refresh cache. */
export function createWorkflowRunReadQuery(rootDir: string) {
  const readContext = new WorkflowRunReadContext(rootDir);
  rootDir = readContext.rootDir;
  let runs: ReturnType<typeof listWorkflowRuns> | undefined;
  let generation: number | undefined;
  return Object.freeze({
    async list(options: Pick<ListWorkflowRunsOptions, 'status'> = {}) {
      const current = await readContext.refresh();
      if (generation !== current) {
        runs = undefined;
        generation = current;
      }
      const pending = (runs ??= listWorkflowRuns({ rootDir, readContext }));
      let all: Awaited<typeof pending>;
      try {
        all = await pending;
      } catch (error) {
        if (runs === pending) runs = undefined;
        throw error;
      }
      if (all.diagnostics.some((d) => d.code !== 'WORKFLOW_RUN_UNROUTED_GO_PROJECTION'))
        runs = undefined;
      const excluded = new Set(
        all
          .filter((run) => options.status && run.status !== options.status)
          .map((run) => run.runId),
      );
      // Return caller-owned records and the enumerable diagnostics property explicitly.
      return Object.assign(structuredClone(all.filter((run) => !excluded.has(run.runId))), {
        diagnostics: structuredClone(
          all.diagnostics.filter((d) => d.scope !== 'run' || !excluded.has(d.runId!)),
        ),
      });
    },
    workflow(workflowName: string) {
      return readContext.memo(`workflow:${workflowName}`, () =>
        loadWorkflowReadModule(rootDir, workflowName),
      );
    },
    show(runId: string) {
      return showWorkflowRun(runId, { rootDir, readContext });
    },
    progress(
      runId: string,
      options: Omit<GetWorkflowRunProgressOptions, 'rootDir' | 'readContext'> = {},
    ) {
      return getWorkflowRunProgress(runId, { ...options, rootDir, readContext });
    },
  });
}
