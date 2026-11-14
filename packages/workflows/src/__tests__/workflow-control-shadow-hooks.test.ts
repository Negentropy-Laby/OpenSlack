import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { RunStore, type RunStoreFs, type RunMeta } from '../run-store.js';
import { createWorkflowRunStoreRecoveryAccess } from '../internal/workflow-run-store-recovery-access.js';
import {
  createWorkflowControlObservationPortForTest,
  createWorkflowControlShadowPublisherPort,
  type WorkflowControlShadowJournalSecurityDependencies,
} from '../workflow-control-shadow.js';
import { createWorkflowEffectDecisionAuthority } from '../workflow-effect-approval.js';
import { LocalWorkflowEffectApprovalStore } from '../workflow-effect-approval-store.js';
import { acceptedReceipt, shadowObservation } from './workflow-control-shadow-fixtures.js';

type ObservationPort = Awaited<ReturnType<typeof createWorkflowControlObservationPortForTest>>;
interface OwnedHookCase {
  roots: string[];
  ports: Set<ObservationPort>;
  work: Set<Promise<unknown>>;
  phase: string;
  started: number;
  steps: { phase: string; durationMs: number; outcome: 'fulfilled' | 'rejected' }[];
  diagnostics: Record<string, unknown>[];
}
const ownedCases = new WeakMap<TestContext['task'], OwnedHookCase>();
function ownCase(context: TestContext, operation: (owned: OwnedHookCase) => Promise<void>) {
  const owned: OwnedHookCase = { roots: [], ports: new Set(), work: new Set(), phase: 'start', started: performance.now(), steps: [], diagnostics: [] };
  ownedCases.set(context.task, owned);
  const work = Promise.resolve().then(() => operation(owned));
  owned.work.add(work);
  void work.catch(() => undefined);
  return work;
}
async function measure<T>(owned: OwnedHookCase, phase: string, operation: () => Promise<T>): Promise<T> {
  owned.phase = phase;
  const started = performance.now();
  let completed = false;
  try { const value = await operation(); completed = true; return value; }
  finally {
    owned.steps.push({ phase, durationMs: performance.now() - started, outcome: completed ? 'fulfilled' : 'rejected' });
    if (owned.phase === phase) owned.phase = 'between_segments';
  }
}
function diagnostic(context: TestContext, owned: OwnedHookCase, phase: 'before_drain' | 'retained' | 'after_drain', cleanupFailures: number) {
  owned.diagnostics.push({ code: 'WORKFLOW_SHADOW_HOOK_TEST_LIFECYCLE', phase,
    activePhase: owned.phase, elapsedMs: performance.now() - owned.started,
    steps: owned.steps.map((step) => ({ ...step })), cleanupFailures, retainedRoots: phase === 'retained' ? owned.roots.length : 0 });
  Object.assign(context.task.meta, { workflowShadowHookLifecycle: owned.diagnostics });
}
const UNIT_JOURNAL_SECURITY: WorkflowControlShadowJournalSecurityDependencies = Object.freeze({
  platform: 'win32',
  currentWindowsSid: () => 'S-1-5-21-1000',
  readWindowsPathSecurity: () =>
    JSON.stringify({
      owner: 'S-1-5-21-1000',
      protected: true,
      reparse: false,
      rules: [
        { sid: 'S-1-5-21-1000', type: 'Allow' },
        { sid: 'S-1-5-18', type: 'Allow' },
      ],
    }),
  hardenPath: () => undefined,
});

vi.setConfig({ testTimeout: process.platform === 'win32' ? 45_000 : 5_000 });

afterEach(async (context) => {
  const owned = ownedCases.get(context.task);
  if (!owned) return;
  const failed = context.task.result?.state === 'fail';
  if (failed) diagnostic(context, owned, 'before_drain', 0);
  // A test deadline does not cancel its producer. Join it before the final
  // scheduled-work snapshot; a hung owner leaves its private directory intact.
  const work = await Promise.allSettled([...owned.work]);
  const ports = await Promise.allSettled([...owned.ports].map((port) => port.flush()));
  const failures = [...work, ...ports].filter((result) => result.status === 'rejected').length;
  if (failures) {
    diagnostic(context, owned, 'retained', failures);
    // A rejected producer already carries the original case failure.
    if (!failed && work.every((result) => result.status === 'fulfilled')) throw new Error('WORKFLOW_SHADOW_HOOK_TEST_CLEANUP_FAILED');
    return;
  }
  const removed = await Promise.allSettled(owned.roots.map((root) => rm(root, { force: true, recursive: true })));
  const cleanupFailures = removed.filter((result) => result.status === 'rejected').length;
  diagnostic(context, owned, cleanupFailures ? 'retained' : 'after_drain', cleanupFailures);
  if (cleanupFailures && !failed) throw new Error('WORKFLOW_SHADOW_HOOK_TEST_CLEANUP_FAILED');
  ownedCases.delete(context.task);
});

