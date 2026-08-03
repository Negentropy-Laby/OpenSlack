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
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import { threadId } from 'node:worker_threads';
import {
  canonicalGovernedJson,
  validateGovernedPlanRecord,
  type GovernedPlanExecution,
  type GovernedPlanRecord,
  type GovernedPlanState,
} from './governed-plan.js';
import {
  isGovernedPlanShadowObservationPort,
  type GovernedPlanShadowObservationPort,
} from './governed-plan-shadow.js';
import type { GovernedPlanAuditEvent, GovernedPlanAuditSink } from './governed-plan-service.js';

const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
export const GOVERNED_PLAN_STORE_LIMITS = Object.freeze({
  maxRecordBytes: 1024 * 1024,
  maxRecords: 4_096,
  maxLockBytes: 512,
  lockAcquireAttempts: 3,
} as const);

export const GOVERNED_PLAN_STORE_ERROR_CODES = Object.freeze([
  'GOVERNED_PLAN_STORE_PATH_UNSAFE',
  'GOVERNED_PLAN_STORE_FILE_UNSAFE',
  'GOVERNED_PLAN_STORE_NOT_FOUND',
  'GOVERNED_PLAN_STORE_ALREADY_EXISTS',
  'GOVERNED_PLAN_STORE_BUSY',
  'GOVERNED_PLAN_STORE_CAS_MISMATCH',
  'GOVERNED_PLAN_STORE_TRANSITION_INVALID',
  'GOVERNED_PLAN_STORE_LIMIT_EXCEEDED',
  'GOVERNED_PLAN_STORE_RECORD_INVALID',
  'GOVERNED_PLAN_STORE_FILE_CHANGED',
] as const);

export const GOVERNED_PLAN_STATE_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['executing', 'cancelled', 'expired'] as const),
  executing: Object.freeze(['succeeded', 'blocked', 'failed', 'reconciliation_required'] as const),
  succeeded: Object.freeze([] as const),
  blocked: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  reconciliation_required: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
  expired: Object.freeze([] as const),
} as const satisfies Readonly<Record<GovernedPlanState, readonly GovernedPlanState[]>>);

export const GOVERNED_PLAN_STORE_ALGORITHMS = Object.freeze({
  persistedRecord: 'canonical_json_utf8_plus_lf',
  cas: 'plan_id+expected_revision',
  executionClaim: 'cas_once(plan_id,expected_revision,execution_id)',
} as const);

export function canGovernedPlanStateTransition(
  from: GovernedPlanState,
  to: GovernedPlanState,
): boolean {
  return (GOVERNED_PLAN_STATE_TRANSITIONS[from] as readonly GovernedPlanState[]).includes(to);
}

const MAX_RECORD_BYTES = GOVERNED_PLAN_STORE_LIMITS.maxRecordBytes;
const MAX_RECORDS = GOVERNED_PLAN_STORE_LIMITS.maxRecords;
const RECORD_NAME = /^[0-9a-f]{64}\.json$/;
const LOCK_NAME = /^[0-9a-f]{64}\.lock$/;
const TEMP_NAME =
  /^\.[0-9a-f]{64}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCK_OWNER_SCHEMA = 'openslack.governed_plan_lock.v1';
const LOCK_MAX_BYTES = GOVERNED_PLAN_STORE_LIMITS.maxLockBytes;
const PROCESS_SESSION_ID = randomUUID();
const LOCK_TEMP_NAME =
  /^\.lock\.([0-9a-f]{64})\.([1-9][0-9]{0,9})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9]{1,10})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const STORES = new WeakSet<object>();

/**
 * Registers a host-created store implementation with the service composition
 * boundary. Kept outside the public package barrel so arbitrary callers cannot
 * make duck-typed stores authoritative.
 */
export function registerGovernedPlanStore<T extends GovernedPlanStore>(store: T): T {
  STORES.add(store);
  return store;
}

export class GovernedPlanStoreError extends Error {
  readonly code: (typeof GOVERNED_PLAN_STORE_ERROR_CODES)[number];
  readonly path?: string;

  constructor(code: GovernedPlanStoreError['code'], message: string, path?: string) {
    super(message);
    this.name = 'GovernedPlanStoreError';
    this.code = code;
    this.path = path;
  }
}

