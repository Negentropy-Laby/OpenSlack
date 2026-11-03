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
}
interface Sample {
  k: number;
  scheduledOffsetMs: number;
  startedOffsetMs: number;
  actualOffsetMs: number;
  observedAt: string;
  valid: boolean;
  snapshot?: DrainSnapshot;
  reason?: string;
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
    value?.admissionClosed === true &&
    value.authorityConsistent === true &&
    [
      value.activeRuns,
      value.pendingEffects,
      value.openReservations,
      value.reconciliationRequired,
    ].every((count) => Number.isSafeInteger(count) && count === 0)
  );
}

/** Read-only schedule, not a sampler for a fabricated/missing authority source. */
export async function observeDrain(
  read: (signal: AbortSignal) => Promise<DrainSnapshot>,
  clock: Clock,
): Promise<{ status: QualificationStatus; startedAt: string; samples: Sample[] }> {
  const startedAt = timestamp(clock.wallNow());
  const origin = clock.now();
  if (!Number.isFinite(origin)) throw new Error('Invalid monotonic observation clock.');
  let priorWall = Date.parse(startedAt);
  const samples: Sample[] = [];
  let prior = origin;
  for (let k = 1; k <= 40; k += 1) {
    const deadline = origin + k * 15_000;
    let current = clock.now();
    if (current < prior) return { status: 'FAIL', startedAt, samples };
    while (current < deadline) {
      await clock.sleep(deadline - current);
      const next = clock.now();
      if (!Number.isFinite(next) || next < current) return { status: 'FAIL', startedAt, samples };
      current = next;
    }
    let snapshot: DrainSnapshot | undefined;
    let reason: string | undefined;
    const cancellation = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const bounded = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => {
            cancellation.abort();
            reject(new Error('Authority sample deadline elapsed.'));
          },
          Math.max(1, deadline + 15_000 - current),
        );
      });
      snapshot = validateSnapshot(await Promise.race([read(cancellation.signal), bounded]));
    } catch {
      reason = cancellation.signal.aborted ? 'authority_read_timeout' : 'authority_read_failed';
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    const actual = clock.now();
    const observedAt = timestamp(clock.wallNow());
    const observedWall = Date.parse(observedAt);
    const valid =
      Number.isFinite(actual) &&
      actual >= current &&
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
    if (!valid) return { status: 'FAIL', startedAt, samples };
    prior = actual;
    priorWall = observedWall;
  }
  return { status: 'PASS', startedAt, samples };
}
