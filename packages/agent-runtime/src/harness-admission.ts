import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

interface Admission { schema: 'openslack.harness_admission.v1'; key: string; requestHash: string; runId: string }

/** Typed outcomes that must never cause an automatic redispatch. */
export class HarnessAdmissionError extends Error {
  constructor(readonly code: 'CONFLICT' | 'INDETERMINATE' | 'BUSY', message: string) {
    super(message); this.name = 'HarnessAdmissionError';
  }
}

/** Canonical JSON for host-resolved inert task data. Request IDs and timestamps are excluded by callers. */
export function hashHarnessInput(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .filter(([, nested]) => nested !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, nested]) => [key, normalize(nested)]));
    return item;
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

/** Minimal exclusive routing records. State and results remain in the canonical agent run. */
export class HarnessAdmissionStore {
  private readonly directory: string;
  constructor(root: string) {
    this.directory = join(resolve(root), '.openslack.local', 'agents', 'harness-admissions');
    let parent = resolve(root);
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
  admit(key: string, requestHash: string): { record: Admission; created: boolean } {
    if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(requestHash)) {
      throw new HarnessAdmissionError('INDETERMINATE', 'Invalid admission digest');
    }
    const record: Admission = { schema: 'openslack.harness_admission.v1', key, requestHash,
      runId: `RUN-${randomUUID().toUpperCase()}` };
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
    if (!/^RUN-[A-Z0-9-]+$/.test(runId)) throw new HarnessAdmissionError('INDETERMINATE', 'Invalid run route');
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

  private read(path: string): Admission {
    const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = fstatSync(file);
      if (!before.isFile() || before.size > 4096) throw new Error('invalid admission file');
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const after = fstatSync(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('unstable admission');
      const row = value as Record<string, unknown>;
      if (row.schema !== 'openslack.harness_admission.v1' || typeof row.key !== 'string' ||
        typeof row.requestHash !== 'string' || typeof row.runId !== 'string' || !/^RUN-[A-Z0-9-]+$/.test(row.runId)) throw new Error('invalid admission');
      return { schema: 'openslack.harness_admission.v1', key: row.key, requestHash: row.requestHash, runId: row.runId };
    } catch {
      throw new HarnessAdmissionError('INDETERMINATE', 'Admission record is unreadable; preserve it and reconcile without replay');
    } finally { closeSync(file); }
  }
}

function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === code;
}
