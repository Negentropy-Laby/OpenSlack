import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkflowBudgetExceededError,
  WorkflowBudgetPausedError,
  computeAgentCacheKey,
} from '../agent-shim.js';
import {
  executeResume,
  executeResumeWithStore,
  executeRun,
  executeRunWithStore,
  WorkflowRunInputInvalidError,
} from '../execute.js';
import { WorkflowPausedError } from '../runtime.js';
import { RunStore } from '../run-store.js';
import type { WorkflowMeta, WorkflowModule, WorkflowRuntime } from '../types.js';

const roots: string[] = [];
const manifest: WorkflowMeta = {
  name: 'resume-budget-test',
  version: '1.0.0',
  description: 'Cumulative resume budget test.',
  phases: [{ title: 'Run', detail: 'Run provider calls.' }],
  risk: 'low',
};

function workflowHash(): string {
  return 'a'.repeat(64);
}

function makeWorkflow(run: NonNullable<WorkflowModule['run']>): WorkflowModule {
  return { meta: manifest, format: 'openslack-native', hash: workflowHash(), run };
}

async function setupRun(
  options: {
    runId?: string;
    args?: Record<string, unknown>;
    budget?: { tokens: number; costUsd: number };
    usage?: { tokensUsed: number; tokensRemaining: number; costUsd: number; agentCalls: number };
    manifestHash?: string;
    status?:
      | 'running'
      | 'paused'
      | 'paused_waiting_approval'
      | 'resuming'
      | 'completed'
      | 'failed'
      | 'cancelled';
  } = {},
) {
  const rootDir = await mkdtemp(join(tmpdir(), 'openslack-resume-budget-'));
  roots.push(rootDir);
  const runId = options.runId ?? 'run.resume.budget';
  const budget = options.budget ?? { tokens: 100, costUsd: 1 };
  const store = new RunStore({ baseDir: join(rootDir, '.openslack.local', 'workflows') });
  const requestedHash = options.manifestHash ?? workflowHash();
  const legacyIdentity = !/^[0-9a-f]{64}$/u.test(requestedHash);
  await store.initRun(runId, {
    runId,
    workflowName: manifest.name,
    mode: 'execute',
    manifestHash: legacyIdentity ? workflowHash() : requestedHash,
    args: options.args ?? { qualification: true },
    startedAt: '2026-08-11T00:00:00.000Z',
    budget,
  });
  if (legacyIdentity) {
    const path = store.metaPath(runId);
    const persisted = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
    persisted.manifestHash = requestedHash;
    delete persisted.argsEncoding;
    persisted.args = options.args ?? { qualification: true };
    await writeFile(path, JSON.stringify(persisted, null, 2), 'utf-8');
  }
  if (options.usage) await store.persistBudgetState(runId, options.usage);
  const status = options.status ?? 'paused';
  if (status !== 'running') await store.transitionStatus(runId, status);
  return { rootDir, runId, budget, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('strict cumulative workflow resume', () => {
  it.each([
    ['pause', WorkflowBudgetPausedError],
    ['fail', WorkflowBudgetExceededError],
  ] as const)(
    'commits cumulative usage before publishing the %s policy outcome',
    async (policy, ErrorType) => {
      const rootDir = await mkdtemp(join(tmpdir(), `openslack-budget-${policy}-`));
      roots.push(rootDir);
      const runId = `run.budget.${policy}`;
      const governedManifest: WorkflowMeta = {
        ...manifest,
        budgetPolicy: { tokenBudget: 5, onExceeded: policy },
      };
      const workflow: WorkflowModule = {
        meta: governedManifest,
        format: 'openslack-native',
        hash: workflowHash(),
        run: async (ctx) => {
          ctx.phase('Run');
          await ctx.agent('budget', { label: 'budget', phase: 'Run' });
          return { status: 'completed' };
        },
      };

      await expect(
        executeRun(workflow, {
          runId,
          manifest: governedManifest,
          budget: { tokens: 5, costUsd: 1 },
          agentLauncher: async () => ({ data: { ok: true }, tokenUsage: 5 }),
          allowUnattended: true,
          rootDir,
        }),
      ).rejects.toBeInstanceOf(ErrorType);

      const store = new RunStore({ baseDir: join(rootDir, '.openslack.local', 'workflows') });
      await expect(store.loadBudgetSnapshot(runId)).resolves.toMatchObject({
        usage: { tokensUsed: 5, tokensRemaining: 0, agentCalls: 1 },
      });
      await expect(store.loadStatus(runId)).resolves.toMatchObject({
        status: policy === 'pause' ? 'paused_waiting_approval' : 'failed',
      });
      const approvals = await store.loadPendingApprovals(runId);
      expect(approvals).toHaveLength(policy === 'pause' ? 1 : 0);
    },
  );

  it.each(['budget', 'approval'] as const)(
    'keeps the run failed when %s persistence prevents a durable pause',
    async (failure) => {
      const rootDir = await mkdtemp(join(tmpdir(), `openslack-budget-${failure}-failure-`));
      roots.push(rootDir);
      const runId = `run.budget.failure.${failure}`;
      const store = new RunStore({ baseDir: join(rootDir, '.openslack.local', 'workflows') });
      const governedManifest: WorkflowMeta = {
        ...manifest,
        budgetPolicy: { tokenBudget: 5, onExceeded: 'pause' },
      };
      const workflow: WorkflowModule = {
        meta: governedManifest,
        format: 'openslack-native',
        hash: workflowHash(),
        run: async (ctx) => {
          ctx.phase('Run');
          await ctx.agent('budget', { label: 'budget', phase: 'Run' });
          return { status: 'completed' };
        },
      };
      const failureError = new Error(`${failure} persistence failed`);
      if (failure === 'budget') {
        vi.spyOn(store, 'persistBudgetState').mockRejectedValue(failureError);
      } else {
        vi.spyOn(store, 'savePendingApproval').mockRejectedValue(failureError);
      }

      await expect(
        executeRunWithStore(
          workflow,
          {
            runId,
            manifest: governedManifest,
            budget: { tokens: 5, costUsd: 1 },
            agentLauncher: async () => ({ data: { ok: true }, tokenUsage: 5 }),
            allowUnattended: true,
            rootDir,
          },
          store,
        ),
      ).rejects.toBe(failureError);
      await expect(store.loadStatus(runId)).resolves.toMatchObject({ status: 'failed' });
      if (failure === 'budget') {
        await expect(store.loadPendingApprovals(runId)).resolves.toEqual([]);
      }
    },
  );

  it('preserves cache and cumulative usage across a legacy run-gate pause/resume cycle', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'openslack-pause-resume-budget-'));
    roots.push(rootDir);
    const runId = 'run.pause.resume.budget';
    const budget = { tokens: 100, costUsd: 1 };
    const launcher = vi.fn(async (_prompt: string, options: { label: string }) => ({
      data: { label: options.label },
      tokenUsage: options.label === 'call-a' ? 10 : 20,
    }));
    let admitCompletion = false;
    const workflow = makeWorkflow(async (ctx: WorkflowRuntime) => {
      ctx.phase('Run');
      await ctx.agent('prompt-a', { label: 'call-a', phase: 'Run' });
      if (!admitCompletion) {
        throw new WorkflowPausedError('legacy.run-gate', 'bounded resume test', runId);
      }
      await ctx.agent('prompt-b', { label: 'call-b', phase: 'Run' });
      return { status: 'completed' };
    });

    await expect(
      executeRun(workflow, {
        runId,
        manifest,
        args: { qualification: true },
        budget,
        agentLauncher: launcher,
        onConfirm: async () => true,
        rootDir,
      }),
    ).rejects.toBeInstanceOf(WorkflowPausedError);

    const store = new RunStore({ baseDir: join(rootDir, '.openslack.local', 'workflows') });
    await expect(store.loadStatus(runId)).resolves.toMatchObject({
      status: 'paused_waiting_approval',
    });
    await expect(
      executeResume(workflow, {
        runId,
        manifest,
        args: { qualification: true },
        budget,
        agentLauncher: launcher,
        onConfirm: async () => true,
        rootDir,
      }),
    ).rejects.toBeInstanceOf(WorkflowPausedError);
    admitCompletion = true;
    await executeResume(workflow, {
      runId,
      manifest,
      args: { qualification: true },
      budget,
      agentLauncher: launcher,
      onConfirm: async () => true,
      rootDir,
    });

    expect(launcher).toHaveBeenCalledTimes(2);
    await expect(store.loadBudgetSnapshot(runId)).resolves.toMatchObject({
      usage: { tokensUsed: 30, tokensRemaining: 70, agentCalls: 2 },
    });
    await expect(store.readAuditRecords(runId)).resolves.toEqual([]);
  });

  it('reuses cached calls without charging and charges new calls against prior usage', async () => {
    const { rootDir, runId, budget, store } = await setupRun({
      usage: { tokensUsed: 30, tokensRemaining: 70, costUsd: 1, agentCalls: 1 },
    });
    const cachedKey = computeAgentCacheKey(manifest.name, 'Run', 'call-a', 'prompt-a');
    await store.saveAgentResult(runId, cachedKey, { data: { call: 'a' }, tokenUsage: 30 });
    const launcher = vi.fn(async () => ({ data: { call: 'b' }, tokenUsage: 20 }));
    const workflow = makeWorkflow(async (ctx: WorkflowRuntime) => {
      ctx.phase('Run');
      const first = await ctx.agent('prompt-a', { label: 'call-a', phase: 'Run' });
      const second = await ctx.agent('prompt-b', { label: 'call-b', phase: 'Run' });
      return { status: 'completed', first, second };
    });

    await executeResume(workflow, {
      runId,
      manifest,
      args: { qualification: true },
      budget,
      agentLauncher: launcher,
      allowUnattended: true,
      rootDir,
    });

    expect(launcher).toHaveBeenCalledTimes(1);
    await expect(store.loadBudgetSnapshot(runId)).resolves.toMatchObject({
      usage: { tokensUsed: 50, tokensRemaining: 50, agentCalls: 2 },
    });
  });

  it('persists charged provider failures before the run fails', async () => {
    const { rootDir, runId, budget, store } = await setupRun({
      usage: { tokensUsed: 30, tokensRemaining: 70, costUsd: 1, agentCalls: 1 },
    });
    const providerError = Object.assign(new Error('provider unavailable'), { tokenUsage: 7 });
    const workflow = makeWorkflow(async (ctx: WorkflowRuntime) => {
      ctx.phase('Run');
      await ctx.agent('prompt-failure', { label: 'failure', phase: 'Run' });
      return { status: 'completed' };
    });

    await expect(
      executeResume(workflow, {
        runId,
        manifest,
        args: { qualification: true },
        budget,
        agentLauncher: async () => {
          throw providerError;
        },
        allowUnattended: true,
        rootDir,
      }),
    ).rejects.toBe(providerError);
    await expect(store.loadBudgetSnapshot(runId)).resolves.toMatchObject({
      usage: { tokensUsed: 37, tokensRemaining: 63, agentCalls: 2 },
    });
  });

  it('serializes parallel provider completions into one cumulative snapshot', async () => {
    const { rootDir, runId, budget, store } = await setupRun();
    const workflow = makeWorkflow(async (ctx: WorkflowRuntime) => {
      ctx.phase('Run');
      await Promise.all([
        ctx.agent('parallel-a', { label: 'parallel-a', phase: 'Run' }),
        ctx.agent('parallel-b', { label: 'parallel-b', phase: 'Run' }),
      ]);
      return { status: 'completed' };
    });
    await executeResume(workflow, {
      runId,
      manifest,
      args: { qualification: true },
      budget,
      agentLauncher: async (_prompt, options) => ({
        data: { label: options.label },
        tokenUsage: options.label === 'parallel-a' ? 11 : 19,
      }),
      allowUnattended: true,
      rootDir,
    });

    await expect(store.loadBudgetSnapshot(runId)).resolves.toMatchObject({
      usage: { tokensUsed: 30, tokensRemaining: 70, agentCalls: 2 },
    });
  });

  it('rejects missing runs and terminal states without reinitializing them', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'openslack-resume-missing-'));
    roots.push(rootDir);
    const workflow = makeWorkflow(async () => {
      return { status: 'completed' };
    });
    await expect(
      executeResume(workflow, {
        runId: 'missing',
        manifest,
        allowUnattended: true,
        rootDir,
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RESUME_RECOVERY_REQUIRED' });

    const terminal = await setupRun({ runId: 'terminal', status: 'completed' });
    await expect(
      executeResume(workflow, {
        runId: terminal.runId,
        manifest,
        allowUnattended: true,
        rootDir: terminal.rootDir,
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RESUME_RECOVERY_REQUIRED' });
  });

  it.each(['paused', 'paused_waiting_approval', 'resuming'] as const)(
    'resumes the strict %s recovery state with the same strong identity',
    async (status) => {
      const resumed = await setupRun({ runId: `resume-${status}`, status });
      const result = await executeResume(
        makeWorkflow(async () => ({ status: 'completed' })),
        {
          runId: resumed.runId,
          manifest,
          allowUnattended: true,
          rootDir: resumed.rootDir,
        },
      );
      expect(result.status).toBe('completed');
      await expect(resumed.store.loadStatus(resumed.runId)).resolves.toMatchObject({
        status: 'completed',
      });
    },
  );

  it.each(['0123456789abcdef', `${manifest.name}:${manifest.version}`])(
    'reads but refuses to automatically resume legacy weak identity %s',
    async (manifestHash) => {
      const legacy = await setupRun({ runId: `legacy-${manifestHash.length}`, manifestHash });
      await expect(
        executeResume(
          makeWorkflow(async () => ({ status: 'completed' })),
          {
            runId: legacy.runId,
            manifest,
            allowUnattended: true,
            rootDir: legacy.rootDir,
          },
        ),
      ).rejects.toMatchObject({ code: 'WORKFLOW_RESUME_RECOVERY_REQUIRED' });
    },
  );

  it('wraps corrupt metadata and status as recovery-required errors with causes', async () => {
    for (const target of ['meta', 'status'] as const) {
      const corrupted = await setupRun({ runId: `corrupt-${target}` });
      const path =
        target === 'meta'
          ? corrupted.store.metaPath(corrupted.runId)
          : corrupted.store.statusPath(corrupted.runId);
      const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      value.unexpected = true;
      await writeFile(path, JSON.stringify(value), 'utf8');
      await expect(
        executeResume(
          makeWorkflow(async () => ({ status: 'completed' })),
          {
            runId: corrupted.runId,
            manifest,
            allowUnattended: true,
            rootDir: corrupted.rootDir,
          },
        ),
      ).rejects.toMatchObject({
        code: 'WORKFLOW_RESUME_RECOVERY_REQUIRED',
        cause: expect.any(Error),
      });
    }
  });

  it('rejects argument, budget, workflow hash, and snapshot drift', async () => {
    const workflow = makeWorkflow(async () => {
      return { status: 'completed' };
    });
    const argsDrift = await setupRun();
    await expect(
      executeResume(workflow, {
        runId: argsDrift.runId,
        manifest,
        args: { qualification: false },
        allowUnattended: true,
        rootDir: argsDrift.rootDir,
      }),
    ).rejects.toThrow('arguments do not match');

    const budgetDrift = await setupRun({ runId: 'budget-drift' });
    await expect(
      executeResume(workflow, {
        runId: budgetDrift.runId,
        manifest,
        budget: { tokens: 101, costUsd: 1 },
        allowUnattended: true,
        rootDir: budgetDrift.rootDir,
      }),
    ).rejects.toThrow('budget does not match');

    const hashDrift = await setupRun({ runId: 'hash-drift', manifestHash: 'b'.repeat(64) });
    await expect(
      executeResume(workflow, {
        runId: hashDrift.runId,
        manifest,
        allowUnattended: true,
        rootDir: hashDrift.rootDir,
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RESUME_RECOVERY_REQUIRED' });

    const snapshotDrift = await setupRun({ runId: 'snapshot-drift' });
    const path = snapshotDrift.store.budgetSnapshotPath(snapshotDrift.runId);
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    snapshot.usage.tokensUsed = Number.NaN;
    await writeFile(path, JSON.stringify(snapshot, null, 2), 'utf8');
    await expect(
      executeResume(workflow, {
        runId: snapshotDrift.runId,
        manifest,
        allowUnattended: true,
        rootDir: snapshotDrift.rootDir,
      }),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_RESUME_RECOVERY_REQUIRED',
      cause: expect.any(Error),
    });
  });

  it('compares canonical argument values and rejects unsupported input before initialization', async () => {
    const reordered = await setupRun({
      runId: 'args-reordered',
      args: { z: 2, a: 1 },
    });
    const workflow = makeWorkflow(async (_ctx, args) => ({ status: 'completed', args }));
    await expect(
      executeResume(workflow, {
        runId: reordered.runId,
        manifest,
        args: { a: 1, z: 2 },
        allowUnattended: true,
        rootDir: reordered.rootDir,
      }),
    ).resolves.toMatchObject({ status: 'completed', args: { a: 1, z: 2 } });

    const rootDir = await mkdtemp(join(tmpdir(), 'openslack-invalid-args-'));
    roots.push(rootDir);
    await expect(
      executeRun(workflow, {
        runId: 'run.invalid.args',
        manifest,
        args: { unsupported: new Map([['key', 'value']]) },
        allowUnattended: true,
        rootDir,
      }),
    ).rejects.toBeInstanceOf(WorkflowRunInputInvalidError);
    const store = new RunStore({ baseDir: join(rootDir, '.openslack.local', 'workflows') });
    await expect(store.runExists('run.invalid.args')).resolves.toBe(false);
  });

  it('isolates positional args, ctx.args snapshots, and persisted tagged state', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'openslack-argument-isolation-'));
    roots.push(rootDir);
    const runId = 'run.argument.isolation';
    const input = {
      nested: { value: 1 },
      rich: { bigint: 7n, absent: undefined, when: new Date('2026-08-11T00:00:00.000Z') },
    };
    const workflow = makeWorkflow(async (ctx, positional) => {
      const first = ctx.args as typeof input;
      first.nested.value = 2;
      (positional.nested as { value: number }).value = 3;
      const second = ctx.args as typeof input;
      expect(second.nested.value).toBe(1);
      expect((positional.rich as typeof input.rich).bigint).toBe(7n);
      return { status: 'completed' };
    });

    await executeRun(workflow, {
      runId,
      manifest,
      args: input,
      allowUnattended: true,
      rootDir,
    });

    expect(input.nested.value).toBe(1);
    const store = new RunStore({ baseDir: join(rootDir, '.openslack.local', 'workflows') });
    const state = await store.getRunStatus(runId);
    expect(state).toMatchObject({
      argsEncoding: 'openslack.workflow_arguments.v1',
      args: { schema: 'openslack.workflow_arguments.v1' },
    });
  });

  it('keeps crashed running state fail-closed with a stable recovery error', async () => {
    const running = await setupRun({ runId: 'crashed-running', status: 'running' });
    await expect(
      executeResume(
        makeWorkflow(async () => ({ status: 'completed' })),
        {
          runId: running.runId,
          manifest,
          allowUnattended: true,
          rootDir: running.rootDir,
        },
      ),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RESUME_RECOVERY_REQUIRED' });
  });

  it('routes resume transition failures through the main failure boundary', async () => {
    const resumed = await setupRun({ runId: 'transition-failure' });
    const transitionError = new Error('transition persistence failed');
    const transition = resumed.store.transitionStatus.bind(resumed.store);
    vi.spyOn(resumed.store, 'transitionStatus').mockImplementation(async (runId, status) => {
      if (status === 'running') throw transitionError;
      await transition(runId, status);
    });
    await expect(
      executeResumeWithStore(
        makeWorkflow(async () => ({ status: 'completed' })),
        {
          runId: resumed.runId,
          manifest,
          allowUnattended: true,
          rootDir: resumed.rootDir,
        },
        resumed.store,
      ),
    ).rejects.toBe(transitionError);
    await expect(resumed.store.loadStatus(resumed.runId)).resolves.toMatchObject({
      status: 'paused',
    });
  });

  it('does not grant a fresh allowance when the persisted budget is exhausted', async () => {
    const { rootDir, runId, budget } = await setupRun({
      usage: { tokensUsed: 100, tokensRemaining: 0, costUsd: 1, agentCalls: 1 },
    });
    const launcher = vi.fn(async () => ({ data: {}, tokenUsage: 1 }));
    const workflow = makeWorkflow(async (ctx: WorkflowRuntime) => {
      ctx.phase('Run');
      await ctx.agent('must-not-run', { label: 'exhausted', phase: 'Run' });
      return { status: 'completed' };
    });
    await expect(
      executeResume(workflow, {
        runId,
        manifest,
        budget,
        agentLauncher: launcher,
        allowUnattended: true,
        rootDir,
      }),
    ).rejects.toThrow();
    expect(launcher).not.toHaveBeenCalled();
  });
});
