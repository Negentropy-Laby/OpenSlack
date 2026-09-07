import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { canonicalWorkflowControlAuthorityJson as canonical } from '../workflow-control-authority-contract.js';
import type { WorkflowControlAuthorityPort } from '../workflow-control-authority-client.js';
import { WorkflowRunRouter, createWorkflowRunRouteJournal } from '../workflow-run-routing.js';
import {
  reconcileWorkflowBindings,
  type WorkflowBindingReconciliationPort,
} from '../workflow-binding-reconciliation.js';
import { WorkflowRunRecoveryError } from '../workflow-run-recovery-evidence.js';
import {
  checkpointState,
  recoveryFrame,
  recoveryHead,
  recoveryView,
} from './workflow-recovery-fixtures.js';
import { settlementFixture } from './workflow-reconciliation-fixtures.js';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 240_000 : 30_000 });
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(count = 1) {
  const rootDir = await mkdtemp(join(tmpdir(), 'workflow-reconciliation-command-'));
  roots.push(rootDir);
  const state = checkpointState(count);
  const proof = {
    ...recoveryView(
      Array.from({ length: count }, (_, i) =>
        recoveryFrame(checkpointState(i + 1), 'checkpoint_commit'),
      ),
    ),
    schema: 'openslack.workflow_runner_recovery_evidence.v2' as const,
  };
  const route = proof.route;
  const router = new WorkflowRunRouter({
    schema: 'openslack.workflow_run_routing_policy.v1',
    workspaceId: proof.workspaceId,
    backend: 'go',
    routingEpoch: route.routingEpoch,
    authorityBuildHash: route.authorityBuildHash,
    qualificationEnvironmentId: 'recovery.test',
    workflowAllowlist: ['workflow.test'],
    runAllowlist: [],
    expiresAt: '2026-09-06T00:00:00.000Z',
  });
  await createWorkflowRunRouteJournal(rootDir).commit(
    router.select({
      workspaceId: proof.workspaceId,
      runId: proof.runId,
      workflowId: 'workflow.test',
      workflowVersion: '1.0.0',
      workflowSourceHash: state.activeBinding.workflowSourceHash,
      manifestHash: state.activeBinding.manifestHash,
      inputHash: state.activeBinding.inputHash,
      correlationId: state.activeBinding.correlationId,
      selectedAt: '2026-09-05T00:00:00.000Z',
    }),
  );
  const receipts = proof.bindings.map((entry) =>
    settlementFixture(JSON.parse(entry.stage), 'resolution', entry.resolution!),
  );
  const reconciliation = {
    preview: vi.fn(async () => ({
      schema: 'openslack.workflow_runner_binding_reconciliation_preview.v1' as const,
      workspaceId: proof.workspaceId,
      runId: proof.runId,
      nextCursor: null,
      items: receipts.map((receipt) => ({
        bindingId: receipt.bindingId,
        stageHash: receipt.stageHash,
        outcome: receipt.outcome,
        code: 'WORKFLOW_RUNNER_BINDING_RECONCILABLE',
        proofKind: receipt.proofKind,
        receipt: null,
      })),
    })),
    apply: vi.fn<WorkflowBindingReconciliationPort['apply']>(
      async (request) =>
        receipts.find((receipt) => receipt.idempotencyKey === request.idempotencyKey)!,
    ),
    readReceipt: vi.fn<WorkflowBindingReconciliationPort['readReceipt']>(async () => null),
    pause: vi.fn<WorkflowBindingReconciliationPort['pause']>(),
  };
  const read = vi.fn(async () => recoveryHead(state));
  const recovery = { readRecoveryEvidence: vi.fn(async () => proof) };
  const options = {
    rootDir,
    reconciliation,
    recovery,
    authority: { read } as unknown as WorkflowControlAuthorityPort,
  };
  return { ...options, options, proof, receipts, read };
}

async function files(root: string) {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => [
        entry.name,
        (await readFile(join(entry.parentPath, entry.name))).toString('hex'),
      ]),
  );
}

it('previews with zero local or remote writes and preserves the selected binding', async () => {
  const f = await fixture();
  const before = await files(f.rootDir);
  const result = await reconcileWorkflowBindings(f.proof.runId, {
    ...f.options,
    bindingId: f.receipts[0]!.bindingId,
  });
  expect(result).toMatchObject({ applied: false, paused: false, diagnostics: [], settled: [] });
  expect(f.reconciliation.preview).toHaveBeenCalledWith(
    f.proof.runId,
    f.receipts[0]!.bindingId,
    undefined,
  );
  expect(f.reconciliation.apply).not.toHaveBeenCalled();
  expect(f.reconciliation.pause).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(await files(f.rootDir)).toEqual(before);
});

it('reports already committed bindings when a later operation remains unknown', async () => {
  const f = await fixture(2);
  f.reconciliation.apply
    .mockResolvedValueOnce(f.receipts[0]!)
    .mockRejectedValueOnce(
      new WorkflowRunRecoveryError('WORKFLOW_RUN_RECOVERY_UNKNOWN', 'private cause'),
    );
  const result = await reconcileWorkflowBindings(f.proof.runId, { ...f.options, apply: true });
  expect(result).toMatchObject({
    applied: false,
    paused: false,
    settled: [f.receipts[0]],
    diagnostics: ['WORKFLOW_RUN_RECOVERY_UNKNOWN'],
  });
  expect(f.reconciliation.pause).not.toHaveBeenCalled();
  expect(canonical(result)).not.toContain('private cause');
});

it('recovers a lost apply response by its exact receipt without repeating the write', async () => {
  const f = await fixture();
  f.reconciliation.apply.mockRejectedValueOnce(
    new WorkflowRunRecoveryError('WORKFLOW_RUN_RECOVERY_UNKNOWN', 'response lost'),
  );
  f.reconciliation.readReceipt.mockResolvedValueOnce(null).mockResolvedValueOnce(f.receipts[0]!);
  const result = await reconcileWorkflowBindings(f.proof.runId, { ...f.options, apply: true });
  expect(result).toMatchObject({
    applied: true,
    paused: false,
    settled: f.receipts,
    diagnostics: [],
  });
  expect(f.reconciliation.apply).toHaveBeenCalledTimes(1);
  expect(f.reconciliation.readReceipt).toHaveBeenLastCalledWith(
    f.proof.runId,
    f.receipts[0]!.idempotencyKey,
    undefined,
  );
});

it('refuses foreign recovery evidence before an apply reaches Go', async () => {
  const f = await fixture();
  f.recovery.readRecoveryEvidence.mockResolvedValue({
    ...f.proof,
    workspaceId: 'workspace.foreign',
  });
  const result = await reconcileWorkflowBindings(f.proof.runId, { ...f.options, apply: true });
  expect(result).toMatchObject({
    applied: false,
    paused: false,
    diagnostics: ['WORKFLOW_RUN_RECOVERY_RECONCILIATION_REQUIRED'],
  });
  expect(f.reconciliation.apply).not.toHaveBeenCalled();
  expect(f.reconciliation.preview).not.toHaveBeenCalled();
});
