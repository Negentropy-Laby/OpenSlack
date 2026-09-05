import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import { RunStore, WORKFLOW_RUN_LIST_CONCURRENCY } from './run-store.js';
import {
  WorkflowReadPathContext,
  withValidatedWorkflowDirectory,
  withWorkflowReadValidation,
  type WorkflowDirectoryIdentity,
} from './internal/workflow-read-path.js';
import {
  readWorkflowEvidenceText,
  WORKFLOW_LOCAL_EVIDENCE_MAX_BYTES,
} from './internal/workflow-evidence-file.js';
import { createWorkflowRunRouteJournal, WorkflowRunRoutingError } from './workflow-run-routing.js';
import {
  primaryWorkflowRunReadCode,
  type WorkflowRunReadCode,
  type WorkflowRunReadProvenance,
  WorkflowRunReadError,
  asWorkflowRunReadError,
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
      provenance: WorkflowRunReadProvenance;
      degraded: boolean;
      /** Non-enumerable internal proof, omitted from public DTOs. */
      readonly readIdentity: WorkflowDirectoryIdentity;
      readonly readSelection: {
        readonly routeRevision?: string;
        readonly namespaces: ReadonlyArray<readonly [WorkflowRunProjectionBackend, string]>;
      };
    }
  | {
      state: 'missing' | 'invalid_id' | 'unreadable' | 'reconciliation_required';
      primaryCode: WorkflowRunReadCode;
      diagnostics: WorkflowRunReadDiagnostic[];
    };

type FoundLocation = Extract<WorkflowRunProjectionLocation, { state: 'found' }>;
const readScope = new AsyncLocalStorage<ReadonlyMap<string, FoundLocation>>();
class WorkflowReadSnapshotChanged extends WorkflowRunReadError {}
/** One immediate retry obtains a new proof; a changing filesystem stays diagnostic. */
export async function retryWorkflowRunRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof WorkflowReadSnapshotChanged)) throw error;
  }
  return read();
}

/** Cached routing is not permission to follow a replaced evidence directory. */
export async function verifyWorkflowRunProjectionLocation(
  runId: string,
  location: FoundLocation,
  paths = new WorkflowReadPathContext(),
): Promise<WorkflowDirectoryIdentity> {
  const scope = { scope: 'run' as const, runId, backend: location.backend };
  if (!location.readIdentity || location.readIdentity.path !== resolve(location.runDir))
    throw new WorkflowRunReadError([{ ...scope, code: 'WORKFLOW_RUN_EVIDENCE_INTERNAL_ERROR' }]);
  try {
    return await paths.verify(location.readIdentity, scope);
  } catch (error) {
    throw asWorkflowRunReadError(error, scope);
  }
}

/** Internal request state. It never grants a write capability or survives a refresh. */
export class WorkflowRunReadContext {
  readonly rootDir: string;
  readonly #routeReader;
  readonly paths = new WorkflowReadPathContext();
  readonly #locations = new Map<
    string,
    {
      runId: string;
      evidenceSource?: WorkflowRunProjectionBackend;
      revision: string;
      result: Promise<WorkflowRunProjectionLocation>;
    }
  >();
  readonly #memo = new Map<string, Promise<unknown>>();
  #generation = 0;
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

  async assertRoot(workspaceRoot: string): Promise<void> {
    if (this.rootDir === resolve(workspaceRoot)) return;
    const [expected, actual] = await Promise.all([
      this.paths.directory(this.rootDir, { scope: 'workspace' }),
      this.paths.directory(workspaceRoot, { scope: 'workspace' }),
    ]).catch(() => {
      throw new TypeError('Read query workspace mismatch.');
    });
    if (expected.dev !== actual.dev || expected.ino !== actual.ino)
      throw new TypeError('Read query workspace mismatch.');
  }

  async revision(runId: string, evidenceSource?: WorkflowRunProjectionBackend): Promise<string> {
    return evidenceSource ? 'explicit' : this.#routeReader.revision(runId);
  }

