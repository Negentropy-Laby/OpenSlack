import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChildProcess } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { BridgeProcessAdapter } from '../bridge-adapter.js';
import { createRunStore } from '../run-store.js';
import { createRunRecorder } from '../recorder.js';
import { buildPermissionProfile } from '../permissions.js';
import { ToolGuard } from '../adapter.js';
import { RepositoryToolExecutor } from '../tool-executor.js';
import type { BridgeEnvelope } from '../bridge-contract.js';
import { readTranscript } from '../transcript.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// The child deliberately ignores EOF. The adapter must use its cleanup budget,
// not wait for this independent natural-exit timer to settle a missed waiter.
const child = `
import readline from 'node:readline';
setTimeout(() => process.exit(0), 4000);
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', text => {
  const frame = JSON.parse(text);
  const reply = (kind, payload) => process.stdout.write(JSON.stringify({ ...frame, kind, payload }) + '\\n');
  if (frame.kind === 'handshake_request') reply('handshake_response', { accepted: true });
  if (frame.kind === 'run_request') reply('tool_request', {
    phase: 'authorize', authorizationRequestId: 'authorization-1', toolName: 'Read', input: {},
  });
});
`;
const delayedCloseChild = `
import readline from 'node:readline';
const hold = setInterval(() => {}, 1000);
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', text => {
  const frame = JSON.parse(text);
  const reply = (kind, payload) => process.stdout.write(JSON.stringify({ ...frame, kind, payload }) + '\\n');
  if (frame.kind === 'handshake_request') reply('handshake_response', { accepted: true });
  if (frame.kind === 'run_request') reply('complete', { data: 'already complete before cleanup' });
});
process.stdin.on('end', () => setTimeout(() => { clearInterval(hold); process.exit(0); }, 250));
`;

interface PublicCloseFact {
  readonly pid: number;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly observedAt: number;
}

/** Public process observation only; no patched spawn, private fields or PID-only exit inference. */
function observeExactChild(args: readonly string[]) {
  const diagnostic = channel('child_process');
  const pending = new Map<ChildProcess, () => void>();
  const matched = new Map<ChildProcess, { exit?: PublicCloseFact; close?: PublicCloseFact; ended: Promise<void> }>();
  let closeFact: PublicCloseFact | undefined;
  let observationFailure: string | undefined;
  let resolveFirstClose!: (fact: PublicCloseFact) => void;
  const firstClose = new Promise<PublicCloseFact>(resolve => { resolveFirstClose = resolve; });
  const unsubscribe = () => {
    diagnostic.unsubscribe(observe);
    for (const [candidate, onSpawn] of pending) candidate.removeListener('spawn', onSpawn);
    pending.clear();
  };
  const observe = (value: unknown) => {
    if (!value || typeof value !== 'object' || !('process' in value) || !(value.process instanceof ChildProcess)) return;
    const candidate = value.process;
    const onSpawn = () => {
      pending.delete(candidate);
      if (candidate.spawnfile !== process.execPath || candidate.spawnargs.length !== args.length + 1 ||
        !args.every((arg, index) => candidate.spawnargs[index + 1] === arg)) return;
      let resolveEnded!: () => void;
      const entry: { exit?: PublicCloseFact; close?: PublicCloseFact; ended: Promise<void> } = {
        ended: new Promise<void>(resolve => { resolveEnded = resolve; }),
      };
      matched.set(candidate, entry);
      if (matched.size !== 1 || !Number.isSafeInteger(candidate.pid)) observationFailure = 'Expected one uniquely bound actual child';
      const fact = (code: number | null, signal: NodeJS.Signals | null) => Object.freeze({
        pid: candidate.pid ?? -1, code, signal, observedAt: performance.now(),
      });
      candidate.once('exit', (code, signal) => { entry.exit = fact(code, signal); });
      candidate.once('close', (code, signal) => {
        entry.close = fact(code, signal);
        closeFact ??= entry.close;
        resolveFirstClose(closeFact);
        resolveEnded();
      });
    };
    pending.set(candidate, onSpawn);
    candidate.once('spawn', onSpawn);
  };
  diagnostic.subscribe(observe);
  const bounded = async <T>(work: Promise<T>, timeoutMs: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Actual owned child close was not observed within its test observation bound')), Math.max(0, timeoutMs));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  return {
    snapshot: () => ({ matches: matched.size, failure: observationFailure, close: closeFact,
      exit: [...matched.values()][0]?.exit }),
    waitForClose: (timeoutMs: number) => closeFact ? Promise.resolve(closeFact) : bounded(firstClose, timeoutMs),
    release: async () => {
      // A failed assertion may still own a process. This is failure-only test
      // teardown, never extra time granted to the adapter's 100ms policy.
      for (const [candidate, entry] of matched) if (!entry.close) candidate.kill('SIGKILL');
      await bounded(Promise.all([...matched.values()].map(entry => entry.ended)), 5_000);
      unsubscribe(); // Never detach observation before the actual owned close.
    },
  };
}

