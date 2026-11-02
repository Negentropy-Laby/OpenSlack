import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import { RunPersistenceError } from './run-files.js';

export const RUN_STORAGE_MAX_BYTES = 96 * 1024 * 1024;
export const RUN_STORAGE_RECOVERY_RESERVE_BYTES = 2 * 1024 * 1024;
export const RUN_STORAGE_NORMAL_MAX_BYTES = RUN_STORAGE_MAX_BYTES - RUN_STORAGE_RECOVERY_RESERVE_BYTES;
export const RUN_STORAGE_FINALIZATION_MAX_BYTES = RUN_STORAGE_NORMAL_MAX_BYTES + 768 * 1024;
export const RUN_STORAGE_ENTRY_MIN_BYTES = 1024;
export const RUN_INTENT_MAX_BYTES = 16 * 1024;

export const runFileCharge = (bytes: number): number => Math.max(bytes, RUN_STORAGE_ENTRY_MIN_BYTES);
export interface RunCapacityEntry { name: string; bytes: number }

/** Capacity is not file authority. Readers must still verify descriptors, links,
 * schemas and exact membership; writers must own the canonical transaction. */
export function inspectRunCapacity(directory: string, ceiling = RUN_STORAGE_MAX_BYTES): { entries: RunCapacityEntry[]; used: number } {
  const stream = opendirSync(directory), entries: RunCapacityEntry[] = [];
  let used = 0;
  try {
    for (let entry = stream.readSync(); entry; entry = stream.readSync()) {
      const stat = lstatSync(join(directory, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 0) {
        throw new RunPersistenceError('RUN_STORAGE_LIMIT', 'Run storage capacity cannot be established safely.');
      }
      used += runFileCharge(stat.size);
      if (used > ceiling) throw new RunPersistenceError('RUN_STORAGE_LIMIT', 'Run storage exceeds its bounded repair capacity; preserve and inspect.');
      entries.push({ name: entry.name, bytes: stat.size });
    }
  } finally { stream.closeSync(); }
  return { entries, used };
}

/** Count the simultaneous old canonical/new temporary peak, not only final size. */
export function assertRunCapacity(directory: string, planned: Readonly<Record<string, number>>,
  options: { finalization?: boolean; recovery?: boolean; reservedBytes?: number } = {}): void {
  const ceiling = options.recovery ? RUN_STORAGE_MAX_BYTES : options.finalization ? RUN_STORAGE_FINALIZATION_MAX_BYTES : RUN_STORAGE_NORMAL_MAX_BYTES;
  const current = inspectRunCapacity(directory), sizes = new Map(current.entries.map(entry => [entry.name, entry.bytes]));
  for (const [name, bytes] of Object.entries(planned)) {
    if (!name || name.includes('/') || name.includes('\\') || !Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError('Invalid run capacity reservation');
    sizes.set(name, Math.max(sizes.get(name) ?? 0, bytes));
  }
  const reserved = options.reservedBytes ?? 0;
  if (!Number.isSafeInteger(reserved) || reserved < 0 ||
    [...sizes.values()].reduce((sum, size) => sum + runFileCharge(size), reserved) > ceiling) {
    throw new RunPersistenceError('RUN_STORAGE_LIMIT', 'Reserve run result and recovery capacity before further effects.');
  }
}
