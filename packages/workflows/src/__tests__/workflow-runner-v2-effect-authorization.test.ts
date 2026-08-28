import { readdir, readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalWorkflowControlAuthorityJson } from '../workflow-control-authority-contract.js';
import { createWorkflowEffectDecisionAuthority } from '../workflow-effect-approval.js';
import { LocalWorkflowEffectApprovalStore } from '../workflow-effect-approval-store.js';
import type { WorkflowRunnerAuthorityBindingStage } from '../workflow-runner-authority-binding-contract.js';
import type { WorkflowRunnerAuthoritySourceAdapter } from '../workflow-runner-authority-binding-runtime.js';
import { createWorkflowRunnerV2EffectAuthorizationPort } from '../workflow-runner-v2-effect-authorization.js';
import { createWorkflowRunnerV2ExecutionDescriptor } from '../workflow-runner-v2-descriptor.js';
import type { WorkflowRunnerV2ExecutionContext } from '../workflow-runner-v2-session.js';
import { WORKFLOW_RUNNER_CAPABILITIES } from '../workflow-runner-contract.js';
import {
  WorkflowEffectApprovalPendingError,
  WorkflowEffectAuthorizationBusyError,
  WorkflowEffectReconciliationRequiredError,
} from '../internal/workflow-effect-authorization-contract.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function commitSource(
  operation: WorkflowRunnerAuthorityBindingStage['operation'],
  source?: WorkflowRunnerAuthoritySourceAdapter,
) {
  if (!source) throw new Error(`Missing ${operation} source adapter.`);
  const stage = { operation } as WorkflowRunnerAuthorityBindingStage;
  const probe = await source.probe(stage);
  return probe.state === 'committed' ? probe.evidence : source.commit(stage, {} as never);
}

async function fixture(suffix: string) {
  const secureTemporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  const workspaceRoot = await mkdtemp(join(secureTemporaryRoot, 'openslack-v2-effect-port-'));
  roots.push(workspaceRoot);
  let now = new Date().toISOString();
  const workflowRunId = `run.v2.effect.${suffix}`;
  const manifest = {
    name: 'v2-effect-test',
    version: '1.0.0',
    description: 'Exact v2 effect port test.',
    phases: [{ title: 'Run', detail: 'Run once.' }],
    risk: 'low' as const,
  };
  const descriptor = createWorkflowRunnerV2ExecutionDescriptor({
    descriptorRef: `descriptor.v2.effect.${suffix}`,
    workspaceId: 'workspace.effect.test',
    workflowRunId,
    correlationId: `correlation.v2.effect.${suffix}`,
    workflowId: manifest.name,
    workflowVersion: manifest.version,
    workflowSource: 'openslack-project',
    workflowSourceBytes: Buffer.from('exact effect source', 'utf8'),
    manifest,
    input: {},
    confirmationPolicy: {
      mode: 'unattended-explicit',
      actorId: 'effect-test',
      runId: workflowRunId,
      allowUnattended: true,
      onUnexpectedEffect: 'fail',
    },
    requiredCapabilities: WORKFLOW_RUNNER_CAPABILITIES,
    authorityRoute: {
      backend: 'go',
      authority: 'workflow-control',
      routingEpoch: 1,
      authorityBuildHash: 'a'.repeat(64),
    },
    runRevision: 1,
    resumeGeneration: 0,
    budgetPolicy: {
      accountId: 'budget.effect.test',
      policyHash: 'b'.repeat(64),
      rateNanoUsdPerToken: '10',
      tokenLimit: '1000',
      costLimitNanoUsd: '10000',
      callLimit: '2',
    },
    createdAt: new Date(Date.parse(now) - 60_000).toISOString(),
    expiresAt: new Date(Date.parse(now) + 60 * 60_000).toISOString(),
  });
  let authorize = async (
    _payload: Readonly<Record<string, unknown>>,
    source?: WorkflowRunnerAuthoritySourceAdapter,
  ) => {
    await commitSource('effect_authorize', source);
    return { payload: { approvalStatus: 'approved' } } as never;
  };
  let report = async (
    _payload: Readonly<Record<string, unknown>>,
    source?: WorkflowRunnerAuthoritySourceAdapter,
  ) => {
    await commitSource('effect_complete', source);
  };
  const context = {
    resumeGeneration: 0,
    authorizeEffect: (
      payload: Readonly<Record<string, unknown>>,
      source?: WorkflowRunnerAuthoritySourceAdapter,
    ) => authorize(payload, source),
    reportEffectOutcome: (
      payload: Readonly<Record<string, unknown>>,
      source?: WorkflowRunnerAuthoritySourceAdapter,
    ) => report(payload, source),
  } as unknown as WorkflowRunnerV2ExecutionContext;
  const makePort = () =>
    createWorkflowRunnerV2EffectAuthorizationPort({
      workspaceRoot,
      descriptor,
      context,
      now: () => now,
    });

  const seed = await makePort();
  const prepared = await seed.prepare({
    runId: workflowRunId,
    evaluationIndex: 1,
    operation: 'openslack.governance.audit',
    detail: 'bounded audit',
  });
  let approvalId: string | undefined;
  try {
    await seed.authorize(prepared);
  } catch (error) {
    if (error instanceof WorkflowEffectApprovalPendingError) approvalId = error.approvalId;
    else throw error;
  }
  if (!approvalId) throw new Error('Effect approval was not staged.');
  const decisionAuthority = createWorkflowEffectDecisionAuthority({
    workspaceId: descriptor.workspaceId,
    humanPrincipalIds: ['wsman'],
    capabilities: ['workflow.effect.decide'],
    maxBindingTtlMs: 60_000,
  });
  const approvals = new LocalWorkflowEffectApprovalStore(
    join(workspaceRoot, '.openslack.local', 'workflows', 'effect-approvals'),
    decisionAuthority,
    () => now,
  );
  const pending = await approvals.read(workflowRunId, approvalId);
  if (!pending) throw new Error('Pending effect approval is not point-readable.');
  const binding = decisionAuthority.issueHumanDecisionBinding({
    principalId: 'wsman',
    capability: 'workflow.effect.decide',
    runId: workflowRunId,
    approvalId,
    correlationId: descriptor.correlationId,
    approvalExpiresAt: pending.expiresAt,
    decision: 'approved',
    reasonHash: '5'.repeat(64),
    expiresAt: new Date(
      Math.min(Date.now() + 30_000, Date.parse(pending.expiresAt) - 1),
    ).toISOString(),
  });
  now = binding.issuedAt;
  await approvals.decide({
    runId: workflowRunId,
    approvalId,
    expectedRevision: 0,
    decision: 'approved',
    reasonHash: '5'.repeat(64),
    binding,
  });

  return {
    context,
    descriptor,
    makePort,
    workspaceRoot,
    workflowRunId,
    setAuthorize(value: typeof authorize) {
      authorize = value;
    },
    setReport(value: typeof report) {
      report = value;
    },
    setNow(value: string) {
      now = value;
    },
  };
}

