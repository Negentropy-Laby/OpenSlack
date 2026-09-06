import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { RunStore } from './run-store.js';
import { assertWorkflowEvidencePath } from './internal/workflow-evidence-file.js';
import { createWorkflowRunRouteJournal, WorkflowRunRoutingError } from './workflow-run-routing.js';
import {
  isWorkflowRunProjectionId,
  workflowRunReadDiagnostic,
  primaryWorkflowRunReadCode,
  type WorkflowRunReadCode,
  type WorkflowRunReadProvenance,
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
      provenance: WorkflowRunReadProvenance;
      degraded: boolean;
    }
  | {
      state: 'missing' | 'invalid_id' | 'unreadable' | 'reconciliation_required';
      primaryCode: WorkflowRunReadCode;
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
      primaryCode: 'WORKFLOW_RUN_PROJECTION_ID_INVALID',
      diagnostics: [{ scope: 'run', runId, code: 'WORKFLOW_RUN_PROJECTION_ID_INVALID' }],
    };
  }
  const path = (backend: WorkflowRunProjectionBackend) =>
    join(resolveWorkflowRunProjectionRoot(workspaceRoot, backend), 'runs', runId);
  const diagnostics: WorkflowRunReadDiagnostic[] = [];
  const probe = async (
    backend: WorkflowRunProjectionBackend,
  ): Promise<'present' | 'missing' | 'unreadable'> => {
    try {
      await assertWorkflowEvidencePath(path(backend), { scope: 'run', runId, backend });
      const entry = await lstat(path(backend));
      if (entry.isDirectory() && !entry.isSymbolicLink()) return 'present';
      diagnostics.push({
        scope: 'run',
        runId,
        backend,
        code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
      });
      return 'unreadable';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      diagnostics.push(workflowRunReadDiagnostic(error, { scope: 'run', runId, backend }));
      return 'unreadable';
    }
  };
  const found = (
    backend: WorkflowRunProjectionBackend,
    selection: WorkflowRunReadProvenance['selection'],
  ): WorkflowRunProjectionLocation => ({
    state: 'found',
    backend,
    runDir: path(backend),
    diagnostics,
    provenance: { backend, selection, authorityVerified: false },
    degraded: selection === 'comparison' || selection === 'explicit',
  });
  const unavailable = (
    state: Exclude<WorkflowRunProjectionLocation['state'], 'found'>,
    primaryCode = primaryWorkflowRunReadCode(diagnostics),
    backend?: WorkflowRunProjectionBackend,
  ): WorkflowRunProjectionLocation => {
    if (!diagnostics.some((diagnostic) => diagnostic.code === primaryCode))
      diagnostics.push({ scope: 'run', runId, ...(backend ? { backend } : {}), code: primaryCode });
    return { state, primaryCode, diagnostics };
  };
  if (options.evidenceSource) {
    const selected = await probe(options.evidenceSource);
    if (selected === 'present') return found(options.evidenceSource, 'explicit');
    return selected === 'missing'
      ? unavailable('missing', 'WORKFLOW_RUN_PROJECTION_MISSING', options.evidenceSource)
      : unavailable('unreadable');
  }
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
  if (route) {
    const backend = route.receipt.route.backend;
    const selected = await probe(backend);
    if (selected === 'present') return found(backend, 'routed');
    if (selected === 'unreadable') return unavailable('unreadable');
    diagnostics.push({
      scope: 'run',
      runId,
      backend,
      code: 'WORKFLOW_RUN_ROUTED_PROJECTION_MISSING',
    });
    const other = backend === 'go' ? 'ts-local' : 'go';
    return (await probe(other)) === 'present'
      ? found(other, 'comparison')
      : unavailable('unreadable');
  }
  const [typescript, go] = await Promise.all([probe('ts-local'), probe('go')]);
  if (
    (typescript === 'present' && go !== 'missing') ||
    (go === 'present' && typescript !== 'missing')
  )
    return unavailable('reconciliation_required', 'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED');
  if (typescript !== 'present' && go !== 'present')
    return diagnostics.length
      ? unavailable('unreadable')
      : unavailable('missing', 'WORKFLOW_RUN_PROJECTION_MISSING');
  const backend = go === 'present' ? 'go' : 'ts-local';
  if (backend === 'go')
    diagnostics.push({ scope: 'run', runId, backend, code: 'WORKFLOW_RUN_UNROUTED_GO_PROJECTION' });
  return found(backend, diagnostics.length ? 'comparison' : 'legacy');
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
