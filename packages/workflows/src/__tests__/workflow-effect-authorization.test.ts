import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyWorkflowEffectApprovalDecision,
  createWorkflowEffectDecisionAuthority,
  workflowEffectApprovalBytes,
  workflowEffectApprovalAuditEventId,
} from '../workflow-effect-approval.js';
import { LocalWorkflowEffectApprovalStore } from '../workflow-effect-approval-store.js';
import { executeRunWithStore } from '../execute.js';
import { createRuntimeWithHostAuthorities } from '../runtime.js';
import { RunStore } from '../run-store.js';
import { canonicalWorkflowEffectControlJson } from '../workflow-effect-control-contract.js';
import {
  createWorkflowEffectAuthorizationPort,
  WorkflowEffectReconciliationRequiredError,
  WorkflowEffectApprovalPendingError,
  type WorkflowEffectAuthorizationPort,
} from '../workflow-effect-authorization.js';
import { createWorkflowCheckpointLeaseAuthority } from '../internal/workflow-checkpoint-lease-authority.js';
import {
  LocalWorkflowEffectAuthorityStore,
  prepareWorkflowEffectAuthorityDecision,
} from '../workflow-effect-authority-store.js';
import {
  createWorkflowEffectLeaseAuthority,
  type WorkflowEffectLeaseBinding,
} from '../internal/workflow-effect-lease-authority.js';
import {
  createWorkflowRunnerEventReceipt,
  prepareWorkflowRunnerMessage,
  validateWorkflowRunnerMessage,
  WORKFLOW_RUNNER_PROTOCOL_VERSION,
  type WorkflowRunnerEffectIntentMessage,
} from '../workflow-runner-contract.js';
import type { WorkflowRuntime } from '../types.js';

const BUILD_HASH = '1'.repeat(64);
const SOURCE_HASH = '2'.repeat(64);
const MANIFEST_HASH = '3'.repeat(64);
const INPUT_HASH = '4'.repeat(64);
const REASON_HASH = '5'.repeat(64);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(nowValue = new Date().toISOString(), descriptorTtlMs = 60 * 60_000) {
  const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  const workspaceRoot = await mkdtemp(join(temporaryRoot, 'openslack-effect-authority-'));
  roots.push(workspaceRoot);
  const approvalRoot = join(workspaceRoot, '.openslack.local', 'workflows', 'effect-approvals');
  await mkdir(approvalRoot, { recursive: true, mode: 0o700 });
  let now = nowValue;
  let sequence = 2;
  const binding: WorkflowEffectLeaseBinding = {
    workspaceId: 'workspace-1',
    runId: 'run-1',
    correlationId: 'correlation-1',
    workflowId: 'workflow-1',
    workflowVersion: '1.0.0',
    workflowSourceHash: SOURCE_HASH,
    manifestHash: MANIFEST_HASH,
    inputHash: INPUT_HASH,
    descriptorExpiresAt: new Date(Date.parse(nowValue) + descriptorTtlMs).toISOString(),
    expectedControlBuildHash: BUILD_HASH,
    async emitIntent(handle, beforeSend) {
      const message = validateWorkflowRunnerMessage({
        protocolVersion: WORKFLOW_RUNNER_PROTOCOL_VERSION,
        kind: 'effect_intent',
        workspaceId: 'workspace-1',
        jobId: 'job-1',
        workflowRunId: 'run-1',
        attemptId: 'attempt-1',
        leaseId: 'lease-1',
        fencingToken: 1,
        sequence,
        eventId: `event-${sequence}`,
        correlationId: 'correlation-1',
        sentAt: now,
        payload: handle,
      }) as WorkflowRunnerEffectIntentMessage;
      const prepared = prepareWorkflowRunnerMessage(message);
      await beforeSend({ message, prepared });
      const receipt = createWorkflowRunnerEventReceipt(message, {
        status: 'accepted',
        errorCode: null,
        sequence: sequence + 1,
        sentAt: now,
        controlBuildHash: BUILD_HASH,
      });
      sequence += 2;
      return { message, prepared, receipt };
    },
  };
  const boundary = Object.freeze({
    intent: vi.fn(),
    outcome: vi.fn(),
  });
  const makePort = (
    overrides: Partial<WorkflowEffectLeaseBinding> = {},
  ): WorkflowEffectAuthorizationPort =>
    createWorkflowEffectAuthorizationPort({
      workspaceRoot,
      effectBoundary: boundary,
      leaseAuthority: createWorkflowEffectLeaseAuthority({ ...binding, ...overrides }),
      now: () => now,
    });
  const decisionAuthority = createWorkflowEffectDecisionAuthority({
    workspaceId: binding.workspaceId,
    humanPrincipalIds: ['wsman'],
    capabilities: ['workflow.effect.decide'],
    maxBindingTtlMs: 60_000,
  });
  const approvals = new LocalWorkflowEffectApprovalStore(
    approvalRoot,
    decisionAuthority,
    () => now,
  );
  return {
    approvalRoot,
    approvals,
    binding,
    boundary,
    decisionAuthority,
    makePort,
    workspaceRoot,
    getNow: () => now,
    setNow(value: string) {
      now = value;
    },
  };
}

