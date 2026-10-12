import {
  readStableDescriptor,
  digestStableDescriptor,
  stableFileIdentity as fileIdentity,
  StableDescriptorError,
} from '@openslack/core';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export type CleanupFileBoundaryCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_PATH'
  | 'SYMLINK_REJECTED'
  | 'FILE_CHANGED'
  | 'UNSAFE_FILE'
  | 'TOO_LARGE'
  | 'NOT_FOUND';
export class CleanupFileBoundaryError extends Error {
  constructor(
    public readonly code: CleanupFileBoundaryCode,
    detail = 'safe descriptor-bound access could not be established.',
  ) {
    super(`CLEANUP_${code}: ${detail}`);
  }
}
function refuse(code: CleanupFileBoundaryCode): never {
  throw new CleanupFileBoundaryError(code);
}
export const inodeIdentity = (s: Stats): string => `${s.dev}:${s.ino}`;
function retainCleanupFailure(primary: unknown, failure: unknown): void {
  if (primary instanceof Error) {
    const value = primary as Error & { cleanupFailures?: string[] };
    (value.cleanupFailures ??= []).push(
      (failure as NodeJS.ErrnoException).code ?? 'FD_CLOSE_FAILED',
    );
  }
}
function closeOwnedDescriptors(fds: readonly number[], primary?: unknown): void {
  let first: unknown;
  for (const fd of fds) {
    try {
      closeSync(fd);
    } catch (error) {
      first ??= error;
      retainCleanupFailure(primary ?? first, error);
    }
  }
  if (first && primary === undefined) throw first;
}

/** There is deliberately no path-check fallback on a platform without these primitives. */
export function assertCleanupDescriptorSupport(): void {
  if (
    process.platform !== 'linux' ||
    !constants.O_NOFOLLOW ||
    !constants.O_DIRECTORY ||
    !constants.O_NONBLOCK
  )
    refuse('UNSUPPORTED_PLATFORM');
  try {
    const fd = openSync('/proc/self/fd', constants.O_RDONLY | constants.O_DIRECTORY);
    closeSync(fd);
  } catch {
    refuse('UNSUPPORTED_PLATFORM');
  }
}

