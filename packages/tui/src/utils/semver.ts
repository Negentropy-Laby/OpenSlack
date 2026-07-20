/**
 * Semver comparison utilities.
 *
 * Ported from Aby's utils/semver.ts — uses the npm `semver` package
 * directly (no Bun runtime dependency).
 */

import { coerce, compare, gte as semverGte, satisfies as semverSatisfies } from 'semver';

export { coerce };

export function gt(a: string, b: string): boolean {
  return compare(a, b, { loose: true }) > 0;
}

export function gte(a: string, b: string): boolean {
  return semverGte(a, b, { loose: true });
}

export function lt(a: string, b: string): boolean {
  return compare(a, b, { loose: true }) < 0;
}

export function lte(a: string, b: string): boolean {
  return compare(a, b, { loose: true }) <= 0;
}

export function satisfies(version: string, range: string): boolean {
  return semverSatisfies(version, range, { loose: true });
}

export function order(a: string, b: string): -1 | 0 | 1 {
  return compare(a, b, { loose: true }) as -1 | 0 | 1;
}
