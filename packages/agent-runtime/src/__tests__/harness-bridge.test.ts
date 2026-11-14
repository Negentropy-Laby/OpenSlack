import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { channel } from 'node:diagnostics_channel';
import { ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { BridgeAdapterError, BridgeProcessAdapter, type BridgeProcessAdapterOptions } from '../bridge-adapter.js';
import { buildBridgeEnvelope } from '../bridge-contract.js';
import { createRunStore, generateRunId } from '../run-store.js';
import { createRunRecorder } from '../recorder.js';
import { ToolGuard } from '../adapter.js';
import { RepositoryToolExecutor } from '../tool-executor.js';
import { buildPermissionProfile } from '../permissions.js';
import { createDeepSeekHarnessProvider } from '../deepseek-harness-provider.js';
import { createConfiguredHarnessTaskHost } from '../harness-deployment.js';
import { readTranscript } from '../transcript.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function setup(source: string, timeoutMs = 2_000, extra: Partial<BridgeProcessAdapterOptions> = {}, onCreated?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'harness-bridge-'));
  roots.push(root);
  onCreated?.(root);
  const runId = generateRunId();
  const resolvedConfig = { agentId: 'fixture', source: 'runtime', tools: ['Read'] };
  const permissionProfile = buildPermissionProfile(resolvedConfig);
  const recorder = createRunRecorder(createRunStore(root));
  const state = recorder.start({ runId, agentId: 'fixture', prompt: 'hello', resolvedConfig, permissionProfile });
  const toolGuard = new ToolGuard(permissionProfile, recorder, runId);
  const adapter = new BridgeProcessAdapter({
    command: process.execPath, args: ['--input-type=module', '-e', source],
    timeoutMs, confirmProcessExit: true, exitGraceMs: 100,
    ...extra,
  });
  const context = {
    prompt: 'hello', runId, agentId: 'fixture', resolvedConfig, permissionProfile,
    recorder, runState: state, toolGuard,
    toolExecutor: new RepositoryToolExecutor({ rootPath: root, recorder, runId, toolGuard }),
  };
  return { root, adapter, context };
}

const prefix = `
import readline from 'node:readline';
const lines = readline.createInterface({ input: process.stdin });
function reply(frame, kind, payload) { process.stdout.write(JSON.stringify({ ...frame, kind, payload }) + '\\n'); }
lines.on('line', text => {
  const frame = JSON.parse(text);
  if (frame.kind === 'handshake_request') reply(frame, 'handshake_response', { accepted: true });
  if (frame.kind === 'run_request') {
`;
const suffix = `\n  }\n});`;

it('38-08: rejects an overlapping invocation without closing or mutating the first real peer', async () => {
  const preliminary = mkdtempSync(join(tmpdir(), 'harness-overlap-control-')); roots.push(preliminary);
  const ready = join(preliminary, 'ready'), release = join(preliminary, 'release');
  const source = `import{existsSync,writeFileSync}from'node:fs';\n${prefix}
    writeFileSync(${JSON.stringify(ready)},'ready');
    const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);reply(frame,'complete',{data:{first:true}});lines.close();process.stdin.pause();setImmediate(()=>process.exit(0));}},5);
  ${suffix}`;
  const { adapter, context } = setup(source);
  const progress = vi.spyOn(context.recorder, 'progress');
  const first = adapter.execute(context).then(value => ({ value }), error => ({ error }));
  let primary: unknown;
  try {
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    const writes = progress.mock.calls.length;
    await expect(adapter.execute(context)).rejects.toMatchObject({ kind: 'session_unavailable' });
    expect(progress.mock.calls).toHaveLength(writes);
    writeFileSync(release, 'release');
    expect(await first).toMatchObject({ value: { data: { first: true } } });
    expect(adapter.processExitReceipt).toMatchObject({ code: 0 });
  } catch (error) { primary = error; throw error; }
  finally {
    writeFileSync(release, 'release');
    await first;
    try { await adapter.closeSession(`bridge-${context.runId}`); }
    catch (error) { if (primary === undefined) throw error; }
  }
});