async function prepareExact(value: Awaited<ReturnType<typeof fixture>>) {
  const port = await value.makePort();
  const prepared = await port.prepare({
    runId: value.workflowRunId,
    evaluationIndex: 1,
    operation: 'openslack.governance.audit',
    detail: 'bounded audit',
  });
  return { port, prepared };
}

describe('Workflow runner v2 effect authorization bridge', () => {
  it('allows exactly one concurrent owner for an exact effect occurrence', async () => {
    const value = await fixture('concurrent');
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    value.setAuthorize(async (_payload, source) => {
      arrived += 1;
      if (arrived === 2) release();
      await barrier;
      await commitSource('effect_authorize', source);
      return { payload: { approvalStatus: 'approved' } } as never;
    });
    const attempts = await Promise.all([prepareExact(value), prepareExact(value)]);
    const outcomes = await Promise.allSettled(
      attempts.map(({ port, prepared }) => port.authorize(prepared)),
    );
    const claimed = outcomes.flatMap((outcome, index) =>
      outcome.status === 'fulfilled' && outcome.value.disposition === 'claimed'
        ? [{ index, authority: outcome.value.authority }]
        : [],
    );
    expect(claimed).toHaveLength(1);
    expect(
      outcomes.filter(
        (outcome) =>
          outcome.status === 'rejected' &&
          outcome.reason instanceof WorkflowEffectAuthorizationBusyError,
      ),
    ).toHaveLength(1);
    const executeEffect = vi.fn(async () =>
      attempts[claimed[0]!.index]!.port.complete(claimed[0]!.authority, { ok: true }),
    );
    await executeEffect();
    expect(executeEffect).toHaveBeenCalledTimes(1);
    const restarted = await prepareExact(value);
    await expect(restarted.port.authorize(restarted.prepared)).resolves.toMatchObject({
      disposition: 'replay',
      value: { ok: true },
    });
    expect(executeEffect).toHaveBeenCalledTimes(1);
  });

  it('rejects a claim when authority expires while the Go decision is in flight', async () => {
    const value = await fixture('expiry');
    let reconciliationOutcomes = 0;
    value.setReport(async (payload, source) => {
      expect(payload.status).toBe('reconciliation_required');
      reconciliationOutcomes += 1;
      await commitSource('effect_complete', source);
    });
    value.setAuthorize(async (_payload, source) => {
      await commitSource('effect_authorize', source);
      value.setNow(value.descriptor.expiresAt);
      return { payload: { approvalStatus: 'approved' } } as never;
    });
    const attempt = await prepareExact(value);
    await expect(attempt.port.authorize(attempt.prepared)).rejects.toBeInstanceOf(
      WorkflowEffectReconciliationRequiredError,
    );
    expect(reconciliationOutcomes).toBe(1);
    const restarted = await prepareExact(value);
    await expect(restarted.port.authorize(restarted.prepared)).rejects.toBeInstanceOf(
      WorkflowEffectReconciliationRequiredError,
    );
  });

  it('rejects a canonical replay value splice whose stored hash was not recomputed', async () => {
    const value = await fixture('replay-splice');
    const attempt = await prepareExact(value);
    const authorization = await attempt.port.authorize(attempt.prepared);
    if (authorization.disposition !== 'claimed') throw new Error('Expected a fresh claim.');
    await attempt.port.complete(authorization.authority, { exact: 'A' });
    const records = join(
      value.workspaceRoot,
      '.openslack.local',
      'workflows',
      'effect-authority-v2-siblings',
      'records',
    );
    const names = await readdir(records);
    expect(names).toHaveLength(1);
    const path = join(records, names[0]!);
    const record = JSON.parse(await readFile(path, 'utf8')) as {
      replay: { kind: string; value: unknown; outcomeHash: string };
    };
    record.replay.value = { exact: 'B' };
    await writeFile(path, `${canonicalWorkflowControlAuthorityJson(record)}\n`, 'utf8');
    const restarted = await prepareExact(value);
    await expect(restarted.port.authorize(restarted.prepared)).rejects.toBeInstanceOf(
      WorkflowEffectReconciliationRequiredError,
    );
  });
});