interface Directory {
  fd: number;
  name: string;
  identity: string;
  privatePublication: boolean;
}
function assertPrivateDirectory(stamp: Stats): void {
  if (stamp.uid !== process.getuid!() || (stamp.mode & 0o022) !== 0)
    throw new CleanupFileBoundaryError(
      'UNSAFE_FILE',
      'Record publication requires private directories below the workspace root. Use a dedicated workspace; shared writable directories are refused.',
    );
}
/** Private capability: callers cannot supply an fd or a proc path. */
export class CleanupDirectoryAnchor {
  private constructor(
    private readonly directories: Directory[],
    readonly absolute: string,
  ) {}
  static open(path: string, createBelow?: string): CleanupDirectoryAnchor {
    assertCleanupDescriptorSupport();
    if (
      !isAbsolute(path) ||
      /[\u0000-\u001f\u007f]/.test(path) ||
      path.split('/').includes('..') ||
      /^\/proc\/(?:self|\d+)\/fd(?:\/|$)/.test(path)
    )
      refuse('INVALID_PATH');
    const absolute = resolve(path),
      parts = absolute.split('/').filter(Boolean);
    const boundary = createBelow === undefined ? undefined : resolve(createBelow);
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
    const directories: Directory[] = [];
    try {
      const root = openSync('/', flags);
      directories.push({ fd: root, name: '', identity: '', privatePublication: false });
      directories[0]!.identity = inodeIdentity(fstatSync(root));
      const anchor = new CleanupDirectoryAnchor(directories, absolute);
      let walked = '';
      for (const name of parts) {
        anchor.verify();
        const parent = directories.at(-1)!;
        const internal = `/proc/self/fd/${parent.fd}/${name}`;
        walked += `/${name}`;
        let fd: number;
        try {
          fd = openSync(internal, flags);
        } catch (error) {
          if (
            (error as NodeJS.ErrnoException).code === 'ENOENT' &&
            boundary !== undefined &&
            walked.startsWith(boundary + '/')
          ) {
            // Never follow an unpinned parent to create a directory.
            anchor.verify();
            try {
              mkdirSync(internal, { mode: 0o700 });
            } catch (creation) {
              if ((creation as NodeJS.ErrnoException).code !== 'EEXIST') throw creation;
            }
            fsyncSync(parent.fd);
            fd = openSync(internal, flags);
          } else {
            try {
              if (lstatSync(internal).isSymbolicLink()) refuse('SYMLINK_REJECTED');
            } catch (inspection) {
              if (inspection instanceof CleanupFileBoundaryError) throw inspection;
            }
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') refuse('NOT_FOUND');
            refuse('INVALID_PATH');
          }
        }
        directories.push({
          fd,
          name,
          identity: '',
          privatePublication: boundary !== undefined && walked.startsWith(boundary + '/'),
        });
        const stamp = fstatSync(fd);
        directories.at(-1)!.identity = inodeIdentity(stamp);
        if (!stamp.isDirectory()) {
          refuse('INVALID_PATH');
        }
        anchor.verify();
      }
      return anchor;
    } catch (error) {
      closeOwnedDescriptors(
        directories.reverse().map((directory) => directory.fd),
        error,
      );
      throw error;
    }
  }
  path(name: string): string {
    if (!name || name === '.' || name === '..' || /[/\\\u0000-\u001f\u007f]/.test(name))
      refuse('INVALID_PATH');
    return `/proc/self/fd/${this.directories.at(-1)!.fd}/${name}`;
  }
  verify(): void {
    for (let i = 0; i < this.directories.length; i++) {
      const current = this.directories[i]!;
      const opened = fstatSync(current.fd);
      if (!opened.isDirectory() || inodeIdentity(opened) !== current.identity)
        refuse('FILE_CHANGED');
      if (current.privatePublication) assertPrivateDirectory(opened);
      if (i === 0) continue;
      let stamp: Stats;
      try {
        stamp = lstatSync(`/proc/self/fd/${this.directories[i - 1]!.fd}/${current.name}`);
      } catch {
        refuse('FILE_CHANGED');
      }
      if (
        !stamp.isDirectory() ||
        stamp.isSymbolicLink() ||
        inodeIdentity(stamp) !== current.identity
      )
        refuse('FILE_CHANGED');
      if (current.privatePublication) assertPrivateDirectory(stamp);
    }
  }
  sync(): void {
    this.verify();
    fsyncSync(this.directories.at(-1)!.fd);
    this.verify();
  }
  close(primary?: unknown): void {
    closeOwnedDescriptors(
      [...this.directories].reverse().map((directory) => directory.fd),
      primary,
    );
  }
}

