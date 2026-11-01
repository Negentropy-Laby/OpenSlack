import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunStore } from '../run-store.js';
import { createRunRecorder, waitForRecorderWrite } from '../recorder.js';
import { acquireRunTransactionLock } from '../run-ownership.js';
import { readTranscript } from '../transcript.js';
import { createHarnessTaskEligibility, bindHarnessToolEligibility } from '../harness-eligibility.js';
import { buildPermissionProfile } from '../permissions.js';
import { failedRunRecoveryEncodingBound } from '../run-recovery-state.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recorder-availability-')); roots.push(root);
  const runId = 'RUN-RECORDER-WAIT', store = createRunStore(root, { sweepOrphans: false });
  store.createRun({ runId, agentId: 'fixture', prompt: 'offline', resolvedConfig: { agentId: 'fixture', source: 'test' },
    permissionProfile: buildPermissionProfile({ agentId: 'fixture', source: 'test' }) });
  return { root, runId, store, lock: join(root, '.openslack.local/agents/runs', runId, 'run.transaction.lock') };
}

function reservedFixture(summary = 'pending') {
  const setup = fixture(), { root, runId, store } = setup, generation = 'fixture-generation', targetPath = join(root, 'fixture.txt');
  const requestHash = 'a'.repeat(64), principalHash = 'b'.repeat(64);
  store.updateRun(runId, { status: 'running', harnessExecution: {
    schema: 'openslack.harness_execution.v1', taskId: 'TASK-FIXTURE', requestHash, principalHash, baseline: 'c'.repeat(40),
    summary, acceptance: 'pending', reports: {}, evidenceRefs: [], evidence: { reservedBytes: 0, calls: {} },
    lifecycle: { phase: 'started', ownerGeneration: generation, deadlineAt: new Date(Date.now() + 60000).toISOString() },
  } });
  const recorder = createRunRecorder(store, root);
  const task = createHarnessTaskEligibility({ taskId: 'TASK-FIXTURE', taskHash: requestHash,
    principalId: 'fixture', principalHash, phase: 'execute' }, { mode: 'not_applicable' });
  const eligibility = bindHarnessToolEligibility(task, { runId, generation, toolName: 'Read', targetPath });
  const receipt = recorder.reserveToolEvidence!(runId, { callId: 'read-once', toolName: 'Read', input: {}, targetPath,
    generation, maxResultBytes: 1024 }, eligibility);
  return { ...setup, recorder, receipt };
}

describe('single-operation recorder availability', () => {
  it('waits only before acquisition then publishes one acknowledged event', async () => {
    const { root, runId, store, lock } = fixture(), recorder = createRunRecorder(store, root);
    writeFileSync(lock, 'isolated short-lived owner');
    const timer = setTimeout(() => unlinkSync(lock), 10);
    try { await waitForRecorderWrite(recorder, () => recorder.progress(runId, { step: 'once' })); }
    finally { clearTimeout(timer); }
    expect(readTranscript(runId, root).filter(event => event.data?.step === 'once')).toHaveLength(1);
  });

  it('never retries a begun callback even if its error originated as another pre-acquisition refusal', async () => {
    const { root, runId, store } = fixture(), otherLock = join(root, 'other-owner');
    writeFileSync(otherLock, 'isolated retained owner');
    let busy: unknown;
    try { acquireRunTransactionLock(otherLock, () => {}); } catch (error) { busy = error; }
    let attempts = 0;
    const recorder = createRunRecorder({ ...store, withRunTransaction(id, update) {
      attempts++;
      return store.withRunTransaction(id, state => { update(state); throw busy; });
    } }, root);
    await expect(waitForRecorderWrite(recorder, () => recorder.progress(runId, { step: 'not-published' }))).rejects.toBe(busy);
    expect(attempts).toBe(1);
    expect(readTranscript(runId, root)).toEqual([]);
  });

  it('does not mark a reservation attempted until its transaction actually owns the lock', async () => {
    const { runId, store, lock, recorder, receipt } = reservedFixture();
    writeFileSync(lock, 'isolated report owner');
    const timer = setTimeout(() => unlinkSync(lock), 10);
    try { await waitForRecorderWrite(recorder, () => recorder.markToolEvidenceAuthorizationAttempt!(receipt)); }
    finally { clearTimeout(timer); }
    expect(store.readRun(runId)!.harnessExecution!.evidence!.calls['read-once']!.phase).toBe('authorization_attempted');
    expect(() => recorder.markToolEvidenceAuthorizationAttempt!(receipt)).toThrow('already been attempted');
  });
  it('reserves pending-result fields in both normal and recovery snapshots against other writers', () => {
    const { runId, store, recorder, receipt } = reservedFixture('s'.repeat(4096));
    recorder.markToolEvidenceAuthorizationAttempt!(receipt);
    const current = store.readRun(runId)!;
    const empty = { ...current, model: '' };
    const bound = Math.max(Buffer.byteLength(JSON.stringify(empty, null, 2)), failedRunRecoveryEncodingBound(empty));
    const unsafeLength = 512 * 1024 - bound - 10;
    expect(() => store.updateRun(runId, { model: 'x'.repeat(unsafeLength) })).toThrow(expect.objectContaining({ code: 'RUN_STORAGE_LIMIT' }));
    expect(store.readRun(runId)!.model).toBeUndefined();
    expect(store.readRun(runId)!.harnessExecution!.evidence!.calls['read-once']!.resultDigest).toBeUndefined();
    store.updateRun(runId, { model: 'x'.repeat(unsafeLength - 256) });
    recorder.recordToolEvidenceCall!(runId, 'read-once');
    recorder.recordToolEvidenceResult!(runId, 'read-once', { ok: true });
    const settled = store.readRun(runId)!;
    expect(settled.harnessExecution!.evidence!.calls['read-once']!.resultDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Buffer.byteLength(JSON.stringify(settled, null, 2))).toBeLessThanOrEqual(512 * 1024);
    expect(failedRunRecoveryEncodingBound(settled)).toBeLessThanOrEqual(512 * 1024);
  });

});
