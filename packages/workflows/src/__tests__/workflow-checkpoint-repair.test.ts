import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import {
  checkpointState,
  recoveryFrame,
  recoveryView,
  recoveryHead,
} from './workflow-recovery-fixtures.js';
import { RunStore } from '../run-store.js';
import { createWorkflowRunStoreRecoveryAccess } from '../internal/workflow-run-store-recovery-access.js';
import { resolveWorkflowRunProjectionRoot } from '../workflow-run-projection.js';
import { WorkflowRunRouter, createWorkflowRunRouteJournal } from '../workflow-run-routing.js';
import { repairWorkflowCheckpoints } from '../workflow-checkpoint-repair.js';
import type { WorkflowRunRecoveryEvidence } from '../workflow-run-recovery-evidence.js';
import type { WorkflowControlAuthorityPort } from '../workflow-control-authority-client.js';
import { canonicalWorkflowControlAuthorityJson as canonical } from '../workflow-control-authority-contract.js';
import { atomicWrite, productionJournalSecurity } from '../workflow-control-shadow.js';
import { workflowCheckpointHash } from '../workflow-checkpoint-shadow-contract.js';

vi.setConfig({ testTimeout: process.platform === 'win32' ? 240_000 : 30_000 });
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tree(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return Object.fromEntries(
    await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const path = join(entry.parentPath, entry.name);
          return [
            path,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ];
        }),
    ),
  );
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'workflow-repair-'));
  roots.push(root);
  const store = new RunStore({
    baseDir: resolveWorkflowRunProjectionRoot(root, 'go'),
    access: createWorkflowRunStoreRecoveryAccess(),
  });
  const initial = checkpointState(0),
    runId = initial.runId,
    binding = initial.activeBinding;
  await store.initRun(runId, {
    runId,
    workflowName: 'workflow.test',
    mode: 'execute',
    manifestHash: binding.manifestHash,
    args: {},
    startedAt: initial.updatedAt,
  });
  await store.initializeCheckpointControl(runId, binding);
  await store.commitWorkflowCheckpoint(runId, binding, 'phase-0', 0, {
    artifact: Buffer.from('committed artifact'),
  });
  const state = (await store.loadCheckpointControl(runId))!;
  let proof = recoveryView([recoveryFrame(state, 'checkpoint_commit')]);
  const route = proof.route;
  const router = new WorkflowRunRouter({
    schema: 'openslack.workflow_run_routing_policy.v1',
    workspaceId: binding.workspaceId,
    backend: 'go',
    routingEpoch: route.routingEpoch,
    authorityBuildHash: route.authorityBuildHash,
    qualificationEnvironmentId: 'recovery.test',
    workflowAllowlist: ['workflow.test'],
    runAllowlist: [],
    expiresAt: '2026-09-06T00:00:00.000Z',
  });
  await createWorkflowRunRouteJournal(root).commit(
    router.select({
      workspaceId: binding.workspaceId,
      runId,
      workflowId: 'workflow.test',
      workflowVersion: '1.0.0',
      workflowSourceHash: binding.workflowSourceHash,
      manifestHash: binding.manifestHash,
      inputHash: binding.inputHash,
      correlationId: binding.correlationId,
      selectedAt: '2026-09-05T00:00:00.000Z',
    }),
  );
  let head = recoveryHead(state);
  const transition = vi.fn(async () => {
    throw Error('repair must not transition authority');
  });
  const authority = {
    read: vi.fn(async () => head),
    transition,
    accept: transition,
  } as unknown as WorkflowControlAuthorityPort;
  const read = vi.fn(async () => proof);
  return {
    root,
    runId,
    store,
    state,
    authority,
    transition,
    read,
    recovery: { readRecoveryEvidence: read },
    setProof(value: WorkflowRunRecoveryEvidence) {
      proof = value;
    },
    setHead(value: typeof head) {
      head = value;
    },
    get proof() {
      return proof;
    },
    options(apply = false) {
      return { rootDir: root, apply, authority, recovery: { readRecoveryEvidence: read } };
    },
  };
}

it('diagnoses missing routing with zero files created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-repair-empty-'));
  roots.push(root);
  expect(await repairWorkflowCheckpoints('run.recovery', { rootDir: root })).toMatchObject({
    applied: false,
    repairable: false,
    diagnostics: ['WORKFLOW_RUN_RECOVERY_ROUTE_REQUIRED'],
  });
  expect(await readdir(root)).toEqual([]);
});

