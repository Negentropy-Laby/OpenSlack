import { performance } from 'node:perf_hooks';
import type { WaitRunSnapshotOptions } from './run-store.js';
import { systemUtcNow } from '@openslack/core/internal/runtime-contracts';

export const RUN_WAIT_DEFAULT_MS = 1000;
export const RUN_WAIT_BACKOFF_MS = Object.freeze([5, 10, 20, 40, 50]);
export class RunWaitDeadlineError extends Error {
  constructor() { super('Run observation deadline expired'); this.name = 'RunWaitDeadlineError'; }
}
export type RunWaitOptions = WaitRunSnapshotOptions;
export interface RunClock { utcNow(): number; monotonicNow(): number }
export const systemRunClock: Readonly<RunClock> = Object.freeze({ utcNow: systemUtcNow, monotonicNow: () => performance.now() });

/** One local monotonic budget; UTC remains an independent denial bound. This
 * helper never decides which failures may be retried or replays an effect. */
export async function waitForRunObservation<T>(attempt: () => T, retryable: (error: unknown) => boolean,
  options: RunWaitOptions = {}, clock: RunClock = systemRunClock): Promise<T> {
  const waitMs = options.waitMs ?? RUN_WAIT_DEFAULT_MS;
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 2_147_483_647 ||
    (options.utcDeadline !== undefined && !Number.isFinite(options.utcDeadline)) ||
    (options.monotonicDeadline !== undefined && !Number.isFinite(options.monotonicDeadline))) throw new TypeError('Run wait requires finite bounded deadlines');
  const start = clock.monotonicNow();
  if (!Number.isFinite(start)) throw new TypeError('Run clock is unavailable');
  const deadline = Math.min(start + waitMs, options.monotonicDeadline ?? Infinity);
  let iteration = 0, initial = true;
  let lastError: unknown;
  const remaining = () => {
    const monotonic = clock.monotonicNow(), utc = clock.utcNow();
    if (!Number.isFinite(monotonic) || !Number.isFinite(utc)) throw new TypeError('Run clock is unavailable');
    return { budget: deadline - monotonic, absolute: Math.min(options.monotonicDeadline === undefined ? Infinity : options.monotonicDeadline - monotonic,
      options.utcDeadline === undefined ? Infinity : options.utcDeadline - utc) };
  };
  while (true) {
    options.signal?.throwIfAborted();
    const before = remaining();
    if (before.absolute <= 0 || (!initial && before.budget <= 0)) throw lastError ?? new RunWaitDeadlineError();
    initial = false;
    try { return attempt(); }
    catch (error) {
      lastError = error;
      const after = remaining(), left = Math.min(after.budget, after.absolute);
      if (!retryable(error) || left <= 0) throw error;
      const duration = Math.max(1, Math.min(left, RUN_WAIT_BACKOFF_MS[Math.min(iteration++, RUN_WAIT_BACKOFF_MS.length - 1)]!));
      await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); resolve(); };
        const abort = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(options.signal?.reason); };
        const timer = setTimeout(finish, duration);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    }
  }
}
