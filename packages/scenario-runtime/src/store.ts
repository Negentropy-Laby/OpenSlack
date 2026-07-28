import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { threadId } from 'node:worker_threads';
import { canonicalJson, parseStrictGraphJson } from '@openslack/organization-graph';
import {
  isTrustedScenarioInstance,
  transitionScenarioInstance,
  trustValidatedScenarioInstance,
  validateScenarioInstance,
  type ScenarioInstance,
  ScenarioInstanceError,
} from './instance.js';

const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4_096;
const SAFE_SCOPE = /^[^\u0000-\u001f\u007f/\\]+$/;
const CAPACITY_LOCK_SCHEMA = 'openslack.scenario_store_lock.v1';
const CAPACITY_LOCK_MAX_BYTES = 512;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TEMPORARY_FILE =
  /^\.[0-9a-f]{64}\.[1-9][0-9]{0,9}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const CAPACITY_LOCK_TEMPORARY_FILE =
  /^\.capacity\.([1-9][0-9]{0,9})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9]{1,10})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const PROCESS_SESSION_ID = randomUUID();

export class ScenarioInstanceStoreError extends Error {
  readonly code:
    | 'SCENARIO_STORE_PATH_UNSAFE'
    | 'SCENARIO_STORE_NOT_FOUND'
    | 'SCENARIO_STORE_BUSY'
    | 'SCENARIO_STORE_LIMIT_EXCEEDED'
    | 'SCENARIO_STORE_FILE_UNSAFE'
    | 'SCENARIO_STORE_FILE_CHANGED'
    | 'SCENARIO_STORE_SCOPE_MISMATCH'
    | 'SCENARIO_STORE_CAS_MISMATCH'
    | 'SCENARIO_STORE_RECORD_INVALID';
  readonly path?: string;

  constructor(code: ScenarioInstanceStoreError['code'], message: string, path?: string) {
    super(message);
    this.name = 'ScenarioInstanceStoreError';
    this.code = code;
    this.path = path;
  }
}

export interface ScenarioInstanceStoreHooks {
  readonly afterBoundedRead?: (path: string) => void | Promise<void>;
  readonly beforeAtomicRename?: (path: string) => void | Promise<void>;
  readonly crashAt?: 'after_lock_temporary_sync' | 'after_temporary_sync' | 'after_directory_sync';
}

export interface StoredScenarioInstance {
  readonly instance: ScenarioInstance;
  readonly revision: string;
}

const NO_HOOKS: ScenarioInstanceStoreHooks = Object.freeze({});
const STORE_TEST_HOOKS = new WeakMap<LocalScenarioInstanceStore, ScenarioInstanceStoreHooks>();

interface CapacityLockOwner {
  readonly schema: typeof CAPACITY_LOCK_SCHEMA;
  readonly pid: number;
  readonly sessionId: string;
  readonly threadId: number;
  readonly nonce: string;
  readonly createdAt: string;
}

interface AcquiredCapacityLock {
  readonly path: string;
  readonly handle: FileHandle;
  readonly owner: CapacityLockOwner;
  readonly stat: Stats;
}

class SimulatedScenarioStoreCrash extends Error {
  constructor(point: NonNullable<ScenarioInstanceStoreHooks['crashAt']>) {
    super(`Simulated Scenario instance-store crash at ${point}.`);
    this.name = 'SimulatedScenarioStoreCrash';
  }
}

interface PreparedStore {
  readonly root: string;
  readonly rootReal: string;
  readonly rootStat: Stats;
  readonly instances: string;
  readonly instancesReal: string;
  readonly instancesStat: Stats;
  readonly locks: string;
  readonly locksReal: string;
  readonly locksStat: Stats;
  readonly scopeDirectory: string;
  readonly scopeDirectoryReal: string;
  readonly scopeDirectoryStat: Stats;
  readonly totalBytes: number;
  readonly entries: number;
}

