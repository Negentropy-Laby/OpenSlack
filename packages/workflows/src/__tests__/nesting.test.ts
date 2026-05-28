import { describe, it, expect } from 'vitest'
import {
  MAX_NESTING_DEPTH,
  checkNestingDepth,
  NestingDepthError,
  createNestingGuard,
} from '../nesting.js'

describe('MAX_NESTING_DEPTH', () => {
  it('is set to 1', () => {
    expect(MAX_NESTING_DEPTH).toBe(1)
  })
})

describe('checkNestingDepth', () => {
  it('returns true for depth 0 (top-level)', () => {
    expect(checkNestingDepth(0)).toBe(true)
  })

  it('returns false for depth 1 (already at max)', () => {
    expect(checkNestingDepth(1)).toBe(false)
  })

  it('returns false for depth 2 (exceeds max)', () => {
    expect(checkNestingDepth(2)).toBe(false)
  })

  it('returns false for large depth values', () => {
    expect(checkNestingDepth(100)).toBe(false)
  })

  it('returns true for negative depth (edge case)', () => {
    expect(checkNestingDepth(-1)).toBe(true)
  })
})

describe('NestingDepthError', () => {
  it('has correct name', () => {
    const err = new NestingDepthError(2)
    expect(err.name).toBe('NestingDepthError')
  })

  it('includes depth and maxDepth in message', () => {
    const err = new NestingDepthError(3)
    expect(err.message).toContain('3')
    expect(err.message).toContain('1')
  })

  it('stores depth property', () => {
    const err = new NestingDepthError(5)
    expect(err.depth).toBe(5)
  })

  it('stores maxDepth property with default', () => {
    const err = new NestingDepthError(2)
    expect(err.maxDepth).toBe(1)
  })

  it('accepts custom maxDepth', () => {
    const err = new NestingDepthError(5, 3)
    expect(err.maxDepth).toBe(3)
    expect(err.message).toContain('3')
  })

  it('is an instance of Error', () => {
    const err = new NestingDepthError(1)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(NestingDepthError)
  })
})

describe('createNestingGuard', () => {
  it('does not throw at depth 0', () => {
    const { guard } = createNestingGuard(0)
    expect(() => guard()).not.toThrow()
  })

  it('throws NestingDepthError at depth 1 (MAX_NESTING_DEPTH)', () => {
    const { guard } = createNestingGuard(1)
    expect(() => guard()).toThrow(NestingDepthError)
  })

  it('throws at depth greater than MAX_NESTING_DEPTH', () => {
    const { guard } = createNestingGuard(5)
    expect(() => guard()).toThrow(NestingDepthError)
  })

  it('incrementDepth increases depth', () => {
    const { guard, incrementDepth, getDepth } = createNestingGuard(0)
    expect(getDepth()).toBe(0)
    expect(() => guard()).not.toThrow()

    incrementDepth()
    expect(getDepth()).toBe(1)
    expect(() => guard()).toThrow(NestingDepthError)
  })

  it('returns new depth from incrementDepth', () => {
    const { incrementDepth } = createNestingGuard(0)
    expect(incrementDepth()).toBe(1)
    expect(incrementDepth()).toBe(2)
  })

  it('getDepth returns current depth without modifying it', () => {
    const { getDepth, incrementDepth } = createNestingGuard(0)
    expect(getDepth()).toBe(0)
    expect(getDepth()).toBe(0) // Still 0, no side effects
    incrementDepth()
    expect(getDepth()).toBe(1)
  })

  it('defaults to depth 0 when no initial value given', () => {
    const { getDepth } = createNestingGuard()
    expect(getDepth()).toBe(0)
  })

  it('simulates a workflow nesting scenario', () => {
    // Top-level workflow starts at depth 0
    const guard = createNestingGuard(0)

    // Top-level can call nested workflow
    expect(() => guard.guard()).not.toThrow()

    // Enter first nesting level
    guard.incrementDepth() // depth now 1

    // At depth 1 (= MAX_NESTING_DEPTH), cannot nest further
    expect(() => guard.guard()).toThrow(NestingDepthError)
  })
})
