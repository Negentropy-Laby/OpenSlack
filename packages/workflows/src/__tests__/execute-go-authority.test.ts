import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeGoAuthorityResume, executeGoAuthorityRun } from '../execute.js';
import { computeAgentCacheKey } from '../agent-shim.js';
import type { AgentConversationEvent } from '../agent-shim.js';
import { createWorkflowCheckpointLeaseAuthority } from '../internal/workflow-checkpoint-lease-authority.js';
import {
  registerWorkflowEffectAuthorizationPort,
  type WorkflowEffectAuthorizationPort,
} from '../internal/workflow-effect-authorization-contract.js';
import { RunStore } from '../run-store.js';
import { WorkflowRunRouter } from '../workflow-run-routing.js';
import {
  workflowControlAuthorityInitialRecord,
  type WorkflowControlAuthorityPort,
} from '../workflow-control-authority-client.js';
import {
  WorkflowRunnerGoProjectionError,
  WorkflowRunnerV2GoProjectionRunStore,
} from '../workflow-runner-v2-go-projection-store.js';
import type { WorkflowMeta, WorkflowModule } from '../types.js';
import { workflowRunnerV2DescriptorFixture } from './workflow-runner-v2-test-fixture.js';

const roots: string[] = [];
const manifest: WorkflowMeta = {
  name: 'go-execution-recovery',
  version: '1.0.0',
  description: 'Sealed Go execution recovery regression.',
  phases: [{ title: 'Run', detail: 'Run provider calls.' }],
  risk: 'low',
};
const budget = { tokens: 100, costUsd: 1 };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function execution(mode: 'run' | 'resume', meta = manifest) {
  const rootDir = await mkdtemp(join(tmpdir(), 'openslack-go-execute-'));
  roots.push(rootDir);
  const descriptor = workflowRunnerV2DescriptorFixture({
    manifest: meta,
    authorityRoute: {
      backend: 'go',
      authority: 'workflow-control',
      routingEpoch: 9,
      authorityBuildHash: 'a'.repeat(64),
    },
  });
  const runId = descriptor.workflowRunId;
  const route = new WorkflowRunRouter({
    schema: 'openslack.workflow_run_routing_policy.v1',
    workspaceId: descriptor.workspaceId,
    backend: 'go',
    routingEpoch: 9,
    authorityBuildHash: 'a'.repeat(64),
    qualificationEnvironmentId: 'execution.test',
    workflowAllowlist: [meta.name],
    runAllowlist: [],
    expiresAt: descriptor.expiresAt,
  }).select({
    workspaceId: descriptor.workspaceId,
    runId,
    workflowId: meta.name,
    workflowVersion: meta.version!,
    workflowSourceHash: descriptor.workflowSourceHash,
    manifestHash: descriptor.manifestHash,
    inputHash: descriptor.inputHash,
    correlationId: descriptor.correlationId,
    selectedAt: descriptor.createdAt,
  });
  let record = workflowControlAuthorityInitialRecord(route);
  const authority: WorkflowControlAuthorityPort = {
    inspectBinding: vi.fn(),
    accept: vi.fn(),
    async read() {
      return {
        ...record,
        schema: 'openslack.workflow_control_authority_read.v2',
        recordHash: 'f'.repeat(64),
        record,
        updatedAt: descriptor.createdAt,
      };
    },
    async readIfExists() {
      return this.read(runId, route.route);
    },
    async transition(next, expected) {
      expect(expected).toMatchObject({ revision: record.revision, state: record.state });
      expect(next.revision).toBe(record.revision + 1);
      record = next;
      return {} as never;
    },
  };
  const baseDir = join(rootDir, '.openslack.local', 'workflows', 'go-recovery-projections');
  const store = new WorkflowRunnerV2GoProjectionRunStore({ baseDir, descriptor, authority });
  const binding = {
    workspaceId: descriptor.workspaceId,
    jobId: 'job.execution',
    workflowRunId: runId,
    attemptId: 'attempt.first',
    leaseId: 'lease.first',
    fencingToken: 1,
    correlationId: descriptor.correlationId,
    runnerBuildHash: 'a'.repeat(64),
    workflowSourceHash: descriptor.workflowSourceHash,
    manifestHash: descriptor.manifestHash,
    inputHash: descriptor.inputHash,
  };
  if (mode === 'resume') {
    await store.initRun(runId, {
      runId,
      workflowName: meta.name,
      mode: 'execute',
      manifestHash: descriptor.workflowSourceHash,
      args: {},
      startedAt: descriptor.createdAt,
      budget,
    });
    await store.initializeCheckpointControl(runId, binding);
    await store.persistBudgetState(runId, {
      tokensUsed: 30,
      tokensRemaining: 70,
      costUsd: 1,
      agentCalls: 1,
    });
    await store.transitionStatus(runId, 'paused');
  }
  const checkpointAuthority = createWorkflowCheckpointLeaseAuthority(
    mode === 'run'
      ? binding
      : { ...binding, attemptId: 'attempt.resume', leaseId: 'lease.resume', fencingToken: 2 },
  );
  // These workflows call providers but perform no governed effects. An attempted
  // effect is an error, not an authorization shortcut in the test composition.
  const unexpectedEffect = vi.fn(async (): Promise<never> => {
    throw new Error('Unexpected effect in execution recovery test.');
  });
  const effects: WorkflowEffectAuthorizationPort = {
    prepare: unexpectedEffect,
    authorize: unexpectedEffect,
    complete: unexpectedEffect,
    reconcile: unexpectedEffect,
  };
  registerWorkflowEffectAuthorizationPort(effects);
  const options = { runId, manifest: meta, rootDir, budget, allowUnattended: true };
  return {
    store,
    authority,
    runId,
    options,
    // Reopen the files to assert durable state independently of the writer object.
    reader: new RunStore({ baseDir, access: 'read-only' }),
    execute(run: NonNullable<WorkflowModule['run']>, extra = {}) {
      return (mode === 'run' ? executeGoAuthorityRun : executeGoAuthorityResume)(
        { meta, hash: descriptor.workflowSourceHash, run },
        { ...options, ...extra },
        store,
        checkpointAuthority,
        effects,
      );
    },
  };
}

