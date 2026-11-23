import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { types as nodeTypes } from 'node:util';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi, type TestContext } from 'vitest';
import type * as AgentRuntime from '@openslack/agent-runtime';
import {
  testTemporaryDirectory,
  platformTestTimeout,
} from '../../../../scripts/testing/process-fixture.mjs';
import { loadWorkflowFile } from '../internal/workflow-file-loader.js';
import { WorkflowRunnerResumeSourceStore } from '../internal/workflow-runner-resume-source.js';
import { createWorkflowCheckpointLeaseAuthority } from '../internal/workflow-checkpoint-lease-authority.js';
import {
  createSealedWorkflowRunnerV2SourceLoader,
  executeWorkflowRunnerV2AuthorityJob,
} from '../workflow-runner-worker.js';
import {
  WorkflowControlAuthorityHttpClient,
  prepareWorkflowControlAuthorityMutation,
  type WorkflowControlAuthorityRunRecord,
} from '../workflow-control-authority-client.js';
import {
  canonicalWorkflowControlAuthorityJson as canonical,
  prepareWorkflowControlAuthorityMessage,
} from '../workflow-control-authority-contract.js';
import { createWorkflowRunnerAuthorityBindingClient } from '../workflow-runner-authority-binding-client.js';
import {
  workflowCheckpointHash,
  type WorkflowCheckpointControlState,
} from '../workflow-checkpoint-shadow-contract.js';
import { recoveryFrame } from './workflow-recovery-fixtures.js';
import { workflowRunnerV2DescriptorFixture } from './workflow-runner-v2-test-fixture.js';
import { RunStore } from '../run-store.js';
import { resolveWorkflowRunProjectionRoot } from '../workflow-run-projection.js';
import { WorkflowEffectApprovalPendingError } from '../internal/workflow-effect-authorization-contract.js';
import { createWorkflowEffectDecisionAuthority } from '../workflow-effect-approval.js';
import { LocalWorkflowEffectApprovalStore } from '../workflow-effect-approval-store.js';
import type { WorkflowRunnerV2ExecutionContext } from '../workflow-runner-v2-session.js';
import type { WorkflowRunnerAuthoritySourceAdapter } from '../workflow-runner-authority-binding-runtime.js';
import type { WorkflowRunRecoveryEvidence } from '../workflow-run-recovery-evidence.js';
import type { WorkflowRunnerAuthorityBindingStage } from '../workflow-runner-authority-binding-contract.js';

