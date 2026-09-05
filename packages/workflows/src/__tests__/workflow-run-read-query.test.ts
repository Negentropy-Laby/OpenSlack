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
} from '../workflow-run-projection.js';
import { getWorkflowRunProgress } from '../workflow-progress.js';

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
  const root = await fs.mkdtemp(join(tmpdir(), 'workflow-read-query-'));
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
            locateReadOnly(runId) {
              locate(runId);
              return reader.locateReadOnly(runId);
            },
          };
        },
      );
      vi.clearAllMocks();
      const start = performance.now();
      const query = createWorkflowRunReadQuery(root);
      const lifecycleRuns = await query.list();
      const progressRuns = await query.list();
      expect(progressRuns).toBe(lifecycleRuns);
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
      expect(enumerated.filter((path) => path.endsWith('runs'))).toHaveLength(2);
      console.log(
        'WORKFLOW_READ_QUERY_MEASUREMENT',
        JSON.stringify({
          platform: process.platform,
          runCount,
          quarantineCount,
          milliseconds: Math.round(performance.now() - start),
          fileApiCalls: metrics,
        }),
      );
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
    expect(await first.list()).toBe(initial);
  });

  it('does not cache progress file contents and rejects a context from another workspace', async () => {
    const { root, workflows } = await seed(1, 0);
    const query = createWorkflowRunReadQuery(root);
    await query.list();
    const statusPath = join(workflows, 'runs', 'run.0', 'status.json');
    await fs.writeFile(statusPath, '{');
    await expect(query.progress('run.0', { strictRead: true })).rejects.toMatchObject({
      code: 'WORKFLOW_PROGRESS_LOCAL_EVIDENCE_INVALID',
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
});
