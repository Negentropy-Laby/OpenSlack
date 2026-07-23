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
  const timeout = options.lockTimeoutMs ?? 5_000;
  const stale = options.lockStaleMs ?? 30_000;
  const nonce = (options.nonce ?? randomUUID)();
  const deadline = Date.now() + timeout;
  while (true) {
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
      if (!isNodeError(error, 'EEXIST')) throw error;
      let lockStatus: ReturnType<typeof lstatSync>;
      try {
        lockStatus = lstatSync(lockPath);
      } catch (statusError) {
        // The previous owner may release the lock between our EEXIST result and
        // this inspection. That is a normal hand-off race, so retry acquisition.
        if (isNodeError(statusError, 'ENOENT')) continue;
        throw statusError;
      }
      if (lockStatus.isSymbolicLink() || !lockStatus.isFile()) {
        throw notificationStorageError(
          'STORAGE_PATH_UNSAFE',
          'Notification storage lock path is a link, junction or non-regular file.',
        );
      }
      if (process.platform !== 'win32' && (lockStatus.mode & 0o777) !== 0o600) {
        throw notificationStorageError(
          'STORAGE_PATH_UNSAFE',
          'Notification storage lock permissions must be 0600.',
        );
      }
      isolateStaleLock(lockPath, stale);
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

function isolateStaleLock(path: string, staleMs: number): void {
  try {
    const status = lstatSync(path);
    if (status.isSymbolicLink() || !status.isFile()) return;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
    const age = Date.now() - status.mtimeMs;
    if (
      typeof parsed.pid === 'number' &&
      Number.isSafeInteger(parsed.pid) &&
      (isProcessAlive(parsed.pid) || age < staleMs)
    ) {
      return;
    }
    unlinkSync(path);
  } catch {
    // A concurrent owner may have changed the lock. Retry without deleting unknown state.
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

function blockFor(milliseconds: number): void {
  const state = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(state, 0, 0, milliseconds);
}
