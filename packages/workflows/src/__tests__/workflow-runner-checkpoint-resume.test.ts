import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
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
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  calls.launcher.mockReset();
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

it.each(['complete', 'missing-artifact', 'cancelled-head'] as const)(
  'runs the real worker canonical-resume path: %s',
  async (scenario) => {
    const root = testTemporaryDirectory('checkpoint-worker-resume-');
    roots.push(root);
    const source = `export const meta={name:'checkpoint-resume-test',version:'1.0.0',description:'Checkpoint resume regression',phases:[{title:'First',detail:'First'},{title:'Approval',detail:'Approval'},{title:'Second',detail:'Second'},{title:'Done',detail:'Done'}],permissions:{openslack:['governance.audit']},sideEffects:['openslack.governance.audit'],risk:'medium'};
export async function run(ctx){ctx.phase('First');const first=await ctx.agent('first',{agentType:'unresolved-fixture',label:'first',phase:'First',budget:{tokens:100}});const replay=await ctx.checkpoint.commit({artifact:new TextEncoder().encode(JSON.stringify(first))});ctx.phase('Approval');await ctx.openslack.governance.audit('checkpoint-resume-marker');await ctx.checkpoint.commit({artifact:new TextEncoder().encode('approved')});ctx.phase('Second');await ctx.agent('second',{agentType:'unresolved-fixture',label:'second',phase:'Second',budget:{tokens:100}});await ctx.checkpoint.commit({artifact:new TextEncoder().encode('second')});ctx.phase('Done');await ctx.checkpoint.commit({artifact:new TextEncoder().encode('done')});return {status:'completed',replay};}`;
    const sourceDirectory = join(root, '.openslack', 'workflows');
    await mkdir(sourceDirectory, { recursive: true });
    const sourcePath = join(sourceDirectory, 'checkpoint-resume-test.mjs');
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
    const failures: unknown[] = [];
    const server = createServer(async (request, response) => {
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
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
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
        signal: new AbortController().signal,
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
      let approvalId = '';
      try {
        await executeWorkflowRunnerV2AuthorityJob(
          workflow,
          descriptor,
          context(binding, 0),
          root,
          { callerId: 'workflow-runner-v2', client: {} as never },
          authority,
          recovery,
        );
      } catch (error) {
        if (!(error instanceof WorkflowEffectApprovalPendingError)) throw error;
        approvalId = error.approvalId;
      }
      expect(approvalId).not.toBe('');
      expect(calls.launcher).toHaveBeenCalledTimes(1);
      expect(checkpointEvents).toBe(1);
      expect(auditEffects).toBe(0);
      expect(record.state).toBe('paused_waiting_approval');
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
        const controller = new AbortController();
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
      const execution = executeWorkflowRunnerV2AuthorityJob(
        workflow,
        descriptor,
        resumeContext,
        root,
        { callerId: 'workflow-runner-v2', client: {} as never },
        authority,
        recovery,
      );
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
    } finally {
      await new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())));
    }
  },
  platformTestTimeout(5_000),
);
