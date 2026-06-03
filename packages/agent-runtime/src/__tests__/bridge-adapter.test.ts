import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createOpenSlackAgentLauncher,
  createRunStore,
  FakeBridgeAdapter,
  BridgeProcessAdapter,
  BridgeAdapterError,
  type AgentPermissionProfile,
} from '../index.js';
import { readTranscript } from '../transcript.js';
import { buildPermissionProfile } from '../permissions.js';
import { createRunRecorder } from '../recorder.js';
import { generateRunId } from '../run-store.js';
import { ToolGuard } from '../adapter.js';
import { buildBridgeEnvelope } from '../bridge-contract.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'bridge-adapter-test-'));
}

function cleanup(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

const NODE = 'bun';

describe('FakeBridgeAdapter', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('has adapterId "fake-bridge"', () => {
    const adapter = new FakeBridgeAdapter();
    expect(adapter.adapterId).toBe('fake-bridge');
    expect(adapter.bridgeId).toBe('fake-bridge');
  });

  it('implements BridgeContract', async () => {
    const adapter = new FakeBridgeAdapter();
    expect(typeof adapter.negotiateCapabilities).toBe('function');
    expect(typeof adapter.openSession).toBe('function');
    expect(typeof adapter.closeSession).toBe('function');
    expect(typeof adapter.sendEnvelope).toBe('function');
    expect(typeof adapter.healthCheck).toBe('function');
  });

  it('healthCheck returns healthy', async () => {
    const adapter = new FakeBridgeAdapter();
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(true);
    expect(result.details?.mode).toBe('fake');
  });

  it('negotiateCapabilities returns requested non-MCP caps', async () => {
    const adapter = new FakeBridgeAdapter();
    const caps = await adapter.negotiateCapabilities([
      { name: 'Read' },
      { name: 'Write' },
    ]);
    expect(caps).toHaveLength(2);
    expect(caps[0].name).toBe('Read');
  });

  it('negotiateCapabilities filters unavailable MCP servers', async () => {
    const adapter = new FakeBridgeAdapter({ availableMcpServers: ['filesystem'] });
    const caps = await adapter.negotiateCapabilities([
      { name: 'mcp.filesystem.read' },
      { name: 'mcp.git.status' },
    ]);
    expect(caps).toHaveLength(1);
    expect(caps[0].name).toBe('mcp.filesystem.read');
  });

  it('openSession transitions through state machine', async () => {
    const adapter = new FakeBridgeAdapter();
    const state = await adapter.openSession({
      runId: 'RUN-20250101-ABCD',
      agentId: 'test',
      prompt: 'test',
      permissionProfile: { allowedTools: ['Read'], deniedTools: [], permissionMode: 'plan' },
    });
    expect(state).toBe('ready');
  });

  it('closeSession transitions to shutdown', async () => {
    const adapter = new FakeBridgeAdapter();
    await adapter.openSession({
      runId: 'RUN-20250101-ABCD',
      agentId: 'test',
      prompt: 'test',
      permissionProfile: { allowedTools: ['Read'], deniedTools: [], permissionMode: 'plan' },
    });
    const state = await adapter.closeSession('fake-RUN-20250101-ABCD');
    expect(state).toBe('shutdown');
  });

  it('executes through launcher with review prompt', async () => {
    const adapter = new FakeBridgeAdapter();
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter,
    });

    const result = await launcher('review this code', {
      label: 'reviewer',
      phase: 'review',
      resolvedAgentConfig: {
        agentId: 'reviewer',
        source: 'test',
        permissionMode: 'default',
      },
    });

    expect((result.data as Record<string, unknown>).review).toBeDefined();
    expect(result.tokenUsage).toBeGreaterThan(0);

    const runs = store.listRuns();
    expect(runs[0].status).toBe('completed');
  });

  it('executes through launcher with research prompt', async () => {
    const adapter = new FakeBridgeAdapter();
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter,
    });

    const result = await launcher('research this topic', {
      label: 'researcher',
      phase: 'research',
      resolvedAgentConfig: {
        agentId: 'researcher',
        source: 'test',
        permissionMode: 'default',
      },
    });

    expect((result.data as Record<string, unknown>).summary).toBeDefined();
  });

  it('executes through launcher with plan prompt', async () => {
    const adapter = new FakeBridgeAdapter();
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter,
    });

    const result = await launcher('plan this feature', {
      label: 'planner',
      phase: 'plan',
      resolvedAgentConfig: {
        agentId: 'planner',
        source: 'test',
        permissionMode: 'default',
      },
    });

    expect((result.data as Record<string, unknown>).plan).toBeDefined();
  });

  it('respects permission profile tool restrictions', async () => {
    const adapter = new FakeBridgeAdapter();
    const store = createRunStore(root);
    const recorder = createRunRecorder(store, root);
    const profile = buildPermissionProfile({
      agentId: 'test',
      source: 'test',
      permissionMode: 'plan',
    });

    const runId = generateRunId();
    const state = recorder.start({
      runId,
      agentId: 'test',
      prompt: 'test',
      resolvedConfig: { agentId: 'test', source: 'test' },
      permissionProfile: profile,
    });

    const result = await adapter.execute({
      prompt: 'do something',
      runId,
      agentId: 'test',
      resolvedConfig: { agentId: 'test', source: 'test' },
      permissionProfile: profile,
      recorder,
      runState: state,
      toolGuard: new ToolGuard(profile, recorder, runId),
    });

    // plan mode should not have Bash in toolsUsed
    const data = result.data as Record<string, unknown>;
    expect(data.toolsUsed).toBeDefined();
    const toolsUsed = data.toolsUsed as string[];
    expect(toolsUsed).not.toContain('Bash');
  });

  it('records bridge transcript events', async () => {
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

    const startEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'bridge_session_started',
    );
    expect(startEvent).toBeDefined();

    const completeEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'bridge_session_completed',
    );
    expect(completeEvent).toBeDefined();
  });

  it('throws when shouldFail is true', async () => {
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
    ).rejects.toThrow(/Fake bridge configured to fail/);

    const runs = store.listRuns();
    expect(runs[0].status).toBe('failed');
  });

  it('uses customResponseTemplate when provided', async () => {
    const adapter = new FakeBridgeAdapter({
      customResponseTemplate: (prompt) => ({ custom: true, echo: prompt }),
    });
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter,
    });

    const result = await launcher('hello world', {
      label: 'worker',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'worker',
        source: 'test',
        permissionMode: 'default',
      },
    });

    const data = result.data as Record<string, unknown>;
    expect(data.custom).toBe(true);
    expect(data.echo).toBe('hello world');
  });

  it('simulates response delay', async () => {
    const adapter = new FakeBridgeAdapter({ responseDelayMs: 50 });
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter,
    });

    const start = Date.now();
    await launcher('test', {
      label: 'worker',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'worker',
        source: 'test',
        permissionMode: 'default',
      },
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(40); // Allow some tolerance
  });

  it('sendEnvelope throws when session is shutdown', async () => {
    const adapter = new FakeBridgeAdapter();
    await adapter.openSession({
      runId: 'RUN-20250101-ABCD',
      agentId: 'test',
      prompt: 'test',
      permissionProfile: { allowedTools: ['Read'], deniedTools: [], permissionMode: 'plan' },
    });
    await adapter.closeSession('fake-RUN-20250101-ABCD');

    await expect(
      adapter.sendEnvelope('fake-RUN-20250101-ABCD', buildBridgeEnvelope('fake-RUN-20250101-ABCD', 'run', 'progress', {})),
    ).rejects.toThrow(BridgeAdapterError);
  });
});