function fail(code: ScenarioInstanceStoreError['code'], message: string, path?: string): never {
  throw new ScenarioInstanceStoreError(code, message, path);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
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

function key(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertScope(value: string, label: string): void {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    !SAFE_SCOPE.test(value)
  ) {
    fail('SCENARIO_STORE_PATH_UNSAFE', `${label} is not a safe instance-store scope.`);
  }
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertDirectory(path: string): Promise<{ stat: Stats; real: string }> {
  const stat = await lstatIfPresent(path);
  if (!stat) return fail('SCENARIO_STORE_NOT_FOUND', 'Instance-store directory is missing.', path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return fail(
      'SCENARIO_STORE_PATH_UNSAFE',
      'Instance-store path must be a real directory.',
      path,
    );
  }
  const real = await realpath(path);
  if (!samePath(path, real)) {
    return fail(
      'SCENARIO_STORE_PATH_UNSAFE',
      'Instance-store path cannot traverse a symlink.',
      path,
    );
  }
  return { stat, real };
}

async function ensureFixedChild(parentReal: string, path: string): Promise<void> {
  const existing = await lstatIfPresent(path);
  if (!existing) {
    await mkdir(path, { recursive: false, mode: 0o700 });
  }
  const child = await assertDirectory(path);
  if (!contained(parentReal, child.real)) {
    return fail('SCENARIO_STORE_PATH_UNSAFE', 'Instance-store child escapes its parent.', path);
  }
}

async function scanStore(root: string): Promise<{ totalBytes: number; entries: number }> {
  let totalBytes = 0;
  let entries = 0;
  const rootEntries = await readdir(root, { withFileTypes: true });
  const rootNames = rootEntries.map((entry) => entry.name).sort();
  if (
    rootNames.length !== 2 ||
    rootNames[0] !== 'instances' ||
    rootNames[1] !== 'locks' ||
    rootEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())
  ) {
    return fail(
      'SCENARIO_STORE_FILE_UNSAFE',
      'Instance-store root contains an unknown or non-directory entry.',
      root,
    );
  }
  const visitFlat = async (
    directory: string,
    allowedName: RegExp,
    allowCapacityLock: boolean,
  ): Promise<void> => {
    const values = await readdir(directory, { withFileTypes: true });
    entries += values.length;
    if (entries > MAX_ENTRIES) {
      return fail(
        'SCENARIO_STORE_LIMIT_EXCEEDED',
        'Instance-store directory entry limit exceeded.',
      );
    }
    for (const value of values) {
      const path = join(directory, value.name);
      const stat = await lstat(path);
      if (
        value.isSymbolicLink() ||
        stat.isSymbolicLink() ||
        !value.isFile() ||
        !stat.isFile() ||
        (!allowedName.test(value.name) && !(allowCapacityLock && value.name === 'capacity.lock'))
      ) {
        return fail('SCENARIO_STORE_PATH_UNSAFE', 'Instance-store symlinks are forbidden.', path);
      }
      totalBytes += stat.size;
      if (stat.size > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
        return fail('SCENARIO_STORE_LIMIT_EXCEEDED', 'Instance-store byte limit exceeded.');
      }
    }
  };
  await visitFlat(join(root, 'instances'), /^[0-9a-f]{64}\.json$/, false);
  await visitFlat(join(root, 'locks'), /^(?!)$/, true);
  return { totalBytes, entries };
}

async function prepare(
  configuredRoot: string,
  correlationId: string,
  create: boolean,
  scan = true,
): Promise<PreparedStore> {
  if (
    typeof configuredRoot !== 'string' ||
    !isAbsolute(configuredRoot) ||
    resolve(configuredRoot) !== configuredRoot ||
    configuredRoot.includes('\0')
  ) {
    return fail('SCENARIO_STORE_PATH_UNSAFE', 'Store root must be a normalized absolute path.');
  }
  assertScope(correlationId, 'correlationId');
  const root = await assertDirectory(configuredRoot);
  const instancesPath = join(configuredRoot, 'instances');
  const locksPath = join(configuredRoot, 'locks');
  if (create) {
    await ensureFixedChild(root.real, instancesPath);
    await ensureFixedChild(root.real, locksPath);
  }
  const instances = await assertDirectory(instancesPath);
  const locks = await assertDirectory(locksPath);
  if (!contained(root.real, instances.real) || !contained(root.real, locks.real)) {
    return fail('SCENARIO_STORE_PATH_UNSAFE', 'Store directory escapes its root.');
  }
  // Instance IDs are globally idempotent across correlations. Correlation remains bound in the
  // record and caller scope; using it as a directory would create duplicate physical instances.
  const scopeDirectory = instancesPath;
  const scope = instances;
  const usage = scan ? await scanStore(configuredRoot) : { totalBytes: 0, entries: 0 };
  return {
    root: configuredRoot,
    rootReal: root.real,
    rootStat: root.stat,
    instances: instancesPath,
    instancesReal: instances.real,
    instancesStat: instances.stat,
    locks: locksPath,
    locksReal: locks.real,
    locksStat: locks.stat,
    scopeDirectory,
    scopeDirectoryReal: scope.real,
    scopeDirectoryStat: scope.stat,
    ...usage,
  };
}

function targetPath(prepared: PreparedStore, instanceId: string): string {
  assertScope(instanceId, 'instanceId');
  return join(prepared.scopeDirectory, `${key(instanceId)}.json`);
}

async function assertFile(path: string, expectedDirectory: string): Promise<Stats> {
  const stat = await lstatIfPresent(path);
  if (!stat) return fail('SCENARIO_STORE_NOT_FOUND', 'Scenario instance is not present.', path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
    return fail('SCENARIO_STORE_FILE_UNSAFE', 'Scenario instance file is unsafe.', path);
  }
  const real = await realpath(path);
  if (!contained(expectedDirectory, real) || !samePath(path, real)) {
    return fail('SCENARIO_STORE_PATH_UNSAFE', 'Scenario instance file escapes its scope.', path);
  }
  return stat;
}

async function boundedRead(
  prepared: PreparedStore,
  instanceId: string,
  correlationId: string,
  hooks: ScenarioInstanceStoreHooks,
): Promise<{ instance: ScenarioInstance; bytes: Buffer; stat: Stats }> {
  const path = targetPath(prepared, instanceId);
  const initial = await assertFile(path, prepared.scopeDirectoryReal);
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const before = await handle.stat();
    if (!sameIdentity(initial, before) || before.size > MAX_FILE_BYTES) {
      return fail('SCENARIO_STORE_FILE_CHANGED', 'Scenario instance changed before read.', path);
    }
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_FILE_BYTES) {
      return fail('SCENARIO_STORE_LIMIT_EXCEEDED', 'Scenario instance file is oversized.', path);
    }
    const after = await handle.stat();
    if (!stableIdentity(before, after) || after.size !== offset) {
      return fail('SCENARIO_STORE_FILE_CHANGED', 'Scenario instance changed during read.', path);
    }
    await hooks.afterBoundedRead?.(path);
    const final = await assertFile(path, prepared.scopeDirectoryReal);
    if (!stableIdentity(after, final)) {
      return fail('SCENARIO_STORE_FILE_CHANGED', 'Scenario instance changed after read.', path);
    }
    const bytes = Buffer.from(buffer.subarray(0, offset));
    let parsed: unknown;
    try {
      parsed = parseStrictGraphJson(bytes, {
        maxDepth: 16,
        maxNodes: 10_000,
        maxStringLength: 2_048,
      });
    } catch {
      return fail('SCENARIO_STORE_RECORD_INVALID', 'Scenario instance JSON is invalid.', path);
    }
    let instance: ScenarioInstance;
    try {
      instance = trustValidatedScenarioInstance(validateScenarioInstance(parsed));
    } catch (error) {
      if (error instanceof ScenarioInstanceError) {
        return fail('SCENARIO_STORE_RECORD_INVALID', 'Scenario instance record is invalid.', path);
      }
      throw error;
    }
    if (instance.id !== instanceId || instance.correlationId !== correlationId) {
      return fail(
        'SCENARIO_STORE_SCOPE_MISMATCH',
        'Scenario instance path and record scope do not match.',
        path,
      );
    }
    return { instance, bytes, stat: final };
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten < 1) throw new Error('Instance-store write made no progress.');
    offset += bytesWritten;
  }
}

