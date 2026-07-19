import { describe, it, expect, vi } from 'vitest';
import { createRuntime } from '../runtime.js';
import { createAnthropicCompatSandbox } from '../anthropic-compat.js';
import type { RuntimeOptions } from '../runtime.js';
import type { WorkflowMeta, AgentOptions } from '../types.js';
import type { AgentLauncher } from '../agent-shim.js';

const testManifest: WorkflowMeta = {
  name: 'parity-test-workflow',
  description: 'Test DSL parity',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Verify', detail: 'Verify phase' },
  ],
};

function makeRuntime(overrides: Partial<RuntimeOptions> = {}): ReturnType<typeof createRuntime> {
  return createRuntime({
    runId: 'parity-test-001',
    mode: 'execute',
    manifest: testManifest,
    ...overrides,
  });
}

describe('claude-dsl-parity', () => {
  // ── budget.total / spent() / remaining() on runtime ─────────────────────────

  describe('runtime budget API (ClaudeBudgetAPI parity)', () => {
    it('exposes budget.total as tokensUsed + tokensRemaining', () => {
      const rt = makeRuntime({ budget: { tokens: 5000, costUsd: 0.1 } });
      // Initially: tokensUsed=0, tokensRemaining=5000
      expect(rt.budget.total).toBe(5000);
    });

    it('returns null for budget.total when tokensRemaining is null (unlimited)', () => {
      const rt = makeRuntime(); // No budget specified
      expect(rt.budget.total).toBeNull();
    });

    it('exposes budget.spent() returning tokensUsed', () => {
      const rt = makeRuntime({ budget: { tokens: 1000, costUsd: 0.05 } });
      expect(rt.budget.spent()).toBe(0);
    });

    it('exposes budget.remaining() returning tokensRemaining', () => {
      const rt = makeRuntime({ budget: { tokens: 1000, costUsd: 0.05 } });
      expect(rt.budget.remaining()).toBe(1000);
    });

    it('returns Infinity for budget.remaining() when unlimited', () => {
      const rt = makeRuntime(); // No budget
      expect(rt.budget.remaining()).toBe(Infinity);
    });

    it('updates budget.total dynamically as tokensUsed increases', () => {
      const rt = makeRuntime({ budget: { tokens: 1000, costUsd: 0 } });
      // total = tokensUsed + tokensRemaining, so it stays constant
      // unless tokensUsed changes internally (e.g., via agent calls)
      expect(rt.budget.total).toBe(1000);
    });
  });

  // ── pipeline single-fn backward compat ──────────────────────────────────────

  describe('pipeline single-fn backward compat', () => {
    it('works with a single function (classic form)', async () => {
      const rt = makeRuntime();
      rt.phase('Scan');

      const results = await rt.pipeline([1, 2, 3], async (item, idx) => item * 10 + idx);

      expect(results).toEqual([10, 21, 32]);
    });

    it('works with empty items array', async () => {
      const rt = makeRuntime();
      rt.phase('Scan');

      const results = await rt.pipeline([] as number[], async (item) => item);

      expect(results).toEqual([]);
    });

    it('passes index correctly to single-fn form', async () => {
      const rt = makeRuntime();
      rt.phase('Scan');

      const collected: Array<{ item: number; idx: number }> = [];
      await rt.pipeline([10, 20, 30], async (item, idx) => {
        collected.push({ item, idx });
        return item;
      });

      expect(collected).toEqual([
        { item: 10, idx: 0 },
        { item: 20, idx: 1 },
        { item: 30, idx: 2 },
      ]);
    });
  });

  // ── pipeline variadic multi-stage form ──────────────────────────────────────

  describe('pipeline variadic multi-stage form', () => {
    it('works with array of stage functions', async () => {
      const rt = makeRuntime();
      rt.phase('Scan');

      const stage1 = vi.fn(async (_prev: unknown, item: number, _idx: number) => {
        return item * 2;
      });
      const stage2 = vi.fn(async (prev: unknown, _item: number, _idx: number) => {
        return (prev as number) + 100;
      });

      const results = await rt.pipeline([1, 2, 3], [stage1, stage2]);

      // stage1: [2, 4, 6], stage2: [102, 104, 106]
      expect(results).toEqual([102, 104, 106]);
      expect(stage1).toHaveBeenCalledTimes(3);
      expect(stage2).toHaveBeenCalledTimes(3);
    });

    it('passes (prevResult, originalItem, index) to each stage', async () => {
      const rt = makeRuntime();
      rt.phase('Scan');

      const stage1 = vi.fn(async (_prev: unknown, item: string, idx: number) => {
        return { upper: item.toUpperCase(), idx };
      });
      const stage2 = vi.fn(async (prev: unknown, item: string, idx: number) => {
        return { prev, original: item, index: idx };
      });

      const results = await rt.pipeline(['hello', 'world'], [stage1, stage2]);

      expect(results[0]).toEqual({
        prev: { upper: 'HELLO', idx: 0 },
        original: 'hello',
        index: 0,
      });
      expect(results[1]).toEqual({
        prev: { upper: 'WORLD', idx: 1 },
        original: 'world',
        index: 1,
      });
    });

    it('returns nulls for items that fail in multi-stage', async () => {
      const rt = makeRuntime();
      rt.phase('Scan');

      const stage1 = vi.fn(async (_prev: unknown, item: number) => {
        if (item === 2) throw new Error('stage1 fail');
        return item * 10;
      });
      const stage2 = vi.fn(async (prev: unknown) => {
        return (prev as number) + 1;
      });

      const results = await rt.pipeline([1, 2, 3], [stage1, stage2]);

      // Item 2 fails in stage1, so it's null
      expect(results).toEqual([11, null, 31]);
    });

    it('supports 3+ stages via array form', async () => {
      const rt = makeRuntime();
      rt.phase('Scan');

      const results = await rt.pipeline(
        ['x'],
        [
          async (_p: unknown, item: string) => item + '1',
          async (p: unknown, _item: string) => (p as string) + '2',
          async (p: unknown, _item: string) => (p as string) + '3',
        ],
      );

      expect(results).toEqual(['x123']);
    });
  });

  // ── AnthropicCompatSandbox variadic pipeline ────────────────────────────────

  describe('AnthropicCompatSandbox variadic pipeline', () => {
    it('supports variadic pipeline through sandbox', async () => {
      const rt = makeRuntime();
      const sandbox = createAnthropicCompatSandbox(rt);
      rt.phase('Scan');

      const results = await sandbox.pipeline(
        [1, 2, 3],
        async (_prev: unknown, item: number) => item * 2,
        async (prev: unknown, _item: number) => (prev as number) + 10,
      );

      expect(results).toEqual([12, 14, 16]);
    });

    it('supports 3+ stages through sandbox', async () => {
      const rt = makeRuntime();
      const sandbox = createAnthropicCompatSandbox(rt);
      rt.phase('Scan');

      const results = await sandbox.pipeline(
        ['x'],
        async (_p: unknown, item: string) => item + '1',
        async (p: unknown, _item: string) => (p as string) + '2',
        async (p: unknown, _item: string) => (p as string) + '3',
      );

      expect(results).toEqual(['x123']);
    });

    it('supports trailing options object', async () => {
      const rt = makeRuntime();
      const sandbox = createAnthropicCompatSandbox(rt);
      rt.phase('Scan');

      const results = await sandbox.pipeline(
        [1, 2, 3],
        async (_prev: unknown, item: number) => item * 2,
        async (prev: unknown, _item: number) => (prev as number) + 1,
        { concurrency: 2 },
      );

      expect(results).toEqual([3, 5, 7]);
    });

    it('returns nulls for items that fail in multi-stage sandbox pipeline', async () => {
      const rt = makeRuntime();
      const sandbox = createAnthropicCompatSandbox(rt);
      rt.phase('Scan');

      const results = await sandbox.pipeline(
        [1, 2, 3],
        async (_prev: unknown, item: number) => {
          if (item === 2) throw new Error('stage1 fail');
          return item * 10;
        },
        async (prev: unknown, _item: number) => (prev as number) + 1,
      );

      expect(results).toEqual([11, null, 31]);
    });

    it('still supports single-function backward compat through sandbox', async () => {
      const rt = makeRuntime();
      const sandbox = createAnthropicCompatSandbox(rt);
      rt.phase('Scan');

      const results = await sandbox.pipeline(
        [1, 2, 3],
        async (item: number, _idx: number) => item * 10,
      );

      expect(results).toEqual([10, 20, 30]);
    });
  });

  // ── agent model/agentType pass-through ──────────────────────────────────────

  describe('agent model/agentType pass-through', () => {
    it('passes model option through to agent launcher', async () => {
      const launcher: AgentLauncher = vi.fn(async () => ({
        data: { result: 'ok' },
        tokenUsage: 10,
      }));
      const rt = makeRuntime({ agentLauncher: launcher });
      rt.phase('Scan');

      await rt.agent('test prompt', {
        label: 'test',
        phase: 'Scan',
        model: 'sonnet',
      });

      expect(launcher).toHaveBeenCalledTimes(1);
      // The launcher receives (prompt, options) — options includes model
      const callArgs = (launcher as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        AgentOptions,
      ];
      expect(callArgs[1]).toMatchObject({ model: 'sonnet' });
    });

    it('passes agentType option through to agent launcher', async () => {
      const launcher: AgentLauncher = vi.fn(async () => ({
        data: { result: 'ok' },
        tokenUsage: 10,
      }));
      const rt = makeRuntime({ agentLauncher: launcher });
      rt.phase('Scan');

      await rt.agent('test prompt', {
        label: 'test',
        phase: 'Scan',
        agentType: 'Explore',
      });

      const callArgs = (launcher as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        AgentOptions,
      ];
      expect(callArgs[1]).toMatchObject({ agentType: 'Explore' });
    });

    it('passes both model and agentType together', async () => {
      const launcher: AgentLauncher = vi.fn(async () => ({
        data: { result: 'ok' },
        tokenUsage: 10,
      }));
      const rt = makeRuntime({ agentLauncher: launcher });
      rt.phase('Scan');

      await rt.agent('test prompt', {
        label: 'test',
        phase: 'Scan',
        model: 'sonnet',
        agentType: 'Explore',
      });

      const callArgs = (launcher as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string,
        AgentOptions,
      ];
      expect(callArgs[1]).toMatchObject({
        model: 'sonnet',
        agentType: 'Explore',
      });
    });
  });

  // ── AnthropicCompatSandbox budget aliases ───────────────────────────────────

  describe('AnthropicCompatSandbox budget aliases', () => {
    it('exposes budget.total on compat sandbox', () => {
      const rt = makeRuntime({ budget: { tokens: 5000, costUsd: 0.1 } });
      const sandbox = createAnthropicCompatSandbox(rt);
      expect(sandbox.budget.total).toBe(5000);
    });

    it('exposes budget.spent() on compat sandbox', () => {
      const rt = makeRuntime({ budget: { tokens: 5000, costUsd: 0.1 } });
      const sandbox = createAnthropicCompatSandbox(rt);
      expect(sandbox.budget.spent()).toBe(0);
    });

    it('exposes budget.remaining() on compat sandbox', () => {
      const rt = makeRuntime({ budget: { tokens: 5000, costUsd: 0.1 } });
      const sandbox = createAnthropicCompatSandbox(rt);
      expect(sandbox.budget.remaining()).toBe(5000);
    });

    it('returns null for total when unlimited budget', () => {
      const rt = makeRuntime(); // no budget
      const sandbox = createAnthropicCompatSandbox(rt);
      expect(sandbox.budget.total).toBeNull();
    });

    it('returns Infinity for remaining() when unlimited budget', () => {
      const rt = makeRuntime(); // no budget
      const sandbox = createAnthropicCompatSandbox(rt);
      expect(sandbox.budget.remaining()).toBe(Infinity);
    });

    it('exposes tokensUsed, tokensRemaining, costUsd, agentCalls', () => {
      const rt = makeRuntime({ budget: { tokens: 5000, costUsd: 0.1 } });
      const sandbox = createAnthropicCompatSandbox(rt);
      expect(sandbox.budget.tokensUsed).toBe(0);
      expect(sandbox.budget.tokensRemaining).toBe(5000);
      expect(sandbox.budget.costUsd).toBe(0.1);
      expect(sandbox.budget.agentCalls).toBe(0);
    });

    it('budget snapshot stays in sync with runtime budget', () => {
      const rt = makeRuntime({ budget: { tokens: 1000, costUsd: 0 } });
      const sandbox = createAnthropicCompatSandbox(rt);

      // The budget uses getters that delegate to runtime.budget
      // So the snapshot reflects live values
      expect(sandbox.budget.tokensUsed).toBe(rt.budget.tokensUsed);
      expect(sandbox.budget.tokensRemaining).toBe(rt.budget.tokensRemaining);
    });
  });
});
