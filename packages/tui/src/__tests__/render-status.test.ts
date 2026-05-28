import { describe, it, expect } from 'vitest'

describe('renderStatusTui', () => {
  it('export exists and is a function', async () => {
    const mod = await import('../views/render-status.js')
    expect(typeof mod.renderStatusTui).toBe('function')
  })
})