function capacityLockBytes(owner: CapacityLockOwner): Buffer {
  return Buffer.from(`${canonicalJson(owner)}\n`, 'utf8');
}

function validateCapacityLockOwner(value: unknown): CapacityLockOwner {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail(
      'SCENARIO_STORE_FILE_UNSAFE',
      'Instance-store capacity lock owner record is invalid.',
    );
  }
  const keys = Reflect.ownKeys(value);
  const fields = ['schema', 'pid', 'sessionId', 'threadId', 'nonce', 'createdAt'] as const;
  if (
    keys.length !== fields.length ||
    keys.some((field) => typeof field !== 'string' || !fields.includes(field as never))
  ) {
    return fail(
      'SCENARIO_STORE_FILE_UNSAFE',
      'Instance-store capacity lock owner record is not closed.',
    );
  }
  for (const field of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return fail(
        'SCENARIO_STORE_FILE_UNSAFE',
        'Instance-store capacity lock owner fields must be inert data.',
      );
    }
  }
  const record = value as Record<string, unknown>;
  const createdAt = record.createdAt;
  if (
    record.schema !== CAPACITY_LOCK_SCHEMA ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) < 1 ||
    (record.pid as number) > 2_147_483_647 ||
    typeof record.sessionId !== 'string' ||
    !UUID_V4.test(record.sessionId) ||
    !Number.isSafeInteger(record.threadId) ||
    (record.threadId as number) < 0 ||
    (record.threadId as number) > 2_147_483_647 ||
    typeof record.nonce !== 'string' ||
    !UUID_V4.test(record.nonce) ||
    typeof createdAt !== 'string' ||
    Buffer.byteLength(createdAt, 'utf8') > 64 ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(Date.parse(createdAt)).toISOString() !== createdAt
  ) {
    return fail(
      'SCENARIO_STORE_FILE_UNSAFE',
      'Instance-store capacity lock owner metadata is invalid.',
    );
  }
  return Object.freeze({
    schema: CAPACITY_LOCK_SCHEMA,
    pid: record.pid as number,
    sessionId: record.sessionId,
    threadId: record.threadId as number,
    nonce: record.nonce,
    createdAt,
  });
}