// Real recovery files include Windows owner-only ACL checks on each write.
describe('sealed Go execution recovery', { timeout: 30_000 }, () => {
  it.each(['run', 'resume'] as const)(
    'keeps durable output recoverable when the %s terminal transition fails',
    async (mode) => {
      const fixture = await execution(mode);
      const failure = new WorkflowRunnerGoProjectionError(
        'WORKFLOW_RUNNER_GO_PROJECTION_RECONCILIATION_REQUIRED',
        'Terminal authority transition requires reconciliation.',
      );
      const transitions: string[] = [];
      const transition = fixture.store.transitionStatus.bind(fixture.store);
      vi.spyOn(fixture.store, 'transitionStatus').mockImplementation(async (runId, status) => {
        transitions.push(status);
        if (status === 'completed') throw failure;
        await transition(runId, status);
      });
      await expect(
        fixture.execute(async () => ({ status: 'completed', durable: true })),
      ).rejects.toBe(failure);
      expect(transitions).toContain('completed');
      expect(transitions).not.toContain('failed');
      await expect(fixture.reader.loadOutput(fixture.runId)).resolves.toMatchObject({
        runId: fixture.runId,
        durable: true,
      });
      await expect(fixture.reader.loadStatus(fixture.runId)).resolves.toMatchObject({
        status: 'running',
      });
      await expect(fixture.authority.read(fixture.runId, {} as never)).resolves.toMatchObject({
        state: 'running',
      });
    },
  );

  it.each(['run', 'resume'] as const)(
    'persists charged provider usage before publishing the %s failure outcome',
    async (mode) => {
      const fixture = await execution(mode);
      const failure = Object.assign(new Error('Provider unavailable.'), { tokenUsage: 7 });
      const events: AgentConversationEvent[] = [];
      const transition = fixture.authority.transition.bind(fixture.authority);
      const failureSnapshots: unknown[] = [];
      vi.spyOn(fixture.authority, 'transition').mockImplementation(async (...args) => {
        if (args[0].state === 'failed') {
          const snapshot = await fixture.reader.loadBudgetSnapshot(fixture.runId);
          failureSnapshots.push(snapshot?.usage);
        }
        return transition(...args);
      });
      await expect(
        fixture.execute(
          async (ctx) => {
            ctx.phase('Run');
            await ctx.agent('failure', { label: 'provider', phase: 'Run' });
            return { status: 'completed' };
          },
          {
            agentLauncher: async () => {
              throw failure;
            },
            agentEventEmitter: (event: AgentConversationEvent) => events.push(event),
          },
        ),
      ).rejects.toBe(failure);
      expect(failureSnapshots).toEqual([
        {
          tokensUsed: mode === 'run' ? 7 : 37,
          tokensRemaining: mode === 'run' ? 93 : 63,
          costUsd: 1,
          agentCalls: mode === 'run' ? 1 : 2,
        },
      ]);
      expect(events.map((event) => event.type)).toEqual([
        'agent.conversation.started',
        'agent.conversation.failed',
      ]);
      expect(events.every((event) => event.runId === fixture.runId)).toBe(true);
      expect(events[1]?.error).toBe(
        'Agent execution failed. Inspect runtime diagnostics for details.',
      );
      await expect(fixture.reader.loadStatus(fixture.runId)).resolves.toMatchObject({
        status: 'failed',
      });
    },
  );

  it('reuses cached calls and charges only new calls against the resumed budget', async () => {
    const fixture = await execution('resume');
    await fixture.store.saveAgentResult(
      fixture.runId,
      computeAgentCacheKey(manifest.name, 'Run', 'cached', 'cached'),
      { data: { cached: true }, tokenUsage: 30 },
    );
    const launcher = vi.fn(async () => ({ data: { fresh: true }, tokenUsage: 20 }));
    const events: AgentConversationEvent[] = [];
    await fixture.execute(
      async (ctx) => {
        ctx.phase('Run');
        await ctx.agent('cached', { label: 'cached', phase: 'Run' });
        await ctx.agent('fresh', { label: 'fresh', phase: 'Run' });
        return { status: 'completed' };
      },
      {
        agentLauncher: launcher,
        agentEventEmitter: (event: AgentConversationEvent) => events.push(event),
      },
    );
    expect(launcher).toHaveBeenCalledTimes(1);
    await expect(fixture.reader.loadBudgetSnapshot(fixture.runId)).resolves.toMatchObject({
      usage: { tokensUsed: 50, tokensRemaining: 50, agentCalls: 2 },
    });
    expect(events.map((event) => event.type)).toEqual([
      'agent.conversation.started',
      'agent.conversation.completed',
    ]);
    expect(
      events.every((event) => event.runId === fixture.runId && event.agentId === 'fresh'),
    ).toBe(true);
  });

  it('refuses a fresh provider allowance when the resumed budget is exhausted', async () => {
    const fixture = await execution('resume');
    await fixture.store.persistBudgetState(fixture.runId, {
      tokensUsed: 100,
      tokensRemaining: 0,
      costUsd: 1,
      agentCalls: 1,
    });
    const launcher = vi.fn(async () => ({ data: {}, tokenUsage: 1 }));
    await expect(
      fixture.execute(
        async (ctx) => {
          ctx.phase('Run');
          await ctx.agent('exhausted', { label: 'exhausted', phase: 'Run' });
          return { status: 'completed' };
        },
        { agentLauncher: launcher },
      ),
    ).rejects.toThrow();
    expect(launcher).not.toHaveBeenCalled();
  });

  it('rejects pending legacy agent controls before advancing or launching a resumed run', async () => {
    const fixture = await execution('resume');
    const status = await fixture.reader.loadStatus(fixture.runId);
    await writeFile(
      fixture.store.statusPath(fixture.runId),
      JSON.stringify({
        ...status,
        pendingAgentControls: [
          {
            action: 'stopAgent',
            timestamp: '2026-08-15T02:00:00.000Z',
            target: { runId: fixture.runId, agentRunId: 'agent.legacy' },
            status: 'recorded',
            message: 'Historical pending stop.',
          },
        ],
      }),
    );
    const generation = await fixture.reader.loadCheckpointControl(fixture.runId);
    const run = vi.fn(async () => ({ status: 'completed' as const }));
    await expect(fixture.execute(run)).rejects.toThrow(
      'legacy pending agent controls are read-only evidence',
    );
    expect(run).not.toHaveBeenCalled();
    await expect(fixture.reader.loadCheckpointControl(fixture.runId)).resolves.toEqual(generation);
  });
});
