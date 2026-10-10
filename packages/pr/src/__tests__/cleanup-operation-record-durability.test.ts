import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as Fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Durability and file-boundary regressions for the cleanup operation record.
 *
 * `node:fs` is partially mocked so that write and fsync failures can be
 * injected. The mock is transparent unless a test arms it.
 */
const control = vi.hoisted(() => ({
  /** Fail every fsync from this 1-based call number onward. */
  failFsyncFromCall: Number.POSITIVE_INFINITY,
  fsyncCalls: 0,
  /** Report zero progress for the next write. */
  zeroProgress: false,
  /** Write only part of the buffer on the next write. */
  shortWriteOnce: false,
  beforeSync: null as null | ((handle: number) => void),
  failCleanup: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    writeSync: ((
      handle: number,
      buffer: Buffer,
      offset: number | null = 0,
      length?: number,
      position?: number | null,
    ): number => {
      const start = offset ?? 0;
      const total = length ?? buffer.length - start;
      if (control.zeroProgress) return 0;
      if (control.shortWriteOnce) {
        control.shortWriteOnce = false;
        // Deliberately short: the caller must loop rather than trust one write.
        return actual.writeSync(handle, buffer, start, Math.max(1, Math.floor(total / 2)), position);
      }
      return actual.writeSync(handle, buffer, start, total, position);
    }) as typeof actual.writeSync,
    unlinkSync: (path: Fs.PathLike) => {
      if (control.failCleanup && String(path).endsWith(".tmp")) throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
      return actual.unlinkSync(path);
    },
    fsyncSync: (handle: number) => {
      control.beforeSync?.(handle);
      control.fsyncCalls += 1;
      if (control.fsyncCalls >= control.failFsyncFromCall) {
        throw Object.assign(new Error('EIO: injected fsync failure'), { code: 'EIO' });
      }
      return actual.fsyncSync(handle);
    },
  };
});

import {
  CLEANUP_OPERATION_RECORD_SCHEMA,
  CleanupOperationRecordError,
  readCleanupOperationRecord,
  saveCleanupOperationRecord,
  type CleanupOperationQueryRecord,
  type CleanupOperationRequest,
} from '../cleanup-operation-record.js';
import { cleanupBrokerExecutionDigest } from '../internal/cleanup-broker-digest.js';
import {
  snapshotAllowingNothing,
  snapshotAllowingOutbox,
  snapshotDenyingOutbox,
} from './helpers/cleanup-record-snapshot.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cleanup-record-durability-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

beforeEach(() => {
  control.failFsyncFromCall = Number.POSITIVE_INFINITY;
  control.fsyncCalls = 0;
  control.zeroProgress = false;
  control.shortWriteOnce = false;
  control.beforeSync = null;
  control.failCleanup = false;
});

function request(overrides: Partial<CleanupOperationRequest> = {}): CleanupOperationRequest {
  return {
    schema: 'openslack.cleanup_request.v1',
    mode: 'execute',
    agentId: 'openslack-agent-operator',
    principalId: 'agent.test',
    runtimeUid: '44180',
    runId: 'run-0001',
    repo: 'Negentropy-Laby/OpenSlack',
    remote: 'origin',
    prNumber: 418,
    permitId: 'PERMIT-0001',
    operationId: 'OP-0001',
    ...overrides,
  };
}

function record(overrides: Partial<CleanupOperationRequest> = {}): CleanupOperationQueryRecord {
  const value = request(overrides);
  return {
    schema: CLEANUP_OPERATION_RECORD_SCHEMA,
    createdAt: '2026-09-21T00:00:00.000Z',
    request: value,
    requestDigest: cleanupBrokerExecutionDigest(value),
  };
}