async function readCapacityLock(
  prepared: PreparedStore,
  path: string,
): Promise<{ owner: CapacityLockOwner; stat: Stats }> {
  const initial = await lstatIfPresent(path);
  if (
    !initial ||
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.size < 1 ||
    initial.size > CAPACITY_LOCK_MAX_BYTES
  ) {
    return fail('SCENARIO_STORE_FILE_UNSAFE', 'Instance-store capacity lock file is unsafe.', path);
  }
  const initialReal = await realpath(path);
  if (!samePath(path, initialReal) || !contained(prepared.locksReal, initialReal)) {
    return fail(
      'SCENARIO_STORE_PATH_UNSAFE',
      'Instance-store capacity lock escapes its directory.',
      path,
    );
  }
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const before = await handle.stat();
    if (!sameIdentity(initial, before) || before.size > CAPACITY_LOCK_MAX_BYTES) {
      return fail(
        'SCENARIO_STORE_FILE_CHANGED',
        'Instance-store capacity lock changed before read.',
        path,
      );
    }
    const buffer = Buffer.allocUnsafe(CAPACITY_LOCK_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > CAPACITY_LOCK_MAX_BYTES) {
      return fail(
        'SCENARIO_STORE_LIMIT_EXCEEDED',
        'Instance-store capacity lock exceeds its byte limit.',
        path,
      );
    }
    const after = await handle.stat();
    const final = await lstat(path);
    if (!stableIdentity(before, after) || !stableIdentity(after, final) || after.size !== offset) {
      return fail(
        'SCENARIO_STORE_FILE_CHANGED',
        'Instance-store capacity lock changed during read.',
        path,
      );
    }
    const bytes = Buffer.from(buffer.subarray(0, offset));
    let parsed: unknown;
    try {
      parsed = parseStrictGraphJson(bytes, {
        maxDepth: 4,
        maxNodes: 16,
        maxStringLength: 128,
      });
    } catch {
      return fail(
        'SCENARIO_STORE_FILE_UNSAFE',
        'Instance-store capacity lock JSON is invalid.',
        path,
      );
    }
    const owner = validateCapacityLockOwner(parsed);
    if (!bytes.equals(capacityLockBytes(owner))) {
      return fail(
        'SCENARIO_STORE_FILE_UNSAFE',
        'Instance-store capacity lock is not canonical.',
        path,
      );
    }
    return { owner, stat: final };
  } finally {
    await handle.close();
  }
}

function capacityLockOwnerIsProvablyDead(owner: CapacityLockOwner): boolean {
  // PID-scoped liveness is deliberately conservative. Worker isolates and duplicate module
  // instances can share a PID without sharing this module's in-memory nonce set.
  if (owner.pid === process.pid) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function removeProvablyStaleCapacityLock(
  prepared: PreparedStore,
  path: string,
  observed: Awaited<ReturnType<typeof readCapacityLock>>,
): Promise<void> {
  if (!capacityLockOwnerIsProvablyDead(observed.owner)) {
    return fail('SCENARIO_STORE_BUSY', 'Instance-store capacity is locked.', path);
  }
  const repeated = await lstat(path);
  const repeatedReal = await realpath(path);
  if (
    !stableIdentity(observed.stat, repeated) ||
    !samePath(path, repeatedReal) ||
    !contained(prepared.locksReal, repeatedReal)
  ) {
    return fail(
      'SCENARIO_STORE_FILE_CHANGED',
      'Instance-store capacity lock changed before stale repair.',
      path,
    );
  }
  await rm(path);
  await syncDirectory(prepared.locks);
}

function ownerFromCapacityLockTemporaryName(name: string): CapacityLockOwner | undefined {
  const match = CAPACITY_LOCK_TEMPORARY_FILE.exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]);
  const ownerThreadId = Number(match[3]);
  if (
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    pid > 2_147_483_647 ||
    !Number.isSafeInteger(ownerThreadId) ||
    ownerThreadId < 0 ||
    ownerThreadId > 2_147_483_647
  ) {
    return undefined;
  }
  return {
    schema: CAPACITY_LOCK_SCHEMA,
    pid,
    sessionId: match[2]!,
    threadId: ownerThreadId,
    nonce: match[4]!,
    createdAt: '1970-01-01T00:00:00.000Z',
  };
}

