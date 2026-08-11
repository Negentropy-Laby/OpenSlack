import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeAgentCacheKey } from '../agent-shim.js';
import {
  executeResume,
  executeResumeWithStore,
  executeRun,
  WorkflowRunInputInvalidError,
} from '../execute.js';
import { WorkflowPausedError } from '../runtime.js';
import { RunStore } from '../run-store.js';
import type { WorkflowMeta, WorkflowModule, WorkflowRuntime } from '../types.js';
import type { WorkflowEffectBoundaryHandle } from '../workflow-runner-effect-boundary.js';

const roots: string[] = [];
const manifest: WorkflowMeta = {
  name: 'resume-budget-test',
  version: '1.0.0',
  description: 'Cumulative resume budget test.',
  phases: [{ title: 'Run', detail: 'Run provider calls.' }],
  risk: 'low',
};

function workflowHash(): string {
  return `${manifest.name}:${manifest.version}`;
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
  await store.initRun(runId, {
    runId,
    workflowName: manifest.name,
    mode: 'execute',
    manifestHash: options.manifestHash ?? workflowHash(),
    args: options.args ?? { qualification: true },
    startedAt: '2026-08-11T00:00:00.000Z',
    budget,
  });
  if (options.usage) await store.persistBudgetState(runId, options.usage);
  const status = options.status ?? 'paused';
  if (status !== 'running') await store.transitionStatus(runId, status);
  return { rootDir, runId, budget, store };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('strict cumulative workflow resume', () => {
  it('preserves cache and cumulative usage across a real pause/resume cycle', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'openslack-pause-resume-budget-'));
    roots.push(rootDir);
    const runId = 'run.pause.resume.budget';
    const budget = { tokens: 100, costUsd: 1 };
    const launcher = vi.fn(async (_prompt: string, options: { label: string }) => ({
      data: { label: options.label },
      tokenUsage: options.label === 'call-a' ? 10 : 20,
    }));
    const effectBoundary = {
      intent: vi.fn(async (input: { operation: string }) => ({
        effectId: `effect:${input.operation}`,
        effectKind: input.operation,
        effectHash: 'a'.repeat(64),
        capabilityHash: 'b'.repeat(64),
        requiresHumanDecision: true,
      })),
      outcome: vi.fn(async (_handle: WorkflowEffectBoundaryHandle) => undefined),
    };
    const workflow = makeWorkflow(async (ctx: WorkflowRuntime) => {
      ctx.phase('Run');
      await ctx.agent('prompt-a', { label: 'call-a', phase: 'Run' });
      await ctx.openslack.governance.audit('pre-approval', { phase: 'Run' });
      await ctx.openslack.task.createIssue({ title: 'bounded audit effect' });
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
        onConfirm: async (operation, detail) => {
          if (operation === 'openslack.governance.audit') return true;
          throw new WorkflowPausedError(operation, detail, runId);
        },
        effectBoundary,
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
        onConfirm: async (operation, detail) => {
          if (operation === 'openslack.governance.audit') return true;
          throw new WorkflowPausedError(operation, detail, runId);
        },
        effectBoundary,
        rootDir,
      }),
    ).rejects.toBeInstanceOf(WorkflowPausedError);
    await executeResume(workflow, {
      runId,
      manifest,
      args: { qualification: true },
      budget,
      agentLauncher: launcher,
      onConfirm: async () => true,
      effectBoundary,
      rootDir,
    });

    expect(launcher).toHaveBeenCalledTimes(2);
    await expect(store.loadBudgetSnapshot(runId)).resolves.toMatchObject({
      usage: { tokensUsed: 30, tokensRemaining: 70, agentCalls: 2 },
    });
    await expect(store.readAuditRecords(runId)).resolves.toMatchObject([
      { sequence: 1, operation: 'pre-approval' },
    ]);
    expect(
      effectBoundary.intent.mock.calls.filter(
        ([input]) => input.operation === 'openslack.governance.audit',
      ),
    ).toHaveLength(3);
    expect(
      effectBoundary.outcome.mock.calls.filter(
        ([handle]) => handle.effectKind === 'openslack.governance.audit',
      ),
    ).toHaveLength(3);
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

    const hashDrift = await setupRun({ runId: 'hash-drift', manifestHash: 'wrong' });
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
    ).rejects.toThrow('tokensUsed');
  });

  it('compares canonical argument values and rejects non-JSON input before initialization', async () => {
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
        args: { unsupported: undefined },
        allowUnattended: true,
        rootDir,
      }),
    ).rejects.toBeInstanceOf(WorkflowRunInputInvalidError);
    const store = new RunStore({ baseDir: join(rootDir, '.openslack.local', 'workflows') });
    await expect(store.runExists('run.invalid.args')).resolves.toBe(false);
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
