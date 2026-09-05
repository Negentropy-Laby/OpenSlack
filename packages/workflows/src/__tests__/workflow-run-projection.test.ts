import * as fs from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  locateWorkflowRunProjection,
  resolveWorkflowRunProjectionRoot,
} from '../workflow-run-projection.js';
import { RunStore } from '../run-store.js';
import { createWorkflowRunStoreRecoveryAccess } from '../internal/workflow-run-store-recovery-access.js';
import {
  listWorkflowRuns,
  showWorkflowRun,
  renderWorkflowRun,
  renderWorkflowRuns,
} from '../workflow-runs.js';
import { getWorkflowRunProgress } from '../workflow-progress.js';
import {
  WorkflowRunRouter,
  WorkflowRunRouteJournal,
  WorkflowRunRoutingError,
  createWorkflowRunRouteJournal,
} from '../workflow-run-routing.js';
import { WorkflowRunReadError, workflowRunReadDiagnostic } from '../workflow-run-read-errors.js';
import { saveWorkflowRunScript } from '../workflow-save.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const roots: string[] = [];
const HASH = 'a'.repeat(64);
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-projection-'));
  roots.push(root);
  const seed = async (backend: 'go' | 'ts-local', runId: string) => {
    const store = new RunStore({
      baseDir: resolveWorkflowRunProjectionRoot(root, backend),
      access: createWorkflowRunStoreRecoveryAccess(),
    });
    await store.initRun(runId, {
      runId,
      workflowName: 'workflow-test',
      mode: 'execute',
      manifestHash: HASH,
      args: {},
      startedAt: '2026-09-05T00:00:00.000Z',
    });
    return store;
  };
  return { root, seed };
}

