import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createOpenSlackAgentLauncher,
  createRunStore,
  LocalExecutionAdapter,
} from '../index.js';
import type {
  AgentExecutionAdapter,
  AdapterExecutionContext,
  AdapterExecutionResult,
} from '../index.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'adapter-test-'));
}

function cleanup(root: string) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('LocalExecutionAdapter', () => {
  it('has adapterId "local"', () => {
    const adapter = new LocalExecutionAdapter();
    expect(adapter.adapterId).toBe('local');
  });

  it('implements AgentExecutionAdapter interface', () => {
    const adapter: AgentExecutionAdapter = new LocalExecutionAdapter();
    expect(typeof adapter.execute).toBe('function');
    expect(adapter.adapterId).toBe('local');
  });
});

describe('Custom adapter injection', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('uses injected adapter instead of default local adapter', async () => {
    const customAdapter: AgentExecutionAdapter = {
      adapterId: 'test-custom',
      async execute<T>(_context: AdapterExecutionContext): Promise<AdapterExecutionResult<T>> {
        return {
          data: { custom: true, message: 'from custom adapter' } as T,
          tokenUsage: 42,
        };
      },
    };

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: customAdapter,
    });

    const result = await launcher('do something', {
      label: 'worker',
      phase: 'execute',
    });

    expect((result.data as Record<string, unknown>).custom).toBe(true);
    expect((result.data as Record<string, unknown>).message).toBe('from custom adapter');
    expect(result.tokenUsage).toBe(42);

    // Run should complete successfully
    const runs = store.listRuns();
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('completed');
  });

  it('passes resolvedConfig to custom adapter', async () => {
    let capturedAgentId: string | undefined;
    let capturedModel: string | undefined;

    const capturingAdapter: AgentExecutionAdapter = {
      adapterId: 'test-capture',
      async execute<T>(context: AdapterExecutionContext): Promise<AdapterExecutionResult<T>> {
        capturedAgentId = context.agentId;
        capturedModel = context.resolvedConfig.model;
        return { data: { ok: true } as T };
      },
    };

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: capturingAdapter,
    });

    await launcher('test prompt', {
      label: 'test-agent',
      phase: 'test',
      resolvedAgentConfig: {
        agentId: 'test-agent',
        source: 'test',
        model: 'custom-model',
      },
    });

    expect(capturedAgentId).toBe('test-agent');
    expect(capturedModel).toBe('custom-model');
  });

  it('passes permissionProfile to custom adapter', async () => {
    let capturedAllowedTools: string[] | undefined;
    let capturedMode: string | undefined;

    const capturingAdapter: AgentExecutionAdapter = {
      adapterId: 'test-capture',
      async execute<T>(context: AdapterExecutionContext): Promise<AdapterExecutionResult<T>> {
        capturedAllowedTools = context.permissionProfile.allowedTools;
        capturedMode = context.permissionProfile.permissionMode;
        return { data: { ok: true } as T };
      },
    };

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: capturingAdapter,
    });

    await launcher('test prompt', {
      label: 'reader',
      phase: 'read',
      resolvedAgentConfig: {
        agentId: 'reader',
        source: 'test',
        permissionMode: 'plan',
        tools: ['Read', 'Grep'],
      },
    });

    expect(capturedAllowedTools).toContain('Read');
    expect(capturedAllowedTools).toContain('Grep');
    expect(capturedAllowedTools).not.toContain('Bash');
    expect(capturedMode).toBe('plan');
  });

  it('records run as failed when adapter throws', async () => {
    const failingAdapter: AgentExecutionAdapter = {
      adapterId: 'test-fail',
      async execute<T>(_context: AdapterExecutionContext): Promise<AdapterExecutionResult<T>> {
        throw new Error('adapter execution failed');
      },
    };

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: failingAdapter,
    });

    await expect(
      launcher('do something', {
        label: 'worker',
        phase: 'execute',
      }),
    ).rejects.toThrow('adapter execution failed');

    const runs = store.listRuns();
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toBe('Agent execution failed. Inspect runtime diagnostics for details.');
  });

  it('custom adapter can use recorder for transcript events', async () => {
    const recordingAdapter: AgentExecutionAdapter = {
      adapterId: 'test-recording',
      async execute<T>(context: AdapterExecutionContext): Promise<AdapterExecutionResult<T>> {
        context.recorder.progress(context.runId, { step: 'custom_step', detail: 'hello' });
        context.recorder.toolCall(context.runId, 'CustomTool', { arg: 'value' });
        context.recorder.toolResult(context.runId, 'CustomTool', { result: 'ok' });
        return { data: { done: true } as T };
      },
    };

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: recordingAdapter,
    });

    await launcher('test prompt', {
      label: 'worker',
      phase: 'execute',
    });

    const run = store.listRuns()[0];
    const { readTranscript } = await import('../transcript.js');
    const transcript = readTranscript(run.runId, root);

    // Should have: start, progress(custom_step), tool_call, tool_result, complete
    const progressEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'custom_step',
    );
    expect(progressEvent).toBeDefined();

    const toolCallEvent = transcript.find(
      (e) => e.type === 'tool_call' && (e.data as Record<string, unknown>).toolName === 'CustomTool',
    );
    expect(toolCallEvent).toBeDefined();
  });
});
