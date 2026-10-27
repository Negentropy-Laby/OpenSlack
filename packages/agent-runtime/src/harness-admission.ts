import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { types as utilTypes } from 'node:util';
import { canonicalHarnessRoot, readHarnessFile } from './harness-read.js';
import { RUN_ID_RE, validateRunId } from './run-id.js';

export interface HarnessAdmissionRecord {
  schema: 'openslack.harness_admission.v1'; key: string; requestHash: string; runId: string;
  ownerGeneration?: string; admittedAt?: string; deadlineAt?: string;
}
export interface HarnessAdmissionObservation {
  kind: 'admission'; runId: string; requestHash: string; canonicalRunPresent: boolean;
  disposition: 'in_progress' | 'reconcile_required';
}

/** Typed outcomes that must never cause an automatic redispatch. */
export class HarnessAdmissionError extends Error {
  constructor(readonly code: 'CONFLICT' | 'INDETERMINATE' | 'BUSY' | 'IN_PROGRESS', message: string,
    readonly observation?: HarnessAdmissionObservation) {
    super(message); this.name = 'HarnessAdmissionError';
  }
}

/** Canonical JSON for host-resolved inert task data. Request IDs and timestamps are excluded by callers. */
export function canonicalHarnessInput(value: unknown): string {
  const ancestors = new Set<object>();
  const normalize = (item: unknown): unknown => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || utilTypes.isProxy(item) || ancestors.has(item)) throw new HarnessInputError();
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) throw new HarnessInputError();
    const keys = Reflect.ownKeys(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (keys.some(key => typeof key !== 'string') || keys.some(key => !Object.hasOwn(descriptors[key as string]!, 'value'))) {
      throw new HarnessInputError();
    }
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (keys.length !== item.length + 1) throw new HarnessInputError();
        return Array.from({ length: item.length }, (_, index) => {
          const descriptor = descriptors[String(index)];
          if (!descriptor) throw new HarnessInputError();
          return normalize(descriptor.value);
        });
      }
      return Object.fromEntries((keys as string[]).sort().filter(key => {
        if (!descriptors[key]!.enumerable) throw new HarnessInputError();
        return descriptors[key]!.value !== undefined;
      }).map(key => [key, normalize(descriptors[key]!.value)]));
    } finally { ancestors.delete(item); }
  };
  return JSON.stringify(normalize(value));
}

export function hashHarnessInput(value: unknown): string {
  return createHash('sha256').update(canonicalHarnessInput(value)).digest('hex');
}

/** Invalid host input cannot alias an existing admission's canonical digest. */
export class HarnessInputError extends TypeError {
  readonly code = 'HARNESS_INPUT_INVALID';
  constructor() { super('Harness input must contain only inert finite JSON data'); this.name = 'HarnessInputError'; }
}