describe('R18-03 reuse must re-establish durability', () => {
  it('reuses an identical record when durability can be re-established', () => {
    const root = temporaryRoot();
    expect(saveCleanupOperationRecord(record(), { rootDir: root, snapshot: snapshotAllowingOutbox() }).status).toBe('published');
    const fsyncsAfterPublish = control.fsyncCalls;
    expect(saveCleanupOperationRecord(record(), { rootDir: root, snapshot: snapshotAllowingOutbox() }).status).toBe('reused');
    // Reuse must actually sync, rather than trusting the earlier publish.
    expect(control.fsyncCalls).toBeGreaterThan(fsyncsAfterPublish);
  });

  it('refuses to reuse when the re-sync fails, instead of reporting success', () => {
    const root = temporaryRoot();
    expect(saveCleanupOperationRecord(record(), { rootDir: root, snapshot: snapshotAllowingOutbox() }).status).toBe('published');
    // Every fsync from the second call onward fails: the reuse cannot prove
    // durability, so it must refuse rather than bypass the earlier failure.
    control.failFsyncFromCall = control.fsyncCalls + 1;
    expect(() => saveCleanupOperationRecord(record(), { rootDir: root, snapshot: snapshotAllowingOutbox() })).toThrowError(
      expect.objectContaining({ code: 'PERSISTENCE_FAILED' }) as unknown as Error,
    );
  });

  it('still refuses a different binding for an existing operation', () => {
    const root = temporaryRoot();
    saveCleanupOperationRecord(record(), { rootDir: root, snapshot: snapshotAllowingOutbox() });
    expect(() =>
      saveCleanupOperationRecord(record({ permitId: 'PERMIT-0002' }), { rootDir: root, snapshot: snapshotAllowingOutbox() }),
    ).toThrowError(expect.objectContaining({ code: 'BINDING_CONFLICT' }) as unknown as Error);
  });
});

describe('R18-08 writes must complete or refuse', () => {
  it('completes a short write by looping and publishes complete bytes', () => {
    const root = temporaryRoot();
    control.shortWriteOnce = true;
    const saved = saveCleanupOperationRecord(record(), { rootDir: root, snapshot: snapshotAllowingOutbox() });
    expect(saved.status).toBe('published');
    // The published record must be complete and decodable.
    expect(readCleanupOperationRecord(saved.path).requestDigest).toBe(record().requestDigest);
  });

  it('refuses when a write makes no progress', () => {
    const root = temporaryRoot();
    control.zeroProgress = true;
    expect(() => saveCleanupOperationRecord(record(), { rootDir: root, snapshot: snapshotAllowingOutbox() })).toThrowError(
      expect.objectContaining({ code: 'PERSISTENCE_FAILED' }) as unknown as Error,
    );
  });

  it('leaves no published record when a write fails', () => {
    const root = temporaryRoot();
    control.zeroProgress = true;
    expect(() => saveCleanupOperationRecord(record(), { rootDir: root, snapshot: snapshotAllowingOutbox() })).toThrowError(
      CleanupOperationRecordError,
    );
    control.zeroProgress = false;
    const directory = join(root, '.openslack', 'outbox', 'cleanup-operations');
    let entries: string[] = [];
    try {
      entries = readdirSync(directory);
    } catch {
      entries = [];
    }
    expect(entries.filter((name) => name.endsWith('.json'))).toEqual([]);
  });
});

