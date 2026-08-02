import { constants as fsConstants } from 'node:fs';
import type { Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { canonicalJson } from './canonical.js';
import { GraphStoreError } from './errors.js';
import {
  assertGraphDeltaIntegrity,
  assertGraphSnapshotIntegrity,
  serializeGraphDelta,
  serializeGraphSnapshot,
} from './integrity.js';
import { GRAPH_SHADOW_POLICY, type GraphShadowPublishPort } from './shadow.js';
import { parseStrictGraphJson } from './strict-json.js';
import type { GraphDelta, GraphEdge, GraphNode, GraphSnapshot } from './types.js';

const CURSOR_SCHEMA = 'openslack.graph_cursor.v1';

interface ShadowPublicationQueue {
  tail: Promise<void>;
  depth: number;
  lastQueuedCursor: string | null;
  catchUp?: ShadowPublicationTask;
}

interface ShadowPublicationTask {
  publisher: GraphShadowPublishPort;
  input: Parameters<GraphShadowPublishPort['publish']>[0];
}

const shadowPublicationQueues = new Map<string, ShadowPublicationQueue>();
/**
 * Node does not expose Windows FILE_FLAG_OPEN_REPARSE_POINT through its portable fs.open API.
 * Windows therefore retains the lstat/realpath/handle-identity/readback checks below, but lacks
 * POSIX-equivalent open-time no-follow and directory-fsync guarantees. Windows qualification
 * must report that platform delta until a native fail-closed adapter supplies both guarantees.
 */
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);

export interface GraphStoreLimits {
  maxFileBytes: number;
  maxDirectoryEntries: number;
  maxTotalBytes: number;
  maxRecords: number;
}

export const DEFAULT_GRAPH_STORE_LIMITS: Readonly<GraphStoreLimits> = Object.freeze({
  maxFileBytes: 16 * 1024 * 1024,
  maxDirectoryEntries: 4_096,
  maxTotalBytes: 128 * 1024 * 1024,
  maxRecords: 35_000,
});

interface CursorRecord {
  schema: typeof CURSOR_SCHEMA;
  scenarioInstanceId: string;
  cursor: string;
  snapshotIntegrityHash: string;
  updatedAt: string;
}

interface PreparedGraphStore {
  root: string;
  realRoot: string;
  rootIdentity: Stats;
  directories: Record<string, string>;
  directoryIdentities: Record<string, Stats>;
  entryCount: number;
  totalBytes: number;
}

export interface PublishGraphSnapshotOptions {
  expectedCursor: string | null;
  delta?: GraphDelta;
}

export interface PublishedGraphSnapshot {
  scenarioInstanceId: string;
  previousCursor: string | null;
  cursor: string;
  snapshotIntegrityHash: string;
  snapshotPath: string;
  deltaPath?: string;
}

/**
 * Common publication result shared by the local cache and a durable remote
 * authority. Filesystem paths are deliberately excluded from this port.
 */
export interface GraphSnapshotPublication {
  scenarioInstanceId: string;
  previousCursor: string | null;
  cursor: string;
  snapshotIntegrityHash: string;
  authorityBackend?: 'ts-local' | 'go';
  routingEpoch?: number;
  receiptStatus?: 'accepted' | 'duplicate';
  revision?: number;
}

export interface GraphSnapshotPublisherPort {
  publishSnapshot(
    snapshot: GraphSnapshot,
    options: PublishGraphSnapshotOptions,
  ): Promise<GraphSnapshotPublication>;
}

export interface GraphStorePathSet {
  root: string;
  snapshotsDirectory: string;
  deltasDirectory: string;
  cursorsDirectory: string;
  locksDirectory: string;
  scenarioKey: string;
  snapshotPath?: string;
  deltaPath?: string;
  cursorPath: string;
  lockPath: string;
}

/**
 * Deterministic fault-injection seams for boundary tests. Production calls use no hooks.
 *
 * @internal
 */
export interface GraphStoreIoTestHooks {
  afterBoundedRead?: (targetPath: string) => void | Promise<void>;
  afterProjectionWrite?: (targetPath: string) => void | Promise<void>;
  beforeCursorPublish?: (targetPath: string) => void | Promise<void>;
  afterCursorRename?: (targetPath: string) => void | Promise<void>;
}

const NO_TEST_HOOKS: GraphStoreIoTestHooks = Object.freeze({});

function storeFail(
  code: ConstructorParameters<typeof GraphStoreError>[0],
  message: string,
  path?: string,
): never {
  throw new GraphStoreError(code, message, path);
}

function comparePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function assertStoreIdentifier(value: string, name: string): void {
  const pathSegments = typeof value === 'string' ? value.split(/[\\/]/) : [];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:/.test(value) ||
    pathSegments.includes('..')
  ) {
    storeFail('GRAPH_STORE_PATH_UNSAFE', `${name} is not a safe graph store identifier.`);
  }
}

