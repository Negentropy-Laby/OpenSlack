import { describe, it, expect, vi } from 'vitest';
import { runParallel } from '../parallel-runner.js';
import type { BudgetState } from '../types.js';

describe('runParallel', () => {
  it('returns empty array for empty tasks', async () => {
    const result = await runParallel([], undefined);
    expect(result).toEqual([]);
  });

  it('executes single task and returns result', async () => {
    const result = await runParallel([async () => 42], undefined);
    expect(result).toEqual([42]);
  });

  it('executes multiple tasks and returns results in order', async () => {
    const tasks = [async () => 'a', async () => 'b', async () => 'c'];
    const result = await runParallel(tasks, undefined);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('respects concurrency limit', async () => {
    const order: number[] = [];
    const tasks = [
      async () => {
        order.push(0);
        await delay(10);
        return 'a';
      },
      async () => {
        order.push(1);
        await delay(10);
        return 'b';
      },
      async () => {
        order.push(2);
        await delay(10);
        return 'c';
      },
      async () => {
        order.push(3);
        await delay(10);
        return 'd';
      },
    ];
    const result = await runParallel(tasks, { concurrency: 2 });
    expect(result).toEqual(['a', 'b', 'c', 'd']);
  });

  it('defaults concurrency to Infinity when not specified', async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => async () => i);
    const result = await runParallel(tasks, undefined);
    expect(result).toHaveLength(20);
  });

  it('propagates first task error', async () => {
    const tasks = [
      async () => {
        throw new Error('task failed');
      },
      async () => 'ok',
    ];
    await expect(runParallel(tasks, undefined)).rejects.toThrow('task failed');
  });

  it('throws when budget is exhausted', async () => {
    const budget: BudgetState = {
      tokensUsed: 1000,
      tokensRemaining: 0,
      costUsd: 0,
      agentCalls: 0,
    };
    await expect(runParallel([async () => 1], undefined, budget)).rejects.toThrow(
      'Budget exhausted',
    );
  });

  it('does not throw when budget is unlimited', async () => {
    const budget: BudgetState = {
      tokensUsed: 0,
      tokensRemaining: null,
      costUsd: 0,
      agentCalls: 0,
    };
    const result = await runParallel([async () => 1], undefined, budget);
    expect(result).toEqual([1]);
  });

  it('handles concurrency of 1 (sequential)', async () => {
    const order: string[] = [];
    const tasks = [
      async () => {
        order.push('a');
        return 'a';
      },
      async () => {
        order.push('b');
        return 'b';
      },
      async () => {
        order.push('c');
        return 'c';
      },
    ];
    const result = await runParallel(tasks, { concurrency: 1 });
    expect(result).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('preserves result order regardless of completion order', async () => {
    const tasks = [
      async () => {
        await delay(30);
        return 'slow';
      },
      async () => {
        await delay(5);
        return 'fast';
      },
      async () => {
        await delay(15);
        return 'medium';
      },
    ];
    const result = await runParallel(tasks, undefined);
    expect(result).toEqual(['slow', 'fast', 'medium']);
  });

  it('works with concurrency equal to task count', async () => {
    const tasks = [async () => 1, async () => 2, async () => 3];
    const result = await runParallel(tasks, { concurrency: 3 });
    expect(result).toEqual([1, 2, 3]);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
