import { join } from 'node:path';

import { RunStore } from './run-store.js';

export type WorkflowRunProjectionBackend = 'ts-local' | 'go';

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
