import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, openSync, closeSync, ftruncateSync, unlinkSync } from 'node:fs';
import type * as FsModule from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessTaskHost, type ApprovedHarnessTask, type HarnessTaskHostOptions } from '../harness-task-host.js';
import { createRunStore, HARNESS_TRANSCRIPT_MAX_BYTES, HARNESS_TERMINAL_RESERVE_BYTES, readRunStateSnapshot, readRunStateSnapshotWhenAvailable } from '../run-store.js';
import { createRunRecorder, type ToolEvidenceReservation } from '../recorder.js';
import { buildPermissionProfile } from '../permissions.js';
import { readHarnessStopIntent } from '../harness-stop.js';
import { visitStrictTranscript } from '../transcript.js';
import { reconcileHarnessTask } from '../harness-reconciliation.js';
import { HarnessAdmissionStore } from '../harness-admission.js';
import { bindHarnessToolEligibility, createHarnessTaskEligibility } from '../harness-eligibility.js';

vi.mock('node:fs', async original => { const fs = await original<typeof FsModule>(); return { ...fs, renameSync: vi.fn(fs.renameSync), unlinkSync: vi.fn(fs.unlinkSync) }; });
const rename = vi.mocked(renameSync);
const nativeRename = rename.getMockImplementation()!;
const unlink = vi.mocked(unlinkSync), nativeUnlink = unlink.getMockImplementation()!;
const roots: string[] = [];
const hosts: HarnessTaskHost[] = [];
afterEach(async () => {
  rename.mockReset().mockImplementation(nativeRename);
  unlink.mockReset().mockImplementation(nativeUnlink);
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.close(100);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred() { return Promise.withResolvers<void>(); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-state-repair-')); roots.push(root);
  const config = { agentId: 'fixture', source: 'fixture', tools: ['Read'] };
  const task: ApprovedHarnessTask = { taskId: 'TASK-FIXTURE', principalHash: 'a'.repeat(64), baseline: 'b'.repeat(40), timeoutMs: 5000,
    request: { agentId: 'fixture', prompt: 'fixture', resolvedConfig: config, permissionProfile: buildPermissionProfile(config) },
    scope: { readPaths: ['fixture.txt'], writePaths: [], forbiddenPaths: ['.git/**'] }, outputSchema: { type: 'object' },
  };
  const store = createRunStore(root, { sweepOrphans: false });
  const execute = vi.fn(async () => ({ data: { answer: 'fixture' }, exitConfirmed: true as const }));
  const options: HarnessTaskHostOptions = { identityRoot: root, workspaceId: 'fixture', store,
    readTask: vi.fn(async () => task), authorize: vi.fn(async () => {}), publish: vi.fn(async () => {}),
    prepare: vi.fn(async () => ({ execute, accept: async () => ({ outcome: 'verified' as const, summary: 'fixture', evidenceRefs: [] }) })),
  };
  const host = new HarnessTaskHost(options); hosts.push(host);
  return { root, task, store, options, host, execute };
}
function runningFixture() {
  const setup = fixture();
  const runId = 'RUN-EVIDENCE-FIXTURE';
  const initial = setup.store.createRun({ ...setup.task.request, runId });
  setup.store.updateRun(runId, { status: 'running', harnessExecution: { schema: 'openslack.harness_execution.v1', taskId: setup.task.taskId,
    requestHash: 'c'.repeat(64), principalHash: setup.task.principalHash, baseline: setup.task.baseline, acceptance: 'pending', summary: 'pending', reports: {}, evidenceRefs: [],
    lifecycle: { phase: 'started', ownerGeneration: 'fixture-owner', deadlineAt: new Date(Date.parse(initial.startedAt) + 60_000).toISOString() },
    evidence: { reservedBytes: 0, calls: {} },
  } });
  const recorder = createRunRecorder(setup.store, setup.root);
  // Quota unit fixture only: this explicit internal observation is not a formal
  // principal, production authorizer or identity provisioning receipt.
  const eligibility = createHarnessTaskEligibility({ taskId: setup.task.taskId, taskHash: 'c'.repeat(64), principalId: 'quota-unit-fixture-only',
    principalHash: setup.task.principalHash, phase: 'execute' }, { mode: 'not_applicable' });
  const reserve = (value: ToolEvidenceReservation) => recorder.reserveToolEvidence!(runId, value,
    bindHarnessToolEligibility(eligibility, { runId, generation: value.generation, toolName: value.toolName, targetPath: value.targetPath }));
  return { ...setup, runId, recorder, reserve, directory: join(setup.root, '.openslack.local/agents/runs', runId) };
}

describe('governed admission and shared canonical state repair', () => {
  it('retains ownership and publishes a non-executable failure when admission unlink fails after exclusive publication', async () => {
    const { root, store, host, options, execute } = fixture();
    unlink.mockImplementation(path => {
      if (String(path).includes('harness-admissions') && String(path).endsWith('.tmp') && !String(path).includes('.stop.json.')) throw Object.assign(new Error('fixture AV EPERM'), { code: 'EPERM' });
      return nativeUnlink(path);
    });
    await expect(host.dispatch('TASK-FIXTURE', 'published-temp-failed')).rejects.toMatchObject({ code: 'INDETERMINATE',
      observation: { kind: 'admission', canonicalRunPresent: true, disposition: 'reconcile_required' } });
    const [run] = store.listRuns();
    expect(run).toMatchObject({ status: 'failed', harnessExecution: { visible: false, lifecycle: { phase: 'stopped_before_start' } } });
    expect(readHarnessStopIntent(root, run!.runId)?.reason).toBe('persistence_failed');
    expect(execute).not.toHaveBeenCalled(); expect(options.publish).not.toHaveBeenCalled();
    expect(await host.close(100)).toEqual({ stopped: false, unknownRunIds: [run!.runId] });
  });
  it('owns publishing before close and never returns an unowned pending success', async () => {
    const { host, options, execute, store } = fixture();
    const published = deferred();
    vi.mocked(options.publish).mockImplementation(async () => published.promise);
    const pending = host.dispatch('TASK-FIXTURE', 'publishing').then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(options.publish).toHaveBeenCalledOnce());
    const closing = host.close(1000);
    published.resolve();
    expect(await pending).toHaveProperty('error');
    expect(await closing).toEqual({ stopped: true, unknownRunIds: [] });
    expect(execute).not.toHaveBeenCalled();
    expect(store.listRuns()[0]).toMatchObject({ status: 'failed', harnessExecution: { lifecycle: { phase: 'stopped_before_start' } } });
  });

  it('expires a confirmation gate from the original admission deadline without starting SDK work', async () => {
    vi.useFakeTimers();
    const { host, execute } = fixture();
    const { runId } = await host.dispatch('TASK-FIXTURE', 'confirmation-never-settled', true);
    await vi.advanceTimersByTimeAsync(5001);
    expect(host.read(runId)).toMatchObject({ status: 'failed', harnessExecution: { lifecycle: { phase: 'stopped_before_start' } } });
    expect(execute).not.toHaveBeenCalled();
    expect(await host.close(100)).toEqual({ stopped: true, unknownRunIds: [] });
  });

  it('does not let another confirmation attempt authorize or cancel the owner', async () => {
    const { host, execute } = fixture();
    const binding = { planId: 'PLAN-FIXTURE', executionId: 'GEXEC-FIXTURE', confirmationAttemptId: 'owner-attempt' };
    const { runId } = await host.dispatch('TASK-FIXTURE', 'owned-confirmation', true, binding);
    host.settleConfirmedAdmissions(binding.planId, { state: 'uncertain', confirmationAttemptId: 'duplicate-bad-token' });
    expect(host.read(runId)?.harnessExecution?.lifecycle?.phase).toBe('awaiting_confirmation');
    host.settleConfirmedAdmissions(binding.planId, { state: 'succeeded', executionId: binding.executionId, confirmationAttemptId: binding.confirmationAttemptId });
    await vi.waitFor(() => expect(host.read(runId)?.status).toBe('completed'));
    expect(execute).toHaveBeenCalledOnce();
  });

  it('settles a failed originating confirmation without executing even when its plan was durable', async () => {
    const { host, execute, root } = fixture();
    const binding = { planId: 'PLAN-FIXTURE', executionId: 'GEXEC-FIXTURE', confirmationAttemptId: 'owner-attempt' };
    const { runId } = await host.dispatch('TASK-FIXTURE', 'owner-failure', true, binding);
    host.settleConfirmedAdmissions(binding.planId, { state: 'uncertain', confirmationAttemptId: binding.confirmationAttemptId });
    await vi.waitFor(() => expect(host.read(runId)?.status).toBe('failed'));
    expect(readHarnessStopIntent(root, runId)?.reason).toBe('confirmation_failed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not cross the business cutoff after asynchronous authority rechecks', async () => {
    const { host, options, store, execute, task } = fixture();
    const clock = vi.spyOn(Date, 'now');
    let cutoff: number | undefined;
    vi.mocked(options.prepare).mockImplementation(async (_task, runId) => {
      cutoff = Date.parse(store.getRun(runId)!.harnessExecution!.lifecycle!.deadlineAt) - 1000;
      store.withRunTransaction(runId, state => ({ patch: { harnessExecution: { ...state.harnessExecution!,
        lifecycle: { ...state.harnessExecution!.lifecycle!, executionDeadlineAt: new Date(cutoff!).toISOString() } } } }));
      return { execute, accept: async () => ({ outcome: 'verified', summary: 'fixture', evidenceRefs: [] }) };
    });
    vi.mocked(options.authorize).mockImplementation(async (_task, phase) => {
      if (phase === 'execute' && cutoff) clock.mockReturnValue(cutoff + 1);
    });
    const { runId } = await host.dispatch(task.taskId, 'business-cutoff');
    await vi.waitFor(() => expect(host.read(runId)?.status).toBe('failed'));
    expect(host.read(runId)?.harnessExecution?.lifecycle?.phase).toBe('stopped_before_start');
    expect(execute).not.toHaveBeenCalled();
  });

  it('waits for the publisher to retire its temporary hard link without weakening the owned-file guard', async () => {
    const { root } = fixture();
    const admissions = new HarnessAdmissionStore(root);
    const key = 'd'.repeat(64), requestHash = 'e'.repeat(64), runId = 'RUN-CROSS-PROCESS-PUBLICATION';
    const directory = join(root, '.openslack.local/agents/harness-admissions');
    const target = join(directory, `${key}.json`);
    const source = `import {writeFileSync,writeSync,linkSync,unlinkSync} from 'node:fs';
      const target=process.argv[1], temporary=target+'.publisher.tmp';
      writeFileSync(temporary,JSON.stringify({schema:'openslack.harness_admission.v1',key:process.argv[2],requestHash:process.argv[3],runId:process.argv[4]}));
      linkSync(temporary,target);writeSync(1,'linked\\n');setTimeout(()=>unlinkSync(temporary),150);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, target, key, requestHash, runId], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Publisher exit ${code}`))); });
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
    expect(statSync(target).nlink).toBe(2);
    expect(admissions.admit(key, requestHash)).toMatchObject({ created: false, record: { runId } });
    await closed;
    expect(statSync(target).nlink).toBe(1);
  });

  it('preserves corrupt canonical bytes and leaves a durable stop fact before a state-lock failure', async () => {
    const { host, options, root } = fixture();
    let runId = '';
    vi.mocked(options.authorize).mockImplementation(async (_task, phase) => {
      if (phase === 'execute') writeFileSync(join(root, '.openslack.local/agents/runs', runId, 'run.json'), 'corrupt preserved fixture\n');
    });
    ({ runId } = await host.dispatch('TASK-FIXTURE', 'corrupt-before-first-execution-read'));
    await vi.waitFor(() => expect(readHarnessStopIntent(root, runId)).not.toBeNull());
    expect(readFileSync(join(root, '.openslack.local/agents/runs', runId, 'run.json'), 'utf8')).toBe('corrupt preserved fixture\n');
    expect(await host.close(100)).toEqual({ stopped: false, unknownRunIds: [runId] });
    const admissions = join(root, '.openslack.local/agents/harness-admissions'), displaced = join(root, 'retained-admissions');
    const stopBytes = readFileSync(join(admissions, `${runId}.stop.json`));
    renameSync(admissions, displaced);
    try {
      symlinkSync(displaced, admissions, process.platform === 'win32' ? 'junction' : 'dir');
      // An absent leaf behind a redirected ancestor is unsafe, not "no stop".
      expect(() => readHarnessStopIntent(root, 'RUN-ABSENT-LEAF')).toThrow('directory link');
    } finally {
      if (existsSync(admissions)) unlinkSync(admissions);
      renameSync(displaced, admissions);
    }
    expect(readFileSync(join(admissions, `${runId}.stop.json`))).toEqual(stopBytes);
  });

  it('publishes a stop barrier despite an orphan writer lock and never acknowledges a later worker report', async () => {
    const { host, options, root, execute } = fixture();
    let runId = '', canonical = Buffer.alloc(0);
    execute.mockImplementation(async () => {
      const directory = join(root, '.openslack.local/agents/runs', runId);
      canonical = readFileSync(join(directory, 'run.json'));
      writeFileSync(join(directory, 'run.transaction.lock'), JSON.stringify({ schema: 'openslack.run_transaction.v1', runId,
        transactionId: 'fixture-abandoned-transaction', ownerPid: process.pid }), { flag: 'wx' });
      throw new Error('Fixture peer failed while worker publication was unconfirmed');
    });
    ({ runId } = await host.dispatch('TASK-FIXTURE', 'orphan-writer'));
    await vi.waitFor(() => expect(readHarnessStopIntent(root, runId)).toMatchObject({ reason: 'execution_failed' }), { timeout: 2000 });
    const worker = new HarnessTaskHost({ ...options, callbackRunId: runId }); hosts.push(worker);
    await expect(worker.report({ runId, reportId: 'late', summary: 'must not be acknowledged', evidenceRefs: [] })).rejects.toThrow('changed during read');
    const directory = join(root, '.openslack.local/agents/runs', runId);
    expect(readFileSync(join(directory, 'run.json'))).toEqual(canonical);
    expect(existsSync(join(directory, 'run.transaction.lock'))).toBe(true);
    expect(await host.close(100)).toEqual({ stopped: false, unknownRunIds: [runId] });
  });

  it('denies reports for awaiting, merely authorized and legacy pending runs', async () => {
    const { host, options, store } = fixture();
    const { runId } = await host.dispatch('TASK-FIXTURE', 'not-started', true);
    const worker = new HarnessTaskHost({ ...options, callbackRunId: runId }); hosts.push(worker);
    const report = { runId, reportId: 'too-early', summary: 'not executed', evidenceRefs: [] };
    for (const phase of ['awaiting_confirmation', 'authorized', 'legacy'] as const) {
      store.withRunTransaction(runId, state => ({ patch: { harnessExecution: { ...state.harnessExecution!,
        lifecycle: phase === 'legacy' ? undefined : { ...state.harnessExecution!.lifecycle!, phase },
      } } }));
      await expect(worker.report(report)).rejects.toThrow(/confirmed started|deadline expired/);
    }
    expect(host.read(runId)?.harnessExecution?.reports).toEqual({});
  });

  it('revalidates accepted file bytes after the final completion CAS obtains its genuine process lock', async () => {
    const { host, root, options, store } = fixture();
    const path = join(root, 'fixture.txt'), control = join(root, 'acceptance-control');
    mkdirSync(control); writeFileSync(path, 'before');
    let accepted = false, finalCas = false, gated = false;
    let closed: Promise<void> = Promise.resolve();
    const prepared = Promise.withResolvers<void>();
    vi.mocked(options.authorize).mockImplementation(async (_task, phase) => { if (phase === 'accept' && accepted) finalCas = true; });
    vi.mocked(options.prepare).mockImplementation(async (_task, runId) => {
      const module = new URL('../../dist/run-store.js', import.meta.url).href;
      const script = `import{createRunStore}from${JSON.stringify(module)};import{existsSync,writeFileSync,writeSync}from'node:fs';import{join}from'node:path';
        const[root,id,control,target]=process.argv.slice(1);writeSync(1,'ready\\n');while(!existsSync(join(control,'start')))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
        createRunStore(root,{sweepOrphans:false}).withRunTransaction(id,s=>{writeFileSync(join(control,'locked'),'1');while(!existsSync(join(control,'release')))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);writeFileSync(target,'drift');return{patch:{toolCalls:s.toolCalls+1}};});`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, runId, control, path], { stdio: ['ignore', 'pipe', 'pipe'] });
      let error = ''; child.stderr.on('data', bytes => { error += bytes; });
      closed = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(error))); });
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
      prepared.resolve();
      return { execute: async () => { writeFileSync(path, 'after'); return { data: {}, exitConfirmed: true }; },
        accept: async () => { accepted = true; return { outcome: 'verified', summary: 'fixture', evidenceRefs: [] }; },
        revalidateAccepted: () => { if (readFileSync(path, 'utf8') !== 'after') throw new Error('Accepted bytes changed'); },
      };
    });
    const transaction = store.withRunTransaction;
    vi.spyOn(store, 'withRunTransaction').mockImplementation((runId, update) => {
      if (finalCas && !gated) {
        gated = true; writeFileSync(join(control, 'start'), '1');
        const until = Date.now() + 1000;
        while (!existsSync(join(control, 'locked'))) { if (Date.now() >= until) throw new Error('Fixture process did not acquire its lock'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
        writeFileSync(join(control, 'release'), '1');
      }
      return transaction(runId, update);
    });
    try {
      const { runId } = await host.dispatch('TASK-FIXTURE', 'completion-drift');
      await prepared.promise;
      await vi.waitFor(() => expect(['completed', 'failed']).toContain(host.read(runId)?.status));
      expect(host.read(runId)?.status).toBe('failed');
      expect(host.read(runId)?.harnessExecution?.acceptance).not.toBe('verified');
      expect(readFileSync(path, 'utf8')).toBe('drift');
    } finally { writeFileSync(join(control, 'start'), '1'); writeFileSync(join(control, 'release'), '1'); await closed; }
  });

  it('keeps historical verified evidence observable after the execution lease expires', async () => {
    const { host, options } = fixture();
    const { runId } = await host.dispatch('TASK-FIXTURE', 'history');
    await vi.waitFor(() => expect(host.read(runId)?.status).toBe('completed'));
    const before = readFileSync(host.read(runId)!.transcriptPath);
    const historical = await options.readTask('TASK-FIXTURE');
    const observe = vi.fn(async () => historical);
    const authorize = vi.fn(async () => { throw new Error('lease expired'); });
    const result = await reconcileHarnessTask({ ...options, readTask: authorize as never, authorize,
      readTaskForReconciliation: observe, observeExecutionEligibility: async () => false,
      inspect: async () => ({ deployment: 'matched', workspace: 'matched', process: 'exited' }) }, runId);
    expect(result).toMatchObject({ disposition: 'existing_verified_result', currentExecutionEligibility: 'ineligible' });
    expect(authorize).not.toHaveBeenCalled();
    expect(readFileSync(host.read(runId)!.transcriptPath)).toEqual(before);
  });
});