describe('workflow run evidence selection', () => {
  it('lists both roots and reads Go show/progress without creating route state', async () => {
    const { root, seed } = await fixture();
    await seed('ts-local', 'run.legacy');
    const store = await seed('go', 'run.go');
    await store.transitionStatus('run.go', 'paused');
    const statusBytes = await readFile(store.statusPath('run.go'), 'utf8');
    const runs = await listWorkflowRuns({ rootDir: root });
    expect(runs.map((run) => run.runId).sort()).toEqual(['run.go', 'run.legacy']);
    expect(
      (await listWorkflowRuns({ rootDir: root, status: 'paused' })).map((run) => run.runId),
    ).toEqual(['run.go']);
    const shown = await showWorkflowRun('run.go', { rootDir: root });
    expect(shown).toMatchObject({ status: 'paused', evidenceSource: 'go-recovery-projection' });
    expect(renderWorkflowRun(shown!)).toContain('local recovery snapshot');
    expect(renderWorkflowRuns(runs)).toContain('go-recovery-projection');
    const progress = await getWorkflowRunProgress('run.go', {
      rootDir: root,
      strictRead: true,
      loadWorkflowManifest: false,
      loadCostConfig: false,
    });
    expect(progress).toMatchObject({ runId: 'run.go', status: 'paused' });
    expect(progress?.warnings).toContain(
      'Go recovery projection: local snapshot only; inspect Workflow Control for the authoritative head.',
    );
    expect(await readFile(store.statusPath('run.go'), 'utf8')).toBe(statusBytes);
    expect(await readdir(join(root, '.openslack.local', 'workflows'))).not.toContain('routes');
  });

  it('rejects ambiguous unrouted copies and unsafe identifiers', async () => {
    const { root, seed } = await fixture();
    await seed('ts-local', 'run.same');
    await seed('go', 'run.same');
    await seed('go', 'run.healthy');
    const runs = await listWorkflowRuns({ rootDir: root });
    expect(runs.map((run) => run.runId)).toEqual(['run.healthy']);
    expect(runs.diagnostics).toContainEqual({
      scope: 'run',
      runId: 'run.same',
      code: 'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED',
    });
    expect(renderWorkflowRuns(runs)).toContain(
      '"run.same": WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED',
    );
    await expect(showWorkflowRun('run.same', { rootDir: root })).rejects.toThrow(
      'RECONCILIATION_REQUIRED',
    );
    await expect(getWorkflowRunProgress('../outside', { rootDir: root })).rejects.toThrow(
      'ID_INVALID',
    );
  });

  it('honors the durable Go route when a historical copy shares its ID', async () => {
    const { root, seed } = await fixture();
    await seed('ts-local', 'run.routed');
    const go = await seed('go', 'run.routed');
    await go.transitionStatus('run.routed', 'paused');
    const router = new WorkflowRunRouter({
      schema: 'openslack.workflow_run_routing_policy.v1',
      workspaceId: 'workspace.test',
      backend: 'go',
      routingEpoch: 21,
      authorityBuildHash: HASH,
      qualificationEnvironmentId: 'recovery.test',
      workflowAllowlist: ['workflow-test'],
      runAllowlist: [],
      expiresAt: '2026-09-06T00:00:00.000Z',
    });
    await createWorkflowRunRouteJournal(root).commit(
      router.select({
        workspaceId: 'workspace.test',
        runId: 'run.routed',
        workflowId: 'workflow-test',
        workflowVersion: '1.0.0',
        workflowSourceHash: HASH,
        manifestHash: HASH,
        inputHash: HASH,
        correlationId: 'correlation.test',
        selectedAt: '2026-09-05T00:00:00.000Z',
      }),
    );
    expect(await locateWorkflowRunProjection(root, 'run.routed')).toMatchObject({ backend: 'go' });
    expect([...(await listWorkflowRuns({ rootDir: root }))]).toMatchObject([
      { runId: 'run.routed', status: 'paused' },
    ]);
  }, 30_000);

  it('returns typed missing and invalid outcomes without creating journal state', async () => {
    const { root } = await fixture();
    expect(await locateWorkflowRunProjection(root, 'run.missing')).toEqual({
      state: 'missing',
      diagnostics: [],
    });
    for (const id of ['_x', '../x', 'x/y', 'x\\y', 'a'.repeat(257)]) {
      expect(await locateWorkflowRunProjection(root, id)).toMatchObject({ state: 'invalid_id' });
      await expect(showWorkflowRun(id, { rootDir: root })).rejects.toMatchObject({
        code: 'WORKFLOW_RUN_PROJECTION_ID_INVALID',
      });
    }
    expect(await locateWorkflowRunProjection(root, 'x:stream')).toMatchObject({
      state: process.platform === 'win32' ? 'invalid_id' : 'missing',
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('keeps historical evidence readable when the routed Go projection is missing', async () => {
    const { root, seed } = await fixture();
    await seed('ts-local', 'run.routed');
    const receipt = { receipt: { route: { backend: 'go' } } } as Awaited<
      ReturnType<WorkflowRunRouteJournal['locateReadOnly']>
    >;
    vi.spyOn(WorkflowRunRouteJournal.prototype, 'createReadOnlyQuery').mockReturnValue({
      locateReadOnly: vi.fn().mockResolvedValue(receipt),
    });
    const result = await showWorkflowRun('run.routed', { rootDir: root });
    expect(result).toMatchObject({
      evidenceSource: 'typescript-historical',
      readDiagnostics: [{ code: 'WORKFLOW_RUN_ROUTED_PROJECTION_MISSING' }],
    });
    expect(renderWorkflowRun(result!)).toContain('comparison evidence only');
    const progress = await getWorkflowRunProgress('run.routed', {
      rootDir: root,
      loadWorkflowManifest: false,
    });
    expect(progress?.warnings.join('\n')).toContain('WORKFLOW_RUN_ROUTED_PROJECTION_MISSING');
    expect(await readdir(join(root, '.openslack.local', 'workflows'))).not.toContain('routes');
  });

  it('preserves a healthy backend and classifies a directory permission failure', async () => {
    const { root, seed } = await fixture();
    await seed('go', 'run.healthy');
    vi.mocked(readdir).mockRejectedValueOnce(
      Object.assign(new Error('private path'), { code: 'EACCES' }),
    );
    const result = await listWorkflowRuns({ rootDir: root });
    expect(result.map((run) => run.runId)).toEqual(['run.healthy']);
    expect(result.diagnostics).toContainEqual({
      scope: 'backend',
      backend: 'ts-local',
      code: 'WORKFLOW_RUN_EVIDENCE_PERMISSION_DENIED',
    });
    expect(renderWorkflowRuns(result)).not.toContain('private path');
    expect(Object.keys(result)).toContain('diagnostics');
    expect(
      JSON.parse(JSON.stringify({ runs: result, diagnostics: result.diagnostics })).diagnostics,
    ).toHaveLength(result.diagnostics.length);
  });

  it('distinguishes invalid directory roots and corrupt run evidence from ambiguity', async () => {
    const { root, seed } = await fixture();
    const corrupt = await seed('go', 'run.corrupt');
    await seed('go', 'run.healthy');
    await writeFile(corrupt.statusPath('run.corrupt'), '{');
    await writeFile(
      join(resolveWorkflowRunProjectionRoot(root, 'ts-local'), 'runs'),
      'not a directory',
    );
    const result = await listWorkflowRuns({ rootDir: root });
    expect(result.map((run) => run.runId)).toEqual(['run.healthy']);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        { scope: 'backend', backend: 'ts-local', code: 'WORKFLOW_RUN_EVIDENCE_PATH_INVALID' },
        { scope: 'run', runId: 'run.corrupt', code: 'WORKFLOW_RUN_EVIDENCE_INVALID' },
      ]),
    );
    expect(
      workflowRunReadDiagnostic(new TypeError('reader defect'), { scope: 'workspace' }).code,
    ).toBe('WORKFLOW_RUN_EVIDENCE_INTERNAL_ERROR');
  });

  it('retains single-copy evidence and the journal ownership diagnostic', async () => {
    const { root, seed } = await fixture();
    await seed('ts-local', 'run.backup');
    vi.spyOn(WorkflowRunRouteJournal.prototype, 'createReadOnlyQuery').mockReturnValue({
      locateReadOnly: vi
        .fn()
        .mockRejectedValue(
          new WorkflowRunRoutingError('WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE', 'unsafe owner'),
        ),
    });
    const run = await showWorkflowRun('run.backup', { rootDir: root });
    expect(run?.readDiagnostics).toContainEqual({
      scope: 'run',
      runId: 'run.backup',
      code: 'WORKFLOW_RUN_ROUTE_JOURNAL_UNSAFE',
    });
  });

  it('salvages complete metadata only after explicitly selecting conflicting evidence', async () => {
    const { root, seed } = await fixture();
    await seed('ts-local', 'run.salvage');
    await seed('go', 'run.salvage');
    const sourceDir = join(root, '.openslack', 'workflows');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      join(sourceDir, 'workflow-test.mjs'),
      'export const meta = { name: "workflow-test", description: "Recovery", phases: [{title: "Recover", detail: "Read evidence"}] }; export default async function () {}',
    );
    await expect(
      saveWorkflowRunScript('run.salvage', { rootDir: root, to: 'claude-project' }),
    ).rejects.toBeInstanceOf(WorkflowRunReadError);
    const result = await saveWorkflowRunScript('run.salvage', {
      rootDir: root,
      to: 'claude-project',
      evidenceSource: 'ts-local',
    });
    expect(result.sourceRunId).toBe('run.salvage');
    expect(await readFile(result.path, 'utf8')).toContain('Recovery');
  });
});
