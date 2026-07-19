import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BridgeLifecycleMapper } from '../bridge-lifecycle.js';
import { createRunRecorder } from '../recorder.js';
import { createRunStore } from '../run-store.js';
import { generateRunId } from '../run-store.js';
import { readTranscript } from '../transcript.js';
import { buildPermissionProfile } from '../permissions.js';
import { FakeBridgeAdapter, createOpenSlackAgentLauncher } from '../index.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'bridge-lifecycle-test-'));
}

function cleanup(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('BridgeLifecycleMapper', () => {
  let root: string;
  let store: ReturnType<typeof createRunStore>;
  let recorder: ReturnType<typeof createRunRecorder>;

  beforeEach(() => {
    root = makeTempRoot();
    store = createRunStore(root);
    recorder = createRunRecorder(store, root);
  });

  afterEach(() => {
    cleanup(root);
  });

  function startRun(runId: string): void {
    recorder.start({
      runId,
      agentId: 'test',
      prompt: 'test',
      resolvedConfig: { agentId: 'test', source: 'test' },
      permissionProfile: buildPermissionProfile({ agentId: 'test', source: 'test' }),
    });
  }

  it('onSessionOpen emits bridge_session_started', () => {
    const runId = generateRunId();
    startRun(runId);
    const mapper = new BridgeLifecycleMapper(recorder, runId);

    mapper.onSessionOpen('sess-123', { extra: 'data' });

    const transcript = readTranscript(runId, root);
    const event = transcript.find(
      (e) =>
        e.type === 'progress' &&
        (e.data as Record<string, unknown>).step === 'bridge_session_started',
    );
    expect(event).toBeDefined();
    expect((event!.data as Record<string, unknown>).sessionId).toBe('sess-123');
    expect((event!.data as Record<string, unknown>).correlationId).toBe(runId);
    expect((event!.data as Record<string, unknown>).extra).toBe('data');
  });

  it('onSessionClose emits bridge_session_completed with summary', () => {
    const runId = generateRunId();
    startRun(runId);
    const mapper = new BridgeLifecycleMapper(recorder, runId);

    const summary = BridgeLifecycleMapper.buildSummary(runId, 'sess-123', {
      tokenUsage: 42,
      durationMs: 1000,
      resultSummary: { toolsUsed: 3 },
    });
    mapper.onSessionClose(summary);

    const transcript = readTranscript(runId, root);
    const event = transcript.find(
      (e) =>
        e.type === 'progress' &&
        (e.data as Record<string, unknown>).step === 'bridge_session_completed',
    );
    expect(event).toBeDefined();
    expect((event!.data as Record<string, unknown>).runId).toBe(runId);
    expect((event!.data as Record<string, unknown>).sessionId).toBe('sess-123');
    expect((event!.data as Record<string, unknown>).terminalReason).toBe('completed');
    expect((event!.data as Record<string, unknown>).tokenUsage).toBe(42);
    expect((event!.data as Record<string, unknown>).durationMs).toBe(1000);
  });

  it('onSessionError emits bridge_session_failed', () => {
    const runId = generateRunId();
    startRun(runId);
    const mapper = new BridgeLifecycleMapper(recorder, runId);

    mapper.onSessionError({
      kind: 'timeout',
      message: 'Session timed out after 120000ms',
      sessionId: 'sess-123',
    });

    const transcript = readTranscript(runId, root);
    const event = transcript.find(
      (e) =>
        e.type === 'progress' &&
        (e.data as Record<string, unknown>).step === 'bridge_session_failed',
    );
    expect(event).toBeDefined();
    expect((event!.data as Record<string, unknown>).errorKind).toBe('timeout');
    expect((event!.data as Record<string, unknown>).errorMessage).toContain('timed out');
    expect((event!.data as Record<string, unknown>).correlationId).toBe(runId);
  });

  it('onBridgeProgress emits bridge_progress events', () => {
    const runId = generateRunId();
    startRun(runId);
    const mapper = new BridgeLifecycleMapper(recorder, runId);

    mapper.onBridgeProgress('thinking', { stepNumber: 3 });

    const transcript = readTranscript(runId, root);
    const event = transcript.find(
      (e) =>
        e.type === 'progress' && (e.data as Record<string, unknown>).step === 'bridge_thinking',
    );
    expect(event).toBeDefined();
    expect((event!.data as Record<string, unknown>).stepNumber).toBe(3);
    expect((event!.data as Record<string, unknown>).correlationId).toBe(runId);
  });

  it('onBridgeToolCall emits bridge_tool_call event', () => {
    const runId = generateRunId();
    startRun(runId);
    const mapper = new BridgeLifecycleMapper(recorder, runId);

    mapper.onBridgeToolCall('Read', { path: 'file.txt' });

    const transcript = readTranscript(runId, root);
    const event = transcript.find(
      (e) =>
        e.type === 'progress' && (e.data as Record<string, unknown>).step === 'bridge_tool_call',
    );
    expect(event).toBeDefined();
    expect((event!.data as Record<string, unknown>).toolName).toBe('Read');
  });

  it('onBridgeToolResult emits bridge_tool_result event', () => {
    const runId = generateRunId();
    startRun(runId);
    const mapper = new BridgeLifecycleMapper(recorder, runId);

    mapper.onBridgeToolResult('Read', { content: 'hello' });

    const transcript = readTranscript(runId, root);
    const event = transcript.find(
      (e) =>
        e.type === 'progress' && (e.data as Record<string, unknown>).step === 'bridge_tool_result',
    );
    expect(event).toBeDefined();
    expect((event!.data as Record<string, unknown>).toolName).toBe('Read');
    expect((event!.data as Record<string, unknown>).output).toEqual({ content: 'hello' });
  });

  it('gracefully handles null recorder (no-op)', () => {
    const mapper = new BridgeLifecycleMapper(null, 'RUN-NULL');

    // None of these should throw
    mapper.onSessionOpen('sess-null');
    mapper.onSessionClose({
      runId: 'RUN-NULL',
      sessionId: 'sess-null',
      terminalReason: 'completed',
    });
    mapper.onSessionError({ kind: 'timeout', message: 'test', sessionId: 'sess-null' });
    mapper.onBridgeProgress('thinking', { stepNumber: 1 });
    mapper.onBridgeToolCall('Read', { path: 'file.txt' });
    mapper.onBridgeToolResult('Read', { content: 'hello' });

    // If we reach here, no exceptions were thrown
    expect(true).toBe(true);
  });

  it('gracefully handles undefined recorder (no-op)', () => {
    const mapper = new BridgeLifecycleMapper(undefined, 'RUN-UNDEF');

    mapper.onSessionOpen('sess-undef');
    mapper.onSessionClose({
      runId: 'RUN-UNDEF',
      sessionId: 'sess-undef',
      terminalReason: 'completed',
    });
    mapper.onSessionError({ kind: 'timeout', message: 'test', sessionId: 'sess-undef' });

    expect(true).toBe(true);
  });
});

describe('BridgeLifecycleMapper.buildSummary', () => {
  it('builds a completed summary', () => {
    const summary = BridgeLifecycleMapper.buildSummary('RUN-1', 'sess-1', {
      tokenUsage: 100,
      toolCalls: 5,
      uniqueTools: ['Read', 'Edit'],
      lastTool: 'Edit',
      durationMs: 5000,
    });

    expect(summary.runId).toBe('RUN-1');
    expect(summary.sessionId).toBe('sess-1');
    expect(summary.terminalReason).toBe('completed');
    expect(summary.tokenUsage).toBe(100);
    expect(summary.toolStats).toEqual({
      totalCalls: 5,
      uniqueTools: ['Read', 'Edit'],
      lastTool: 'Edit',
    });
    expect(summary.durationMs).toBe(5000);
  });

  it('builds summary without optional fields', () => {
    const summary = BridgeLifecycleMapper.buildSummary('RUN-1', 'sess-1');
    expect(summary.runId).toBe('RUN-1');
    expect(summary.sessionId).toBe('sess-1');
    expect(summary.terminalReason).toBe('completed');
    expect(summary.tokenUsage).toBeUndefined();
  });
});

describe('BridgeLifecycleMapper.buildErrorSummary', () => {
  it('builds a failed summary', () => {
    const summary = BridgeLifecycleMapper.buildErrorSummary(
      'RUN-1',
      'sess-1',
      { kind: 'process_crash', message: 'Process exited unexpectedly' },
      { tokenUsage: 50, durationMs: 2000 },
    );

    expect(summary.terminalReason).toBe('failed');
    expect(summary.errorDetails).toEqual({
      kind: 'process_crash',
      message: 'Process exited unexpectedly',
    });
  });

  it('builds a timeout summary', () => {
    const summary = BridgeLifecycleMapper.buildErrorSummary('RUN-1', 'sess-1', {
      kind: 'timeout',
      message: 'Timed out',
    });

    expect(summary.terminalReason).toBe('timeout');
  });
});

describe('FakeBridgeAdapter lifecycle integration', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('records bridge_session_started and bridge_session_completed via FakeBridgeAdapter', async () => {
    const adapter = new FakeBridgeAdapter();
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter,
    });

    await launcher('plan this feature', {
      label: 'planner',
      phase: 'plan',
      resolvedAgentConfig: {
        agentId: 'planner',
        source: 'test',
        permissionMode: 'default',
      },
    });

    const run = store.listRuns()[0];
    const transcript = readTranscript(run.runId, root);

    const startedEvent = transcript.find(
      (e) =>
        e.type === 'progress' &&
        (e.data as Record<string, unknown>).step === 'bridge_session_started',
    );
    expect(startedEvent).toBeDefined();

    const completedEvent = transcript.find(
      (e) =>
        e.type === 'progress' &&
        (e.data as Record<string, unknown>).step === 'bridge_session_completed',
    );
    expect(completedEvent).toBeDefined();
    expect((completedEvent!.data as Record<string, unknown>).terminalReason).toBe('completed');
  });

  it('records bridge_session_failed via FakeBridgeAdapter when shouldFail', async () => {
    const adapter = new FakeBridgeAdapter({ shouldFail: true });
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter,
    });

    await expect(
      launcher('test prompt', {
        label: 'worker',
        phase: 'execute',
        resolvedAgentConfig: {
          agentId: 'worker',
          source: 'test',
          permissionMode: 'default',
        },
      }),
    ).rejects.toThrow();

    const run = store.listRuns()[0];
    const transcript = readTranscript(run.runId, root);

    const failedEvent = transcript.find(
      (e) =>
        e.type === 'progress' &&
        (e.data as Record<string, unknown>).step === 'bridge_session_failed',
    );
    expect(failedEvent).toBeDefined();
    expect((failedEvent!.data as Record<string, unknown>).errorKind).toBe('unknown');
  });

  it('launcher records bridge_lifecycle_complete on success', async () => {
    const adapter = new FakeBridgeAdapter();
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter,
    });

    await launcher('test prompt', {
      label: 'worker',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'worker',
        source: 'test',
        permissionMode: 'default',
      },
    });

    const run = store.listRuns()[0];
    const transcript = readTranscript(run.runId, root);

    const lifecycleEvent = transcript.find(
      (e) =>
        e.type === 'progress' &&
        (e.data as Record<string, unknown>).step === 'bridge_lifecycle_complete',
    );
    expect(lifecycleEvent).toBeDefined();
    expect((lifecycleEvent!.data as Record<string, unknown>).status).toBe('completed');
  });

  it('launcher records bridge_lifecycle_complete on failure', async () => {
    const adapter = new FakeBridgeAdapter({ shouldFail: true });
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter,
    });

    await expect(
      launcher('test prompt', {
        label: 'worker',
        phase: 'execute',
        resolvedAgentConfig: {
          agentId: 'worker',
          source: 'test',
          permissionMode: 'default',
        },
      }),
    ).rejects.toThrow();

    const run = store.listRuns()[0];
    const transcript = readTranscript(run.runId, root);

    const lifecycleEvent = transcript.find(
      (e) =>
        e.type === 'progress' &&
        (e.data as Record<string, unknown>).step === 'bridge_lifecycle_complete',
    );
    expect(lifecycleEvent).toBeDefined();
    expect((lifecycleEvent!.data as Record<string, unknown>).status).toBe('failed');
  });
});