export interface GovernedPlanStore {
  create(record: GovernedPlanRecord): Promise<GovernedPlanRecord>;
  load(planId: string): Promise<GovernedPlanRecord | null>;
  list(): Promise<readonly GovernedPlanRecord[]>;
  claimExecution(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly executionId: string;
    readonly ownerPid: number;
    readonly startedAt: string;
  }): Promise<GovernedPlanRecord>;
  completeExecution(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly executionId: string;
    readonly state: 'succeeded' | 'blocked' | 'failed' | 'reconciliation_required';
    readonly completedAt: string;
    readonly outcomes: GovernedPlanExecution['outcomes'];
    readonly blocker?: string;
    readonly failure?: string;
  }): Promise<GovernedPlanRecord>;
  cancel(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly updatedAt: string;
  }): Promise<GovernedPlanRecord>;
  expire(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly updatedAt: string;
  }): Promise<GovernedPlanRecord>;
  requireReconciliation(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly executionId: string;
    readonly completedAt: string;
    readonly failure: string;
  }): Promise<GovernedPlanRecord>;
  /** Optional durable prepare before the collaboration audit append begins. */
  prepareAudit?(event: GovernedPlanAuditEvent): Promise<void>;
  /** Mark collaboration durable, acknowledge authority, then retire the prepare. */
  recordAudit?(event: GovernedPlanAuditEvent): Promise<void>;
  /** Drain durable authority audit prepares before exposing the mutation server. */
  recoverAudits?(auditSink: GovernedPlanAuditSink): Promise<void>;
}

interface PreparedStore {
  readonly root: string;
  readonly rootReal: string;
  readonly records: string;
  readonly recordsReal: string;
  readonly locks: string;
  readonly locksReal: string;
}

interface LoadedRecord {
  readonly record: GovernedPlanRecord;
  readonly path: string;
  readonly stat: Stats;
}

interface HeldLock {
  readonly path: string;
  readonly handle: FileHandle;
  readonly stat: Stats;
  readonly owner: LockOwner;
}

interface LockOwner {
  readonly schema: typeof LOCK_OWNER_SCHEMA;
  readonly pid: number;
  readonly sessionId: string;
  readonly threadId: number;
  readonly nonce: string;
  readonly createdAt: string;
}

function fail(code: GovernedPlanStoreError['code'], message: string, path?: string): never {
  throw new GovernedPlanStoreError(code, message, path);
}

function key(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function contained(parent: string, child: string): boolean {
  const value = relative(parent, child);
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

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertRealDirectory(path: string): Promise<string> {
  const stat = await lstatIfPresent(path);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    return fail(
      'GOVERNED_PLAN_STORE_PATH_UNSAFE',
      'Governed plan store path must be a real directory.',
      path,
    );
  }
  const actual = await realpath(path);
  if (!samePath(path, actual)) {
    return fail(
      'GOVERNED_PLAN_STORE_PATH_UNSAFE',
      'Governed plan store cannot traverse a symlink or reparse path.',
      path,
    );
  }
  return actual;
}

async function ensureChild(parentReal: string, path: string): Promise<string> {
  if (!(await lstatIfPresent(path))) {
    await mkdir(path, { recursive: false, mode: 0o700 });
  }
  const actual = await assertRealDirectory(path);
  if (!contained(parentReal, actual)) {
    return fail(
      'GOVERNED_PLAN_STORE_PATH_UNSAFE',
      'Governed plan store child escapes its parent.',
      path,
    );
  }
  return actual;
}

async function scan(
  directory: string,
  pattern: RegExp,
  allowedTemporary?: RegExp,
): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > MAX_RECORDS * 2) {
    return fail(
      'GOVERNED_PLAN_STORE_LIMIT_EXCEEDED',
      'Governed plan store entry limit exceeded.',
      directory,
    );
  }
  let bytes = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (
      entry.isSymbolicLink() ||
      stat.isSymbolicLink() ||
      !entry.isFile() ||
      !stat.isFile() ||
      (!pattern.test(entry.name) && !(allowedTemporary && allowedTemporary.test(entry.name)))
    ) {
      return fail(
        'GOVERNED_PLAN_STORE_FILE_UNSAFE',
        'Governed plan store contains an unknown or unsafe entry.',
        path,
      );
    }
    if (stat.size > MAX_RECORD_BYTES) {
      return fail(
        'GOVERNED_PLAN_STORE_LIMIT_EXCEEDED',
        'Governed plan store file exceeds the byte limit.',
        path,
      );
    }
    bytes += stat.size;
    if (bytes > MAX_RECORD_BYTES * MAX_RECORDS) {
      return fail(
        'GOVERNED_PLAN_STORE_LIMIT_EXCEEDED',
        'Governed plan store exceeds its aggregate byte limit.',
        directory,
      );
    }
  }
  return entries.length;
}