const calls = vi.hoisted(() => ({ launcher: vi.fn() }));
vi.mock('@openslack/agent-runtime', async (original) => ({
  ...(await original<typeof AgentRuntime>()),
  createOpenSlackAgentLauncher: () => calls.launcher,
}));
const checkpointScenarios = ['complete', 'missing-artifact', 'cancelled-head', 'missing-registration'] as const;
type CheckpointScenario = typeof checkpointScenarios[number];
interface CheckpointFixture {
  context: TestContext;
  scenario: CheckpointScenario;
  root?: string;
  removed: boolean;
  cleaning: boolean;
  body?: Promise<void>;
  bodySettled: boolean;
  executions: Set<Promise<unknown>>;
  requests: Set<Promise<unknown>>;
  controllers: Set<AbortController>;
  server?: ReturnType<typeof createServer>;
  serverStarted: boolean;
  serverClosed: boolean;
  failures: unknown[];
  stage: string;
  phase: string;
  phaseBegan: number;
  phaseLive: boolean;
  intervals: { name: string; ending: string; milliseconds: number }[];
  steps: { name: string; outcome: 'fulfilled' | 'rejected'; milliseconds: number }[];
  firstFailure?: { origin: string; phase: string; code: string };
}
const checkpointFixtures = new WeakMap<TestContext['task'], CheckpointFixture>();
const checkpointByScenario = new Map<CheckpointScenario, CheckpointFixture>();
const checkpointErrorCode = (error: unknown) => {
  if (!error || typeof error !== 'object' || nodeTypes.isProxy(error)) return 'UNKNOWN';
  const code = Object.getOwnPropertyDescriptor(error, 'code');
  const message = Object.getOwnPropertyDescriptor(error, 'message');
  const timeout = message && 'value' in message && typeof message.value === 'string' ? /^Test timed out in (5000|120000)ms\b/.exec(message.value) : null;
  if (timeout) return `TEST_TIMEOUT_${timeout[1]}`;
  return code && 'value' in code && typeof code.value === 'string' &&
    ['EACCES', 'EPERM', 'EIO', 'ENOENT', 'ETIMEDOUT', 'ECONNRESET', 'ABORT_ERR'].includes(code.value) ? code.value : 'UNKNOWN';
};
function publishCheckpointFixture(owned: CheckpointFixture) {
  Object.assign(owned.context.task.meta, { checkpointFixture: { stage: owned.stage, phase: owned.phase,
    steps: owned.steps.map(step => ({ ...step })), phaseIntervals: owned.intervals.map(interval => ({ ...interval })), firstFailure: owned.firstFailure ?? null,
    executionCount: owned.executions.size, activeRequests: owned.requests.size,
    serverStarted: owned.serverStarted, serverClosed: owned.serverClosed,
    retainedRoots: owned.root && !owned.removed ? 1 : 0 } });
}
function checkpointEndPhase(owned: CheckpointFixture, ending: string) {
  if (owned.phaseLive) {
    owned.intervals.push({ name: owned.phase, ending, milliseconds: performance.now() - owned.phaseBegan });
    owned.phaseLive = false;
  }
}
function checkpointMark(owned: CheckpointFixture, phase: string) {
  checkpointEndPhase(owned, 'next_phase');
  owned.phase = phase; owned.phaseBegan = performance.now(); owned.phaseLive = true;
  publishCheckpointFixture(owned);
}
async function checkpointSpan<T>(owned: CheckpointFixture, name: string, work: () => Promise<T>): Promise<T> {
  const began = performance.now();
  let outcome: 'fulfilled' | 'rejected' = 'rejected';
  try { const result = await work(); outcome = 'fulfilled'; return result; }
  finally { owned.steps.push({ name, outcome, milliseconds: performance.now() - began }); publishCheckpointFixture(owned); }
}
async function checkpointStep<T>(owned: CheckpointFixture, name: string, work: () => Promise<T>): Promise<T> {
  checkpointMark(owned, name);
  return checkpointSpan(owned, name, work);
}
function checkpointController(owned: CheckpointFixture) {
  const controller = new AbortController();
  owned.controllers.add(controller);
  if (owned.cleaning) controller.abort(new Error('CHECKPOINT_TEST_CLEANUP'));
  return controller;
}
function trackCheckpointExecution<T>(owned: CheckpointFixture, work: Promise<T>): Promise<T> {
  owned.executions.add(work);
  void work.catch(() => undefined);
  return work;
}
function runCheckpointCase(scenario: CheckpointScenario, operation: (owned: CheckpointFixture) => Promise<void>) {
  const owned = checkpointByScenario.get(scenario);
  if (!owned) throw new Error('CHECKPOINT_FIXTURE_NOT_PREPARED');
  owned.phaseBegan = performance.now(); owned.phaseLive = true;
  const work = Promise.resolve().then(() => operation(owned)).catch(error => {
    owned.firstFailure ??= { origin: 'body', phase: owned.phase, code: checkpointErrorCode(error) };
    throw error;
  });
  owned.body = work;
  void work.then(() => { owned.bodySettled = true; checkpointEndPhase(owned, 'body_fulfilled'); publishCheckpointFixture(owned); },
    () => { owned.bodySettled = true; checkpointEndPhase(owned, 'body_rejected'); publishCheckpointFixture(owned); });
  void work.catch(() => undefined);
  return work;
}
async function checkpointJoin<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('CHECKPOINT_TEST_WORK_UNCONFIRMED')), Math.max(0, deadline - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}
beforeEach(context => {
  const scenario = checkpointScenarios.find(value => context.task.name === `runs the real worker canonical-resume path: ${value}`);
  if (!scenario) return;
  const owned: CheckpointFixture = { context, scenario, removed: false, cleaning: false, bodySettled: false, executions: new Set(), requests: new Set(),
    controllers: new Set(), serverStarted: false, serverClosed: false, failures: [], stage: 'tested_protocol', phase: 'fixture_files', phaseBegan: 0, phaseLive: false, intervals: [], steps: [] };
  checkpointFixtures.set(context.task, owned);
  checkpointByScenario.set(scenario, owned);
});
afterEach(async context => {
  const owned = checkpointFixtures.get(context.task);
  if (!owned) return;
  checkpointFixtures.delete(context.task);
  if (checkpointByScenario.get(owned.scenario) === owned) checkpointByScenario.delete(owned.scenario);
  let primaryFailed = context.task.result?.state === 'fail' || (context.task.result?.errors?.length ?? 0) > 0;
  if (primaryFailed) owned.firstFailure ??= { origin: 'runner', phase: owned.phase, code: checkpointErrorCode(context.task.result?.errors?.[0]) };
  if (primaryFailed) checkpointEndPhase(owned, 'runner_failed');
  owned.cleaning = true; owned.stage = primaryFailed || !owned.bodySettled ? 'cancelling_owned_work' : 'joining_owned_work'; publishCheckpointFixture(owned);
  if (primaryFailed || !owned.bodySettled) for (const controller of owned.controllers) controller.abort(new Error('CHECKPOINT_TEST_CLEANUP'));
  const deadline = performance.now() + 5_000;
  try {
    const body = await checkpointSpan(owned, 'cleanup_body_join', () => checkpointJoin(Promise.allSettled(owned.body ? [owned.body] : []), deadline));
    if (body.some(result => result.status === 'rejected')) primaryFailed = true;
    // Initial approval-pending and negative-scenario rejections are expected;
    // these joins establish quiescence, not a new successful-outcome assertion.
    await checkpointSpan(owned, 'cleanup_execution_join', () => checkpointJoin(Promise.allSettled([...owned.executions]), deadline));
    await checkpointSpan(owned, 'cleanup_request_join', () => checkpointJoin(Promise.allSettled([...owned.requests]), deadline));
    if (owned.requests.size !== 0) throw new Error('CHECKPOINT_TEST_HTTP_WORK_UNCONFIRMED');
    if (owned.server && owned.serverStarted && !owned.serverClosed) {
      await checkpointSpan(owned, 'cleanup_server_close', () => checkpointJoin(new Promise<void>((resolve, reject) => owned.server!.close(error => error ? reject(error) : resolve())), deadline));
      if (!owned.serverClosed) throw new Error('CHECKPOINT_TEST_SERVER_CLOSE_UNCONFIRMED');
    }
  } catch {
    owned.stage = 'ownership_unconfirmed'; publishCheckpointFixture(owned);
    if (!primaryFailed) throw new Error('CHECKPOINT_TEST_CLEANUP_UNCONFIRMED');
    return;
  }
  owned.stage = 'owned_work_drained'; publishCheckpointFixture(owned);
  let cleanupFailed = false;
  const restoreBegan = performance.now();
  try { vi.restoreAllMocks(); calls.launcher.mockReset(); }
  catch { cleanupFailed = true; }
  owned.steps.push({ name: 'cleanup_restore', outcome: cleanupFailed ? 'rejected' : 'fulfilled', milliseconds: performance.now() - restoreBegan });
  if (owned.failures.length > 0) cleanupFailed = true;
  if (!primaryFailed && !cleanupFailed && owned.root) {
    try { await checkpointSpan(owned, 'cleanup_remove', () => rm(owned.root!, { recursive: true, force: true })); owned.removed = true; }
    catch { cleanupFailed = true; }
  }
  owned.stage = cleanupFailed ? 'cleanup_failed' : primaryFailed ? 'failed_fixture_retained' : 'removed';
  publishCheckpointFixture(owned);
  if (cleanupFailed && !primaryFailed) throw new Error('CHECKPOINT_TEST_CLEANUP_FAILED');
});