describe('R18-02 publication requires authorization', () => {
  const outbox = (root: string) => join(root, '.openslack', 'outbox', 'cleanup-operations');

  it('creates no directory and writes no record when the path is denied', () => {
    const root = temporaryRoot();
    expect(() =>
      saveCleanupOperationRecord(record(), {
        rootDir: root,
        snapshot: snapshotDenyingOutbox(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'BLOCKED_AUTHORIZATION' }) as unknown as Error);

    // A denial must leave nothing behind, not even the outbox directory.
    expect(existsSync(join(root, '.openslack'))).toBe(false);
    expect(existsSync(outbox(root))).toBe(false);
  });

  it('creates nothing when the allow list does not cover the record path', () => {
    const root = temporaryRoot();
    expect(() =>
      saveCleanupOperationRecord(record(), {
        rootDir: root,
        snapshot: snapshotAllowingNothing(),
      }),
    ).toThrowError(expect.objectContaining({ code: 'BLOCKED_AUTHORIZATION' }) as unknown as Error);
    expect(existsSync(join(root, '.openslack'))).toBe(false);
  });

  it('creates nothing for an unknown principal', () => {
    const root = temporaryRoot();
    expect(() =>
      saveCleanupOperationRecord(record(), { rootDir: root, snapshot: null }),
    ).toThrowError(expect.objectContaining({ code: 'BLOCKED_AUTHORIZATION' }) as unknown as Error);
    expect(existsSync(join(root, '.openslack'))).toBe(false);
  });

  it('publishes when the path is allowed', () => {
    const root = temporaryRoot();
    const saved = saveCleanupOperationRecord(record(), {
      rootDir: root,
      snapshot: snapshotAllowingOutbox(),
    });
    expect(saved.status).toBe('published');
    expect(existsSync(saved.path)).toBe(true);
  });
});

describe('R18-07 file boundaries', () => {
  const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';

  it('rejects a symlinked ancestor directory on publish', () => {
    const root = temporaryRoot();
    const real = join(root, 'real');
    mkdirSync(real, { recursive: true });
    const link = join(root, 'linked-root');
    symlinkSync(real, link, directoryLink);

    // Writing through the alias would place the record outside the workspace.
    expect(() => saveCleanupOperationRecord(record(), { rootDir: link, snapshot: snapshotAllowingOutbox() })).toThrowError(
      expect.objectContaining({ code: 'SYMLINK_REJECTED' }) as unknown as Error,
    );
  });

  it('rejects a symlinked ancestor directory on read', () => {
    const root = temporaryRoot();
    const real = join(root, 'real');
    mkdirSync(real, { recursive: true });
    const saved = saveCleanupOperationRecord(record(), { rootDir: real, snapshot: snapshotAllowingOutbox() });
    const link = join(root, 'linked-read');
    symlinkSync(real, link, directoryLink);

    const aliased = saved.path.replace(real, link);
    expect(() => readCleanupOperationRecord(aliased)).toThrowError(
      expect.objectContaining({ code: 'SYMLINK_REJECTED' }) as unknown as Error,
    );
  });

  it('rejects an oversized record without reading it whole', () => {
    const root = temporaryRoot();
    const directory = join(root, '.openslack', 'outbox', 'cleanup-operations');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'OP-BIG.json');
    writeFileSync(path, `{"schema":"${CLEANUP_OPERATION_RECORD_SCHEMA}","pad":"${'x'.repeat(40_000)}"}`);

    expect(() => readCleanupOperationRecord(path)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RECORD' }) as unknown as Error,
    );
  });
});


describe('Q1–Q3 publication boundary regressions', () => {
  it('creates nothing outside a statically symlinked .openslack directory', () => {
    const workspace = temporaryRoot(), external = temporaryRoot();
    symlinkSync(external, join(workspace, '.openslack'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => saveCleanupOperationRecord(record(), {rootDir: workspace, snapshot: snapshotAllowingOutbox()})).toThrow();
    expect(readdirSync(external)).toEqual([]);
  });

  it('removes its temporary inode after publication and reuse', () => {
    const root = temporaryRoot();
    const first = saveCleanupOperationRecord(record(), {rootDir: root, snapshot: snapshotAllowingOutbox()});
    const second = saveCleanupOperationRecord(record(), {rootDir: root, snapshot: snapshotAllowingOutbox()});
    expect(second.status).toBe('reused');
    expect(readdirSync(join(root, '.openslack/outbox/cleanup-operations'))).toEqual(['OP-0001.json']);
    expect(readFileSync(first.path, 'utf8')).toContain('PERMIT-0001');
  });

  it('refuses a record replaced between read and fsync', () => {
    const root = temporaryRoot();
    const saved = saveCleanupOperationRecord(record(), {rootDir: root, snapshot: snapshotAllowingOutbox()});
    let replaced = false;
    control.beforeSync = () => {
      if (replaced) return;
      replaced = true;
      renameSync(saved.path, saved.path + '.held');
      writeFileSync(saved.path, JSON.stringify(record({permitId: 'PERMIT-0002'})), {mode: 0o600});
    };
    expect(() => saveCleanupOperationRecord(record(), {rootDir: root, snapshot: snapshotAllowingOutbox()})).toThrow();
    expect(replaced).toBe(true);
    expect(readFileSync(saved.path, 'utf8')).toContain('PERMIT-0002');
  });

  it('refuses success when owned-temp cleanup fails', () => {
    const root = temporaryRoot();
    control.failCleanup = true;
    expect(() => saveCleanupOperationRecord(record(), {rootDir: root, snapshot: snapshotAllowingOutbox()})).toThrow();
  });
});
