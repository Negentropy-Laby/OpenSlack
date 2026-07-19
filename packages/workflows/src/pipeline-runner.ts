import type { BudgetState, ClaudeBudgetAPI, PipelineOptions } from './types.js';

/**
 * Cache store interface for pipeline item checkpointing.
 */
export interface PipelineCacheStore {
  loadItem(runId: string, phase: string, index: number): Promise<unknown | null>;
  saveItem(runId: string, phase: string, index: number, result: unknown): Promise<void>;
}

/**
 * Execute a pipeline of items with bounded concurrency and per-item checkpoints.
 *
 * Phase 1: Replay cached items (contiguous from the start).
 * Phase 2: Execute remaining items with bounded concurrency,
 *          saving each result as a checkpoint on completion.
 *
 * Failed items are recorded as null in the results array (not thrown).
 *
 * @param runId - Unique run identifier for cache namespacing
 * @param phase - Current phase name for cache keys
 * @param items - Array of input items
 * @param fn - Async function to apply to each item
 * @param options - Concurrency limit (default: 4)
 * @param cache - Cache store for checkpointing
 * @param budget - Optional budget state for pre-check
 * @param log - Optional logging function
 * @returns Array of results (null for failed items)
 */
export async function runPipeline<T, R>(
  runId: string,
  phase: string,
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options: PipelineOptions | undefined,
  cache: PipelineCacheStore,
  budget?: BudgetState,
  log?: (message: string) => void,
): Promise<(R | null)[]> {
  if (items.length === 0) return [];

  const concurrency = options?.concurrency ?? 4;

  // Budget pre-check
  if (budget && budget.tokensRemaining !== null && budget.tokensRemaining <= 0) {
    throw new Error('Budget exhausted: no tokens remaining for pipeline');
  }

  const results: (R | null)[] = new Array(items.length).fill(null);
  let nextIndex = 0;

  // Phase 1: replay cached items (must be contiguous from start)
  for (let i = 0; i < items.length; i++) {
    const cached = await cache.loadItem(runId, phase, i);
    if (cached !== null) {
      results[i] = cached as R;
      nextIndex = i + 1;
    } else {
      break;
    }
  }

  if (nextIndex > 0) {
    log?.(`Replayed ${nextIndex} cached pipeline items for phase "${phase}"`);
  }

  // If all items were cached, return early
  if (nextIndex >= items.length) {
    return results;
  }

  // Phase 2: execute remaining items with bounded concurrency
  const settled = new Set<number>();
  const inFlight: Array<{ index: number; promise: Promise<void> }> = [];

  async function launchItem(index: number): Promise<void> {
    try {
      const result = await fn(items[index], index);
      results[index] = result;
      await cache.saveItem(runId, phase, index, result);
    } catch (err) {
      results[index] = null;
      const msg = err instanceof Error ? err.message : String(err);
      log?.(`Pipeline item ${index} failed: ${msg}`);
    }
    settled.add(index);
  }

  while (nextIndex < items.length || inFlight.length > 0) {
    // Fill up to concurrency limit
    while (inFlight.length < concurrency && nextIndex < items.length) {
      const index = nextIndex++;
      const promise = launchItem(index);
      inFlight.push({ index, promise });
    }

    if (inFlight.length > 0) {
      // Wait for at least one to settle
      await Promise.race(inFlight.map((entry) => entry.promise));

      // Remove settled entries
      for (let j = inFlight.length - 1; j >= 0; j--) {
        if (settled.has(inFlight[j].index)) {
          inFlight.splice(j, 1);
        }
      }
    }
  }

  return results;
}

/**
 * Execute a multi-stage pipeline: each item independently passes through ALL
 * stages sequentially, while items run concurrently up to the concurrency limit.
 *
 * Failed items are recorded as null in the results array (not thrown).
 *
 * @param items  - Array of input items
 * @param stages - Array of stage functions; each receives (prevResult, originalItem, index)
 * @param options - Concurrency limit (default: 4)
 * @returns Array of final stage results (null for failed items)
 */
export async function runMultiStagePipeline<T, R>(
  items: T[],
  stages: Array<(prev: unknown, item: T, index: number) => Promise<unknown>>,
  options?: PipelineOptions,
): Promise<(R | null)[]> {
  if (items.length === 0) return [];
  if (stages.length === 0) return items.map(() => null as R | null);

  const concurrency = options?.concurrency ?? 4;
  const results: (R | null)[] = new Array(items.length).fill(null);

  const settled = new Set<number>();
  const inFlight: Array<{ index: number; promise: Promise<void> }> = [];
  let nextIndex = 0;

  async function processItem(index: number): Promise<void> {
    try {
      let prev: unknown = undefined;
      for (const stage of stages) {
        prev = await stage(prev, items[index], index);
      }
      results[index] = prev as R;
    } catch (err) {
      results[index] = null;
    }
    settled.add(index);
  }

  while (nextIndex < items.length || inFlight.length > 0) {
    while (inFlight.length < concurrency && nextIndex < items.length) {
      const index = nextIndex++;
      const promise = processItem(index);
      inFlight.push({ index, promise });
    }

    if (inFlight.length > 0) {
      await Promise.race(inFlight.map((entry) => entry.promise));

      for (let j = inFlight.length - 1; j >= 0; j--) {
        if (settled.has(inFlight[j].index)) {
          inFlight.splice(j, 1);
        }
      }
    }
  }

  return results;
}
