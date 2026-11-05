import { exactKeys, timestamp, type QualificationStatus } from './evidence.js';

export interface DrainSnapshot {
  admissionClosed: boolean;
  activeRuns: number;
  pendingEffects: number;
  openReservations: number;
  reconciliationRequired: number;
  authorityConsistent: boolean;
}
interface Clock {
  now(): number;
  wallNow(): string;
  sleep(ms: number): Promise<void>;
  /** Same monotonic domain as now(); returns an idempotent cancellation. */
  schedule(deadlineMs: number, callback: () => void): () => void;
}
type FailureReason =
  | 'clock_invalid'
  | 'clock_stalled'
  | 'clock_sleep_failed'
  | 'authority_read_timeout'
  | 'authority_read_failed'
  | 'authority_snapshot_invalid'
  | 'invalid_or_missed_observation';
interface Sample {
  k: number;
  scheduledOffsetMs: number;
  startedOffsetMs: number;
  actualOffsetMs: number;
  observedAt: string;
  valid: boolean;
  snapshot?: DrainSnapshot;
  reason?: FailureReason;
}

function validateSnapshot(value: unknown): DrainSnapshot {
  exactKeys(value, [
    'admissionClosed',
    'activeRuns',
    'pendingEffects',
    'openReservations',
    'reconciliationRequired',
    'authorityConsistent',
  ]);
  if (
    typeof value.admissionClosed !== 'boolean' ||
    typeof value.authorityConsistent !== 'boolean' ||
    [
      value.activeRuns,
      value.pendingEffects,
      value.openReservations,
      value.reconciliationRequired,
    ].some((count) => !Number.isSafeInteger(count) || Number(count) < 0)
  )
    throw new Error('Invalid drain counters.');
  return structuredClone(value) as unknown as DrainSnapshot;
}

function drained(value: DrainSnapshot): boolean {
  return (
    value.admissionClosed &&
    value.authorityConsistent === true &&
    value.activeRuns === 0 &&
    value.pendingEffects === 0 &&
    value.openReservations === 0 &&
    value.reconciliationRequired === 0
  );
}

/** Read-only schedule, not a sampler for a fabricated/missing authority source. */
export async function observeDrain(
  read: (signal: AbortSignal) => Promise<DrainSnapshot>,
  clock: Clock,
): Promise<{
  status: QualificationStatus;
  startedAt: string;
  samples: Sample[];
  reason?: FailureReason;
}> {
  const startedAt = timestamp(clock.wallNow());
  const origin = clock.now();
  if (!Number.isFinite(origin)) throw new Error('Invalid monotonic observation clock.');
  let priorWall = Date.parse(startedAt);
  const samples: Sample[] = [];
  const fail = (reason: FailureReason) => ({ status: 'FAIL' as const, startedAt, samples, reason });
  let prior = origin;
  for (let k = 1; k <= 40; k += 1) {
    const deadline = origin + k * 15_000;
    let current: number;
    try {
      current = clock.now();
    } catch {
      return fail('clock_invalid');
    }
    if (!Number.isFinite(current) || current < prior) return fail('clock_invalid');
    while (current < deadline) {
      try {
        await clock.sleep(deadline - current);
      } catch {
        return fail('clock_sleep_failed');
      }
      let next: number;
      try {
        next = clock.now();
      } catch {
        return fail('clock_invalid');
      }
      if (!Number.isFinite(next) || next < current) return fail('clock_invalid');
      if (next === current) return fail('clock_stalled');
      current = next;
    }
    if (current >= deadline + 15_000) return fail('invalid_or_missed_observation');
    let snapshot: DrainSnapshot | undefined;
    let reason: FailureReason | undefined;
    const cancellation = new AbortController();
    let cancelDeadline: (() => void) | undefined;
    try {
      const bounded = new Promise<never>((_resolve, reject) => {
        cancelDeadline = clock.schedule(deadline + 15_000, () => {
          cancellation.abort();
          reject(new Error('Authority sample deadline elapsed.'));
        });
      });
      // Invalid scheduling ports still fail closed without an unhandled rejection.
      void bounded.catch(() => {});
      if (typeof cancelDeadline !== 'function') return fail('clock_invalid');
      const value = await (cancellation.signal.aborted
        ? bounded
        : Promise.race([read(cancellation.signal), bounded]));
      try {
        snapshot = validateSnapshot(value);
      } catch {
        reason = 'authority_snapshot_invalid';
      }
    } catch {
      reason = cancellation.signal.aborted ? 'authority_read_timeout' : 'authority_read_failed';
    } finally {
      try {
        cancelDeadline?.();
      } catch {
        reason = 'clock_invalid';
        snapshot = undefined;
      }
    }
    let actual: number;
    let observedAt: string;
    try {
      actual = clock.now();
      observedAt = timestamp(clock.wallNow());
    } catch {
      return fail('clock_invalid');
    }
    if (!Number.isFinite(actual) || actual < current) return fail('clock_invalid');
    const observedWall = Date.parse(observedAt);
    const valid =
      reason === undefined &&
      actual < deadline + 15_000 &&
      observedWall >= priorWall &&
      Math.abs(observedWall - Date.parse(startedAt) - (actual - origin)) < 15_000 &&
      snapshot !== undefined &&
      drained(snapshot);
    samples.push({
      k,
      scheduledOffsetMs: k * 15_000,
      startedOffsetMs: current - origin,
      actualOffsetMs: actual - origin,
      observedAt,
      valid,
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(reason ? { reason } : !valid ? { reason: 'invalid_or_missed_observation' } : {}),
    });
    if (!valid) return fail(reason ?? 'invalid_or_missed_observation');
    prior = actual;
    priorWall = observedWall;
  }
  return { status: 'PASS', startedAt, samples };
}
