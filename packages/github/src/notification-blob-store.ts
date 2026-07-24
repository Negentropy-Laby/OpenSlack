import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { NOTIFICATION_HANDOFF_POLICY } from './notification-handoff-contracts.js';
import {
  cleanupNotificationTemporary,
  ensureSecureNotificationDirectory,
  fsyncNotificationDirectory,
  isNodeError,
  temporaryNotificationPath,
  withNotificationStorageLock,
  type NotificationStorageLockOptions,
} from './notification-storage-fs.js';

export const NOTIFICATION_BLOB_STORE_RELATIVE_PATH = join(
  '.openslack.local',
  'daemon',
  'blobs',
  'sha256',
);
const NOTIFICATION_BLOB_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type NotificationBlobStoreErrorCode =
  | 'BLOB_DIGEST_INVALID'
  | 'BLOB_SIZE_MISMATCH'
  | 'BLOB_DIGEST_MISMATCH'
  | 'BLOB_NOT_FOUND'
  | 'BLOB_FILE_UNSAFE'
  | 'BLOB_PATH_UNSAFE'
  | 'BLOB_QUOTA_EXCEEDED'
  | 'BLOB_READ_RACE'
  | 'BLOB_LOCK_TIMEOUT';

export class NotificationBlobStoreError extends Error {
  constructor(
    readonly code: NotificationBlobStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NotificationBlobStoreError';
  }
}

export interface NotificationBlobStoreOptions extends NotificationStorageLockOptions {
  rootPath: string;
  maxBytes?: number;
  warningRatio?: number;
}

export interface NotificationBlobInput {
  bytes: Uint8Array;
  digest: `sha256:${string}`;
  size: number;
}

export interface NotificationBlobPutResult {
  digest: `sha256:${string}`;
  path: string;
  size: number;
  created: boolean;
  usedBytes: number;
  warning: boolean;
}

export interface NotificationBlobReadResult {
  digest: `sha256:${string}`;
  bytes: Uint8Array;
  size: number;
}

export interface NotificationBlobVerifyResult {
  digest: `sha256:${string}`;
  size: number;
}

export interface NotificationBlobGcInput {
  activeDigests: ReadonlySet<string>;
  eligibleDigests: ReadonlySet<string>;
}

export interface NotificationBlobGcResult {
  removedDigests: string[];
  reclaimedBytes: number;
  usedBytes: number;
  warning: boolean;
}

export function notificationBlobStorePath(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), NOTIFICATION_BLOB_STORE_RELATIVE_PATH);
}

export class NotificationBlobStore {
  readonly rootPath: string;
  readonly maxBytes: number;
  readonly warningRatio: number;
  private readonly lockOptions: NotificationStorageLockOptions;
  private readonly nonce: () => string;