async function prepare(configuredRoot: string): Promise<PreparedStore> {
  if (
    typeof configuredRoot !== 'string' ||
    !isAbsolute(configuredRoot) ||
    resolve(configuredRoot) !== configuredRoot
  ) {
    return fail(
      'GOVERNED_PLAN_STORE_PATH_UNSAFE',
      'Governed plan store root must be an absolute normalized path.',
      configuredRoot,
    );
  }
  if (!(await lstatIfPresent(configuredRoot))) {
    await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
  }
  const rootReal = await assertRealDirectory(configuredRoot);
  const records = join(rootReal, 'records');
  const locks = join(rootReal, 'locks');
  const recordsReal = await ensureChild(rootReal, records);
  const locksReal = await ensureChild(rootReal, locks);
  const rootEntries = await readdir(rootReal, { withFileTypes: true });
  const names = rootEntries.map((entry) => entry.name).sort();
  if (
    names.length !== 2 ||
    names[0] !== 'locks' ||
    names[1] !== 'records' ||
    rootEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())
  ) {
    return fail(
      'GOVERNED_PLAN_STORE_FILE_UNSAFE',
      'Governed plan store root contains an unknown entry.',
      rootReal,
    );
  }
  await scan(recordsReal, RECORD_NAME, TEMP_NAME);
  await scan(locksReal, LOCK_NAME, LOCK_TEMP_NAME);
  return {
    root: configuredRoot,
    rootReal,
    records,
    recordsReal,
    locks,
    locksReal,
  };
}

async function readBounded(path: string): Promise<{ bytes: Buffer; stat: Stats }> {
  const before = await lstatIfPresent(path);
  if (!before) {
    return fail('GOVERNED_PLAN_STORE_NOT_FOUND', 'Governed plan was not found.', path);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_RECORD_BYTES) {
    return fail('GOVERNED_PLAN_STORE_FILE_UNSAFE', 'Governed plan file is unsafe.', path);
  }
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await handle.stat();
    if (!stableIdentity(before, opened)) {
      return fail(
        'GOVERNED_PLAN_STORE_FILE_CHANGED',
        'Governed plan changed before bounded read.',
        path,
      );
    }
    const buffer = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== buffer.length) {
      return fail(
        'GOVERNED_PLAN_STORE_FILE_CHANGED',
        'Governed plan changed during bounded read.',
        path,
      );
    }
    const after = await handle.stat();
    if (!stableIdentity(opened, after)) {
      return fail(
        'GOVERNED_PLAN_STORE_FILE_CHANGED',
        'Governed plan changed during bounded read.',
        path,
      );
    }
    return { bytes: buffer, stat: after };
  } finally {
    await handle.close();
  }
}

function parseRecord(bytes: Buffer, expectedPlanId?: string): GovernedPlanRecord {
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) {
    return fail('GOVERNED_PLAN_STORE_RECORD_INVALID', 'Governed plan bytes are not canonical.');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('GOVERNED_PLAN_STORE_RECORD_INVALID', 'Governed plan record is not valid UTF-8.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('GOVERNED_PLAN_STORE_RECORD_INVALID', 'Governed plan record is not valid JSON.');
  }
  let record: GovernedPlanRecord;
  try {
    record = validateGovernedPlanRecord(parsed);
  } catch (error) {
    return fail(
      'GOVERNED_PLAN_STORE_RECORD_INVALID',
      `Governed plan record failed validation: ${(error as Error).message}`,
    );
  }
  if (!Buffer.from(`${canonicalGovernedJson(record)}\n`, 'utf8').equals(bytes)) {
    return fail(
      'GOVERNED_PLAN_STORE_RECORD_INVALID',
      'Governed plan record is not exact canonical JSON.',
    );
  }
  if (expectedPlanId !== undefined && record.planId !== expectedPlanId) {
    return fail(
      'GOVERNED_PLAN_STORE_RECORD_INVALID',
      'Governed plan record does not match its requested identity.',
    );
  }
  return record;
}

