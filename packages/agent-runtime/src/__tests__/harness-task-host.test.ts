import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('dispatches the executor exactly once across two independent host processes', async () => {
    const { root, task } = setup();
    const hostModule = new URL('../../dist/harness-task-host.js', import.meta.url).href;
    const storeModule = new URL('../../dist/run-store.js', import.meta.url).href;
    const source = `import { HarnessTaskHost } from ${JSON.stringify(hostModule)};
      import { createRunStore, RunStateSnapshotChangedError } from ${JSON.stringify(storeModule)};
      import { appendFileSync } from 'node:fs';
      import { join } from 'node:path';
      const root = process.argv[1], task = JSON.parse(process.argv[2]);
      const host = new HarnessTaskHost({ identityRoot: root, workspaceId: 'independent-hosts', store: createRunStore(root),
        readTask: async () => task, authorize: async () => {}, publish: async () => {},
        prepare: async () => ({ execute: async () => {
          appendFileSync(join(root, 'effects.log'), 'executed\\n');
          return { data: { answer: 'fixture' }, exitConfirmed: true };
        }, accept: async () => ({ outcome: 'verified', summary: 'fixture', evidenceRefs: [] }) }) });
      const receipt = await host.dispatch(task.taskId, 'request-' + process.pid);
      const deadline = Date.now() + 5000;
      for (;;) {
        if (Date.now() >= deadline) throw new Error('No completed canonical fixture');
        try {
          if (host.read(receipt.runId)?.status === 'completed') break;
        } catch (error) {
          if (!(error instanceof RunStateSnapshotChangedError) || error.runId !== receipt.runId) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!(await host.close(1000)).stopped) throw new Error('Fixture host did not stop');
      process.stdout.write(JSON.stringify(receipt));`;
    const invoke = () => new Promise<{ runId: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, root, JSON.stringify(task)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; let error = '';
      child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString(); });
      child.stderr.on('data', (bytes: Buffer) => { error += bytes.toString(); });
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`Fixture host failed: ${error}`)));
    });
    const receipts = await Promise.all([invoke(), invoke()]);
    expect(receipts[0]!.runId).toBe(receipts[1]!.runId);
    expect(readFileSync(join(root, 'effects.log'), 'utf8')).toBe('executed\n');
  });

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
    const receipt = await host.dispatch('TASK-1', 'governed', true);
    await new Promise(resolve => setImmediate(resolve));
    expect(execute).not.toHaveBeenCalled();
    expect(host.read(receipt.runId)?.status).toBe('pending');
    host.releaseConfirmedAdmission(receipt.runId);
    await vi.waitFor(() => expect(host.read(receipt.runId)?.status).toBe('completed'));
    host.releaseConfirmedAdmission(receipt.runId);
    expect(execute).toHaveBeenCalledTimes(1);
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
    const { root } = setup();
    const store = new HarnessAdmissionStore(root);
    const path = join(root, '.openslack.local/agents/harness-admissions/RUN-LOCK.lock');
    expect(() => store.withRunLock('RUN-LOCK', () => {
      unlinkSync(path);
      writeFileSync(path, 'replacement', { flag: 'wx' });
    })).toThrow('lock ownership changed');
    expect(readFileSync(path, 'utf8')).toBe('replacement');
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
