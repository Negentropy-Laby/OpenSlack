import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createBridgeRuntimeResolver,
  createOpenSlackAgentLauncher,
  createRunStore,
} from '../index.js';
import { readTranscript } from '../transcript.js';
import { requestAgentRunCancellation } from '../control.js';
import { resolveTestBunExecutable } from './test-executable.js';

const BUN = resolveTestBunExecutable();

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'bridge-process-smoke-test-'));
}

async function waitForOwnedWork<T>(work: Promise<T>, deadline = performance.now() + 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('BRIDGE_SMOKE_OWNED_WORK_UNCONFIRMED')), Math.max(0, deadline - performance.now()));
    })]);
  } finally { clearTimeout(timer); }
}

/** Observe the exact fixture process; launcher completion never fabricates a close receipt. */
type TestChildObservationChannel = Pick<ReturnType<typeof channel>, 'subscribe' | 'unsubscribe'>;
function observeBridgeChild(args: readonly string[], diagnostic: TestChildObservationChannel = channel('child_process')) {
  const pending = new Map<ChildProcess, () => void>();
  const constructions = new Set<Promise<void>>();
  const matched = new Map<ChildProcess, { ended: Promise<void>; exit?: number | null; close?: number | null }>();
  const observe = (value: unknown) => {
    if (!value || typeof value !== 'object' || !('process' in value) || !(value.process instanceof ChildProcess)) return;
    const child = value.process;
    const finished = Promise.withResolvers<void>();
    constructions.add(finished.promise);
    const spawned = () => {
      pending.delete(child);
      if (child.spawnfile !== BUN || child.spawnargs.length !== args.length + 1 ||
        !args.every((arg, index) => child.spawnargs[index + 1] === arg)) return;
      const entry: { ended: Promise<void>; exit?: number | null; close?: number | null } = { ended: finished.promise };
      matched.set(child, entry);
      child.once('exit', code => { entry.exit = code; });
      child.once('close', code => { entry.close = code; });
    };
    pending.set(child, spawned); child.once('spawn', spawned);
    child.once('close', () => {
      pending.delete(child); child.removeListener('spawn', spawned); finished.resolve();
    });
  };
  diagnostic.subscribe(observe);
  return {
    snapshot: () => [...matched.values()].map(({ exit, close }) => ({ exit, close })),
    join: (deadline?: number) => waitForOwnedWork(Promise.all([...constructions]), deadline),
    release: () => {
      diagnostic.unsubscribe(observe);
      for (const [child, spawned] of pending) child.removeListener('spawn', spawned);
      pending.clear();
    },
  };
}

function createFakeAbyRoot(root: string): string {
  const abyRoot = join(root, 'fake-aby');
  const entrypointDir = join(abyRoot, 'src', 'sidecar', 'entrypoints');
  mkdirSync(entrypointDir, { recursive: true });

  writeFileSync(
    join(entrypointDir, 'runEntrypoint.ts'),
    [
      'const target = process.argv[2];',
      "if (!target) throw new Error('missing entrypoint target');",
      'await import(target);',
    ].join('\n'),
    'utf-8',
  );

  writeFileSync(
    join(entrypointDir, 'agentRunBridge.ts'),
    [
      "import { stdin, stdout, env } from 'node:process';",
      "let buffer = '';",
      "stdin.setEncoding('utf8');",
      'function envelope(input, kind, payload) {',
      "  return JSON.stringify({ protocolVersion: input.protocolVersion, sessionId: input.sessionId, correlationId: input.correlationId, timestamp: new Date().toISOString(), kind, payload }) + '\\n';",
      '}',
      "stdin.on('data', chunk => {",
      '  buffer += chunk;',
      "  const lines = buffer.split('\\n');",
      "  buffer = lines.pop() ?? '';",
      '  for (const line of lines) {',
      '    if (!line.trim()) continue;',
      '    const input = JSON.parse(line);',
      "    if (input.kind === 'handshake_request') {",
      "      stdout.write(envelope(input, 'handshake_response', { accepted: true }));",
      '    }',
      "    if (input.kind === 'run_request') {",
      "      stdout.write(envelope(input, 'run_started', { runId: input.payload.runId }));",
      "      stdout.write(envelope(input, 'assistant_text', { text: 'fake aby response' }));",
      "      stdout.write(envelope(input, 'progress', { step: 'fake_aby_progress' }));",
      "      stdout.write(envelope(input, 'tool_request', { toolName: 'Read', input: { path: 'README.md' } }));",
      "      stdout.write(envelope(input, 'tool_response', { toolName: 'Read', output: { found: true } }));",
      "      stdout.write(envelope(input, 'complete', { data: { response: 'fake aby complete', payload: input.payload, envAudit: { safeRunner: env.AGENT_RUN_BRIDGE_RUNNER, unsafePresent: Boolean(env.OPENSLACK_PRIVATE_KEY) } }, tokenUsage: 7 }));",
      '    }',
      '  }',
      '});',
    ].join('\n'),
    'utf-8',
  );

  return abyRoot;
}