async function exerciseSendCancellation(
  boundary: 'handshake_request' | 'run_request' | 'tool_response',
  kind: 'cancel' | 'deadline',
  stallParent = false,
) {
    const root = mkdtempSync(join(tmpdir(), 'bridge-send-cancellation-'));
    roots.push(root);
    const store = createRunStore(root);
    const recorder = createRunRecorder(store, root);
    const runId = 'RUN-SEND-CANCELLATION';
    const resolvedConfig = { agentId: 'fixture', source: 'unit-test', tools: ['Read'] };
    const permissionProfile = buildPermissionProfile(resolvedConfig);
    const runState = recorder.start({ runId, agentId: 'fixture', prompt: 'fixture', resolvedConfig, permissionProfile });
    const toolGuard = new ToolGuard(permissionProfile, recorder, runId);
    const controller = new AbortController();
    const reason = kind === 'deadline' ? new DOMException('Controlled deadline', 'TimeoutError') : new Error('Controlled cancellation');
    if (kind === 'deadline') vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let abortedAt: number | undefined, abortedWallTime: number | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    let stallStartedAt: number | undefined, stallEndedAt: number | undefined;
    let stallOutcome: ReturnType<typeof Atomics.wait> | undefined;
    const args = ['--input-type=module', '-e', child];
    const observation = observeExactChild(args);
    class PublicSendBoundary extends BridgeProcessAdapter {
      override async sendEnvelope<T>(sessionId: string, envelope: BridgeEnvelope<T>): Promise<void> {
        await super.sendEnvelope(sessionId, envelope);
        if (envelope.kind === boundary) {
          abortedAt = performance.now(); abortedWallTime = Date.now();
          if (stallParent) stallTimer = setTimeout(() => {
            stallStartedAt = performance.now();
            stallOutcome = Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
            stallEndedAt = performance.now();
          }, 50);
          controller.abort(reason);
        }
      }
    }
    const adapter = new PublicSendBoundary({ command: process.execPath, args,
      timeoutMs: 6_000, handshakeTimeoutMs: 5_000, confirmProcessExit: true, exitGraceMs: 100,
      authorizeTool: async () => {} });
    let assertionFailure: unknown;
    try {
      const error = await adapter.execute({ runId, agentId: 'fixture', prompt: 'fixture', resolvedConfig, permissionProfile,
      recorder, runState, toolGuard, ...(kind === 'cancel' ? { signal: controller.signal } : {}),
      toolExecutor: new RepositoryToolExecutor({ rootPath: root, recorder, runId, toolGuard }),
      }).then(() => undefined, failure => failure);
      const returnedAt = performance.now(), returnedWallTime = Date.now();
      const receiptAtReturn = adapter.processExitReceipt;
      const observedAtReturn = observation.snapshot();
      expect(abortedAt).toBeDefined();
      // Scheduling tolerance is not an extension of the actual 100ms cleanup.
      expect(returnedAt - abortedAt!).toBeLessThan(600);
      expect(error).toMatchObject({ kind: kind === 'deadline' ? 'timeout' : 'session_unavailable' });
      expect(error.cause).toBe(reason);
      expect(observedAtReturn.matches).toBe(1);
      expect(observedAtReturn.failure).toBeUndefined();
      if (stallParent) {
        expect(stallStartedAt).toBeDefined();
        expect(stallEndedAt).toBeDefined();
        expect(stallOutcome).toBe('timed-out');
        expect(receiptAtReturn).toBeNull(); // Deterministically cover unknown -> late close.
      }
      const shutdownAtReturn = structuredClone(error.shutdownEvidence);
      if (receiptAtReturn) {
        expect(observedAtReturn.close).toBeDefined();
        expect(observedAtReturn.exit).toBeDefined();
        expect(observedAtReturn.close!.observedAt).toBeLessThanOrEqual(returnedAt);
        expect(receiptAtReturn).toEqual({ code: observedAtReturn.close!.code, signal: observedAtReturn.close!.signal });
      } else {
        // In this child fixture no shutdown is requested before cancellation.
        // abortBegin+100 is only an earliest possible cutoff, not an upper
        // bound inferred from abortReturn or asynchronous cleanup scheduling.
        expect(returnedWallTime - abortedWallTime!).toBeGreaterThanOrEqual(100);
        expect(observedAtReturn.close).toBeUndefined(); // Already closed + missing receipt must fail.
        expect(shutdownAtReturn).toEqual({ exit: null, clean: false });
      }
      // Separate observation only: do not turn a late close into a timely or
      // clean shutdown, restore success, or add to the adapter's cleanup budget.
      const closed = await observation.waitForClose(returnedAt + 500 - performance.now());
      expect(closed.observedAt).toBeLessThanOrEqual(returnedAt + 500);
      expect(observation.snapshot().matches).toBe(1);
      expect(observation.snapshot().failure).toBeUndefined();
      expect(observation.snapshot().exit).toMatchObject({ pid: closed.pid, code: closed.code, signal: closed.signal });
      expect(observation.snapshot().exit!.observedAt).toBeLessThanOrEqual(closed.observedAt);
      expect(adapter.processExitReceipt).toEqual({ code: closed.code, signal: closed.signal });
      expect(error.cause).toBe(reason);
      expect(error.kind).toBe(kind === 'deadline' ? 'timeout' : 'session_unavailable');
      expect(error.shutdownEvidence).toEqual(shutdownAtReturn);
      const transcript = readTranscript(runId, root);
      expect(transcript.filter(event => ['tool_call', 'tool_result', 'complete'].includes(event.type))).toEqual([]);
      expect(transcript.some(event => event.type === 'progress' && event.data.step === 'bridge_session_completed')).toBe(false);
      expect(store.getRun(runId)?.toolCalls).toBe(0);
      if (!receiptAtReturn || stallParent) console.info(JSON.stringify({ scope: 'controlled Bridge cancellation exit observation',
        boundary, kind, stalled: stallParent, elapsedMs: returnedAt - abortedAt!, receiptAtReturn,
        elapsedWallMs: returnedWallTime - abortedWallTime!, stallDurationMs: stallParent ? stallEndedAt! - stallStartedAt! : undefined,
        actualExit: observation.snapshot().exit, actualClose: closed,
        actualCloseAfterReturnMs: closed.observedAt - returnedAt, shutdownAtReturn, primaryCausePreserved: error.cause === reason,
        toolEvents: 0, completedEvents: 0 }));
    } catch (error) { assertionFailure = error; throw error; }
    finally {
      if (stallTimer) clearTimeout(stallTimer);
      try { await observation.release(); }
      catch (error) { throw new AggregateError([...(assertionFailure ? [assertionFailure] : []), error], 'Cancellation fixture process shutdown remains unconfirmed'); }
    }
}

