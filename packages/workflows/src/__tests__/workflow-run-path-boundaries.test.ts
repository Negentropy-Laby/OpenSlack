import { WorkflowRunnerResumeSourceStore } from '../internal/workflow-runner-resume-source.js';
import { resumeIntentFixture, recoveryView } from './workflow-recovery-fixtures.js';
import { describe, expect, it, vi } from 'vitest';
import { RunStore } from '../run-store.js';
import { checkResumable } from '../resume.js';
import {
  assertWorkflowRunPathId,
  workflowRunPathErrorCode,
  WorkflowRunReadError,
  WORKFLOW_RUN_READ_POLICIES,
} from '../workflow-run-read-errors.js';
import { repairWorkflowCheckpoints } from '../workflow-checkpoint-repair.js';
import { executeWorkflowRunnerV2AuthorityJob } from '../workflow-runner-worker.js';

describe('typed run path boundaries', () => {
  it.each(['run:x', 'con', 'aux.txt', 'run.'])(
    'diagnoses historical %s without changing its logical identity',
    (id) => {
      expect(workflowRunPathErrorCode(id, 'linux')).toBeUndefined();
      expect(workflowRunPathErrorCode(id, 'win32')).toBe('WORKFLOW_RUN_PLATFORM_UNSUPPORTED');
      expect(() => assertWorkflowRunPathId(id, { scope: 'run' }, 'win32')).toThrow(
        WorkflowRunReadError,
      );
      expect(WORKFLOW_RUN_READ_POLICIES.WORKFLOW_RUN_PLATFORM_UNSUPPORTED.status).toBe('blocked');
    },
  );
  it('guards ordinary store paths with a typed invalid-input error', () => {
    const store = new RunStore({ baseDir: '/unused', access: 'read-only' });
    expect(() => store.runDir('../foreign')).toThrow(WorkflowRunReadError);
  });
  it('contains runExists failures in the resume result', async () => {
    const cause = new WorkflowRunReadError([
      { scope: 'run', runId: 'run:x', code: 'WORKFLOW_RUN_PLATFORM_UNSUPPORTED' },
    ]);
    const result = await checkResumable(
      {
        runExists: async () => {
          throw cause;
        },
      } as never,
      'run:x',
      {} as never,
    );
    expect(result).toMatchObject({ canResume: false, cause });
  });
  it('preserves healthy indexed runs and scoped failures', async () => {
    const store = new RunStore({
      baseDir: '/unused',
      access: 'read-only',
      fs: { readFile: async () => 'run.good\n.DS_Store\nrun.bad' } as never,
    });
    vi.spyOn(store, 'loadMeta').mockImplementation(async (id) => {
      store.runDir(id);
      if (id === 'run.bad') throw Object.assign(new Error('private'), { code: 'EACCES' });
      return { runId: id, workflowName: 'test', mode: 'run', startedAt: 'now' } as never;
    });
    vi.spyOn(store, 'loadStatus').mockImplementation(async (id) => {
      store.runDir(id);
      return { status: 'paused', updatedAt: 'now' } as never;
    });
    const result = await store.listRunsByStatus('paused');
    expect(result.map((run) => run.runId)).toEqual(['run.good']);
    expect(result.diagnostics).toHaveLength(2);
    expect(Object.keys(result)).toContain('diagnostics');
    expect(JSON.stringify(result.diagnostics)).not.toContain('private');
  });
  it.runIf(process.platform === 'win32')(
    'refuses unrepresentable worker IDs before accessing a port or disk',
    async () => {
      const context = new Proxy(
        {},
        {
          get() {
            throw Error('port accessed');
          },
        },
      );
      await expect(
        executeWorkflowRunnerV2AuthorityJob(
          {} as never,
          {
            workflowRunId: 'run:x',
            authorityRoute: { backend: 'go', authority: 'workflow-control' },
          } as never,
          context as never,
          'Z:/must-not-exist',
          {} as never,
          {} as never,
        ),
      ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_PLATFORM_UNSUPPORTED' });
      const report = await repairWorkflowCheckpoints('run:x', {
        rootDir: 'Z:/must-not-exist',
      } as never);
      expect(report).toMatchObject({
        repairable: false,
        applied: false,
        diagnostics: ['WORKFLOW_RUN_PLATFORM_UNSUPPORTED'],
      });
      expect(report.actions.join(' ')).toContain('compatible platform');
    },
  );
});

it('preserves typed path failures through actual checkpoint loading and a committed-history probe', async () => {
  const store = new RunStore({ baseDir: '/unused', access: 'read-only' });
  await expect(store.loadCheckpointControl('../foreign')).rejects.toMatchObject({
    code: 'WORKFLOW_RUN_PROJECTION_ID_INVALID',
  });
  const fixture = resumeIntentFixture(0);
  const source = new WorkflowRunnerResumeSourceStore('/unused', fixture.target, {} as never, {
    readRecoveryEvidence: async () => ({
      ...recoveryView([fixture.frame]),
      bindings: [fixture.frame],
    }),
  });
  vi.spyOn(source, 'checkpointControlDir').mockImplementation(() => {
    throw new WorkflowRunReadError([
      { scope: 'run', runId: fixture.stage.runId, code: 'WORKFLOW_RUN_PLATFORM_UNSUPPORTED' },
    ]);
  });
  const result = await source.probe(fixture.stage);
  expect(result).toMatchObject({
    state: 'committed',
    readiness: { state: 'blocked', code: 'WORKFLOW_RUN_PLATFORM_UNSUPPORTED' },
  });
  expect(JSON.stringify(result)).not.toContain('use runs inspect and repair-checkpoints');
});

it('drains both reads before advancing a failed indexed run', async () => {
  const store = new RunStore({
    baseDir: '/unused',
    access: 'read-only',
    fs: {
      readFile: async () => Array.from({ length: 20 }, (_, i) => 'run.' + i).join('\n'),
    } as never,
  });
  let active = 0,
    maximum = 0;
  const read = async (fail: boolean) => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, fail ? 1 : 10));
      if (fail) throw new SyntaxError('invalid');
      return null;
    } finally {
      active--;
    }
  };
  vi.spyOn(store, 'loadMeta').mockImplementation(() => read(true));
  vi.spyOn(store, 'loadStatus').mockImplementation(() => read(false));
  const result = await store.listRunsByStatus('paused');
  expect(result.diagnostics).toHaveLength(20);
  expect(maximum).toBeLessThanOrEqual(8);
  expect(active).toBe(0);
});
