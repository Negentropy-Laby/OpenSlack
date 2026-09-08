import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkflowRunReadQuery } from '../workflow-run-read-query.js';
import { createWorkflowRunRouteJournal, WorkflowRunRouteJournal } from '../workflow-run-routing.js';
import {
  resolveWorkflowRunProjectionRoot,
  WorkflowRunReadContext,
  openWorkflowRunReadOnly,
} from '../workflow-run-projection.js';
import { getWorkflowRunProgress } from '../workflow-progress.js';
import {
  withWorkflowReadValidation,
  workflowReadPathStat,
} from '../internal/workflow-read-path.js';
import {
  renderWorkflowRunReadDiagnostics,
  type WorkflowRunReadDiagnostic,
} from '../workflow-run-read-errors.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    ...Object.fromEntries(
      ['readdir', 'lstat', 'realpath', 'open', 'readFile'].map((name) => [
        name,
        vi.fn(actual[name as keyof typeof actual] as (...args: unknown[]) => unknown),
      ]),
    ),
  };
});
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof syncFs>();
  return {
    ...actual,
    ...Object.fromEntries(
      [
        'existsSync',
        'lstatSync',
        'openSync',
        'fstatSync',
        'readSync',
        'closeSync',
        'opendirSync',
      ].map((name) => [
        name,
        vi.fn(actual[name as keyof typeof actual] as (...args: unknown[]) => unknown),
      ]),
    ),
  };
});

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function seed(runCount: number, quarantineCount: number) {
  const root = await fs.mkdtemp(join(await fs.realpath(tmpdir()), 'workflow-read-query-'));
  roots.push(root);
  const journal = createWorkflowRunRouteJournal(root);
  await journal.initialize();
  const workflows = resolveWorkflowRunProjectionRoot(root, 'ts-local');
  for (let index = 0; index < runCount; index++) {
    const runId = `run.${index}`;
    const directory = join(workflows, 'runs', runId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(directory, 'meta.json'),
      JSON.stringify({
        runId,
        workflowName: 'workflow.test',
        mode: 'execute',
        manifestHash: 'a'.repeat(64),
        args: {},
        startedAt: '2026-09-05T00:00:00.000Z',
      }),
    );
    await fs.writeFile(
      join(directory, 'status.json'),
      JSON.stringify({
        runId,
        status: 'paused',
        updatedAt: '2026-09-05T00:00:00.000Z',
        phases: [],
      }),
    );
  }
  for (let index = 0; index < quarantineCount; index++) {
    await fs.writeFile(
      join(
        workflows,
        'routes',
        'quarantine',
        `${createHash('sha256').update(`other.${index}`).digest('hex')}.json.incident`,
      ),
      'unrelated quarantine evidence',
    );
  }
  return { root, workflows };
}

function fileCalls() {
  return Object.fromEntries(
    [
      ...['readdir', 'lstat', 'realpath', 'open', 'readFile'].map((name) => [
        name,
        fs[name as keyof typeof fs],
      ]),
      ...[
        'existsSync',
        'lstatSync',
        'openSync',
        'fstatSync',
        'readSync',
        'closeSync',
        'opendirSync',
      ].map((name) => [name, syncFs[name as keyof typeof syncFs]]),
    ].map(([name, method]) => [
      name,
      vi.mocked(method as ReturnType<typeof vi.fn>).mock.calls.length,
    ]),
  );
}

