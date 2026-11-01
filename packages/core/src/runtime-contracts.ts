import { posix, win32 } from 'node:path';
import { types as utilTypes } from 'node:util';

/** Syntax only. These values never mint confirmation or execution authority. */
export const CONFIRMATION_CAPABILITY_PATTERN = Object.freeze(/^[A-Za-z0-9_-]{32,128}$/);
export const HARNESS_CONFIRMATION_PENDING_LIMIT = 128;
export const RUN_UNAVAILABLE_REASONS = Object.freeze(['locked', 'creation-incomplete', 'corrupt', 'unsafe', 'persistence-unconfirmed'] as const);
export type RuntimeRunUnavailableReason = typeof RUN_UNAVAILABLE_REASONS[number];
export type ExecutionEligibilityRestriction = Readonly<{ mode: 'required'; expiresAt: number } | { mode: 'not_applicable' }>;
export const systemUtcNow = (): number => Date.now();

/** Keep lexical alias checks separate from resolved spelling comparisons. */
export function nativePathSpellingEqual(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
export function resolvedPathsEqual(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  return nativePathSpellingEqual(path.resolve(a), path.resolve(b), platform);
}

/** One finite clock observation per check; no wall-clock correction or lease renewal. */
export function readExecutionEligibilityRestriction(value: unknown, now: number): ExecutionEligibilityRestriction {
  if (!Number.isFinite(now) || !value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Live eligibility restriction is unavailable or expired');
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !Object.hasOwn(descriptors[key as string]!, 'value'))) throw new Error('Live eligibility restriction is unavailable or expired');
  const mode = descriptors.mode?.value;
  if (mode === 'not_applicable' && keys.length === 1) return Object.freeze({ mode });
  const expiresAt = descriptors.expiresAt?.value;
  if (mode === 'required' && keys.length === 2 && Number.isSafeInteger(expiresAt) && now < expiresAt) return Object.freeze({ mode, expiresAt: expiresAt as number });
  throw new Error('Live eligibility restriction is unavailable or expired');
}

/** A parsed frozen restriction can recheck time without repeating shape parsing. */
export function assertExecutionEligibilityCurrent(value: ExecutionEligibilityRestriction, now: number): void {
  if (!Number.isFinite(now) || (value.mode === 'required' ? !Number.isSafeInteger(value.expiresAt) || now >= value.expiresAt : value.mode !== 'not_applicable')) {
    throw new Error('Live eligibility restriction is unavailable or expired');
  }
}