describe('Aby process bridge smoke', () => {
  let root: string;
  let store: ReturnType<typeof createRunStore>;
  let launcher: ReturnType<typeof createOpenSlackAgentLauncher>;
  let observation: ReturnType<typeof observeBridgeChild> | undefined;
  let running: Promise<unknown> | undefined;
  const runId = 'RUN-BRIDGE-SMOKE-FIXTURE';

  beforeEach(() => {
    root = makeTempRoot();
    running = undefined;
    observation = undefined;
    const abyRoot = createFakeAbyRoot(root);
    mkdirSync(join(root, '.openslack.local'), { recursive: true });
    writeFileSync(
      join(root, '.openslack.local', 'agent-runtime.json'),
      JSON.stringify({
        aby: {
          root: abyRoot,
          command: BUN,
          timeoutMs: 15_000,
          env: {
            AGENT_RUN_BRIDGE_RUNNER: 'fake',
            OPENSLACK_PRIVATE_KEY: 'blocked',
          },
        },
      }),
      'utf-8',
    );

    store = createRunStore(root);
    launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      availableMcpServers: ['github'],
      bridgeRuntimeResolver: createBridgeRuntimeResolver({ rootDir: root, env: {} }),
    });

    observation = observeBridgeChild([
      join(abyRoot, 'src', 'sidecar', 'entrypoints', 'runEntrypoint.ts'),
      join(abyRoot, 'src', 'sidecar', 'entrypoints', 'agentRunBridge.ts'),
    ]);
  });

  afterEach(async context => {
    const cleanupDeadline = performance.now() + 5_000;
    try {
      if (running) {
        requestAgentRunCancellation(runId, 'Owned bridge smoke fixture teardown');
        await waitForOwnedWork(running, cleanupDeadline);
      }
      await observation?.join(cleanupDeadline);
      // Delete only after both the owned launcher and actual process are finished.
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      if (context.task.result?.state === 'fail') console.error('BRIDGE_SMOKE_CLEANUP_FAILED_FIXTURE_RETAINED', error);
      else throw error;
    } finally { observation?.release(); }
  });

  it('runs a generic run_request through a fake Aby root and records transcript evidence', async () => {
    let result;
    try {
      const launched = launcher<{
        response: string;
        payload: Record<string, unknown>;
        envAudit: { safeRunner?: string; unsafePresent: boolean };
      }>('inspect README', {
        label: 'anthropic_architect_aby',
        agentRunId: runId,
        phase: 'conversation',
        resolvedAgentConfig: {
          agentId: 'anthropic_architect_aby',
          source: 'test',
          runtime: 'aby_assistant',
          bridgeMode: 'process',
          permissionMode: 'plan',
          requiredMcpServers: ['github'],
        },
        threadId: 'CONV-20260603-ABCDEFGH',
        correlationId: 'CONV-20260603-ABCDEFGH',
      });
      running = launched.then(() => undefined, () => undefined);
      result = await launched;
      await observation!.join();
      expect(observation!.snapshot()).toEqual([{ exit: 0, close: 0 }]);
    } catch (error) {
      const stderr = (error as { stderrSummary?: string }).stderrSummary;
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${stderr ?? ''}`);
    }

    expect(result.data.response).toBe('fake aby complete');
    expect(result.data.payload.input).toEqual([{ role: 'user', content: 'inspect README' }]);
    expect(result.data.payload.mcp).toEqual({ required: ['github'], available: ['github'] });
    expect((result.data.payload.metadata as Record<string, unknown>).integrationId).toBe(
      'openslack',
    );
    expect((result.data.payload.metadata as Record<string, unknown>).threadId).toBe(
      'CONV-20260603-ABCDEFGH',
    );
    expect(result.data.envAudit.safeRunner).toBe('fake');
    expect(result.data.envAudit.unsafePresent).toBe(false);

    const transcript = readTranscript(result.runId, root);
    expect(
      transcript.some(
        (event) => event.type === 'progress' && event.data.step === 'bridge_session_started',
      ),
    ).toBe(true);
    expect(
      transcript.some(
        (event) => event.type === 'progress' && event.data.step === 'bridge_run_started',
      ),
    ).toBe(true);
    expect(
      transcript.some(
        (event) => event.type === 'progress' && event.data.step === 'bridge_assistant_text',
      ),
    ).toBe(true);
    expect(
      transcript.some((event) => event.type === 'tool_call' && event.data.toolName === 'Read'),
    ).toBe(true);
    expect(
      transcript.some((event) => event.type === 'tool_result' && event.data.toolName === 'Read'),
    ).toBe(true);
    expect(transcript.some((event) => event.type === 'complete')).toBe(true);

    const run = store.getRun(result.runId);
    expect(run?.status).toBe('completed');
  });
});


describe('bridge smoke construction ownership', () => {
  it.each(['pending-spawn', 'error-before-spawn'] as const)('does not treat %s as confirmed process termination', async mode => {
    let notify: Parameters<TestChildObservationChannel['subscribe']>[0] | undefined;
    const subscribe = vi.fn<TestChildObservationChannel['subscribe']>(listener => { notify = listener; });
    const unsubscribe = vi.fn<TestChildObservationChannel['unsubscribe']>(() => true);
    const observation = observeBridgeChild([], { subscribe, unsubscribe });
    // Inert event emitter only: no OS child or actual-close evidence is fabricated.
    const child = new ChildProcess();
    child.on('error', () => undefined); // Existing runtime error consumer, not a close receipt.
    notify!({ process: child }, 'child_process');
    const joined = observation.join();
    let ended = false; void joined.then(() => { ended = true; }, () => { ended = true; });
    try {
      if (mode === 'error-before-spawn') child.emit('error', new Error('Controlled fixture spawn failure'));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(ended).toBe(false);
      expect(observation.snapshot()).toEqual([]);
    } finally { child.emit('close', null, null); await joined; observation.release(); }
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('refuses an unclosed construction at the original observation deadline', async () => {
    let notify: Parameters<TestChildObservationChannel['subscribe']>[0] | undefined;
    const subscribe = vi.fn<TestChildObservationChannel['subscribe']>(listener => { notify = listener; });
    const unsubscribe = vi.fn<TestChildObservationChannel['unsubscribe']>(() => true);
    const observation = observeBridgeChild([], { subscribe, unsubscribe });
    const child = new ChildProcess();
    notify!({ process: child }, 'child_process');
    vi.useFakeTimers();
    try {
      const assertion = expect(observation.join()).rejects.toThrow('BRIDGE_SMOKE_OWNED_WORK_UNCONFIRMED');
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(observation.snapshot()).toEqual([]);
    } finally { observation.release(); vi.useRealTimers(); }
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
