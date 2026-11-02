/** Fixed governed cleanup contract. Durations, never cross-process clocks.
 * The Go supervisor independently enforces the total maximum. */
import { HARNESS_CLEANUP_BUDGET } from './bridge-wire.js';
export { HARNESS_CLEANUP_BUDGET } from './bridge-wire.js';

/** The legacy Harness field is a compatibility assertion, not a silent knob. */
export function assertHarnessCleanupBudget(value: number): void {
  if (value !== HARNESS_CLEANUP_BUDGET.totalMs) throw new Error('Harness exitGraceMs must be 30000; migrate to the fixed 24s/25s/5s/30s cleanup contract.');
}