async function createPending(port: WorkflowEffectAuthorizationPort) {
  const prepared = await port.prepare({
    runId: 'run-1',
    evaluationIndex: 1,
    operation: 'openslack.governance.audit',
    detail: 'bounded audit',
  });
  let pending: WorkflowEffectApprovalPendingError | undefined;
  try {
    await port.authorize(prepared);
  } catch (error) {
    if (error instanceof WorkflowEffectApprovalPendingError) pending = error;
    else throw error;
  }
  expect(pending).toBeInstanceOf(WorkflowEffectApprovalPendingError);
  return { prepared, pending: pending! };
}

async function approve(value: Awaited<ReturnType<typeof fixture>>, approvalId: string) {
  const pending = await value.approvals.read('run-1', approvalId);
  expect(pending?.status).toBe('pending');
  const binding = value.decisionAuthority.issueHumanDecisionBinding({
    principalId: 'wsman',
    capability: 'workflow.effect.decide',
    runId: 'run-1',
    approvalId,
    correlationId: 'correlation-1',
    approvalExpiresAt: pending!.expiresAt,
    decision: 'approved',
    reasonHash: REASON_HASH,
    expiresAt: new Date(Date.parse(value.getNow()) + 30_000).toISOString(),
  });
  value.setNow(binding.issuedAt);
  const decided = await value.approvals.decide({
    runId: 'run-1',
    approvalId,
    expectedRevision: 0,
    decision: 'approved',
    reasonHash: REASON_HASH,
    binding,
  });
  return { binding, decided };
}

async function reject(value: Awaited<ReturnType<typeof fixture>>, approvalId: string) {
  const pending = await value.approvals.read('run-1', approvalId);
  expect(pending?.status).toBe('pending');
  const binding = value.decisionAuthority.issueHumanDecisionBinding({
    principalId: 'wsman',
    capability: 'workflow.effect.decide',
    runId: 'run-1',
    approvalId,
    correlationId: 'correlation-1',
    approvalExpiresAt: pending!.expiresAt,
    decision: 'rejected',
    reasonHash: REASON_HASH,
    expiresAt: new Date(Date.parse(value.getNow()) + 30_000).toISOString(),
  });
  value.setNow(binding.issuedAt);
  return value.approvals.decide({
    runId: 'run-1',
    approvalId,
    expectedRevision: 0,
    decision: 'rejected',
    reasonHash: REASON_HASH,
    binding,
  });
}

async function recordFiles(value: Awaited<ReturnType<typeof fixture>>) {
  const directory = join(
    value.workspaceRoot,
    '.openslack.local',
    'workflows',
    'effect-authority',
    'records',
  );
  return Promise.all(
    (await readdir(directory)).map(async (name) => ({
      path: join(directory, name),
      value: JSON.parse(await readFile(join(directory, name), 'utf8')) as Record<string, unknown>,
    })),
  );
}

