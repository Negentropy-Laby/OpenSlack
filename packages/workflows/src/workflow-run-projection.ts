import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { RunStore } from './run-store.js';
import { createWorkflowRunRouteJournal } from './workflow-run-routing.js';

export type WorkflowRunProjectionBackend = 'ts-local' | 'go';

/** Select evidence without initializing a journal or changing a recovery cache. */
export async function locateWorkflowRunProjection(
  workspaceRoot: string,
  runId: string,
): Promise<{ backend: WorkflowRunProjectionBackend; runDir: string }> {
  // RunStore paths are directory names. Reject separators and Windows stream syntax.
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,255}$/u.test(runId)) {
    throw new Error('WORKFLOW_RUN_PROJECTION_ID_INVALID');
  }
  const path = (backend: WorkflowRunProjectionBackend) =>
    join(resolveWorkflowRunProjectionRoot(workspaceRoot, backend), 'runs', runId);
  const route = await createWorkflowRunRouteJournal(workspaceRoot).locateReadOnly(runId);
  if (route) {
    const backend = route.receipt.route.backend;
    return { backend, runDir: path(backend) };
  }
  const exists = async (backend: WorkflowRunProjectionBackend) => {
    try {
      return (await stat(path(backend))).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  };
  const [typescript, go] = await Promise.all([exists('ts-local'), exists('go')]);
  if (typescript && go) throw new Error('WORKFLOW_RUN_PROJECTION_RECONCILIATION_REQUIRED');
  const backend = go ? 'go' : 'ts-local';
  return { backend, runDir: path(backend) };
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

export function createWorkflowRunProjectionStore(
  workspaceRoot: string,
  backend: WorkflowRunProjectionBackend,
): RunStore {
  return new RunStore({ baseDir: resolveWorkflowRunProjectionRoot(workspaceRoot, backend) });
}