describe('Bridge async send cancellation boundary', () => {
  it.each([
    ['handshake_request', 'cancel'], ['run_request', 'cancel'], ['tool_response', 'cancel'],
    ['handshake_request', 'deadline'], ['run_request', 'deadline'], ['tool_response', 'deadline'],
  ] as const)('settles %s immediately when %s arrives after send and before waiter registration', async (boundary, kind) => {
    await exerciseSendCancellation(boundary, kind);
  }, 10_000);

  it('preserves unknown cancellation when a controlled parent event-loop stall delays the actual child close', async () => {
    await exerciseSendCancellation('handshake_request', 'cancel', true);
  }, 10_000);
});

describe('caller cancellation during clean Bridge shutdown', () => {
  it.each([
    [false, 'caller'], [true, 'caller'],
    [false, 'internal-deadline'], [true, 'internal-deadline'],
    [false, 'deadline-then-caller'], [true, 'deadline-then-caller'],
  ] as const)('keeps explicit caller cancellation separate from internal completion policy: owned=%s, %s', async (owned, scenario) => {
    const root = mkdtempSync(join(tmpdir(), 'bridge-close-cancellation-'));
    roots.push(root);
    const recorder = createRunRecorder(createRunStore(root), root);
    const progress = vi.spyOn(recorder, 'progress');
    const runId = 'RUN-CLOSE-CANCELLATION';
    const resolvedConfig = { agentId: 'fixture', source: 'unit-test', tools: ['Read'] };
    const permissionProfile = buildPermissionProfile(resolvedConfig);
    const runState = recorder.start({ runId, agentId: 'fixture', prompt: 'fixture', resolvedConfig, permissionProfile });
    const toolGuard = new ToolGuard(permissionProfile, recorder, runId);
    const caller = new AbortController();
    const internal = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(internal.signal);
    const cancellation = new Error('Caller cancelled during clean shutdown');
    class PublicCloseBoundary extends BridgeProcessAdapter {
      override async closeSession(sessionId: string) {
        if (scenario !== 'caller') setTimeout(() => internal.abort(new DOMException('Internal cutoff', 'TimeoutError')), 10);
        if (scenario !== 'internal-deadline') setTimeout(() => caller.abort(cancellation), 20);
        return super.closeSession(sessionId);
      }
    }
    const adapter = new PublicCloseBoundary({ command: process.execPath, args: ['--input-type=module', '-e', delayedCloseChild],
      timeoutMs: 5_000, handshakeTimeoutMs: 1_000, confirmProcessExit: owned, exitGraceMs: 1_000 });
    const outcome = await adapter.execute({ runId, agentId: 'fixture', prompt: 'fixture', resolvedConfig, permissionProfile,
      recorder, runState, toolGuard, signal: caller.signal,
      toolExecutor: new RepositoryToolExecutor({ rootPath: root, recorder, runId, toolGuard }),
    }).then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    expect(adapter.processExitReceipt).toEqual({ code: 0, signal: null });
    if (scenario === 'internal-deadline' && !owned) {
      expect(outcome.value?.data).toBe('already complete before cleanup');
      expect(outcome.error).toBeUndefined();
    } else {
      expect(outcome.value).toBeUndefined();
      if (scenario === 'internal-deadline') expect(outcome.error).toMatchObject({ kind: 'timeout' });
      else expect(outcome.error).toMatchObject({ kind: 'unknown', cause: cancellation, shutdownEvidence: { clean: true } });
      expect(progress.mock.calls.some(([, data]) => data.step === 'bridge_session_completed')).toBe(false);
    }
  }, 5_000);
});