  async selectionUnchanged(runId: string, location: FoundLocation): Promise<boolean> {
    return withWorkflowReadValidation(() => this.#selectionUnchanged(runId, location));
  }

  async #selectionUnchanged(runId: string, location: FoundLocation): Promise<boolean> {
    const proof = location.readSelection;
    if (!proof) return false;
    if (proof.routeRevision !== undefined && proof.routeRevision !== (await this.revision(runId)))
      return false;
    for (const [backend, revision] of proof.namespaces)
      if (revision !== (await projectionNamespaceRevision(this.rootDir, backend, this.paths)))
        return false;
    return true;
  }

  #snapshotRevision: string | undefined;
  async refresh(): Promise<number> {
    return withWorkflowReadValidation(() => this.#refresh());
  }

  async #refresh(): Promise<number> {
    const parts: string[] = [];
    try {
      parts.push(await this.#routeReader.revision());
    } catch {
      parts.push('unreadable');
      this.#generation++;
    }
    for (const backend of ['ts-local', 'go'] as const) {
      const directory = join(resolveWorkflowRunProjectionRoot(this.rootDir, backend), 'runs');
      try {
        parts.push((await this.paths.directory(directory, { scope: 'backend', backend })).revision);
      } catch (error) {
        parts.push((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable');
      }
    }
    const revision = parts.join('|');
    if (this.#snapshotRevision !== undefined && this.#snapshotRevision !== revision) {
      this.#entries.clear();
      this.#generation++;
    }
    this.#snapshotRevision = revision;
    for (const entry of this.#locations.values()) {
      try {
        const previous = await entry.result;
        if (previous.state === 'found') {
          await verifyWorkflowRunProjectionLocation(entry.runId, previous, this.paths);
          if (
            (await this.revision(entry.runId, entry.evidenceSource)) === entry.revision &&
            (await this.selectionUnchanged(entry.runId, previous))
          )
            continue;
        }
      } catch {
        /* A failed proof invalidates the snapshot; the next read reports it. */
      }
      // Keep the old identity until locate verifies it, even after a route change.
      this.#entries.clear();
      this.#generation++;
    }
    return this.#generation;
  }

  memo<T>(key: string, read: () => Promise<T>): Promise<T> {
    let value = this.#memo.get(key);
    if (!value) {
      value = read();
      this.#memo.set(key, value);
      void value.catch(() => {
        if (this.#memo.get(key) === value) this.#memo.delete(key);
      });
    }
    return value as Promise<T>;
  }

  async locate(
    runId: string,
    evidenceSource?: WorkflowRunProjectionBackend,
  ): Promise<WorkflowRunProjectionLocation> {
    try {
      return await this.#locate(runId, evidenceSource);
    } catch (error) {
      throw asWorkflowRunReadError(error, { scope: 'run', runId, backend: evidenceSource });
    }
  }

  async #locate(
    runId: string,
    evidenceSource?: WorkflowRunProjectionBackend,
  ): Promise<WorkflowRunProjectionLocation> {
    const key = JSON.stringify([runId, evidenceSource]);
    // A failed probe is never cached; retain its scoped classification in locateProjection.
    let revision: string | undefined;
    try {
      revision = await this.revision(runId, evidenceSource);
    } catch {
      /* classified below */
    }
    const cached = this.#locations.get(key);
    if (cached) {
      const previous = await cached.result;
      if (previous.state === 'found') {
        const unchanged = await withWorkflowReadValidation(async () => {
          await verifyWorkflowRunProjectionLocation(runId, previous, this.paths);
          return cached.revision === revision && (await this.selectionUnchanged(runId, previous));
        });
        if (unchanged) return previous;
      }
    }
    if (cached) {
      this.#locations.delete(key);
      this.#generation++;
    }
    const result = (async () => {
      for (let attempt = 0; ; attempt++) {
        const value = await locateProjection(
          this.rootDir,
          runId,
          this.#routeReader,
          evidenceSource,
          this.paths,
          evidenceSource ? undefined : revision,
        );
        if (value.state !== 'found' || (await this.selectionUnchanged(runId, value))) return value;
        await verifyWorkflowRunProjectionLocation(runId, value, this.paths);
        if (attempt === 1)
          throw new WorkflowReadSnapshotChanged([
            { scope: 'run', runId, code: 'WORKFLOW_RUN_EVIDENCE_IO_FAILED' },
          ]);
        revision = await this.revision(runId, evidenceSource);
      }
    })();
    if (revision !== undefined) {
      const entry = { runId, evidenceSource, revision, result };
      this.#locations.set(key, entry);
      void result.then(
        (value) => {
          if (value.state === 'found')
            entry.revision = value.readSelection.routeRevision ?? entry.revision;
          if (
            value.state !== 'found' ||
            value.diagnostics.some((d) => d.code !== 'WORKFLOW_RUN_UNROUTED_GO_PROJECTION')
          )
            if (this.#locations.get(key) === entry) this.#locations.delete(key);
        },
        () => {
          if (this.#locations.get(key) === entry) this.#locations.delete(key);
        },
      );
    }
    return result;
  }

  entries(backend: WorkflowRunProjectionBackend) {
    let result = this.#entries.get(backend);
    if (!result) {
      result = this.#readEntries(backend);
      this.#entries.set(backend, result);
      void result.then(
        (value) => {
          if (value.diagnostics.length && this.#entries.get(backend) === result)
            this.#entries.delete(backend);
        },
        () => {
          if (this.#entries.get(backend) === result) this.#entries.delete(backend);
        },
      );
    }
    return result;
  }

  async #readEntries(backend: WorkflowRunProjectionBackend) {
    const diagnostics: WorkflowRunReadDiagnostic[] = [];
    try {
      const directory = join(resolveWorkflowRunProjectionRoot(this.rootDir, backend), 'runs');
      const before = await this.paths.directory(directory, { scope: 'backend', backend });
      const entries = await readdir(directory, { withFileTypes: true });
      const after = await this.paths.directory(directory, { scope: 'backend', backend });
      if (before.revision !== after.revision)
        throw new WorkflowRunReadError([
          { scope: 'backend', backend, code: 'WORKFLOW_RUN_EVIDENCE_IO_FAILED' },
        ]);
      return {
        names: entries
          .filter((entry) => {
            if (entry.isSymbolicLink()) {
              diagnostics.push({
                scope: 'run',
                runId: entry.name,
                backend,
                code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
              });
              return false;
            }
            return entry.isDirectory();
          })
          .map((entry) => entry.name),
        diagnostics,
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
  await context.assertRoot(workspaceRoot);
  return context.locate(runId, options.evidenceSource);
}

async function locateProjection(
  workspaceRoot: string,
  runId: string,
  routeReader: Pick<ReturnType<typeof createWorkflowRunRouteJournal>, 'locateReadOnly'>,
  evidenceSource?: WorkflowRunProjectionBackend,
  paths = new WorkflowReadPathContext(),
  routeRevision?: string,
): Promise<WorkflowRunProjectionLocation> {
  // RunStore paths are directory names. Reject separators and Windows stream syntax.
  if (!isWorkflowRunPathId(runId)) {
    return {
      state: 'invalid_id',
      primaryCode: 'WORKFLOW_RUN_PROJECTION_ID_INVALID',
      diagnostics: [{ scope: 'run', runId, code: 'WORKFLOW_RUN_PROJECTION_ID_INVALID' }],
    };
  }
  const path = (backend: WorkflowRunProjectionBackend) =>
    join(resolveWorkflowRunProjectionRoot(workspaceRoot, backend), 'runs', runId);
  const diagnostics: WorkflowRunReadDiagnostic[] = [];
  const identities = new Map<WorkflowRunProjectionBackend, WorkflowDirectoryIdentity>();
  const namespaces = new Map<WorkflowRunProjectionBackend, string>();
  const probe = async (
    backend: WorkflowRunProjectionBackend,
  ): Promise<'present' | 'missing' | 'unreadable'> => {
    return withWorkflowReadValidation(async () => {
      try {
        namespaces.set(backend, await projectionNamespaceRevision(workspaceRoot, backend, paths));
        identities.set(
          backend,
          await paths.directory(path(backend), { scope: 'run', runId, backend }),
        );
        return 'present';
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
        diagnostics.push(workflowRunReadDiagnostic(error, { scope: 'run', runId, backend }));
        return 'unreadable';
      }
    });
  };
  const found = (
    backend: WorkflowRunProjectionBackend,
    selection: WorkflowRunReadProvenance['selection'],
  ): WorkflowRunProjectionLocation => {
    const location = {
      state: 'found',
      backend,
      runDir: path(backend),
      diagnostics,
      provenance: { backend, selection, authorityVerified: false as const },
      degraded: selection === 'comparison' || selection === 'explicit',
    };
    Object.defineProperty(location, 'readIdentity', {
      value: identities.get(backend)!,
      enumerable: false,
    });
    Object.defineProperty(location, 'readSelection', {
      value: Object.freeze({
        routeRevision,
        namespaces: Object.freeze([...namespaces].map((entry) => Object.freeze(entry))),
      }),
      enumerable: false,
    });
    return Object.freeze(location) as FoundLocation;
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

async function projectionNamespaceRevision(
  root: string,
  backend: WorkflowRunProjectionBackend,
  paths: WorkflowReadPathContext,
): Promise<string> {
  try {
    return (
      await paths.directory(join(resolveWorkflowRunProjectionRoot(root, backend), 'runs'), {
        scope: 'backend',
        backend,
      })
    ).revision;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
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

/** One logical, possibly multi-file read. Nested store calls share the same proof. */
export async function withWorkflowRunRead<T>(
  runId: string,
  location: FoundLocation,
  read: () => Promise<T>,
  context?: WorkflowRunReadContext,
): Promise<T> {
  const key = resolve(location.runDir);
  const active = readScope.getStore();
  if (active?.get(key) === location) return read();
  const paths = context?.paths ?? new WorkflowReadPathContext();
  const checkSelection = async () => {
    if (context && !(await context.selectionUnchanged(runId, location)))
      throw new WorkflowReadSnapshotChanged([
        { scope: 'run', runId, backend: location.backend, code: 'WORKFLOW_RUN_EVIDENCE_IO_FAILED' },
      ]);
  };
  const before = await withWorkflowReadValidation(async () => {
    const identity = await verifyWorkflowRunProjectionLocation(runId, location, paths);
    await checkSelection();
    return identity;
  });
  const result = await readScope.run(new Map([...(active ?? []), [key, location]]), () =>
    withValidatedWorkflowDirectory(location.readIdentity, read),
  );
  const after = await withWorkflowReadValidation(async () => {
    const identity = await verifyWorkflowRunProjectionLocation(runId, location, paths);
    await checkSelection();
    return identity;
  });
  if (before.revision !== after.revision)
    throw new WorkflowReadSnapshotChanged([
      { scope: 'run', runId, backend: location.backend, code: 'WORKFLOW_RUN_EVIDENCE_IO_FAILED' },
    ]);
  return result;
}

/**
 * Open historical TypeScript evidence or a Go recovery projection without a
 * mutation capability. The returned surface cannot initialize or advance a
 * workflow run.
 */
export function openWorkflowRunReadOnly(
  workspaceRoot: string,
  backend: WorkflowRunProjectionBackend,
  context = new WorkflowRunReadContext(workspaceRoot),
): WorkflowRunReadOnlyStore {
  const store = new RunStore({
    baseDir: resolveWorkflowRunProjectionRoot(workspaceRoot, backend),
    access: 'read-only',
  });
  const methods = [
    'getRunStatus',
    'loadAgentReplayInput',
    'loadAgentResult',
    'loadBudgetSnapshot',
    'loadCheckpointControl',
    'loadMeta',
    'loadOutput',
    'loadPendingApprovals',
    'loadPhaseCheckpoint',
    'loadPipelineItem',
    'loadStatus',
    'readAuditRecords',
    'readLog',
    'runExists',
  ] as const;
  const reader = Object.fromEntries(
    methods.map((name) => [
      name,
      (runId: string, ...args: unknown[]) =>
        retryWorkflowRunRead(async () => {
          await context.assertRoot(workspaceRoot);
          if (!isWorkflowRunProjectionId(runId))
            throw new WorkflowRunReadError([
              { scope: 'run', runId, backend, code: 'WORKFLOW_RUN_PROJECTION_ID_INVALID' },
            ]);
          const key = join(
            resolveWorkflowRunProjectionRoot(context.rootDir, backend),
            'runs',
            runId,
          );
          const active = readScope.getStore()?.get(resolve(key));
          const location = active ?? (await context.locate(runId, backend));
          if (location.state === 'missing') {
            if (name === 'runExists') return false;
            return ['loadPendingApprovals', 'readAuditRecords', 'readLog'].includes(name)
              ? []
              : null;
          }
          if (location.state !== 'found')
            throw new WorkflowRunReadError(location.diagnostics, {
              primaryCode: location.primaryCode,
            });
          return withWorkflowRunRead(
            runId,
            location,
            () =>
              (store[name] as (...values: unknown[]) => Promise<unknown>).call(
                store,
                runId,
                ...args,
              ),
            context,
          );
        }),
    ]),
  ) as Omit<WorkflowRunReadOnlyStore, 'listRunsByStatus'>;
  return Object.freeze({
    ...reader,
    async listRunsByStatus(status) {
      await context.assertRoot(workspaceRoot);
      await context.refresh();
      const directory = join(resolveWorkflowRunProjectionRoot(context.rootDir, backend), 'runs');
      let names: string[] | undefined;
      try {
        const index = await readWorkflowEvidenceText(
          join(directory, '.index'),
          WORKFLOW_LOCAL_EVIDENCE_MAX_BYTES,
          { scope: 'backend', backend },
        );
        if (index) names = index.trim().split('\n').filter(Boolean);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (!names) {
        const entries = await context.entries(backend);
        if (entries.diagnostics.length) throw new WorkflowRunReadError(entries.diagnostics);
        names = entries.names;
      }
      const results = new Array<Awaited<ReturnType<RunStore['listRunsByStatus']>>[number] | null>(
        names.length,
      ).fill(null);
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(WORKFLOW_RUN_LIST_CONCURRENCY, names.length) }, async () => {
          while (cursor < names.length) {
            const index = cursor++,
              runId = names[index]!;
            results[index] = await retryWorkflowRunRead(async () => {
              const location = await context.locate(runId, backend);
              if (location.state === 'missing') return null;
              if (location.state !== 'found')
                throw new WorkflowRunReadError(location.diagnostics, {
                  primaryCode: location.primaryCode,
                });
              return withWorkflowRunRead(
                runId,
                location,
                async () => {
                  const [meta, st] = await Promise.all([
                    reader.loadMeta(runId),
                    reader.loadStatus(runId),
                  ]);
                  if (meta && st && st.status === status) {
                    if (meta.runId !== runId || st.runId !== runId)
                      throw new WorkflowRunReadError([
                        { scope: 'run', runId, backend, code: 'WORKFLOW_RUN_EVIDENCE_INVALID' },
                      ]);
                    return {
                      runId: meta.runId,
                      workflowName: meta.workflowName,
                      mode: meta.mode,
                      status,
                      startedAt: meta.startedAt,
                      updatedAt: st.updatedAt,
                    };
                  }
                  return null;
                },
                context,
              );
            });
          }
        }),
      );
      return results.filter((run): run is NonNullable<typeof run> => run !== null);
    },
  } satisfies WorkflowRunReadOnlyStore);
}
