import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { parse, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface NotificationStorageLockOptions {
  lockTimeoutMs?: number;
  lockStaleMs?: number;
  nonce?: () => string;
}

export function ensureSecureNotificationDirectory(path: string): string {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const segment of absolute
    .slice(root.length)
    .split(/[\\/]+/u)
    .filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
    }
    const status = lstatSync(current);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw notificationStorageError(
        'STORAGE_PATH_UNSAFE',
        'Notification storage path contains a link, junction or non-directory component.',
      );
    }
  }
  const finalStatus = lstatSync(absolute);
  if (process.platform !== 'win32' && (finalStatus.mode & 0o777) !== 0o700) {
    throw notificationStorageError(
      'STORAGE_PATH_UNSAFE',
      'Notification storage directory permissions must be 0700.',
    );
  }
  return absolute;
}

export function fsyncNotificationDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function withNotificationStorageLock<T>(
  rootPath: string,
  lockName: string,
  options: NotificationStorageLockOptions,
  operation: () => T,
): T {
  const root = ensureSecureNotificationDirectory(rootPath);
  const lockPath = join(root, lockName);
  const reclaimPath = `${lockPath}.reclaim`;
  const timeout = options.lockTimeoutMs ?? 5_000;
  const stale = options.lockStaleMs ?? 30_000;
  const nonceFactory = options.nonce ?? randomUUID;
  const nonce = nonceFactory();
  const deadline = Date.now() + timeout;
  while (true) {
    if (existsSync(reclaimPath)) {
      try {
        assertSecureLockFile(reclaimPath);
      } catch (error) {
        // The elected reclaimer may finish between the existence probe and
        // this inspection. Retry acquisition, but continue to fail closed for
        // links, non-regular files, or unsafe permissions.
        if (isTransientLockInspectionRace(error)) continue;
        throw error;
      }
      if (Date.now() >= deadline) {
        throw notificationStorageError(
          'STORAGE_LOCK_TIMEOUT',
          'Timed out waiting for notification storage lock reclamation.',
        );
      }
      blockFor(Math.min(25, Math.max(1, deadline - Date.now())));
      continue;
    }
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600);
      try {
        writeFileSync(
          descriptor,
          JSON.stringify({ pid: process.pid, nonce, created_at: new Date().toISOString() }),
          'utf8',
        );
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      fsyncNotificationDirectory(root);
      break;
    } catch (error) {
      if (
        !isNodeError(error, 'EEXIST') &&
        !(process.platform === 'win32' && isNodeError(error, 'EPERM'))
      ) {
        throw error;
      }
      try {
        assertSecureLockFile(lockPath);
      } catch (statusError) {
        // The previous owner may release the lock between our EEXIST result and
        // this inspection. Windows may surface the same delete-sharing window
        // as EPERM. Both cases are bounded by the acquisition deadline.
        if (isTransientLockInspectionRace(statusError)) {
          if (Date.now() >= deadline) {
            throw notificationStorageError(
              'STORAGE_LOCK_TIMEOUT',
              'Timed out waiting for the notification storage lock.',
            );
          }
          blockFor(Math.min(25, Math.max(1, deadline - Date.now())));
          continue;
        }
        throw statusError;
      }
      isolateStaleLock(lockPath, reclaimPath, root, stale, nonceFactory());
      if (Date.now() >= deadline) {
        throw notificationStorageError(
          'STORAGE_LOCK_TIMEOUT',
          'Timed out waiting for the notification storage lock.',
        );
      }
      blockFor(Math.min(25, Math.max(1, deadline - Date.now())));
    }
  }

  try {
    return operation();
  } finally {
    try {
      const current = JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce?: unknown };
      if (current.nonce === nonce) {
        unlinkSync(lockPath);
        fsyncNotificationDirectory(root);
      }
    } catch {
      // Never remove a lock whose ownership can no longer be proven.
    }
  }
}

export function temporaryNotificationPath(
  directory: string,
  stem: string,
  nonce?: () => string,
): string {
  return join(directory, `.${stem}.${process.pid}.${(nonce ?? randomUUID)()}.tmp`);
}

export function cleanupNotificationTemporary(path: string): void {
  rmSync(path, { force: true });
}

export function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export function notificationStorageError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isolateStaleLock(
  path: string,
  reclaimPath: string,
  root: string,
  staleMs: number,
  reclaimNonce: string,
): void {
  let reclaimDescriptor: number | null = null;
  try {
    try {
      reclaimDescriptor = openSync(reclaimPath, 'wx', 0o600);
      writeFileSync(
        reclaimDescriptor,
        JSON.stringify({
          pid: process.pid,
          nonce: reclaimNonce,
          created_at: new Date().toISOString(),
        }),
        'utf8',
      );
      fsyncSync(reclaimDescriptor);
      closeSync(reclaimDescriptor);
      reclaimDescriptor = null;
      fsyncNotificationDirectory(root);
    } catch (error) {
      if (reclaimDescriptor !== null) closeSync(reclaimDescriptor);
      if (isNodeError(error, 'EEXIST')) return;
      throw error;
    }

    const before = readLockIdentity(path);
    if (!before) return;
    const age = Date.now() - before.mtimeMs;
    if (
      !Number.isSafeInteger(before.pid) ||
      before.pid < 1 ||
      isProcessAlive(before.pid) ||
      age < staleMs
    ) {
      return;
    }
    const current = readLockIdentity(path);
    if (
      !current ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.pid !== before.pid ||
      current.nonce !== before.nonce
    ) {
      return;
    }
    unlinkSync(path);
    fsyncNotificationDirectory(root);
  } catch {
    // A concurrent owner may have changed the lock. Retry without deleting unknown state.
  } finally {
    if (reclaimDescriptor !== null) {
      try {
        closeSync(reclaimDescriptor);
      } catch {
        // Best-effort descriptor cleanup.
      }
    }
    try {
      const current = JSON.parse(readFileSync(reclaimPath, 'utf8')) as { nonce?: unknown };
      if (current.nonce === reclaimNonce) {
        unlinkSync(reclaimPath);
        fsyncNotificationDirectory(root);
      }
    } catch {
      // Never remove a reclaim gate whose ownership cannot be proven.
    }
  }
}

function assertSecureLockFile(path: string): void {
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw notificationStorageError(
      'STORAGE_PATH_UNSAFE',
      'Notification storage lock path is a link, junction or non-regular file.',
    );
  }
  if (process.platform !== 'win32' && (status.mode & 0o777) !== 0o600) {
    throw notificationStorageError(
      'STORAGE_PATH_UNSAFE',
      'Notification storage lock permissions must be 0600.',
    );
  }
}

function readLockIdentity(path: string): {
  dev: number;
  ino: number;
  mtimeMs: number;
  pid: number;
  nonce: string;
} | null {
  try {
    assertSecureLockFile(path);
    const status = lstatSync(path);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      pid?: unknown;
      nonce?: unknown;
    };
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isSafeInteger(parsed.pid) ||
      typeof parsed.nonce !== 'string' ||
      parsed.nonce.length === 0
    ) {
      return null;
    }
    const after = lstatSync(path);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== status.dev ||
      after.ino !== status.ino
    ) {
      return null;
    }
    return {
      dev: after.dev,
      ino: after.ino,
      mtimeMs: after.mtimeMs,
      pid: parsed.pid,
      nonce: parsed.nonce,
    };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

function isTransientLockInspectionRace(error: unknown): boolean {
  return (
    isNodeError(error, 'ENOENT') || (process.platform === 'win32' && isNodeError(error, 'EPERM'))
  );
}

function blockFor(milliseconds: number): void {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, milliseconds);
}
