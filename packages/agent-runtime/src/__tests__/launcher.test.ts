import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpenSlackAgentLauncher, createRunStore, FakeBridgeAdapter, BridgeFactory } from '../index.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-launcher-test-'));
}

function cleanup(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('createOpenSlackAgentLauncher', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('does not throw "No agent launcher configured"', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    const result = await launcher('review this code', {
      label: 'reviewer',
      phase: 'review',
    });

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
  });

  it('creates a run record', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    await launcher('research something', {
      label: 'researcher',
      phase: 'research',
      agentType: 'research-agent',
      resolvedAgentConfig: {
        agentId: 'research-agent',
        source: 'claude-project',
        model: 'sonnet',
        permissionMode: 'plan',
      },
    });

    const runs = store.listRuns();
    expect(runs.length).toBe(1);
    expect(runs[0].agentId).toBe('research-agent');
    expect(runs[0].status).toBe('completed');
    expect(runs[0].model).toBe('sonnet');
  });

  it('writes transcript events', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    await launcher('plan this feature', {
      label: 'planner',
      phase: 'plan',
      resolvedAgentConfig: {
        agentId: 'planner',
        source: 'claude-project',
        permissionMode: 'plan',
      },
    });

    const run = store.listRuns()[0];
    const { readTranscript } = await import('../transcript.js');
    const transcript = readTranscript(run.runId, root);

    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript[0].type).toBe('start');
    expect(transcript.some((e) => e.type === 'complete')).toBe(true);
  });

  it('respects permission mode in profile', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    await launcher('do something', {
      label: 'worker',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'worker',
        source: 'claude-project',
        permissionMode: 'plan',
        tools: ['Read', 'Grep'],
      },
    });

    const run = store.listRuns()[0];
    const { readTranscript } = await import('../transcript.js');
    const transcript = readTranscript(run.runId, root);
    const startEvent = transcript.find((e) => e.type === 'start');

    expect(startEvent).toBeDefined();
    expect(startEvent!.data.permissionMode).toBe('plan');
    expect(startEvent!.data.allowedTools).toContain('Read');
    expect(startEvent!.data.allowedTools).not.toContain('Bash');
  });

  it('returns different result shapes based on prompt', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    const reviewResult = await launcher('review PR #42', {
      label: 'reviewer',
      phase: 'review',
    });
    expect((reviewResult.data as any).review).toBeDefined();

    const researchResult = await launcher('research this topic', {
      label: 'researcher',
      phase: 'research',
    });
    expect((researchResult.data as any).summary).toBeDefined();

    const planResult = await launcher('plan this feature', {
      label: 'planner',
      phase: 'plan',
    });
    expect((planResult.data as any).plan).toBeDefined();
  });

  it('uses per-run bridgeMode from resolvedConfig to select bridge adapter', async () => {
    const store = createRunStore(root);
    // Create launcher with NO global bridgeMode — defaults to local adapter
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    // Run with per-run bridgeMode='fake' — should use FakeBridgeAdapter
    const result = await launcher('review this code', {
      label: 'bridge-test',
      phase: 'review',
      resolvedAgentConfig: {
        agentId: 'bridge-test',
        source: 'openslack-registry',
        bridgeMode: 'fake',
      },
    });

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();

    // Verify bridge_lifecycle_complete event is present (proves bridge adapter was used)
    const run = store.listRuns()[0];
    const { readTranscript } = await import('../transcript.js');
    const transcript = readTranscript(run.runId, root);

    const lifecycleEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'bridge_lifecycle_complete',
    );
    expect(lifecycleEvent).toBeDefined();
    expect((lifecycleEvent!.data as Record<string, unknown>).status).toBe('completed');
  });

  it('does not emit bridge_lifecycle_complete for local adapter runs', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    // No bridgeMode — uses default LocalExecutionAdapter
    await launcher('review this code', {
      label: 'local-test',
      phase: 'review',
      resolvedAgentConfig: {
        agentId: 'local-test',
        source: 'test',
      },
    });

    const run = store.listRuns()[0];
    const { readTranscript } = await import('../transcript.js');
    const transcript = readTranscript(run.runId, root);

    const lifecycleEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'bridge_lifecycle_complete',
    );
    expect(lifecycleEvent).toBeUndefined();
  });

  it('uses the runtime resolver for per-run process bridge agents', async () => {
    const store = createRunStore(root);
    const bridgeScript = join(root, 'fake-bridge.mjs');
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
        "    if (input.kind === 'run_request') stdout.write(envelope(input, 'complete', { data: { ok: true, payload: input.payload, env: { prompt: process.env.OPENSLACK_AGENT_PROMPT ?? null, anthropicKey: process.env.ANTHROPIC_API_KEY ?? null, runner: process.env.AGENT_RUN_BRIDGE_RUNNER ?? null, safeTrace: process.env.AGENT_RUN_SAFE_TRACE ?? null, oldRunId: process.env.OPENSLACK_RUN_ID ?? null, oldAgentId: process.env.OPENSLACK_AGENT_ID ?? null, runId: process.env.AGENT_RUN_ID ?? null, agentId: process.env.AGENT_ID ?? null } }, tokenUsage: 7 }));",
        "  }",
        "});",
      ].join('\n'),
      'utf-8',
    );

    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      availableMcpServers: ['github'],
      bridgeRuntimeResolver: {
        resolve: () => ({
          command: process.execPath,
          args: [bridgeScript],
          env: {
            ANTHROPIC_API_KEY: 'must-not-leak',
            AGENT_RUN_BRIDGE_RUNNER: 'fake',
            AGENT_RUN_SAFE_TRACE: '1',
          },
        }),
      },
    });

    const result = await launcher('hello bridge', {
      label: 'aby',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'aby',
        source: 'test',
        runtime: 'aby_assistant',
        bridgeMode: 'process',
        permissionMode: 'plan',
        model: 'sonnet',
        effort: 'high',
        maxTurns: 4,
        requiredMcpServers: ['github'],
      },
    });

    expect((result.data as any).ok).toBe(true);
    expect((result.data as any).payload.input).toEqual([{ role: 'user', content: 'hello bridge' }]);
    expect((result.data as any).payload.runId).toBe(result.runId);
    expect((result.data as any).payload.agentId).toBe('aby');
    expect((result.data as any).payload.model).toBe('sonnet');
    expect((result.data as any).payload.effort).toBe('high');
    expect((result.data as any).payload.maxTurns).toBe(4);
    expect((result.data as any).payload.allowedTools).toContain('Read');
    expect((result.data as any).payload.permissionMode).toBe('plan');
    expect((result.data as any).payload.mcp).toEqual({ required: ['github'], available: ['github'] });
    expect((result.data as any).payload.metadata.integrationId).toBe('openslack');
    expect((result.data as any).payload.metadata.resolvedConfig.model).toBe('sonnet');
    expect((result.data as any).env).toMatchObject({
      prompt: null,
      anthropicKey: null,
      runner: 'fake',
      safeTrace: '1',
      oldRunId: null,
      oldAgentId: null,
      runId: result.runId,
      agentId: 'aby',
    });
    expect(result.tokenUsage).toBe(7);
  });
});