async function recoverCapacityLockTemporaryFiles(prepared: PreparedStore): Promise<void> {
  const values = await readdir(prepared.locks, { withFileTypes: true });
  let removed = false;
  for (const value of values) {
    if (!value.name.startsWith('.capacity.')) continue;
    const path = join(prepared.locks, value.name);
    const owner = ownerFromCapacityLockTemporaryName(value.name);
    if (!owner) {
      return fail(
        'SCENARIO_STORE_PATH_UNSAFE',
        'Instance-store contains an unrecognized capacity-lock artifact.',
        path,
      );
    }
    const initial = await lstat(path);
    const resolved = await realpath(path);
    if (
      value.isSymbolicLink() ||
      initial.isSymbolicLink() ||
      !value.isFile() ||
      !initial.isFile() ||
      initial.size > CAPACITY_LOCK_MAX_BYTES ||
      !samePath(path, resolved) ||
      !contained(prepared.locksReal, resolved)
    ) {
      return fail(
        'SCENARIO_STORE_FILE_UNSAFE',
        'Instance-store capacity-lock temporary file is unsafe.',
        path,
      );
    }
    if (!capacityLockOwnerIsProvablyDead(owner)) {
      return fail('SCENARIO_STORE_BUSY', 'Instance-store capacity claim is active.', path);
    }
    const repeated = await lstat(path);
    if (!stableIdentity(initial, repeated)) {
      return fail(
        'SCENARIO_STORE_FILE_CHANGED',
        'Instance-store capacity-lock temporary changed during recovery.',
        path,
      );
    }
    await rm(path);
    removed = true;
  }
  if (removed) await syncDirectory(prepared.locks);
}

async function acquireCapacityLock(
  prepared: PreparedStore,
  hooks: ScenarioInstanceStoreHooks = NO_HOOKS,
): Promise<AcquiredCapacityLock> {
  const path = join(prepared.locks, 'capacity.lock');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await recoverCapacityLockTemporaryFiles(prepared);
    const owner: CapacityLockOwner = Object.freeze({
      schema: CAPACITY_LOCK_SCHEMA,
      pid: process.pid,
      sessionId: PROCESS_SESSION_ID,
      threadId,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    const temporaryPath = join(
      prepared.locks,
      `.capacity.${owner.pid}.${owner.sessionId}.${owner.threadId}.${owner.nonce}.tmp`,
    );
    const handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      const bytes = capacityLockBytes(owner);
      await writeAll(handle, bytes);
      await handle.sync();
      const trusted = await handle.stat();
      const temporaryStat = await lstat(temporaryPath);
      const temporaryReal = await realpath(temporaryPath);
      if (
        !stableIdentity(trusted, temporaryStat) ||
        temporaryStat.size !== bytes.length ||
        !samePath(temporaryPath, temporaryReal) ||
        !contained(prepared.locksReal, temporaryReal)
      ) {
        return fail(
          'SCENARIO_STORE_FILE_CHANGED',
          'Instance-store capacity-lock temporary changed during acquisition.',
          temporaryPath,
        );
      }
      if (hooks.crashAt === 'after_lock_temporary_sync') {
        await handle.close().catch(() => undefined);
        throw new SimulatedScenarioStoreCrash('after_lock_temporary_sync');
      }
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await handle.close().catch(() => undefined);
        await rm(temporaryPath);
        await syncDirectory(prepared.locks);
        await removeProvablyStaleCapacityLock(
          prepared,
          path,
          await readCapacityLock(prepared, path),
        );
        continue;
      }
      await syncDirectory(prepared.locks);
      const published = await lstat(path);
      const publishedReal = await realpath(path);
      if (
        !sameIdentity(trusted, published) ||
        published.size !== bytes.length ||
        !samePath(path, publishedReal) ||
        !contained(prepared.locksReal, publishedReal)
      ) {
        return fail(
          'SCENARIO_STORE_FILE_CHANGED',
          'Instance-store capacity lock changed during atomic publication.',
          path,
        );
      }
      await rm(temporaryPath);
      await syncDirectory(prepared.locks);
      const pathStat = await lstat(path);
      if (!sameIdentity(published, pathStat) || pathStat.size !== bytes.length) {
        return fail(
          'SCENARIO_STORE_FILE_CHANGED',
          'Instance-store capacity lock changed after atomic publication.',
          path,
        );
      }
      return { path, handle, owner, stat: pathStat };
    } catch (error) {
      if (error instanceof SimulatedScenarioStoreCrash) throw error;
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return fail('SCENARIO_STORE_BUSY', 'Instance-store capacity lock retry limit exceeded.', path);
}

async function releaseCapacityLock(lock: AcquiredCapacityLock, remove: boolean): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  if (!remove) return;
  const current = await lstatIfPresent(lock.path);
  const currentReal = current ? await realpath(lock.path) : undefined;
  if (
    !current ||
    !sameIdentity(lock.stat, current) ||
    current.size !== lock.stat.size ||
    !currentReal ||
    !samePath(lock.path, currentReal)
  ) {
    return fail(
      'SCENARIO_STORE_FILE_CHANGED',
      'Instance-store capacity lock changed before release.',
      lock.path,
    );
  }
  await rm(lock.path);
  await syncDirectory(dirname(lock.path));
}

