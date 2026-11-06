/** Offline fixture driven by TestGS9F2SealedCheckpointResume; no provider or external effect. */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadWorkflowFile } from '../../packages/workflows/src/internal/workflow-file-loader.js';
import { executeWorkflowThroughRunnerWithRuntime } from '../../packages/workflows/src/workflow-runner-execution-client.js';
import { WorkflowRunnerStatusClient } from '../../packages/workflows/src/workflow-runner-control-client.js';
import {
  createWorkflowRunRoutingExecutionContext,
  WORKFLOW_RUN_ROUTING_MODE_GO,
} from '../../packages/workflows/src/workflow-run-routing-config.js';
import { WorkflowRunRouter } from '../../packages/workflows/src/workflow-run-routing.js';
import { RunStore } from '../../packages/workflows/src/run-store.js';
import { resolveWorkflowRunProjectionRoot } from '../../packages/workflows/src/workflow-run-projection.js';
import { resolveWorkflowEffectApprovalRoot } from '../../packages/workflows/src/internal/workflow-effect-approval-layout.js';
import { createWorkflowEffectDecisionAuthority } from '../../packages/workflows/src/workflow-effect-approval.js';
import { LocalWorkflowEffectApprovalStore } from '../../packages/workflows/src/workflow-effect-approval-store.js';
import { createWorkflowDrainObserver } from '../../packages/workflows/src/internal/workflow-drain-observation.js';
import { WorkflowControlAuthorityHttpClient } from '../../packages/workflows/src/workflow-control-authority-client.js';

const config = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as {
  root: string;
  descriptorRoot: string;
  runnerOrigin: string;
  authorityOrigin: string;
  workspaceId: string;
  runnerToken: string;
  authorityToken: string;
  budgetOrigin: string;
  budgetToken: string;
  runnerBuild: string;
  authorityBuild: string;
};
const runId = 'run.checkpoint.worker';
const correlationId = 'correlation.checkpoint.worker';
const source = `export const meta={name:'checkpoint-worker',version:'1.0.0',description:'Offline checkpoint qualification',phases:[{title:'First',detail:'First'},{title:'Approval',detail:'Approval'},{title:'Done',detail:'Done'}],permissions:{openslack:['governance.audit']},sideEffects:['openslack.governance.audit'],risk:'medium'};
export async function run(ctx){ctx.phase('First');const replay=await ctx.checkpoint.commit({artifact:new TextEncoder().encode('first')});ctx.phase('Approval');await ctx.openslack.governance.audit('checkpoint-worker-fixture');await ctx.checkpoint.commit({artifact:new TextEncoder().encode('approved')});ctx.phase('Done');await ctx.checkpoint.commit({artifact:new TextEncoder().encode('done')});return {status:'completed',replay};}`;
const directory = join(config.root, '.openslack/workflows');
await mkdir(directory, { recursive: true });
const path = join(directory, 'checkpoint-worker.mjs');
await writeFile(path, source);
const workflow = await loadWorkflowFile(path);
const runner = {
  origin: config.runnerOrigin,
  workspaceId: config.workspaceId,
  bearerToken: config.runnerToken,
  descriptorRoot: config.descriptorRoot,
  expectedBuildHash: config.runnerBuild,
};
const routing = createWorkflowRunRoutingExecutionContext({
  runner,
  workspaceRoot: config.root,
  config: {
    mode: WORKFLOW_RUN_ROUTING_MODE_GO,
    router: new WorkflowRunRouter({
      schema: 'openslack.workflow_run_routing_policy.v1',
      workspaceId: config.workspaceId,
      backend: 'go',
      routingEpoch: 1,
      authorityBuildHash: config.authorityBuild,
      qualificationEnvironmentId: 'checkpoint.fixture',
      workflowAllowlist: [workflow.meta.name],
      runAllowlist: [],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }),
    authorityOptions: {
      origin: config.authorityOrigin,
      workspaceId: config.workspaceId,
      bearerToken: config.authorityToken,
      callerId: 'workflow-runner-v2',
      expectedBuildHash: config.authorityBuild,
    },
    v2BudgetPolicy: {
      accountId: 'checkpoint.fixture',
      policyHash: 'b'.repeat(64),
      rateNanoUsdPerToken: '1',
      tokenLimit: '1000',
      costLimitNanoUsd: '1000',
      callLimit: '2',
    },
    fingerprint: 'c'.repeat(64),
  },
});
const execute = () =>
  executeWorkflowThroughRunnerWithRuntime({
    workspaceRoot: config.root,
    workflowRunId: runId,
    correlationId,
    workflowSource: 'openslack-project',
    workflowSourceBytes: Buffer.from(source),
    sourceSnapshot: workflow.sourceSnapshot,
    manifest: workflow.meta,
    confirmationPolicy: {
      mode: 'unattended-explicit',
      actorId: 'qualification-host',
      runId,
      allowUnattended: true,
      onUnexpectedEffect: 'fail',
    },
    config: runner,
    client: new WorkflowRunnerStatusClient(runner),
    now: () => new Date(),
    routing,
  });
