import { WorkflowRunReadContext } from './workflow-run-projection.js';
import {
  listWorkflowRuns,
  showWorkflowRun,
  type ListWorkflowRunsOptions,
} from './workflow-runs.js';
import { getWorkflowRunProgress, type GetWorkflowRunProgressOptions } from './workflow-progress.js';

/** Create one query per request or TUI refresh, then discard it. No cross-refresh cache. */
export function createWorkflowRunReadQuery(rootDir: string) {
  const readContext = new WorkflowRunReadContext(rootDir);
  rootDir = readContext.rootDir;
  let runs: ReturnType<typeof listWorkflowRuns> | undefined;
  return Object.freeze({
    list(options: Pick<ListWorkflowRunsOptions, 'status'> = {}) {
      if (options.status) return listWorkflowRuns({ ...options, rootDir, readContext });
      return (runs ??= listWorkflowRuns({ rootDir, readContext }));
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