async function recoverTemporaryFiles(prepared: PreparedStore): Promise<void> {
  const values = await readdir(prepared.instances, { withFileTypes: true });
  let removed = false;
  for (const value of values) {
    if (!value.name.startsWith('.')) continue;
    const path = join(prepared.instances, value.name);
    if (!TEMPORARY_FILE.test(value.name)) {
      return fail(
        'SCENARIO_STORE_PATH_UNSAFE',
        'Instance-store contains an unrecognized temporary artifact.',
        path,
      );
    }
    const initial = await lstat(path);
    const resolved = await realpath(path);
    if (
      value.isSymbolicLink() ||
      initial.isSymbolicLink() ||
      !value.isFile() ||
      !initial.isFile() ||
      initial.size > MAX_FILE_BYTES ||
      !samePath(path, resolved) ||
      !contained(prepared.instancesReal, resolved)
    ) {
      return fail('SCENARIO_STORE_FILE_UNSAFE', 'Instance-store temporary file is unsafe.', path);
    }
    const repeated = await lstat(path);
    if (!stableIdentity(initial, repeated)) {
      return fail(
        'SCENARIO_STORE_FILE_CHANGED',
        'Instance-store temporary file changed during recovery.',
        path,
      );
    }
    await rm(path);
    removed = true;
  }
  if (removed) await syncDirectory(prepared.instances);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    await handle.close();
  }
}