const pausedReaderChild = String.raw`
import {writeFileSync} from 'node:fs';
const witnessPath = process.argv[1], paused = process.argv[2] === 'paused';
const hold = setInterval(() => {}, 1000);
let pending = '';
const onData = bytes => {
  pending += bytes;
  let newline;
  while ((newline = pending.indexOf('\n')) >= 0) {
    const frame = JSON.parse(pending.slice(0, newline)); pending = pending.slice(newline + 1);
    if (frame.kind === 'handshake_request') {
      if (paused) { process.stdin.removeListener('data', onData); process.stdin.pause(); }
      writeFileSync(witnessPath, JSON.stringify({paused, flowing: process.stdin.readableFlowing, dataListeners: process.stdin.listenerCount('data')}));
      process.stdout.write(JSON.stringify({...frame, kind: 'handshake_response', payload: {accepted:true}}) + '\n');
      setTimeout(() => { clearInterval(hold); process.exit(0); }, 2000);
      if (paused) return;
    }
  }
};
process.stdin.setEncoding('utf8'); process.stdin.on('data', onData);
process.stdin.on('end', () => {});
`;

describe('real Bridge pipe backpressure cancellation', () => {
  it.each([
    ['readable-large-during-send', false, 700 * 1024, false],
    ['paused-small-after-send', true, 32, true],
    ['readable-large-after-send', false, 700 * 1024, true],
    ['paused-large-during-send', true, 700 * 1024, false],
  ] as const)('settles a real pending write before the original cleanup cutoff: %s', async (_name, paused, promptBytes, afterSend) => {
    const root = mkdtempSync(join(tmpdir(), 'bridge-real-backpressure-'));
    roots.push(root);
    const witness = join(root, 'child-witness.json');
    const recorder = createRunRecorder(createRunStore(root), root);
    const runId = 'RUN-REAL-BACKPRESSURE';
    const resolvedConfig = { agentId: 'fixture', source: 'unit-test', tools: ['Read'] };
    const permissionProfile = buildPermissionProfile(resolvedConfig);
    const prompt = 'x'.repeat(promptBytes);
    const runState = recorder.start({ runId, agentId: 'fixture', prompt, resolvedConfig, permissionProfile });
    const toolGuard = new ToolGuard(permissionProfile, recorder, runId);
    const controller = new AbortController();
    const reason = new Error('Real pipe caller cancellation');
    let abortedAt: number | undefined, sendBytes: number | undefined;
    let sendSettled = false, abortedWithWritePending: boolean | undefined;
    const abort = () => { abortedAt = performance.now(); abortedWithWritePending = !sendSettled; controller.abort(reason); };
    class PublicSendObserver extends BridgeProcessAdapter {
      override async sendEnvelope<T>(sessionId: string, envelope: BridgeEnvelope<T>): Promise<void> {
        if (envelope.kind !== 'run_request') return super.sendEnvelope(sessionId, envelope);
        sendBytes = Buffer.byteLength(JSON.stringify(envelope)) + 1;
        if (!afterSend) setTimeout(abort, 20);
        try { await super.sendEnvelope(sessionId, envelope); }
        finally { sendSettled = true; }
        if (afterSend) setTimeout(abort, 20);
      }
    }
    const adapter = new PublicSendObserver({ command: process.execPath,
      args: ['--input-type=module', '-e', pausedReaderChild, witness, paused ? 'paused' : 'readable'],
      timeoutMs: 5_000, handshakeTimeoutMs: 1_000, confirmProcessExit: true, exitGraceMs: 100 });
    const error = await adapter.execute({ runId, agentId: 'fixture', prompt, resolvedConfig, permissionProfile,
      recorder, runState, toolGuard, signal: controller.signal,
      toolExecutor: new RepositoryToolExecutor({ rootPath: root, recorder, runId, toolGuard }),
    }).then(() => undefined, failure => failure);
    expect(sendBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(abortedAt).toBeDefined();
    if (paused && promptBytes > 32) expect(abortedWithWritePending).toBe(true);
    expect(JSON.parse(readFileSync(witness, 'utf8'))).toMatchObject(paused
      ? { paused: true, flowing: false, dataListeners: 0 } : { paused: false, flowing: true });
    expect(performance.now() - abortedAt!).toBeLessThan(600);
    expect(error).toMatchObject({ kind: 'session_unavailable', cause: reason });
    expect(adapter.processExitReceipt).not.toBeNull();
  }, 8_000);
});
