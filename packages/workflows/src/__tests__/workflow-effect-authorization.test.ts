import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { types as utilTypes } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyWorkflowEffectApprovalDecision,
  createWorkflowEffectDecisionAuthority,
  workflowEffectApprovalBytes,
  workflowEffectApprovalAuditEventId,
} from '../workflow-effect-approval.js';
import { LocalWorkflowEffectApprovalStore } from '../workflow-effect-approval-store.js';
import { createRuntimeWithHostAuthorities } from '../runtime.js';
import type { RunStore } from '../run-store.js';
import * as shadowFilesystem from '../workflow-control-shadow.js';
import { productionJournalSecurity, writeExclusive } from '../workflow-control-shadow.js';
import { canonicalWorkflowEffectControlJson } from '../workflow-effect-control-contract.js';
import {
  createWorkflowEffectAuthorizationPort,
  WorkflowEffectReconciliationRequiredError,
  WorkflowEffectApprovalPendingError,
  WorkflowEffectAuthorizationBusyError,
  type WorkflowEffectAuthorizationPort,
} from '../workflow-effect-authorization.js';
import { registerWorkflowEffectAuthorizationPort } from '../internal/workflow-effect-authorization-contract.js';
import { createWorkflowCheckpointLeaseAuthority } from '../internal/workflow-checkpoint-lease-authority.js';
import {
  LocalWorkflowEffectAuthorityStore,
  prepareWorkflowEffectAuthorityDecision,
  repairWorkflowEffectAuthoritySecurity,
  scanWorkflowEffectAuthorityObservationPrefixes,
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
import { platformTestTimeout } from '../../../../scripts/testing/process-fixture.mjs';

const BUILD_HASH = '1'.repeat(64);
const SOURCE_HASH = '2'.repeat(64);
const MANIFEST_HASH = '3'.repeat(64);
const INPUT_HASH = '4'.repeat(64);
const REASON_HASH = '5'.repeat(64);
const roots: string[] = [];
let revisionPhase: { work: Promise<void>; roots: string[] } | undefined;
const CONSUMED_CLAIM_MISSING_CASE =
  'fails closed when a consumed claim file disappears but its authority high-watermark remains';
const consumedClaimFixtures = new WeakMap<
  object,
  { value: Awaited<ReturnType<typeof fixture>>; claimPath: string }
>();

function fixtureCleanupCode(error: unknown): string {
  try {
    if (!error || typeof error !== 'object' || utilTypes.isProxy(error)) return 'UNKNOWN';
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    return typeof code === 'string' &&
      ['EACCES', 'EPERM', 'ENOENT', 'EBUSY', 'EIO', 'ENOSPC', 'ENOTEMPTY'].includes(code)
      ? code
      : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

async function measureFixturePhase<T>(
  phase: 'preparation' | 'protocol' | 'wait' | 'cleanup',
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    console.info('Effect authorization fixture phase', {
      phase,
      elapsedMs: performance.now() - started,
    });
  }
}

function trackRevisionPhase(operation: (ownedRoots: string[]) => Promise<void>): Promise<void> {
  const ownedRoots = revisionPhase?.roots ?? [];
  const work = operation(ownedRoots);
  revisionPhase = { work, roots: ownedRoots };
  return work;
}

// Exact Windows DACL qualification invokes the platform ACL authority for each
// newly-created durable artifact. Keep the bound above the observed multi-step
// approval + claim + replay path while Linux retains the normal fast timeout.
vi.setConfig({ testTimeout: process.platform === 'win32' ? 120_000 : 5_000 });

// A hook/test timeout must not delete fixtures while its real I/O is still in flight.
afterEach(async (context) => {
  const phase = revisionPhase;
  revisionPhase = undefined;
  const ownedRoots = roots.splice(0);
  let primaryFailed = context.task.result?.state === 'fail';
  if (phase) {
    await measureFixturePhase('wait', () =>
      phase.work.catch(() => {
        primaryFailed = true;
      }),
    );
  }
  // Phase-owned roots stay separate even if the hook times out and another
  // case starts while a filesystem call from this phase is still completing.
  const cleanup = () =>
    Promise.allSettled(
      [...ownedRoots, ...(phase?.roots ?? [])].map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  const settled = phase ? await measureFixturePhase('cleanup', cleanup) : await cleanup();
  const failures = settled.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    if (primaryFailed)
      console.error('Effect authorization fixture cleanup also failed', {
        phase: 'remove',
        count: failures.length,
        codes: failures.map((result) => fixtureCleanupCode(result.reason)),
      });
    else
      throw new AggregateError(
        failures.map((result) => result.reason),
        'Effect authorization fixture cleanup failed',
      );
  }
}, platformTestTimeout(30_000));

beforeEach((context) => {
  if (context.task.name !== CONSUMED_CLAIM_MISSING_CASE) return;
  return trackRevisionPhase(async (ownedRoots) => {
    const started = performance.now();
    let completed = false;
    try {
      const value = await fixture(undefined, undefined, ownedRoots);
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
      const [claimFile] = await authorityClaimFiles(
        value,
        'openslack.workflow_effect_execution_record.v1',
      );

      if (claimFile === undefined) throw new Error('Consumed claim fixture was not prepared');
      consumedClaimFixtures.set(context.task, { value, claimPath: claimFile.path });
      completed = true;
    } finally {
      Object.assign(context.task.meta, {
        consumedClaimPreparation: {
          durationMs: performance.now() - started,
          completed,
        },
      });
    }
  });
}, platformTestTimeout(5_000));

async function fixture(
  nowValue = new Date().toISOString(),
  descriptorTtlMs = 60 * 60_000,
  ownedRoots = roots,
) {
  const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  const workspaceRoot = await mkdtemp(join(temporaryRoot, 'openslack-effect-authority-'));
  ownedRoots.push(workspaceRoot);
  const approvalRoot = join(workspaceRoot, '.openslack.local', 'workflows', 'effect-approvals');
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

function issueFixtureDecisionBinding(
  value: Awaited<ReturnType<typeof fixture>>,
  input: Parameters<typeof value.decisionAuthority.issueHumanDecisionBinding>[0],
) {
  // The store already uses this fixture clock. Keep synchronous issuance in
  // the same window, then restore real time before any filesystem await.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(value.getNow());
  try {
    return value.decisionAuthority.issueHumanDecisionBinding(input);
  } finally {
    vi.useRealTimers();
  }
}

async function approve(value: Awaited<ReturnType<typeof fixture>>, approvalId: string) {
  const pending = await value.approvals.read('run-1', approvalId);
  expect(pending?.status).toBe('pending');
  const bindingExpiresAt = new Date(
    Math.min(Date.now() + 30_000, Date.parse(pending!.expiresAt) - 1),
  ).toISOString();
  const binding = value.decisionAuthority.issueHumanDecisionBinding({
    principalId: 'wsman',
    capability: 'workflow.effect.decide',
    runId: 'run-1',
    approvalId,
    correlationId: 'correlation-1',
    approvalExpiresAt: pending!.expiresAt,
    decision: 'approved',
    reasonHash: REASON_HASH,
    expiresAt: bindingExpiresAt,
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
  const bindingExpiresAt = new Date(
    Math.min(Date.now() + 30_000, Date.parse(pending!.expiresAt) - 1),
  ).toISOString();
  const binding = value.decisionAuthority.issueHumanDecisionBinding({
    principalId: 'wsman',
    capability: 'workflow.effect.decide',
    runId: 'run-1',
    approvalId,
    correlationId: 'correlation-1',
    approvalExpiresAt: pending!.expiresAt,
    decision: 'rejected',
    reasonHash: REASON_HASH,
    expiresAt: bindingExpiresAt,
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

async function authorityClaimFiles(value: Awaited<ReturnType<typeof fixture>>, schema: string) {
  const directory = join(
    value.workspaceRoot,
    '.openslack.local',
    'workflows',
    'effect-authority',
    'claims',
  );
  const files = await Promise.all(
    (await readdir(directory)).map(async (name) => ({
      path: join(directory, name),
      value: JSON.parse(await readFile(join(directory, name), 'utf8')) as Record<string, unknown>,
    })),
  );
  return files.filter((entry) => entry.value.schema === schema);
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
  it('retries BUSY at the same evaluation index without latching the run', async () => {
    const value = await fixture();
    const prepared = Object.freeze({
      kind: 'workflow_effect_prepared_authorization' as const,
      handle: Object.freeze({
        effectId: 'effect-1',
        effectKind: 'openslack.governance.audit',
        effectHash: '6'.repeat(64),
        capabilityHash: '7'.repeat(64),
        requiresHumanDecision: true as const,
      }),
    });
    const indexes: number[] = [];
    const port: WorkflowEffectAuthorizationPort = {
      async prepare(input) {
        indexes.push(input.evaluationIndex);
        if (indexes.length === 1) throw new WorkflowEffectAuthorizationBusyError();
        return prepared;
      },
      async authorize() {
        throw new WorkflowEffectApprovalPendingError('run-1', 'approval-1');
      },
      async complete() {
        throw new Error('unreachable');
      },
      async reconcile() {
        throw new Error('unreachable');
      },
    };
    registerWorkflowEffectAuthorizationPort(port);
    const runtime = createRuntimeWithHostAuthorities(
      {
        runId: 'run-1',
        mode: 'execute',
        manifest: {
          name: 'workflow-1',
          version: '1.0.0',
          description: 'D2 busy retry test.',
          phases: [{ title: 'Run', detail: 'Run once.' }],
          risk: 'low',
        },
        onConfirm: async () => true,
        effectBoundary: value.boundary,
        runStore: {
          appendAuditRecord: vi.fn(async () => undefined),
          appendLog: vi.fn(async () => undefined),
        } as unknown as RunStore,
      },
      createWorkflowCheckpointLeaseAuthority({
        workspaceId: 'workspace-1',
        jobId: 'job-1',
        workflowRunId: 'run-1',
        attemptId: 'attempt-1',
        leaseId: 'lease-1',
        fencingToken: 1,
        correlationId: 'correlation-1',
        runnerBuildHash: BUILD_HASH,
        workflowSourceHash: SOURCE_HASH,
        manifestHash: MANIFEST_HASH,
        inputHash: INPUT_HASH,
      }),
      port,
    );

    await expect(runtime.openslack.governance.audit('bounded audit')).rejects.toBeInstanceOf(
      WorkflowEffectAuthorizationBusyError,
    );
    await expect(runtime.openslack.governance.audit('bounded audit')).rejects.toBeInstanceOf(
      WorkflowEffectApprovalPendingError,
    );
    await expect(runtime.openslack.governance.audit('successor audit')).rejects.toBeInstanceOf(
      WorkflowEffectApprovalPendingError,
    );
    expect(indexes).toEqual([1, 1]);
  });

  it('retries claim contention at the same occurrence without publishing a false outcome', async () => {
    const value = await fixture();
    const indexes: number[] = [];
    let authorizationAttempts = 0;
    const prepared = Object.freeze({
      kind: 'workflow_effect_prepared_authorization' as const,
      handle: Object.freeze({
        effectId: 'effect-1',
        effectKind: 'openslack.governance.audit',
        effectHash: '6'.repeat(64),
        capabilityHash: '7'.repeat(64),
        requiresHumanDecision: true as const,
      }),
    });
    const port: WorkflowEffectAuthorizationPort = {
      async prepare(input) {
        indexes.push(input.evaluationIndex);
        return prepared;
      },
      async authorize() {
        authorizationAttempts += 1;
        if (authorizationAttempts === 1) throw new WorkflowEffectAuthorizationBusyError();
        return {
          disposition: 'replay' as const,
          value: undefined,
          executionId: 'execution-1',
          outcomeHash: '8'.repeat(64),
        };
      },
      async complete() {
        throw new Error('unreachable');
      },
      async reconcile() {
        throw new Error('unreachable');
      },
    };
    registerWorkflowEffectAuthorizationPort(port);
    const runtime = createRuntimeWithHostAuthorities(
      {
        runId: 'run-1',
        mode: 'execute',
        manifest: {
          name: 'workflow-1',
          version: '1.0.0',
          description: 'D2 claim contention retry test.',
          phases: [{ title: 'Run', detail: 'Run once.' }],
          risk: 'low',
        },
        onConfirm: async () => true,
        effectBoundary: value.boundary,
        runStore: {
          appendAuditRecord: vi.fn(async () => undefined),
          appendLog: vi.fn(async () => undefined),
        } as unknown as RunStore,
      },
      createWorkflowCheckpointLeaseAuthority({
        workspaceId: 'workspace-1',
        jobId: 'job-1',
        workflowRunId: 'run-1',
        attemptId: 'attempt-1',
        leaseId: 'lease-1',
        fencingToken: 1,
        correlationId: 'correlation-1',
        runnerBuildHash: BUILD_HASH,
        workflowSourceHash: SOURCE_HASH,
        manifestHash: MANIFEST_HASH,
        inputHash: INPUT_HASH,
      }),
      port,
    );

    await expect(runtime.openslack.governance.audit('bounded audit')).rejects.toBeInstanceOf(
      WorkflowEffectAuthorizationBusyError,
    );
    expect(value.boundary.outcome).not.toHaveBeenCalled();
    await expect(runtime.openslack.governance.audit('bounded audit')).resolves.toBeUndefined();
    expect(indexes).toEqual([1, 1]);
    expect(value.boundary.outcome).toHaveBeenCalledOnce();
    expect(value.boundary.outcome).toHaveBeenCalledWith(
      prepared.handle,
      expect.objectContaining({ status: 'executed' }),
    );
  });

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
    await expect(
      runtime.checkpoint!.commit({ artifact: new Uint8Array([1]) }),
    ).rejects.toBeInstanceOf(WorkflowEffectApprovalPendingError);
    expect(() =>
      (runtime as unknown as { assertEffectTerminalState(): void }).assertEffectTerminalState(),
    ).toThrow(WorkflowEffectApprovalPendingError);
    expect(appendAuditRecord).not.toHaveBeenCalled();
    expect(await recordFiles(value)).toHaveLength(1);
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

  it('rejects a terminal human rejection without creating an execution claim', () =>
    trackRevisionPhase(async (ownedRoots) => {
      const value = await measureFixturePhase('preparation', () =>
        fixture(undefined, undefined, ownedRoots),
      );
      await measureFixturePhase('protocol', async () => {
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
        expect(
          await authorityClaimFiles(value, 'openslack.workflow_effect_execution_record.v1'),
        ).toEqual([]);
      });
    }));

  it.each([
    ['ensureOwnerDirectory', WorkflowEffectAuthorizationBusyError],
    ['writeExclusive', WorkflowEffectAuthorizationBusyError],
    ['atomicWrite', WorkflowEffectReconciliationRequiredError],
  ] as const)(
    'classifies a queued %s refusal according to the durable publication stage',
    async (operation, errorClass) => {
      const value = await fixture();
      const port = value.makePort();
      const wait = vi
        .spyOn(shadowFilesystem, operation)
        .mockRejectedValueOnce(new shadowFilesystem.OwnerDirectoryWaitTimeoutError());
      try {
        await expect(createPending(port)).rejects.toBeInstanceOf(errorClass);
        expect(wait).toHaveBeenCalled();
      } finally {
        wait.mockRestore();
      }
      if (operation === 'atomicWrite') {
        await expect(createPending(port)).rejects.toBeInstanceOf(
          WorkflowEffectReconciliationRequiredError,
        );
      } else {
        await expect(createPending(port)).resolves.toMatchObject({
          pending: expect.any(WorkflowEffectApprovalPendingError),
        });
      }
    },
  );

  it('fails closed on workflow, input, correlation, and effect identity drift', async () => {
    const value = await fixture();
    await createPending(value.makePort());
    for (const overrides of [
      { workflowSourceHash: 'a'.repeat(64) },
      { manifestHash: 'b'.repeat(64) },
      { inputHash: 'c'.repeat(64) },
      { correlationId: 'correlation-drift' },
      { expectedControlBuildHash: 'd'.repeat(64) },
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
    const [executionFile] = await authorityClaimFiles(
      value,
      'openslack.workflow_effect_execution_record.v1',
    );
    const claimPath = executionFile!.path;
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

  it(CONSUMED_CLAIM_MISSING_CASE, (context) =>
    trackRevisionPhase(async () => {
      const prepared = consumedClaimFixtures.get(context.task);
      if (prepared === undefined) throw new Error('Consumed claim fixture was not prepared');
      const { value, claimPath } = prepared;
      await rm(claimPath);

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
    }),
  );

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

  it('requires both sides of the immutable occurrence anchor binding', async () => {
    const value = await fixture();
    await createPending(value.makePort());
    const [anchor] = await authorityClaimFiles(
      value,
      'openslack.workflow_effect_occurrence_anchor.v1',
    );
    await rm(anchor!.path);
    await expect(
      value.makePort().prepare({
        runId: 'run-1',
        evaluationIndex: 1,
        operation: 'openslack.governance.audit',
        detail: 'bounded audit',
      }),
    ).rejects.toBeInstanceOf(WorkflowEffectReconciliationRequiredError);
  });

  it('recovers a canonical atomic-write temporary before reading authority state', async () => {
    const value = await fixture();
    const { pending } = await createPending(value.makePort());
    const [authority] = await recordFiles(value);
    const directory = join(
      value.workspaceRoot,
      '.openslack.local',
      'workflows',
      'effect-authority',
      'records',
    );
    const targetHash = createHash('sha256').update(authority!.path, 'utf8').digest('hex');
    const temporary = join(directory, `.${targetHash}.${process.pid}.${randomUUID()}.tmp`);
    await writeExclusive(
      temporary,
      `${canonicalWorkflowEffectControlJson(authority!.value)}\n`,
      productionJournalSecurity(),
    );
    await rm(authority!.path);

    const recovered = value.makePort();
    const prepared = await recovered.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(recovered.authorize(prepared)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_PENDING',
      approvalId: pending.approvalId,
    });
    expect(await readdir(directory)).not.toContain(basename(temporary));
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

  it.runIf(process.platform === 'win32')(
    'audits and explicitly rebuilds verified legacy DACLs without manufacturing authority',
    async () => {
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
      const [execution] = await authorityClaimFiles(
        value,
        'openslack.workflow_effect_execution_record.v1',
      );
      expect(execution).toBeDefined();
      execFileSync('icacls.exe', [execution!.path, '/grant', '*S-1-1-0:(R)'], {
        stdio: 'ignore',
        windowsHide: true,
      });

      await expect(
        repairWorkflowEffectAuthoritySecurity(value.workspaceRoot),
      ).resolves.toMatchObject({
        status: 'repairable',
        insecurePaths: expect.any(Number),
      });
      await expect(
        repairWorkflowEffectAuthoritySecurity(value.workspaceRoot, { apply: true }),
      ).resolves.toMatchObject({ status: 'repaired' });
      await expect(
        repairWorkflowEffectAuthoritySecurity(value.workspaceRoot),
      ).resolves.toMatchObject({
        status: 'secure',
        insecurePaths: 0,
      });
    },
    240_000,
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

  describe('bounded authority-store capacity', () => {
    let preparedCase: Awaited<ReturnType<typeof fixture>> | undefined;

    beforeEach(
      () =>
        trackRevisionPhase(async (ownedRoots) => {
          const value = await fixture(undefined, undefined, ownedRoots);
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
          const initialNames = await readdir(claims);
          // Populate the real store in setup; the guarded operation retains its
          // original test deadline and every batch still starts 128 real writes.
          for (let offset = 0; offset < names.length; offset += 128) {
            const settled = await Promise.allSettled(
              names
                .slice(offset, offset + 128)
                .map((name) => writeFile(join(claims, name), '', { mode: 0o600 })),
            );
            const failures = settled.filter((result) => result.status === 'rejected');
            if (failures.length > 0) {
              throw new AggregateError(
                failures.map((result) => result.reason),
                'Authority-store capacity fixture preparation failed.',
              );
            }
          }
          expect((await readdir(claims)).sort()).toEqual([...initialNames, ...names].sort());
          preparedCase = value;
        }),
      platformTestTimeout(5_000),
    );

    it('fails closed when the bounded authority-store entry budget is exhausted', () =>
      trackRevisionPhase(async () => {
        if (preparedCase === undefined)
          throw new Error('Authority capacity fixture was not prepared');
        await expect(
          preparedCase.makePort().prepare({
            runId: 'run-1',
            evaluationIndex: 1,
            operation: 'openslack.governance.audit',
            detail: 'bounded audit',
          }),
        ).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_AUTHORITY_LIMIT_EXCEEDED' });
      }));
  });

  it('keeps identical effect contents distinct by deterministic evaluation occurrence', () =>
    trackRevisionPhase(async (ownedRoots) => {
      const value = await measureFixturePhase('preparation', () =>
        fixture(undefined, undefined, ownedRoots),
      );
      await measureFixturePhase('protocol', async () => {
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
    }));

  it('recovers a committed v2 decision from the prepared decision journal after restart', async () => {
    const value = await fixture('2026-10-01T00:00:00.000Z');
    const { pending } = await createPending(value.makePort());
    const current = await value.approvals.read('run-1', pending.approvalId);
    const binding = issueFixtureDecisionBinding(value, {
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
    expect(binding.issuedAt).toBe(value.getNow());
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

    const repairBinding = issueFixtureDecisionBinding(value, {
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
    expect(repairBinding.issuedAt).toBe(value.getNow());
    expect(repairBinding.nonce).not.toBe(binding.nonce);
    const repaired = await value.approvals.decide({
      runId: 'run-1',
      approvalId: pending.approvalId,
      expectedRevision: 0,
      decision: 'approved',
      reasonHash: REASON_HASH,
      binding: repairBinding,
    });
    expect(repaired.decision?.attestationNonce).toBe(binding.nonce);

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
    const value = await fixture('2026-10-01T00:00:00.000Z');
    const { pending } = await createPending(value.makePort());
    const current = await value.approvals.read('run-1', pending.approvalId);
    const binding = issueFixtureDecisionBinding(value, {
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
    expect(binding.issuedAt).toBe(value.getNow());
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
    await expect(port.complete(claim.authority, 'x'.repeat(256 * 1024))).rejects.toBeInstanceOf(
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

  it('persists and replays the exact 256 KiB canonical result boundary out of line', async () => {
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
    const result = 'x'.repeat(256 * 1024 - 2);
    await expect(port.complete(claim.authority, result)).resolves.toBeDefined();
    const replayPort = value.makePort();
    const replayPrepared = await replayPort.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(replayPort.authorize(replayPrepared)).resolves.toMatchObject({
      disposition: 'replay',
      value: result,
    });
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

    const renewedLease = value.makePort({
      descriptorExpiresAt: new Date(Date.parse(value.getNow()) + 60_000).toISOString(),
    });
    const renewedPrepared = await renewedLease.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(renewedLease.authorize(renewedPrepared)).resolves.toMatchObject({
      disposition: 'claimed',
    });
  });

  it('renews an expired pending approval with a monotonic generation', async () => {
    const value = await fixture();
    const first = await createPending(value.makePort());
    const firstRecord = await value.approvals.read('run-1', first.pending.approvalId);
    expect(firstRecord?.status).toBe('pending');
    const staleBinding = value.decisionAuthority.issueHumanDecisionBinding({
      principalId: 'wsman',
      capability: 'workflow.effect.decide',
      runId: 'run-1',
      approvalId: first.pending.approvalId,
      correlationId: 'correlation-1',
      approvalExpiresAt: firstRecord!.expiresAt,
      decision: 'approved',
      reasonHash: REASON_HASH,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });
    value.setNow(new Date(Date.parse(value.getNow()) + 16 * 60_000).toISOString());
    const port = value.makePort();
    const prepared = await port.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    const renewedError = await port.authorize(prepared).catch((error: unknown) => error);
    expect(renewedError).toBeInstanceOf(WorkflowEffectApprovalPendingError);
    const renewedApprovalId = (renewedError as WorkflowEffectApprovalPendingError).approvalId;
    expect(renewedApprovalId).not.toBe(first.pending.approvalId);
    await expect(
      value.approvals.decide({
        runId: 'run-1',
        approvalId: first.pending.approvalId,
        expectedRevision: 0,
        decision: 'approved',
        reasonHash: REASON_HASH,
        binding: staleBinding,
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_EFFECT_APPROVAL_EXPIRED' });
    await expect(value.approvals.read('run-1', renewedApprovalId)).resolves.toMatchObject({
      status: 'pending',
      revision: 0,
    });
  });

  it('recovers a persisted approval generation after the authority-head write is lost', async () => {
    const value = await fixture();
    const first = await createPending(value.makePort());
    const [priorAuthority] = await recordFiles(value);
    expect(priorAuthority).toBeDefined();

    value.setNow(new Date(Date.parse(value.getNow()) + 16 * 60_000).toISOString());
    const renewingPort = value.makePort();
    const renewingPrepared = await renewingPort.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    const renewed = await renewingPort.authorize(renewingPrepared).catch((error: unknown) => error);
    expect(renewed).toBeInstanceOf(WorkflowEffectApprovalPendingError);
    const renewedApprovalId = (renewed as WorkflowEffectApprovalPendingError).approvalId;
    expect(renewedApprovalId).not.toBe(first.pending.approvalId);

    // Model a crash after the immutable generation anchor and pending D1 record
    // reached durable storage, but before the mutable authority head did.
    await writeCanonical(priorAuthority!.path, priorAuthority!.value);

    const recoveredPort = value.makePort();
    const recoveredPrepared = await recoveredPort.prepare({
      runId: 'run-1',
      evaluationIndex: 1,
      operation: 'openslack.governance.audit',
      detail: 'bounded audit',
    });
    await expect(recoveredPort.authorize(recoveredPrepared)).rejects.toMatchObject({
      code: 'WORKFLOW_EFFECT_APPROVAL_PENDING',
      approvalId: renewedApprovalId,
    });
    const [recoveredAuthority] = await recordFiles(value);
    expect(recoveredAuthority!.value).toMatchObject({
      state: 'approval_committed',
      artifact: {
        approvalGeneration: 1,
        approval: { approvalId: renewedApprovalId },
      },
    });
  });

  describe('cached authority directory verification', () => {
    function ownVerification(
      work: Promise<unknown>[],
      promise: Promise<unknown>,
    ): Promise<unknown> {
      work.push(promise);
      void promise.catch(() => undefined);
      return promise;
    }

    async function waitForVerificationGate(
      entered: Promise<void>,
      work: Promise<unknown>,
    ): Promise<void> {
      await Promise.race([
        entered,
        work.then(() => {
          throw new Error('AUTHORITY_VERIFICATION_GATE_NOT_ENTERED');
        }),
      ]);
    }

    async function restoreVerification(
      operations: Array<() => void | Promise<void>>,
      primaryFailed: boolean,
    ) {
      const errors: unknown[] = [];
      for (const operation of operations) {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        console.error('Authority verification fixture cleanup also failed', {
          count: errors.length,
          codes: errors.map(fixtureCleanupCode),
        });
        if (!primaryFailed) throw new Error('AUTHORITY_VERIFICATION_FIXTURE_CLEANUP_FAILED');
      }
    }

    async function preparedStore(ownedRoots: string[]) {
      const value = await fixture(undefined, undefined, ownedRoots);
      const store = new LocalWorkflowEffectAuthorityStore(value.approvalRoot, value.getNow);
      const find = () => store.find(value.binding, 1, 'governance', 'occurrence', REASON_HASH);
      await expect(find()).resolves.toBeUndefined();
      const findAt = (approvalRoot: string) =>
        new LocalWorkflowEffectAuthorityStore(approvalRoot, value.getNow).find(
          value.binding,
          1,
          'governance',
          'occurrence',
          REASON_HASH,
        );
      return {
        root: join(value.workspaceRoot, '.openslack.local', 'workflows', 'effect-authority'),
        approvalRoot: value.approvalRoot,
        find,
        findAt,
      };
    }

    it('holds concurrent lookups behind the same complete directory verification and rechecks a later lookup', () =>
      trackRevisionPhase(async (ownedRoots) => {
        const value = await preparedStore(ownedRoots);
        const security = await import('../workflow-control-shadow.js');
        const original = security.assertOwnerDirectory;
        const entered = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        let rootReads = 0,
          primaryFailed = false;
        const restore: Array<() => void> = [],
          work: Promise<unknown>[] = [];
        try {
          const spy = vi
            .spyOn(security, 'assertOwnerDirectory')
            .mockImplementation(async (...args) => {
              if (args[0] === value.root) {
                rootReads += 1;
                entered.resolve();
                await release.promise;
              }
              return original(...args);
            });
          restore.push(() => spy.mockRestore());
          const first = ownVerification(work, value.find());
          ownVerification(work, value.find());
          await waitForVerificationGate(entered.promise, first);
          expect(rootReads).toBe(1);
          expect(await readdir(join(value.root, 'locks'))).toEqual([]);
          release.resolve();
          await expect(Promise.all(work)).resolves.toEqual([undefined, undefined]);
          const later = ownVerification(work, value.find());
          await expect(later).resolves.toBeUndefined();
          expect(rootReads).toBe(2);
        } catch (error) {
          primaryFailed = true;
          throw error;
        } finally {
          release.resolve();
          await Promise.allSettled(work);
          await restoreVerification(restore.reverse(), primaryFailed);
        }
      }));

    it.each(['find', 'observer'] as const)(
      'waits for a live local %s lock owner before starting a later directory verification',
      (kind) =>
        trackRevisionPhase(async (ownedRoots) => {
          const value = await preparedStore(ownedRoots);
          const security = await import('../workflow-control-shadow.js');
          const originalRead = security.assertOwnerDirectory,
            originalAcquire = security.acquireOwnerJournalLock;
          const entered = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
          let held = false,
            lockCalls = 0,
            readsWhileHeld = 0,
            primaryFailed = false;
          const restore: Array<() => void> = [],
            work: Promise<unknown>[] = [];
          try {
            const readSpy = vi
              .spyOn(security, 'assertOwnerDirectory')
              .mockImplementation(async (...args) => {
                if (held && args[0] === value.root) readsWhileHeld += 1;
                return originalRead(...args);
              });
            restore.push(() => readSpy.mockRestore());
            const acquireSpy = vi
              .spyOn(security, 'acquireOwnerJournalLock')
              .mockImplementation(async (...args) => {
                const unlock = await originalAcquire(...args);
                if (lockCalls++ !== 0) return unlock;
                held = true;
                entered.resolve();
                await release.promise;
                return async () => {
                  try {
                    await unlock();
                  } finally {
                    held = false;
                  }
                };
              });
            restore.push(() => acquireSpy.mockRestore());
            const first = ownVerification(
              work,
              kind === 'observer'
                ? scanWorkflowEffectAuthorityObservationPrefixes(value.approvalRoot)
                : value.find(),
            );
            await waitForVerificationGate(entered.promise, first);
            expect(await readdir(join(value.root, 'locks'))).toContain('authority.lock');
            ownVerification(work, value.find());
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(readsWhileHeld).toBe(0);
            release.resolve();
            const results = await Promise.all(work);
            expect(results[1]).toBeUndefined();
            if (kind === 'observer')
              expect(results[0]).toMatchObject({
                prefixes: [],
                failures: [],
                recordIndex: new Map(),
              });
            else expect(results[0]).toBeUndefined();
            expect(lockCalls).toBe(2);
            expect(await readdir(join(value.root, 'locks'))).toEqual([]);
          } catch (error) {
            primaryFailed = true;
            throw error;
          } finally {
            release.resolve();
            await Promise.allSettled(work);
            await restoreVerification(restore.reverse(), primaryFailed);
          }
        }),
    );

    it.each(['find', 'observer'] as const)(
      'ends the %s writer phase after lock acquisition is refused',
      (kind) =>
        trackRevisionPhase(async (ownedRoots) => {
          const value = await preparedStore(ownedRoots);
          const security = await import('../workflow-control-shadow.js');
          const refused = Object.assign(new Error('Controlled owner lock acquisition refusal.'), {
            code: 'EACCES',
          });
          const restore: Array<() => void> = [],
            work: Promise<unknown>[] = [];
          let primaryFailed = false;
          try {
            const spy = vi
              .spyOn(security, 'acquireOwnerJournalLock')
              .mockRejectedValueOnce(refused);
            restore.push(() => spy.mockRestore());
            const first = ownVerification(
              work,
              kind === 'observer'
                ? scanWorkflowEffectAuthorityObservationPrefixes(value.approvalRoot)
                : value.find(),
            );
            if (kind === 'observer') await expect(first).rejects.toBe(refused);
            else
              await expect(first).rejects.toMatchObject({
                code: 'WORKFLOW_EFFECT_AUTHORITY_FILE_UNSAFE',
                cause: refused,
              });
            expect(await readdir(join(value.root, 'locks'))).toEqual([]);
            const next = ownVerification(work, value.find());
            await expect(next).resolves.toBeUndefined();
          } catch (error) {
            primaryFailed = true;
            throw error;
          } finally {
            await Promise.allSettled(work);
            await restoreVerification(restore.reverse(), primaryFailed);
          }
        }),
    );

    it.skipIf(process.platform !== 'win32')(
      'queues an alternate Windows root spelling behind the active authority writer',
      () =>
        trackRevisionPhase(async (ownedRoots) => {
          const value = await preparedStore(ownedRoots);
          const aliasParent = dirname(value.approvalRoot).toUpperCase();
          const aliasApproval = join(aliasParent, basename(value.approvalRoot));
          const aliasRoot = join(aliasParent, basename(value.root));
          expect(aliasApproval).not.toBe(value.approvalRoot);
          expect((await realpath(aliasRoot)).toLowerCase()).toBe(
            (await realpath(value.root)).toLowerCase(),
          );
          const security = await import('../workflow-control-shadow.js');
          const acquire = security.acquireOwnerJournalLock;
          const keyFor = security.workflowDirectoryCoordinationKey;
          const verify = security.assertOwnerDirectory;
          const entered = Promise.withResolvers<void>();
          const aliasKey = Promise.withResolvers<void>();
          const release = Promise.withResolvers<void>();
          const work: Promise<unknown>[] = [];
          let acquiringFirst = true;
          let active = false;
          let aliasReads = 0;
          let prematureReads = 0;
          const lockSpy = vi
            .spyOn(security, 'acquireOwnerJournalLock')
            .mockImplementation(async (...args) => {
              const unlock = await acquire(...args);
              if (acquiringFirst) {
                acquiringFirst = false;
                active = true;
                entered.resolve();
                await release.promise;
                return async () => {
                  try {
                    await unlock();
                  } finally {
                    active = false;
                  }
                };
              }
              return unlock;
            });
          const keySpy = vi
            .spyOn(security, 'workflowDirectoryCoordinationKey')
            .mockImplementation(async (...args) => {
              const key = await keyFor(...args);
              if (args[0] === aliasRoot) aliasKey.resolve();
              return key;
            });
          const verifySpy = vi
            .spyOn(security, 'assertOwnerDirectory')
            .mockImplementation(async (...args) => {
              if (args[0] === aliasRoot) {
                aliasReads += 1;
                if (active) prematureReads += 1;
              }
              return verify(...args);
            });
          try {
            const initial = ownVerification(work, value.find());
            await waitForVerificationGate(entered.promise, initial);
            const alternate = ownVerification(work, value.findAt(aliasApproval));
            await waitForVerificationGate(aliasKey.promise, alternate);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(aliasReads).toBe(0);
            release.resolve();
            await expect(initial).resolves.toBeUndefined();
            await expect(alternate).resolves.toBeUndefined();
            expect(aliasReads).toBeGreaterThan(0);
            expect(prematureReads).toBe(0);
          } finally {
            release.resolve();
            await Promise.allSettled(work);
            verifySpy.mockRestore();
            keySpy.mockRestore();
            lockSpy.mockRestore();
          }
        }),
      60_000,
    );

    it('times out an authority lookup without disturbing the active writer', () =>
      trackRevisionPhase(async (ownedRoots) => {
        const value = await preparedStore(ownedRoots);
        const security = await import('../workflow-control-shadow.js');
        const acquire = security.acquireOwnerJournalLock;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const work: Promise<unknown>[] = [];
        let acquisitions = 0;
        const spy = vi
          .spyOn(security, 'acquireOwnerJournalLock')
          .mockImplementation(async (...args) => {
            const unlock = await acquire(...args);
            acquisitions += 1;
            if (acquisitions === 1) {
              entered.resolve();
              await release.promise;
            }
            return unlock;
          });
        try {
          const active = ownVerification(work, value.find());
          await waitForVerificationGate(entered.promise, active);
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
          const waiter = ownVerification(work, value.find());
          const refused = expect(waiter).rejects.toMatchObject({
            code: 'WORKFLOW_EFFECT_AUTHORITY_BUSY',
          });
          await vi.advanceTimersByTimeAsync(security.WORKFLOW_CONTROL_SHADOW_POLICY.maxTimeoutMs);
          await refused;
          expect(acquisitions).toBe(1);
          vi.useRealTimers();

          release.resolve();
          await active;
          await expect(value.find()).resolves.toBeUndefined();
          expect(acquisitions).toBe(2);
          expect(await readdir(join(value.root, 'locks'))).toEqual([]);
        } finally {
          vi.useRealTimers();
          release.resolve();
          await Promise.allSettled(work);
          spy.mockRestore();
        }
      }));

    it('refuses every waiting lookup after a directory replacement and retries fresh after restoration', () =>
      trackRevisionPhase(async (ownedRoots) => {
        const value = await preparedStore(ownedRoots);
        const security = await import('../workflow-control-shadow.js');
        const original = security.assertOwnerDirectory;
        const entered = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        let rootReads = 0,
          moved = false,
          primaryFailed = false;
        const retained = value.root + '-retained';
        const restore: Array<() => void> = [],
          work: Promise<unknown>[] = [];
        try {
          const spy = vi
            .spyOn(security, 'assertOwnerDirectory')
            .mockImplementation(async (...args) => {
              if (args[0] === value.root) {
                rootReads += 1;
                entered.resolve();
                await release.promise;
              }
              return original(...args);
            });
          restore.push(() => spy.mockRestore());
          const first = ownVerification(work, value.find());
          ownVerification(work, value.find());
          const outcomes = Promise.allSettled(work);
          await waitForVerificationGate(entered.promise, first);
          expect(rootReads).toBe(1);
          await rename(value.root, retained);
          moved = true;
          await writeFile(value.root, 'unsafe directory replacement', { mode: 0o600 });
          release.resolve();
          const settled = await outcomes;
          expect(settled).toHaveLength(2);
          for (const result of settled) {
            expect(result.status).toBe('rejected');
            if (result.status === 'rejected')
              expect(result.reason).toMatchObject({
                code: 'WORKFLOW_EFFECT_AUTHORITY_PATH_UNSAFE',
              });
          }
          await rm(value.root);
          await rename(retained, value.root);
          moved = false;
          const later = ownVerification(work, value.find());
          await expect(later).resolves.toBeUndefined();
        } catch (error) {
          primaryFailed = true;
          throw error;
        } finally {
          release.resolve();
          await Promise.allSettled(work);
          await restoreVerification(
            [
              ...restore.reverse(),
              async () => {
                if (moved) await rm(value.root, { force: true });
              },
              async () => {
                if (moved) {
                  await rename(retained, value.root);
                  moved = false;
                }
              },
            ],
            primaryFailed,
          );
        }
      }));

    it('joins all started child checks before falling back from a rejected cached verification', () =>
      trackRevisionPhase(async (ownedRoots) => {
        const value = await preparedStore(ownedRoots);
        const security = await import('../workflow-control-shadow.js');
        const filesystem = (await import('node:fs/promises')).default;
        const { syncBuiltinESMExports } = await import('node:module');
        const originalRead = security.assertOwnerDirectory,
          originalEnsure = security.ensureOwnerDirectory;
        const originalStat = filesystem.lstat,
          rootStat = await originalStat(value.root);
        const entered = Promise.withResolvers<void>(),
          release = Promise.withResolvers<void>();
        let fallbackStarted = false,
          primaryFailed = false;
        const restore: Array<() => void> = [];
        // Only the fallback's existence probe is made immediate, using this real
        // unchanged root stat. Security checks still read their own live bigint stats.
        let work: ReturnType<typeof value.find> | undefined;
        try {
          const readSpy = vi
            .spyOn(security, 'assertOwnerDirectory')
            .mockImplementation(async (...args) => {
              if (args[0] === join(value.root, 'records'))
                throw new TypeError('Controlled cached security rejection.');
              if (args[0] === join(value.root, 'claims')) {
                entered.resolve();
                await release.promise;
              }
              return originalRead(...args);
            });
          restore.push(() => readSpy.mockRestore());
          const ensureSpy = vi
            .spyOn(security, 'ensureOwnerDirectory')
            .mockImplementation(async (...args) => {
              if (args[0] === value.root) fallbackStarted = true;
              return originalEnsure(...args);
            });
          restore.push(() => ensureSpy.mockRestore());
          const statSpy = vi
            .spyOn(filesystem, 'lstat')
            .mockImplementation(((...args: Parameters<typeof filesystem.lstat>) =>
              args[0] === value.root && args[1] === undefined
                ? Promise.resolve(rootStat)
                : originalStat(...args)) as typeof filesystem.lstat);
          restore.push(() => statSpy.mockRestore());
          syncBuiltinESMExports();
          work = value.find();
          await waitForVerificationGate(entered.promise, work);
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(fallbackStarted).toBe(false);
          release.resolve();
          await expect(work).resolves.toBeUndefined();
          expect(fallbackStarted).toBe(true);
        } catch (error) {
          primaryFailed = true;
          throw error;
        } finally {
          release.resolve();
          await Promise.allSettled(work ? [work] : []);
          await restoreVerification(
            [...restore.reverse(), () => syncBuiltinESMExports()],
            primaryFailed,
          );
        }
      }));
  });

  describe('concurrent approval revisions', () => {
    type Participant = {
      port: WorkflowEffectAuthorizationPort;
      prepared: Awaited<ReturnType<WorkflowEffectAuthorizationPort['prepare']>>;
    };
    let preparedCase: {
      value: Awaited<ReturnType<typeof fixture>>;
      participants: Participant[];
    };

    async function prepareRevision(
      value: Awaited<ReturnType<typeof fixture>>,
    ): Promise<Participant[]> {
      const participants: Participant[] = [];
      // Preparation is fixture setup, not the concurrency assertion. Prepare
      // every host-minted view without competing for the production 30s lock
      // budget; all 24 authorize calls below still start concurrently.
      for (let index = 0; index < 12; index += 1) {
        const port = value.makePort();
        try {
          participants.push({
            port,
            prepared: await port.prepare({
              runId: 'run-1',
              evaluationIndex: 1,
              operation: 'openslack.governance.audit',
              detail: 'bounded audit',
            }),
          });
        } catch (cause) {
          throw new Error(`Approval revision preparation failed at participant ${index + 1}/12.`, {
            cause,
          });
        }
      }
      return participants;
    }

    // Measured Windows preparation alone takes about 67s. Bound setup separately
    // from the unchanged 120s claim/complete/replay budget (30s on POSIX).
    beforeEach(
      () =>
        trackRevisionPhase(async (ownedRoots) => {
          const value = await fixture(undefined, undefined, ownedRoots);
          const { pending } = await createPending(value.makePort());
          const { decided } = await approve(value, pending.approvalId);
          const revisionOne = await prepareRevision(value);
          await value.approvals.markAuditProjected({
            runId: 'run-1',
            approvalId: pending.approvalId,
            expectedRevision: 1,
            eventId: workflowEffectApprovalAuditEventId('run-1', pending.approvalId),
          });
          expect(decided.auditProjection?.status).toBe('pending');
          const revisionTwo = await prepareRevision(value);
          preparedCase = { value, participants: [...revisionOne, ...revisionTwo] };
        }),
      platformTestTimeout(30_000),
    );

    it(
      'maps revision-one and revision-two approval views to one concurrent execution claim',
      () =>
        trackRevisionPhase(async () => {
          const { value, participants } = preparedCase;
          const settled = await Promise.allSettled(
            participants.map(({ port, prepared }) => port.authorize(prepared)),
          );
          const outcomes = settled.map((result) =>
            result.status === 'fulfilled'
              ? { status: result.status }
              : {
                  status: result.status,
                  name: result.reason?.name,
                  code: result.reason?.code,
                  causeCode: result.reason?.cause?.code,
                  causeName: result.reason?.cause?.name,
                  message: result.reason?.message,
                  causeMessage: result.reason?.cause?.message,
                },
          );
          const diagnostic = JSON.stringify(outcomes);
          const fulfilledIndex = settled.findIndex((entry) => entry.status === 'fulfilled');
          expect(
            settled.filter((entry) => entry.status === 'fulfilled'),
            diagnostic,
          ).toHaveLength(1);
          for (const rejected of settled.filter((entry) => entry.status === 'rejected')) {
            expect(rejected.reason, diagnostic).toBeInstanceOf(
              WorkflowEffectAuthorizationBusyError,
            );
            expect(rejected.reason).toMatchObject({ code: 'WORKFLOW_EFFECT_AUTHORIZATION_BUSY' });
          }
          const claimed = settled[fulfilledIndex];
          if (claimed?.status !== 'fulfilled' || claimed.value.disposition !== 'claimed') {
            throw new Error('expected one concurrent claim');
          }
          const owner = participants[fulfilledIndex]!.port;
          await owner.complete(claimed.value.authority, { ok: true });
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
          });
        }),
      platformTestTimeout(30_000),
    );
  });

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
