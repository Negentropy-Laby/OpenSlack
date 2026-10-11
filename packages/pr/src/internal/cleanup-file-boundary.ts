import {
  readStableDescriptor,
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
      for (const directory of directories.reverse()) closeSync(directory.fd);
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
  close(): void {
    for (const directory of [...this.directories].reverse()) closeSync(directory.fd);
  }
}

type ReadPurpose = 'runtime-evidence' | 'historical-record' | 'artifact';
export function readCleanupDescriptor(
  fd: number,
  maxBytes: number,
  purpose: ReadPurpose = 'runtime-evidence',
): Buffer {
  const stamp = fstatSync(fd);
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
  const anchor = CleanupDirectoryAnchor.open(dirname(path));
  const leaf = path.slice(path.lastIndexOf('/') + 1);
  let fd: number | undefined;
  try {
    anchor.verify();
    const internal = anchor.path(leaf),
      before = lstatSync(internal);
    if (before.isSymbolicLink()) refuse('SYMLINK_REJECTED');
    if (!before.isFile()) refuse('UNSAFE_FILE');
    fd = openSync(internal, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stamp = fstatSync(fd);
    if (fileIdentity(before) !== fileIdentity(stamp)) refuse('FILE_CHANGED');
    const bytes = readCleanupDescriptor(fd, maxBytes, purpose);
    const result = consume(bytes, fd, anchor);
    if (
      fileIdentity(fstatSync(fd)) !== fileIdentity(stamp) ||
      fileIdentity(lstatSync(internal)) !== fileIdentity(stamp)
    )
      refuse('FILE_CHANGED');
    anchor.verify();
    return result;
  } finally {
    if (fd !== undefined) closeSync(fd);
    anchor.close();
  }
}

export function readCleanupBoundedFile(path: string, maxBytes: number): Buffer {
  return withCleanupFile(path, maxBytes, (bytes) => bytes);
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
