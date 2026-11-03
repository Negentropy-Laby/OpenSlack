import { createHash } from 'node:crypto';

export type QualificationStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';
export const CANDIDATE_SHA = /^[0-9a-f]{40}$/u;
export const SHA256 = /^[0-9a-f]{64}$/u;
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error('Expected an exact canonical UTC timestamp.');
  }
  return value;
}

export function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new Error('Unexpected or missing qualification evidence fields.');
  }
}

/** Preparation status is deliberately not an execution or qualification grant. */
export function preparationStatus() {
  return Object.freeze({
    fullSealedResume: 'BLOCKED' as const,
    blocker: '#433' as const,
    realProvider: 'NOT_RUN' as const,
    humanApproval: 'NOT_RUN' as const,
    databaseRestart: 'NOT_RUN' as const,
    drainObservation: 'NOT_RUN' as const,
    hostedCI: 'NOT_RUN' as const,
    qualification: 'NOT_RUN' as const,
    liveExecutionEnabled: false as const,
  });
}