async function writeCanonical(path: string, value: unknown) {
  await writeFile(path, `${canonicalWorkflowEffectControlJson(value)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function hostRuntime(
  value: Awaited<ReturnType<typeof fixture>>,
  runStore: RunStore,
  options: {
    readonly onConfirm?: () => Promise<boolean>;
    readonly signal?: AbortSignal;
  } = {},
) {
  return createRuntimeWithHostAuthorities(
    {
      runId: value.binding.runId,
      mode: 'execute',
      manifest: {
        name: value.binding.workflowId,
        version: value.binding.workflowVersion,
        description: 'D2 exact authorization runtime test.',
        phases: [{ title: 'Run', detail: 'Run once.' }],
        risk: 'low',
      },
      onConfirm: options.onConfirm ?? (async () => true),
      signal: options.signal,
      effectBoundary: value.boundary,
      runStore,
    },
    createWorkflowCheckpointLeaseAuthority({
      workspaceId: value.binding.workspaceId,
      jobId: 'job-1',
      workflowRunId: value.binding.runId,
      attemptId: 'attempt-1',
      leaseId: 'lease-1',
      fencingToken: 1,
      correlationId: value.binding.correlationId,
      runnerBuildHash: BUILD_HASH,
      workflowSourceHash: value.binding.workflowSourceHash,
      manifestHash: value.binding.manifestHash,
      inputHash: value.binding.inputHash,
    }),
    value.makePort(),
  );
}

describe('workflow effect D2 authorization', () => {
  it('closes the runner boundary and latches the run while exact approval is pending', async () => {
    const value = await fixture();
    const appendAuditRecord = vi.fn(async () => undefined);
    const runtime = hostRuntime(value, {
      appendAuditRecord,
      appendLog: vi.fn(async () => undefined),
    } as unknown as RunStore);

    await expect(runtime.openslack.governance.audit('bounded audit')).rejects.toBeInstanceOf(
      WorkflowEffectApprovalPendingError,
    );
    expect(value.boundary.outcome).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        status: 'failed',
        evidence: expect.objectContaining({ code: 'WORKFLOW_EFFECT_APPROVAL_PENDING' }),
      }),
    );
    await expect(runtime.openslack.governance.audit('successor audit')).rejects.toBeInstanceOf(
      WorkflowEffectApprovalPendingError,
    );
    expect(() =>
      (runtime as unknown as { assertEffectTerminalState(): void }).assertEffectTerminalState(),
    ).toThrow(WorkflowEffectApprovalPendingError);
    expect(appendAuditRecord).not.toHaveBeenCalled();
    expect(await recordFiles(value)).toHaveLength(1);
  });

  it('keeps a caught pending decision paused at the authenticated worker boundary', async () => {
    const value = await fixture();
    const store = new RunStore({
      baseDir: join(value.workspaceRoot, '.openslack.local', 'workflows'),
    });
    const workflow = {
      hash: SOURCE_HASH,
      meta: {
        name: value.binding.workflowId,
        version: value.binding.workflowVersion,
        description: 'D2 pending run-state integration.',
        phases: [{ title: 'Run', detail: 'Run once.' }],
        risk: 'low' as const,
      },
      async run(ctx: WorkflowRuntime) {
        try {
          await ctx.openslack.governance.audit('bounded audit');
        } catch (error) {
          expect(error).toBeInstanceOf(WorkflowEffectApprovalPendingError);
        }
        return { status: 'completed' as const };
      },
    };
    const checkpointAuthority = createWorkflowCheckpointLeaseAuthority({
      workspaceId: value.binding.workspaceId,
      jobId: 'job-1',
      workflowRunId: value.binding.runId,
      attemptId: 'attempt-1',
      leaseId: 'lease-1',
      fencingToken: 1,
      correlationId: value.binding.correlationId,
      runnerBuildHash: BUILD_HASH,
      workflowSourceHash: SOURCE_HASH,
      manifestHash: MANIFEST_HASH,
      inputHash: INPUT_HASH,
    });

    await expect(
      executeRunWithStore(
        workflow,
        {
          runId: value.binding.runId,
          manifest: workflow.meta,
          args: {},
          budget: { tokens: 1_000, costUsd: 1 },
          onConfirm: async () => true,
          rootDir: value.workspaceRoot,
          effectBoundary: value.boundary,
        },
        store,
        checkpointAuthority,
        value.makePort(),
      ),
    ).rejects.toBeInstanceOf(WorkflowEffectApprovalPendingError);
    await expect(store.loadStatus(value.binding.runId)).resolves.toMatchObject({
      status: 'paused_waiting_approval',
    });
    await expect(store.loadOutput(value.binding.runId)).resolves.toBeNull();
  });

  it('reports only the exact v2 rejection as a rejected runner outcome', async () => {
    const value = await fixture();
    const { pending } = await createPending(value.makePort());
    await reject(value, pending.approvalId);
    value.boundary.outcome.mockClear();
    const runtime = hostRuntime(value, {
      appendAuditRecord: vi.fn(async () => undefined),
      appendLog: vi.fn(async () => undefined),
    } as unknown as RunStore);

    await expect(runtime.openslack.governance.audit('bounded audit')).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_AUTHORIZATION_REJECTED',
    });
    expect(value.boundary.outcome).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        status: 'rejected',
        evidence: expect.objectContaining({ approvalId: pending.approvalId }),
      }),
    );
  });

  it('executes an approved effect once and returns the durable replay on runtime restart', async () => {
    const value = await fixture();
    const { pending } = await createPending(value.makePort());
    await approve(value, pending.approvalId);
    const appendAuditRecord = vi.fn(async () => undefined);
    const runStore = {
      appendAuditRecord,
      appendLog: vi.fn(async () => undefined),
    } as unknown as RunStore;
    const makeRuntime = () =>
      createRuntimeWithHostAuthorities(
        {
          runId: value.binding.runId,
          mode: 'execute',
          manifest: {
            name: value.binding.workflowId,
            version: value.binding.workflowVersion,
            description: 'D2 exact authorization runtime test.',
            phases: [{ title: 'Run', detail: 'Run once.' }],
            risk: 'low',
          },
          onConfirm: async () => true,
          effectBoundary: value.boundary,
          runStore,
        },
        createWorkflowCheckpointLeaseAuthority({
          workspaceId: value.binding.workspaceId,
          jobId: 'job-1',
          workflowRunId: value.binding.runId,
          attemptId: 'attempt-1',
          leaseId: 'lease-1',
          fencingToken: 1,
          correlationId: value.binding.correlationId,
          runnerBuildHash: BUILD_HASH,
          workflowSourceHash: value.binding.workflowSourceHash,
          manifestHash: value.binding.manifestHash,
          inputHash: value.binding.inputHash,
        }),
        value.makePort(),
      );

    await expect(
      makeRuntime().openslack.governance.audit('bounded audit'),
    ).resolves.toBeUndefined();
    await expect(
      makeRuntime().openslack.governance.audit('bounded audit'),
    ).resolves.toBeUndefined();
    expect(appendAuditRecord).toHaveBeenCalledOnce();
    expect(value.boundary.outcome).toHaveBeenCalledTimes(2);
  });

  it('cancels before claim and after durable outcome at the closed D2 boundaries', async () => {
    const before = await fixture();
    const beforePending = await createPending(before.makePort());
    await approve(before, beforePending.pending.approvalId);
    const beforeController = new AbortController();
    const beforeStore = {
      appendAuditRecord: vi.fn(async () => undefined),
      appendLog: vi.fn(async () => undefined),
    } as unknown as RunStore;
    const beforeRuntime = hostRuntime(before, beforeStore, {
      signal: beforeController.signal,
      onConfirm: async () => {
        beforeController.abort(new Error('cancel before claim'));
        return true;
      },
    });
    await expect(beforeRuntime.openslack.governance.audit('bounded audit')).rejects.toMatchObject({
      name: 'WorkflowExecutionCancelledError',
      boundary: 'effect_execution',
    });
    expect(beforeStore.appendAuditRecord).not.toHaveBeenCalled();

    const after = await fixture();
    const afterPending = await createPending(after.makePort());
    await approve(after, afterPending.pending.approvalId);
    const afterController = new AbortController();
    after.boundary.outcome.mockImplementation(async () => {
      afterController.abort(new Error('cancel after durable outcome'));
    });
    const afterStore = {
      appendAuditRecord: vi.fn(async () => undefined),
      appendLog: vi.fn(async () => undefined),
    } as unknown as RunStore;
    const afterRuntime = hostRuntime(after, afterStore, { signal: afterController.signal });
    await expect(afterRuntime.openslack.governance.audit('bounded audit')).rejects.toMatchObject({
      name: 'WorkflowExecutionCancelledError',
      boundary: 'effect_outcome',
    });
    expect(afterStore.appendAuditRecord).toHaveBeenCalledOnce();
    await expect(
      hostRuntime(after, afterStore).openslack.governance.audit('bounded audit'),
    ).resolves.toBeUndefined();
    expect(afterStore.appendAuditRecord).toHaveBeenCalledOnce();
  });

  it('requires an exact v2 decision, claims once, and replays after restart', async () => {
    const value = await fixture();
    const first = value.makePort();
    const { pending } = await createPending(first);
    await approve(value, pending.approvalId);

    const resumed = value.makePort();
    const prepared = await resumed.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    const claim = await resumed.authorize(prepared);
    expect(claim.disposition).toBe('claimed');
    if (claim.disposition !== 'claimed') throw new Error('expected claim');
    await resumed.complete(claim.authority, { ok: true });

    const restarted = value.makePort();
    const replayPrepared = await restarted.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(restarted.authorize(replayPrepared)).resolves.toMatchObject({
      disposition: 'replay',
      value: { ok: true },
      executionId: claim.executionId,
    });
  });

  it('rejects a terminal human rejection without creating an execution claim', async () => {
    const value = await fixture();
    const { pending } = await createPending(value.makePort());
    await reject(value, pending.approvalId);
    const port = value.makePort();
    const prepared = await port.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(port.authorize(prepared)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_AUTHORIZATION_REJECTED',
    });
    const claims = join(
      value.workspaceRoot,
      '.openslack.local',
      'workflows',
      'effect-authority',
      'claims',
    );
    expect(await readdir(claims)).toEqual([]);
  });

  it('fails closed on workflow, input, correlation, and effect identity drift', async () => {
    const value = await fixture();
    await createPending(value.makePort());
    for (const overrides of [
      { workflowSourceHash: 'a'.repeat(64) },
      { manifestHash: 'b'.repeat(64) },
      { inputHash: 'c'.repeat(64) },
      { correlationId: 'correlation-drift' },
    ] satisfies Array<Partial<WorkflowEffectLeaseBinding>>) {
      const port = value.makePort(overrides);
      await expect(
        port.prepare({
          runId: 'run-1',
          evaluationIndex: 1,
          operation: 'openslack.governance.audit',
          detail: 'bounded audit',
        }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH' });
    }
    await expect(
      value.makePort().prepare({
        runId: 'run-1',
        evaluationIndex: 1,
        operation: 'openslack.governance.audit',
        detail: 'different effect detail',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH' });
  });

  it('rejects a valid D1 artifact copied across two durable occurrences', async () => {
    const value = await fixture();
    const first = await createPending(value.makePort());
    await approve(value, first.pending.approvalId);
    const secondPort = value.makePort();
    const secondPrepared = await secondPort.prepare({
      runId: 'run-1',
      evaluationIndex: 2,
      operation: 'openslack.governance.audit',
      detail: 'second audit',
    });
    let secondPending: WorkflowEffectApprovalPendingError | undefined;
    try {
      await secondPort.authorize(secondPrepared);
    } catch (error) {
      if (error instanceof WorkflowEffectApprovalPendingError) secondPending = error;
      else throw error;
    }
    await approve(value, secondPending!.approvalId);
    const records = await recordFiles(value);
    const firstRecord = records.find((entry) => entry.value.evaluationIndex === 1)!;
    const secondRecord = records.find((entry) => entry.value.evaluationIndex === 2)!;
    firstRecord.value.artifact = secondRecord.value.artifact;
    await writeCanonical(firstRecord.path, firstRecord.value);

    await expect(
      value.makePort().prepare({
        runId: 'run-1',
        evaluationIndex: 1,
        operation: 'openslack.governance.audit',
        detail: 'bounded audit',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH' });
  });

  it('rechecks the host-minted occurrence identity inside the claim lock', async () => {
    const value = await fixture();
    const first = await createPending(value.makePort());
    await approve(value, first.pending.approvalId);
    const secondPort = value.makePort();
    const secondPrepared = await secondPort.prepare({
      runId: 'run-1',
      evaluationIndex: 2,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    let secondPending: WorkflowEffectApprovalPendingError | undefined;
    try {
      await secondPort.authorize(secondPrepared);
    } catch (error) {
      if (error instanceof WorkflowEffectApprovalPendingError) secondPending = error;
      else throw error;
    }
    await approve(value, secondPending!.approvalId);

    const files = await recordFiles(value);
    const firstFile = files.find((entry) => entry.value.evaluationIndex === 1)!;
    const secondFile = files.find((entry) => entry.value.evaluationIndex === 2)!;
    const store = new LocalWorkflowEffectAuthorityStore(value.approvalRoot, value.getNow);
    const preparedOccurrence = await store.find(
      value.binding,
      1,
      firstFile.value.effectKind as string,
      firstFile.value.effectId as string,
      firstFile.value.effectHash as string,
    );
    await writeFile(firstFile.path, await readFile(secondFile.path));
    await expect(store.claim(preparedOccurrence!)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_AUTHORITY_IDENTITY_MISMATCH',
    });
  });

  it('rejects an executed replay whose outcome hash was changed independently', async () => {
    const value = await fixture();
    const { pending } = await createPending(value.makePort());
    await approve(value, pending.approvalId);
    const port = value.makePort();
    const prepared = await port.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    const claim = await port.authorize(prepared);
    expect(claim.disposition).toBe('claimed');
    if (claim.disposition !== 'claimed') throw new Error('expected claim');
    await port.complete(claim.authority, { ok: true });
    const claims = join(
      value.workspaceRoot,
      '.openslack.local',
      'workflows',
      'effect-authority',
      'claims',
    );
    const [claimName] = await readdir(claims);
    const claimPath = join(claims, claimName!);
    const execution = JSON.parse(await readFile(claimPath, 'utf8')) as Record<string, unknown>;
    (execution.artifact as Record<string, unknown>).outcomeHash = 'f'.repeat(64);
    await writeCanonical(claimPath, execution);

    const retry = value.makePort();
    const retryPrepared = await retry.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(retry.authorize(retryPrepared)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_AUTHORITY_RECORD_INVALID',
    });
  });

  it('fails closed when a consumed claim file disappears but its authority high-watermark remains', async () => {
    const value = await fixture();
    const { pending } = await createPending(value.makePort());
    await approve(value, pending.approvalId);
    const port = value.makePort();
    const prepared = await port.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    const claim = await port.authorize(prepared);
    if (claim.disposition !== 'claimed') throw new Error('expected claim');
    await port.complete(claim.authority, { ok: true });
    const claims = join(
      value.workspaceRoot,
      '.openslack.local',
      'workflows',
      'effect-authority',
      'claims',
    );
    const [claimName] = await readdir(claims);
    await rm(join(claims, claimName!));

    const retry = value.makePort();
    const retryPrepared = await retry.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(retry.authorize(retryPrepared)).rejects.toBeInstanceOf(
      WorkflowEffectReconciliationRequiredError,
    );
  });

  it('does not treat a bare terminal v2 record as execution authority', async () => {
    const value = await fixture();
    const first = await createPending(value.makePort());
    await rm(join(value.workspaceRoot, '.openslack.local', 'workflows', 'effect-authority'), {
      recursive: true,
      force: true,
    });
    await approve(value, first.pending.approvalId);

    const port = value.makePort();
    await expect(
      port.prepare({
        runId: 'run-1',
        evaluationIndex: 1,
        operation: 'openslack.governance.audit',
        detail: 'bounded audit',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_RECONCILIATION_REQUIRED' });
  });

  it.runIf(process.platform !== 'win32')(
    'requires owner-only directories and files for the canonical D2 store',
    async () => {
      const value = await fixture();
      await createPending(value.makePort());
      const authorityRoot = join(
        value.workspaceRoot,
        '.openslack.local',
        'workflows',
        'effect-authority',
      );
      for (const path of [
        value.approvalRoot,
        join(value.approvalRoot, 'records'),
        join(value.approvalRoot, 'locks'),
        authorityRoot,
        join(authorityRoot, 'records'),
        join(authorityRoot, 'claims'),
        join(authorityRoot, 'locks'),
      ]) {
        expect((await stat(path)).mode & 0o077).toBe(0);
      }
      const [authority] = await recordFiles(value);
      expect((await stat(authority!.path)).mode & 0o077).toBe(0);
      await chmod(authority!.path, 0o644);
      await expect(
        value.makePort().prepare({
          runId: 'run-1',
          evaluationIndex: 1,
          operation: 'openslack.governance.audit',
          detail: 'bounded audit',
        }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE' });

      await chmod(authority!.path, 0o600);
      await chmod(value.approvalRoot, 0o755);
      const drifted = value.makePort();
      const prepared = await drifted.prepare({
        runId: 'run-1',
        evaluationIndex: 1,
        operation: 'openslack.governance.audit',
        detail: 'bounded audit',
      });
      await expect(drifted.authorize(prepared)).rejects.toMatchObject({
        code: 'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
      });
    },
  );

  it('rejects a forged authority lock without deleting it', async () => {
    const value = await fixture();
    await createPending(value.makePort());
    const lock = join(
      value.workspaceRoot,
      '.openslack.local',
      'workflows',
      'effect-authority',
      'locks',
      'authority.lock',
    );
    await writeFile(lock, '{}\n', { encoding: 'utf8', mode: 0o600 });

    await expect(
      value.makePort().prepare({
        runId: 'run-1',
        evaluationIndex: 1,
        operation: 'openslack.governance.audit',
        detail: 'bounded audit',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE' });
    await expect(readFile(lock, 'utf8')).resolves.toBe('{}\n');
  });

  it('fails closed when the bounded authority-store entry budget is exhausted', async () => {
    const value = await fixture();
    await createPending(value.makePort());
    const claims = join(
      value.workspaceRoot,
      '.openslack.local',
      'workflows',
      'effect-authority',
      'claims',
    );
    const names = Array.from(
      { length: 4_095 },
      (_, index) => `${(index + 1).toString(16).padStart(64, '0')}.json`,
    );
    for (let offset = 0; offset < names.length; offset += 128) {
      await Promise.all(
        names
          .slice(offset, offset + 128)
          .map((name) => writeFile(join(claims, name), '', { mode: 0o600 })),
      );
    }
    await expect(
      value.makePort().prepare({
        runId: 'run-1',
        evaluationIndex: 1,
        operation: 'openslack.governance.audit',
        detail: 'bounded audit',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_AUTHORITY_LIMIT_EXCEEDED' });
  });

  it('keeps identical effect contents distinct by deterministic evaluation occurrence', async () => {
    const value = await fixture();
    const port = value.makePort();
    const first = await createPending(port);
    await approve(value, first.pending.approvalId);
    const resumedFirst = value.makePort();
    const firstPrepared = await resumedFirst.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    const firstClaim = await resumedFirst.authorize(firstPrepared);
    expect(firstClaim.disposition).toBe('claimed');
    if (firstClaim.disposition !== 'claimed') throw new Error('expected first claim');
    await resumedFirst.complete(firstClaim.authority, undefined);

    const secondPrepared = await port.prepare({
      runId: 'run-1',
      evaluationIndex: 2,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    let secondPending: WorkflowEffectApprovalPendingError | undefined;
    try {
      await port.authorize(secondPrepared);
    } catch (error) {
      if (error instanceof WorkflowEffectApprovalPendingError) secondPending = error;
      else throw error;
    }
    expect(secondPending?.approvalId).not.toBe(first.pending.approvalId);
    await approve(value, secondPending!.approvalId);
    const secondPort = value.makePort();
    const resumedSecond = await secondPort.prepare({
      runId: 'run-1',
      evaluationIndex: 2,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    const secondClaim = await secondPort.authorize(resumedSecond);
    expect(secondClaim.disposition).toBe('claimed');
    if (secondClaim.disposition !== 'claimed') throw new Error('expected second claim');
    expect(secondClaim.executionId).not.toBe(firstClaim.executionId);
  });

  it('recovers a committed v2 decision from the prepared decision journal after restart', async () => {
    const value = await fixture();
    const { pending } = await createPending(value.makePort());
    const current = await value.approvals.read('run-1', pending.approvalId);
    const binding = value.decisionAuthority.issueHumanDecisionBinding({
      principalId: 'wsman',
      capability: 'workflow.effect.decide',
      runId: 'run-1',
      approvalId: pending.approvalId,
      correlationId: 'correlation-1',
      approvalExpiresAt: current!.expiresAt,
      decision: 'approved',
      reasonHash: REASON_HASH,
      expiresAt: new Date(Date.parse(value.getNow()) + 30_000).toISOString(),
    });
    value.setNow(binding.issuedAt);
    const next = applyWorkflowEffectApprovalDecision(
      current!,
      'approved',
      binding,
      value.decisionAuthority,
      REASON_HASH,
      value.getNow(),
    );
    await prepareWorkflowEffectAuthorityDecision(value.approvalRoot, current!, next, binding);
    const rawFiles = await readdir(join(value.approvalRoot, 'records'));
    expect(rawFiles).toHaveLength(1);
    await writeFile(
      join(value.approvalRoot, 'records', rawFiles[0]!),
      workflowEffectApprovalBytes(next),
    );

    const port = value.makePort();
    const prepared = await port.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(port.authorize(prepared)).resolves.toMatchObject({
      disposition: 'claimed',
    });
    expect((await recordFiles(value))[0]?.value.state).toBe('approval_committed');
  });

  it('preserves a live same-process journal and rolls back only a provably dead owner', async () => {
    const value = await fixture();
    const { pending } = await createPending(value.makePort());
    const current = await value.approvals.read('run-1', pending.approvalId);
    const binding = value.decisionAuthority.issueHumanDecisionBinding({
      principalId: 'wsman',
      capability: 'workflow.effect.decide',
      runId: 'run-1',
      approvalId: pending.approvalId,
      correlationId: 'correlation-1',
      approvalExpiresAt: current!.expiresAt,
      decision: 'approved',
      reasonHash: REASON_HASH,
      expiresAt: new Date(Date.parse(value.getNow()) + 30_000).toISOString(),
    });
    value.setNow(binding.issuedAt);
    const next = applyWorkflowEffectApprovalDecision(
      current!,
      'approved',
      binding,
      value.decisionAuthority,
      REASON_HASH,
      value.getNow(),
    );
    await prepareWorkflowEffectAuthorityDecision(value.approvalRoot, current!, next, binding);
    const [authority] = await recordFiles(value);
    const preparedDecision = authority!.value.preparedDecision as Record<string, unknown>;
    preparedDecision.owner = {
      ...(preparedDecision.owner as Record<string, unknown>),
      sessionId: randomUUID(),
    };
    await writeCanonical(authority!.path, authority!.value);

    const port = value.makePort();
    const prepared = await port.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(port.authorize(prepared)).rejects.toBeInstanceOf(
      WorkflowEffectApprovalPendingError,
    );
    expect((await recordFiles(value))[0]?.value.state).toBe('decision_prepared');

    const [stillPrepared] = await recordFiles(value);
    const deadDecision = stillPrepared!.value.preparedDecision as Record<string, unknown>;
    deadDecision.owner = {
      ...(deadDecision.owner as Record<string, unknown>),
      pid: 2_147_483_647,
      sessionId: randomUUID(),
    };
    await writeCanonical(stillPrepared!.path, stillPrepared!.value);
    const recovery = value.makePort();
    const recoveryPrepared = await recovery.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(recovery.authorize(recoveryPrepared)).rejects.toBeInstanceOf(
      WorkflowEffectApprovalPendingError,
    );
    expect((await recordFiles(value))[0]?.value.state).toBe('approval_committed');
  });

  it('latches reconciliation after an effect throws and never retries it', async () => {
    const value = await fixture();
    const { pending } = await createPending(value.makePort());
    await approve(value, pending.approvalId);
    const appendAuditRecord = vi.fn(async () => {
      throw new Error('audit sink failed after claim');
    });
    const runStore = {
      appendAuditRecord,
      appendLog: vi.fn(async () => undefined),
    } as unknown as RunStore;
    const runtime = createRuntimeWithHostAuthorities(
      {
        runId: value.binding.runId,
        mode: 'execute',
        manifest: {
          name: value.binding.workflowId,
          version: value.binding.workflowVersion,
          description: 'D2 reconciliation test.',
          phases: [{ title: 'Run', detail: 'Run once.' }],
          risk: 'low',
        },
        onConfirm: async () => true,
        effectBoundary: value.boundary,
        runStore,
      },
      createWorkflowCheckpointLeaseAuthority({
        workspaceId: value.binding.workspaceId,
        jobId: 'job-1',
        workflowRunId: value.binding.runId,
        attemptId: 'attempt-1',
        leaseId: 'lease-1',
        fencingToken: 1,
        correlationId: value.binding.correlationId,
        runnerBuildHash: BUILD_HASH,
        workflowSourceHash: value.binding.workflowSourceHash,
        manifestHash: value.binding.manifestHash,
        inputHash: value.binding.inputHash,
      }),
      value.makePort(),
    );
    await expect(runtime.openslack.governance.audit('bounded audit')).rejects.toBeInstanceOf(
      WorkflowEffectReconciliationRequiredError,
    );
    expect(appendAuditRecord).toHaveBeenCalledOnce();
    await expect(runtime.openslack.governance.audit('successor audit')).rejects.toBeInstanceOf(
      WorkflowEffectReconciliationRequiredError,
    );
    expect(() =>
      (runtime as unknown as { assertEffectTerminalState(): void }).assertEffectTerminalState(),
    ).toThrow(WorkflowEffectReconciliationRequiredError);
    expect(await recordFiles(value)).toHaveLength(1);
    const retry = value.makePort();
    await expect(
      retry.prepare({
        runId: 'run-1',
        evaluationIndex: 1,
        operation: 'openslack.governance.audit',
        detail: 'bounded audit',
      }),
    ).rejects.toBeInstanceOf(WorkflowEffectReconciliationRequiredError);
    expect(appendAuditRecord).toHaveBeenCalledOnce();
  });

  it('latches reconciliation when a successful effect result cannot be durably replayed', async () => {
    const value = await fixture();
    const { pending } = await createPending(value.makePort());
    await approve(value, pending.approvalId);
    const port = value.makePort();
    const prepared = await port.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    const claim = await port.authorize(prepared);
    expect(claim.disposition).toBe('claimed');
    if (claim.disposition !== 'claimed') throw new Error('expected claim');
    await expect(port.complete(claim.authority, 'x'.repeat(70 * 1024))).rejects.toBeInstanceOf(
      WorkflowEffectReconciliationRequiredError,
    );
    const retry = value.makePort();
    await expect(
      retry.prepare({
        runId: 'run-1',
        evaluationIndex: 1,
        operation: 'openslack.governance.audit',
        detail: 'bounded audit',
      }),
    ).rejects.toBeInstanceOf(WorkflowEffectReconciliationRequiredError);
  });

  it('rejects the runner descriptor expiry independently of approval expiry', async () => {
    const value = await fixture(new Date().toISOString(), 60_000);
    const { pending } = await createPending(value.makePort());
    await approve(value, pending.approvalId);
    value.setNow(new Date(Date.parse(value.getNow()) + 61_000).toISOString());
    const port = value.makePort();
    const prepared = await port.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(port.authorize(prepared)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_AUTHORITY_EXPIRED',
      message: expect.stringContaining('descriptor'),
    });
  });

  it('maps revision-one and revision-two approval views to one concurrent execution claim', async () => {
    const value = await fixture();
    const { pending } = await createPending(value.makePort());
    const { decided } = await approve(value, pending.approvalId);
    const revisionOne = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const port = value.makePort();
        return {
          port,
          prepared: await port.prepare({
            runId: 'run-1',
            evaluationIndex: 1,
            operation: 'openslack.governance.audit',
            detail: 'bounded audit',
          }),
        };
      }),
    );
    await value.approvals.markAuditProjected({
      runId: 'run-1',
      approvalId: pending.approvalId,
      expectedRevision: 1,
      eventId: workflowEffectApprovalAuditEventId('run-1', pending.approvalId),
    });
    expect(decided.auditProjection?.status).toBe('pending');

    const revisionTwo = await Promise.all(
      Array.from({ length: 50 }, async () => {
        const port = value.makePort();
        return {
          port,
          prepared: await port.prepare({
            runId: 'run-1',
            evaluationIndex: 1,
            operation: 'openslack.governance.audit',
            detail: 'bounded audit',
          }),
        };
      }),
    );
    const settled = await Promise.allSettled(
      [...revisionOne, ...revisionTwo].map(({ port, prepared }) => port.authorize(prepared)),
    );
    expect(settled.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((entry) => entry.status === 'rejected')).toHaveLength(99);
  }, 30_000);

  it('rejects expired decisions before creating an execution claim', async () => {
    const value = await fixture();
    const { pending } = await createPending(value.makePort());
    await approve(value, pending.approvalId);
    value.setNow(new Date(Date.parse(value.getNow()) + 16 * 60_000).toISOString());
    const port = value.makePort();
    const prepared = await port.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(port.authorize(prepared)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_AUTHORITY_EXPIRED',
    });
  });

  it('replays a proved executed claim after the approval expires', async () => {
    const value = await fixture();
    const { pending } = await createPending(value.makePort());
    await approve(value, pending.approvalId);
    const port = value.makePort();
    const prepared = await port.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    const claim = await port.authorize(prepared);
    expect(claim.disposition).toBe('claimed');
    if (claim.disposition !== 'claimed') throw new Error('expected claim');
    await port.complete(claim.authority, { ok: true });
    value.setNow(new Date(Date.parse(value.getNow()) + 16 * 60_000).toISOString());

    const replayPort = value.makePort();
    const replayPrepared = await replayPort.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(replayPort.authorize(replayPrepared)).resolves.toMatchObject({
      disposition: 'replay',
      value: { ok: true },
      executionId: claim.executionId,
    });
  });
});