async function root(name: string, owned: OwnedHookCase) {
  const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  const value = resolve(await measure(owned, 'fixture.directory', () => mkdtemp(join(temporaryRoot, `${name}-`))));
  owned.roots.push(value);
  return value;
}

function memFs(failPath?: string): RunStoreFs & { readonly files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async mkdir(path) {
      files.set(`${path}/`, '');
    },
    async writeFile(path, content) {
      if (path === failPath) throw new Error('authority write failed');
      files.set(path, content);
    },
    async readFile(path) {
      return files.get(path) ?? null;
    },
    async appendFile(path, line) {
      files.set(path, `${files.get(path) ?? ''}${line}`);
    },
    async exists(path) {
      return files.has(path) || files.has(`${path}/`);
    },
  };
}

async function observationPort(journalRoot: string, published: number[], owned: OwnedHookCase) {
  let build = 0;
  const port = await measure(owned, 'fixture.initialize_and_replay', () => createWorkflowControlObservationPortForTest(
    {
      enabled: true,
      workspaceId: 'workspace.test',
      journalRoot,
      publisher: createWorkflowControlShadowPublisherPort(async (envelope) => {
        published.push(envelope.source.sourceSequence);
        return acceptedReceipt(envelope.source.sourceSequence, envelope.observation);
      }),
      buildObservation: async (runId) => {
        build += 1;
        return shadowObservation({
          runId,
          updatedAt: `2026-08-03T00:00:${String(build).padStart(2, '0')}.000Z`,
        });
      },
    },
    UNIT_JOURNAL_SECURITY,
  ));
  owned.ports.add(port);
  return port;
}

function meta(): RunMeta {
  return {
    runId: 'run-shadow-test',
    workflowName: 'shadow-hook',
    mode: 'execute',
    manifestHash: 'a'.repeat(64),
    manifestHashDomain: 'raw-sha256',
    args: {},
    startedAt: '2026-08-03T00:00:00.000Z',
  };
}

