import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../run-store.js';
import { createWorkflowRunStoreRecoveryAccess } from '../internal/workflow-run-store-recovery-access.js';
import { readWorkflowEvidenceText } from '../internal/workflow-evidence-file.js';
import {
  locateWorkflowRunProjection,
  resolveWorkflowRunProjectionRoot,
} from '../workflow-run-projection.js';
import { WorkflowRunRouteJournal, WorkflowRunRoutingError } from '../workflow-run-routing.js';
import {
  WorkflowRunReadError,
  asWorkflowRunReadError,
  renderWorkflowRunReadError,
} from '../workflow-run-read-errors.js';
import { showWorkflowRun, listWorkflowRuns } from '../workflow-runs.js';
import { getWorkflowRunProgress } from '../workflow-progress.js';
import { saveWorkflowRunScript } from '../workflow-save.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const id = 'run.review';
async function fixture(backend: 'ts-local' | 'go' = 'ts-local') {
  const root = await fs.mkdtemp(join(tmpdir(), 'pr403-read-'));
  roots.push(root);
  const store = new RunStore({
    baseDir: resolveWorkflowRunProjectionRoot(root, backend),
    access: createWorkflowRunStoreRecoveryAccess(),
  });
  await store.initRun(id, {
    runId: id,
    workflowName: 'salvage-test',
    mode: 'execute',
    manifestHash: 'a'.repeat(64),
    args: {},
    startedAt: '2026-09-05T00:00:00.000Z',
  });
  return {
    root,
    store,
    directory: store.runDir(id),
    progress: () =>
      getWorkflowRunProgress(id, {
        rootDir: root,
        strictRead: true,
        loadWorkflowManifest: false,
        loadCostConfig: false,
      }),
  };
}
function route(backend: 'ts-local' | 'go') {
  const locateReadOnly = vi.fn().mockResolvedValue({ receipt: { route: { backend } } });
  vi.spyOn(WorkflowRunRouteJournal.prototype, 'createReadOnlyQuery').mockReturnValue({
    revision: async () => 'fixture',
    locateReadOnly,
  });
  return locateReadOnly;
}
describe('read correctness across evidence boundaries', () => {
  it('reports a non-directory agent result path with its run identity', async () => {
    const { root, directory, progress } = await fixture();
    await fs.rmdir(join(directory, 'agents'));
    await fs.writeFile(join(directory, 'agents'), 'invalid directory');
    const diagnostics = [
      { scope: 'run', runId: id, backend: 'ts-local', code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID' },
    ];
    await expect(progress()).rejects.toMatchObject({
      code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
      diagnostics,
    });
    expect(
      await getWorkflowRunProgress(id, {
        rootDir: root,
        loadWorkflowManifest: false,
        loadCostConfig: false,
      }),
    ).toMatchObject({ degraded: true, readDiagnostics: diagnostics });
  });

  it.each(['EACCES', 'EIO'])(
    'retains a nested %s read failure and its internal cause',
    async (errno) => {
      const { root, directory, progress } = await fixture();
      const path = join(directory, 'log.jsonl');
      await fs.writeFile(path, '');
      const original = await vi.importActual<typeof fs>('node:fs/promises');
      const cause = Object.assign(new Error('private cause'), { code: errno });
      vi.mocked(fs.open).mockImplementation(((file: string, flags: never, mode: never) => {
        if (String(file) === path) throw cause;
        return original.open(file, flags, mode);
      }) as typeof fs.open);
      const code =
        errno === 'EACCES'
          ? 'WORKFLOW_RUN_EVIDENCE_PERMISSION_DENIED'
          : 'WORKFLOW_RUN_EVIDENCE_IO_FAILED';
      await expect(progress()).rejects.toMatchObject({ code, cause });
      expect(
        await getWorkflowRunProgress(id, {
          rootDir: root,
          loadWorkflowManifest: false,
          loadCostConfig: false,
        }),
      ).toMatchObject({
        degraded: true,
        readDiagnostics: [{ scope: 'run', runId: id, backend: 'ts-local', code }],
      });
    },
  );
  it.each(['log.jsonl', 'agents/result.json'])(
    'preserves nested read codes and identities for %s in strict and partial progress',
    async (name) => {
      const { root, directory, progress } = await fixture();
      await fs.mkdir(join(directory, 'agents'), { recursive: true });
      await fs.writeFile(join(directory, name), Buffer.alloc(2 * 1024 * 1024 + 1, 32));
      const diagnostics = [
        { scope: 'run', runId: id, backend: 'ts-local', code: 'WORKFLOW_RUN_EVIDENCE_TOO_LARGE' },
      ];
      await expect(progress()).rejects.toMatchObject({
        code: 'WORKFLOW_RUN_EVIDENCE_TOO_LARGE',
        diagnostics,
      });
      expect(
        await getWorkflowRunProgress(id, {
          rootDir: root,
          loadWorkflowManifest: false,
          loadCostConfig: false,
        }),
      ).toMatchObject({ degraded: true, readDiagnostics: diagnostics });
    },
  );
  it('selects reconciliation over journal failure in either diagnostic order and retains context/cause', async () => {
    const { root } = await fixture();
    await fs.mkdir(join(resolveWorkflowRunProjectionRoot(root, 'go'), 'runs', id), {
      recursive: true,
    });
    vi.spyOn(WorkflowRunRouteJournal.prototype, 'createReadOnlyQuery').mockReturnValue({
      revision: async () => 'fixture',
      locateReadOnly: vi
        .fn()
        .mockRejectedValue(
          new WorkflowRunRoutingError('WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE', 'private cause'),
        ),
    });
    const location = await locateWorkflowRunProjection(root, id);
    expect(location).toMatchObject({
      state: 'reconciliation_required',
      primaryCode: 'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED',
    });
    for (const diagnostics of [location.diagnostics, [...location.diagnostics].reverse()]) {
      const cause = new Error('sensitive cause');
      const error = new WorkflowRunReadError(diagnostics, { cause });
      expect(error.code).toBe('WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED');
      expect(asWorkflowRunReadError(error, { scope: 'workspace' })).toBe(error);
      expect(error.cause).toBe(cause);
      expect(renderWorkflowRunReadError(error)).toContain('Use runs inspect');
      expect(renderWorkflowRunReadError(error)).toContain('WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE');
      expect(renderWorkflowRunReadError(error)).not.toContain('sensitive cause');
    }
  });

  it('does not probe an unrelated unsafe copy with a valid route or an explicit missing source', async () => {
    const { root, directory } = await fixture('go');
    const foreign = join(resolveWorkflowRunProjectionRoot(root, 'ts-local'), 'runs', id);
    await fs.mkdir(join(foreign, '..'), { recursive: true });
    await fs.symlink(directory, foreign, process.platform === 'win32' ? 'junction' : 'dir');
    const journal = route('go');
    vi.mocked(fs.lstat).mockClear();
    expect(await locateWorkflowRunProjection(root, id)).toMatchObject({
      state: 'found',
      provenance: { backend: 'go', selection: 'routed' },
      degraded: false,
      diagnostics: [],
    });
    expect(vi.mocked(fs.lstat).mock.calls.some(([path]) => String(path) === foreign)).toBe(false);
    journal.mockClear();
    await fs.rm(directory, { recursive: true });
    expect(await locateWorkflowRunProjection(root, id, { evidenceSource: 'go' })).toMatchObject({
      state: 'missing',
      primaryCode: 'WORKFLOW_RUN_PROJECTION_MISSING',
      diagnostics: [{ backend: 'go' }],
    });
    expect(journal).not.toHaveBeenCalled();
  });

  it('does not infer uniqueness when the other backend is unreadable', async () => {
    const { root } = await fixture();
    const foreign = join(resolveWorkflowRunProjectionRoot(root, 'go'), 'runs', id);
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.lstat).mockImplementation(((path: string, options: never) => {
      if (String(path) === resolveWorkflowRunProjectionRoot(root, 'go'))
        throw Object.assign(new Error('private path'), { code: 'EACCES' });
      return actual.lstat(path, options);
    }) as typeof fs.lstat);
    expect(await locateWorkflowRunProjection(root, id)).toMatchObject({
      state: 'reconciliation_required',
      primaryCode: 'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED',
      diagnostics: expect.arrayContaining([
        { scope: 'run', runId: id, backend: 'go', code: 'WORKFLOW_RUN_EVIDENCE_PERMISSION_DENIED' },
      ]),
    });
    expect(foreign).toContain(id);
  });

  it('lists unsafe directory links with run identity while retaining healthy runs; direct reads agree', async () => {
    const { root, directory } = await fixture();
    const link = join(directory, '..', 'run.link');
    await fs.symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
    const list = await listWorkflowRuns({ rootDir: root });
    expect(list.map((run) => run.runId)).toEqual([id]);
    expect(list.diagnostics).toContainEqual({
      scope: 'run',
      runId: 'run.link',
      backend: 'ts-local',
      code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
    });
    await expect(showWorkflowRun('run.link', { rootDir: root })).rejects.toMatchObject({
      code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
    });
  });

  it.each([256 * 1024 - 1, 256 * 1024, 256 * 1024 + 1, 2 * 1024 * 1024])(
    'reads a valid %i-byte local status consistently without rewriting it',
    async (size) => {
      const { root, store, progress } = await fixture();
      const status = (await store.loadStatus(id))!;
      status.phases = [
        { phase: 'phase-0', status: 'completed', timestamp: status.updatedAt, result: '' },
      ];
      status.phases[0]!.result = 'x'.repeat(size - Buffer.byteLength(JSON.stringify(status)));
      const raw = JSON.stringify(status);
      expect(Buffer.byteLength(raw)).toBe(size);
      await fs.writeFile(store.statusPath(id), raw);
      expect(await showWorkflowRun(id, { rootDir: root })).toMatchObject({ runId: id });
      expect(await progress()).toMatchObject({ runId: id });
      expect(await fs.readFile(store.statusPath(id), 'utf8')).toBe(raw);
    },
  );

  it.each(['oversize', 'utf8', 'json'] as const)(
    'classifies %s identically in show and progress and preserves the evidence bytes',
    async (kind) => {
      const { root, store, progress } = await fixture();
      const bytes =
        kind === 'oversize'
          ? Buffer.alloc(2 * 1024 * 1024 + 1, 32)
          : kind === 'utf8'
            ? Buffer.from([0xc3, 0x28])
            : Buffer.from('{');
      await fs.writeFile(store.statusPath(id), bytes);
      const code =
        kind === 'oversize' ? 'WORKFLOW_RUN_EVIDENCE_TOO_LARGE' : 'WORKFLOW_RUN_EVIDENCE_INVALID';
      await expect(showWorkflowRun(id, { rootDir: root })).rejects.toMatchObject({ code });
      await expect(progress()).rejects.toMatchObject({ code });
      expect((await fs.readFile(store.statusPath(id))).equals(bytes)).toBe(true);
    },
  );

  it('rejects file replacement after the handle was opened', async () => {
    const { store } = await fixture();
    const path = store.metaPath(id);
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      const read = handle.read.bind(handle);
      vi.spyOn(handle, 'read').mockImplementationOnce((async (...readArgs: unknown[]) => {
        const value = await (read as (...args: unknown[]) => Promise<unknown>)(...readArgs);
        await fs.rename(path, `${path}.original`);
        await fs.writeFile(path, '{}');
        return value;
      }) as typeof handle.read);
      return handle;
    });
    await expect(readWorkflowEvidenceText(path)).rejects.toMatchObject({
      code: 'WORKFLOW_RUN_EVIDENCE_IO_FAILED',
    });
  });

  it('rejects stored identity mismatches even in non-strict progress', async () => {
    const { root, store } = await fixture();
    const value = JSON.parse(await fs.readFile(store.metaPath(id), 'utf8'));
    value.runId = 'run.other';
    await fs.writeFile(store.metaPath(id), JSON.stringify(value));
    await expect(
      getWorkflowRunProgress(id, { rootDir: root, strictRead: false }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_EVIDENCE_INVALID' });
  });

  it.each([undefined, id])(
    'salvages legacy metadata with identity %s and preserves its exact bytes',
    async (runId) => {
      const { root, store } = await fixture();
      const raw = JSON.stringify({
        workflowName: 'salvage-test',
        runId,
        mode: 'retired',
        startedAt: 'old',
        args: [],
        obsolete: { sourcePath: '../../untrusted' },
      });
      await fs.writeFile(store.metaPath(id), raw);
      const source = join(root, '.openslack', 'workflows');
      await fs.mkdir(source, { recursive: true });
      await fs.writeFile(
        join(source, 'salvage-test.mjs'),
        'export const meta = {name:"salvage-test",description:"Salvage",phases:[{title:"Read",detail:"Evidence"}]}; export default async function(){}',
      );
      // A concurrent, unrelated directory entry requires a new selection/read,
      // while the eventual script write must run only after a stable read.
      const actual = await vi.importActual<typeof fs>('node:fs/promises');
      vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        await fs.writeFile(join(store.runDir(id), 'concurrent-entry'), 'retained');
        return handle;
      });
      const result = await saveWorkflowRunScript(id, { rootDir: root, to: 'claude-project' });
      expect(result).toMatchObject({
        workflowName: 'salvage-test',
        provenance: { selection: 'legacy' },
        readDiagnostics: [],
      });
      expect(await fs.readFile(store.metaPath(id), 'utf8')).toBe(raw);
    },
  );

  it.each([
    { workflowName: 'salvage-test', runId: 'other' },
    { workflowName: 'salvage-test', runId: null },
    {},
    { workflowName: '../bad' },
    { workflowName: '' },
  ])('rejects unusable salvage metadata %j', async (value) => {
    const { root, store } = await fixture();
    await fs.writeFile(store.metaPath(id), JSON.stringify(value));
    await expect(
      saveWorkflowRunScript(id, { rootDir: root, to: 'claude-project' }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_EVIDENCE_INVALID' });
  });
});
