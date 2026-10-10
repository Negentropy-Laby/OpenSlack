import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

export type CleanupFileBoundaryCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'INVALID_PATH'
  | 'SYMLINK_REJECTED'
  | 'FILE_CHANGED'
  | 'UNSAFE_FILE'
  | 'TOO_LARGE';
export class CleanupFileBoundaryError extends Error {
  constructor(public readonly code: CleanupFileBoundaryCode) {
    super(`CLEANUP_${code}: safe descriptor-bound access could not be established.`);
  }
}
function refuse(code: CleanupFileBoundaryCode): never {
  throw new CleanupFileBoundaryError(code);
}
export const inodeIdentity = (s: Stats): string => `${s.dev}:${s.ino}`;
const fileIdentity = (s: Stats): string =>
  [s.dev, s.ino, s.mode, s.uid, s.gid, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');

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
      directories.push({ fd: root, name: '', identity: inodeIdentity(fstatSync(root)) });
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
            refuse('INVALID_PATH');
          }
        }
        const stamp = fstatSync(fd);
        if (!stamp.isDirectory()) {
          closeSync(fd);
          refuse('INVALID_PATH');
        }
        directories.push({ fd, name, identity: inodeIdentity(stamp) });
        anchor.verify();
        if (
          boundary !== undefined &&
          walked.startsWith(boundary + '/') &&
          (stamp.uid !== process.getuid!() || (stamp.mode & 0o022) !== 0)
        )
          refuse('UNSAFE_FILE');
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
      if (inodeIdentity(fstatSync(current.fd)) !== current.identity) refuse('FILE_CHANGED');
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

export function readCleanupDescriptor(fd: number, maxBytes: number): Buffer {
  const stamp = fstatSync(fd);
  if (
    !stamp.isFile() ||
    stamp.nlink !== 1 ||
    (stamp.mode & 0o022) !== 0 ||
    (stamp.uid !== process.getuid!() && stamp.uid !== 0)
  )
    refuse('UNSAFE_FILE');
  if (stamp.size > maxBytes) refuse('TOO_LARGE');
  const bytes = Buffer.alloc(Math.min(stamp.size + 1, maxBytes + 1));
  let count = 0;
  while (count < bytes.length) {
    const read = readSync(fd, bytes, count, bytes.length - count, count);
    if (read === 0) break;
    count += read;
  }
  if (
    count > maxBytes ||
    count !== stamp.size ||
    fileIdentity(fstatSync(fd)) !== fileIdentity(stamp)
  )
    refuse(count > maxBytes ? 'TOO_LARGE' : 'FILE_CHANGED');
  return bytes.subarray(0, count);
}

/** Read, optionally sync, and revalidate one inode without reopening a pathname. */
export function withCleanupFile<T>(
  path: string,
  maxBytes: number,
  consume: (bytes: Buffer, fd: number, anchor: CleanupDirectoryAnchor) => T,
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
    const bytes = readCleanupDescriptor(fd, maxBytes);
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