function keyFor(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeFilename(path: string): void {
  const name = basename(path);
  if (
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    (process.platform === 'win32' && name.includes(':'))
  ) {
    storeFail('GRAPH_STORE_PATH_UNSAFE', 'Graph store candidate has an unsafe filename.', path);
  }
}

export function graphStorePaths(
  configuredRoot: string,
  scenarioInstanceId: string,
  cursor?: string,
  fromCursor?: string,
): GraphStorePathSet {
  assertStoreIdentifier(scenarioInstanceId, 'scenarioInstanceId');
  if (cursor !== undefined) assertStoreIdentifier(cursor, 'cursor');
  if (fromCursor !== undefined) assertStoreIdentifier(fromCursor, 'fromCursor');
  const root = resolve(configuredRoot);
  const scenarioKey = keyFor(scenarioInstanceId);
  const cursorKey = cursor === undefined ? undefined : keyFor(cursor);
  const fromCursorKey = fromCursor === undefined ? undefined : keyFor(fromCursor);
  const snapshotsDirectory = join(root, 'snapshots');
  const deltasDirectory = join(root, 'deltas');
  const cursorsDirectory = join(root, 'cursors');
  const locksDirectory = join(root, 'locks');
  const result: GraphStorePathSet = {
    root,
    snapshotsDirectory,
    deltasDirectory,
    cursorsDirectory,
    locksDirectory,
    scenarioKey,
    ...(cursorKey === undefined
      ? {}
      : { snapshotPath: join(snapshotsDirectory, `${scenarioKey}.${cursorKey}.json`) }),
    ...(cursorKey === undefined || fromCursorKey === undefined
      ? {}
      : {
          deltaPath: join(deltasDirectory, `${scenarioKey}.${fromCursorKey}.${cursorKey}.json`),
        }),
    cursorPath: join(cursorsDirectory, `${scenarioKey}.json`),
    lockPath: join(locksDirectory, `${scenarioKey}.lock`),
  };
  Object.values(result)
    .filter((value): value is string => typeof value === 'string' && value.includes(sep))
    .forEach(safeFilename);
  return result;
}

function positiveInteger(value: number, name: string, ceiling: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    storeFail(
      'GRAPH_STORE_PATH_UNSAFE',
      `${name} must be a positive integer no greater than ${ceiling}.`,
    );
  }
  return value;
}

