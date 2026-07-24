import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NotificationBlobStore,
  notificationBlobStorePath,
  type NotificationBlobInput,
} from '../notification-blob-store.js';

const workerPath = fileURLToPath(
  new URL('../__fixtures__/notification-storage-worker.ts', import.meta.url),
);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('NotificationBlobStore', () => {
  it('publishes content-addressed bytes with durable permissions and verifies reads', () => {
    const workspace = temporaryRoot();
    const store = new NotificationBlobStore({ rootPath: notificationBlobStorePath(workspace) });
    const input = blob('hello blob');

    expect(store.maxBytes).toBe(1_073_741_824);
    expect(store.warningRatio).toBe(0.8);

    const result = store.put(input);

    expect(result).toMatchObject({
      digest: input.digest,
      size: input.size,
      created: true,
      usedBytes: input.size,
      warning: false,
    });
    expect(result.path).toBe(join(store.rootPath, input.digest.slice(7, 9), input.digest.slice(7)));
    expect(store.verify(input.digest, input.size)).toEqual({
      digest: input.digest,
      size: input.size,
    });
    expect(Buffer.from(store.read(input.digest).bytes).toString('utf8')).toBe('hello blob');
    expect(lstatSync(result.path).isFile()).toBe(true);
    expect(lstatSync(result.path).nlink).toBe(1);
    if (process.platform !== 'win32') {
      expect(lstatSync(store.rootPath).mode & 0o777).toBe(0o700);
      expect(lstatSync(result.path).mode & 0o777).toBe(0o600);
    }
  });

  it('enforces quota, reports the 80% warning, and permits verified idempotent puts', () => {
    const store = new NotificationBlobStore({ rootPath: temporaryRoot(), maxBytes: 10 });
    const first = blob('12345678');

    expect(store.put(first)).toMatchObject({ created: true, usedBytes: 8, warning: true });
    expect(store.put(first)).toMatchObject({ created: false, usedBytes: 8, warning: true });
    expect(() => store.put(blob('abc'))).toThrowError(
      expect.objectContaining({ code: 'BLOB_QUOTA_EXCEEDED' }),
    );
    expect(store.usage()).toEqual({ usedBytes: 8, warning: true });
  });

  it('fails closed for mismatched input and re-verifies existing content', () => {
    const store = new NotificationBlobStore({ rootPath: temporaryRoot(), maxBytes: 100 });
    const input = blob('original');
    expect(() => store.put({ ...input, size: input.size + 1 })).toThrowError(
      expect.objectContaining({ code: 'BLOB_SIZE_MISMATCH' }),
    );
    expect(() => store.put({ ...input, digest: blob('different').digest })).toThrowError(
      expect.objectContaining({ code: 'BLOB_DIGEST_MISMATCH' }),
    );
    const result = store.put(input);
    writeFileSync(result.path, 'tampered', 'utf8');
    expect(() => store.verify(input.digest, input.size)).toThrowError(
      expect.objectContaining({ code: 'BLOB_DIGEST_MISMATCH' }),
    );
    expect(() => store.put(input)).toThrowError(
      expect.objectContaining({ code: 'BLOB_DIGEST_MISMATCH' }),
    );
  });

  it('never evicts active content and only removes caller-supplied eligible digests', () => {
    const store = new NotificationBlobStore({ rootPath: temporaryRoot(), maxBytes: 100 });
    const active = blob('active');
    const eligible = blob('eligible');
    const unlisted = blob('unlisted');
    for (const input of [active, eligible, unlisted]) store.put(input);

    const result = store.collectGarbage({
      activeDigests: new Set([active.digest]),
      eligibleDigests: new Set([active.digest, eligible.digest]),
    });

    expect(result.removedDigests).toEqual([eligible.digest]);
    expect(result.reclaimedBytes).toBe(eligible.size);
    expect(existsSync(store.pathFor(active.digest))).toBe(true);
    expect(existsSync(store.pathFor(unlisted.digest))).toBe(true);
    expect(existsSync(store.pathFor(eligible.digest))).toBe(false);
    expect(() =>
      store.collectGarbage({ activeDigests: new Set(), eligibleDigests: new Set(['../escape']) }),
    ).toThrowError(expect.objectContaining({ code: 'BLOB_DIGEST_INVALID' }));
  });

  it('rejects digest path escape, directory targets and linked prefix paths', () => {
    const root = temporaryRoot();
    const store = new NotificationBlobStore({ rootPath: root, maxBytes: 100 });
    expect(() => store.pathFor('../escape')).toThrowError(
      expect.objectContaining({ code: 'BLOB_DIGEST_INVALID' }),
    );

    const directoryInput = blob('directory-target');
    mkdirSync(dirname(store.pathFor(directoryInput.digest)), { recursive: true, mode: 0o700 });
    mkdirSync(store.pathFor(directoryInput.digest));
    expect(() => store.put(directoryInput)).toThrowError(
      expect.objectContaining({ code: 'BLOB_FILE_UNSAFE' }),
    );

    const linkedRoot = temporaryRoot();
    const linkedStore = new NotificationBlobStore({ rootPath: linkedRoot, maxBytes: 100 });
    const linkedInput = blob('linked-prefix');
    const outside = temporaryRoot();
    symlinkSync(outside, join(linkedRoot, linkedInput.digest.slice(7, 9)), 'junction');
    expect(() => linkedStore.put(linkedInput)).toThrowError(
      expect.objectContaining({ code: 'BLOB_PATH_UNSAFE' }),
    );
  });

  it('rejects a symlinked destination when file links are available', () => {
    const root = temporaryRoot();
    const store = new NotificationBlobStore({ rootPath: root, maxBytes: 100 });
    const input = blob('symlink-target');
    const path = store.pathFor(input.digest);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const outside = join(temporaryRoot(), 'outside');
    writeFileSync(outside, input.bytes);
    try {
      symlinkSync(outside, path, 'file');
    } catch {
      return;
    }
    expect(() => store.put(input)).toThrowError(
      expect.objectContaining({ code: 'BLOB_FILE_UNSAFE' }),
    );
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO destination', () => {
    const root = temporaryRoot();
    const store = new NotificationBlobStore({ rootPath: root, maxBytes: 100 });
    const input = blob('fifo-target');
    const path = store.pathFor(input.digest);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    execFileSync('mkfifo', [path]);
    expect(() => store.put(input)).toThrowError(
      expect.objectContaining({ code: 'BLOB_FILE_UNSAFE' }),
    );
  });

  it.skipIf(process.platform === 'win32')('fails closed for permissive existing paths', () => {
    const looseRoot = temporaryRoot();
    chmodSync(looseRoot, 0o755);
    expect(() => new NotificationBlobStore({ rootPath: looseRoot })).toThrowError(
      expect.objectContaining({ code: 'BLOB_PATH_UNSAFE' }),
    );

    const store = new NotificationBlobStore({ rootPath: temporaryRoot(), maxBytes: 100 });
    const input = blob('permissions');
    const result = store.put(input);
    chmodSync(dirname(result.path), 0o755);
    expect(() => store.read(input.digest)).toThrowError(
      expect.objectContaining({ code: 'BLOB_PATH_UNSAFE' }),
    );
    chmodSync(dirname(result.path), 0o700);
    chmodSync(result.path, 0o644);
    expect(() => store.read(input.digest)).toThrowError(
      expect.objectContaining({ code: 'BLOB_FILE_UNSAFE' }),
    );

    const orphanRoot = temporaryRoot();
    const orphanStore = new NotificationBlobStore({ rootPath: orphanRoot, maxBytes: 100 });
    const orphanPrefix = join(orphanRoot, 'aa');
    mkdirSync(orphanPrefix, { mode: 0o700 });
    const orphanPath = join(orphanPrefix, '.orphan');
    writeFileSync(orphanPath, 'temporary', { mode: 0o600 });
    chmodSync(orphanPath, 0o644);
    expect(() => orphanStore.usage()).toThrowError(
      expect.objectContaining({ code: 'BLOB_FILE_UNSAFE' }),
    );
  });

  it('serializes multi-process publish races without duplicate capacity', async () => {
    const root = temporaryRoot();
    const encoded = Buffer.from('concurrent-content').toString('base64');
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runWorker(['blob-put', root, encoded, '1024'])),
    );

    expect(
      results.every((result) => result.code === 0),
      JSON.stringify(results),
    ).toBe(true);
    const created = results.map((result) => JSON.parse(result.stdout) as { created: boolean });
    expect(created.filter((result) => result.created)).toHaveLength(1);
    expect(new NotificationBlobStore({ rootPath: root, maxBytes: 1024 }).usage().usedBytes).toBe(
      Buffer.byteLength('concurrent-content'),
    );
  });

  it('serializes quota decisions across competing processes', async () => {
    const root = temporaryRoot();
    const results = await Promise.all([
      runWorker(['blob-put', root, Buffer.alloc(600, 'a').toString('base64'), '1000']),
      runWorker(['blob-put', root, Buffer.alloc(600, 'b').toString('base64'), '1000']),
    ]);

    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(results.filter((result) => result.code !== 0)).toHaveLength(1);
    expect(new NotificationBlobStore({ rootPath: root, maxBytes: 1000 }).usage().usedBytes).toBe(
      600,
    );
  });

  it('keeps read and GC races locked and never returns torn bytes', async () => {
    const root = temporaryRoot();
    const input = blob('read-gc-race');
    new NotificationBlobStore({ rootPath: root, maxBytes: 1024 }).put(input);

    const [reader, collector] = await Promise.all([
      runWorker(['blob-read-loop', root, input.digest, '1024']),
      runWorker(['blob-gc', root, input.digest, '1024']),
    ]);

    expect(reader.code, reader.stderr).toBe(0);
    expect(collector.code, collector.stderr).toBe(0);
    const readResult = JSON.parse(reader.stdout) as { reads: number; missing: number };
    expect(readResult.reads + readResult.missing).toBe(30);
  });

  it('elects one stale-lock reclaimer without deleting a successor lock', async () => {
    const root = temporaryRoot();
    const lockName = '.stale-reclaim.lock';
    const lockPath = join(root, lockName);
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 999_999, nonce: 'stale-owner', created_at: new Date().toISOString() }),
      { encoding: 'utf8', mode: 0o600 },
    );
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => runWorker(['storage-lock', root, lockName, '25'])),
    );

    expect(
      results.every((result) => result.code === 0),
      JSON.stringify(results),
    ).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-notification-blob-'));
  temporaryRoots.push(root);
  return root;
}

function blob(value: string): NotificationBlobInput {
  const bytes = Buffer.from(value, 'utf8');
  return {
    bytes,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.byteLength,
  };
}

function runWorker(
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', workerPath, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
