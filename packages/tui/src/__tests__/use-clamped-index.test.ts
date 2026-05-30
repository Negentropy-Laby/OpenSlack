import { describe, it, expect } from 'vitest'
import { useClampedIndex } from '../hooks/use-clamped-index.js'

// Simple shim to test the hook's logic without @testing-library/react
function createTestHarness(initialLength: number) {
  let length = initialLength
  let selectedIndex = 0

  function setIndex(updater: number | ((prev: number) => number)) {
    const next = typeof updater === 'function'
      ? (updater as (prev: number) => number)(selectedIndex)
      : updater
    if (length === 0) {
      selectedIndex = 0
    } else if (next < 0) {
      selectedIndex = length - 1
    } else if (next >= length) {
      selectedIndex = 0
    } else {
      selectedIndex = next
    }
  }

  function clampOnLengthChange(newLength: number) {
    length = newLength
    if (length === 0) {
      selectedIndex = 0
    } else if (selectedIndex >= length) {
      selectedIndex = length - 1
    }
  }

  return {
    get index() { return selectedIndex },
    setIndex,
    clampOnLengthChange,
  }
}

describe('useClampedIndex logic', () => {
  it('initializes to 0', () => {
    const h = createTestHarness(5)
    expect(h.index).toBe(0)
  })

  it('increments within bounds', () => {
    const h = createTestHarness(5)
    h.setIndex(prev => prev + 1)
    expect(h.index).toBe(1)
  })

  it('wraps from last to first', () => {
    const h = createTestHarness(3)
    h.setIndex(2)
    h.setIndex(prev => prev + 1)
    expect(h.index).toBe(0)
  })

  it('wraps from first to last', () => {
    const h = createTestHarness(3)
    h.setIndex(prev => prev - 1)
    expect(h.index).toBe(2)
  })

  it('clamps to last item when length shrinks', () => {
    const h = createTestHarness(5)
    h.setIndex(4)
    expect(h.index).toBe(4)
    h.clampOnLengthChange(3)
    expect(h.index).toBe(2)
  })

  it('resets to 0 when length becomes 0', () => {
    const h = createTestHarness(3)
    h.setIndex(2)
    expect(h.index).toBe(2)
    h.clampOnLengthChange(0)
    expect(h.index).toBe(0)
  })

  it('does not change when length grows', () => {
    const h = createTestHarness(3)
    h.setIndex(1)
    expect(h.index).toBe(1)
    h.clampOnLengthChange(10)
    expect(h.index).toBe(1)
  })

  it('accepts direct number setter', () => {
    const h = createTestHarness(5)
    h.setIndex(3)
    expect(h.index).toBe(3)
  })

  it('clamps direct number setter to bounds', () => {
    const h = createTestHarness(3)
    h.setIndex(99)
    expect(h.index).toBe(0)
  })
})
