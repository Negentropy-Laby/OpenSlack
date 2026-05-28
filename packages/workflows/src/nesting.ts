/**
 * Maximum nesting depth for ctx.workflow() calls.
 * A child workflow at depth 1 cannot call ctx.workflow() again.
 */
export const MAX_NESTING_DEPTH = 1

/**
 * Check whether the given nesting depth exceeds the maximum allowed.
 * Returns true if the depth is within bounds, false if it would exceed.
 */
export function checkNestingDepth(depth: number): boolean {
  return depth < MAX_NESTING_DEPTH
}

/**
 * Error thrown when a workflow nesting depth limit is exceeded.
 */
export class NestingDepthError extends Error {
  readonly depth: number
  readonly maxDepth: number

  constructor(depth: number, maxDepth: number = MAX_NESTING_DEPTH) {
    super(
      `Workflow nesting depth limit (${maxDepth}) exceeded at depth ${depth}. ` +
      'Child workflows cannot call ctx.workflow() again.',
    )
    this.name = 'NestingDepthError'
    this.depth = depth
    this.maxDepth = maxDepth
  }
}

/**
 * Create a nesting guard function that throws NestingDepthError when
 * the current nesting depth exceeds MAX_NESTING_DEPTH.
 *
 * The guard tracks the current depth and increments it on each nested call.
 * Returns a tuple of [guard, incrementDepth, getDepth] where:
 * - guard: throws if current depth >= MAX_NESTING_DEPTH
 * - incrementDepth: increments the nesting depth counter
 * - getDepth: returns the current nesting depth
 */
export function createNestingGuard(
  initialDepth: number = 0,
): {
  guard: () => void
  incrementDepth: () => number
  getDepth: () => number
} {
  let depth = initialDepth

  return {
    guard(): void {
      if (depth >= MAX_NESTING_DEPTH) {
        throw new NestingDepthError(depth)
      }
    },
    incrementDepth(): number {
      depth++
      return depth
    },
    getDepth(): number {
      return depth
    },
  }
}