it.each(['complete', 'missing-artifact', 'cancelled-head', 'missing-registration'] as const)(
  'runs the real worker canonical-resume path: %s',
  scenario => runCheckpointCase(scenario, async owned => {
    const setupBegan = performance.now();
    const root = testTemporaryDirectory('checkpoint-worker-resume-');
    owned.root = root;
    const source = `export const meta={name:'${scenario === 'missing-registration' ? 'r-ext-go-qualification' : 'checkpoint-resume-test'}',version:'1.0.0',description:'Checkpoint resume regression',phases:[{title:'First',detail:'First'},{title:'Approval',detail:'Approval'},{title:'Second',detail:'Second'},{title:'Done',detail:'Done'}],permissions:{openslack:['governance.audit']},sideEffects:['openslack.governance.audit'],risk:'medium'};
export async function run(ctx){ctx.phase('First');const first=await ctx.agent('first',{agentType:'unresolved-fixture',label:'first',phase:'First',budget:{tokens:100}});const replay=await ctx.checkpoint.commit({artifact:new TextEncoder().encode(JSON.stringify(first))});ctx.phase('Approval');await ctx.openslack.governance.audit('checkpoint-resume-marker');await ctx.checkpoint.commit({artifact:new TextEncoder().encode('approved')});ctx.phase('Second');await ctx.agent('second',{agentType:'unresolved-fixture',label:'second',phase:'Second',budget:{tokens:100}});await ctx.checkpoint.commit({artifact:new TextEncoder().encode('second')});ctx.phase('Done');await ctx.checkpoint.commit({artifact:new TextEncoder().encode('done')});return {status:'completed',replay};}`;
    const sourceDirectory = join(root, '.openslack', 'workflows');
    await mkdir(sourceDirectory, { recursive: true });
    const sourcePath = join(
      sourceDirectory,
      scenario === 'missing-registration'
        ? 'r-ext-go-qualification.mjs'
        : 'checkpoint-resume-test.mjs',
    );
    await writeFile(sourcePath, source);
    const loaded = await loadWorkflowFile(sourcePath);
    const now = new Date().toISOString();
    const descriptor = workflowRunnerV2DescriptorFixture({
      workflowSourceBytes: Buffer.from(source),
      manifest: loaded.meta,
      authorityRoute: {
        backend: 'go',
        authority: 'workflow-control',
        routingEpoch: 1,
        authorityBuildHash: '1'.repeat(64),
      },
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
    });
    const loader = createSealedWorkflowRunnerV2SourceLoader(root);
    const workflow = await loader.load(await loader.prepare(descriptor), descriptor);
    owned.steps.push({ name: 'fixture_files_and_descriptor', outcome: 'fulfilled', milliseconds: performance.now() - setupBegan });
    checkpointMark(owned, 'http_fixture');
    let record: WorkflowControlAuthorityRunRecord = {
      schema: 'openslack.workflow_control_authority_run_record.v2',
      workspaceId: descriptor.workspaceId,
      runId: descriptor.workflowRunId,
      workflowId: descriptor.workflowId,
      workflowVersion: descriptor.workflowVersion,
      workflowSourceHash: descriptor.workflowSourceHash,
      manifestHash: descriptor.manifestHash,
      inputHash: descriptor.inputHash,
      route: descriptor.authorityRoute,
      state: 'created',
      revision: 1,
      resumeGeneration: 0,
      currentPhaseId: null,
      currentPhaseIndex: null,
    };
    const frames: WorkflowRunRecoveryEvidence['bindings'][number][] = [];
    const receipts = new Map<string, string>();
    let activeAttempt = 'attempt.initial';
    const failures = owned.failures;
    const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
      const reply = (value: unknown, status = 200) => {
        const bytes = canonical(value) + '\n';
        response.writeHead(status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bytes),
        });
        response.end(bytes);
      };
      try {
        const path = request.url!;
        if (request.method === 'GET') {
          if (path.startsWith('/v2/runner/runs/')) {
            const selected = new URL(path, 'http://localhost').searchParams.get('bindingId');
            const entries = frames.filter((f) => selected === null || f.bindingId === selected);
            return reply({
              schema: 'openslack.workflow_runner_recovery_evidence.v1',
              workspaceId: record.workspaceId,
              runId: record.runId,
              route: record.route,
              complete: selected === null,
              snapshot: createHash('sha256').update(canonical(entries)).digest('hex'),
              nextCursor: null,
              bindings: entries,
              unfinished: entries
                .filter((f) => f.state !== 'completed')
                .map((f) => ({
                  bindingId: f.bindingId,
                  operation: JSON.parse(f.stage).operation,
                  state: f.state,
                })),
              activeAttempts: [activeAttempt],
            });
          }
          if (path.startsWith('/v1/workflow-control/runs/'))
            return reply({
              ...record,
              schema: 'openslack.workflow_control_authority_read.v2',
              record,
              recordHash: createHash('sha256')
                .update(canonical(record) + '\n')
                .digest('hex'),
              updatedAt: now,
            });
          const receipt = receipts.get(decodeURIComponent(path.split('/').at(-1)!));
          if (receipt) {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            return response.end(receipt);
          }
          response.writeHead(404);
          return response.end();
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks).toString('utf8');
        const mutation = JSON.parse(bytes);
        const prepared = prepareWorkflowControlAuthorityMutation({
          ...mutation,
          callerId: 'workflow-runner-v2',
          expectedBuildHash: record.route.authorityBuildHash,
        });
        expect(bytes).toBe(prepared.exactBody);
        expect(mutation.expected.revision).toBe(record.revision);
        expect(mutation.expected.state).toBe(record.state);
        record = mutation.record;
        const receipt = {
          schema: 'openslack.workflow_control_authority_receipt.v2',
          operation: 'run_transition',
          status: 'accepted',
          workspaceId: record.workspaceId,
          runId: record.runId,
          expectedRevision: mutation.expected.revision,
          acceptedRevision: record.revision,
          resumeGeneration: record.resumeGeneration,
          route: record.route,
          idempotencyKey: prepared.idempotencyKey,
          requestFingerprint: prepared.requestFingerprint,
          requestHash: prepared.requestHash,
          recordHash: prepared.recordHash,
          correlationId: mutation.correlationId,
          serviceBuildHash: record.route.authorityBuildHash,
          committedAt: new Date().toISOString(),
          reconciliationToken: null,
        };
        receipts.set(prepared.idempotencyKey, canonical(receipt) + '\n');
        reply(receipt, 201);
      } catch (error) {
        failures.push(error);
        response.writeHead(500);
        response.end();
      }
    };
    const server = createServer((request, response) => {
      const work = handleRequest(request, response);
      owned.requests.add(work);
      void work.then(() => owned.requests.delete(work), error => { failures.push(error); owned.requests.delete(work); });
    });
    owned.server = server;
    server.once('close', () => { owned.serverClosed = true; });
    server.on('error', error => failures.push(error));
    await checkpointStep(owned, 'http_listen', () => new Promise<void>((done, reject) => {
      const refused = (error: Error) => reject(error);
      server.once('error', refused);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', refused); owned.serverStarted = true; done(); });
    }));
    {
      checkpointMark(owned, 'authority_fixture');
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('No fixture address');
      const origin = `http://127.0.0.1:${address.port}`;
      const authority = new WorkflowControlAuthorityHttpClient({
        origin,
        workspaceId: record.workspaceId,
        callerId: 'workflow-runner-v2',
        bearerToken: 'r'.repeat(48),
        expectedBuildHash: record.route.authorityBuildHash,
      });
      const recovery = createWorkflowRunnerAuthorityBindingClient({
        origin,
        workspaceId: record.workspaceId,
        bearerToken: 'c'.repeat(48),
      });
      const reader = new RunStore({
        baseDir: resolveWorkflowRunProjectionRoot(root, 'go'),
        access: 'read-only',
      });
      const binding = {
        workspaceId: record.workspaceId,
        workflowRunId: record.runId,
        jobId: 'job.initial',
        attemptId: activeAttempt,
        leaseId: 'lease.initial',
        fencingToken: 1,
        correlationId: descriptor.correlationId,
        runnerBuildHash: '1'.repeat(64),
        workflowSourceHash: record.workflowSourceHash,
        manifestHash: record.manifestHash,
        inputHash: record.inputHash,
      };
      let checkpointEvents = 0,
        auditEffects = 0;
      const commit = async (
        operation: WorkflowRunnerAuthorityBindingStage['operation'],
        source?: WorkflowRunnerAuthoritySourceAdapter,
      ) => {
        if (!source) throw Error('No source adapter');
        const stage = { operation } as WorkflowRunnerAuthorityBindingStage;
        const probe = await source.probe(stage);
        return probe.state === 'committed' ? probe.evidence : source.commit(stage, {} as never);
      };
      const context = (
        nextBinding: typeof binding,
        generation: number,
      ): WorkflowRunnerV2ExecutionContext => ({
        signal: checkpointController(owned).signal,
        resumeOffer: null,
        resumeGeneration: generation,
        checkpointAuthority: createWorkflowCheckpointLeaseAuthority(nextBinding),
        async checkpointCommit(_payload, source) {
          await commit('checkpoint_commit', source);
          checkpointEvents++;
          frames.push(
            recoveryFrame((await reader.loadCheckpointControl(record.runId))!, 'checkpoint_commit'),
          );
        },
        async reserveBudget() {
          throw Error('Logical launcher fixture makes no physical provider request');
        },
        async reportBudgetUsage() {
          throw Error('No physical provider request');
        },
        async authorizeEffect(_payload, source) {
          await commit('effect_authorize', source);
          return { payload: { approvalStatus: 'approved' } } as never;
        },
        async reportEffectOutcome(_payload, source) {
          await commit('effect_complete', source);
          auditEffects++;
        },
      });
      calls.launcher.mockImplementation(async (prompt: string) => ({
        data: { value: prompt },
        tokenUsage: 1,
      }));
      checkpointMark(owned, 'initial_worker');
      if (scenario === 'missing-registration') {
        await expect(
          trackCheckpointExecution(owned, executeWorkflowRunnerV2AuthorityJob(
            workflow,
            descriptor,
            context(binding, 0),
            root,
            { callerId: 'workflow-runner-v2', client: {} as never },
            authority,
            recovery,
          )),
        ).rejects.toThrow(/registered send-campaign/);
        expect(calls.launcher).not.toHaveBeenCalled();
        expect(checkpointEvents).toBe(0);
        expect(auditEffects).toBe(0);
        expect(record.state).toBe('created');
        expect(record.revision).toBe(1);
        expect(failures).toEqual([]);
        return;
      }
      let approvalId = '';
      try {
        await trackCheckpointExecution(owned, executeWorkflowRunnerV2AuthorityJob(
          workflow,
          descriptor,
          context(binding, 0),
          root,
          { callerId: 'workflow-runner-v2', client: {} as never },
          authority,
          recovery,
        ));
      } catch (error) {
        if (!(error instanceof WorkflowEffectApprovalPendingError)) throw error;
        approvalId = error.approvalId;
      }
      expect(approvalId).not.toBe('');
      expect(calls.launcher).toHaveBeenCalledTimes(1);
      expect(checkpointEvents).toBe(1);
      expect(auditEffects).toBe(0);
      expect(record.state).toBe('paused_waiting_approval');
      checkpointMark(owned, 'fixture_human_decision');
      const human = createWorkflowEffectDecisionAuthority({
        workspaceId: record.workspaceId,
        humanPrincipalIds: ['fixture-human'],
        capabilities: ['workflow.effect.decide'],
        maxBindingTtlMs: 60_000,
      });
      let decisionNow = new Date().toISOString();
      const approvals = new LocalWorkflowEffectApprovalStore(
        join(root, '.openslack.local/workflows/effect-approvals'),
        human,
        () => decisionNow,
      );
      const pending = (await approvals.read(record.runId, approvalId))!;
      const decision = human.issueHumanDecisionBinding({
        principalId: 'fixture-human',
        capability: 'workflow.effect.decide',
        runId: record.runId,
        approvalId,
        correlationId: descriptor.correlationId,
        approvalExpiresAt: pending.expiresAt,
        decision: 'approved',
        reasonHash: '5'.repeat(64),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      });
      decisionNow = decision.issuedAt;
      await approvals.decide({
        runId: record.runId,
        approvalId,
        expectedRevision: 0,
        decision: 'approved',
        reasonHash: '5'.repeat(64),
        binding: decision,
      });
      const prior = (await reader.loadCheckpointControl(record.runId))!;
      const nextBinding = {
        ...binding,
        jobId: 'job.resume',
        attemptId: 'attempt.resume',
        leaseId: 'lease.resume',
      };
      activeAttempt = nextBinding.attemptId;
      const prospective: WorkflowCheckpointControlState = {
        ...prior,
        revision: prior.revision + 1,
        resumeGeneration: 1,
        activeBinding: nextBinding,
        seenBindingHashes: [...prior.seenBindingHashes, workflowCheckpointHash(nextBinding)],
        updatedAt: new Date().toISOString(),
      };
      const draft = recoveryFrame(prospective, 'resume_advance');
      const template = JSON.parse(JSON.parse(draft.stage).target.body);
      const target = prepareWorkflowControlAuthorityMessage({
        ...template,
        runRevision: record.revision,
        sentAt: prospective.updatedAt,
        payload: {
          acceptedAt: prospective.updatedAt,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      const planned = recoveryFrame(prospective, 'resume_advance', target);
      const stage = JSON.parse(planned.stage);
      frames.push({ ...planned, state: 'staged', resolution: null, resolutionReceipt: null });
      checkpointMark(owned, 'resume_commit');
      const resumed = await new WorkflowRunnerResumeSourceStore(
        root,
        JSON.parse(target.body),
        authority,
        recovery,
      ).commitResume(stage, JSON.parse(planned.stageReceipt));
      frames[frames.length - 1] = recoveryFrame(resumed, 'resume_advance', target);
      if (scenario === 'missing-artifact')
        await rm(reader.checkpointArtifactPath(record.runId, prior.checkpoints[0]!.artifactHash));
      const resumeContext = context(nextBinding, 1);
      if (scenario === 'cancelled-head') {
        const controller = checkpointController(owned);
        Object.defineProperty(resumeContext, 'signal', { value: controller.signal });
        const originalRead = authority.read.bind(authority);
        vi.spyOn(authority, 'read').mockImplementation(async (...args) => {
          if (record.state !== 'running') return originalRead(...args);
          expect(args[2]).toBe(controller.signal);
          return new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
              once: true,
            });
            queueMicrotask(() => controller.abort(new Error('fixture cancelled head read')));
          });
        });
      }
      checkpointMark(owned, 'resumed_worker');
      const execution = trackCheckpointExecution(owned, executeWorkflowRunnerV2AuthorityJob(
        workflow,
        descriptor,
        resumeContext,
        root,
        { callerId: 'workflow-runner-v2', client: {} as never },
        authority,
        recovery,
      ));
      if (scenario !== 'complete') {
        await expect(execution).rejects.toThrow(
          scenario === 'missing-artifact' ? /artifact/i : /cancelled/,
        );
        expect(calls.launcher).toHaveBeenCalledTimes(1);
        expect(checkpointEvents).toBe(1);
        expect(auditEffects).toBe(0);
        expect(failures).toEqual([]);
        return;
      }
      const result = await execution;
      expect(result).toMatchObject({
        status: 'completed',
        replay: {
          checkpointId: prior.checkpoints[0]!.checkpointId,
          revision: 2,
          resumeGeneration: 0,
          duplicate: true,
        },
      });
      expect(calls.launcher.mock.calls.map((c) => c[0])).toEqual(['first', 'second']);
      expect(checkpointEvents).toBe(4);
      expect(auditEffects).toBe(1);
      expect((await reader.loadCheckpointControl(record.runId))?.checkpoints).toHaveLength(4);
      expect(record.state).toBe('completed');
      expect(failures).toEqual([]);
    }
  }),
  platformTestTimeout(5_000),
);