function resolveLimits(value: Partial<GraphStoreLimits>): GraphStoreLimits {
  return {
    maxFileBytes: positiveInteger(
      value.maxFileBytes ?? DEFAULT_GRAPH_STORE_LIMITS.maxFileBytes,
      'maxFileBytes',
      DEFAULT_GRAPH_STORE_LIMITS.maxFileBytes,
    ),
    maxDirectoryEntries: positiveInteger(
      value.maxDirectoryEntries ?? DEFAULT_GRAPH_STORE_LIMITS.maxDirectoryEntries,
      'maxDirectoryEntries',
      DEFAULT_GRAPH_STORE_LIMITS.maxDirectoryEntries,
    ),
    maxTotalBytes: positiveInteger(
      value.maxTotalBytes ?? DEFAULT_GRAPH_STORE_LIMITS.maxTotalBytes,
      'maxTotalBytes',
      DEFAULT_GRAPH_STORE_LIMITS.maxTotalBytes,
    ),
    maxRecords: positiveInteger(
      value.maxRecords ?? DEFAULT_GRAPH_STORE_LIMITS.maxRecords,
      'maxRecords',
      DEFAULT_GRAPH_STORE_LIMITS.maxRecords,
    ),
  };
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableIdentity(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function assertRoot(
  configuredRoot: string,
  create: boolean,
): Promise<{ root: string; realRoot: string; identity: Stats }> {
  const root = resolve(configuredRoot);
  if (create) await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstatIfPresent(root);
  if (!rootStat) {
    return storeFail('GRAPH_STORE_NOT_FOUND', 'Graph store root does not exist.', root);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return storeFail(
      'GRAPH_STORE_PATH_UNSAFE',
      'Graph store root must be a real directory, not a symlink.',
      root,
    );
  }
  const realRoot = await realpath(root);
  if (!comparePath(realRoot, root)) {
    return storeFail(
      'GRAPH_STORE_PATH_UNSAFE',
      'Graph store root resolves through a symbolic link.',
      root,
    );
  }
  return { root, realRoot, identity: rootStat };
}

async function assertDirectory(
  root: string,
  realRoot: string,
  name: 'snapshots' | 'deltas' | 'cursors' | 'locks',
  create: boolean,
): Promise<{ directory: string; realDirectory: string; identity: Stats }> {
  const directory = join(root, name);
  if (create) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const directoryStat = await lstatIfPresent(directory);
  if (!directoryStat) {
    return storeFail(
      'GRAPH_STORE_NOT_FOUND',
      `Graph store ${name} directory is missing.`,
      directory,
    );
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return storeFail(
      'GRAPH_STORE_PATH_UNSAFE',
      `Graph store ${name} path must be a real directory.`,
      directory,
    );
  }
  const realDirectory = await realpath(directory);
  if (!comparePath(dirname(realDirectory), realRoot)) {
    return storeFail(
      'GRAPH_STORE_PATH_UNSAFE',
      `Graph store ${name} directory escapes the configured root.`,
      directory,
    );
  }
  return { directory, realDirectory, identity: directoryStat };
}

async function prepareStore(
  configuredRoot: string,
  create: boolean,
  limits: GraphStoreLimits,
): Promise<PreparedGraphStore> {
  const { root, realRoot, identity: rootIdentity } = await assertRoot(configuredRoot, create);
  const directories: Record<string, string> = Object.create(null) as Record<string, string>;
  const directoryIdentities: Record<string, Stats> = Object.create(null) as Record<string, Stats>;
  let entries = 0;
  let totalBytes = 0;
  for (const name of ['snapshots', 'deltas', 'cursors', 'locks'] as const) {
    const checked = await assertDirectory(root, realRoot, name, create);
    directories[name] = checked.realDirectory;
    directoryIdentities[name] = checked.identity;
    const children = await readdir(checked.directory, { withFileTypes: true });
    entries += children.length;
    if (entries > limits.maxDirectoryEntries) {
      return storeFail(
        'GRAPH_STORE_DIRECTORY_LIMIT',
        `Graph store contains more than ${limits.maxDirectoryEntries} directory entries.`,
        root,
      );
    }
    for (const child of children) {
      const childPath = join(checked.directory, child.name);
      safeFilename(childPath);
      if (child.isSymbolicLink() || !child.isFile()) {
        return storeFail(
          'GRAPH_STORE_FILE_UNSAFE',
          'Graph store accepts regular files only.',
          childPath,
        );
      }
      const childStat = await lstat(childPath);
      if (!childStat.isFile() || childStat.isSymbolicLink()) {
        return storeFail(
          'GRAPH_STORE_FILE_UNSAFE',
          'Graph store candidate changed type during enumeration.',
          childPath,
        );
      }
      if (childStat.size > limits.maxFileBytes) {
        return storeFail(
          'GRAPH_STORE_FILE_TOO_LARGE',
          `Graph store file exceeds ${limits.maxFileBytes} bytes.`,
          childPath,
        );
      }
      totalBytes += childStat.size;
      if (totalBytes > limits.maxTotalBytes) {
        return storeFail(
          'GRAPH_STORE_DIRECTORY_LIMIT',
          `Graph store contains more than ${limits.maxTotalBytes} bytes.`,
          root,
        );
      }
    }
  }
  return {
    root,
    realRoot,
    rootIdentity,
    directories,
    directoryIdentities,
    entryCount: entries,
    totalBytes,
  };
}

async function assertPreparedStoreStable(prepared: PreparedGraphStore): Promise<void> {
  const rootStat = await lstatIfPresent(prepared.root);
  if (
    !rootStat ||
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !sameIdentity(rootStat, prepared.rootIdentity) ||
    !comparePath(await realpath(prepared.root), prepared.realRoot)
  ) {
    return storeFail(
      'GRAPH_STORE_PATH_UNSAFE',
      'Graph store root changed identity during publication.',
      prepared.root,
    );
  }
  for (const name of ['snapshots', 'deltas', 'cursors', 'locks'] as const) {
    const directory = prepared.directories[name]!;
    const expectedIdentity = prepared.directoryIdentities[name]!;
    const directoryStat = await lstatIfPresent(directory);
    if (
      !directoryStat ||
      !directoryStat.isDirectory() ||
      directoryStat.isSymbolicLink() ||
      !sameIdentity(directoryStat, expectedIdentity) ||
      !comparePath(await realpath(directory), directory) ||
      !comparePath(dirname(directory), prepared.realRoot)
    ) {
      return storeFail(
        'GRAPH_STORE_PATH_UNSAFE',
        `Graph store ${name} directory changed identity during publication.`,
        directory,
      );
    }
  }
}

async function assertProspectiveStoreCapacity(
  prepared: PreparedGraphStore,
  paths: GraphStorePathSet,
  snapshotBytes: Buffer,
  deltaBytes: Buffer | undefined,
  cursorBytes: Buffer,
  limits: GraphStoreLimits,
): Promise<void> {
  const candidates = [
    { path: paths.snapshotPath!, bytes: snapshotBytes },
    ...(deltaBytes === undefined ? [] : [{ path: paths.deltaPath!, bytes: deltaBytes }]),
  ];
  let newImmutableEntries = 0;
  let newImmutableBytes = 0;
  let largestTemporaryBytes = cursorBytes.length;
  for (const candidate of candidates) {
    largestTemporaryBytes = Math.max(largestTemporaryBytes, candidate.bytes.length);
    if (!(await lstatIfPresent(candidate.path))) {
      newImmutableEntries += 1;
      newImmutableBytes += candidate.bytes.length;
    }
  }
  const cursorExists = await lstatIfPresent(paths.cursorPath);
  const finalEntries =
    prepared.entryCount + newImmutableEntries + (cursorExists === undefined ? 1 : 0) + 1;
  const peakEntries = finalEntries + 1;
  if (peakEntries > limits.maxDirectoryEntries) {
    storeFail(
      'GRAPH_STORE_DIRECTORY_LIMIT',
      `Graph publication would exceed ${limits.maxDirectoryEntries} directory entries.`,
      prepared.root,
    );
  }
  const peakBytes =
    prepared.totalBytes +
    newImmutableBytes +
    cursorBytes.length +
    Buffer.byteLength(`${process.pid}\n`, 'utf8') +
    largestTemporaryBytes;
  if (peakBytes > limits.maxTotalBytes) {
    storeFail(
      'GRAPH_STORE_DIRECTORY_LIMIT',
      `Graph publication would exceed ${limits.maxTotalBytes} bytes including atomic-write reserve.`,
      prepared.root,
    );
  }
}

async function assertSafeFile(
  path: string,
  realDirectory: string,
  limits: GraphStoreLimits,
): Promise<Stats> {
  safeFilename(path);
  const pathStat = await lstatIfPresent(path);
  if (!pathStat) return storeFail('GRAPH_STORE_NOT_FOUND', 'Graph store file is missing.', path);
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    return storeFail(
      'GRAPH_STORE_FILE_UNSAFE',
      'Graph store candidate is not a regular file.',
      path,
    );
  }
  if (pathStat.size > limits.maxFileBytes) {
    return storeFail(
      'GRAPH_STORE_FILE_TOO_LARGE',
      `Graph store file exceeds ${limits.maxFileBytes} bytes.`,
      path,
    );
  }
  const resolved = await realpath(path);
  if (!comparePath(dirname(resolved), realDirectory) || !comparePath(resolved, path)) {
    return storeFail(
      'GRAPH_STORE_PATH_UNSAFE',
      'Graph store candidate resolves outside its fixed directory.',
      path,
    );
  }
  return pathStat;
}

async function readSecureBytes(
  path: string,
  realDirectory: string,
  limits: GraphStoreLimits,
  hooks: GraphStoreIoTestHooks,
): Promise<Buffer> {
  const pathStat = await assertSafeFile(path, realDirectory, limits);
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameIdentity(pathStat, before)) {
      return storeFail(
        'GRAPH_STORE_FILE_UNSAFE',
        'Graph store file changed identity before reading.',
        path,
      );
    }
    const bytes = Buffer.allocUnsafe(limits.maxFileBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > limits.maxFileBytes) {
      return storeFail(
        'GRAPH_STORE_FILE_TOO_LARGE',
        `Graph store file exceeds ${limits.maxFileBytes} bytes.`,
        path,
      );
    }
    const after = await handle.stat();
    if (!stableIdentity(before, after) || after.size !== length) {
      return storeFail('GRAPH_STORE_FILE_UNSAFE', 'Graph store file changed while reading.', path);
    }
    await hooks.afterBoundedRead?.(path);
    const repeatedPathStat = await assertSafeFile(path, realDirectory, limits);
    if (!sameIdentity(after, repeatedPathStat)) {
      return storeFail(
        'GRAPH_STORE_FILE_UNSAFE',
        'Graph store path changed identity during reading.',
        path,
      );
    }
    return Buffer.from(bytes.subarray(0, length));
  } finally {
    await handle.close();
  }
}