describe('real worker recorder contention', () => {
  const kinds = new Set(['handshake_failed', 'session_unavailable', 'timeout', 'envelope_malformed',
    'permission_denied', 'worktree_boundary_violation', 'protocol_version_mismatch', 'process_crash', 'unknown']);
  const codes = new Set(['EACCES', 'EPERM', 'EIO', 'ENOENT', 'ETIMEDOUT', 'RUN_STATE_BUSY', 'RUN_OBSERVATION_TIMEOUT']);
  const field = (value: unknown, key: string): unknown => {
    if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  };
  const failureFacts = (error: unknown) => {
    const kind = field(error, 'kind'), code = field(error, 'code') ?? field(field(error, 'cause'), 'code');
    return { kind: typeof kind === 'string' && kinds.has(kind) ? kind : 'UNKNOWN',
      code: typeof code === 'string' && codes.has(code) ? code : 'UNKNOWN',
      deadlineExceeded: field(error, 'deadlineExceeded') === true };
  };
  let control: string, ready: string, send: string, release: string, marker: string, source: string;
  let fixture: ReturnType<typeof setup> | undefined;
  let outcome: Promise<{ value: unknown } | { error: unknown }> | undefined;
  let exited: Promise<{ output: string; stderr: string }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let phases: Record<string, number>, began: number, firstError: unknown, firstErrorRecorded: boolean;
  const recordFirstError = (error: unknown) => {
    if (!firstErrorRecorded) { firstError = error; firstErrorRecorded = true; }
  };
  let unsubscribe: (() => void) | undefined;
  const ownedRoots = new Set<string>();
  type ChildFact = { kind: 'peer' | 'writer' | 'unknown'; ended: Promise<void>;
    exit?: { code: number | null; signal: NodeJS.Signals | null };
    close?: { code: number | null; signal: NodeJS.Signals | null } };
  const children = new Map<ChildProcess, ChildFact>();
  const mark = (phase: string) => { phases[phase] = performance.now() - began; };
  const ownRoot = (root: string) => {
    ownedRoots.add(root);
    const index = roots.indexOf(root); if (index >= 0) roots.splice(index, 1);
  };
  async function bounded<T>(work: Promise<T>, deadline: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('H38_06_OWNED_WORK_UNCONFIRMED')), Math.max(0, deadline - performance.now()));
      })]);
    } finally { clearTimeout(timeout); }
  }

  beforeEach(() => {
    control = ready = send = release = marker = source = '';
    began = performance.now(); phases = {}; fixture = undefined; outcome = undefined;
    exited = undefined; timer = undefined; firstError = undefined; firstErrorRecorded = false; unsubscribe = undefined;
    children.clear(); ownedRoots.clear();
    try {
      control = mkdtempSync(join(tmpdir(), 'harness-recorder-contention-')); ownRoot(control);
      ready = join(control, 'ready'); send = join(control, 'send');
      release = join(control, 'release'); marker = join(control, 'writer');
      source = `import{existsSync,writeFileSync}from'node:fs';\n${prefix}
        writeFileSync(${JSON.stringify(ready)},'ready');
        const timer=setInterval(()=>{if(existsSync(${JSON.stringify(send)})){clearInterval(timer);reply(frame,'progress',{step:'peer-during-worker-report'});reply(frame,'complete',{data:{ok:true}});lines.close();process.stdin.pause();setImmediate(()=>process.exit(0));}},5);
      ${suffix}`;
      fixture = setup(source, 2_000, {}, ownRoot);
      mark('prepared');
    } catch (error) { recordFirstError(error); throw error; }
  });

  afterEach(async context => {
    const deadline = performance.now() + 5_000, cleanupErrors: unknown[] = [];
    clearTimeout(timer);
    // All gates precede every join; a signal or producer result is never a close receipt.
    for (const path of [send, release]) if (path) {
      try { writeFileSync(path, 'cleanup'); } catch (error) { cleanupErrors.push(error); }
    }
    try {
      if (outcome) await bounded(outcome, deadline);
      if (exited) await bounded(exited.then(() => undefined, error => { cleanupErrors.push(error); }), deadline);
      await bounded(Promise.all([...children.values()].map(value => value.ended)), deadline);
    } catch (error) {
      cleanupErrors.push(error);
      for (const [child, fact] of children) if (fact.kind !== 'unknown' && !fact.close) {
        try { child.kill('SIGKILL'); } catch (cause) { cleanupErrors.push(cause); }
      }
      // Unknown work retains its roots even if a later actual close arrives.
    } finally { unsubscribe?.(); }
    const primaryFailed = context.task.result?.state === 'fail' || firstErrorRecorded;
    if (!primaryFailed && cleanupErrors.length === 0) {
      for (const root of ownedRoots) {
        try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
      }
    }
    if (primaryFailed || cleanupErrors.length > 0) {
      console.error('H38_06_FIXTURE_RETAINED', { ...failureFacts(firstError), phases,
        fixtureIds: [...ownedRoots].map(root => basename(root)),
        cleanup: cleanupErrors.map(failureFacts) });
    }
    if (!primaryFailed && cleanupErrors.length > 0) throw new Error('H38_06_CLEANUP_FAILED');
  });

  it('38-06: yields for a real worker writer while persisting a peer frame exactly once', async () => {
    const { root, adapter, context } = fixture!;
    const script = fileURLToPath(new URL('./fixtures/run-ordered-writer.mjs', import.meta.url));
    const writerArgs = [script, root, context.runId, 'append', marker, release];
    const diagnostic = channel('child_process');
    const pending = new Map<ChildProcess, () => void>();
    const capture = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('process' in value) || !(value.process instanceof ChildProcess)) return;
      const child = value.process, finished = Promise.withResolvers<void>();
      const fact: ChildFact = { kind: 'unknown', ended: finished.promise }; children.set(child, fact);
      child.once('exit', (code, signal) => { fact.exit = { code, signal }; });
      child.once('close', (code, signal) => {
        fact.close = { code, signal }; pending.delete(child); child.removeListener('spawn', spawned);
        mark(fact.kind + '_close'); finished.resolve();
      });
      const spawned = () => {
        pending.delete(child);
        if (child.spawnfile === process.execPath) {
          const args = child.spawnargs.slice(1);
          if (JSON.stringify(args) === JSON.stringify(['--input-type=module', '-e', source])) fact.kind = 'peer';
          else if (JSON.stringify(args) === JSON.stringify(writerArgs)) fact.kind = 'writer';
        }
        mark(fact.kind + '_spawn');
      };
      pending.set(child, spawned); child.once('spawn', spawned);
    };
    diagnostic.subscribe(capture);
    unsubscribe = () => { diagnostic.unsubscribe(capture); for (const [child, spawned] of pending) child.removeListener('spawn', spawned); };
    try {
      mark('adapter_start');
      outcome = adapter.execute(context).then(value => { mark('outcome'); return { value }; }, error => {
        mark('outcome'); recordFirstError(error); return { error };
      });
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true)); mark('peer_ready');
      mark('writer_start');
      const child = spawn(process.execPath, writerArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', stderr = '';
      child.stdout!.on('data', bytes => { output += bytes; }); child.stderr!.on('data', bytes => { stderr += bytes; });
      exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve({ output, stderr }) : reject(new Error('H38_06_WRITER_EXIT_FAILED')));
      });
      void exited.catch(() => undefined);
      await vi.waitFor(() => expect(existsSync(marker + '.acquired')).toBe(true)); mark('writer_acquired');
      writeFileSync(send, 'allow peer frame while writer owns lock'); mark('peer_send');
      timer = setTimeout(() => { writeFileSync(release, 'release writer'); mark('writer_released'); }, 50);
      const result = await outcome;
      const comparable = 'error' in result ? { error: failureFacts(result.error) } : result;
      expect(comparable, JSON.stringify({ phase: 'peer_result', ...failureFacts(firstError), phases }))
        .toMatchObject({ value: { data: { ok: true } } });
      await expect(exited).resolves.toMatchObject({ stderr: '' });
      await bounded(Promise.all([...children.values()].map(value => value.ended)), began + 5_000);
      expect([...children.values()].map(value => value.kind).sort()).toEqual(['peer', 'writer']);
      expect([...children.values()].every(value => value.close?.code === 0 && value.exit?.code === 0)).toBe(true);
      const transcript = readTranscript(context.runId, root);
      expect(transcript.filter(event => event.data?.independentAppend)).toHaveLength(1);
      expect(transcript.filter(event => event.data?.step === 'peer-during-worker-report')).toHaveLength(1);
    } catch (error) { recordFirstError(error); throw error; }
  });
});