describe('one workflow read query', { timeout: 30_000 }, () => {
  it('limits shared component probes to one validation pass', async () => {
    const path = await fs.realpath(tmpdir());
    vi.mocked(fs.lstat).mockClear();
    await withWorkflowReadValidation(async () => {
      await workflowReadPathStat(path);
      await withWorkflowReadValidation(() => workflowReadPathStat(path));
    });
    expect(vi.mocked(fs.lstat)).toHaveBeenCalledTimes(1);
    await withWorkflowReadValidation(() => workflowReadPathStat(path));
    expect(vi.mocked(fs.lstat)).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['ENOENT', 'WORKFLOW_RUN_PROJECTION_MISSING'],
    ['EACCES', 'WORKFLOW_RUN_EVIDENCE_PERMISSION_DENIED'],
    ['EIO', 'WORKFLOW_RUN_EVIDENCE_IO_FAILED'],
  ])('normalizes cached directory %s failures and retains healthy results', async (errno, code) => {
    const { root, workflows } = await seed(2, 0),
      query = createWorkflowRunReadQuery(root);
    await query.list();
    const directory = join(workflows, 'runs', 'run.0');
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) === directory)
        throw Object.assign(new Error(`private ${directory}`), { code: errno });
      return actual.lstat(...args);
    }) as typeof fs.lstat);
    for (const read of [() => query.show('run.0'), () => query.progress('run.0')]) {
      const error = await read().catch((error) => error);
      expect(error).toMatchObject({
        code,
        diagnostics: [{ scope: 'run', runId: 'run.0', backend: 'ts-local', code }],
      });
      expect(error.message).not.toContain(directory);
    }
    const list = await query.list();
    expect(list.map((run) => run.runId)).toEqual(['run.1']);
    expect(list.diagnostics).toContainEqual({
      scope: 'run',
      runId: 'run.0',
      backend: 'ts-local',
      code,
    });
  });

  it('filters readable-run diagnostics while retaining unreadable runs with unknown status', async () => {
    const { root, workflows } = await seed(3, 0);
    const go = resolveWorkflowRunProjectionRoot(root, 'go');
    await fs.mkdir(go, { recursive: true });
    await fs.rename(join(workflows, 'runs'), join(go, 'runs'));
    const completedPath = join(go, 'runs', 'run.1', 'status.json');
    const completed = JSON.parse(await fs.readFile(completedPath, 'utf8'));
    completed.status = 'completed';
    await fs.writeFile(completedPath, JSON.stringify(completed));
    await fs.writeFile(join(go, 'runs', 'run.2', 'status.json'), '{');
    const query = createWorkflowRunReadQuery(root);
    const rows = await query.list({ status: 'paused' });
    expect(rows.map((run) => run.runId)).toEqual(['run.0']);
    expect(rows.diagnostics).toEqual(
      expect.arrayContaining([
        {
          scope: 'run',
          runId: 'run.0',
          backend: 'go',
          code: 'WORKFLOW_RUN_UNROUTED_GO_PROJECTION',
        },
        { scope: 'run', runId: 'run.2', backend: 'go', code: 'WORKFLOW_RUN_EVIDENCE_INVALID' },
      ]),
    );
    expect(rows.diagnostics.some((diagnostic) => diagnostic.runId === 'run.1')).toBe(false);
  });

  it('aggregates presentation reasons without losing machine identities or scopes', () => {
    const diagnostics: WorkflowRunReadDiagnostic[] = [
      { scope: 'run', runId: 'run.b', backend: 'go', code: 'WORKFLOW_RUN_EVIDENCE_INVALID' },
      { scope: 'run', runId: 'run.a', backend: 'go', code: 'WORKFLOW_RUN_EVIDENCE_INVALID' },
      { scope: 'run', runId: 'run.a', backend: 'go', code: 'WORKFLOW_RUN_EVIDENCE_INVALID' },
      { scope: 'backend', backend: 'go', code: 'WORKFLOW_RUN_EVIDENCE_INVALID' },
    ];
    const bytes = JSON.stringify(diagnostics);
    const rendered = renderWorkflowRunReadDiagnostics(diagnostics);
    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toContain('Runs "run.a", "run.b"');
    expect(rendered[1]).toContain('Backend go');
    expect(JSON.stringify(diagnostics)).toBe(bytes);
    expect(diagnostics).toHaveLength(4);
  });
  it.each([
    [4, 8],
    [12, 8],
    [12, 80],
  ])(
    'scans each root once for %i runs and %i quarantine entries',
    async (runCount, quarantineCount) => {
      const { root } = await seed(runCount, quarantineCount);
      const original = WorkflowRunRouteJournal.prototype.createReadOnlyQuery;
      const locate = vi.fn();
      vi.spyOn(WorkflowRunRouteJournal.prototype, 'createReadOnlyQuery').mockImplementation(
        function (this: WorkflowRunRouteJournal) {
          const reader = original.call(this);
          return {
            revision: reader.revision,
            locateReadOnly(runId) {
              locate(runId);
              return reader.locateReadOnly(runId);
            },
          };
        },
      );
      vi.clearAllMocks();
      const query = createWorkflowRunReadQuery(root);
      const lifecycleRuns = await query.list();
      const progressRuns = await query.list();
      expect(progressRuns).not.toBe(lifecycleRuns);
      expect(progressRuns).toEqual(lifecycleRuns);
      expect(progressRuns).toHaveLength(runCount);
      for (const run of progressRuns) {
        expect(
          await query.progress(run.runId, { loadWorkflowManifest: false, loadCostConfig: false }),
        ).toMatchObject({ runId: run.runId, status: 'paused' });
      }
      const metrics = fileCalls();
      expect(locate).toHaveBeenCalledTimes(runCount);
      const enumerated = vi.mocked(fs.readdir).mock.calls.map(([path]) => String(path));
      expect(enumerated.filter((path) => path.endsWith('quarantine'))).toHaveLength(1);
      // The absent Go root is checked without attempting an enumeration.
      expect(enumerated.filter((path) => path.endsWith('runs'))).toHaveLength(1);
      expect(metrics.open).toBe(runCount * 4);
      expect(metrics.readdir).toBe(2);
    },
  );

  it('refreshes quarantine and locations for a new query without changing journal files', async () => {
    const { root, workflows } = await seed(1, 0);
    const first = createWorkflowRunReadQuery(root);
    const initial = await first.list();
    expect(initial.diagnostics).toHaveLength(0);
    const name = `${createHash('sha256').update('openslack.workflow-run-route.journal.v1\0').update('run.0').digest('hex')}.json.incident`;
    const quarantine = join(workflows, 'routes', 'quarantine', name);
    await fs.writeFile(quarantine, 'retained incident');
    const next = await createWorkflowRunReadQuery(root).list();
    expect(next).toHaveLength(1);
    expect(next.diagnostics).toContainEqual({
      scope: 'run',
      runId: 'run.0',
      code: 'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
    });
    expect(await fs.readFile(quarantine, 'utf8')).toBe('retained incident');
    expect((await first.list()).diagnostics).toContainEqual({
      scope: 'run',
      runId: 'run.0',
      code: 'WORKFLOW_RUN_ROUTE_RECONCILIATION_REQUIRED',
    });
  });

  it('does not cache progress file contents and rejects a context from another workspace', async () => {
    const { root, workflows } = await seed(1, 0);
    const query = createWorkflowRunReadQuery(root);
    await query.list();
    const statusPath = join(workflows, 'runs', 'run.0', 'status.json');
    await fs.writeFile(statusPath, '{');
    await expect(query.progress('run.0', { strictRead: true })).rejects.toMatchObject({
      code: 'WORKFLOW_RUN_EVIDENCE_INVALID',
    });
    await expect(
      getWorkflowRunProgress('run.0', {
        rootDir: join(root, 'foreign'),
        readContext: new WorkflowRunReadContext(root),
      }),
    ).rejects.toThrow('workspace mismatch');
  });

  it.each(['directory', 'junction'] as const)(
    'rejects a cached location replaced by a different %s',
    async (replacement) => {
      const { root, workflows } = await seed(1, 0);
      const query = createWorkflowRunReadQuery(root);
      await query.list();
      const directory = join(workflows, 'runs', 'run.0');
      await fs.rename(directory, `${directory}.original`);
      if (replacement === 'junction') {
        const external = await fs.mkdtemp(join(tmpdir(), 'workflow-external-evidence-'));
        roots.push(external);
        await fs.cp(`${directory}.original`, external, { recursive: true });
        await fs.symlink(external, directory, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        await fs.cp(`${directory}.original`, directory, { recursive: true });
      }
      await fs.writeFile(
        join(directory, 'status.json'),
        JSON.stringify({
          runId: 'run.0',
          status: 'completed',
          updatedAt: '2026-09-05T01:00:00.000Z',
          phases: [],
        }),
      );
      await expect(query.show('run.0')).rejects.toMatchObject({
        code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
      });
      await expect(query.progress('run.0')).rejects.toMatchObject({
        code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
      });
    },
  );
  it('recovers a failed quarantine scan in the same query and accepts historical directory permissions', async () => {
    const { root, workflows } = await seed(2, 0);
    const directory = join(workflows, 'routes', 'quarantine');
    await fs.chmod(directory, 0o755);
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    let failed = false;
    vi.mocked(fs.readdir).mockImplementation((async (path: unknown, options: unknown) => {
      if (String(path) === directory && !failed) {
        failed = true;
        throw Object.assign(new Error('private'), { code: 'EACCES' });
      }
      return actual.readdir(path as string, options as never);
    }) as typeof fs.readdir);
    const query = createWorkflowRunReadQuery(root);
    const first = await query.list();
    expect(first).toHaveLength(2);
    expect(first.diagnostics.length).toBeGreaterThan(0);
    const next = await query.list();
    expect(next).toHaveLength(2);
    expect(next.diagnostics).toEqual([]);
    expect(await actual.readdir(directory)).toEqual([]);
  });

  it('retries a quarantine snapshot changed during enumeration', async () => {
    const { root, workflows } = await seed(1, 0);
    const directory = join(workflows, 'routes', 'quarantine');
    const actual = await vi.importActual<typeof fs>('node:fs/promises');
    let changed = false;
    vi.mocked(fs.readdir).mockClear();
    vi.mocked(fs.readdir).mockImplementation((async (path: unknown, options: unknown) => {
      const result = await actual.readdir(path as string, options as never);
      if (String(path) === directory && !changed) {
        changed = true;
        await fs.writeFile(
          join(directory, 'a'.repeat(64) + '.json.incident'),
          'unrelated retained evidence',
        );
      }
      return result;
    }) as typeof fs.readdir);
    const rows = await createWorkflowRunReadQuery(root).list();
    expect(rows).toHaveLength(1);
    expect(rows.diagnostics).toEqual([]);
    expect(
      vi.mocked(fs.readdir).mock.calls.filter(([path]) => String(path) === directory),
    ).toHaveLength(2);
  });

  it('invalidates a formerly unique selection when another backend gains a copy', async () => {
    const { root, workflows } = await seed(1, 0);
    const query = createWorkflowRunReadQuery(root);
    await query.list();
    const other = join(resolveWorkflowRunProjectionRoot(root, 'go'), 'runs', 'run.0');
    await fs.mkdir(other, { recursive: true });
    await fs.cp(join(workflows, 'runs', 'run.0'), other, { recursive: true });
    await expect(query.show('run.0')).rejects.toMatchObject({
      code: 'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED',
    });
  });

  it('retains old directory identity when a changed route invalidates the list', async () => {
    const { root, workflows } = await seed(2, 0);
    const query = createWorkflowRunReadQuery(root);
    await query.list();
    const path = join(workflows, 'runs', 'run.0');
    await fs.rename(path, path + '.original');
    await fs.cp(path + '.original', path, { recursive: true });
    await fs.writeFile(
      join(workflows, 'routes', 'quarantine', 'a'.repeat(64) + '.json.incident'),
      'unrelated',
    );
    const rows = await query.list();
    expect(rows.map((row) => row.runId)).toEqual(['run.1']);
    expect(rows.diagnostics).toContainEqual({
      scope: 'run',
      runId: 'run.0',
      backend: 'ts-local',
      code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
    });
  });

  it('returns independent filtered views with one underlying listing', async () => {
    const { root } = await seed(2, 0);
    const query = createWorkflowRunReadQuery(root);
    const first = await query.list({ status: 'paused' });
    const calls = vi.mocked(fs.readdir).mock.calls.length;
    first[0]!.workflowName = 'changed';
    first[0]!.phases.push({ phase: 'changed', status: 'failed', timestamp: 'changed' });
    first.diagnostics.push({ scope: 'workspace', code: 'WORKFLOW_RUN_EVIDENCE_IO_FAILED' });
    const next = await query.list({ status: 'paused' });
    expect(next[0]!.workflowName).toBe('workflow.test');
    expect(next[0]!.phases).toEqual([]);
    expect(next.diagnostics).toEqual([]);
    expect(await query.list({ status: 'completed' })).toHaveLength(0);
    expect(vi.mocked(fs.readdir).mock.calls.length).toBe(calls);
  });

  it('keeps the historical indexed order through the protected store facade', async () => {
    const { root, workflows } = await seed(3, 0);
    await fs.writeFile(join(workflows, 'runs', '.index'), 'run.2\nrun.0\n');
    const rows = await openWorkflowRunReadOnly(root, 'ts-local').listRunsByStatus('paused');
    expect(rows.map((row) => row.runId)).toEqual(['run.2', 'run.0']);
  });

  it('guards every facade read and keeps its internal credentials immutable and nonpublic', async () => {
    const { root, workflows } = await seed(1, 0);
    const context = new WorkflowRunReadContext(root);
    const location = await context.locate('run.0', 'ts-local');
    expect(location.state).toBe('found');
    if (location.state !== 'found') return;
    expect(Object.isFrozen(location.readIdentity)).toBe(true);
    expect(Object.isFrozen(location.readSelection.namespaces)).toBe(true);
    expect(JSON.stringify(location)).not.toMatch(/readIdentity|readSelection|canonicalPath|cause/);
    const reader = openWorkflowRunReadOnly(root, 'ts-local', context);
    const path = join(workflows, 'runs', 'run.0');
    await fs.rename(path, path + '.original');
    await fs.cp(path + '.original', path, { recursive: true });
    for (const method of [
      'getRunStatus',
      'loadMeta',
      'loadStatus',
      'loadBudgetSnapshot',
      'loadCheckpointControl',
      'loadPendingApprovals',
      'readLog',
      'readAuditRecords',
      'runExists',
    ] as const)
      await expect(reader[method]('run.0')).rejects.toMatchObject({
        code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID',
      });
  });
});