  constructor(options: NotificationBlobStoreOptions) {
    if (
      !Number.isSafeInteger(options.maxBytes ?? NOTIFICATION_HANDOFF_POLICY.blobStoreMaxBytes) ||
      (options.maxBytes ?? NOTIFICATION_HANDOFF_POLICY.blobStoreMaxBytes) <= 0
    ) {
      throw new TypeError('maxBytes must be a positive safe integer');
    }
    const warningRatio = options.warningRatio ?? NOTIFICATION_HANDOFF_POLICY.blobStoreWarningRatio;
    if (!Number.isFinite(warningRatio) || warningRatio <= 0 || warningRatio > 1) {
      throw new TypeError('warningRatio must be greater than 0 and at most 1');
    }
    try {
      this.rootPath = ensureSecureNotificationDirectory(options.rootPath);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'STORAGE_PATH_UNSAFE') {
        throw blobError('BLOB_PATH_UNSAFE', 'Notification Blob store path is unsafe.');
      }
      throw error;
    }
    this.maxBytes = options.maxBytes ?? NOTIFICATION_HANDOFF_POLICY.blobStoreMaxBytes;
    this.warningRatio = warningRatio;
    this.nonce = options.nonce ?? randomUUID;
    this.lockOptions = {
      ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
      ...(options.lockStaleMs === undefined ? {} : { lockStaleMs: options.lockStaleMs }),
      nonce: this.nonce,
    };
  }

  pathFor(digest: string): string {
    const hex = parseBlobDigest(digest);
    return join(this.rootPath, hex.slice(0, 2), hex);
  }

  put(input: NotificationBlobInput): NotificationBlobPutResult {
    const bytes = Buffer.from(input.bytes);
    const digest = checkedDigest(input.digest);
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size !== bytes.byteLength) {
      throw blobError('BLOB_SIZE_MISMATCH', 'Notification Blob size does not match its bytes.');
    }
    if (sha256(bytes) !== digest) {
      throw blobError('BLOB_DIGEST_MISMATCH', 'Notification Blob digest does not match its bytes.');
    }

    return this.withLock(() => {
      const path = this.pathFor(digest);
      const directory = ensureSecureNotificationDirectory(join(this.rootPath, digest.slice(7, 9)));
      if (existsSync(path)) {
        verifyBlobFile(path, digest, input.size);
        const usedBytes = this.scanUsage();
        return this.putResult(digest, path, input.size, false, usedBytes);
      }

      const usedBefore = this.scanUsage();
      if (usedBefore + input.size > this.maxBytes) {
        throw blobError(
          'BLOB_QUOTA_EXCEEDED',
          'Notification Blob store capacity would be exceeded.',
        );
      }
      const temporary = temporaryNotificationPath(directory, digest.slice(7), this.nonce);
      let descriptor: number | null = null;
      let created = false;
      try {
        descriptor = openSync(temporary, 'wx', 0o600);
        writeFileSync(descriptor, bytes);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = null;
        try {
          linkSync(temporary, path);
          created = true;
          fsyncNotificationDirectory(directory);
        } catch (error) {
          if (!isNodeError(error, 'EEXIST')) throw error;
        }
        verifyBlobFile(path, digest, input.size);
      } finally {
        if (descriptor !== null) {
          try {
            closeSync(descriptor);
          } catch {
            // Best-effort descriptor cleanup; the original error remains authoritative.
          }
        }
        cleanupNotificationTemporary(temporary);
        fsyncNotificationDirectory(directory);
      }
      const usedBytes = created ? usedBefore + input.size : this.scanUsage();
      return this.putResult(digest, path, input.size, created, usedBytes);
    });
  }

  read(digest: string): NotificationBlobReadResult {
    const checked = checkedDigest(digest);
    return this.withLock(() => {
      const path = this.pathFor(checked);
      const directory = join(this.rootPath, checked.slice(7, 9));
      if (!existsSync(directory)) {
        throw blobError('BLOB_NOT_FOUND', 'Notification Blob is not available.');
      }
      ensureSecureNotificationDirectory(directory);
      if (!existsSync(path)) {
        throw blobError('BLOB_NOT_FOUND', 'Notification Blob is not available.');
      }
      const verified = verifyBlobFile(path, checked);
      return { digest: checked, bytes: verified.bytes, size: verified.bytes.byteLength };
    });
  }

  /**
   * Verifies the complete content-addressed Blob without returning its bytes to
   * payload-blind callers such as doctor and governed recovery.
   */
  verify(digest: string, expectedSize?: number): NotificationBlobVerifyResult {
    return this.withVerifiedBlob(digest, expectedSize, (verified) => verified);
  }

  /**
   * Keeps the Blob-store lock held while a queue owner commits a transition
   * that makes the verified Blob active. Callers must acquire queue-v2 before
   * entering this method.
   */
  withVerifiedBlob<T>(
    digest: string,
    expectedSize: number | undefined,
    operation: (verified: NotificationBlobVerifyResult) => T,
  ): T {
    const checked = checkedDigest(digest);
    if (expectedSize !== undefined && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
      throw blobError('BLOB_SIZE_MISMATCH', 'Expected Notification Blob size is invalid.');
    }
    return this.withLock(() => {
      const path = this.pathFor(checked);
      const directory = join(this.rootPath, checked.slice(7, 9));
      if (!existsSync(directory)) {
        throw blobError('BLOB_NOT_FOUND', 'Notification Blob is not available.');
      }
      ensureSecureNotificationDirectory(directory);
      if (!existsSync(path)) {
        throw blobError('BLOB_NOT_FOUND', 'Notification Blob is not available.');
      }
      const verified = verifyBlobFile(path, checked, expectedSize);
      return operation({ digest: checked, size: verified.bytes.byteLength });
    });
  }

  usage(): { usedBytes: number; warning: boolean } {
    return this.withLock(() => {
      const usedBytes = this.scanUsage();
      return { usedBytes, warning: this.isWarning(usedBytes) };
    });
  }

  collectGarbage(input: NotificationBlobGcInput): NotificationBlobGcResult {
    const active = validateDigestSet(input.activeDigests);
    const eligible = validateDigestSet(input.eligibleDigests);
    return this.withLock(() => {
      const removedDigests: string[] = [];
      let reclaimedBytes = 0;
      for (const digest of [...eligible].sort()) {
        if (active.has(digest)) continue;
        const path = this.pathFor(digest);
        const directory = join(this.rootPath, digest.slice(7, 9));
        if (!existsSync(directory)) continue;
        ensureSecureNotificationDirectory(directory);
        if (!existsSync(path)) continue;
        const verified = verifyBlobFile(path, digest);
        const current = lstatSync(path, { bigint: true });
        if (
          current.isSymbolicLink() ||
          !current.isFile() ||
          current.dev !== verified.dev ||
          current.ino !== verified.ino
        ) {
          throw blobError('BLOB_READ_RACE', 'Notification Blob changed before garbage collection.');
        }
        unlinkSync(path);
        fsyncNotificationDirectory(directory);
        removedDigests.push(digest);
        reclaimedBytes += verified.bytes.byteLength;
      }
      const usedBytes = this.scanUsage();
      return {
        removedDigests,
        reclaimedBytes,
        usedBytes,
        warning: this.isWarning(usedBytes),
      };
    });
  }

  private putResult(
    digest: `sha256:${string}`,
    path: string,
    size: number,
    created: boolean,
    usedBytes: number,
  ): NotificationBlobPutResult {
    return { digest, path, size, created, usedBytes, warning: this.isWarning(usedBytes) };
  }

  private isWarning(usedBytes: number): boolean {
    return usedBytes / this.maxBytes >= this.warningRatio;
  }

  private scanUsage(): number {
    let total = 0;
    for (const entry of readdirSync(this.rootPath, { withFileTypes: true })) {
      if (entry.name === '.blob-store.lock' || entry.name === '.blob-store.lock.reclaim') {
        const lockStatus = lstatSync(join(this.rootPath, entry.name));
        if (
          entry.isSymbolicLink() ||
          lockStatus.isSymbolicLink() ||
          !entry.isFile() ||
          !lockStatus.isFile() ||
          (process.platform !== 'win32' && (lockStatus.mode & 0o777) !== 0o600)
        ) {
          throw blobError('BLOB_PATH_UNSAFE', 'Notification Blob store lock path is unsafe.');
        }
        continue;
      }
      const prefixPath = join(this.rootPath, entry.name);
      const prefixStatus = lstatSync(prefixPath);
      if (
        !/^[0-9a-f]{2}$/u.test(entry.name) ||
        entry.isSymbolicLink() ||
        prefixStatus.isSymbolicLink() ||
        !entry.isDirectory() ||
        !prefixStatus.isDirectory()
      ) {
        throw blobError('BLOB_PATH_UNSAFE', 'Notification Blob store contains an unsafe entry.');
      }
      if (process.platform !== 'win32' && (prefixStatus.mode & 0o777) !== 0o700) {
        throw blobError('BLOB_PATH_UNSAFE', 'Notification Blob prefix permissions must be 0700.');
      }
      for (const blobEntry of readdirSync(prefixPath, { withFileTypes: true })) {
        if (blobEntry.name.startsWith('.')) {
          const temporaryStatus = lstatSync(join(prefixPath, blobEntry.name));
          if (temporaryStatus.isSymbolicLink() || !temporaryStatus.isFile()) {
            throw blobError(
              'BLOB_FILE_UNSAFE',
              'Notification Blob store contains an unsafe temporary entry.',
            );
          }
          if (process.platform !== 'win32' && (temporaryStatus.mode & 0o777) !== 0o600) {
            throw blobError(
              'BLOB_FILE_UNSAFE',
              'Notification Blob temporary file permissions must be 0600.',
            );
          }
          total += temporaryStatus.size;
          continue;
        }
        if (!/^[0-9a-f]{64}$/u.test(blobEntry.name) || blobEntry.name.slice(0, 2) !== entry.name) {
          throw blobError(
            'BLOB_PATH_UNSAFE',
            'Notification Blob store contains an invalid digest path.',
          );
        }
        const status = lstatSync(join(prefixPath, blobEntry.name));
        if (blobEntry.isSymbolicLink() || status.isSymbolicLink() || !status.isFile()) {
          throw blobError('BLOB_FILE_UNSAFE', 'Notification Blob path is not a regular file.');
        }
        if (process.platform !== 'win32' && (status.mode & 0o777) !== 0o600) {
          throw blobError('BLOB_FILE_UNSAFE', 'Notification Blob file permissions must be 0600.');
        }
        total += status.size;
      }
    }
    return total;
  }

  private withLock<T>(operation: () => T): T {
    try {
      return withNotificationStorageLock(
        this.rootPath,
        '.blob-store.lock',
        this.lockOptions,
        operation,
      );
    } catch (error) {
      if ((error as { code?: unknown }).code === 'STORAGE_LOCK_TIMEOUT') {
        throw blobError(
          'BLOB_LOCK_TIMEOUT',
          'Timed out waiting for the Notification Blob store lock.',
        );
      }
      if ((error as { code?: unknown }).code === 'STORAGE_PATH_UNSAFE') {
        throw blobError('BLOB_PATH_UNSAFE', 'Notification Blob store path is unsafe.');
      }
      throw error;
    }
  }
}