/** Observe the exact real test child; failure teardown never fabricates exit evidence. */
function observePeer(root: string, source: string) {
  const diagnostic = channel('child_process');
  const closed = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  const pending = new Map<ChildProcess, () => void>();
  let child: ChildProcess | undefined, closeFact: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let matches = 0, constructions = 0, observationFailure: string | undefined;
  const capture = (value: unknown) => {
    if (!value || typeof value !== 'object' || !('process' in value) || !(value.process instanceof ChildProcess)) {
      observationFailure = 'Invalid child construction observation'; return;
    }
    constructions++;
    const candidate = value.process;
    const spawned = () => {
      pending.delete(candidate);
      if (candidate.spawnfile !== process.execPath || JSON.stringify(candidate.spawnargs.slice(1)) !== JSON.stringify(['--input-type=module', '-e', source])) {
        observationFailure = 'Unexpected child executable or arguments'; return;
      }
      matches++; child = candidate;
      if (matches !== 1 || !Number.isSafeInteger(candidate.pid) || candidate.pid! <= 0) observationFailure = 'Non-unique child identity';
      candidate.once('close', (code, signal) => { closeFact = { code, signal }; closed.resolve(closeFact); });
    };
    pending.set(candidate, spawned); candidate.once('spawn', spawned);
  };
  const bounded = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Fixture close remains unknown; preserve its workspace')), 5_000);
      })]);
    } finally { clearTimeout(timer); }
  };
  if (roots.includes(root)) roots.splice(roots.indexOf(root), 1);
  diagnostic.subscribe(capture);
  return {
    get child() { return child; }, get matches() { return matches; },
    get constructions() { return constructions; }, get pending() { return pending.size; },
    get failure() { return observationFailure; }, get closeFact() { return closeFact; },
    waitForClose: () => bounded(closed.promise),
    async verify<T>(task: Promise<T>, check: () => Promise<void>) {
      let primaryFailure: unknown;
      try { await bounded(check()); }
      catch (cause) { primaryFailure = cause; throw cause; }
      finally {
        try { await bounded(task); }
        catch (cause) {
          if (primaryFailure === undefined) { primaryFailure = cause; throw cause; }
          if (primaryFailure instanceof Error) {
            try { Object.defineProperty(primaryFailure, 'fixtureSettlementError', { value: cause }); } catch { /* preserve the primary */ }
          }
        } finally { await this.release(primaryFailure); }
      }
    },
    async release(primaryFailure?: unknown) {
      try {
        if (child && !closeFact) { child.kill('SIGKILL'); await bounded(closed.promise); }
      } catch (cleanupError) {
        if (primaryFailure === undefined) throw cleanupError;
        if (primaryFailure instanceof Error) {
          try { Object.defineProperty(primaryFailure, 'fixtureCleanupError', { value: cleanupError }); } catch { /* preserve the primary */ }
        }
      } finally {
        diagnostic.unsubscribe(capture);
        for (const [candidate, spawned] of pending) candidate.removeListener('spawn', spawned);
        if (((constructions === 1 && matches === 1 && closeFact && pending.size === 0 && !observationFailure) || (constructions === 0 && pending.size === 0 && !observationFailure)) && !roots.includes(root)) roots.push(root);
      }
    },
  };
}

async function assertRefusedChild(
  observation: ReturnType<typeof observePeer>, adapter: BridgeProcessAdapter,
  error: BridgeAdapterError, authorityCalls: number, startedAt: number,
) {
  expect(observation.failure).toBeUndefined();
  expect(observation.pending).toBe(0);
  if (observation.constructions === 0) {
    // A spent startup budget can deny before the OS is asked to create a child.
    // Zero successful spawn events alone would not establish this branch.
    expect(observation.matches).toBe(0);
    expect(error.kind).toBe('timeout');
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(authorityCalls).toBe(0);
    expect(adapter.processExitReceipt).toBeNull();
    expect(observation.child).toBeUndefined();
    return;
  }
  expect(observation.constructions).toBe(1);
  expect(observation.matches).toBe(1);
  expect(observation.child!.pid).toBeGreaterThan(0);
  const receiptAtReturn = adapter.processExitReceipt;
  if (receiptAtReturn) expect(observation.closeFact).toEqual(receiptAtReturn);
  else {
    expect(observation.closeFact).toBeUndefined();
    expect(error.shutdownEvidence).toEqual({ exit: null, clean: false });
  }
  const actualClose = await observation.waitForClose();
  expect(observation.constructions).toBe(1);
  expect(observation.matches).toBe(1);
  expect(observation.pending).toBe(0);
  expect(observation.failure).toBeUndefined();
  if (receiptAtReturn) expect(actualClose).toEqual(receiptAtReturn);
  // A separately observed late close does not change the returned refusal.
  if (!receiptAtReturn) expect(error.shutdownEvidence).toEqual({ exit: null, clean: false });
}

