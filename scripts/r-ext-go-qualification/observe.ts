import { exactKeys, timestamp, type QualificationStatus } from './evidence.js';

export interface DrainSnapshot {
  admissionClosed: boolean;
  activeRuns: number;
  pendingEffects: number;
  openReservations: number;
  reconciliationRequired: number;
  authorityConsistent: boolean;
}
/**
 * now/schedule share one monotonic domain. wallNow must not move backwards,
 * and its elapsed time must stay within 15 seconds of the monotonic elapsed time.
 * A resolved sleep must advance now; scheduling must not fire before its deadline.
 */
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
  cleanupReason?: 'clock_invalid';
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
  startedAt?: string;
  samples: Sample[];
  reason?: FailureReason;
  cleanupReason?: 'clock_invalid';
}> {
  let startedAt: string | undefined;
  let origin: number;
  const samples: Sample[] = [];
  const fail = (reason: FailureReason, cleanupReason?: 'clock_invalid') => ({
    status: 'FAIL' as const,
    ...(startedAt === undefined ? {} : { startedAt }),
    samples,
    reason,
    ...(cleanupReason === undefined ? {} : { cleanupReason }),
  });
  try {
    startedAt = timestamp(clock.wallNow());
    origin = clock.now();
    if (!Number.isFinite(origin)) return fail('clock_invalid');
  } catch {
    return fail('clock_invalid');
  }
  const startedWall = Date.parse(startedAt);
  let priorWall = startedWall;
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
    let cleanupReason: 'clock_invalid' | undefined;
    let registering = true;
    let active = true;
    let expired: 'clock_invalid' | 'authority_read_timeout' | undefined;
    let settleDeadline!: (reason: 'clock_invalid' | 'authority_read_timeout') => void;
    const bounded = new Promise<'clock_invalid' | 'authority_read_timeout'>((resolve) => {
      settleDeadline = resolve;
    });
    let cancelDeadline: () => void;
    try {
      cancelDeadline = clock.schedule(deadline + 15_000, () => {
        if (!active) return;
        let reading: number;
        try {
          reading = clock.now();
        } catch {
          reading = Number.NaN;
        }
        expired =
          registering || !Number.isFinite(reading) || reading < deadline + 15_000
            ? 'clock_invalid'
            : 'authority_read_timeout';
        cancellation.abort();
        settleDeadline(expired);
      });
      if (typeof cancelDeadline !== 'function') {
        active = false;
        return fail('clock_invalid');
      }
    } catch {
      active = false;
      return fail('clock_invalid');
    }
    registering = false;
    // An invalid scheduler has not observed an authority timeout or started a read.
    if (expired !== undefined) {
      active = false;
      try {
        cancelDeadline();
      } catch {
        cleanupReason = 'clock_invalid';
      }
      return fail('clock_invalid', cleanupReason);
    }
    try {
      const outcome = await Promise.race([
        read(cancellation.signal).then(
          (value) => ({ kind: 'value' as const, value }),
          () => ({ kind: 'failed' as const }),
        ),
        bounded.then((failure) => ({ kind: 'deadline' as const, failure })),
      ]);
      if (outcome.kind === 'deadline') reason = outcome.failure;
      else if (outcome.kind === 'failed') reason = 'authority_read_failed';
      else {
        try {
          snapshot = validateSnapshot(outcome.value);
        } catch {
          reason = 'authority_snapshot_invalid';
        }
      }
    } catch {
      reason = 'authority_read_failed';
    } finally {
      active = false;
      try {
        cancelDeadline();
      } catch {
        if (reason === undefined) reason = 'clock_invalid';
        else cleanupReason = 'clock_invalid';
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
      Math.abs(observedWall - startedWall - (actual - origin)) < 15_000 &&
      snapshot !== undefined &&
      drained(snapshot);
    const failure = valid ? undefined : (reason ?? 'invalid_or_missed_observation');
    samples.push({
      k,
      scheduledOffsetMs: k * 15_000,
      startedOffsetMs: current - origin,
      actualOffsetMs: actual - origin,
      observedAt,
      valid,
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(failure === undefined ? {} : { reason: failure }),
      ...(cleanupReason === undefined ? {} : { cleanupReason }),
    });
    if (failure !== undefined) return fail(failure, cleanupReason);
    prior = actual;
    priorWall = observedWall;
  }
  return { status: 'PASS', startedAt, samples };
}
