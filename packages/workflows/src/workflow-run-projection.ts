import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { RunStore } from './run-store.js';
import {
  assertNoWindowsReparseComponents,
  productionJournalSecurity,
} from './workflow-control-shadow.js';
import { createWorkflowRunRouteJournal, WorkflowRunRoutingError } from './workflow-run-routing.js';
import {
  WorkflowRunReadError,
  workflowRunReadDiagnostic,
  type WorkflowRunReadDiagnostic,
  type WorkflowRunProjectionBackend,
} from './workflow-run-read-errors.js';
import { isWorkflowRunPathId } from './internal/workflow-run-identity.js';

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

type FoundLocation = Extract<WorkflowRunProjectionLocation, { state: 'found' }>;
const locationIdentity = new WeakMap<FoundLocation, { dev: bigint; ino: bigint }>();

/** Cached routing is not permission to follow a replaced evidence directory. */
export async function verifyWorkflowRunProjectionLocation(
  runId: string,
  location: FoundLocation,
): Promise<void> {
  try {
    await assertNoWindowsReparseComponents(location.runDir, productionJournalSecurity());
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new WorkflowRunReadError([
      {
        scope: 'run',
        runId,
        backend: location.backend,
        code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
      },
    ]);
  }
  const expected = locationIdentity.get(location);
  const before = await lstat(location.runDir, { bigint: true });
  const canonical = await realpath(location.runDir);
  const after = await lstat(location.runDir, { bigint: true });
  const normalize = (path: string) =>
    process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  if (
    !expected ||
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    before.dev !== expected.dev ||
    before.ino !== expected.ino ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    (process.platform !== 'win32' && normalize(canonical) !== normalize(location.runDir))
  ) {
    throw new WorkflowRunReadError([
      {
        scope: 'run',
        runId,
        backend: location.backend,
        code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
      },
    ]);
  }
}

/** Internal request state. It never grants a write capability or survives a refresh. */
export class WorkflowRunReadContext {
  readonly rootDir: string;
  readonly #routeReader;
  readonly #locations = new Map<string, Promise<WorkflowRunProjectionLocation>>();
  readonly #entries = new Map<
    WorkflowRunProjectionBackend,
    Promise<{
      names: string[];
      diagnostics: WorkflowRunReadDiagnostic[];
    }>
  >();

  constructor(workspaceRoot: string) {
    this.rootDir = resolve(workspaceRoot);
    this.#routeReader = createWorkflowRunRouteJournal(this.rootDir).createReadOnlyQuery();
  }

  assertRoot(workspaceRoot: string): void {
    if (this.rootDir !== resolve(workspaceRoot))
      throw new TypeError('Read query workspace mismatch.');
  }

  locate(
    runId: string,
    evidenceSource?: WorkflowRunProjectionBackend,
  ): Promise<WorkflowRunProjectionLocation> {
    const key = JSON.stringify([runId, evidenceSource]);
    let result = this.#locations.get(key);
    if (!result) {
      result = locateProjection(this.rootDir, runId, this.#routeReader, evidenceSource);
      this.#locations.set(key, result);
    }
    return result;
  }

  entries(backend: WorkflowRunProjectionBackend) {
    let result = this.#entries.get(backend);
    if (!result) {
      result = this.#readEntries(backend);
      this.#entries.set(backend, result);
    }
    return result;
  }

  async #readEntries(backend: WorkflowRunProjectionBackend) {
    try {
      const entries = await readdir(
        join(resolveWorkflowRunProjectionRoot(this.rootDir, backend), 'runs'),
        { withFileTypes: true },
      );
      return {
        names: entries
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
          .map((entry) => entry.name),
        diagnostics: [] as WorkflowRunReadDiagnostic[],
      };
    } catch (error) {
      return {
        names: [],
        diagnostics:
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? []
            : [workflowRunReadDiagnostic(error, { scope: 'backend', backend })],
      };
    }
  }
}

/** Select evidence without initializing a journal or changing a recovery cache. */
export async function locateWorkflowRunProjection(
  workspaceRoot: string,
  runId: string,
  options: {
    evidenceSource?: WorkflowRunProjectionBackend;
    readContext?: WorkflowRunReadContext;
  } = {},
): Promise<WorkflowRunProjectionLocation> {
  const context = options.readContext ?? new WorkflowRunReadContext(workspaceRoot);
  context.assertRoot(workspaceRoot);
  return context.locate(runId, options.evidenceSource);
}

async function locateProjection(
  workspaceRoot: string,
  runId: string,
  routeReader: Pick<ReturnType<typeof createWorkflowRunRouteJournal>, 'locateReadOnly'>,
  evidenceSource?: WorkflowRunProjectionBackend,
): Promise<WorkflowRunProjectionLocation> {
  // RunStore paths are directory names. Reject separators and Windows stream syntax.
  if (!isWorkflowRunPathId(runId)) {
    return {
      state: 'invalid_id',
      diagnostics: [{ scope: 'run', runId, code: 'WORKFLOW_RUN_PROJECTION_ID_INVALID' }],
    };
  }
  const path = (backend: WorkflowRunProjectionBackend) =>
    join(resolveWorkflowRunProjectionRoot(workspaceRoot, backend), 'runs', runId);
  const diagnostics: WorkflowRunReadDiagnostic[] = [];
  const identities = new Map<WorkflowRunProjectionBackend, { dev: bigint; ino: bigint }>();
  let route;
  try {
    route = await routeReader.locateReadOnly(runId);
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
      const entry = await lstat(path(backend), { bigint: true });
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        identities.set(backend, { dev: entry.dev, ino: entry.ino });
        return true;
      }
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
  const found = (backend: WorkflowRunProjectionBackend): WorkflowRunProjectionLocation => {
    const location: FoundLocation = Object.freeze({
      state: 'found',
      backend,
      runDir: path(backend),
      diagnostics,
    });
    locationIdentity.set(location, identities.get(backend)!);
    return location;
  };
  if (evidenceSource) {
    if (present(evidenceSource)) return found(evidenceSource);
    return {
      state: diagnostics.length ? 'unreadable' : 'missing',
      diagnostics: diagnostics.length
        ? diagnostics
        : [
            {
              scope: 'run',
              runId,
              backend: evidenceSource,
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
