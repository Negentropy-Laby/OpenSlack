import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForRunObservation, type RunClock } from '../run-wait.js';

afterEach(() => vi.useRealTimers());
describe('bounded run observation and pre-acquisition waits', () => {
  it('does not invoke an attempt after either absolute cutoff', async () => {
    const attempt = vi.fn(() => 'unsafe'), clock: RunClock = { utcNow: () => 100, monotonicNow: () => 10 };
    for (const options of [{ utcDeadline: 99 }, { monotonicDeadline: 9 }]) {
      await expect(waitForRunObservation(attempt, () => true, options, clock)).rejects.toThrow('deadline expired');
    }
    expect(attempt).not.toHaveBeenCalled();
  });
  it('retains one initial observation at zero relative wait but never retries it', async () => {
    const clock: RunClock = { utcNow: () => 100, monotonicNow: () => 10 };
    const attempt = vi.fn(() => 'ready');
    await expect(waitForRunObservation(attempt, () => true, { waitMs: 0 }, clock)).resolves.toBe('ready');
    const busy = new Error('owned fixture busy'), refused = vi.fn(() => { throw busy; });
    await expect(waitForRunObservation(refused, () => true, { waitMs: 0 }, clock)).rejects.toBe(busy);
    expect(attempt).toHaveBeenCalledOnce(); expect(refused).toHaveBeenCalledOnce();
  });
  it('checks the monotonic budget again after a delayed wake without running a second callback', async () => {
    vi.useFakeTimers();
    let monotonic = 0;
    const busy = new Error('busy'), clock: RunClock = { utcNow: () => 100, monotonicNow: () => monotonic };
    const attempt = vi.fn(() => { throw busy; });
    const result = waitForRunObservation(attempt, () => true, { waitMs: 5 }, clock).catch(error => error);
    monotonic = 10;
    await vi.advanceTimersByTimeAsync(5);
    expect(await result).toBe(busy); expect(attempt).toHaveBeenCalledOnce();
  });
  it('yields through increasing bounded delays and honors cancellation', async () => {
    vi.useFakeTimers();
    const signal = new AbortController(), attempt = vi.fn(() => { throw new Error('busy'); });
    const result = waitForRunObservation(attempt, () => true, { signal: signal.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(5 + 10 + 20 + 40 + 50);
    expect(attempt).toHaveBeenCalledTimes(6);
    const reason = new Error('cancelled'); signal.abort(reason);
    expect(await result).toBe(reason); expect(vi.getTimerCount()).toBe(0);
  });
});
