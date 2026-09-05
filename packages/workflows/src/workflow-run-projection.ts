import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { RunStore } from './run-store.js';
import { createWorkflowRunRouteJournal, WorkflowRunRoutingError } from './workflow-run-routing.js';
import {
  isWorkflowRunProjectionId,
  workflowRunReadDiagnostic,
  type WorkflowRunReadDiagnostic,
  type WorkflowRunProjectionBackend,
} from './workflow-run-read-errors.js';

export type { WorkflowRunProjectionBackend } from './workflow-run-read-errors.js';

export type WorkflowRunProjectionLocation =
  | {
      state: 'found';
      backend: WorkflowRunProjectionBackend;
      runDir: string;
      diagnostics: WorkflowRunReadDiagnostic[];
    }
  | {
      state: 'missing' | 'invalid_id' | 'unreadable' | 'reconciliation_required';
      diagnostics: WorkflowRunReadDiagnostic[];
    };

/** Select evidence without initializing a journal or changing a recovery cache. */
export async function locateWorkflowRunProjection(
  workspaceRoot: string,
  runId: string,
  options: { evidenceSource?: WorkflowRunProjectionBackend } = {},
): Promise<WorkflowRunProjectionLocation> {
  // RunStore paths are directory names. Reject separators and Windows stream syntax.
  if (!isWorkflowRunProjectionId(runId)) {
    return {
      state: 'invalid_id',
      diagnostics: [{ scope: 'run', runId, code: 'WORKFLOW_RUN_PROJECTION_ID_INVALID' }],
    };
  }
  const path = (backend: WorkflowRunProjectionBackend) =>
    join(resolveWorkflowRunProjectionRoot(workspaceRoot, backend), 'runs', runId);
  const diagnostics: WorkflowRunReadDiagnostic[] = [];
  let route;
  try {
    route = await createWorkflowRunRouteJournal(workspaceRoot).locateReadOnly(runId);
  } catch (error) {
    diagnostics.push({
      scope: 'run',
      runId,
      code:
        error instanceof WorkflowRunRoutingError &&
        (error.code === 'WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE' ||
          error.code === 'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED')
          ? error.code
          : 'WORKFLOW_RUN_ROUTE_UNAVAILABLE',
    });
  }
  const exists = async (backend: WorkflowRunProjectionBackend) => {
    try {
      const entry = await lstat(path(backend));
      if (entry.isDirectory() && !entry.isSymbolicLink()) return true;
      diagnostics.push({
        scope: 'run',
        runId,
        backend,
        code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
      });
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      diagnostics.push(workflowRunReadDiagnostic(error, { scope: 'run', runId, backend }));
      return false;
    }
  };
  const [typescript, go] = await Promise.all([exists('ts-local'), exists('go')]);
  const present = (backend: WorkflowRunProjectionBackend) => (backend === 'go' ? go : typescript);
  const found = (backend: WorkflowRunProjectionBackend): WorkflowRunProjectionLocation => ({
    state: 'found',
    backend,
    runDir: path(backend),
    diagnostics,
  });
  if (options.evidenceSource) {
    if (present(options.evidenceSource)) return found(options.evidenceSource);
    return {
      state: diagnostics.length ? 'unreadable' : 'missing',
      diagnostics: diagnostics.length
        ? diagnostics
        : [
            {
              scope: 'run',
              runId,
              backend: options.evidenceSource,
              code: 'WORKFLOW_RUN_PROJECTION_MISSING',
            },
          ],
    };
  }
  if (route) {
    const backend = route.receipt.route.backend;
    if (present(backend)) return found(backend);
    diagnostics.push({
      scope: 'run',
      runId,
      backend,
      code: 'WORKFLOW_RUN_ROUTED_PROJECTION_MISSING',
    });
  }
  if (typescript && go)
    return {
      state: 'reconciliation_required',
      diagnostics: [
        ...diagnostics,
        { scope: 'run', runId, code: 'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED' },
      ],
    };
  if (!typescript && !go)
    return { state: diagnostics.length ? 'unreadable' : 'missing', diagnostics };
  const backend = go ? 'go' : 'ts-local';
  if (go && !route)
    diagnostics.push({ scope: 'run', runId, backend, code: 'WORKFLOW_RUN_UNROUTED_GO_PROJECTION' });
  return found(backend);
}

export function resolveWorkflowRunProjectionRoot(
  workspaceRoot: string,
  backend: WorkflowRunProjectionBackend,
): string {
  return join(
    workspaceRoot,
    '.openslack.local',
    'workflows',
    ...(backend === 'go' ? ['go-recovery-projections'] : []),
  );
}

export type WorkflowRunReadOnlyStore = Pick<
  RunStore,
  | 'getRunStatus'
  | 'listRunsByStatus'
  | 'loadAgentReplayInput'
  | 'loadAgentResult'
  | 'loadBudgetSnapshot'
  | 'loadCheckpointControl'
  | 'loadMeta'
  | 'loadOutput'
  | 'loadPendingApprovals'
  | 'loadPhaseCheckpoint'
  | 'loadPipelineItem'
  | 'loadStatus'
  | 'readAuditRecords'
  | 'readLog'
  | 'runExists'
>;

/**
 * Open historical TypeScript evidence or a Go recovery projection without a
 * mutation capability. The returned surface cannot initialize or advance a
 * workflow run.
 */
export function openWorkflowRunReadOnly(
  workspaceRoot: string,
  backend: WorkflowRunProjectionBackend,
): WorkflowRunReadOnlyStore {
  return new RunStore({
    baseDir: resolveWorkflowRunProjectionRoot(workspaceRoot, backend),
    access: 'read-only',
  });
}