it('diagnoses and repairs invalid reservation envelopes even when the checkpoint head is healthy', async () => {
  const f = await fixture(),
    marker = f.store.checkpointControlPath(f.runId) + '.intent';
  for (const value of [{ bindingId: null }, { schema: 'wrong', bindingId: null }]) {
    await atomicWrite(marker, canonical(value), productionJournalSecurity());
    const before = await tree(f.root);
    expect(await repairWorkflowCheckpoints(f.runId, f.options())).toMatchObject({
      repairable: true,
      applied: false,
      diagnostics: ['WORKFLOW_CHECKPOINT_RESERVATION_CORRUPT'],
    });
    expect(await tree(f.root)).toEqual(before);
    expect(await repairWorkflowCheckpoints(f.runId, f.options(true))).toMatchObject({
      applied: true,
    });
    await expect(
      f.store.initializeCheckpointControl(f.runId, f.state.activeBinding),
    ).resolves.toMatchObject({ revision: f.state.revision });
  }
});
it('defaults to zero writes and applies a repeatable repair with an exact invalid-UTF8 backup', async () => {
  const f = await fixture(),
    path = f.store.checkpointControlPath(f.runId),
    corrupt = Buffer.from([0xff, 0x7b, 0x00]);
  await writeFile(path, corrupt);
  const before = await tree(f.root);
  expect(await repairWorkflowCheckpoints(f.runId, f.options())).toMatchObject({
    repairable: true,
    applied: false,
  });
  expect(await tree(f.root)).toEqual(before);
  const result = await repairWorkflowCheckpoints(f.runId, f.options(true));
  expect(result).toMatchObject({ repairable: true, applied: true });
  expect(result.backups).toHaveLength(1);
  expect(await readFile(result.backups[0]!)).toEqual(corrupt);
  expect(await f.store.loadCheckpointControl(f.runId)).toEqual(f.state);
  const repaired = await tree(f.root);
  expect(await repairWorkflowCheckpoints(f.runId, f.options(true))).toMatchObject({
    applied: false,
    diagnostics: ['WORKFLOW_CHECKPOINT_CACHE_HEALTHY'],
  });
  expect(await tree(f.root)).toEqual(repaired);
  expect(f.transition).not.toHaveBeenCalled();
});
it.each(['insufficient', 'workspace', 'lease', 'phase'] as const)(
  'refuses %s evidence before writing',
  async (kind) => {
    const f = await fixture(),
      path = f.store.checkpointControlPath(f.runId);
    await writeFile(path, '{');
    if (kind === 'insufficient') f.setProof(recoveryView([]));
    if (kind === 'workspace') f.setProof({ ...f.proof, workspaceId: 'workspace.foreign' });
    if (kind === 'lease') f.setProof({ ...f.proof, activeAttempts: ['attempt.active'] });
    if (kind === 'phase') f.setHead(recoveryHead(f.state, 5));
    const before = await tree(f.root);
    expect(await repairWorkflowCheckpoints(f.runId, f.options(true))).toMatchObject({
      applied: false,
      repairable: false,
    });
    expect(await tree(f.root)).toEqual(before);
  },
);
it('revalidates concurrent leases outside the lock and preserves a resumable repair reservation', async () => {
  const f = await fixture(),
    path = f.store.checkpointControlPath(f.runId);
  await writeFile(path, '{');
  f.read
    .mockResolvedValueOnce(f.proof)
    .mockResolvedValueOnce({ ...f.proof, activeAttempts: ['attempt.concurrent'] });
  expect(await repairWorkflowCheckpoints(f.runId, f.options(true))).toMatchObject({
    applied: false,
  });
  expect(await readFile(path, 'utf8')).toBe('{');
  expect(JSON.parse(await readFile(path + '.intent', 'utf8')).bindingId).toMatch(/^repair\./u);
  expect(await repairWorkflowCheckpoints(f.runId, f.options(true))).toMatchObject({
    applied: true,
  });
});
it('backs up a torn committed resume intent and never rewinds generation', async () => {
  const f = await fixture(),
    prior = f.state;
  const activeBinding = {
    ...prior.activeBinding,
    jobId: 'job.next',
    attemptId: 'attempt.next',
    leaseId: 'lease.next',
  };
  const resumed = {
    ...prior,
    revision: prior.revision + 1,
    resumeGeneration: 1,
    activeBinding,
    seenBindingHashes: [...prior.seenBindingHashes, workflowCheckpointHash(activeBinding)],
  };
  const frame = recoveryFrame(resumed, 'resume_advance');
  f.setProof({ ...f.proof, bindings: [...f.proof.bindings, frame] });
  f.setHead(recoveryHead(resumed));
  const intent = join(
    f.store.checkpointControlDir(f.runId),
    `resume-${createHash('sha256').update(frame.bindingId).digest('hex')}.json`,
  );
  await atomicWrite(intent, '{"schema":', productionJournalSecurity());
  await writeFile(f.store.checkpointControlPath(f.runId), '{');
  const result = await repairWorkflowCheckpoints(f.runId, f.options(true));
  expect(result).toMatchObject({ applied: true });
  const backup = result.backups.find((path) => path.startsWith(intent))!;
  expect(await readFile(backup, 'utf8')).toBe('{"schema":');
  await expect(readFile(intent)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await f.store.loadCheckpointControl(f.runId))?.resumeGeneration).toBe(1);
  f.setProof(recoveryView([recoveryFrame(prior, 'checkpoint_commit')]));
  f.setHead(recoveryHead(prior));
  const before = await tree(f.root);
  expect(await repairWorkflowCheckpoints(f.runId, f.options(true))).toMatchObject({
    applied: false,
  });
  expect(await tree(f.root)).toEqual(before);
});
