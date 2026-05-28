import { describe, it, expect } from 'vitest'

describe('renderPrQueueTui', () => {
  it('export exists and is a function', async () => {
    const mod = await import('../views/render-pr-queue.js')
    expect(typeof mod.renderPrQueueTui).toBe('function')
  })
})