function revision(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertImmutableBinding(current: ScenarioInstance, next: ScenarioInstance): void {
  const immutableFields = [
    'id',
    'definitionId',
    'definitionVersion',
    'definitionHash',
    'correlationId',
    'planId',
    'planHash',
    'createdAt',
  ] as const;
  if (
    immutableFields.some((field) => current[field] !== next[field]) ||
    canonicalJson(current.targetRefs) !== canonicalJson(next.targetRefs)
  ) {
    return fail(
      'SCENARIO_STORE_RECORD_INVALID',
      'Scenario instance immutable binding cannot change.',
    );
  }
  if (Date.parse(next.updatedAt) <= Date.parse(current.updatedAt)) {
    return fail(
      'SCENARIO_STORE_CAS_MISMATCH',
      'Scenario instance update time must advance monotonically.',
    );
  }
  if (
    current.workflowRunIds.some((id) => !next.workflowRunIds.includes(id)) ||
    current.evidenceRefs.some((id) => !next.evidenceRefs.includes(id))
  ) {
    return fail(
      'SCENARIO_STORE_RECORD_INVALID',
      'Scenario instance evidence and workflow bindings are append-only.',
    );
  }
  if (current.state !== next.state) {
    try {
      transitionScenarioInstance(current, {
        state: next.state,
        updatedAt: next.updatedAt,
        workflowRunIds: next.workflowRunIds,
        evidenceRefs: next.evidenceRefs,
      });
    } catch {
      return fail(
        'SCENARIO_STORE_RECORD_INVALID',
        'Scenario instance lifecycle transition is invalid.',
      );
    }
  } else if (['completed', 'failed', 'cancelled'].includes(current.state)) {
    return fail('SCENARIO_STORE_RECORD_INVALID', 'Terminal Scenario instances are immutable.');
  }
}

async function assertPreparedStable(prepared: PreparedStore): Promise<void> {
  const root = await assertDirectory(prepared.root);
  const instances = await assertDirectory(prepared.instances);
  const locks = await assertDirectory(prepared.locks);
  const scope = await assertDirectory(prepared.scopeDirectory);
  if (
    !sameIdentity(prepared.rootStat, root.stat) ||
    !sameIdentity(prepared.instancesStat, instances.stat) ||
    !sameIdentity(prepared.locksStat, locks.stat) ||
    !sameIdentity(prepared.scopeDirectoryStat, scope.stat) ||
    !samePath(prepared.rootReal, root.real) ||
    !samePath(prepared.instancesReal, instances.real) ||
    !samePath(prepared.locksReal, locks.real) ||
    !samePath(prepared.scopeDirectoryReal, scope.real)
  ) {
    return fail('SCENARIO_STORE_PATH_UNSAFE', 'Instance-store directory identity changed.');
  }
}

export class LocalScenarioInstanceStore {
  readonly #root: string;
  readonly #correlationId: string;

  constructor(root: string, correlationId: string) {
    assertScope(correlationId, 'correlationId');
    this.#root = root;
    this.#correlationId = correlationId;
  }

  async read(instanceId: string): Promise<ScenarioInstance | undefined> {
    return (await this.readWithRevision(instanceId))?.instance;
  }

  async readWithRevision(instanceId: string): Promise<StoredScenarioInstance | undefined> {
    let prepared = await prepare(this.#root, this.#correlationId, false, false).catch((error) => {
      if (
        error instanceof ScenarioInstanceStoreError &&
        error.code === 'SCENARIO_STORE_NOT_FOUND'
      ) {
        return undefined;
      }
      throw error;
    });
    if (!prepared) return undefined;
    const capacityLock = await acquireCapacityLock(prepared);
    try {
      await recoverTemporaryFiles(prepared);
      prepared = await prepare(this.#root, this.#correlationId, false);
      await assertPreparedStable(prepared);
    } finally {
      await releaseCapacityLock(capacityLock, true);
    }
    const path = targetPath(prepared, instanceId);
    if (!(await lstatIfPresent(path))) return undefined;
    const read = await boundedRead(
      prepared,
      instanceId,
      this.#correlationId,
      STORE_TEST_HOOKS.get(this) ?? NO_HOOKS,
    );
    return Object.freeze({ instance: read.instance, revision: revision(read.bytes) });
  }

  async write(
    value: ScenarioInstance,
    options: { readonly expectedRevision: string | null },
  ): Promise<StoredScenarioInstance> {
    const trustedFirstWrite = isTrustedScenarioInstance(value);
    const instance = validateScenarioInstance(value);
    if (instance.correlationId !== this.#correlationId) {
      return fail(
        'SCENARIO_STORE_SCOPE_MISMATCH',
        'Scenario instance correlation does not match the store scope.',
      );
    }
    const bytes = Buffer.from(`${canonicalJson(instance)}\n`, 'utf8');
    if (bytes.length > MAX_FILE_BYTES) {
      return fail('SCENARIO_STORE_LIMIT_EXCEEDED', 'Scenario instance exceeds file limit.');
    }
    let prepared = await prepare(this.#root, this.#correlationId, true, false);
    const path = targetPath(prepared, instance.id);
    const temporaryPath = join(
      prepared.scopeDirectory,
      `.${key(instance.id)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let capacityLock: AcquiredCapacityLock | undefined;
    let temporary: FileHandle | undefined;
    let simulatedCrash = false;
    try {
      capacityLock = await acquireCapacityLock(prepared, STORE_TEST_HOOKS.get(this) ?? NO_HOOKS);
      await recoverTemporaryFiles(prepared);
      prepared = await prepare(this.#root, this.#correlationId, false);
      if (
        prepared.totalBytes + bytes.length * 2 > MAX_TOTAL_BYTES ||
        prepared.entries + 1 > MAX_ENTRIES
      ) {
        return fail(
          'SCENARIO_STORE_LIMIT_EXCEEDED',
          'Scenario instance publication exceeds capacity including atomic reserve.',
        );
      }
      await assertPreparedStable(prepared);
      const existing = await lstatIfPresent(path);
      if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
        return fail('SCENARIO_STORE_FILE_UNSAFE', 'Scenario instance target is unsafe.', path);
      }
      let current: ScenarioInstance | undefined;
      let currentRevision: string | null = null;
      let currentBytes: Buffer | undefined;
      if (existing) {
        const read = await boundedRead(prepared, instance.id, this.#correlationId, NO_HOOKS);
        current = read.instance;
        currentBytes = read.bytes;
        currentRevision = revision(read.bytes);
      }
      if (!current && !trustedFirstWrite) {
        return fail(
          'SCENARIO_STORE_RECORD_INVALID',
          'A new Scenario instance must come from the canonical planner.',
        );
      }
      if (
        options.expectedRevision === null &&
        current &&
        currentBytes?.equals(bytes) &&
        currentRevision
      ) {
        return Object.freeze({ instance: current, revision: currentRevision });
      }
      if (currentRevision !== options.expectedRevision) {
        return fail('SCENARIO_STORE_CAS_MISMATCH', 'Scenario instance compare-and-swap failed.');
      }
      if (current) assertImmutableBinding(current, instance);
      temporary = await open(
        temporaryPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      await writeAll(temporary, bytes);
      await temporary.sync();
      if ((STORE_TEST_HOOKS.get(this) ?? NO_HOOKS).crashAt === 'after_temporary_sync') {
        simulatedCrash = true;
        throw new SimulatedScenarioStoreCrash('after_temporary_sync');
      }
      const trustedTemporaryStat = await temporary.stat();
      await temporary.close();
      temporary = undefined;
      await assertPreparedStable(prepared);
      const tempReal = await realpath(temporaryPath);
      const tempPathStat = await lstat(temporaryPath);
      if (
        !samePath(dirname(tempReal), prepared.scopeDirectoryReal) ||
        !stableIdentity(trustedTemporaryStat, tempPathStat) ||
        tempPathStat.size !== bytes.length
      ) {
        return fail('SCENARIO_STORE_PATH_UNSAFE', 'Temporary instance file escaped its scope.');
      }
      await (STORE_TEST_HOOKS.get(this) ?? NO_HOOKS).beforeAtomicRename?.(path);
      await assertPreparedStable(prepared);
      const repeatedTempStat = await lstat(temporaryPath);
      const repeatedTempReal = await realpath(temporaryPath);
      if (
        !stableIdentity(trustedTemporaryStat, repeatedTempStat) ||
        !samePath(tempReal, repeatedTempReal)
      ) {
        return fail('SCENARIO_STORE_FILE_CHANGED', 'Temporary instance file changed before write.');
      }
      const repeatedTarget = await lstatIfPresent(path);
      if (
        repeatedTarget?.isSymbolicLink() ||
        (repeatedTarget && !repeatedTarget.isFile()) ||
        Boolean(existing) !== Boolean(repeatedTarget) ||
        (existing && repeatedTarget && !stableIdentity(existing, repeatedTarget))
      ) {
        return fail(
          'SCENARIO_STORE_FILE_CHANGED',
          'Scenario instance target changed before write.',
        );
      }
      await rename(temporaryPath, path);
      await syncDirectory(prepared.scopeDirectory);
      if ((STORE_TEST_HOOKS.get(this) ?? NO_HOOKS).crashAt === 'after_directory_sync') {
        simulatedCrash = true;
        throw new SimulatedScenarioStoreCrash('after_directory_sync');
      }
      await assertPreparedStable(prepared);
      const installed = await assertFile(path, prepared.scopeDirectoryReal);
      const readback = await boundedRead(prepared, instance.id, this.#correlationId, NO_HOOKS);
      if (!sameIdentity(installed, readback.stat) || !readback.bytes.equals(bytes)) {
        return fail('SCENARIO_STORE_FILE_CHANGED', 'Scenario instance write verification failed.');
      }
      return Object.freeze({
        instance: readback.instance,
        revision: revision(readback.bytes),
      });
    } finally {
      if (temporary) await temporary.close().catch(() => undefined);
      if (!simulatedCrash) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      if (capacityLock) {
        await releaseCapacityLock(capacityLock, !simulatedCrash);
      }
    }
  }
}

export function scenarioInstanceStoreRoot(workspaceRoot: string): string {
  if (
    typeof workspaceRoot !== 'string' ||
    !isAbsolute(workspaceRoot) ||
    resolve(workspaceRoot) !== workspaceRoot ||
    workspaceRoot.includes('\0')
  ) {
    return fail('SCENARIO_STORE_PATH_UNSAFE', 'Workspace root must be normalized and absolute.');
  }
  return join(workspaceRoot, '.openslack.local', 'scenario-instances');
}

export async function initializeScenarioInstanceStoreRoot(workspaceRoot: string): Promise<string> {
  const root = scenarioInstanceStoreRoot(workspaceRoot);
  const workspace = await assertDirectory(workspaceRoot);
  const localPath = join(workspace.real, '.openslack.local');
  await ensureFixedChild(workspace.real, localPath);
  const local = await assertDirectory(localPath);
  if (!contained(workspace.real, local.real)) {
    return fail('SCENARIO_STORE_PATH_UNSAFE', 'Local state root escapes the workspace.');
  }
  await ensureFixedChild(local.real, root);
  await prepare(root, 'scenario-store-preflight', true);
  return root;
}

/** @internal deterministic fault-injection seam; intentionally absent from the package root. */
export function createScenarioInstanceStoreForTest(
  root: string,
  correlationId: string,
  hooks: ScenarioInstanceStoreHooks,
): LocalScenarioInstanceStore {
  const store = new LocalScenarioInstanceStore(root, correlationId);
  STORE_TEST_HOOKS.set(store, Object.freeze({ ...hooks }));
  return store;
}