describe('test observer ownership', () => {
  it('rejects a construction arriving during close observation and preserves its workspace', async () => {
    const source = 'inert observer contract; no OS spawn';
    const { root, adapter } = setup(source);
    const observation = observePeer(root, source);
    // Inert emitters only. No spawn call is made and no real PID is signalled.
    const first = Object.assign(new ChildProcess(), { spawnfile: process.execPath, spawnargs: [process.execPath, '--input-type=module', '-e', source], pid: 123 });
    try {
      first.emit('spawn');
      const refusal = new BridgeAdapterError('timeout', 'Fixed test refusal');
      refusal.shutdownEvidence = { exit: null, clean: false };
      const check = assertRefusedChild(observation, adapter, refusal, 0, performance.now());
      new ChildProcess(); first.emit('close', 0, null);
      await expect(check).rejects.toThrow();
      await observation.release();
      expect(observation.constructions).toBe(2); expect(observation.pending).toBe(1);
      expect(roots).not.toContain(root);
    } finally {
      await observation.release();
      // Both objects are inert; the negative ownership fixture is now disposed.
      if (!roots.includes(root)) roots.push(root);
    }
  });
});

describe('Harness bridge ownership', () => {
  it('returns complete.data only after an observed clean exit', async () => {
    const { adapter, context } = setup(prefix + `reply(frame, 'complete', { data: { text: 'done' } });` + suffix);
    expect((await adapter.execute(context)).data).toEqual({ text: 'done' });
    expect(adapter.processExitReceipt).toEqual({ code: 0, signal: null });
  });

  it.each(['deadline', 'cancel', 'elapsed'] as const)('does not return success when %s invalidates clean shutdown confirmation', async kind => {
    const controller = new AbortController();
    const started = performance.now();
    if (kind === 'deadline') vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const { adapter, context } = setup(prefix + `reply(frame, 'complete', { data: 'must not succeed' });` + suffix);
    const close = adapter.closeSession.bind(adapter);
    vi.spyOn(adapter, 'closeSession').mockImplementationOnce(async id => {
      if (kind !== 'elapsed') controller.abort(new Error('Cancelled during shutdown'));
      const result = await close(id);
      if (kind === 'elapsed') vi.spyOn(performance, 'now').mockReturnValue(started + 60_000);
      return result;
    });
    const outcome = await adapter.execute({ ...context, ...(kind === 'cancel' ? { signal: controller.signal } : {}) })
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    expect(adapter.processExitReceipt).toEqual({ code: 0, signal: null });
    expect(outcome.value).toBeUndefined();
    expect(outcome.error).toMatchObject({ kind: kind === 'cancel' ? 'unknown' : 'timeout' });
  });

  it.each([false, true])('rejects frames from a different run with held-open peer=%s', async holdOpen => {
    const source = prefix + `reply({ ...frame, correlationId: 'other' }, 'complete', { data: {} });${holdOpen ? 'setInterval(() => {}, 1_000);' : ''}` + suffix;
    const { root, adapter, context } = setup(source);
    const observation = observePeer(root, source);
    const progress = vi.spyOn(context.recorder, 'progress');
    const startedAt = performance.now();
    const task = adapter.execute(context).then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
    await observation.verify(task, async () => {
      const outcome = await task;
      expect(outcome.value).toBeUndefined();
      expect(outcome.error).toBeInstanceOf(BridgeAdapterError);
      if (!(outcome.error instanceof BridgeAdapterError)) throw new Error('Expected a typed protocol refusal.');
      expect(outcome.error.kind).toBe('envelope_malformed');
      expect(outcome.error.message).toContain('another run');
      expect(observation.constructions).toBe(1);
      expect(observation.matches).toBe(1);
      const receiptAtReturn = adapter.processExitReceipt;
      await assertRefusedChild(observation, adapter, outcome.error, 0, startedAt);
      const state = createRunStore(root).readRun(context.runId);
      expect(state).not.toBeNull();
      expect(state!.toolCalls).toBe(0);
      expect(state!.status).not.toBe('completed');
      expect(progress.mock.calls.some(([, data]) => data.step === 'bridge_session_failed' && data.errorKind === 'envelope_malformed')).toBe(true);
      expect(progress.mock.calls.some(([, data]) => data.step === 'bridge_session_completed')).toBe(false);
      if (receiptAtReturn && (receiptAtReturn.code !== 0 || receiptAtReturn.signal !== null)) {
        expect(outcome.error.shutdownEvidence).toEqual({ exit: receiptAtReturn, clean: false });
      }
    });
  });

  it('retains an explicit null data value and refuses a missing data field', async () => {
    const valid = setup(prefix + `reply(frame, 'complete', { data: null });` + suffix);
    expect((await valid.adapter.execute(valid.context)).data).toBeNull();
    const missing = setup(prefix + `reply(frame, 'complete', { result: 'not data' });` + suffix);
    await expect(missing.adapter.execute(missing.context)).rejects.toThrow(/data/);
  });

  it('rejects duplicate terminal frames even when the first complete would otherwise be valid', async () => {
    const { adapter, context } = setup(prefix + `reply(frame, 'complete', { data: 1 }); reply(frame, 'complete', { data: 2 });` + suffix);
    await expect(adapter.execute(context)).rejects.toThrow('Duplicate terminal');
  });

  it('decodes multibyte UTF-8 split across process writes', async () => {
    const { adapter, context } = setup(prefix + `
      const bytes = Buffer.from(JSON.stringify({ ...frame, kind: 'complete', payload: { data: '双向闭环' } }) + '\\n');
      const cut = bytes.indexOf(Buffer.from('双')) + 1;
      process.stdout.write(bytes.subarray(0, cut));
      setTimeout(() => process.stdout.write(bytes.subarray(cut)), 10);
    ` + suffix);
    expect((await adapter.execute(context)).data).toBe('双向闭环');
  });

  it('requires an acknowledged live host authorization before the peer proceeds', async () => {
    const authorizeTool = vi.fn(async () => {});
    const { adapter, context } = setup(prefix + `
      reply(frame, 'tool_request', { phase: 'authorize', authorizationRequestId: 'auth-1', toolName: 'Read', input: { file_path: '/fixture.txt' } });
    }
    if (frame.kind === 'tool_response' && frame.payload.authorizationRequestId === 'auth-1') {
      if (frame.payload.allowed !== true) process.exit(9);
      reply(frame, 'complete', { data: 'authorized' });
    ` + suffix, 2_000, { authorizeTool });
    expect((await adapter.execute(context)).data).toBe('authorized');
    expect(authorizeTool).toHaveBeenCalledTimes(1);
    expect(authorizeTool.mock.calls[0]?.slice(1)).toEqual(['Read', { file_path: '/fixture.txt' }]);
  });

  it('refuses live authority or an earlier original startup cutoff without effects', async () => {
    for (const authorizeTool of [async () => { throw new Error('PRIVATE_AUTHORITY_DETAIL'); }, () => new Promise<void>(() => {})]) {
      const source = prefix + `
        reply(frame, 'tool_request', { phase: 'authorize', authorizationRequestId: 'auth-1', toolName: 'Read', input: {} });
      ` + suffix;
      const authority = vi.fn(authorizeTool);
      const { root, adapter, context } = setup(source, 100, { authorizeTool: authority });
      const effects = vi.spyOn(context.toolExecutor, 'execute');
      const completed = vi.spyOn(context.recorder, 'complete');
      const progress = vi.spyOn(context.recorder, 'progress');
      const observation = observePeer(root, source);
      const startedAt = performance.now();
      const task = adapter.execute(context).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
      await observation.verify(task, async () => {
        const outcome = await task;
        expect(outcome.value).toBeUndefined();
        expect(outcome.error).toBeInstanceOf(BridgeAdapterError);
        expect(['permission_denied', 'timeout']).toContain(outcome.error.kind);
        expect(outcome.error.message).not.toContain('PRIVATE_AUTHORITY_DETAIL');
        expect(effects).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled();
        expect(progress.mock.calls.some(([, value]) => value.step === 'bridge_session_completed')).toBe(false);
        if (observation.constructions === 0) expect(progress.mock.calls.some(([, value]) => value.step === 'bridge_session_started')).toBe(false);
        await assertRefusedChild(observation, adapter, outcome.error as BridgeAdapterError, authority.mock.calls.length, startedAt);
      });
    }
  }, 20_000); // Two authority modes; bounded observation/teardown, not a renewed task.

  it('proves zero child construction when recorder persistence spends the original startup budget', async () => {
    const source = prefix + `reply(frame, 'complete', { data: 'forbidden' });` + suffix;
    const authority = vi.fn(async () => {});
    const { root, adapter, context } = setup(source, 100, { authorizeTool: authority });
    const effects = vi.spyOn(context.toolExecutor, 'execute');
    const completed = vi.spyOn(context.recorder, 'complete');
    const original = context.recorder.progress.bind(context.recorder);
    const progress = vi.spyOn(context.recorder, 'progress').mockImplementation((id, value) => {
      original(id, value);
      if (value.step === 'bridge_mcp_availability') {
        const cutoff = performance.now() + 120;
        while (performance.now() < cutoff) { /* Controlled synchronous persistence stall. */ }
      }
    });
    const observation = observePeer(root, source), startedAt = performance.now();
    const task = adapter.execute(context).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await observation.verify(task, async () => {
      const outcome = await task;
      expect(outcome.value).toBeUndefined(); expect(outcome.error).toBeInstanceOf(BridgeAdapterError);
      expect(observation.constructions).toBe(0);
      expect(effects).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled();
      expect(progress.mock.calls.some(([, value]) => value.step === 'bridge_session_started' || value.step === 'bridge_session_completed')).toBe(false);
      await assertRefusedChild(observation, adapter, outcome.error as BridgeAdapterError, authority.mock.calls.length, startedAt);
    });
  });

  it.each(['rejected', 'pending'] as const)('enters a %s authority port once and preserves its bounded refusal', async mode => {
    const controller = new AbortController();
    if (mode === 'pending') vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const authority = vi.fn(async () => {
      if (mode === 'rejected') throw new Error('PRIVATE_AUTHORITY_DETAIL');
      queueMicrotask(() => controller.abort(new Error('PRIVATE_AUTHORITY_DETAIL')));
      await new Promise<void>(() => {});
    });
    const source = prefix + `reply(frame, 'tool_request', { phase: 'authorize', authorizationRequestId: 'auth-1', toolName: 'Read', input: {} });` + suffix;
    // The file's existing ordinary setup, not an extension of the 100ms case.
    const { root, adapter, context } = setup(source, undefined, { authorizeTool: authority });
    const effects = vi.spyOn(context.toolExecutor, 'execute');
    const completed = vi.spyOn(context.recorder, 'complete');
    const observation = observePeer(root, source), startedAt = performance.now();
    const task = adapter.execute(context).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await observation.verify(task, async () => {
      const outcome = await task;
      expect(outcome.value).toBeUndefined(); expect(outcome.error).toBeInstanceOf(BridgeAdapterError);
      expect(outcome.error).toMatchObject({ kind: mode === 'rejected' ? 'permission_denied' : 'timeout' });
      expect(outcome.error.message).not.toContain('PRIVATE_AUTHORITY_DETAIL');
      expect(authority).toHaveBeenCalledOnce();
      expect(effects).not.toHaveBeenCalled(); expect(completed).not.toHaveBeenCalled();
      await assertRefusedChild(observation, adapter, outcome.error as BridgeAdapterError, authority.mock.calls.length, startedAt);
    });
  });

  it('does not reset the deadline on heartbeat', async () => {
    const { adapter, context } = setup(prefix + `
      const timer = setInterval(() => reply(frame, 'heartbeat', {}), 5);
      lines.on('close', () => clearInterval(timer));
    ` + suffix, 100);
    await expect(adapter.execute(context)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('drains more than 256 valid heartbeats while live authorization is pending', async () => {
    const authorizeTool = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
    const { adapter, context } = setup(prefix + `
      reply(frame, 'tool_request', { phase: 'authorize', authorizationRequestId: 'auth-1', toolName: 'Read', input: { file_path: '/fixture.txt' } });
      for (let n = 0; n < 600; n++) reply(frame, 'heartbeat', {});
    }
    if (frame.kind === 'tool_response') reply(frame, 'complete', { data: 'one live action' });
    if (false) {
    ` + suffix, 2_000, { authorizeTool });
    expect((await adapter.execute(context)).data).toBe('one live action');
    expect(authorizeTool).toHaveBeenCalledOnce();
  });

  it.each(['foreign', 'missing-data', 'duplicate', 'utf8', 'truncated'])('applies strict %s validation to legacy providers too', async kind => {
    const body = kind === 'foreign' ? `reply({ ...frame, correlationId: 'OTHER' }, 'complete', { data: 1 });`
      : kind === 'missing-data' ? `reply(frame, 'complete', { result: 1 });`
      : kind === 'duplicate' ? `reply(frame, 'complete', { data: 1 }); reply(frame, 'complete', { data: 2 });`
      : kind === 'utf8' ? `process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));`
      : `process.stdout.write('{"protocolVersion":'); process.exit(0);`;
    const { adapter, context } = setup(prefix + body + suffix, 2_000, { confirmProcessExit: false });
    await expect(adapter.execute(context)).rejects.toMatchObject({ kind: 'envelope_malformed' });
  });

  it.each(['within', 'outside'] as const)('uses one absolute legacy completion grace: %s', async boundary => {
    const base = performance.now();
    let observed = base;
    vi.spyOn(performance, 'now').mockImplementation(() => observed);
    const { adapter, context } = setup(prefix + `reply(frame, 'progress', { step: 'advance-clock' }); reply(frame, 'complete', { data: 'boundary' });` + suffix,
      2_000, { confirmProcessExit: false });
    const progress = context.recorder.progress.bind(context.recorder);
    vi.spyOn(context.recorder, 'progress').mockImplementation((runId, data) => {
      progress(runId, data);
      if (data.step === 'advance-clock') observed = base + (boundary === 'within' ? 2_050 : 3_001);
    });
    if (boundary === 'within') expect((await adapter.execute(context)).data).toBe('boundary');
    else await expect(adapter.execute(context)).rejects.toMatchObject({ kind: 'timeout' });
  });

  it.each([-86_400_000, 86_400_000])('does not use an unrelated wall-clock jump of %i ms as local elapsed time', async jump => {
    const wall = Date.now();
    const { adapter, context } = setup(prefix + `reply(frame, 'progress', { step: 'wall-jump' }); reply(frame, 'complete', { data: 'local elapsed only' });` + suffix);
    const progress = context.recorder.progress.bind(context.recorder);
    vi.spyOn(context.recorder, 'progress').mockImplementation((id, value) => {
      progress(id, value); if (value.step === 'wall-jump') vi.spyOn(Date, 'now').mockReturnValue(wall + jump);
    });
    expect((await adapter.execute(context)).data).toBe('local elapsed only');
  });

  it('retains an explicit UTC task cutoff as a separate denial bound even while monotonic execution time remains', async () => {
    const wall = Date.now();
    const { adapter, context } = setup(prefix + `reply(frame, 'progress', { step: 'utc-policy-expiry' }); reply(frame, 'complete', { data: 'not accepted' });` + suffix);
    const progress = context.recorder.progress.bind(context.recorder);
    vi.spyOn(context.recorder, 'progress').mockImplementation((id, value) => {
      progress(id, value); if (value.step === 'utc-policy-expiry') vi.spyOn(Date, 'now').mockReturnValue(wall + 60_000);
    });
    await expect(adapter.execute({ ...context, executionDeadline: wall + 30_000 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('does not overwrite a primary permission denial when its deadline also aborts', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const denial = new BridgeAdapterError('permission_denied', 'fixed permission refusal');
    const authorizeTool = async () => { controller.abort(new Error('deadline')); throw denial; };
    const { adapter, context } = setup(prefix + `reply(frame, 'tool_request', { phase: 'authorize', authorizationRequestId: 'auth', toolName: 'Read', input: {} });` + suffix,
      2_000, { authorizeTool });
    await expect(adapter.execute(context)).rejects.toMatchObject({ kind: 'permission_denied', message: 'fixed permission refusal', deadlineExceeded: true });
  });

  it('settles an in-flight public waiter when closeSession is called externally', async () => {
    const source = prefix + `reply(frame, 'progress', { step: 'waiting-for-close' });` + suffix;
    const { root, adapter, context } = setup(source);
    const observation = observePeer(root, source);
    const progress = vi.spyOn(context.recorder, 'progress');
    const task = adapter.execute(context).then(value => ({ value }), error => ({ error }));
    await observation.verify(task, async () => {
      await vi.waitFor(() => expect(progress.mock.calls.some(([, data]) => data.step === 'waiting-for-close')).toBe(true));
      const shutdown = await adapter.closeSession(`bridge-${context.runId}`).then(() => undefined, error => error);
      if (shutdown !== undefined) {
        expect(shutdown).toMatchObject({ kind: 'process_crash' });
        expect(['Bridge did not confirm a clean owned shutdown', 'Bridge exit and side effects remain unknown']).toContain(shutdown.message);
      }
      expect(await task).toMatchObject({ error: { kind: 'session_unavailable' } });
      expect(observation.matches).toBe(1);
      expect(await observation.waitForClose()).toEqual(adapter.processExitReceipt);
    });
  }, 20_000);

  it.each(['callback', 'error-event'] as const)('handles an EPIPE at the public stdin %s boundary without an uncaught exception or success', async boundary => {
    const source = prefix + `
      const hold = setInterval(() => {}, 1000);
      process.stdin.once('end', () => clearInterval(hold));
      reply(frame, 'progress', { step: 'write-fault-ready' });
    ` + suffix;
    const { root, adapter, context } = setup(source);
    const observation = observePeer(root, source);
    const progress = vi.spyOn(context.recorder, 'progress');
    const task = adapter.execute(context).then(value => ({ value }), error => ({ error }));
    await observation.verify(task, async () => {
      await vi.waitFor(() => expect(progress.mock.calls.some(([, data]) => data.step === 'write-fault-ready')).toBe(true));
      expect(observation.matches).toBe(1);
      const stdin = observation.child!.stdin!;
      const pipeError = Object.assign(new Error('Deterministic test-only broken pipe'), { code: 'EPIPE' });
      // Fault injection at a public Writable port, not an OS-generated EPIPE
      // qualification. Closing child fd 0 does not portably close every pipe handle.
      vi.spyOn(stdin, 'write').mockImplementationOnce(((...args: unknown[]) => {
        const callback = args.at(-1);
        if (typeof callback !== 'function') throw new Error('Expected the real Bridge write callback');
        queueMicrotask(() => {
          // Outside write's synchronous try/catch: without the permanent error
          // listener this would be an uncaught event, not a rescued callback.
          if (boundary === 'error-event') stdin.emit('error', pipeError);
          callback(pipeError);
        }); return false;
      }) as typeof stdin.write);
      await expect(adapter.sendEnvelope(`bridge-${context.runId}`, buildBridgeEnvelope(`bridge-${context.runId}`, context.runId,
        'progress', { text: 'x'.repeat(900_000) }))).rejects.toMatchObject({ kind: 'process_crash' });
      expect(await task).toMatchObject({ error: { kind: 'process_crash' } });
      expect(progress.mock.calls.some(([, data]) => data.step === 'bridge_session_completed')).toBe(false);
      expect(await observation.waitForClose()).toEqual(adapter.processExitReceipt);
    });
  }, 20_000);

  it('does not publish success after forced shutdown', async () => {
    const source = prefix + `
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      reply(frame, 'complete', { data: { text: 'must not succeed' } });
    ` + suffix;
    const { root, adapter, context } = setup(source);
    const complete = vi.spyOn(context.recorder, 'complete');
    const progress = vi.spyOn(context.recorder, 'progress');
    const observation = observePeer(root, source);
    const task = adapter.execute(context).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await observation.verify(task, async () => {
      const outcome = await task;
      expect(outcome.value).toBeUndefined();
      expect(outcome.error).toBeInstanceOf(BridgeAdapterError);
      expect(outcome.error).toMatchObject({ kind: 'process_crash' });
      // The unchanged 100 ms cleanup may end before the OS delivers close after
      // SIGKILL. Both fail-closed outcomes are valid, never business success.
      expect(['Bridge did not confirm a clean owned shutdown', 'Bridge exit and side effects remain unknown']).toContain(outcome.error.message);
      expect(complete).not.toHaveBeenCalled();
      expect(progress.mock.calls.some(([, data]) => data.step === 'bridge_session_completed')).toBe(false);
      expect(observation.matches).toBe(1);
      expect(await observation.waitForClose()).toEqual({ code: null, signal: 'SIGKILL' });
      // This is independent, possibly late OS evidence, not extra adapter time.
      expect(outcome.error.shutdownEvidence).toMatchObject({ clean: false });
    });
  }, 20_000);

  it('fails closed without trusted deployment configuration', () => {
    expect(() => createDeepSeekHarnessProvider().resolve({
      agentId: 'fixture', source: 'runtime', runtimeProvider: 'deepseek-harness',
    })).toThrow('not configured');
  });

  it('does not spawn or send a run request for a pre-cancelled invocation', async () => {
    const { adapter, context } = setup('process.exit(99)');
    const controller = new AbortController();
    controller.abort(new Error('Already cancelled'));
    await expect(adapter.execute({ ...context, signal: controller.signal })).rejects.toThrow('Already cancelled');
    expect(adapter.processExitReceipt).toBeNull();
  });

  it('rejects an expired host-owned absolute cutoff before spawning', async () => {
    const { adapter, context } = setup('process.exit(99)');
    await expect(adapter.execute({ ...context, executionDeadline: Date.now() - 1 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(adapter.processExitReceipt).toBeNull();
  });

  it('does not renew the host cutoff after preparation or asynchronous authorization', async () => {
    const base = Date.now();
    let observed = base;
    vi.spyOn(Date, 'now').mockImplementation(() => observed);
    let calls = 0;
    const { adapter, context } = setup(prefix + `
      reply(frame, 'tool_request', { phase: 'authorize', authorizationRequestId: 'auth-1', toolName: 'Read', input: {} });
    ` + suffix, 2_000, { authorizeTool: async () => { calls++; await Promise.resolve(); observed = base + 1_001; } });
    await expect(adapter.execute({ ...context, executionDeadline: base + 1_000 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(calls).toBe(1);
    expect(adapter.processExitReceipt).not.toBeNull();
  });

  it('allows an already received complete to use only its separate cleanup reserve', async () => {
    const base = Date.now();
    let observed = base;
    vi.spyOn(Date, 'now').mockImplementation(() => observed);
    const businessCutoff = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(businessCutoff.signal);
    const { adapter, context } = setup(prefix + `reply(frame, 'complete', { data: 'before cutoff' });` + suffix, 2_000, { exitGraceMs: 500 });
    const close = adapter.closeSession.bind(adapter);
    vi.spyOn(adapter, 'closeSession').mockImplementationOnce(async id => {
      observed = base + 1_001;
      businessCutoff.abort(new Error('Business cutoff during permitted cleanup'));
      return close(id);
    });
    expect((await adapter.execute({ ...context, executionDeadline: base + 1_000 })).data).toBe('before cutoff');
    expect(adapter.processExitReceipt).toEqual({ code: 0, signal: null });
  });

  it('retains a primary error and closes the child when failure diagnostics cannot persist', async () => {
    const { adapter, context } = setup(prefix + `reply(frame, 'error', { kind: 'permission_denied', message: 'primary refusal' });` + suffix);
    const progress = context.recorder.progress.bind(context.recorder);
    vi.spyOn(context.recorder, 'progress').mockImplementation((runId, data) => {
      if (data.step === 'bridge_session_failed') throw new Error('diagnostic disk unavailable');
      return progress(runId, data);
    });
    await expect(adapter.execute(context)).rejects.toMatchObject({ kind: 'permission_denied', message: 'primary refusal', diagnosticPersistenceFailed: true });
    expect(adapter.processExitReceipt).toEqual({ code: 0, signal: null });
  });

  it('does not let a failed abort diagnostic escape its listener or skip child shutdown', async () => {
    const controller = new AbortController();
    const source = prefix + `reply(frame, 'progress', { step: 'abort-now' });` + suffix;
    const { root, adapter, context } = setup(source);
    const observation = observePeer(root, source);
    const progress = context.recorder.progress.bind(context.recorder);
    vi.spyOn(context.recorder, 'progress').mockImplementation((runId, data) => {
      if (data.step === 'bridge_agent_cancel_requested') throw new Error('diagnostic disk unavailable');
      const result = progress(runId, data);
      if (data.step === 'abort-now') controller.abort(new Error('explicit cancellation'));
      return result;
    });
    const task = adapter.execute({ ...context, signal: controller.signal }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    await observation.verify(task, async () => {
      const outcome = await task;
      expect(outcome.value).toBeUndefined();
      expect(outcome.error).toMatchObject({ diagnosticPersistenceFailed: true });
      expect(observation.matches).toBe(1);
      expect(await observation.waitForClose()).toEqual(adapter.processExitReceipt);
    });
  }, 20_000);

  it('does not announce a completed lifecycle before strict legacy wire finalization', async () => {
    const { adapter, context } = setup(prefix + `reply(frame, 'complete', { data: 'not final' }); setTimeout(() => process.stdout.write('truncated'), 20);` + suffix,
      2_000, { confirmProcessExit: false, exitGraceMs: 500 });
    const progress = vi.spyOn(context.recorder, 'progress');
    await expect(adapter.execute(context)).rejects.toMatchObject({ kind: 'envelope_malformed' });
    expect(progress.mock.calls.some(([, data]) => data.step === 'bridge_session_completed')).toBe(false);
  });

  it('closes a child cancelled synchronously during the public spawn diagnostic without sending a handshake', async () => {
    const controller = new AbortController();
    const { adapter, context } = setup(`process.stdin.on('data', () => { process.exitCode = 77; }); process.stdin.resume();`, 2_000, { exitGraceMs: 1_000 });
    const diagnostic = channel('child_process');
    let observed = 0;
    const capture = (value: unknown) => {
      if (!value || typeof value !== 'object' || !('process' in value) || !(value.process instanceof ChildProcess)) return;
      observed++;
      controller.abort(new Error('cancelled during spawn'));
    };
    diagnostic.subscribe(capture);
    try { await expect(adapter.execute({ ...context, signal: controller.signal })).rejects.toThrow('cancelled during spawn'); }
    finally { diagnostic.unsubscribe(capture); }
    expect(observed).toBe(1);
    expect(adapter.processExitReceipt).toEqual({ code: 0, signal: null });
  });

  it.each(['late-duplicate', 'late-utf8', 'late-tail'] as const)('finalizes legacy stdout before accepting %s', kind => {
    const late = kind === 'late-duplicate' ? `reply(frame, 'complete', { data: 'late' });`
      : kind === 'late-utf8' ? `process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));`
      : `process.stdout.write('{"partial":');`;
    const { adapter, context } = setup(prefix + `reply(frame, 'complete', { data: 'not final yet' }); setTimeout(() => { ${late} }, 20);` + suffix,
      2_000, { confirmProcessExit: false, exitGraceMs: 300 });
    return expect(adapter.execute(context)).rejects.toMatchObject({ kind: 'envelope_malformed' });
  });

  it('does not provision absent deployment and refuses a configuration parent link', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-deployment-'));
    roots.push(root);
    expect(createConfiguredHarnessTaskHost(root, 'fixture')).toBeUndefined();
    const target = join(root, 'target');
    mkdirSync(target);
    mkdirSync(join(target, 'harness'));
    writeFileSync(join(target, 'harness/deployment.json'), '{}');
    symlinkSync(target, join(root, '.openslack.local'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => createConfiguredHarnessTaskHost(root, 'fixture')).toThrow(/traverses? (?:a )?(?:directory )?link/);
  });
});
