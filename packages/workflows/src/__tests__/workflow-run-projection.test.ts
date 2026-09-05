import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkflowRunProjectionStore,
  locateWorkflowRunProjection,
} from '../workflow-run-projection.js';
import {
  listWorkflowRuns,
  showWorkflowRun,
  renderWorkflowRun,
  renderWorkflowRuns,
} from '../workflow-runs.js';
import { getWorkflowRunProgress } from '../workflow-progress.js';
import { WorkflowRunRouter, createWorkflowRunRouteJournal } from '../workflow-run-routing.js';

const roots: string[] = [];
const HASH = 'a'.repeat(64);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-projection-'));
  roots.push(root);
  const seed = async (backend: 'go' | 'ts-local', runId: string) => {
    const store = createWorkflowRunProjectionStore(root, backend);
    await store.initRun(runId, {
      runId,
      workflowName: 'workflow.test',
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
    expect(runs.diagnostics).toEqual([
      { runId: 'run.same', code: 'WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED' },
    ]);
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
      workflowAllowlist: ['workflow.test'],
      runAllowlist: [],
      expiresAt: '2026-09-06T00:00:00.000Z',
    });
    await createWorkflowRunRouteJournal(root).commit(
      router.select({
        workspaceId: 'workspace.test',
        runId: 'run.routed',
        workflowId: 'workflow.test',
        workflowVersion: '1.0.0',
        workflowSourceHash: HASH,
        manifestHash: HASH,
        inputHash: HASH,
        correlationId: 'correlation.test',
        selectedAt: '2026-09-05T00:00:00.000Z',
      }),
    );
    expect(await locateWorkflowRunProjection(root, 'run.routed')).toMatchObject({ backend: 'go' });
    expect(await listWorkflowRuns({ rootDir: root })).toMatchObject([
      { runId: 'run.routed', status: 'paused' },
    ]);
  }, 30_000);
});
