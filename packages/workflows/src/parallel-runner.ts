import type { BudgetState, ParallelOptions } from './types.js'

/**
 * Execute an array of async tasks with bounded concurrency and
 * optional budget pre-check.
 *
 * Results are returned in the same order as the input tasks array.
 * If any task rejects, the first rejection propagates (others continue
 * to settle but their rejections are ignored).
 *
 * @param tasks - Array of functions returning promises
 * @param options - Concurrency limit (default: Infinity)
 * @param budget - Optional budget state to check before launch
 * @returns Array of results in input order
 */
export async function runParallel<T>(
  tasks: Array<() => Promise<T>>,
  options: ParallelOptions | undefined,
  budget?: BudgetState,
): Promise<T[]> {
  if (tasks.length === 0) return []

  const concurrency = options?.concurrency ?? Infinity

  // Budget pre-check
  if (budget && budget.tokensRemaining !== null && budget.tokensRemaining <= 0) {
    throw new Error('Budget exhausted: no tokens remaining for parallel tasks')
  }

  const results: T[] = new Array(tasks.length)
  const settled = new Set<number>()
  const errors: unknown[] = []
  const inFlight: Array<{ index: number; promise: Promise<void> }> = []
  let nextIndex = 0

  function launchTask(index: number): Promise<void> {
    return tasks[index]()
      .then((result) => {
        results[index] = result
        settled.add(index)
      })
      .catch((err) => {
        errors.push(err)
        settled.add(index)
      })
  }

  while (nextIndex < tasks.length || inFlight.length > 0) {
    // Fill up to concurrency limit
    while (inFlight.length < concurrency && nextIndex < tasks.length) {
      const index = nextIndex++
      const promise = launchTask(index)
      inFlight.push({ index, promise })
    }

    if (inFlight.length > 0) {
      // Wait for at least one to settle
      await Promise.race(inFlight.map((entry) => entry.promise))

      // Remove settled entries
      for (let j = inFlight.length - 1; j >= 0; j--) {
        if (settled.has(inFlight[j].index)) {
          inFlight.splice(j, 1)
        }
      }
    }
  }

  // Throw the first error if any task failed
  if (errors.length > 0) {
    throw errors[0]
  }

  return results
}