describe('Workflow Control GS7-B authoritative post-commit hooks', () => {
  it('covers the RunStore observation inventory after committed authority writes', (context) => ownCase(context, async (owned) => {
    const journal = join(await root('workflow-shadow-hook', owned), 'journal');
    const published: number[] = [];
    const port = await observationPort(journal, published, owned);
    const fs = memFs();
    const store = new RunStore({
      access: createWorkflowRunStoreRecoveryAccess(),
      baseDir: '/test/workflows',
      fs,
      observationPort: port,
    });

    await measure(owned, 'authority.init_run', () => store.initRun('run-shadow-test', meta()));
    await measure(owned, 'flush.1', () => port.flush());
    await measure(owned, 'authority.transition_status', () => store.transitionStatus('run-shadow-test', 'paused'));
    await measure(owned, 'flush.2', () => port.flush());
    await measure(owned, 'authority.current_phase', () => store.setCurrentPhase('run-shadow-test', 'review'));
    await measure(owned, 'flush.3', () => port.flush());
    await measure(owned, 'authority.phase_checkpoint', () => store.savePhaseCheckpoint('run-shadow-test', {
      phase: 'review',
      timestamp: '2026-08-03T00:00:01.000Z',
      status: 'completed',
    }));
    await measure(owned, 'flush.4', () => port.flush());
    await measure(owned, 'authority.agent_result', () => store.saveAgentResult('run-shadow-test', 'agent-1', { data: true }));
    await measure(owned, 'flush.5', () => port.flush());
    await measure(owned, 'authority.budget_warning', () => store.appendBudgetWarning('run-shadow-test', {
      timestamp: '2026-08-03T00:00:02.000Z',
      kind: 'threshold',
      message: 'warning',
      tokensUsed: 5,
      tokenBudget: 10,
      percent: 0.5,
    }));
    await measure(owned, 'flush.6', () => port.flush());
    await measure(owned, 'authority.pending_approval', () => store.savePendingApproval('run-shadow-test', {
      operation: 'effect',
      detail: 'not exported',
      timestamp: '2026-08-03T00:00:02.000Z',
    }));
    await measure(owned, 'flush.7', () => port.flush());
    const [approval] = await measure(owned, 'authority.load_approvals', () => store.loadPendingApprovals('run-shadow-test'));
    await measure(owned, 'authority.resolve_approval', () => store.resolvePendingApproval('run-shadow-test', approval!.id, 'approved'));
    await measure(owned, 'flush.8', () => port.flush());
    expect(published).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  }));

  it('never observes a failed authority write', (context) => ownCase(context, async (owned) => {
    const failedPublished: number[] = [];
    const failedPort = await observationPort(
      join(await root('workflow-shadow-hook-failed', owned), 'journal'),
      failedPublished,
      owned,
    );
    const failing = new RunStore({
      access: createWorkflowRunStoreRecoveryAccess(),
      baseDir: '/failed/workflows',
      fs: memFs('/failed/workflows/runs/run-shadow-test/status.json'),
      observationPort: failedPort,
    });
    await expect(failing.initRun('run-shadow-test', meta())).rejects.toThrow(
      'authority write failed',
    );
    await failedPort.flush();
    expect(failedPublished).toEqual([]);
  }));

  it('observes effect approval commits and exact authority recovery only after durable state', (context) => ownCase(context, async (owned) => {
    const workspace = await root('workflow-shadow-effect', owned);
    const published: number[] = [];
    const port = await observationPort(join(workspace, 'journal'), published, owned);
    const now = Date.now();
    const authority = createWorkflowEffectDecisionAuthority({
      workspaceId: 'workspace.test',
      humanPrincipalIds: ['human-reviewer'],
      capabilities: ['workflow.effect.decide'],
      maxBindingTtlMs: 60_000,
    });
    let offset = 1000;
    const approvalRoot = join(workspace, 'effect-approvals');
    const store = new LocalWorkflowEffectApprovalStore(
      approvalRoot,
      authority,
      () => new Date(now + offset).toISOString(),
      port,
    );
    await store.createPending({
      runId: 'run-shadow-test',
      approvalId: 'approval-1',
      correlationId: 'correlation-1',
      workflowId: 'workflow-1',
      workflowVersion: '1.0.0',
      workflowHash: 'a'.repeat(64),
      inputHash: 'b'.repeat(64),
      effectId: `workflow-effect:sha256:${'c'.repeat(64)}`,
      effectHash: 'c'.repeat(64),
      requiredCapability: 'workflow.effect.decide',
      createdAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    });
    await port.flush();
    const reasonHash = 'd'.repeat(64);
    const binding = authority.issueHumanDecisionBinding({
      principalId: 'human-reviewer',
      capability: 'workflow.effect.decide',
      runId: 'run-shadow-test',
      approvalId: 'approval-1',
      correlationId: 'correlation-1',
      approvalExpiresAt: new Date(now + 60_000).toISOString(),
      decision: 'approved',
      reasonHash,
      expiresAt: new Date(now + 30_000).toISOString(),
    });
    offset = Date.parse(binding.issuedAt) - now;
    const decided = await store.decide({
      runId: 'run-shadow-test',
      approvalId: 'approval-1',
      expectedRevision: 0,
      decision: 'approved',
      reasonHash,
      binding,
    });
    await port.flush();
    offset += 1000;
    await store.markAuditProjected({
      runId: 'run-shadow-test',
      approvalId: 'approval-1',
      expectedRevision: 1,
      eventId: decided.auditProjection!.eventId,
    });
    await port.flush();
    expect(published).toEqual([1, 2, 3]);
    await expect(
      store.markAuditProjected({
        runId: 'run-shadow-test',
        approvalId: 'approval-1',
        expectedRevision: 1,
        eventId: decided.auditProjection!.eventId,
      }),
    ).resolves.toMatchObject({
      revision: 2,
      auditProjection: { status: 'recorded', eventId: decided.auditProjection!.eventId },
    });
    await port.flush();
    expect(published).toEqual([1, 2, 3, 4]);
  }));
});
