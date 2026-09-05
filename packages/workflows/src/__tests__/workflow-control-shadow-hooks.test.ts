import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

const roots: string[] = [];
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

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function root(name: string) {
  const temporaryRoot = process.platform === 'win32' ? tmpdir() : '/tmp';
  const value = resolve(await mkdtemp(join(temporaryRoot, `${name}-`)));
  roots.push(value);
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

async function observationPort(journalRoot: string, published: number[]) {
  let build = 0;
  return createWorkflowControlObservationPortForTest(
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
  );
}

function meta(): RunMeta {
  return {
    runId: 'run-shadow-test',
    workflowName: 'shadow-hook',
    mode: 'execute',
    manifestHash: 'a'.repeat(64),
    args: {},
    startedAt: '2026-08-03T00:00:00.000Z',
  };
}

describe('Workflow Control GS7-B authoritative post-commit hooks', () => {
  it('covers the RunStore observation inventory and never observes a failed authority write', async () => {
    const journal = join(await root('workflow-shadow-hook'), 'journal');
    const published: number[] = [];
    const port = await observationPort(journal, published);
    const fs = memFs();
    const store = new RunStore({
      access: createWorkflowRunStoreRecoveryAccess(),
      baseDir: '/test/workflows',
      fs,
      observationPort: port,
    });

    await store.initRun('run-shadow-test', meta());
    await port.flush();
    await store.transitionStatus('run-shadow-test', 'paused');
    await port.flush();
    await store.setCurrentPhase('run-shadow-test', 'review');
    await port.flush();
    await store.savePhaseCheckpoint('run-shadow-test', {
      phase: 'review',
      timestamp: '2026-08-03T00:00:01.000Z',
      status: 'completed',
    });
    await port.flush();
    await store.saveAgentResult('run-shadow-test', 'agent-1', { data: true });
    await port.flush();
    await store.appendBudgetWarning('run-shadow-test', {
      timestamp: '2026-08-03T00:00:02.000Z',
      kind: 'threshold',
      message: 'warning',
      tokensUsed: 5,
      tokenBudget: 10,
      percent: 0.5,
    });
    await port.flush();
    await store.savePendingApproval('run-shadow-test', {
      operation: 'effect',
      detail: 'not exported',
      timestamp: '2026-08-03T00:00:02.000Z',
    });
    await port.flush();
    const [approval] = await store.loadPendingApprovals('run-shadow-test');
    await store.resolvePendingApproval('run-shadow-test', approval!.id, 'approved');
    await port.flush();
    expect(published).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

    const failedPublished: number[] = [];
    const failedPort = await observationPort(
      join(await root('workflow-shadow-hook-failed'), 'journal'),
      failedPublished,
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
  });

  it('observes effect approval commits and exact authority recovery only after durable state', async () => {
    const workspace = await root('workflow-shadow-effect');
    const published: number[] = [];
    const port = await observationPort(join(workspace, 'journal'), published);
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
  });
});