function verifyBlobFile(
  path: string,
  digest: `sha256:${string}`,
  expectedSize?: number,
): { bytes: Buffer; dev: number | bigint; ino: number | bigint } {
  const beforePath = lstatSync(path, { bigint: true });
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) {
    throw blobError('BLOB_FILE_UNSAFE', 'Notification Blob path is not a regular file.');
  }
  if (process.platform !== 'win32' && (Number(beforePath.mode) & 0o777) !== 0o600) {
    throw blobError('BLOB_FILE_UNSAFE', 'Notification Blob file permissions must be 0600.');
  }
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino) {
      throw blobError('BLOB_READ_RACE', 'Notification Blob changed while it was opened.');
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.dev !== before.dev ||
      afterPath.ino !== before.ino
    ) {
      throw blobError('BLOB_READ_RACE', 'Notification Blob changed while it was read.');
    }
    if (expectedSize !== undefined && bytes.byteLength !== expectedSize) {
      throw blobError('BLOB_SIZE_MISMATCH', 'Stored Notification Blob has an unexpected size.');
    }
    if (sha256(bytes) !== digest) {
      throw blobError('BLOB_DIGEST_MISMATCH', 'Stored Notification Blob has an unexpected digest.');
    }
    return { bytes, dev: after.dev, ino: after.ino };
  } finally {
    closeSync(descriptor);
  }
}

function validateDigestSet(values: ReadonlySet<string>): Set<`sha256:${string}`> {
  const result = new Set<`sha256:${string}`>();
  for (const value of values) result.add(checkedDigest(value));
  return result;
}

function parseBlobDigest(value: string): string {
  if (!NOTIFICATION_BLOB_DIGEST_PATTERN.test(value)) {
    throw blobError(
      'BLOB_DIGEST_INVALID',
      'Notification Blob digest must be sha256:<64 lowercase hex>.',
    );
  }
  return value.slice(7);
}

function checkedDigest(value: string): `sha256:${string}` {
  parseBlobDigest(value);
  return value as `sha256:${string}`;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function blobError(
  code: NotificationBlobStoreErrorCode,
  message: string,
): NotificationBlobStoreError {
  return new NotificationBlobStoreError(code, message);
}