async function loadPrepared(prepared: PreparedStore, planId: string): Promise<LoadedRecord | null> {
  const path = join(prepared.recordsReal, `${key(planId)}.json`);
  if (!(await lstatIfPresent(path))) return null;
  const value = await readBounded(path);
  return { record: parseRecord(value.bytes, planId), path, stat: value.stat };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    try {
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows and Windows-backed DrvFS reject fsync on directory handles. The
      // record and lock files themselves are always fsynced before link/rename;
      // only this unsupported directory-metadata flush is degraded.
      if (
        process.platform === 'win32' &&
        (code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP' || code === 'ENOSYS')
      ) {
        return;
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}

async function writeTemporary(
  prepared: PreparedStore,
  planId: string,
  bytes: string,
): Promise<string> {
  if (Buffer.byteLength(bytes, 'utf8') > MAX_RECORD_BYTES) {
    return fail(
      'GOVERNED_PLAN_STORE_LIMIT_EXCEEDED',
      'Governed plan record exceeds the byte limit.',
    );
  }
  const path = join(prepared.recordsReal, `.${key(planId)}.${randomUUID()}.tmp`);
  const handle = await open(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(bytes, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
  return path;
}

function validateLockOwner(value: unknown): LockOwner {
  const record = validateGovernedLockJson(value);
  const expected = ['createdAt', 'nonce', 'pid', 'schema', 'sessionId', 'threadId'];
  if (
    Object.keys(record).sort().join('\0') !== expected.join('\0') ||
    record.schema !== LOCK_OWNER_SCHEMA ||
    typeof record.pid !== 'number' ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 1 ||
    record.pid > 2_147_483_647 ||
    typeof record.threadId !== 'number' ||
    !Number.isSafeInteger(record.threadId) ||
    record.threadId < 0 ||
    record.threadId > 2_147_483_647 ||
    typeof record.sessionId !== 'string' ||
    !UUID_V4.test(record.sessionId) ||
    typeof record.nonce !== 'string' ||
    !UUID_V4.test(record.nonce) ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    new Date(Date.parse(record.createdAt)).toISOString() !== record.createdAt
  ) {
    return fail('GOVERNED_PLAN_STORE_FILE_UNSAFE', 'Governed plan lock owner metadata is invalid.');
  }
  return Object.freeze({
    schema: LOCK_OWNER_SCHEMA,
    pid: record.pid,
    sessionId: record.sessionId,
    threadId: record.threadId,
    nonce: record.nonce,
    createdAt: record.createdAt,
  });
}

function validateGovernedLockJson(value: unknown): Record<string, string | number> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail(
      'GOVERNED_PLAN_STORE_FILE_UNSAFE',
      'Governed plan lock owner must be a plain object.',
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      (typeof descriptor.value !== 'string' && typeof descriptor.value !== 'number')
    ) {
      return fail(
        'GOVERNED_PLAN_STORE_FILE_UNSAFE',
        'Governed plan lock owner must contain inert scalar fields.',
      );
    }
  }
  return value as Record<string, string | number>;
}

function lockOwnerBytes(owner: LockOwner): string {
  return `${canonicalGovernedJson(owner)}\n`;
}

async function readLock(
  prepared: PreparedStore,
  path: string,
): Promise<{ readonly owner: LockOwner; readonly stat: Stats }> {
  const initial = await lstatIfPresent(path);
  if (
    !initial ||
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.size < 1 ||
    initial.size > LOCK_MAX_BYTES
  ) {
    return fail('GOVERNED_PLAN_STORE_FILE_UNSAFE', 'Governed plan lock file is unsafe.', path);
  }
  const actual = await realpath(path);
  if (!samePath(path, actual) || !contained(prepared.locksReal, actual)) {
    return fail(
      'GOVERNED_PLAN_STORE_PATH_UNSAFE',
      'Governed plan lock escapes its directory.',
      path,
    );
  }
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await handle.stat();
    if (!stableIdentity(initial, opened)) {
      return fail(
        'GOVERNED_PLAN_STORE_FILE_CHANGED',
        'Governed plan lock changed before read.',
        path,
      );
    }
    const buffer = Buffer.alloc(opened.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    const final = await lstat(path);
    if (
      bytesRead !== buffer.length ||
      !stableIdentity(opened, after) ||
      !stableIdentity(after, final)
    ) {
      return fail(
        'GOVERNED_PLAN_STORE_FILE_CHANGED',
        'Governed plan lock changed during read.',
        path,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.toString('utf8'));
    } catch {
      return fail('GOVERNED_PLAN_STORE_FILE_UNSAFE', 'Governed plan lock JSON is invalid.', path);
    }
    const owner = validateLockOwner(parsed);
    if (buffer.toString('utf8') !== lockOwnerBytes(owner)) {
      return fail(
        'GOVERNED_PLAN_STORE_FILE_UNSAFE',
        'Governed plan lock is not exact canonical JSON.',
        path,
      );
    }
    return { owner, stat: final };
  } finally {
    await handle.close();
  }
}

function ownerIsProvablyDead(owner: LockOwner): boolean {
  if (owner.pid === process.pid) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function removeProvablyStaleLock(
  prepared: PreparedStore,
  path: string,
  observed: Awaited<ReturnType<typeof readLock>>,
): Promise<void> {
  if (!ownerIsProvablyDead(observed.owner)) {
    return fail(
      'GOVERNED_PLAN_STORE_BUSY',
      'Governed plan lock has a live or unverifiable owner.',
      path,
    );
  }
  const repeated = await lstat(path);
  const actual = await realpath(path);
  if (
    !stableIdentity(observed.stat, repeated) ||
    !samePath(path, actual) ||
    !contained(prepared.locksReal, actual)
  ) {
    return fail(
      'GOVERNED_PLAN_STORE_FILE_CHANGED',
      'Governed plan lock changed before stale-owner recovery.',
      path,
    );
  }
  await rm(path);
  await syncDirectory(prepared.locksReal);
}

async function acquireLock(prepared: PreparedStore, planId: string): Promise<HeldLock> {
  const path = join(prepared.locksReal, `${key(planId)}.lock`);
  for (let attempt = 0; attempt < GOVERNED_PLAN_STORE_LIMITS.lockAcquireAttempts; attempt += 1) {
    const owner: LockOwner = Object.freeze({
      schema: LOCK_OWNER_SCHEMA,
      pid: process.pid,
      sessionId: PROCESS_SESSION_ID,
      threadId,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    const temporary = join(
      prepared.locksReal,
      `.lock.${key(planId)}.${owner.pid}.${owner.sessionId}.${owner.threadId}.${owner.nonce}.tmp`,
    );
    const handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(lockOwnerBytes(owner), 'utf8');
      await handle.sync();
      const trusted = await handle.stat();
      const temporaryStat = await lstat(temporary);
      if (!stableIdentity(trusted, temporaryStat)) {
        return fail(
          'GOVERNED_PLAN_STORE_FILE_CHANGED',
          'Governed plan lock temporary changed during acquisition.',
          temporary,
        );
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await handle.close();
        await rm(temporary);
        await removeProvablyStaleLock(prepared, path, await readLock(prepared, path));
        continue;
      }
      await syncDirectory(prepared.locksReal);
      const published = await lstat(path);
      if (!sameIdentity(trusted, published)) {
        return fail(
          'GOVERNED_PLAN_STORE_FILE_CHANGED',
          'Governed plan lock changed during atomic publication.',
          path,
        );
      }
      await rm(temporary);
      await syncDirectory(prepared.locksReal);
      return { path, handle, stat: await lstat(path), owner };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return fail('GOVERNED_PLAN_STORE_BUSY', 'Governed plan lock retry limit exceeded.', path);
}

async function releaseLock(lock: HeldLock): Promise<void> {
  await lock.handle.close();
  const current = await lstatIfPresent(lock.path);
  if (!current || !sameIdentity(lock.stat, current)) {
    return fail(
      'GOVERNED_PLAN_STORE_FILE_CHANGED',
      'Governed plan lock identity changed before release.',
      lock.path,
    );
  }
  await rm(lock.path);
  await syncDirectory(resolve(lock.path, '..'));
}

function nextRecord(
  current: GovernedPlanRecord,
  patch: Partial<GovernedPlanRecord>,
): GovernedPlanRecord {
  return validateGovernedPlanRecord({
    ...current,
    ...patch,
    revision: current.revision + 1,
  });
}

export class LocalGovernedPlanStore implements GovernedPlanStore {
  readonly #root: string;
  readonly #shadowObserver: GovernedPlanShadowObservationPort | undefined;

  constructor(root: string, shadowObserver?: GovernedPlanShadowObservationPort) {
    if (shadowObserver !== undefined && !isGovernedPlanShadowObservationPort(shadowObserver)) {
      throw new TypeError('Governed plan shadow observer must be host-created.');
    }
    this.#root = root;
    this.#shadowObserver = shadowObserver;
    registerGovernedPlanStore(this);
    Object.freeze(this);
  }

  #observe(record: GovernedPlanRecord): void {
    try {
      this.#shadowObserver?.observeRecord(record);
    } catch {
      // The local TypeScript store remains the sole authority.
    }
  }

  async create(recordValue: GovernedPlanRecord): Promise<GovernedPlanRecord> {
    const record = validateGovernedPlanRecord(recordValue);
    if (record.revision !== 1 || record.state !== 'pending') {
      return fail(
        'GOVERNED_PLAN_STORE_TRANSITION_INVALID',
        'New governed plans must begin at pending revision 1.',
      );
    }
    const prepared = await prepare(this.#root);
    const finalPath = join(prepared.recordsReal, `${key(record.planId)}.json`);
    const temporary = await writeTemporary(
      prepared,
      record.planId,
      `${canonicalGovernedJson(record)}\n`,
    );
    try {
      try {
        await link(temporary, finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return fail(
            'GOVERNED_PLAN_STORE_ALREADY_EXISTS',
            'Governed plan already exists.',
            finalPath,
          );
        }
        throw error;
      }
      await syncDirectory(prepared.recordsReal);
    } finally {
      await rm(temporary, { force: true });
    }
    const published = (await this.load(record.planId))!;
    this.#observe(published);
    return published;
  }

  async load(planId: string): Promise<GovernedPlanRecord | null> {
    const prepared = await prepare(this.#root);
    return (await loadPrepared(prepared, planId))?.record ?? null;
  }

  async list(): Promise<readonly GovernedPlanRecord[]> {
    const prepared = await prepare(this.#root);
    const names = (await readdir(prepared.recordsReal))
      .filter((name) => RECORD_NAME.test(name))
      .sort();
    const records: GovernedPlanRecord[] = [];
    for (const name of names) {
      const value = await readBounded(join(prepared.recordsReal, name));
      const record = parseRecord(value.bytes);
      if (`${key(record.planId)}.json` !== name) {
        return fail(
          'GOVERNED_PLAN_STORE_RECORD_INVALID',
          'Governed plan filename does not match record identity.',
        );
      }
      records.push(record);
    }
    return Object.freeze(
      records.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    );
  }

  async #mutate(
    planId: string,
    expectedRevision: number,
    transition: (record: GovernedPlanRecord) => GovernedPlanRecord,
  ): Promise<GovernedPlanRecord> {
    const prepared = await prepare(this.#root);
    const lock = await acquireLock(prepared, planId);
    let released = false;
    try {
      const loaded = await loadPrepared(prepared, planId);
      if (!loaded) {
        return fail('GOVERNED_PLAN_STORE_NOT_FOUND', 'Governed plan was not found.');
      }
      if (loaded.record.revision !== expectedRevision) {
        return fail(
          'GOVERNED_PLAN_STORE_CAS_MISMATCH',
          'Governed plan revision changed before transition.',
        );
      }
      const next = transition(loaded.record);
      const current = await lstat(loaded.path);
      if (!stableIdentity(loaded.stat, current)) {
        return fail(
          'GOVERNED_PLAN_STORE_FILE_CHANGED',
          'Governed plan changed before atomic replacement.',
          loaded.path,
        );
      }
      const temporary = await writeTemporary(prepared, planId, `${canonicalGovernedJson(next)}\n`);
      try {
        await rename(temporary, loaded.path);
        await syncDirectory(prepared.recordsReal);
      } finally {
        await rm(temporary, { force: true });
      }
      await releaseLock(lock);
      released = true;
      const published = await loadPrepared(prepared, planId);
      if (!published || published.record.revision !== next.revision) {
        return fail(
          'GOVERNED_PLAN_STORE_FILE_CHANGED',
          'Governed plan atomic replacement could not be verified.',
        );
      }
      this.#observe(published.record);
      return published.record;
    } finally {
      if (!released) {
        try {
          await releaseLock(lock);
        } catch {
          // A changed lock is intentionally retained for explicit reconciliation.
        }
      }
    }
  }

  async claimExecution(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly executionId: string;
    readonly ownerPid: number;
    readonly startedAt: string;
  }): Promise<GovernedPlanRecord> {
    return this.#mutate(params.planId, params.expectedRevision, (record) => {
      if (!canGovernedPlanStateTransition(record.state, 'executing')) {
        return fail(
          'GOVERNED_PLAN_STORE_TRANSITION_INVALID',
          `Cannot claim governed plan from ${record.state}.`,
        );
      }
      return nextRecord(record, {
        state: 'executing',
        updatedAt: params.startedAt,
        execution: {
          executionId: params.executionId,
          ownerPid: params.ownerPid,
          startedAt: params.startedAt,
          outcomes: [],
        },
      });
    });
  }

  async completeExecution(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly executionId: string;
    readonly state: 'succeeded' | 'blocked' | 'failed' | 'reconciliation_required';
    readonly completedAt: string;
    readonly outcomes: GovernedPlanExecution['outcomes'];
    readonly blocker?: string;
    readonly failure?: string;
  }): Promise<GovernedPlanRecord> {
    return this.#mutate(params.planId, params.expectedRevision, (record) => {
      if (
        !canGovernedPlanStateTransition(record.state, params.state) ||
        record.execution?.executionId !== params.executionId
      ) {
        return fail(
          'GOVERNED_PLAN_STORE_TRANSITION_INVALID',
          'Only the claimed execution may complete a governed plan.',
        );
      }
      return nextRecord(record, {
        state: params.state,
        updatedAt: params.completedAt,
        execution: {
          ...record.execution,
          completedAt: params.completedAt,
          outcomes: params.outcomes,
          ...(params.blocker === undefined ? {} : { blocker: params.blocker }),
          ...(params.failure === undefined ? {} : { failure: params.failure }),
        },
      });
    });
  }

  async cancel(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly updatedAt: string;
  }): Promise<GovernedPlanRecord> {
    return this.#mutate(params.planId, params.expectedRevision, (record) => {
      if (!canGovernedPlanStateTransition(record.state, 'cancelled')) {
        return fail(
          'GOVERNED_PLAN_STORE_TRANSITION_INVALID',
          `Cannot cancel governed plan from ${record.state}.`,
        );
      }
      return nextRecord(record, {
        state: 'cancelled',
        updatedAt: params.updatedAt,
      });
    });
  }

  async expire(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly updatedAt: string;
  }): Promise<GovernedPlanRecord> {
    return this.#mutate(params.planId, params.expectedRevision, (record) => {
      if (!canGovernedPlanStateTransition(record.state, 'expired')) {
        return fail(
          'GOVERNED_PLAN_STORE_TRANSITION_INVALID',
          `Cannot expire governed plan from ${record.state}.`,
        );
      }
      if (Date.parse(record.expiresAt) > Date.parse(params.updatedAt)) {
        return fail('GOVERNED_PLAN_STORE_TRANSITION_INVALID', 'Governed plan has not expired.');
      }
      return nextRecord(record, {
        state: 'expired',
        updatedAt: params.updatedAt,
      });
    });
  }

  async requireReconciliation(params: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly executionId: string;
    readonly completedAt: string;
    readonly failure: string;
  }): Promise<GovernedPlanRecord> {
    return this.completeExecution({
      ...params,
      state: 'reconciliation_required',
      outcomes: [],
    });
  }
}

Object.freeze(LocalGovernedPlanStore.prototype);

export function isGovernedPlanStore(value: unknown): value is GovernedPlanStore {
  return Boolean(value && typeof value === 'object' && STORES.has(value));
}

export function governedPlanStoreRoot(workspaceRoot: string): string {
  return join(workspaceRoot, '.openslack.local', 'operator', 'governed-plans');
}

export function isGovernedPlanExecutionTerminal(state: GovernedPlanState): boolean {
  return (
    state === 'succeeded' ||
    state === 'blocked' ||
    state === 'failed' ||
    state === 'reconciliation_required'
  );
}