describe('owned RunStore transactions and full evidence quota', () => {
  it.each(['ordinary', 'harness'] as const)('retains the %s lock and unpublished snapshot after transcript fsync but failed rename', provider => {
    const { store, directory, runId, root } = runningFixture();
    if (provider === 'ordinary') store.updateRun(runId, { harnessExecution: undefined });
    const original = readFileSync(join(directory, 'run.json'));
    rename.mockImplementationOnce(() => { throw Object.assign(new Error('fixture rename denied'), { code: 'EPERM' }); });
    expect(() => store.withRunTransaction(runId, state => ({ patch: { toolCalls: state.toolCalls + 1 },
      events: [{ timestamp: new Date().toISOString(), type: 'progress', data: { partial: true } }] }))).toThrow('publication is unconfirmed');
    expect(readFileSync(join(directory, 'run.json'))).toEqual(original);
    expect(() => readRunStateSnapshot(runId, root)).toThrow('changed during read');
    const temporary = readdirSync(directory).find(name => name.startsWith('run.json.') && name.endsWith('.tmp'))!;
    utimesSync(join(directory, temporary), new Date(0), new Date(0));
    createRunStore(root);
    expect(existsSync(join(directory, temporary))).toBe(true);
    expect(existsSync(join(directory, 'run.transaction.lock'))).toBe(true);
  });

  it('checkpoints an explicitly mutated legacy row without rewriting it on mere observation', () => {
    const { store, directory, runId, root } = runningFixture();
    const state = store.getRun(runId)!;
    delete state.persistence;
    writeFileSync(join(directory, 'run.json'), JSON.stringify(state));
    const before = readFileSync(join(directory, 'run.json'));
    expect(readRunStateSnapshot(runId, root)?.persistence).toBeUndefined();
    expect(readFileSync(join(directory, 'run.json'))).toEqual(before);
    const updated = store.withRunTransaction(runId, current => ({ patch: { toolCalls: current.toolCalls + 1 },
      events: [{ timestamp: new Date().toISOString(), type: 'progress', data: { checkpoint: true } }] }));
    expect(updated.persistence).toEqual({ revision: 1, transcriptBytes: statSync(join(directory, 'transcript.jsonl')).size });
  });

  it('retains partial evidence instead of renaming a success snapshot when eligibility expires during publication I/O', () => {
    const { store, directory, runId, root } = runningFixture();
    const before = readFileSync(join(directory, 'run.json'));
    const expiresAt = Date.now() + 100;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiresAt - 1);
    let checks = 0;
    expect(() => store.withRunTransaction(runId, () => ({ patch: { status: 'completed' }, events: [
      { timestamp: new Date().toISOString(), type: 'complete', data: { result: { ok: true } } },
    ], beforePublish: () => {
      if (Date.now() >= expiresAt) throw new Error('Fixture known lease expiry reached');
      if (++checks === 1) clock.mockReturnValue(expiresAt + 1);
    } }))).toThrow('publication is unconfirmed');
    expect(readFileSync(join(directory, 'run.json')).equals(before)).toBe(true);
    expect(readFileSync(join(directory, 'transcript.jsonl'), 'utf8')).toContain('"type":"complete"');
    expect(existsSync(join(directory, 'run.transaction.lock'))).toBe(true);
    expect(readdirSync(directory).some(path => path.startsWith('run.json.') && path.endsWith('.tmp'))).toBe(true);
    expect(() => readRunStateSnapshot(runId, root)).toThrow('changed during read');
  });

  it('rejects nested and async transactions before changing state', () => {
    const { store, runId } = runningFixture();
    const before = store.getRun(runId);
    expect(() => store.withRunTransaction(runId, () => { store.updateRun(runId, { status: 'failed' }); return {}; })).toThrow('reentry');
    expect(() => store.withRunTransaction(runId, (async () => ({})) as never)).toThrow('synchronous');
    expect(store.getRun(runId)).toEqual(before);
  });

  it('yields for a healthy cross-process transaction rather than failing three immediate reads', async () => {
    const { root, runId } = runningFixture();
    const module = new URL('../../dist/run-store.js', import.meta.url).href;
    const source = `import {createRunStore} from ${JSON.stringify(module)};import {writeSync} from 'node:fs';
      const store=createRunStore(process.argv[1],{sweepOrphans:false});
      store.withRunTransaction(process.argv[2],s=>{writeSync(1,'locked\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);return{patch:{toolCalls:s.toolCalls+1}};});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, runId], { stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`Transaction writer exit ${code}`))); });
    await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); });
    expect(() => readRunStateSnapshot(runId, root)).toThrow('changed during read');
    expect((await readRunStateSnapshotWhenAvailable(runId, root))?.toolCalls).toBe(1);
    await closed;
  });

  it('cannot mix metadata and state winners when independent processes create the same run', async () => {
    const { root } = fixture();
    const module = new URL('../../dist/run-store.js', import.meta.url).href;
    const runId = 'RUN-EXCLUSIVE-CREATE';
    const source = `import {createRunStore} from ${JSON.stringify(module)};
      const store=createRunStore(process.argv[1],{sweepOrphans:false}),role=process.argv[3];
      try{store.createRun({runId:process.argv[2],agentId:role,resolvedConfig:{agentId:role,source:role,model:role},permissionProfile:{allowedTools:[],deniedTools:[],permissionMode:'default'}});process.stdout.write('created');}catch{process.stdout.write('exists');}`;
    const create = (role: string) => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, runId, role], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', bytes => { output += bytes; });
      child.once('error', reject); child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`Create writer exit ${code}`)));
    });
    expect((await Promise.all([create('owner-a'), create('owner-b')])).sort()).toEqual(['created', 'exists']);
    const directory = join(root, '.openslack.local/agents/runs', runId);
    const state = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8'));
    const metadata = JSON.parse(readFileSync(join(directory, 'metadata.json'), 'utf8'));
    expect(metadata.agentId).toBe(state.agentId);
    expect(metadata.resolvedConfig.model).toBe(state.model);
  });

  it('persists full call/result once and rejects reauthorization of a settled public call ID', () => {
    const { recorder, store, runId, reserve } = runningFixture();
    const reservation = { callId: 'call-1', toolName: 'Read', input: { file_path: 'fixture.txt' }, targetPath: '/fixture/fixture.txt', generation: 'fixture-owner', maxResultBytes: 2048 };
    const receipt = reserve(reservation);
    reserve(reservation);
    recorder.markToolEvidenceAuthorizationAttempt!(receipt);
    recorder.recordToolEvidenceCall!(runId, reservation.callId);
    const result = { message: 'full public output', meta: { path: 'fixture.txt' }, value: { text: 'fixture' } };
    recorder.recordToolEvidenceResult!(runId, reservation.callId, result);
    recorder.recordToolEvidenceResult!(runId, reservation.callId, result);
    expect(() => reserve(reservation)).toThrow('settled tool call ID');
    const events: unknown[] = [];
    visitStrictTranscript(store.getRun(runId)!.transcriptPath, value => events.push(value));
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: 'tool_result', data: { callId: reservation.callId, output: result } });
    expect(store.getRun(runId)!.harnessExecution!.evidence!.reservedBytes).toBe(0);
  });

  it('releases only a newly committed reservation when eligibility expires before any allowed response can be attempted', () => {
    const { recorder, store, runId, task } = runningFixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const eligibility = bindHarnessToolEligibility(createHarnessTaskEligibility({ taskId: task.taskId,
      taskHash: 'c'.repeat(64), principalId: 'quota-unit-fixture-only', principalHash: task.principalHash, phase: 'execute' },
    { mode: 'required', expiresAt: now + 1000 }), { runId, generation: 'fixture-owner', toolName: 'Read', targetPath: '/fixture' });
    const transact = store.withRunTransaction.bind(store);
    let first = true;
    vi.spyOn(store, 'withRunTransaction').mockImplementation((id, update) => {
      const result = transact(id, update);
      if (first) { first = false; clock.mockReturnValue(now + 1000); }
      return result;
    });
    expect(() => recorder.reserveToolEvidence!(runId, { callId: 'expiry-after-commit', toolName: 'Read', input: {},
      targetPath: '/fixture', generation: 'fixture-owner', maxResultBytes: 2048 }, eligibility)).toThrow(/eligibility|lease/);
    expect(store.readRun(runId)?.harnessExecution?.evidence?.reservedBytes).toBe(0);
    expect(store.readRun(runId)?.harnessExecution?.evidence?.calls['expiry-after-commit']).toMatchObject({ phase: 'not_dispatched' });
    const events: Array<{ type: string }> = [];
    visitStrictTranscript(store.readRun(runId)!.transcriptPath, value => events.push(value));
    expect(events.map(value => value.type)).toEqual(['tool_call', 'progress']);
  });

  it('revalidates only this recorder\'s exact already-attempted call and never releases duplicate, foreign or attempted receipts', () => {
    const { recorder, store, runId, reserve } = runningFixture();
    const value = { callId: 'pre-effect-checks', toolName: 'Read', input: {}, targetPath: '/fixture', generation: 'fixture-owner', maxResultBytes: 2048 };
    const first = reserve(value), prematureDuplicate = reserve(value);
    expect(() => recorder.markToolEvidenceAuthorizationAttempt!(prematureDuplicate)).toThrow('first-dispatch');
    expect(() => recorder.releaseUndispatchedToolEvidence!(prematureDuplicate)).toThrow('original new');
    recorder.markToolEvidenceAuthorizationAttempt!(first);
    const before = store.readRun(runId);
    for (let index = 0; index < 2; index++) recorder.markToolEvidenceAuthorizationAttempt!(reserve(value));
    expect(store.readRun(runId)).toEqual(before); // No extra allocation, event or checkpoint on a pure recheck.
    expect(() => recorder.releaseUndispatchedToolEvidence!(first)).toThrow('attempted');
    expect(() => recorder.releaseUndispatchedToolEvidence!({} as never)).toThrow('original new');
    recorder.recordToolEvidenceResult!(runId, value.callId, { fixture: 'settled' });
    expect(() => reserve(value)).toThrow('settled tool call ID');
  });

  it('cannot use another recorder or a legacy unknown call to acquire or release first-dispatch authority', () => {
    const { recorder, store, root, runId, reserve, task } = runningFixture();
    const value = { callId: 'foreign-owner', toolName: 'Read', input: {}, targetPath: '/fixture', generation: 'fixture-owner', maxResultBytes: 2048 };
    const first = reserve(value); recorder.markToolEvidenceAuthorizationAttempt!(first);
    const other = createRunRecorder(store, root);
    const eligibility = bindHarnessToolEligibility(createHarnessTaskEligibility({ taskId: task.taskId, taskHash: 'c'.repeat(64),
      principalId: 'quota-unit-fixture-only', principalHash: task.principalHash, phase: 'execute' }, { mode: 'not_applicable' }),
    { runId, generation: value.generation, toolName: value.toolName, targetPath: value.targetPath });
    const reused = other.reserveToolEvidence!(runId, value, eligibility);
    expect(() => other.markToolEvidenceAuthorizationAttempt!(reused)).toThrow('original new');
    expect(() => other.releaseUndispatchedToolEvidence!(reused)).toThrow('original new');
    const state = store.readRun(runId)!;
    const calls = state.harnessExecution!.evidence!.calls;
    store.updateRun(runId, { harnessExecution: { ...state.harnessExecution!, evidence: { ...state.harnessExecution!.evidence!,
      calls: { ...calls, [value.callId]: { ...calls[value.callId]!, reservationId: undefined, phase: undefined } } } } });
    const legacy = reserve(value);
    expect(() => recorder.markToolEvidenceAuthorizationAttempt!(legacy)).toThrow('original new');
    expect(store.readRun(runId)?.harnessExecution?.evidence?.reservedBytes).toBe(2048);
  });

  it('rejects missing, forged and callback-domain observations instead of treating them as unlimited eligibility', () => {
    const { recorder, store, runId, task } = runningFixture();
    const reservation = { callId: 'no-eligibility', toolName: 'Read', input: {}, targetPath: '/fixture', generation: 'fixture-owner', maxResultBytes: 2048 };
    const before = store.getRun(runId);
    expect(() => recorder.reserveToolEvidence!(runId, reservation)).toThrow('eligibility');
    expect(() => recorder.reserveToolEvidence!(runId, reservation, {} as never)).toThrow('eligibility');
    const report = createHarnessTaskEligibility({ taskId: task.taskId, taskHash: 'c'.repeat(64), principalId: 'quota-unit-fixture-only', principalHash: task.principalHash, phase: 'report' }, { mode: 'not_applicable' });
    const callback = bindHarnessToolEligibility(report, { runId, generation: 'fixture-owner', toolName: 'mcp.openslack.openslack_get_activity', targetPath: 'mcp:mcp.openslack.openslack_get_activity' });
    expect(() => recorder.reserveToolEvidence!(runId, reservation, callback)).toThrow('eligibility');
    expect(store.getRun(runId)).toEqual(before);
  });

  it('protects reserved tool capacity against progress writers before any effect', () => {
    const { recorder, store, runId, reserve } = runningFixture();
    for (let i = 0; i < 3; i++) reserve({ callId: `call-${i}`, toolName: 'Read', input: {}, targetPath: '/fixture', generation: 'fixture-owner', maxResultBytes: 16 * 1024 * 1024 });
    reserve({ callId: 'call-last', toolName: 'Read', input: {}, targetPath: '/fixture', generation: 'fixture-owner', maxResultBytes: 14 * 1024 * 1024 });
    const before = store.getRun(runId)!;
    expect(before.harnessExecution!.evidence!.reservedBytes).toBeLessThan(HARNESS_TRANSCRIPT_MAX_BYTES - HARNESS_TERMINAL_RESERVE_BYTES);
    expect(() => recorder.progress(runId, { text: 'x'.repeat(3 * 1024 * 1024) })).toThrow('capacity must be reserved');
    expect(store.getRun(runId)).toEqual(before);
  });

  it('refuses an oversized terminal event before appending or changing the protected checkpoint', () => {
    const { store, runId } = runningFixture();
    const before = store.getRun(runId)!;
    expect(() => store.withRunTransaction(runId, () => ({ patch: { status: 'failed' }, events: [
      { timestamp: new Date().toISOString(), type: 'fail', data: { full: 'x'.repeat(HARNESS_TERMINAL_RESERVE_BYTES) } },
    ] }))).toThrow('capacity must be reserved');
    expect(store.getRun(runId)).toEqual(before);
    expect(existsSync(before.transcriptPath)).toBe(false);
  });

  it('strictly streams complete evidence beyond the old 8 MiB reader limit', () => {
    const { recorder, store, runId, reserve } = runningFixture();
    const receipt = reserve({ callId: 'large', toolName: 'Read', input: {}, targetPath: '/fixture', generation: 'fixture-owner', maxResultBytes: 16 * 1024 * 1024 });
    recorder.markToolEvidenceAuthorizationAttempt!(receipt);
    recorder.recordToolEvidenceResult!(runId, 'large', { message: 'x'.repeat(9 * 1024 * 1024), meta: { complete: true } });
    let count = 0;
    visitStrictTranscript(store.getRun(runId)!.transcriptPath, () => count++);
    expect(count).toBe(2);
  });

  it.each(['bad-json', 'missing-final-lf', 'invalid-utf8', 'oversized-event', 'oversized-transcript'] as const)('rejects persisted %s evidence without rewriting its original bytes', kind => {
    const { root } = fixture();
    const path = join(root, 'strict-evidence.jsonl');
    if (kind === 'bad-json') writeFileSync(path, '{not JSON}\n');
    if (kind === 'missing-final-lf') writeFileSync(path, JSON.stringify({ type: 'progress', data: {} }));
    if (kind === 'invalid-utf8') writeFileSync(path, Buffer.from([0xc3, 0x28, 0x0a]));
    if (kind === 'oversized-event') writeFileSync(path, JSON.stringify({ type: 'progress', data: { text: 'x'.repeat(16 * 1024 * 1024) } }) + '\n');
    if (kind === 'oversized-transcript') { const fd = openSync(path, 'wx'); try { ftruncateSync(fd, 64 * 1024 * 1024 + 1); } finally { closeSync(fd); } }
    const before = statSync(path), bytes = kind === 'oversized-transcript' ? undefined : readFileSync(path);
    expect(() => visitStrictTranscript(path, () => {})).toThrow();
    const after = statSync(path);
    expect([after.size, after.mtimeMs, after.ctimeMs]).toEqual([before.size, before.mtimeMs, before.ctimeMs]);
    if (bytes) expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it('never loses acknowledged report fields to an independent recorder process', async () => {
    const { store, root, runId } = runningFixture();
    const module = new URL('../../dist/run-store.js', import.meta.url).href;
    const source = `import { createRunStore } from ${JSON.stringify(module)};
      const store=createRunStore(process.argv[1],{sweepOrphans:false}), id=process.argv[2], role=process.argv[3];
      for(let i=0;i<20;i++) store.withRunTransaction(id,s=>({patch:role==='host'?{toolCalls:s.toolCalls+1}:{harnessExecution:{...s.harnessExecution,reports:{...s.harnessExecution.reports,['report-'+i]:'ack'}}},events:[{timestamp:new Date().toISOString(),type:'progress',data:{role,i}}]}));`;
    const child = (role: string) => new Promise<void>((resolve, reject) => {
      const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', source, root, runId, role], { stdio: ['ignore', 'ignore', 'pipe'] });
      let error = ''; process.stderr.on('data', bytes => { error += bytes; });
      process.once('error', reject); process.once('close', code => code === 0 ? resolve() : reject(new Error(error)));
    });
    await Promise.all([child('host'), child('worker')]);
    expect(store.getRun(runId)?.toolCalls).toBe(20);
    expect(Object.keys(store.getRun(runId)!.harnessExecution!.reports)).toHaveLength(20);
    let count = 0; visitStrictTranscript(store.getRun(runId)!.transcriptPath, () => count++);
    expect(count).toBe(40);
  });
});