const initial = await execute();
assert.equal(initial.status, 'paused_waiting_approval');
const connection = (origin: string, bearerToken: string) => ({
  origin,
  bearerToken,
  callerId: 'workflow-runner-v2',
  buildHash: config.authorityBuild,
});
const drain = createWorkflowDrainObserver({
  workspaceRoot: config.root,
  workspaceId: config.workspaceId,
  route: {
    backend: 'go',
    authority: 'workflow-control',
    routingEpoch: 1,
    authorityBuildHash: config.authorityBuild,
  },
  authority: connection(config.authorityOrigin, config.authorityToken),
  runner: connection(config.runnerOrigin, config.runnerToken),
  budget: connection(config.budgetOrigin, config.budgetToken),
  authorityClient: new WorkflowControlAuthorityHttpClient({
    origin: config.authorityOrigin,
    workspaceId: config.workspaceId,
    callerId: 'workflow-runner-v2',
    bearerToken: config.authorityToken,
    expectedBuildHash: config.authorityBuild,
  }),
});
const pausedDrain = await drain.read(new AbortController().signal);
assert.equal(pausedDrain.activeRuns, 1);
assert.equal(pausedDrain.pendingEffects, 1);
assert.equal(pausedDrain.outboxDrained, false);
assert.equal(pausedDrain.admissionClosed, false);
const reader = new RunStore({
  baseDir: resolveWorkflowRunProjectionRoot(config.root, 'go'),
  access: 'read-only',
});
const original = await reader.loadCheckpointControl(runId);
assert.equal(original?.checkpoints.length, 1);
assert.equal((await reader.readAuditRecords(runId)).length, 0);
const approvalRoot = resolveWorkflowEffectApprovalRoot(config.root);
const records = await readdir(join(approvalRoot, 'records'));
assert.equal(records.length, 1);
const recorded = JSON.parse(await readFile(join(approvalRoot, 'records', records[0]!), 'utf8')) as {
  approvalId: string;
};
const human = createWorkflowEffectDecisionAuthority({
  workspaceId: config.workspaceId,
  humanPrincipalIds: ['fixture-human'],
  capabilities: ['workflow.effect.decide'],
  maxBindingTtlMs: 60_000,
});
let decisionNow = new Date().toISOString();
const store = new LocalWorkflowEffectApprovalStore(approvalRoot, human, () => decisionNow);
const pending = (await store.read(runId, recorded.approvalId))!;
const binding = human.issueHumanDecisionBinding({
  principalId: 'fixture-human',
  capability: 'workflow.effect.decide',
  runId,
  approvalId: pending.approvalId,
  correlationId,
  approvalExpiresAt: pending.expiresAt,
  decision: 'approved',
  reasonHash: '5'.repeat(64),
  expiresAt: new Date(Date.now() + 30_000).toISOString(),
});
decisionNow = binding.issuedAt;
await store.decide({
  runId,
  approvalId: pending.approvalId,
  expectedRevision: 0,
  decision: 'approved',
  reasonHash: '5'.repeat(64),
  binding,
});
const resumed = await execute();
assert.equal(resumed.status, 'completed');
const final = (await reader.loadCheckpointControl(runId))!;
assert.equal(final.resumeGeneration, 1);
assert.equal(final.checkpoints.length, 3);
assert.deepEqual(final.checkpoints[0], original!.checkpoints[0]);
assert.equal((await reader.readAuditRecords(runId)).length, 1);
const completedDrain = await drain.read(new AbortController().signal);
assert.equal(completedDrain.activeRuns, 0);
assert.equal(completedDrain.pendingEffects, 0);
assert.equal(completedDrain.runnerDrained, true);
assert.equal(completedDrain.openReservations, 0);
assert.equal(completedDrain.outboxDrained, false); // Real durable outbox remains unpublished.
process.stdout.write(
  JSON.stringify({
    status: 'PASS',
    initial: initial.status,
    resumed: resumed.status,
    checkpointCount: final.checkpoints.length,
    originalCheckpoint: final.checkpoints[0],
    auditEffects: 1,
    pausedDrain,
    completedDrain,
    drainEvidence: drain.evidence(),
  }) + '\n',
);