function parseCursorRecord(value: unknown, expectedScenario: string): CursorRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return storeFail('GRAPH_STORE_CONTENT_INVALID', 'Graph cursor record must be an object.');
  }
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).sort().join(',') !==
      'cursor,scenarioInstanceId,schema,snapshotIntegrityHash,updatedAt' ||
    object.schema !== CURSOR_SCHEMA ||
    object.scenarioInstanceId !== expectedScenario ||
    typeof object.cursor !== 'string' ||
    typeof object.snapshotIntegrityHash !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(object.snapshotIntegrityHash) ||
    typeof object.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(object.updatedAt))
  ) {
    return storeFail(
      'GRAPH_STORE_CONTENT_INVALID',
      'Graph cursor record violates its closed contract.',
    );
  }
  assertStoreIdentifier(object.cursor, 'stored cursor');
  return {
    schema: CURSOR_SCHEMA,
    scenarioInstanceId: expectedScenario,
    cursor: object.cursor,
    snapshotIntegrityHash: object.snapshotIntegrityHash,
    updatedAt: object.updatedAt,
  };
}

async function readCursorRecord(
  configuredRoot: string,
  scenarioInstanceId: string,
  limits: GraphStoreLimits,
  hooks: GraphStoreIoTestHooks,
  allowMissing: boolean,
): Promise<CursorRecord | null> {
  const paths = graphStorePaths(configuredRoot, scenarioInstanceId);
  const prepared = await prepareStore(configuredRoot, false, limits);
  const existing = await lstatIfPresent(paths.cursorPath);
  if (!existing && allowMissing) return null;
  const bytes = await readSecureBytes(
    paths.cursorPath,
    prepared.directories.cursors!,
    limits,
    hooks,
  );
  try {
    return parseCursorRecord(parseStrictGraphJson(bytes), scenarioInstanceId);
  } catch (error) {
    if (error instanceof GraphStoreError) throw error;
    return storeFail(
      'GRAPH_STORE_CONTENT_INVALID',
      `Graph cursor JSON is invalid: ${(error as Error).message}`,
      paths.cursorPath,
    );
  }
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (result.bytesWritten < 1) {
      storeFail('GRAPH_STORE_FILE_UNSAFE', 'Could not make progress during graph store write.');
    }
    offset += result.bytesWritten;
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const directory = await open(path, fsConstants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function writeTemporary(directory: string, bytes: Buffer): Promise<string> {
  const path = join(directory, `.graph.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    await writeAll(handle, bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    return path;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function installImmutable(
  targetPath: string,
  realDirectory: string,
  bytes: Buffer,
  limits: GraphStoreLimits,
): Promise<void> {
  const existing = await lstatIfPresent(targetPath);
  if (existing) {
    const current = await readSecureBytes(targetPath, realDirectory, limits, NO_TEST_HOOKS);
    if (!current.equals(bytes)) {
      return storeFail(
        'GRAPH_STORE_CURSOR_CONFLICT',
        'An immutable graph projection already exists with different bytes.',
        targetPath,
      );
    }
    return;
  }
  const temporaryPath = await writeTemporary(realDirectory, bytes);
  try {
    await link(temporaryPath, targetPath);
    await unlink(temporaryPath);
    await fsyncDirectory(realDirectory);
    const installed = await readSecureBytes(targetPath, realDirectory, limits, NO_TEST_HOOKS);
    if (!installed.equals(bytes)) {
      return storeFail(
        'GRAPH_STORE_FILE_UNSAFE',
        'Installed graph projection failed exact-byte readback.',
        targetPath,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const current = await readSecureBytes(targetPath, realDirectory, limits, NO_TEST_HOOKS);
      if (current.equals(bytes)) return;
    }
    throw error;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function replaceAtomic(
  targetPath: string,
  realDirectory: string,
  bytes: Buffer,
  limits: GraphStoreLimits,
  onCommitted: () => void,
  afterRename?: (targetPath: string) => void | Promise<void>,
): Promise<void> {
  const existing = await lstatIfPresent(targetPath);
  if (existing) await assertSafeFile(targetPath, realDirectory, limits);
  const temporaryPath = await writeTemporary(realDirectory, bytes);
  try {
    const repeatedDirectory = await realpath(realDirectory);
    if (!comparePath(repeatedDirectory, realDirectory)) {
      return storeFail(
        'GRAPH_STORE_PATH_UNSAFE',
        'Graph cursor directory changed before publication.',
        realDirectory,
      );
    }
    await rename(temporaryPath, targetPath);
    onCommitted();
    await afterRename?.(targetPath);
    await fsyncDirectory(realDirectory);
    const installed = await readSecureBytes(targetPath, realDirectory, limits, NO_TEST_HOOKS);
    if (!installed.equals(bytes)) {
      return storeFail(
        'GRAPH_STORE_FILE_UNSAFE',
        'Published graph cursor failed exact-byte readback.',
        targetPath,
      );
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function acquireLock(path: string): Promise<{ handle: FileHandle; identity: Stats }> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return storeFail('GRAPH_STORE_LOCKED', 'Graph scenario is already being published.', path);
    }
    throw error;
  }
  try {
    const body = Buffer.from(`${process.pid}\n`, 'utf8');
    await writeAll(handle, body);
    await handle.sync();
    return { handle, identity: await handle.stat() };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function releaseLock(
  path: string,
  lock: { handle: FileHandle; identity: Stats },
): Promise<void> {
  await lock.handle.close();
  const pathStat = await lstatIfPresent(path);
  if (!pathStat || !sameIdentity(pathStat, lock.identity)) {
    return storeFail(
      'GRAPH_STORE_FILE_UNSAFE',
      'Graph scenario lock changed identity while held.',
      path,
    );
  }
  await unlink(path);
}

function assertRecordBound(
  snapshotOrDelta: GraphSnapshot | GraphDelta,
  limits: GraphStoreLimits,
): void {
  const records =
    'nodes' in snapshotOrDelta
      ? snapshotOrDelta.nodes.length + snapshotOrDelta.edges.length
      : snapshotOrDelta.upsertNodes.length +
        snapshotOrDelta.closeNodeIds.length +
        snapshotOrDelta.upsertEdges.length +
        snapshotOrDelta.closeEdgeIds.length;
  if (records > limits.maxRecords) {
    storeFail(
      'GRAPH_STORE_RECORD_LIMIT',
      `Graph projection contains more than ${limits.maxRecords} records.`,
    );
  }
}

function assertDeltaTransition(
  current: GraphSnapshot,
  target: GraphSnapshot,
  delta: GraphDelta,
): void {
  if (target.generatedAt !== delta.generatedAt) {
    storeFail(
      'GRAPH_STORE_CONTENT_INVALID',
      'Snapshot and delta generatedAt must identify the same deterministic projection run.',
    );
  }
  const nodes = new Map(current.nodes.map((node) => [node.id, node]));
  const edges = new Map(current.edges.map((edge) => [edge.id, edge]));

  for (const node of delta.upsertNodes) {
    if (nodes.get(node.id)?.validTo !== undefined) {
      storeFail(
        'GRAPH_STORE_CONTENT_INVALID',
        `Delta node upsert ${node.id} cannot reopen a closed v1 record.`,
      );
    }
    nodes.set(node.id, node);
  }
  for (const id of delta.closeNodeIds) {
    const existing = nodes.get(id);
    if (!existing || existing.validTo !== undefined) {
      storeFail(
        'GRAPH_STORE_CONTENT_INVALID',
        `Delta node closure ${id} must identify one currently open node.`,
      );
    }
    nodes.set(id, { ...existing, validTo: delta.generatedAt });
  }
  for (const edge of delta.upsertEdges) {
    if (edges.get(edge.id)?.validTo !== undefined) {
      storeFail(
        'GRAPH_STORE_CONTENT_INVALID',
        `Delta edge upsert ${edge.id} cannot reopen a closed v1 record.`,
      );
    }
    edges.set(edge.id, edge);
  }
  for (const id of delta.closeEdgeIds) {
    const existing = edges.get(id);
    if (!existing || existing.validTo !== undefined) {
      storeFail(
        'GRAPH_STORE_CONTENT_INVALID',
        `Delta edge closure ${id} must identify one currently open edge.`,
      );
    }
    edges.set(id, { ...existing, validTo: delta.generatedAt });
  }

  const compareRecords = <T extends GraphNode | GraphEdge>(
    actual: ReadonlyMap<string, T>,
    expected: readonly T[],
    kind: 'node' | 'edge',
  ): void => {
    const actualRecords = [...actual.values()].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    const expectedRecords = [...expected].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    if (canonicalJson(actualRecords) !== canonicalJson(expectedRecords)) {
      storeFail(
        'GRAPH_STORE_CONTENT_INVALID',
        `Delta ${kind} operations do not reconstruct the target snapshot exactly.`,
      );
    }
  };
  compareRecords(nodes, target.nodes, 'node');
  compareRecords(edges, target.edges, 'edge');
}

export class LocalGraphStore {
  readonly root: string;
  readonly limits: GraphStoreLimits;
  private readonly shadowPublisher: GraphShadowPublishPort | undefined;

  constructor(
    configuredRoot: string,
    limits: Partial<GraphStoreLimits> = {},
    /** Explicit only: the store never discovers or enables network shadowing from environment. */
    shadowPublisher?: GraphShadowPublishPort,
  ) {
    if (typeof configuredRoot !== 'string' || configuredRoot.length === 0) {
      storeFail('GRAPH_STORE_PATH_UNSAFE', 'Graph store root must be a non-empty path.');
    }
    this.root = resolve(configuredRoot);
    this.limits = resolveLimits(limits);
    this.shadowPublisher = shadowPublisher;
  }

  paths(scenarioInstanceId: string, cursor?: string, fromCursor?: string): GraphStorePathSet {
    return graphStorePaths(this.root, scenarioInstanceId, cursor, fromCursor);
  }

  async readSnapshot(scenarioInstanceId: string, cursor: string): Promise<GraphSnapshot> {
    return this.readSnapshotInternal(scenarioInstanceId, cursor, NO_TEST_HOOKS);
  }

  /** @internal */
  async readSnapshotForTest(
    scenarioInstanceId: string,
    cursor: string,
    hooks: GraphStoreIoTestHooks,
  ): Promise<GraphSnapshot> {
    return this.readSnapshotInternal(scenarioInstanceId, cursor, hooks);
  }

  private async readSnapshotInternal(
    scenarioInstanceId: string,
    cursor: string,
    hooks: GraphStoreIoTestHooks,
  ): Promise<GraphSnapshot> {
    const paths = this.paths(scenarioInstanceId, cursor);
    const prepared = await prepareStore(this.root, false, this.limits);
    const bytes = await readSecureBytes(
      paths.snapshotPath!,
      prepared.directories.snapshots!,
      this.limits,
      hooks,
    );
    let snapshot: GraphSnapshot;
    try {
      snapshot = assertGraphSnapshotIntegrity(parseStrictGraphJson(bytes));
    } catch (error) {
      return storeFail(
        'GRAPH_STORE_CONTENT_INVALID',
        `Stored graph snapshot is invalid: ${(error as Error).message}`,
        paths.snapshotPath,
      );
    }
    if (snapshot.scenarioInstanceId !== scenarioInstanceId || snapshot.cursor !== cursor) {
      return storeFail(
        'GRAPH_STORE_CONTENT_INVALID',
        'Stored graph snapshot does not match its requested scope and cursor.',
        paths.snapshotPath,
      );
    }
    assertRecordBound(snapshot, this.limits);
    return snapshot;
  }

  async readDelta(
    scenarioInstanceId: string,
    fromCursor: string,
    toCursor: string,
  ): Promise<GraphDelta> {
    const paths = this.paths(scenarioInstanceId, toCursor, fromCursor);
    const prepared = await prepareStore(this.root, false, this.limits);
    const bytes = await readSecureBytes(
      paths.deltaPath!,
      prepared.directories.deltas!,
      this.limits,
      NO_TEST_HOOKS,
    );
    let delta: GraphDelta;
    try {
      delta = assertGraphDeltaIntegrity(parseStrictGraphJson(bytes));
    } catch (error) {
      return storeFail(
        'GRAPH_STORE_CONTENT_INVALID',
        `Stored graph delta is invalid: ${(error as Error).message}`,
        paths.deltaPath,
      );
    }
    if (
      delta.scenarioInstanceId !== scenarioInstanceId ||
      delta.fromCursor !== fromCursor ||
      delta.toCursor !== toCursor
    ) {
      return storeFail(
        'GRAPH_STORE_CONTENT_INVALID',
        'Stored graph delta does not match its requested scope and cursors.',
        paths.deltaPath,
      );
    }
    assertRecordBound(delta, this.limits);
    return delta;
  }

  async readCurrentSnapshot(scenarioInstanceId: string): Promise<GraphSnapshot> {
    const before = await readCursorRecord(
      this.root,
      scenarioInstanceId,
      this.limits,
      NO_TEST_HOOKS,
      false,
    );
    const snapshot = await this.readSnapshot(scenarioInstanceId, before!.cursor);
    const after = await readCursorRecord(
      this.root,
      scenarioInstanceId,
      this.limits,
      NO_TEST_HOOKS,
      false,
    );
    if (canonicalJson(before) !== canonicalJson(after)) {
      return storeFail(
        'GRAPH_STORE_FILE_UNSAFE',
        'Graph cursor changed while the current snapshot was being read.',
      );
    }
    if (snapshot.integrityHash !== before!.snapshotIntegrityHash) {
      return storeFail(
        'GRAPH_STORE_CONTENT_INVALID',
        'Current cursor integrity does not match its snapshot.',
      );
    }
    return snapshot;
  }

  async currentCursor(scenarioInstanceId: string): Promise<string | null> {
    assertStoreIdentifier(scenarioInstanceId, 'scenarioInstanceId');
    if (!(await lstatIfPresent(this.root))) return null;
    const record = await readCursorRecord(
      this.root,
      scenarioInstanceId,
      this.limits,
      NO_TEST_HOOKS,
      true,
    );
    return record?.cursor ?? null;
  }

  async publishSnapshot(
    snapshotValue: GraphSnapshot,
    options: PublishGraphSnapshotOptions,
  ): Promise<PublishedGraphSnapshot> {
    return this.publishSnapshotAndObserve(snapshotValue, options, NO_TEST_HOOKS);
  }

  /** @internal */
  async publishSnapshotForTest(
    snapshotValue: GraphSnapshot,
    options: PublishGraphSnapshotOptions,
    hooks: GraphStoreIoTestHooks,
  ): Promise<PublishedGraphSnapshot> {
    return this.publishSnapshotAndObserve(snapshotValue, options, hooks);
  }

  private async publishSnapshotAndObserve(
    snapshotValue: GraphSnapshot,
    options: PublishGraphSnapshotOptions,
    hooks: GraphStoreIoTestHooks,
  ): Promise<PublishedGraphSnapshot> {
    const snapshot = assertGraphSnapshotIntegrity(snapshotValue);
    const delta =
      options.delta === undefined ? undefined : assertGraphDeltaIntegrity(options.delta);
    const published = await this.publishSnapshotInternal(
      snapshot,
      { expectedCursor: options.expectedCursor, ...(delta === undefined ? {} : { delta }) },
      hooks,
    );
    if (this.shadowPublisher) {
      this.enqueueShadowPublish({
        expectedCursor: options.expectedCursor,
        snapshot,
        ...(delta === undefined ? {} : { delta }),
      });
    }
    return published;
  }

  private enqueueShadowPublish(input: Parameters<GraphShadowPublishPort['publish']>[0]): void {
    const scenarioInstanceId = input.snapshot.scenarioInstanceId;
    const queueKey = `${this.root}\u0000${scenarioInstanceId}`;
    let queue = shadowPublicationQueues.get(queueKey);
    if (queue === undefined) {
      queue = {
        tail: Promise.resolve(),
        depth: 0,
        lastQueuedCursor: input.expectedCursor,
      };
      shadowPublicationQueues.set(queueKey, queue);
    }

    const task: ShadowPublicationTask = {
      publisher: this.shadowPublisher!,
      input,
    };
    if (
      queue.catchUp !== undefined ||
      queue.depth >= GRAPH_SHADOW_POLICY.maxQueuedPublicationsPerScenario
    ) {
      // Preserve one latest full snapshot outside the fixed-depth queue. Once
      // the accepted sequence drains, this can advance the shadow from its last
      // queued cursor without replaying or retaining every skipped transition.
      const expectedCursor = queue.catchUp?.input.expectedCursor ?? queue.lastQueuedCursor;
      queue.catchUp = {
        publisher: task.publisher,
        input: {
          expectedCursor,
          snapshot: task.input.snapshot,
        },
      };
      return;
    }

    this.appendShadowPublish(queueKey, queue, task);
  }

  private appendShadowPublish(
    queueKey: string,
    queue: ShadowPublicationQueue,
    task: ShadowPublicationTask,
  ): void {
    queue.depth += 1;
    queue.lastQueuedCursor = task.input.snapshot.cursor;
    const dispatch = async (): Promise<void> => {
      try {
        await task.publisher.publish(task.input, {
          backlog: Math.max(0, queue.depth - 1) + (queue.catchUp === undefined ? 0 : 1),
          inFlight: 1,
        });
      } catch {
        // The local TypeScript commit is authoritative throughout GS1. A broken
        // shadow adapter can neither roll it back nor turn it into a failure.
      }
    };
    const current = queue.tail.then(dispatch, dispatch);
    queue.tail = current;
    void current.finally(() => {
      queue.depth -= 1;
      if (queue.tail !== current) {
        return;
      }
      const catchUp = queue.catchUp;
      if (catchUp !== undefined) {
        queue.catchUp = undefined;
        this.appendShadowPublish(queueKey, queue, catchUp);
        return;
      }
      shadowPublicationQueues.delete(queueKey);
    });
  }

  private async publishSnapshotInternal(
    snapshotValue: GraphSnapshot,
    options: PublishGraphSnapshotOptions,
    hooks: GraphStoreIoTestHooks,
  ): Promise<PublishedGraphSnapshot> {
    const snapshot = assertGraphSnapshotIntegrity(snapshotValue);
    assertRecordBound(snapshot, this.limits);
    assertStoreIdentifier(snapshot.scenarioInstanceId, 'scenarioInstanceId');
    assertStoreIdentifier(snapshot.cursor, 'cursor');
    if (options.expectedCursor !== null) {
      assertStoreIdentifier(options.expectedCursor, 'expectedCursor');
    }
    const delta =
      options.delta === undefined ? undefined : assertGraphDeltaIntegrity(options.delta);
    if (
      delta &&
      (delta.scenarioInstanceId !== snapshot.scenarioInstanceId ||
        delta.fromCursor !== options.expectedCursor ||
        delta.toCursor !== snapshot.cursor)
    ) {
      storeFail(
        'GRAPH_STORE_CONTENT_INVALID',
        'Delta scope and cursors must bind the expected and published snapshot cursors.',
      );
    }
    if (delta) assertRecordBound(delta, this.limits);

    const snapshotBytes = serializeGraphSnapshot(snapshot);
    const deltaBytes = delta === undefined ? undefined : serializeGraphDelta(delta);
    if (
      snapshotBytes.length > this.limits.maxFileBytes ||
      (deltaBytes !== undefined && deltaBytes.length > this.limits.maxFileBytes)
    ) {
      storeFail(
        'GRAPH_STORE_FILE_TOO_LARGE',
        `Serialized graph projection exceeds ${this.limits.maxFileBytes} bytes.`,
      );
    }

    const paths = this.paths(snapshot.scenarioInstanceId, snapshot.cursor, delta?.fromCursor);
    const cursorRecord: CursorRecord = {
      schema: CURSOR_SCHEMA,
      scenarioInstanceId: snapshot.scenarioInstanceId,
      cursor: snapshot.cursor,
      snapshotIntegrityHash: snapshot.integrityHash,
      updatedAt: new Date().toISOString(),
    };
    const cursorBytes = Buffer.from(`${canonicalJson(cursorRecord)}\n`, 'utf8');
    const initialized = await prepareStore(this.root, true, this.limits);
    const publicationLockPath = join(initialized.directories.locks!, '.publication.lock');
    const publicationLock = await acquireLock(publicationLockPath);
    let publicationError: unknown;
    let cursorCommitted = false;
    try {
      const prepared = await prepareStore(this.root, false, this.limits);
      await assertProspectiveStoreCapacity(
        prepared,
        paths,
        snapshotBytes,
        deltaBytes,
        cursorBytes,
        this.limits,
      );
      const lock = await acquireLock(paths.lockPath);
      let operationError: unknown;
      try {
        await assertPreparedStoreStable(prepared);
        const current = await readCursorRecord(
          this.root,
          snapshot.scenarioInstanceId,
          this.limits,
          NO_TEST_HOOKS,
          true,
        );
        const actualCursor = current?.cursor ?? null;
        if (actualCursor !== options.expectedCursor) {
          return storeFail(
            'GRAPH_STORE_CURSOR_CONFLICT',
            `Expected cursor ${options.expectedCursor ?? '<none>'}, found ${actualCursor ?? '<none>'}.`,
            paths.cursorPath,
          );
        }
        if (snapshot.cursor === actualCursor) {
          return storeFail(
            'GRAPH_STORE_CURSOR_CONFLICT',
            'Published snapshot cursor must advance the current cursor.',
            paths.cursorPath,
          );
        }
        if (delta) {
          const currentSnapshot = await this.readSnapshot(
            snapshot.scenarioInstanceId,
            options.expectedCursor!,
          );
          if (currentSnapshot.integrityHash !== current?.snapshotIntegrityHash) {
            return storeFail(
              'GRAPH_STORE_CONTENT_INVALID',
              'Expected cursor does not bind the current snapshot integrity.',
              paths.cursorPath,
            );
          }
          assertDeltaTransition(currentSnapshot, snapshot, delta);
        }

        await assertPreparedStoreStable(prepared);
        await installImmutable(
          paths.snapshotPath!,
          prepared.directories.snapshots!,
          snapshotBytes,
          this.limits,
        );
        await hooks.afterProjectionWrite?.(paths.snapshotPath!);
        await assertPreparedStoreStable(prepared);
        if (delta && deltaBytes) {
          await installImmutable(
            paths.deltaPath!,
            prepared.directories.deltas!,
            deltaBytes,
            this.limits,
          );
          await hooks.afterProjectionWrite?.(paths.deltaPath!);
          await assertPreparedStoreStable(prepared);
        }
        await hooks.beforeCursorPublish?.(paths.cursorPath);
        await assertPreparedStoreStable(prepared);
        const repeatedCurrent = await readCursorRecord(
          this.root,
          snapshot.scenarioInstanceId,
          this.limits,
          NO_TEST_HOOKS,
          true,
        );
        if (canonicalJson(current) !== canonicalJson(repeatedCurrent)) {
          return storeFail(
            'GRAPH_STORE_CURSOR_CONFLICT',
            'Graph cursor changed after compare-and-swap precondition validation.',
            paths.cursorPath,
          );
        }
        const installedSnapshot = await readSecureBytes(
          paths.snapshotPath!,
          prepared.directories.snapshots!,
          this.limits,
          NO_TEST_HOOKS,
        );
        if (!installedSnapshot.equals(snapshotBytes)) {
          return storeFail(
            'GRAPH_STORE_FILE_UNSAFE',
            'Graph snapshot changed before cursor publication.',
            paths.snapshotPath,
          );
        }
        if (deltaBytes !== undefined) {
          const installedDelta = await readSecureBytes(
            paths.deltaPath!,
            prepared.directories.deltas!,
            this.limits,
            NO_TEST_HOOKS,
          );
          if (!installedDelta.equals(deltaBytes)) {
            return storeFail(
              'GRAPH_STORE_FILE_UNSAFE',
              'Graph delta changed before cursor publication.',
              paths.deltaPath,
            );
          }
        }
        await replaceAtomic(
          paths.cursorPath,
          prepared.directories.cursors!,
          cursorBytes,
          this.limits,
          () => {
            cursorCommitted = true;
          },
          hooks.afterCursorRename,
        );
        try {
          await assertPreparedStoreStable(prepared);
          const committedSnapshot = await readSecureBytes(
            paths.snapshotPath!,
            prepared.directories.snapshots!,
            this.limits,
            NO_TEST_HOOKS,
          );
          if (!committedSnapshot.equals(snapshotBytes)) {
            throw new Error('Committed snapshot bytes changed.');
          }
          if (deltaBytes !== undefined) {
            const committedDelta = await readSecureBytes(
              paths.deltaPath!,
              prepared.directories.deltas!,
              this.limits,
              NO_TEST_HOOKS,
            );
            if (!committedDelta.equals(deltaBytes)) {
              throw new Error('Committed delta bytes changed.');
            }
          }
          const publishedCursor = await readCursorRecord(
            this.root,
            snapshot.scenarioInstanceId,
            this.limits,
            NO_TEST_HOOKS,
            false,
          );
          if (
            publishedCursor!.cursor !== snapshot.cursor ||
            publishedCursor!.snapshotIntegrityHash !== snapshot.integrityHash
          ) {
            throw new Error('Committed cursor does not bind the published snapshot.');
          }
        } catch (error) {
          throw new GraphStoreError(
            'GRAPH_STORE_COMMITTED_UNVERIFIED',
            `Cursor ${snapshot.cursor} was atomically committed, but post-commit verification failed: ${(error as Error).message}`,
            paths.cursorPath,
          );
        }
        return {
          scenarioInstanceId: snapshot.scenarioInstanceId,
          previousCursor: actualCursor,
          cursor: snapshot.cursor,
          snapshotIntegrityHash: snapshot.integrityHash,
          snapshotPath: paths.snapshotPath!,
          ...(paths.deltaPath === undefined ? {} : { deltaPath: paths.deltaPath }),
        };
      } catch (error) {
        const reportedError =
          cursorCommitted &&
          !(error instanceof GraphStoreError && error.code === 'GRAPH_STORE_COMMITTED_UNVERIFIED')
            ? new GraphStoreError(
                'GRAPH_STORE_COMMITTED_UNVERIFIED',
                `Cursor ${snapshot.cursor} was atomically committed, but verification failed: ${(error as Error).message}`,
                paths.cursorPath,
              )
            : error;
        operationError = reportedError;
        throw reportedError;
      } finally {
        try {
          await releaseLock(paths.lockPath, lock);
        } catch (releaseError) {
          if (cursorCommitted) {
            throw new GraphStoreError(
              'GRAPH_STORE_COMMITTED_UNVERIFIED',
              `Cursor ${snapshot.cursor} was committed, but scenario lock release failed: ${(releaseError as Error).message}`,
              paths.cursorPath,
            );
          }
          if (operationError === undefined) throw releaseError;
        }
      }
    } catch (error) {
      publicationError = error;
      throw error;
    } finally {
      try {
        await releaseLock(publicationLockPath, publicationLock);
      } catch (releaseError) {
        if (cursorCommitted) {
          throw new GraphStoreError(
            'GRAPH_STORE_COMMITTED_UNVERIFIED',
            `Cursor ${snapshot.cursor} was committed, but publication lock release failed: ${(releaseError as Error).message}`,
            paths.cursorPath,
          );
        }
        if (publicationError === undefined) throw releaseError;
      }
    }
  }
}
