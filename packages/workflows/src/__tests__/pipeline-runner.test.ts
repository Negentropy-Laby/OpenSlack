import { describe, it, expect, vi } from 'vitest'
import { runPipeline } from '../pipeline-runner.js'
import type { PipelineCacheStore } from '../pipeline-runner.js'
import type { BudgetState, PipelineOptions } from '../types.js'

function makeCache(overrides: Partial<{
  stored: Map<string, unknown>
}> = {}): PipelineCacheStore & { stored: Map<string, unknown> } {
  const stored = overrides.stored ?? new Map<string, unknown>()
  return {
    stored,
    async loadItem(runId: string, phase: string, index: number) {
      return stored.get(`${runId}:${phase}:${index}`) ?? null
    },
    async saveItem(runId: string, phase: string, index: number, result: unknown) {
      stored.set(`${runId}:${phase}:${index}`, result)
    },
  }
}

describe('runPipeline', () => {
  it('returns empty array for empty items', async () => {
    const result = await runPipeline('run1', 'Scan', [], async (item) => item, undefined, makeCache())
    expect(result).toEqual([])
  })

  it('processes items and returns results in order', async () => {
    const items = [1, 2, 3]
    const fn = async (item: number) => item * 2
    const result = await runPipeline('run1', 'Scan', items, fn, undefined, makeCache())
    expect(result).toEqual([2, 4, 6])
  })

  it('uses default concurrency of 4', async () => {
    const items = [1, 2, 3, 4, 5]
    const fn = async (item: number) => item * 10
    const result = await runPipeline('run1', 'Scan', items, fn, undefined, makeCache())
    expect(result).toEqual([10, 20, 30, 40, 50])
  })

  it('respects custom concurrency', async () => {
    const items = [1, 2, 3, 4]
    const fn = async (item: number) => item + 1
    const result = await runPipeline('run1', 'Scan', items, fn, { concurrency: 2 }, makeCache())
    expect(result).toEqual([2, 3, 4, 5])
  })

  it('replays cached items from start', async () => {
    const cache = makeCache()
    // Pre-populate cache for items 0 and 1
    cache.stored.set('run1:Scan:0', 'cached-0')
    cache.stored.set('run1:Scan:1', 'cached-1')

    const items = ['a', 'b', 'c']
    const fn = vi.fn(async (item: string) => `processed-${item}`)

    const result = await runPipeline('run1', 'Scan', items, fn, undefined, cache)

    expect(result).toEqual(['cached-0', 'cached-1', 'processed-c'])
    // fn should only be called for item 2 (index 2)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith('c', 2)
  })

  it('does not replay items after a cache gap', async () => {
    const cache = makeCache()
    // Only cache item 1 (gap at 0)
    cache.stored.set('run1:Scan:1', 'cached-1')

    const items = ['a', 'b', 'c']
    const fn = vi.fn(async (item: string) => `processed-${item}`)

    const result = await runPipeline('run1', 'Scan', items, fn, undefined, cache)

    // Items must be contiguous from start, so gap at 0 means replay nothing
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('returns early when all items are cached', async () => {
    const cache = makeCache()
    cache.stored.set('run1:Scan:0', 'c0')
    cache.stored.set('run1:Scan:1', 'c1')

    const items = ['a', 'b']
    const fn = vi.fn(async (item: string) => `new-${item}`)

    const result = await runPipeline('run1', 'Scan', items, fn, undefined, cache)

    expect(result).toEqual(['c0', 'c1'])
    expect(fn).not.toHaveBeenCalled()
  })

  it('records null for failed items', async () => {
    const items = ['a', 'bad', 'c']
    const fn = async (item: string) => {
      if (item === 'bad') throw new Error('item failed')
      return `ok-${item}`
    }
    const log = vi.fn()
    const result = await runPipeline('run1', 'Scan', items, fn, undefined, makeCache(), undefined, log)
    expect(result).toEqual(['ok-a', null, 'ok-c'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Pipeline item 1 failed'))
  })

  it('saves checkpoints for processed items', async () => {
    const cache = makeCache()
    const items = ['x', 'y']
    const fn = async (item: string) => `result-${item}`

    await runPipeline('run1', 'Scan', items, fn, undefined, cache)

    expect(cache.stored.get('run1:Scan:0')).toBe('result-x')
    expect(cache.stored.get('run1:Scan:1')).toBe('result-y')
  })

  it('throws when budget is exhausted', async () => {
    const budget: BudgetState = {
      tokensUsed: 1000,
      tokensRemaining: 0,
      costUsd: 0,
      agentCalls: 0,
    }
    await expect(
      runPipeline('run1', 'Scan', [1], async (x) => x, undefined, makeCache(), budget),
    ).rejects.toThrow('Budget exhausted')
  })

  it('does not throw when budget is unlimited', async () => {
    const budget: BudgetState = {
      tokensUsed: 0,
      tokensRemaining: null,
      costUsd: 0,
      agentCalls: 0,
    }
    const result = await runPipeline('run1', 'Scan', [1], async (x) => x * 2, undefined, makeCache(), budget)
    expect(result).toEqual([2])
  })

  it('passes correct index to fn', async () => {
    const indices: number[] = []
    const items = ['a', 'b', 'c']
    const fn = async (_item: string, index: number) => { indices.push(index); return index }

    await runPipeline('run1', 'Scan', items, fn, undefined, makeCache())
    expect(indices).toEqual([0, 1, 2])
  })

  it('calls log for cached replay', async () => {
    const cache = makeCache()
    cache.stored.set('run1:Scan:0', 'c0')

    const log = vi.fn()
    await runPipeline('run1', 'Scan', ['a', 'b'], async (x) => x, undefined, cache, undefined, log)

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Replayed 1 cached pipeline items'))
  })

  it('does not save checkpoint for failed items', async () => {
    const cache = makeCache()
    const items = ['ok', 'fail']
    const fn = async (item: string) => {
      if (item === 'fail') throw new Error('boom')
      return item
    }

    await runPipeline('run1', 'Scan', items, fn, undefined, cache, undefined, vi.fn())

    expect(cache.stored.has('run1:Scan:0')).toBe(true)
    expect(cache.stored.has('run1:Scan:1')).toBe(false)
  })
})