/** Minimal exclusive routing records. State and results remain in the canonical agent run. */
export class HarnessAdmissionStore {
  private readonly directory: string;
  constructor(root: string) {
    const canonical = canonicalHarnessRoot(root);
    this.directory = join(canonical, '.openslack.local', 'agents', 'harness-admissions');
    let parent = canonical;
    for (const part of ['.openslack.local', 'agents', 'harness-admissions']) {
      parent = join(parent, part);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const actual = realpathSync(parent);
      const sameNativePath = process.platform === 'win32' ? actual.toLowerCase() === parent.toLowerCase() : actual === parent;
      if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink() || !sameNativePath) {
        throw new HarnessAdmissionError('INDETERMINATE', 'Admission storage traverses an alias or link');
      }
    }
  }

  /** Exclusive publication, including across independent processes. A damaged record is never replaced. */
  admit(key: string, requestHash: string, owner?: { ownerGeneration: string; admittedAt: string; deadlineAt: string }): { record: HarnessAdmissionRecord; created: boolean } {
    if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(requestHash)) {
      throw new HarnessAdmissionError('INDETERMINATE', 'Invalid admission digest');
    }
    if (owner && (!/^[A-Za-z0-9-]{1,128}$/.test(owner.ownerGeneration) || !Number.isFinite(Date.parse(owner.admittedAt)) ||
      !Number.isFinite(Date.parse(owner.deadlineAt)) || Date.parse(owner.deadlineAt) <= Date.parse(owner.admittedAt))) {
      throw new HarnessAdmissionError('INDETERMINATE', 'Invalid admission owner or deadline');
    }
    const record: HarnessAdmissionRecord = { schema: 'openslack.harness_admission.v1', key, requestHash,
      runId: `RUN-${randomUUID().toUpperCase()}`, ...owner };
    const target = join(this.directory, `${key}.json`);
    const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`);
    const file = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(file, JSON.stringify(record)); fsyncSync(file); } finally { closeSync(file); }
    try {
      try { linkSync(temporary, target); return { record, created: true }; }
      catch (error) {
        if (!isCode(error, 'EEXIST')) throw new HarnessAdmissionError('INDETERMINATE', 'Admission publication is unconfirmed; reconcile without replay');
      }
      const existing = this.read(target);
      if (existing.key !== key || existing.requestHash !== requestHash) {
        throw new HarnessAdmissionError('CONFLICT', 'This logical task already has different execution input');
      }
      return { record: existing, created: false };
    } finally { unlinkSync(temporary); }
  }

  /** Hold only a short synchronous canonical-run read/update; a stale lock blocks instead of being repaired. */
  withRunLock<T>(runId: string, action: () => T): T {
    validateRunId(runId);
    const path = join(this.directory, `${runId}.lock`);
    let file: number;
    try { file = openSync(path, 'wx', 0o600); }
    catch (error) {
      if (isCode(error, 'EEXIST')) throw new HarnessAdmissionError('BUSY', 'Canonical run is busy; query before retrying a mutation');
      throw error;
    }
    try { return action(); } finally {
      try {
        const owned = fstatSync(file);
        const current = lstatSync(path);
        if (owned.ino !== current.ino || owned.dev !== current.dev || !current.isFile() || current.isSymbolicLink()) {
          throw new HarnessAdmissionError('INDETERMINATE', 'Canonical lock ownership changed; preserve and reconcile');
        }
        unlinkSync(path);
      } finally { closeSync(file); }
    }
  }

  private read(path: string): HarnessAdmissionRecord {
    try {
      const until = Date.now() + 1000;
      while (lstatSync(path).nlink !== 1) {
        if (Date.now() >= until) throw new HarnessAdmissionError('IN_PROGRESS', 'Admission publication has not released its temporary link; query without replay');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      const value: unknown = JSON.parse(readHarnessFile(path, 4096).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('unstable admission');
      const row = value as Record<string, unknown>;
      if (row.schema !== 'openslack.harness_admission.v1' || typeof row.key !== 'string' ||
        typeof row.requestHash !== 'string' || typeof row.runId !== 'string' || !RUN_ID_RE.test(row.runId)) throw new Error('invalid admission');
      const hasOwner = row.ownerGeneration !== undefined || row.admittedAt !== undefined || row.deadlineAt !== undefined;
      if (hasOwner && (typeof row.ownerGeneration !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(row.ownerGeneration) ||
        typeof row.admittedAt !== 'string' || typeof row.deadlineAt !== 'string' || !Number.isFinite(Date.parse(row.admittedAt)) ||
        !Number.isFinite(Date.parse(row.deadlineAt)) || Date.parse(row.deadlineAt) <= Date.parse(row.admittedAt))) throw new Error('invalid owner binding');
      return { schema: 'openslack.harness_admission.v1', key: row.key, requestHash: row.requestHash, runId: row.runId,
        ...(hasOwner ? { ownerGeneration: row.ownerGeneration as string, admittedAt: row.admittedAt as string, deadlineAt: row.deadlineAt as string } : {}) };
    } catch (error) {
      if (error instanceof HarnessAdmissionError && error.code === 'IN_PROGRESS') throw error;
      throw new HarnessAdmissionError('INDETERMINATE', 'Admission record is unreadable; preserve it and reconcile without replay');
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}
