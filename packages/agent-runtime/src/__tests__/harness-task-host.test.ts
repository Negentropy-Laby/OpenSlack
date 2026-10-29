import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { HarnessTaskHost, type ApprovedHarnessTask, type HarnessTaskHostOptions } from '../harness-task-host.js';
import { createRunStore, readRunStateSnapshot, RunStateSnapshotChangedError } from '../run-store.js';
import type * as RunStoreModule from '../run-store.js';
import { buildPermissionProfile } from '../permissions.js';
import { HarnessAdmissionStore, hashHarnessInput } from '../harness-admission.js';
import { reconcileHarnessTask, type HarnessRecoveryObservation } from '../harness-reconciliation.js';
import { buildHarnessTaskPermissionProfile } from '../harness-permissions.js';
import { ownRunWriterWitness } from '../run-process-witness.js';

vi.mock('../run-store.js', async importOriginal => {
  const actual = await importOriginal<typeof RunStoreModule>();
  return { ...actual, readRunStateSnapshot: vi.fn(actual.readRunStateSnapshot) };
});
const snapshotReader = vi.mocked(readRunStateSnapshot);
const originalSnapshotReader = snapshotReader.getMockImplementation()!;

const roots: string[] = [];
const hosts: HarnessTaskHost[] = [];
afterEach(async () => {
  snapshotReader.mockReset().mockImplementation(originalSnapshotReader);
  for (const host of hosts.splice(0)) await host.close(100);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'harness-task-host-'));
  roots.push(root);
  const resolvedConfig = { agentId: 'fixture', source: 'test', tools: ['Read'] };
  const task: ApprovedHarnessTask = {
    taskId: 'TASK-1', principalHash: 'a'.repeat(64), baseline: 'b'.repeat(40), timeoutMs: 5_000,
    request: { agentId: 'fixture', prompt: 'fixture task', resolvedConfig, permissionProfile: buildPermissionProfile(resolvedConfig) },
    scope: { readPaths: ['fixture.txt'], writePaths: [], forbiddenPaths: ['.git/**'] },
    outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
  };
  const execute = vi.fn(async () => ({ data: { answer: 'fixture' }, exitConfirmed: true as const }));
  const accept = vi.fn(async () => ({ outcome: 'verified' as const, summary: 'Verified by host fixture.', evidenceRefs: ['artifact:fixture'] }));
  const options: HarnessTaskHostOptions = {
    identityRoot: root, workspaceId: 'fixture-workspace', store: createRunStore(root),
    readTask: vi.fn(async () => task), authorize: vi.fn(async () => {}),
    prepare: vi.fn(async () => ({ execute, accept })), publish: vi.fn(async () => {}),
  };
  const host = new HarnessTaskHost(options);
  hosts.push(host);
  return { root, task, host, execute, accept, options };
}

