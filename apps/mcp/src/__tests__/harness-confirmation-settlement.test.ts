import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGovernedActionExecutionRegistry, createGovernedPlanService, LocalGovernedPlanStore } from '@openslack/operator';
import { createRunStore, buildPermissionProfile } from '@openslack/agent-runtime';
import { HarnessTaskHost, type ApprovedHarnessTask } from '@openslack/agent-runtime/internal/harness';
import { createOpenSlackGovernedMutationPort, currentGovernedMutationAttempt } from '../mutations.js';

const roots: string[] = [];
const hosts: HarnessTaskHost[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.close(100);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(failure: 'hook' | 'audit' | 'busy' | 'none', wait?: Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'harness-confirmation-settlement-')); roots.push(root);
  const config = { agentId: 'fixture', source: 'fixture', tools: ['Read'] };
  const task: ApprovedHarnessTask = { taskId: 'TASK-1', principalHash: 'a'.repeat(64), baseline: 'b'.repeat(40), timeoutMs: 5000,
    request: { agentId: 'fixture', prompt: 'fixture', resolvedConfig: config, permissionProfile: buildPermissionProfile(config) },
    scope: { readPaths: [], writePaths: [], forbiddenPaths: ['.git/**'] }, outputSchema: { type: 'object' },
  };
  const execute = vi.fn(async () => ({ data: { ok: true }, exitConfirmed: true as const }));
  const host = new HarnessTaskHost({ identityRoot: root, workspaceId: 'fixture', store: createRunStore(root, { sweepOrphans: false }),
    readTask: async () => task, authorize: async () => {}, publish: async () => {},
    prepare: async () => ({ execute, accept: async () => ({ outcome: 'verified', summary: 'fixture', evidenceRefs: [] }) }),
  }); hosts.push(host);
  let runId: string | undefined;
  const admitted = Promise.withResolvers<void>();
  const registry = createGovernedActionExecutionRegistry([{ actionId: 'harness.task.dispatch', version: '1.0.0', bindingId: 'fixture-harness-owner-v1',
    description: 'Fixture trusted task admission', execute: async (_input, context) => {
      const confirmationAttemptId = currentGovernedMutationAttempt();
      if (!confirmationAttemptId) throw new Error('Missing originating attempt');
      const receipt = await host.dispatch(task.taskId, 'request', true, { planId: context.planId, executionId: context.executionId, confirmationAttemptId });
      runId = receipt.runId; admitted.resolve();
      await wait;
      if (failure === 'busy') {
        // A genuine live-owner publication lock, not a forged service/store implementation.
        writeFileSync(join(root, 'plans/locks', `${createHash('sha256').update(context.planId).digest('hex')}.lock`), JSON.stringify({
          schema: 'openslack.governed_plan_lock.v1', pid: process.pid, sessionId: randomUUID(), threadId: 0,
          nonce: randomUUID(), createdAt: new Date().toISOString(),
        }), { flag: 'wx', mode: 0o600 });
      }
      return { status: 'succeeded', summary: 'Admission only', data: { ...receipt }, evidenceRefs: [`run:${runId}`] };
    } }]);
  const store = new LocalGovernedPlanStore(join(root, 'plans'));
  const service = createGovernedPlanService({ store, registry,
    getBindingSnapshot: () => ({ sourceVersions: { fixture: 'a'.repeat(64) }, permissionSnapshot: { fixture: true }, buildNonce: 'fixture-build-0123456789' }),
    audit: async event => { if (failure === 'audit' && event.type === 'plan.execution_completed') throw new Error('Fixture terminal audit failure'); },
  });
  const compile = () => ({ kind: 'workflow.start', goal: 'Admit only the approved fixture task', input: {},
    actions: [{ actionId: 'harness.task.dispatch', input: {} }], effects: [{ type: 'harness.task.dispatch', summary: 'Admit fixture', risk: 'medium' as const, target: task.taskId }],
  });
  const outcomes: Array<{ attemptId: string; failed: boolean }> = [];
  const mutations = createOpenSlackGovernedMutationPort({ service, authority: { actorId: 'fixture-principal', workspaceId: 'fixture' },
    compileScenario: compile, compileWorkflow: compile,
    onConfirmed: () => { if (failure === 'hook') throw new Error('Fixture post-confirm hook failure'); },
    onConfirmationSettled: async (planId, outcome) => {
      outcomes.push(outcome);
      const record = await service.get(planId);
      host.settleConfirmedAdmissions(planId, { state: outcome.failed || outcome.aborted ? 'uncertain' : record?.state ?? 'uncertain',
        confirmationAttemptId: outcome.attemptId, ...(record?.execution?.executionId ? { executionId: record.execution.executionId } : {}) });
    },
  });
  const invocation = () => ({ signal: new AbortController().signal, deadlineAt: new Date(Date.now() + 10_000).toISOString() });
  const preview = () => mutations.previewWorkflow({ workflowId: 'harness.task.dispatch', input: { taskId: task.taskId, requestId: 'request' } }, invocation());
  return { host, execute, mutations, service, invocation, preview, admitted: admitted.promise, getRunId: () => runId!, outcomes };
}

describe('originating governed confirmation settlement', () => {
  it.each(['hook', 'audit', 'busy'] as const)('stops admission after %s failure without interpreting durable success as execution permission', async failure => {
    const value = setup(failure);
    const preview = await value.preview();
    await expect(value.mutations.confirm({ planId: preview.record.planId, confirmationToken: preview.confirmationToken }, value.invocation())).rejects.toThrow();
    const runId = value.getRunId();
    await vi.waitFor(() => expect(value.host.read(runId)?.status).toBe('failed'));
    expect(value.host.read(runId)?.harnessExecution?.lifecycle?.phase).toBe('stopped_before_start');
    expect(value.execute).not.toHaveBeenCalled();
    expect(value.outcomes).toEqual([expect.objectContaining({ failed: true })]);
    if (failure !== 'busy') expect((await value.service.get(preview.record.planId))?.state).toBe('succeeded');
  });

  it('does not cancel the owner when duplicate-active and bad-token confirmations settle first', async () => {
    const gate = Promise.withResolvers<void>();
    const value = setup('none', gate.promise);
    const preview = await value.preview();
    const request = { planId: preview.record.planId, confirmationToken: preview.confirmationToken };
    const owner = value.mutations.confirm(request, value.invocation());
    await value.admitted;
    await expect(value.mutations.confirm(request, value.invocation())).rejects.toMatchObject({ code: 'GOVERNED_PLAN_EXECUTION_ACTIVE' });
    const altered = (request.confirmationToken.startsWith('a') ? 'b' : 'a') + request.confirmationToken.slice(1);
    await expect(value.mutations.confirm({ ...request, confirmationToken: altered }, value.invocation())).rejects.toThrow();
    expect(value.host.read(value.getRunId())?.harnessExecution?.lifecycle?.phase).toBe('awaiting_confirmation');
    expect(value.execute).not.toHaveBeenCalled();
    gate.resolve();
    await owner;
    await vi.waitFor(() => expect(value.host.read(value.getRunId())?.status).toBe('completed'));
    expect(value.execute).toHaveBeenCalledOnce();
    expect(new Set(value.outcomes.map(outcome => outcome.attemptId)).size).toBe(3);
  });
});
