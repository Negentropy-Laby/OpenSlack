import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { RunStore } from './run-store.js';
import { assertWorkflowEvidencePath } from './internal/workflow-evidence-file.js';
import {
  assertNoWindowsReparseComponents,
  productionJournalSecurity,
} from './workflow-control-shadow.js';
import { createWorkflowRunRouteJournal, WorkflowRunRoutingError } from './workflow-run-routing.js';
import {
  isWorkflowRunProjectionId,
  primaryWorkflowRunReadCode,
  type WorkflowRunReadCode,
  type WorkflowRunReadProvenance,
  WorkflowRunReadError,
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
      provenance: WorkflowRunReadProvenance;
      degraded: boolean;
    }
  | {
      state: 'missing' | 'invalid_id' | 'unreadable' | 'reconciliation_required';
      primaryCode: WorkflowRunReadCode;
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
    const diagnostics: WorkflowRunReadDiagnostic[] = [];
    try {
      const directory = join(resolveWorkflowRunProjectionRoot(this.rootDir, backend), 'runs');
      await assertWorkflowEvidencePath(directory, { scope: 'backend', backend });
      const entries = await readdir(directory, { withFileTypes: true });
      return { names: entries.filter((entry) => {
        if (entry.isSymbolicLink()) {
          diagnostics.push({ scope: 'run', runId: entry.name, backend, code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID' });
          return false;
        }
        return entry.isDirectory();
      }).map((entry) => entry.name), diagnostics };
    } catch (error) {
      return { names: [], diagnostics: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? [] : [workflowRunReadDiagnostic(error, { scope: 'backend', backend })] };
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
  const identities = new Map<WorkflowRunProjectionBackend, { dev: bigint; ino: bigint }>();
  const probe = async (
    backend: WorkflowRunProjectionBackend,
  ): Promise<'present' | 'missing' | 'unreadable'> => {
    try {
      await assertWorkflowEvidencePath(path(backend), { scope: 'run', runId, backend });
      const entry = await lstat(path(backend), { bigint: true });
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        identities.set(backend, { dev: entry.dev, ino: entry.ino });
        return 'present';
      }
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
  const found = (backend: WorkflowRunProjectionBackend, selection: WorkflowRunReadProvenance['selection']): WorkflowRunProjectionLocation => {
    const location: FoundLocation = Object.freeze({
      state: 'found', backend, runDir: path(backend), diagnostics,
      provenance: { backend, selection, authorityVerified: false as const },
      degraded: selection === 'comparison' || selection === 'explicit',
    });
    locationIdentity.set(location, identities.get(backend)!);
    return location;
  };
  const unavailable = (
    state: Exclude<WorkflowRunProjectionLocation['state'], 'found'>,
    primaryCode = primaryWorkflowRunReadCode(diagnostics),
    backend?: WorkflowRunProjectionBackend,
  ): WorkflowRunProjectionLocation => {
    if (!diagnostics.some((diagnostic) => diagnostic.code === primaryCode))
      diagnostics.push({ scope: 'run', runId, ...(backend ? { backend } : {}), code: primaryCode });
    return { state, primaryCode, diagnostics };
  };
  if (evidenceSource) {
    const selected = await probe(evidenceSource);
    if (selected === 'present') return found(evidenceSource, 'explicit');
    return selected === 'missing'
      ? unavailable('missing', 'WORKFLOW_RUN_PROJECTION_MISSING', evidenceSource)
      : unavailable('unreadable');
  }
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
