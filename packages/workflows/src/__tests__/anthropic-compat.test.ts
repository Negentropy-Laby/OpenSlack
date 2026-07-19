import { describe, it, expect, vi } from 'vitest';
import {
  createAnthropicCompatSandbox,
  createAnthropicCompatRunner,
  AnthropicCompatError,
} from '../anthropic-compat.js';
import { createRuntime } from '../runtime.js';
import type { RuntimeOptions } from '../runtime.js';
import type { AgentLauncher } from '../agent-shim.js';
import type { WorkflowMeta } from '../types.js';

const testManifest: WorkflowMeta = {
  name: 'test-compat-workflow',
  description: 'Test compat workflow',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Verify', detail: 'Verify phase' },
  ],
};

function makeRuntime(overrides: Partial<RuntimeOptions> = {}): ReturnType<typeof createRuntime> {
  return createRuntime({
    runId: 'compat-test-001',
    mode: 'execute',
    manifest: testManifest,
    ...overrides,
  });
}

describe('createAnthropicCompatSandbox', () => {
  describe('basic properties', () => {
    it('exposes frozen args', () => {
      const rt = makeRuntime();
      const sandbox = createAnthropicCompatSandbox(rt);
      expect(sandbox.args).toEqual({});
      // Verify frozen
      expect(Object.isFrozen(sandbox.args)).toBe(true);
    });

    it('exposes budget as read-only snapshot', () => {
      const rt = makeRuntime({ budget: { tokens: 5000, costUsd: 0.1 } });
      const sandbox = createAnthropicCompatSandbox(rt);
      expect(sandbox.budget.tokensRemaining).toBe(5000);
      expect(sandbox.budget.costUsd).toBe(0.1);
      expect(sandbox.budget.tokensUsed).toBe(0);
      expect(sandbox.budget.agentCalls).toBe(0);
    });
  });

  describe('phase and log', () => {
    it('delegates phase calls to runtime', () => {
      const rt = makeRuntime();
      const sandbox = createAnthropicCompatSandbox(rt);
      expect(() => sandbox.phase('Scan')).not.toThrow();
    });

    it('delegates log calls to runtime', () => {
      const rt = makeRuntime();
      const sandbox = createAnthropicCompatSandbox(rt);
      expect(() => sandbox.log('test message')).not.toThrow();
    });

    it('throws for invalid phase', () => {
      const rt = makeRuntime();
      const sandbox = createAnthropicCompatSandbox(rt);
      expect(() => sandbox.phase('Invalid')).toThrow('Unknown phase');
    });
  });

  describe('agent', () => {
    it('delegates agent calls to runtime', async () => {
      const launcher: AgentLauncher = vi.fn(async () => ({ data: { ok: true }, tokenUsage: 5 }));
      const rt = makeRuntime({ agentLauncher: launcher });
      const sandbox = createAnthropicCompatSandbox(rt);
      rt.phase('Scan');
      const result = await sandbox.agent('test prompt', { label: 'test', phase: 'Scan' });
      expect(result).toEqual({ ok: true });
    });

    it('fails closed when no custom launcher or execution provider is configured', async () => {
      const rt = makeRuntime();
      const sandbox = createAnthropicCompatSandbox(rt);
      await expect(sandbox.agent('prompt', { label: 'test', phase: 'Scan' })).rejects.toMatchObject(
        {
          code: 'RUNTIME_NOT_CONFIGURED',
        },
      );
    });
  });

  describe('parallel', () => {
    it('delegates parallel calls to runtime', async () => {
      const rt = makeRuntime();
      const sandbox = createAnthropicCompatSandbox(rt);
      const result = await sandbox.parallel([async () => 'a', async () => 'b']);
      expect(result).toEqual(['a', 'b']);
    });
  });

  describe('pipeline', () => {
    it('delegates pipeline calls to runtime', async () => {
      const rt = makeRuntime();
      const sandbox = createAnthropicCompatSandbox(rt);
      const result = await sandbox.pipeline([1, 2], async (x: number, _idx: number) => x * 2);
      expect(result).toEqual([2, 4]);
    });
  });

  describe('workflow', () => {
    it('blocks workflow calls in preview mode', async () => {
      const rt = makeRuntime({ mode: 'preview' });
      const sandbox = createAnthropicCompatSandbox(rt);
      await expect(sandbox.workflow('child')).rejects.toThrow(AnthropicCompatError);
      await expect(sandbox.workflow('child')).rejects.toThrow('forbidden in preview mode');
    });

    it('allows workflow calls in execute mode', async () => {
      const onCall = vi.fn(async () => ({ done: true }));
      const rt = makeRuntime({ mode: 'execute', onWorkflowCall: onCall });
      const sandbox = createAnthropicCompatSandbox(rt);
      const result = await sandbox.workflow('child-workflow');
      expect(result).toEqual({ done: true });
    });

    it('allows workflow calls in dry-run mode', async () => {
      const onCall = vi.fn(async () => ({ status: 'dry' }));
      const rt = makeRuntime({ mode: 'dry-run', onWorkflowCall: onCall });
      const sandbox = createAnthropicCompatSandbox(rt);
      const result = await sandbox.workflow('child-workflow');
      expect(result).toEqual({ status: 'dry' });
    });
  });
});

describe('createAnthropicCompatRunner', () => {
  describe('preview', () => {
    it('returns default preview result for meta-only modules', async () => {
      const rt = makeRuntime({ mode: 'preview' });
      const runner = createAnthropicCompatRunner(rt, {});
      const result = await runner.preview({});
      expect(result.preview).toBe(true);
      expect(result.mode).toBe('preview');
      expect(result.runId).toBe('compat-test-001');
    });

    it('delegates to module preview function when available', async () => {
      const rt = makeRuntime({ mode: 'preview' });
      const customPreview = vi.fn(async () => ({
        preview: true as const,
        findings: ['finding-1', 'finding-2'],
      }));
      const runner = createAnthropicCompatRunner(rt, { preview: customPreview });
      const result = await runner.preview({ key: 'value' });
      expect(result.findings).toEqual(['finding-1', 'finding-2']);
      expect(customPreview).toHaveBeenCalledWith(rt, { key: 'value' });
    });
  });

  describe('run', () => {
    it('throws AnthropicCompatError when no run function', async () => {
      const rt = makeRuntime({ mode: 'execute' });
      const runner = createAnthropicCompatRunner(rt, {});
      await expect(runner.run({})).rejects.toThrow(AnthropicCompatError);
      await expect(runner.run({})).rejects.toThrow('no "run" export');
    });

    it('delegates to module run function when available', async () => {
      const rt = makeRuntime({ mode: 'execute' });
      const customRun = vi.fn(async () => ({ status: 'complete' }));
      const runner = createAnthropicCompatRunner(rt, { run: customRun });
      const result = await runner.run({ key: 'value' });
      expect(result.status).toBe('complete');
      expect(customRun).toHaveBeenCalledWith(rt, { key: 'value' });
    });
  });
});

describe('AnthropicCompatError', () => {
  it('has correct name and properties', () => {
    const err = new AnthropicCompatError('test-op', 'test reason');
    expect(err.name).toBe('AnthropicCompatError');
    expect(err.operation).toBe('test-op');
    expect(err.message).toContain('test-op');
    expect(err.message).toContain('test reason');
  });

  it('is an instance of Error', () => {
    const err = new AnthropicCompatError('op', 'reason');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AnthropicCompatError);
  });
});