describe('canonical Harness task lifecycle (keyless host fixtures)', () => {
  beforeAll(() => {
    // Prepare the real, bounded OS port before these fixtures' 5 s task budget.
    // A cold Windows CIM timeout is not part of snapshot-observation behavior.
    // Missing witness still grants no maintenance authority; its OS semantics
    // are exercised separately in run-process-witness.test.ts.
    ownRunWriterWitness();
  });
  it.each(['transient', 'exhausted', 'corrupt', 'foreign-conflict'] as const)('only re-observes rejected %s snapshots without another effect', async kind => {
    const { host, root, execute, options } = setup();
    const receipt = await host.dispatch('TASK-1', 'read-only-conflict');
    await vi.waitFor(() => expect(host.read(receipt.runId)?.status).toBe('completed'));
    const path = join(root, '.openslack.local/agents/runs', receipt.runId, 'run.json');
    const before = readFileSync(path);
    const publications = vi.mocked(options.publish).mock.calls.length;
    snapshotReader.mockClear();
    if (kind === 'transient') {
      for (let i = 0; i < 2; i++) snapshotReader.mockImplementationOnce(() => { throw new RunStateSnapshotChangedError(receipt.runId); });
      expect(host.read(receipt.runId)?.status).toBe('completed');
      expect(snapshotReader).toHaveBeenCalledTimes(3);
    } else {
      const error = kind === 'corrupt' ? new Error('Corrupted run metadata')
        : new RunStateSnapshotChangedError(kind === 'foreign-conflict' ? 'RUN-OTHER' : receipt.runId);
      snapshotReader.mockImplementation(() => { throw error; });
      expect(() => host.read(receipt.runId)).toThrow(error);
      expect(snapshotReader).toHaveBeenCalledTimes(kind === 'exhausted' ? 3 : 1);
    }
    expect(readFileSync(path)).toEqual(before);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(options.prepare).toHaveBeenCalledTimes(1);
    expect(options.publish).toHaveBeenCalledTimes(publications);
  });
  it('persists pending before returning admission and completes only after host acceptance', async () => {
    const { host, options, execute, accept } = setup();
    const gate = deferred();
    vi.mocked(options.prepare).mockImplementation(async () => { await gate.promise; return { execute, accept }; });
    const receipt = await host.dispatch('TASK-1', 'request-a');
    expect(receipt.status).toBe('pending');
    expect(host.read(receipt.runId)?.status).toBe('pending');
    expect(options.prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    gate.release();
    await vi.waitFor(() => expect(host.read(receipt.runId)?.status).toBe('completed'));
    expect(accept).toHaveBeenCalledTimes(1);
    expect(host.read(receipt.runId)?.harnessExecution?.acceptance).toBe('verified');
  });

  it('deduplicates logical tasks despite 100 different request IDs and independent host instances', async () => {
    const { host, options, execute } = setup();
    const other = new HarnessTaskHost(options);
    hosts.push(other);
    const receipts = await Promise.all(Array.from({ length: 100 }, (_, index) =>
      (index % 2 ? host : other).dispatch('TASK-1', `request-${index}`)));
    expect(new Set(receipts.map(receipt => receipt.runId)).size).toBe(1);
    await vi.waitFor(() => expect(host.read(receipts[0]!.runId)?.status).toBe('completed'));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('publishes only one admission across two independent OS processes', async () => {
    const { root } = setup();
    const module = new URL('../../dist/harness-admission.js', import.meta.url).href;
    const source = `import { HarnessAdmissionStore } from ${JSON.stringify(module)};
      const result = new HarnessAdmissionStore(process.argv[1]).admit('a'.repeat(64), 'b'.repeat(64));
      process.stdout.write(JSON.stringify(result));`;
    const invoke = () => new Promise<{ created: boolean; record: { runId: string } }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let error = '';
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
      child.once('error', reject);
      child.once('close', code => {
        if (code !== 0) reject(new Error(`Admission child failed: ${error}`));
        else resolve(JSON.parse(output));
      });
    });
    const results = await Promise.all([invoke(), invoke()]);
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(new Set(results.map(result => result.record.runId)).size).toBe(1);
  });

  it.each(['concurrent', 'publication-held'] as const)('dispatches exactly once across two host processes with %s publication', async mode => {
    const { root, task } = setup();
    const hostModule = new URL('../../dist/harness-task-host.js', import.meta.url).href;
    const storeModule = new URL('../../dist/run-store.js', import.meta.url).href;
    const admissionModule = new URL('../../dist/harness-admission.js', import.meta.url).href;
    const witnessModule = new URL('../../dist/run-process-witness.js', import.meta.url).href;
    const source = `import { HarnessTaskHost, hashHarnessTask } from ${JSON.stringify(hostModule)};
      import { createRunStore, RunStateSnapshotChangedError } from ${JSON.stringify(storeModule)};
      import { HarnessAdmissionError } from ${JSON.stringify(admissionModule)};
      import { ownRunWriterWitness } from ${JSON.stringify(witnessModule)};
      import { appendFileSync } from 'node:fs';
      import { join } from 'node:path';
      const root = process.argv[1], task = JSON.parse(process.argv[2]), role = process.argv[3], held = process.argv[4] === 'publication-held';
      const received = new Set(), waiters = new Map();
      process.on('message', message => { received.add(message); waiters.get(message)?.(); });
      const wait = message => received.has(message) ? Promise.resolve() : new Promise(resolve => waiters.set(message, resolve));
      // Each real child prepares its own bounded OS port before admission's
      // unchanged 5 s task budget, not just the Vitest parent's cached witness.
      ownRunWriterWitness(); process.send({ phase: 'ready' }); await wait('go');
      const host = new HarnessTaskHost({ identityRoot: root, workspaceId: 'independent-hosts', store: createRunStore(root),
        readTask: async () => task, authorize: async () => {}, publish: async () => {
          if (held && role === 'owner') { process.send({ phase: 'publishing' }); await wait('release'); }
        },
        prepare: async () => ({ execute: async () => {
          appendFileSync(join(root, 'effects.log'), 'executed\\n');
          return { data: { answer: 'fixture' }, exitConfirmed: true };
        }, accept: async () => ({ outcome: 'verified', summary: 'fixture', evidenceRefs: [] }) }) });
      let result, dispatchCalls = 0;
      try {
        dispatchCalls++; const receipt = await host.dispatch(task.taskId, 'request-' + process.pid);
        if (receipt.taskId !== task.taskId) throw new Error('Foreign task receipt');
        result = { kind: 'receipt', runId: receipt.runId, requestHash: hashHarnessTask(task) };
      } catch (error) {
        const observation = error instanceof HarnessAdmissionError && error.code === 'IN_PROGRESS' ? error.observation : undefined;
        if (!observation || observation.kind !== 'admission' || observation.disposition !== 'in_progress' ||
          !/^RUN-[A-Z0-9-]+$/.test(observation.runId) || typeof observation.canonicalRunPresent !== 'boolean' ||
          observation.requestHash !== hashHarnessTask(task)) throw error;
        result = observation; process.send({ phase: 'observed-admission' });
      }
      // Never dispatch again: only query the same durable route, including
      // after a legitimate IN_PROGRESS observation rather than a receipt.
      const deadline = performance.now() + 5000;
      for (;;) {
        if (performance.now() >= deadline) throw new Error('No completed canonical fixture');
        try {
          const state = host.read(result.runId);
          if (state?.status === 'completed') {
            if (state.harnessExecution?.taskId !== task.taskId || state.harnessExecution.requestHash !== result.requestHash ||
              state.harnessExecution.acceptance !== 'verified') throw new Error('Canonical result binding differs');
            break;
          }
          if (state?.status === 'failed') throw new Error('Canonical task failed');
        } catch (error) {
          if (!(error instanceof RunStateSnapshotChangedError) || error.runId !== result.runId) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!(await host.close(1000)).stopped) throw new Error('Fixture host did not stop');
      process.stdout.write(JSON.stringify({ ...result, dispatchCalls })); process.disconnect();`;
    const children: Array<ReturnType<typeof spawn>> = [];
    const closed = new Set<ReturnType<typeof spawn>>();
    const actualCloses: Array<Promise<void>> = [];
    const invoke = (role: string) => {
      const ready = Promise.withResolvers<void>();
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, JSON.stringify(task), role, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      if (roots.includes(root)) roots.splice(roots.indexOf(root), 1);
      children.push(child);
      actualCloses.push(new Promise(resolve => child.once('close', () => resolve())));
      let output = ''; let error = '';
      child.stdout!.on('data', (bytes: Buffer) => { output += bytes.toString(); });
      child.stderr!.on('data', (bytes: Buffer) => { error += bytes.toString(); });
      const done = new Promise<{ kind: string; runId: string; requestHash: string; dispatchCalls: number }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Fixture host ${role} exceeded its bounded startup/observation window`)), 20_000);
        child.once('error', cause => { ready.reject(cause); reject(cause); });
        child.once('close', code => {
          clearTimeout(timer); closed.add(child);
          if (code !== 0) { const cause = new Error(`Fixture host failed: ${error}`); ready.reject(cause); reject(cause); }
          else { try { resolve(JSON.parse(output)); } catch (cause) { reject(cause); } }
        });
      });
      // Attach immediately so an early child failure is not an unhandled rejection.
      void done.catch(() => {});
      child.on('message', message => {
        const phase = (message as { phase?: string }).phase;
        if (phase === 'ready') ready.resolve();
        if (phase === 'publishing' && role === 'owner') children[1]!.send('go');
        if (phase === 'observed-admission' && role === 'observer' && mode === 'publication-held') children[0]!.send('release');
      });
      return { ready: Promise.race([ready.promise, done.then(() => { throw new Error('Child closed before ready'); })]), done, child };
    };
    const owner = invoke('owner'), observer = invoke('observer');
    try {
      await Promise.all([owner.ready, observer.ready]);
      owner.child.send('go');
      if (mode === 'concurrent') observer.child.send('go');
      const results = await Promise.all([owner.done, observer.done]);
      expect(results[0]!.runId).toBe(results[1]!.runId);
      expect(results[0]!.requestHash).toBe(results[1]!.requestHash);
      expect(results.map(result => result.dispatchCalls)).toEqual([1, 1]);
      if (mode === 'publication-held') expect(results[1]!.kind).toBe('admission');
      expect(readFileSync(join(root, 'effects.log'), 'utf8')).toBe('executed\n');
    } finally {
      for (const child of children) if (!closed.has(child)) child.kill('SIGKILL');
      // Preserve the fixture if a failed child cannot produce an actual close.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.all(actualCloses), new Promise(resolve => { timer = setTimeout(resolve, 5_000); })]); }
      finally { clearTimeout(timer); }
      if (closed.size === children.length && !roots.includes(root)) roots.push(root);
    }
  }, 30_000);

  it('refuses same-key changed input and does not replay a prior run after restart', async () => {
    const { host, options, task, execute } = setup();
    const receipt = await host.dispatch('TASK-1', 'first');
    await vi.waitFor(() => expect(host.read(receipt.runId)?.status).toBe('completed'));
    const restarted = new HarnessTaskHost(options);
    hosts.push(restarted);
    expect((await restarted.dispatch('TASK-1', 'reconnect')).runId).toBe(receipt.runId);
    expect(execute).toHaveBeenCalledTimes(1);
    task.request.prompt = 'changed task';
    await expect(restarted.dispatch('TASK-1', 'changed')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('records only current-task reports, deduplicates them, and never lets reports accept the task', async () => {
    const { host, options, execute } = setup();
    const gate = deferred();
    execute.mockImplementation(async () => { await gate.promise; return { data: { answer: 'fixture' }, exitConfirmed: true }; });
    const { runId } = await host.dispatch('TASK-1', 'admit');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const worker = new HarnessTaskHost({ ...options, callbackRunId: runId });
    hosts.push(worker);
    const report = { runId, reportId: 'report-1', summary: 'progress', evidenceRefs: ['artifact:fixture'] };
    await worker.report(report);
    await worker.report(report);
    expect(host.read(runId)?.harnessExecution?.acceptance).toBe('pending');
    expect(Object.keys(host.read(runId)!.harnessExecution!.reports)).toEqual(['report-1']);
    await expect(worker.report({ ...report, summary: 'changed' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(worker.report({ ...report, completed: true } as typeof report)).rejects.toThrow('Invalid');
    await expect(worker.report({ ...report, runId: 'RUN-OTHER' })).rejects.toThrow('not bound');
    await expect(worker.dispatch('TASK-1', 'recursive')).rejects.toThrow('cannot dispatch');
    gate.release();
    await vi.waitFor(() => expect(host.read(runId)?.status).toBe('completed'));
  });

  it('rejects task drift while preparing, before executor side effects', async () => {
    const { host, options, execute, accept, task } = setup();
    const gate = deferred();
    vi.mocked(options.prepare).mockImplementation(async () => { await gate.promise; return { execute, accept }; });
    const { runId } = await host.dispatch('TASK-1', 'admit');
    task.scope.writePaths.push('unapproved.txt');
    gate.release();
    await vi.waitFor(() => expect(host.read(runId)?.status).toBe('failed'));
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not complete on rejected acceptance, malformed output, or acceptance-time permission revocation', async () => {
    for (const failure of ['acceptance', 'schema', 'permission']) {
      const { host, execute, accept, options } = setup();
      if (failure === 'acceptance') vi.mocked(options.prepare).mockResolvedValue({ execute, accept: async () => ({ outcome: 'rejected', summary: 'Rejected fixture', evidenceRefs: [] }) });
      if (failure === 'schema') execute.mockResolvedValue({ data: { wrong: true } as never, exitConfirmed: true });
      if (failure === 'permission') vi.mocked(options.authorize).mockImplementation(async (_task, phase) => { if (phase === 'accept') throw new Error('revoked'); });
      const { runId } = await host.dispatch('TASK-1', `admit-${failure}`);
      await vi.waitFor(() => expect(host.read(runId)?.status).toBe('failed'));
      expect(host.read(runId)?.harnessExecution?.acceptance).not.toBe('verified');
      if (failure !== 'acceptance') expect(accept).not.toHaveBeenCalled();
    }
  });

  it('preserves admission after the crash window before canonical pending and refuses automatic replay', async () => {
    const { host, root, task, execute } = setup();
    const store = new HarnessAdmissionStore(root);
    const key = hashHarnessInput(['fixture-workspace', 'TASK-1', 'TASK-1']);
    const hash = hashHarnessInput({ ...task, idempotencyKey: 'TASK-1', request: { ...task.request, correlationId: undefined, worktreePath: undefined } });
    store.admit(key, hash);
    const directory = join(root, '.openslack.local/agents/harness-admissions');
    const path = join(directory, readdirSync(directory).find(path => path.endsWith('.json'))!);
    const before = readFileSync(path);
    await expect(host.dispatch('TASK-1', 'reconnect')).rejects.toMatchObject({ code: 'INDETERMINATE' });
    expect(readFileSync(path)).toEqual(before);
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports unknown exit separately from settled host promises', async () => {
    const { host, execute } = setup();
    execute.mockRejectedValue(new Error('unknown exit'));
    const { runId } = await host.dispatch('TASK-1', 'admit');
    await vi.waitFor(() => expect(host.read(runId)?.status).toBe('failed'));
    expect(await host.close(100)).toEqual({ stopped: false, unknownRunIds: [runId] });
    expect(host.read(runId)?.harnessExecution?.acceptance).toBe('indeterminate');
  });

  it('refuses an ordinary duplicate receipt after uncertain visible-anchor publication, without replay', async () => {
    const { host, options, execute } = setup();
    vi.mocked(options.publish).mockRejectedValue(new Error('visible anchor unavailable'));
    await expect(host.dispatch('TASK-1', 'first')).rejects.toThrow('visible anchor unavailable');
    const restarted = new HarnessTaskHost(options);
    hosts.push(restarted);
    await expect(restarted.dispatch('TASK-1', 'reconnect')).rejects.toMatchObject({ code: 'INDETERMINATE' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('starts a governed admission only after its durable confirmation and never activates a historical route', async () => {
    const { host, execute } = setup();
    const binding = { planId: 'GPLAN-FIXTURE', executionId: 'GEXEC-FIXTURE', confirmationAttemptId: 'fixture-owner' };
    const receipt = await host.dispatch('TASK-1', 'governed', true, binding);
    await new Promise(resolve => setImmediate(resolve));
    expect(execute).not.toHaveBeenCalled();
    expect(host.read(receipt.runId)?.status).toBe('pending');
    host.settleConfirmedAdmissions(binding.planId, { state: 'succeeded', ...binding });
    await vi.waitFor(() => expect(host.read(receipt.runId)?.status).toBe('completed'));
    host.settleConfirmedAdmissions(binding.planId, { state: 'succeeded', ...binding });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('makes read-only reconciliation unavailable instead of turning a busy snapshot into execution or an empty result', async () => {
    const { host, options } = setup(); const receipt = await host.dispatch('TASK-1', 'held-confirmation', true);
    const path = join(options.identityRoot, '.openslack.local/agents/runs', receipt.runId, 'run.transaction.lock');
    writeFileSync(path, 'preserved historical writer');
    const inspect = vi.fn();
    const result = await reconcileHarnessTask({ ...options, inspect }, receipt.runId);
    expect(result).toEqual({ runId: receipt.runId, readStatus: 'unavailable', reason: 'locked', disposition: 'preserve_and_reconcile' });
    expect(result).not.toHaveProperty('status'); expect(inspect).not.toHaveBeenCalled();
    expect(readFileSync(path, 'utf8')).toBe('preserved historical writer');
  });

  it('stops a scheduled-but-not-confirmed admission without starting its executor', async () => {
    const { host, execute } = setup();
    const { runId } = await host.dispatch('TASK-1', 'governed', true);
    expect(await host.close(100)).toEqual({ stopped: true, unknownRunIds: [] });
    expect(execute).not.toHaveBeenCalled();
    expect(host.read(runId)?.status).toBe('failed');
    expect(host.read(runId)?.harnessExecution?.stopRequestedAt).toEqual(expect.any(String));
  });

  it('does not restart the total deadline after synchronous preparation', async () => {
    const { host, task, options, execute, accept } = setup();
    const before = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(before);
    vi.mocked(options.prepare).mockImplementation(async () => {
      clock.mockReturnValue(Date.parse(options.store.listRuns()[0]!.startedAt) + task.timeoutMs + 1);
      return { execute, accept };
    });
    try {
      const { runId } = await host.dispatch('TASK-1', 'deadline');
      await vi.waitFor(() => expect(host.read(runId)?.status).toBe('failed'));
      expect(execute).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it('reconciles existing evidence without changing bytes, prompting or claiming unknown exit', async () => {
    const { host, root, options, execute } = setup();
    const { runId } = await host.dispatch('TASK-1', 'first');
    await vi.waitFor(() => expect(host.read(runId)?.status).toBe('completed'));
    const file = join(root, '.openslack.local/agents/runs', runId, 'run.json');
    const before = readFileSync(file);
    const inspect = vi.fn(async (): Promise<HarnessRecoveryObservation> => ({ deployment: 'matched', workspace: 'matched', process: 'exited' }));
    expect(await reconcileHarnessTask({ ...options, inspect }, runId)).toMatchObject({ disposition: 'existing_verified_result' });
    inspect.mockResolvedValue({ deployment: 'matched', workspace: 'matched', process: 'unknown' });
    expect(await reconcileHarnessTask({ ...options, inspect }, runId)).toMatchObject({ disposition: 'preserve_and_reconcile' });
    expect(readFileSync(file)).toEqual(before);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('adds only explicitly requested task callbacks without widening other provider baselines', () => {
    const config = { agentId: 'fixture', source: 'test', runtimeProvider: 'deepseek-harness', permissionMode: 'acceptEdits' as const,
      tools: ['Read', 'Write', 'Edit', 'mcp.openslack.openslack_get_activity'] };
    expect(buildPermissionProfile(config).allowedTools).not.toContain('mcp.openslack.openslack_get_activity');
    expect(buildHarnessTaskPermissionProfile(config).allowedTools).toContain('mcp.openslack.openslack_get_activity');
    expect(() => buildHarnessTaskPermissionProfile({ ...config, tools: ['Bash'] })).toThrow('unsupported or denied');
    expect(() => buildHarnessTaskPermissionProfile({ ...config, disallowedTools: ['mcp.openslack.openslack_get_activity'] })).toThrow('unsupported or denied');
  });

  it('rechecks accepted artifact versions after authority awaits and before recording completion', async () => {
    const { host, options, execute, accept } = setup();
    const revalidateAccepted = vi.fn(() => { throw new Error('Artifact drift during authority await'); });
    vi.mocked(options.prepare).mockResolvedValue({ execute, accept, revalidateAccepted });
    const { runId } = await host.dispatch('TASK-1', 'artifact-drift');
    await vi.waitFor(() => expect(host.read(runId)?.status).toBe('failed'));
    expect(accept).toHaveBeenCalledTimes(1);
    expect(revalidateAccepted).toHaveBeenCalledTimes(1);
    expect(accept.mock.invocationCallOrder[0]).toBeLessThan(revalidateAccepted.mock.invocationCallOrder[0]!);
    expect(host.read(runId)?.harnessExecution?.acceptance).not.toBe('verified');
  });

  it('does not delete another owner\'s canonical lock when ownership changes', () => {
    const { root, options, task } = setup();
    const store = options.store;
    for (const write of [false, true]) {
      const runId = write ? 'RUN-LOCK-WRITE' : 'RUN-LOCK-NOOP';
      store.createRun({ ...task.request, runId });
      const directory = join(root, '.openslack.local/agents/runs', runId);
      const path = join(directory, 'run.transaction.lock');
      const original = new Map(readdirSync(directory).map(name => [name, readFileSync(join(directory, name))]));
      expect(() => store.withRunTransaction(runId, () => {
        unlinkSync(path);
        writeFileSync(path, 'replacement', { flag: 'wx' });
        return write ? { patch: { toolCalls: 1 } } : {};
      })).toThrow(expect.objectContaining({ code: 'RUN_PERSISTENCE_INDETERMINATE' }));
      expect(readFileSync(path, 'utf8')).toBe('replacement');
      // Both retirement and before-write checks preserve all original bytes;
      // a changed lock must not publish an intent, transcript or temporary file.
      expect(readdirSync(directory).sort()).toEqual([...original.keys(), 'run.transaction.lock'].sort());
      for (const [name, bytes] of original) expect(readFileSync(join(directory, name))).toEqual(bytes);
      expect(store.observeRun(runId)).toMatchObject({ kind: 'unavailable', reason: 'locked' });
    }
  });

  it('refuses expired callback preview and report after a host restart without changing historical bytes', async () => {
    const { host, options, root } = setup();
    const { runId } = await host.dispatch('TASK-1', 'not-started', true);
    const worker = new HarnessTaskHost({ ...options, callbackRunId: runId });
    hosts.push(worker);
    const report = { runId, reportId: 'expired', summary: 'must not write', evidenceRefs: [] };
    const file = join(root, '.openslack.local/agents/runs', runId, 'run.json');
    const before = readFileSync(file);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    try {
      await expect(worker.observe('harness.task.report', report)).rejects.toThrow('deadline expired');
      await expect(worker.report(report)).rejects.toThrow('deadline expired');
      expect(readFileSync(file)).toEqual(before);
    } finally { now.mockRestore(); }
  });

  it('refuses callbacks during a requested stop before process exit is known', async () => {
    const { host, options } = setup();
    const { runId } = await host.dispatch('TASK-1', 'stop-before-start', true);
    options.store.updateRun(runId, { harnessExecution: { ...host.read(runId)!.harnessExecution!, stopRequestedAt: new Date().toISOString() } });
    const worker = new HarnessTaskHost({ ...options, callbackRunId: runId });
    hosts.push(worker);
    const report = { runId, reportId: 'late', summary: 'must not write', evidenceRefs: [] };
    await expect(worker.observe('harness.task.report', report)).rejects.toThrow('preserve and reconcile');
    await expect(worker.report(report)).rejects.toThrow('preserve and reconcile');
    expect(host.read(runId)?.harnessExecution?.reports).toEqual({});
    expect(host.read(runId)?.harnessExecution?.processExit).toBeUndefined();
  });

  it('refuses linked canonical run storage without creating a run outside the owner workspace', async () => {
    const { host, root } = setup();
    const outside = mkdtempSync(join(tmpdir(), 'harness-unrelated-'));
    roots.push(outside);
    symlinkSync(outside, join(root, '.openslack.local/agents/runs'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(host.dispatch('TASK-1', 'linked-storage')).rejects.toThrow('run storage is unsafe');
    expect(readdirSync(outside)).toEqual([]);
  });
});