type ReadPurpose = 'runtime-evidence' | 'historical-record' | 'artifact';
function assertFilePurpose(stamp: Stats, purpose: ReadPurpose): void {
  if (
    !stamp.isFile() ||
    stamp.nlink !== 1 ||
    (purpose !== 'artifact' &&
      ((stamp.mode & 0o022) !== 0 ||
        (stamp.uid !== process.getuid!() &&
          stamp.uid !== 0 &&
          !(purpose === 'historical-record' && process.getuid!() === 0))))
  )
    refuse('UNSAFE_FILE');
}
/** Owned capture held across one preparation stage. No caller-provided FD path. */
export class CleanupCapturedFile {
  private constructor(
    readonly anchor: CleanupDirectoryAnchor,
    readonly fd: number,
    private readonly leaf: string,
    private readonly identity: string,
    private readonly maxBytes: number,
    private readonly purpose: ReadPurpose,
  ) {}
  static open(
    path: string,
    maxBytes: number,
    purpose: ReadPurpose = 'runtime-evidence',
  ): CleanupCapturedFile {
    const anchor = CleanupDirectoryAnchor.open(dirname(path));
    const leaf = path.slice(path.lastIndexOf('/') + 1);
    let fd: number | undefined;
    try {
      const before = lstatSync(anchor.path(leaf));
      if (before.isSymbolicLink()) refuse('SYMLINK_REJECTED');
      assertFilePurpose(before, purpose);
      fd = openSync(
        anchor.path(leaf),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stamp = fstatSync(fd);
      if (fileIdentity(before) !== fileIdentity(stamp)) refuse('FILE_CHANGED');
      const capture = new CleanupCapturedFile(
        anchor,
        fd,
        leaf,
        fileIdentity(stamp),
        maxBytes,
        purpose,
      );
      capture.verify();
      return capture;
    } catch (error) {
      if (fd !== undefined) closeOwnedDescriptors([fd], error);
      anchor.close(error);
      throw error;
    }
  }
  verify(): void {
    this.anchor.verify();
    const stamp = fstatSync(this.fd),
      entry = lstatSync(this.anchor.path(this.leaf));
    assertFilePurpose(stamp, this.purpose);
    assertFilePurpose(entry, this.purpose);
    if (fileIdentity(stamp) !== this.identity || fileIdentity(entry) !== this.identity)
      refuse('FILE_CHANGED');
  }
  read(): Buffer {
    this.verify();
    const bytes = readCleanupDescriptor(this.fd, this.maxBytes, this.purpose);
    this.verify();
    return bytes;
  }
  digest(): { sha256: string; bytes: number } {
    this.verify();
    try {
      const result = digestStableDescriptor(this.fd, this.maxBytes, false);
      this.verify();
      return result;
    } catch (error) {
      if (error instanceof StableDescriptorError)
        refuse(error.code === 'SIZE_INVALID' ? 'TOO_LARGE' : 'FILE_CHANGED');
      throw error;
    }
  }
  close(primary?: unknown): void {
    let failure = primary;
    try {
      closeOwnedDescriptors([this.fd], primary);
    } catch (error) {
      failure = error;
    }
    try {
      this.anchor.close(failure);
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined && primary === undefined) throw failure;
  }
}
export function readCleanupDescriptor(
  fd: number,
  maxBytes: number,
  purpose: ReadPurpose = 'runtime-evidence',
): Buffer {
  const stamp = fstatSync(fd);
  assertFilePurpose(stamp, purpose);
  try {
    return readStableDescriptor(fd, maxBytes);
  } catch (error) {
    if (error instanceof StableDescriptorError)
      refuse(error.code === 'SIZE_INVALID' ? 'TOO_LARGE' : 'FILE_CHANGED');
    throw error;
  }
}

/** Read, optionally sync, and revalidate one inode without reopening a pathname. */
export function withCleanupFile<T>(
  path: string,
  maxBytes: number,
  consume: (bytes: Buffer, fd: number, anchor: CleanupDirectoryAnchor) => T,
  purpose: ReadPurpose = 'runtime-evidence',
): T {
  const capture = CleanupCapturedFile.open(path, maxBytes, purpose);
  let failure: unknown;
  try {
    const result = consume(capture.read(), capture.fd, capture.anchor);
    capture.verify();
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    capture.close(failure);
  }
}

export function readCleanupBoundedFile(path: string, maxBytes: number): Buffer {
  return withCleanupFile(path, maxBytes, (bytes) => bytes);
}

/** Execution-trusted streaming capture; never buffers an entire program. */
export function digestCleanupBoundedFile(
  path: string,
  maxBytes: number,
): { sha256: string; bytes: number } {
  const capture = CleanupCapturedFile.open(path, maxBytes, 'runtime-evidence');
  let failure: unknown;
  try {
    const result = capture.digest();
    capture.verify();
    return result;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    capture.close(failure);
  }
}

/** Offline artifact integrity is portable and does not assert execution trust. */
export function readCleanupArtifactFile(path: string, maxBytes: number): Buffer {
  if (process.platform === 'linux')
    return withCleanupFile(path, maxBytes, (bytes) => bytes, 'artifact');
  const ancestors = () => {
    for (let p = resolve(path); ; p = dirname(p)) {
      if (lstatSync(p).isSymbolicLink()) refuse('SYMLINK_REJECTED');
      if (dirname(p) === p) break;
    }
  };
  ancestors();
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) refuse('UNSAFE_FILE');
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (fileIdentity(before) !== fileIdentity(fstatSync(fd))) refuse('FILE_CHANGED');
    const bytes = readStableDescriptor(fd, maxBytes);
    if (fileIdentity(before) !== fileIdentity(lstatSync(path))) refuse('FILE_CHANGED');
    ancestors();
    return bytes;
  } catch (error) {
    if (error instanceof StableDescriptorError)
      refuse(error.code === 'SIZE_INVALID' ? 'TOO_LARGE' : 'FILE_CHANGED');
    throw error;
  } finally {
    closeSync(fd);
  }
}