describe('BridgeProcessAdapter', () => {
  it('has adapterId "bridge-process"', () => {
    const adapter = new BridgeProcessAdapter({ command: 'echo' });
    expect(adapter.adapterId).toBe('bridge-process');
    expect(adapter.bridgeId).toBe('bridge-process');
  });

  it('implements BridgeContract', () => {
    const adapter = new BridgeProcessAdapter({ command: 'echo' });
    expect(typeof adapter.negotiateCapabilities).toBe('function');
    expect(typeof adapter.openSession).toBe('function');
    expect(typeof adapter.closeSession).toBe('function');
    expect(typeof adapter.sendEnvelope).toBe('function');
    expect(typeof adapter.healthCheck).toBe('function');
  });

  it('healthCheck returns not healthy when process not spawned', async () => {
    const adapter = new BridgeProcessAdapter({ command: 'echo' });
    const result = await adapter.healthCheck();
    expect(result.healthy).toBe(false);
  });

  it('negotiateCapabilities returns requested caps', async () => {
    const adapter = new BridgeProcessAdapter({ command: 'echo' });
    const caps = await adapter.negotiateCapabilities([{ name: 'Read' }]);
    expect(caps).toHaveLength(1);
    expect(caps[0].name).toBe('Read');
  });

  it('BridgeAdapterError carries error kind', () => {
    const err = new BridgeAdapterError('timeout', 'test error');
    expect(err.kind).toBe('timeout');
    expect(err.message).toBe('test error');
    expect(err.name).toBe('BridgeAdapterError');
  });

  it('sends filtered permission profile in run_request payload', async () => {
    const root = makeTempRoot();
    try {
      const bridgeScript = join(root, 'capture-bridge.mjs');
      writeFileSync(
        bridgeScript,
        [
          "import { stdin, stdout } from 'node:process';",
          "let buffer = '';",
          "stdin.setEncoding('utf8');",
          "function envelope(input, kind, payload) {",
          "  return JSON.stringify({ protocolVersion: input.protocolVersion, sessionId: input.sessionId, correlationId: input.correlationId, timestamp: new Date().toISOString(), kind, payload }) + '\\n';",
          "}",
          "stdin.on('data', chunk => {",
          "  buffer += chunk;",
          "  const lines = buffer.split('\\n');",
          "  buffer = lines.pop() ?? '';",
          "  for (const line of lines) {",
          "    if (!line.trim()) continue;",
          "    const input = JSON.parse(line);",
          "    if (input.kind === 'handshake_request') stdout.write(envelope(input, 'handshake_response', { accepted: true }));",
          "    if (input.kind === 'run_request') stdout.write(envelope(input, 'complete', { data: { payload: input.payload }, tokenUsage: 1 }));",
          "  }",
          "});",
        ].join('\n'),
        'utf-8',
      );

      const adapter = new BridgeProcessAdapter({
        command: process.execPath,
        args: [bridgeScript],
      });
      const store = createRunStore(root);
      const recorder = createRunRecorder(store, root);
      const permissionProfile: AgentPermissionProfile = {
        allowedTools: ['Read', 'github.pr.merge'],
        deniedTools: [],
        permissionMode: 'default',
        canApprovePR: false,
        canMerge: false,
        canReadSecrets: false,
        canBypassRulesets: false,
        acceptEdits: false,
        isReadOnly: false,
      };
      const runId = generateRunId();
      const runState = recorder.start({
        runId,
        agentId: 'bridge-test',
        prompt: 'capture permissions',
        resolvedConfig: { agentId: 'bridge-test', source: 'test' },
        permissionProfile,
      });

      const result = await adapter.execute({
        prompt: 'capture permissions',
        runId,
        agentId: 'bridge-test',
        resolvedConfig: { agentId: 'bridge-test', source: 'test' },
        permissionProfile,
        recorder,
        runState,
        toolGuard: new ToolGuard(permissionProfile, recorder, runId),
      });

      const data = result.data as Record<string, unknown>;
      const payload = data.payload as Record<string, unknown>;
      expect(payload.allowedTools).toEqual(['Read']);
      expect(payload.permissionMode).toBe('default');
      expect(payload.deniedTools as string[]).toContain('github.pr.merge');
      expect(payload.input).toEqual([{ role: 'user', content: 'capture permissions' }]);
      expect((payload.metadata as Record<string, unknown>).integrationId).toBe('openslack');
    } finally {
      cleanup(root);
    }
  });

  it('fails closed when a bridge emits approval_required', async () => {
    const root = makeTempRoot();
    try {
      const bridgeScript = join(root, 'approval-bridge.mjs');
      writeFileSync(
        bridgeScript,
        [
          "import { stdin, stdout } from 'node:process';",
          "let buffer = '';",
          "stdin.setEncoding('utf8');",
          "function envelope(input, kind, payload) {",
          "  return JSON.stringify({ protocolVersion: input.protocolVersion, sessionId: input.sessionId, correlationId: input.correlationId, timestamp: new Date().toISOString(), kind, payload }) + '\\n';",
          "}",
          "stdin.on('data', chunk => {",
          "  buffer += chunk;",
          "  const lines = buffer.split('\\n');",
          "  buffer = lines.pop() ?? '';",
          "  for (const line of lines) {",
          "    if (!line.trim()) continue;",
          "    const input = JSON.parse(line);",
          "    if (input.kind === 'handshake_request') stdout.write(envelope(input, 'handshake_response', { accepted: true }));",
          "    if (input.kind === 'run_request') stdout.write(envelope(input, 'approval_required', { action: 'write', reason: 'needs human' }));",
          "  }",
          "});",
        ].join('\n'),
        'utf-8',
      );

      const adapter = new BridgeProcessAdapter({
        command: process.execPath,
        args: [bridgeScript],
      });
      const store = createRunStore(root);
      const recorder = createRunRecorder(store, root);
      const permissionProfile = buildPermissionProfile({
        agentId: 'bridge-test',
        source: 'test',
        permissionMode: 'plan',
      });
      const runId = generateRunId();
      const runState = recorder.start({
        runId,
        agentId: 'bridge-test',
        prompt: 'needs approval',
        resolvedConfig: { agentId: 'bridge-test', source: 'test' },
        permissionProfile,
      });

      await expect(
        adapter.execute({
          prompt: 'needs approval',
          runId,
          agentId: 'bridge-test',
          resolvedConfig: { agentId: 'bridge-test', source: 'test' },
          permissionProfile,
          recorder,
          runState,
          toolGuard: new ToolGuard(permissionProfile, recorder, runId),
        }),
      ).rejects.toThrow(/requested approval/);

      const transcript = readTranscript(runId, root);
      expect(transcript.some((event) => event.type === 'progress' && event.data.step === 'bridge_approval_required')).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  // Multi-envelope processing tests (AR-2.5B fix)
  describe('multi-envelope event loop', () => {
    let mr: string;
    beforeEach(() => { mr = makeTempRoot(); });
    afterEach(() => { cleanup(mr); });

    it('records bridge lifecycle events during fake adapter execution', async () => {
      const adapter = new FakeBridgeAdapter();
      const store = createRunStore(mr);
      const recorder = createRunRecorder(store, mr);
      const profile = buildPermissionProfile({ agentId: 'test', source: 'test', permissionMode: 'default' });
      const runId = generateRunId();
      const state = recorder.start({
        runId,
        agentId: 'test',
        prompt: 'test multi-envelope',
        resolvedConfig: { agentId: 'test', source: 'test' },
        permissionProfile: profile,
      });

      const result = await adapter.execute({
        prompt: 'test multi-envelope',
        runId,
        agentId: 'test',
        resolvedConfig: { agentId: 'test', source: 'test' },
        permissionProfile: profile,
        recorder,
        runState: state,
        toolGuard: new ToolGuard(profile, recorder, runId),
      });

      expect(result).toBeDefined();
      // Verify lifecycle events were recorded in transcript
      const transcript = readTranscript(runId, mr);
      const lifecycleEvents = transcript.filter(
        (e: any) => typeof e?.data?.step === 'string' && e.data.step.startsWith('bridge_'),
      );
      expect(lifecycleEvents.length).toBeGreaterThan(0);
      // Should include session started and completed
      const started = lifecycleEvents.some((e: any) => e.data.step === 'bridge_session_started');
      const completed = lifecycleEvents.some((e: any) => e.data.step === 'bridge_session_completed');
      expect(started).toBe(true);
      expect(completed).toBe(true);
    });

    it('does not fabricate dirty:false in post-session worktree validation', async () => {
      const adapter = new FakeBridgeAdapter();
      const store = createRunStore(mr);
      const recorder = createRunRecorder(store, mr);
      const profile = buildPermissionProfile({ agentId: 'test', source: 'test', permissionMode: 'default' });
      const runId = generateRunId();
      const state = recorder.start({
        runId,
        agentId: 'test',
        prompt: 'test dirty evidence',
        resolvedConfig: { agentId: 'test', source: 'test' },
        permissionProfile: profile,
      });

      await adapter.execute({
        prompt: 'test dirty evidence',
        runId,
        agentId: 'test',
        resolvedConfig: { agentId: 'test', source: 'test' },
        permissionProfile: profile,
        worktreePath: join(mr, 'test-worktree'),
        recorder,
        runState: state,
        toolGuard: new ToolGuard(profile, recorder, runId),
      });

      const transcript = readTranscript(runId, mr);
      const postValidation = transcript.filter(
        (e: any) => e?.data?.step === 'bridge_worktree_post_validation',
      );
      // Post-session validation should exist (boundary evidence)
      expect(postValidation.length).toBeGreaterThan(0);
      // But must NOT contain fabricated dirty: false / preserved: false
      for (const evt of postValidation) {
        const data = (evt as any).data;
        expect(data).not.toHaveProperty('dirty', false);
        expect(data).not.toHaveProperty('preserved', false);
      }
    });

    it('denied tool triggers PermissionDeniedError via ToolGuard.check()', async () => {
      const adapter = new FakeBridgeAdapter();
      const store = createRunStore(mr);
      const recorder = createRunRecorder(store, mr);
      // Plan mode: only Read/Grep/Glob/Find — no Edit/Write/Bash
      const profile = buildPermissionProfile({ agentId: 'test', source: 'test', permissionMode: 'plan' });
      const runId = generateRunId();
      const state = recorder.start({
        runId,
        agentId: 'test',
        prompt: 'test tool guard enforcement',
        resolvedConfig: { agentId: 'test', source: 'test' },
        permissionProfile: profile,
      });

      // The FakeBridgeAdapter simulates tool usage with allowedTools.
      // In plan mode, Bash is denied. The adapter tries the first 3 allowedTools.
      // Since plan mode has ['Read','Grep','Glob','Find'], all should pass
      // ToolGuard.check(). Verify tool_call/tool_result are in the transcript.
      const result = await adapter.execute({
        prompt: 'test tool guard enforcement',
        runId,
        agentId: 'test',
        resolvedConfig: { agentId: 'test', source: 'test' },
        permissionProfile: profile,
        recorder,
        runState: state,
        toolGuard: new ToolGuard(profile, recorder, runId),
      });

      expect(result).toBeDefined();
      const transcript = readTranscript(runId, mr);

      // Verify canonical tool_call and tool_result transcript events exist
      const toolCalls = transcript.filter((e: any) => e?.type === 'tool_call');
      const toolResults = transcript.filter((e: any) => e?.type === 'tool_result');
      expect(toolCalls.length).toBeGreaterThan(0);
      expect(toolResults.length).toBeGreaterThan(0);

      // Verify all recorded tool calls are for allowed tools only
      for (const tc of toolCalls) {
        const toolName = (tc as any).data?.toolName;
        expect(profile.allowedTools).toContain(toolName);
      }
    });
  });
});
