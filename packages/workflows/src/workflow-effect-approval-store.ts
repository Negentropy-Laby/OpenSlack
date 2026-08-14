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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { types as nodeTypes } from 'node:util';
import { threadId } from 'node:worker_threads';
import {
  applyWorkflowEffectApprovalDecision,
  createPendingWorkflowEffectApproval,
  markWorkflowEffectApprovalAuditRecorded,
  validateWorkflowEffectApproval,
  workflowEffectApprovalBytes,
  WorkflowEffectApprovalContractError,
  WorkflowEffectDecisionAuthority,
  type CreatePendingWorkflowEffectApprovalInput,
  type HumanWorkflowEffectDecisionBinding,
  type WorkflowEffectApprovalDecision,
  type WorkflowEffectApprovalRecord,
} from './workflow-effect-approval.js';
import { canonicalWorkflowEffectJson, parseWorkflowEffectJson } from './workflow-effect-json.js';
import {
  assertOwnerDirectory,
  assertOwnerFile,
  ensureOwnerDirectory,
  isWorkflowControlObservationPort,
  productionJournalSecurity,
  type WorkflowControlObservationPort,
} from './workflow-control-shadow.js';

const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4_096;
const LOCK_MAX_BYTES = 512;
const SAFE_SCOPE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const RECORD_NAME = /^[0-9a-f]{64}\.json$/;
const RECORD_TEMP =
  /^\.[0-9a-f]{64}\.[1-9][0-9]{0,9}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const LOCK_TEMP =
  /^\.decision\.([1-9][0-9]{0,9})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9]{1,10})\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LOCK_SCHEMA = 'openslack.workflow_effect_approval_lock.v1';
const PROCESS_SESSION_ID = randomUUID();
const AUTHORITY_STORE_SECURITY = productionJournalSecurity();

function hasWorkflowEffectAuthorityRoot(approvalStoreRoot: string): boolean {
  if (!isAbsolute(approvalStoreRoot) || resolve(approvalStoreRoot) !== approvalStoreRoot) {
    throw new WorkflowEffectApprovalStoreError(
      'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
      'Approval-store root must be a normalized absolute path.',
      approvalStoreRoot,
    );
  }
  return basename(approvalStoreRoot) === 'effect-approvals';
}

async function authorityRecovery() {
  return import('./workflow-effect-authority-store.js');
}

export class WorkflowEffectApprovalStoreError extends Error {
  readonly code:
    | 'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE'
    | 'WORKFLOW_EFFECT_APPROVAL_STORE_NOT_FOUND'
    | 'WORKFLOW_EFFECT_APPROVAL_STORE_ALREADY_EXISTS'
    | 'WORKFLOW_EFFECT_APPROVAL_STORE_BUSY'
    | 'WORKFLOW_EFFECT_APPROVAL_STORE_LIMIT_EXCEEDED'
    | 'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE'
    | 'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED'
    | 'WORKFLOW_EFFECT_APPROVAL_STORE_SCOPE_MISMATCH'
    | 'WORKFLOW_EFFECT_APPROVAL_STORE_CAS_MISMATCH'
    | 'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID';
  readonly path?: string;

  constructor(code: WorkflowEffectApprovalStoreError['code'], message: string, path?: string) {
    super(message);
    this.name = 'WorkflowEffectApprovalStoreError';
    this.code = code;
    this.path = path;
  }
}

export interface DecideWorkflowEffectApprovalInput {
  readonly runId: string;
  readonly approvalId: string;
  readonly expectedRevision: number;
  readonly decision: WorkflowEffectApprovalDecision;
  readonly reasonHash: string;
  readonly binding: HumanWorkflowEffectDecisionBinding;
}

export interface MarkWorkflowEffectApprovalAuditProjectedInput {
  readonly runId: string;
  readonly approvalId: string;
  readonly expectedRevision: 1;
  readonly eventId: string;
}

/** @internal Runtime-only pending writer; intentionally not exported from the package root. */
export async function persistWorkflowEffectApprovalPending(
  root: string,
  input: CreatePendingWorkflowEffectApprovalInput,
  nowValue: string,
  allowExactReplay = true,
): Promise<WorkflowEffectApprovalRecord> {
  if (!(await lstatIfPresent(root))) {
    if (hasWorkflowEffectAuthorityRoot(root)) {
      await ensureOwnerDirectory(root, AUTHORITY_STORE_SECURITY);
    } else {
      await mkdir(root, { recursive: false, mode: 0o700 });
    }
  }
  const record = createPendingWorkflowEffectApproval(input);
  if (
    !Number.isFinite(Date.parse(nowValue)) ||
    new Date(Date.parse(nowValue)).toISOString() !== nowValue
  ) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
      'Approval-store clock must return a canonical timestamp.',
    );
  }
  if (
    Date.parse(record.createdAt) > Date.parse(nowValue) ||
    Date.parse(record.expiresAt) <= Date.parse(nowValue)
  ) {
    throw new WorkflowEffectApprovalContractError(
      'WORKFLOW_EFFECT_APPROVAL_EXPIRED',
      'Pending workflow effect approval is outside its active lifetime.',
    );
  }
  let prepared = await prepare(root, true);
  const lock = await acquireLock(prepared);
  try {
    await recoverRecordTemporaries(prepared);
    prepared = await prepare(root, false);
    const path = recordPath(prepared, record.runId, record.approvalId);
    if (await lstatIfPresent(path)) {
      const existing = await boundedRead(prepared, record.runId, record.approvalId);
      if (allowExactReplay && existing.bytes.equals(workflowEffectApprovalBytes(record)))
        return existing.record;
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_ALREADY_EXISTS',
        'Workflow effect approval already exists with different exact bytes.',
        path,
      );
    }
    await atomicWrite(prepared, record.runId, record.approvalId, record, null);
    return record;
  } finally {
    await releaseLock(lock);
  }
}

interface PreparedStore {
  readonly root: string;
  readonly rootReal: string;
  readonly rootStat: Stats;
  readonly records: string;
  readonly recordsReal: string;
  readonly recordsStat: Stats;
  readonly locks: string;
  readonly locksReal: string;
  readonly locksStat: Stats;
  readonly totalBytes: number;
  readonly entries: number;
}

interface LockOwner {
  readonly schema: typeof LOCK_SCHEMA;
  readonly pid: number;
  readonly sessionId: string;
  readonly threadId: number;
  readonly nonce: string;
  readonly createdAt: string;
}

interface AcquiredLock {
  readonly path: string;
  readonly stat: Stats;
}

function fail(
  code: WorkflowEffectApprovalStoreError['code'],
  message: string,
  path?: string,
): never {
  throw new WorkflowEffectApprovalStoreError(code, message, path);
}

function samePath(left: string, right: string): boolean {
  const normalized = (value: string) =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalized(left) === normalized(right);
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

function assertSafeScope(value: string, label: string): void {
  if (typeof value !== 'string' || !SAFE_SCOPE.test(value)) {
    fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
      `${label} is not a safe approval-store scope.`,
    );
  }
}

function recordKey(runId: string, approvalId: string): string {
  return createHash('sha256').update(`${runId}\0${approvalId}`, 'utf8').digest('hex');
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
  if (!stat) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_NOT_FOUND',
      'Approval-store directory is missing.',
      path,
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
      'Approval-store path must be a real directory.',
      path,
    );
  }
  const real = await realpath(path);
  if (!samePath(path, real)) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
      'Approval-store path cannot traverse a symlink or reparse point.',
      path,
    );
  }
  return { stat, real };
}

async function assertAuthorityDirectory(
  path: string,
  create: boolean,
  parent?: string,
  missingIsNotFound = false,
): Promise<{ stat: Stats; real: string }> {
  if (!create && !(await lstatIfPresent(path))) {
    return fail(
      missingIsNotFound
        ? 'WORKFLOW_EFFECT_APPROVAL_STORE_NOT_FOUND'
        : 'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
      missingIsNotFound
        ? 'Approval-store directory is missing.'
        : 'Approval-store directory structure is incomplete.',
      path,
    );
  }
  try {
    const real = create
      ? await ensureOwnerDirectory(path, AUTHORITY_STORE_SECURITY, parent)
      : await assertOwnerDirectory(path, AUTHORITY_STORE_SECURITY, parent);
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
        'Approval-store path must be a real owner-only directory.',
        path,
      );
    }
    return { stat, real };
  } catch (error) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
      `Approval-store path is not owner-only: ${String(error)}`,
      path,
    );
  }
}

async function ensureFixedChild(parentReal: string, path: string): Promise<void> {
  const existing = await lstatIfPresent(path);
  if (!existing) await mkdir(path, { recursive: false, mode: 0o700 });
  const child = await assertDirectory(path);
  if (!contained(parentReal, child.real)) {
    fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
      'Approval-store child escapes its parent.',
      path,
    );
  }
}

async function scanStore(
  root: string,
  ownerOnly: boolean,
): Promise<{ totalBytes: number; entries: number }> {
  const rootEntries = await readdir(root, { withFileTypes: true });
  const names = rootEntries.map((entry) => entry.name).sort();
  if (
    names.length !== 2 ||
    names[0] !== 'locks' ||
    names[1] !== 'records' ||
    rootEntries.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())
  ) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
      'Approval-store root contains unknown entries.',
      root,
    );
  }
  let totalBytes = 0;
  let entries = 0;
  const scanDirectory = async (
    directory: string,
    allowed: (name: string) => boolean,
  ): Promise<void> => {
    const values = await readdir(directory, { withFileTypes: true });
    entries += values.length;
    if (entries > MAX_ENTRIES) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_LIMIT_EXCEEDED',
        'Approval-store entry limit exceeded.',
      );
    }
    for (const value of values) {
      const path = join(directory, value.name);
      const stat = await lstat(path);
      if (
        !allowed(value.name) ||
        value.isSymbolicLink() ||
        stat.isSymbolicLink() ||
        !value.isFile() ||
        !stat.isFile()
      ) {
        return fail(
          'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
          'Approval-store contains an unsafe entry.',
          path,
        );
      }
      if (ownerOnly) {
        try {
          await assertOwnerFile(path, AUTHORITY_STORE_SECURITY);
        } catch (error) {
          return fail(
            'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
            `Approval-store entry is not owner-only: ${String(error)}`,
            path,
          );
        }
      }
      totalBytes += stat.size;
      if (stat.size > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
        return fail(
          'WORKFLOW_EFFECT_APPROVAL_STORE_LIMIT_EXCEEDED',
          'Approval-store byte limit exceeded.',
          path,
        );
      }
    }
  };
  await scanDirectory(
    join(root, 'records'),
    (name) => RECORD_NAME.test(name) || RECORD_TEMP.test(name),
  );
  await scanDirectory(
    join(root, 'locks'),
    (name) => name === 'decision.lock' || LOCK_TEMP.test(name),
  );
  return { totalBytes, entries };
}

async function prepare(configuredRoot: string, create: boolean): Promise<PreparedStore> {
  if (
    typeof configuredRoot !== 'string' ||
    !isAbsolute(configuredRoot) ||
    resolve(configuredRoot) !== configuredRoot ||
    configuredRoot.includes('\0')
  ) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
      'Approval-store root must be a normalized absolute path.',
    );
  }
  const ownerOnly = hasWorkflowEffectAuthorityRoot(configuredRoot);
  const root = ownerOnly
    ? await assertAuthorityDirectory(configuredRoot, create, undefined, !create)
    : await assertDirectory(configuredRoot);
  const recordsPath = join(configuredRoot, 'records');
  const locksPath = join(configuredRoot, 'locks');
  if (create && !ownerOnly) {
    await ensureFixedChild(root.real, recordsPath);
    await ensureFixedChild(root.real, locksPath);
  }
  const records = ownerOnly
    ? await assertAuthorityDirectory(recordsPath, create, root.real)
    : await assertDirectory(recordsPath);
  const locks = ownerOnly
    ? await assertAuthorityDirectory(locksPath, create, root.real)
    : await assertDirectory(locksPath);
  if (!contained(root.real, records.real) || !contained(root.real, locks.real)) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
      'Approval-store directories escape their root.',
    );
  }
  return {
    root: configuredRoot,
    rootReal: root.real,
    rootStat: root.stat,
    // Keep all durable child and file operations rooted in the verified
    // canonical directories. Windows may expand a safe 8.3 configured root,
    // and reusing the host spelling would make later exact-path checks reject
    // the store's own owner-checked temporaries.
    records: records.real,
    recordsReal: records.real,
    recordsStat: records.stat,
    locks: locks.real,
    locksReal: locks.real,
    locksStat: locks.stat,
    ...(await scanStore(root.real, ownerOnly)),
  };
}

async function assertPreparedStable(prepared: PreparedStore): Promise<void> {
  const ownerOnly = hasWorkflowEffectAuthorityRoot(prepared.root);
  const root = ownerOnly
    ? await assertAuthorityDirectory(prepared.root, false)
    : await assertDirectory(prepared.root);
  const records = ownerOnly
    ? await assertAuthorityDirectory(prepared.records, false, root.real)
    : await assertDirectory(prepared.records);
  const locks = ownerOnly
    ? await assertAuthorityDirectory(prepared.locks, false, root.real)
    : await assertDirectory(prepared.locks);
  if (
    !sameIdentity(prepared.rootStat, root.stat) ||
    !sameIdentity(prepared.recordsStat, records.stat) ||
    !sameIdentity(prepared.locksStat, locks.stat) ||
    !samePath(prepared.rootReal, root.real) ||
    !samePath(prepared.recordsReal, records.real) ||
    !samePath(prepared.locksReal, locks.real)
  ) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
      'Approval-store directory identity changed.',
    );
  }
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

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten < 1) throw new Error('Approval-store write made no progress.');
    offset += bytesWritten;
  }
}

function lockBytes(owner: LockOwner): Buffer {
  return Buffer.from(`${canonicalWorkflowEffectJson(owner)}\n`, 'utf8');
}

function validateLockOwner(value: unknown): LockOwner {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
      'Approval-store lock owner is invalid.',
    );
  }
  const record = value as Record<string, unknown>;
  const fields = ['schema', 'pid', 'sessionId', 'threadId', 'nonce', 'createdAt'];
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
      'Approval-store lock owner is not closed.',
    );
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
        'Approval-store lock owner must be inert.',
      );
    }
  }
  if (
    record.schema !== LOCK_SCHEMA ||
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
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    new Date(Date.parse(record.createdAt)).toISOString() !== record.createdAt
  ) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
      'Approval-store lock owner metadata is invalid.',
    );
  }
  return Object.freeze(record as unknown as LockOwner);
}

async function readLock(prepared: PreparedStore, path: string) {
  const initial = await lstatIfPresent(path);
  if (!initial) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED',
      'Approval-store lock disappeared before read.',
      path,
    );
  }
  if (initial.isFile() && !initial.isSymbolicLink() && initial.size < 1) {
    await delay(5);
    const repeated = await lstatIfPresent(path);
    if (
      !repeated ||
      !sameIdentity(initial, repeated) ||
      (repeated.isFile() &&
        !repeated.isSymbolicLink() &&
        repeated.size >= 1 &&
        repeated.size <= LOCK_MAX_BYTES)
    ) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED',
        'Approval-store lock publication was not yet stable.',
        path,
      );
    }
  }
  if (
    !initial.isFile() ||
    initial.isSymbolicLink() ||
    initial.size < 1 ||
    initial.size > LOCK_MAX_BYTES
  ) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
      'Approval-store lock file is unsafe.',
      path,
    );
  }
  if (hasWorkflowEffectAuthorityRoot(prepared.root)) {
    try {
      await assertOwnerFile(path, AUTHORITY_STORE_SECURITY);
    } catch (error) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
        `Approval-store lock is not owner-only: ${String(error)}`,
        path,
      );
    }
  }
  const resolved = await realpath(path);
  if (!samePath(path, resolved) || !contained(prepared.locksReal, resolved)) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
      'Approval-store lock escapes its directory.',
      path,
    );
  }
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const before = await handle.stat();
    const buffer = Buffer.allocUnsafe(LOCK_MAX_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const final = await lstat(path);
    if (
      offset > LOCK_MAX_BYTES ||
      !stableIdentity(initial, before) ||
      !stableIdentity(before, after) ||
      !stableIdentity(after, final) ||
      after.size !== offset
    ) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED',
        'Approval-store lock changed during read.',
        path,
      );
    }
    const bytes = Buffer.from(buffer.subarray(0, offset));
    let owner: LockOwner;
    try {
      owner = validateLockOwner(parseWorkflowEffectJson(bytes));
    } catch (error) {
      if (error instanceof WorkflowEffectApprovalStoreError) throw error;
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
        'Approval-store lock JSON is invalid.',
        path,
      );
    }
    if (!bytes.equals(lockBytes(owner))) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
        'Approval-store lock is not canonical.',
        path,
      );
    }
    return { owner, stat: final };
  } finally {
    await handle.close();
  }
}

function ownerIsProvablyDead(owner: Pick<LockOwner, 'pid'>): boolean {
  if (owner.pid === process.pid) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function removeStaleLock(
  prepared: PreparedStore,
  path: string,
  observed: Awaited<ReturnType<typeof readLock>>,
): Promise<boolean> {
  if (!ownerIsProvablyDead(observed.owner)) return false;
  const repeated = await lstat(path);
  const resolved = await realpath(path);
  if (
    !stableIdentity(observed.stat, repeated) ||
    !samePath(path, resolved) ||
    !contained(prepared.locksReal, resolved)
  ) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED',
      'Approval-store lock changed before stale recovery.',
      path,
    );
  }
  await rm(path);
  await syncDirectory(prepared.locks);
  return true;
}

function ownerFromTemporaryName(name: string): Pick<LockOwner, 'pid'> | undefined {
  const match = LOCK_TEMP.exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) return undefined;
  return { pid };
}

async function recoverTemporaryLocks(prepared: PreparedStore): Promise<boolean> {
  const values = await readdir(prepared.locks, { withFileTypes: true });
  let removed = false;
  for (const value of values) {
    if (!value.name.startsWith('.decision.')) continue;
    const path = join(prepared.locks, value.name);
    const owner = ownerFromTemporaryName(value.name);
    if (!owner) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
        'Approval-store lock temporary name is invalid.',
        path,
      );
    }
    const stat = await lstatIfPresent(path);
    if (!stat) continue;
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !(await lstatIfPresent(path))) {
        continue;
      }
      throw error;
    }
    const dead = ownerIsProvablyDead(owner);
    if (!dead) return false;
    if (
      value.isSymbolicLink() ||
      stat.isSymbolicLink() ||
      !value.isFile() ||
      !stat.isFile() ||
      stat.size > LOCK_MAX_BYTES ||
      !samePath(path, resolved) ||
      !contained(prepared.locksReal, resolved)
    ) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
        'Approval-store lock temporary is unsafe.',
        path,
      );
    }
    await rm(path);
    removed = true;
  }
  if (removed) await syncDirectory(prepared.locks);
  return true;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

async function acquireLock(prepared: PreparedStore): Promise<AcquiredLock> {
  const path = join(prepared.locks, 'decision.lock');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!(await recoverTemporaryLocks(prepared))) {
      await delay(5);
      continue;
    }
    const owner: LockOwner = Object.freeze({
      schema: LOCK_SCHEMA,
      pid: process.pid,
      sessionId: PROCESS_SESSION_ID,
      threadId,
      nonce: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    const temporaryPath = join(
      prepared.locks,
      `.decision.${owner.pid}.${owner.sessionId}.${owner.threadId}.${owner.nonce}.tmp`,
    );
    const handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    let handleClosed = false;
    try {
      if (hasWorkflowEffectAuthorityRoot(prepared.root)) {
        AUTHORITY_STORE_SECURITY.hardenPath(temporaryPath, false);
        await assertOwnerFile(temporaryPath, AUTHORITY_STORE_SECURITY);
      }
      const bytes = lockBytes(owner);
      await writeAll(handle, bytes);
      await handle.sync();
      const opened = await handle.stat();
      await handle.close();
      handleClosed = true;
      const temporaryStat = await lstat(temporaryPath);
      const temporaryReal = await realpath(temporaryPath);
      if (
        !stableIdentity(opened, temporaryStat) ||
        temporaryStat.size !== bytes.length ||
        !samePath(temporaryPath, temporaryReal) ||
        !contained(prepared.locksReal, temporaryReal)
      ) {
        return fail(
          'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED',
          'Approval-store lock temporary changed.',
          temporaryPath,
        );
      }
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await rm(temporaryPath);
        let observed: Awaited<ReturnType<typeof readLock>>;
        try {
          observed = await readLock(prepared, path);
        } catch (readError) {
          if (
            (readError instanceof WorkflowEffectApprovalStoreError &&
              readError.code === 'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED') ||
            (((readError instanceof WorkflowEffectApprovalStoreError &&
              readError.code === 'WORKFLOW_EFFECT_APPROVAL_STORE_NOT_FOUND') ||
              (readError as NodeJS.ErrnoException).code === 'ENOENT') &&
              !(await lstatIfPresent(path)))
          ) {
            await delay(5);
            continue;
          }
          throw readError;
        }
        if (!(await removeStaleLock(prepared, path, observed))) await delay(5);
        continue;
      }
      await syncDirectory(prepared.locks);
      const published = await lstat(path);
      if (!sameIdentity(temporaryStat, published) || published.size !== bytes.length) {
        return fail(
          'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED',
          'Approval-store lock publication changed.',
          path,
        );
      }
      if (hasWorkflowEffectAuthorityRoot(prepared.root)) {
        await assertOwnerFile(path, AUTHORITY_STORE_SECURITY);
      }
      await rm(temporaryPath);
      await syncDirectory(prepared.locks);
      return { path, stat: await lstat(path) };
    } catch (error) {
      if (!handleClosed) await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
  return fail(
    'WORKFLOW_EFFECT_APPROVAL_STORE_BUSY',
    'Approval-store lock retry limit exceeded.',
    path,
  );
}

async function releaseLock(lock: AcquiredLock): Promise<void> {
  const current = await lstatIfPresent(lock.path);
  const resolved = current ? await realpath(lock.path) : undefined;
  if (
    !current ||
    !sameIdentity(lock.stat, current) ||
    !resolved ||
    !samePath(lock.path, resolved)
  ) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED',
      'Approval-store lock changed before release.',
      lock.path,
    );
  }
  await rm(lock.path);
  await syncDirectory(dirname(lock.path));
}

async function recoverRecordTemporaries(prepared: PreparedStore): Promise<void> {
  const values = await readdir(prepared.records, { withFileTypes: true });
  let removed = false;
  for (const value of values) {
    if (!value.name.startsWith('.')) continue;
    const path = join(prepared.records, value.name);
    if (!RECORD_TEMP.test(value.name)) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
        'Approval-store record temporary name is invalid.',
        path,
      );
    }
    const stat = await lstat(path);
    const resolved = await realpath(path);
    if (
      value.isSymbolicLink() ||
      stat.isSymbolicLink() ||
      !value.isFile() ||
      !stat.isFile() ||
      stat.size > MAX_FILE_BYTES ||
      !samePath(path, resolved) ||
      !contained(prepared.recordsReal, resolved)
    ) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
        'Approval-store record temporary is unsafe.',
        path,
      );
    }
    await rm(path);
    removed = true;
  }
  if (removed) await syncDirectory(prepared.records);
}

function recordPath(prepared: PreparedStore, runId: string, approvalId: string): string {
  assertSafeScope(runId, 'runId');
  assertSafeScope(approvalId, 'approvalId');
  return join(prepared.records, `${recordKey(runId, approvalId)}.json`);
}

async function assertRecordFile(path: string, recordsReal: string): Promise<Stats> {
  const stat = await lstatIfPresent(path);
  if (!stat) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_NOT_FOUND',
      'Workflow effect approval is not present.',
      path,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_FILE_BYTES) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
      'Workflow effect approval file is unsafe.',
      path,
    );
  }
  const resolved = await realpath(path);
  if (!samePath(path, resolved) || !contained(recordsReal, resolved)) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
      'Workflow effect approval file escapes its directory.',
      path,
    );
  }
  const storeRoot = dirname(recordsReal);
  if (hasWorkflowEffectAuthorityRoot(storeRoot)) {
    try {
      await assertOwnerFile(path, AUTHORITY_STORE_SECURITY);
    } catch (error) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_UNSAFE',
        `Workflow effect approval file is not owner-only: ${String(error)}`,
        path,
      );
    }
  }
  return stat;
}

async function boundedRead(
  prepared: PreparedStore,
  runId: string,
  approvalId: string,
): Promise<{ record: WorkflowEffectApprovalRecord; bytes: Buffer; stat: Stats }> {
  const path = recordPath(prepared, runId, approvalId);
  const initial = await assertRecordFile(path, prepared.recordsReal);
  const handle = await open(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const before = await handle.stat();
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    const final = await lstat(path);
    if (
      offset > MAX_FILE_BYTES ||
      !stableIdentity(initial, before) ||
      !stableIdentity(before, after) ||
      !stableIdentity(after, final) ||
      after.size !== offset
    ) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED',
        'Workflow effect approval changed during read.',
        path,
      );
    }
    const bytes = Buffer.from(buffer.subarray(0, offset));
    let record: WorkflowEffectApprovalRecord;
    try {
      record = validateWorkflowEffectApproval(parseWorkflowEffectJson(bytes));
    } catch (error) {
      if (error instanceof WorkflowEffectApprovalContractError) {
        return fail(
          'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
          'Workflow effect approval record is invalid.',
          path,
        );
      }
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
        'Workflow effect approval JSON is invalid.',
        path,
      );
    }
    if (!bytes.equals(workflowEffectApprovalBytes(record))) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
        'Workflow effect approval record is not canonical.',
        path,
      );
    }
    if (record.runId !== runId || record.approvalId !== approvalId) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_SCOPE_MISMATCH',
        'Workflow effect approval path and record scope differ.',
        path,
      );
    }
    return { record, bytes, stat: final };
  } finally {
    await handle.close();
  }
}

/** @internal Stable point-read used by the authenticated D2 recovery path. */
export async function readWorkflowEffectApprovalRecordExact(
  root: string,
  runId: string,
  approvalId: string,
): Promise<WorkflowEffectApprovalRecord | undefined> {
  const prepared = await prepare(root, false);
  const path = recordPath(prepared, runId, approvalId);
  if (!(await lstatIfPresent(path))) return undefined;
  return (await boundedRead(prepared, runId, approvalId)).record;
}

async function atomicWrite(
  prepared: PreparedStore,
  runId: string,
  approvalId: string,
  record: WorkflowEffectApprovalRecord,
  expected: Stats | null,
): Promise<void> {
  const bytes = workflowEffectApprovalBytes(record);
  if (bytes.length > MAX_FILE_BYTES) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_LIMIT_EXCEEDED',
      'Workflow effect approval exceeds its file limit.',
    );
  }
  if (
    prepared.totalBytes + bytes.length * 2 > MAX_TOTAL_BYTES ||
    prepared.entries + 1 > MAX_ENTRIES
  ) {
    return fail(
      'WORKFLOW_EFFECT_APPROVAL_STORE_LIMIT_EXCEEDED',
      'Workflow effect approval exceeds store capacity.',
    );
  }
  const key = recordKey(runId, approvalId);
  const path = recordPath(prepared, runId, approvalId);
  const temporaryPath = join(prepared.records, `.${key}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
    0o600,
  );
  let handleClosed = false;
  try {
    if (hasWorkflowEffectAuthorityRoot(prepared.root)) {
      AUTHORITY_STORE_SECURITY.hardenPath(temporaryPath, false);
      await assertOwnerFile(temporaryPath, AUTHORITY_STORE_SECURITY);
    }
    await writeAll(handle, bytes);
    await handle.sync();
    const temporaryStat = await lstat(temporaryPath);
    const temporaryReal = await realpath(temporaryPath);
    if (
      temporaryStat.size !== bytes.length ||
      !samePath(temporaryPath, temporaryReal) ||
      !contained(prepared.recordsReal, temporaryReal)
    ) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED',
        'Workflow effect approval temporary changed.',
        temporaryPath,
      );
    }
    await assertPreparedStable(prepared);
    if (expected === null) {
      try {
        await link(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          return fail(
            'WORKFLOW_EFFECT_APPROVAL_STORE_ALREADY_EXISTS',
            'Workflow effect approval already exists.',
            path,
          );
        }
        throw error;
      }
      await rm(temporaryPath);
    } else {
      const current = await assertRecordFile(path, prepared.recordsReal);
      if (!stableIdentity(expected, current)) {
        return fail(
          'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED',
          'Workflow effect approval changed before atomic update.',
          path,
        );
      }
      // Windows and WSL drvfs delay visibility of a renamed file until the
      // source handle closes. Revalidate the exact temporary after closing so
      // publication remains fail-closed on every supported filesystem.
      await handle.close();
      handleClosed = true;
      const repeatedTemporary = await lstat(temporaryPath);
      if (!stableIdentity(temporaryStat, repeatedTemporary)) {
        return fail(
          'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED',
          'Workflow effect approval temporary changed before atomic update.',
          temporaryPath,
        );
      }
      await rename(temporaryPath, path);
    }
    await syncDirectory(prepared.records);
    const final = await assertRecordFile(path, prepared.recordsReal);
    if (final.size !== bytes.length) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_FILE_CHANGED',
        'Workflow effect approval changed after atomic update.',
        path,
      );
    }
    await assertPreparedStable(prepared);
  } finally {
    if (!handleClosed) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export class LocalWorkflowEffectApprovalStore {
  readonly #root: string;
  readonly #authority: WorkflowEffectDecisionAuthority;
  readonly #now: () => string;
  readonly #observationPort: WorkflowControlObservationPort | undefined;

  constructor(
    root: string,
    authority: WorkflowEffectDecisionAuthority,
    now: () => string = () => new Date().toISOString(),
    observationPort?: WorkflowControlObservationPort,
  ) {
    WorkflowEffectDecisionAuthority.assertSealed(authority);
    if (
      typeof root !== 'string' ||
      !isAbsolute(root) ||
      resolve(root) !== root ||
      root.includes('\0')
    ) {
      fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_PATH_UNSAFE',
        'Approval-store root must be a normalized absolute path.',
      );
    }
    if (typeof now !== 'function') {
      fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
        'Approval-store clock must be host-owned.',
      );
    }
    if (observationPort !== undefined && !isWorkflowControlObservationPort(observationPort)) {
      fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
        'Approval-store observationPort must be a host-created Workflow Control port.',
      );
    }
    this.#root = root;
    this.#authority = authority;
    this.#now = now;
    this.#observationPort = observationPort;
  }

  #observe(runId: string): void {
    try {
      this.#observationPort?.observeRun(runId);
    } catch {
      // Effect authority commits are never coupled to the Go shadow.
    }
  }

  async createPending(
    input: CreatePendingWorkflowEffectApprovalInput,
  ): Promise<WorkflowEffectApprovalRecord> {
    const now = this.#now();
    const record = await persistWorkflowEffectApprovalPending(this.#root, input, now, false);
    this.#observe(record.runId);
    return record;
  }

  async read(runId: string, approvalId: string): Promise<WorkflowEffectApprovalRecord | undefined> {
    assertSafeScope(runId, 'runId');
    assertSafeScope(approvalId, 'approvalId');
    let prepared: PreparedStore;
    try {
      prepared = await prepare(this.#root, false);
    } catch (error) {
      if (
        error instanceof WorkflowEffectApprovalStoreError &&
        error.code === 'WORKFLOW_EFFECT_APPROVAL_STORE_NOT_FOUND'
      ) {
        return undefined;
      }
      throw error;
    }
    const lock = await acquireLock(prepared);
    try {
      await recoverRecordTemporaries(prepared);
      prepared = await prepare(this.#root, false);
    } finally {
      await releaseLock(lock);
    }
    if (!(await lstatIfPresent(recordPath(prepared, runId, approvalId)))) return undefined;
    return (await boundedRead(prepared, runId, approvalId)).record;
  }

  async decide(
    inputValue: DecideWorkflowEffectApprovalInput,
  ): Promise<WorkflowEffectApprovalRecord> {
    if (
      typeof inputValue !== 'object' ||
      inputValue === null ||
      Array.isArray(inputValue) ||
      nodeTypes.isProxy(inputValue) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(inputValue) as never) ||
      Reflect.ownKeys(inputValue).length !== 6 ||
      !['runId', 'approvalId', 'expectedRevision', 'decision', 'reasonHash', 'binding'].every(
        (field) => Object.hasOwn(inputValue, field),
      )
    ) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
        'Approval decision input is not closed.',
      );
    }
    const values = Object.fromEntries(
      Reflect.ownKeys(inputValue).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(inputValue, key);
        if (
          typeof key !== 'string' ||
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        ) {
          return fail(
            'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
            'Approval decision input must contain only data fields.',
          );
        }
        return [key, descriptor.value];
      }),
    ) as unknown as DecideWorkflowEffectApprovalInput;
    assertSafeScope(values.runId, 'runId');
    assertSafeScope(values.approvalId, 'approvalId');
    if (!Number.isSafeInteger(values.expectedRevision)) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_CAS_MISMATCH',
        'Approval expected revision is invalid.',
      );
    }
    let prepared = await prepare(this.#root, false);
    const lock = await acquireLock(prepared);
    try {
      await recoverRecordTemporaries(prepared);
      prepared = await prepare(this.#root, false);
      const current = await boundedRead(prepared, values.runId, values.approvalId);
      if (current.record.revision !== values.expectedRevision) {
        const decision = current.record.decision;
        if (
          hasWorkflowEffectAuthorityRoot(this.#root) &&
          values.expectedRevision === 0 &&
          current.record.revision === 1 &&
          current.record.status === values.decision &&
          decision !== null &&
          decision.reasonHash === values.reasonHash &&
          decision.principalId === values.binding.principalId &&
          decision.workspaceId === values.binding.workspaceId &&
          decision.capability === values.binding.capability &&
          values.binding.runId === current.record.runId &&
          values.binding.approvalId === current.record.approvalId &&
          values.binding.correlationId === current.record.correlationId &&
          values.binding.approvalExpiresAt === current.record.expiresAt &&
          values.binding.decision === values.decision &&
          values.binding.reasonHash === values.reasonHash &&
          values.binding.issuedAt < values.binding.expiresAt
        ) {
          this.#authority.assertHumanDecisionBinding(values.binding, {
            requiredCapability: current.record.requiredCapability,
            runId: current.record.runId,
            approvalId: current.record.approvalId,
            correlationId: current.record.correlationId,
            approvalExpiresAt: current.record.expiresAt,
            decision: values.decision,
            reasonHash: values.reasonHash,
            decidedAt: values.binding.issuedAt,
          });
          const { commitWorkflowEffectAuthorityDecision } = await authorityRecovery();
          await commitWorkflowEffectAuthorityDecision(this.#root, current.record);
          this.#observe(values.runId);
          return current.record;
        }
        return fail(
          'WORKFLOW_EFFECT_APPROVAL_STORE_CAS_MISMATCH',
          'Workflow effect approval revision no longer matches.',
        );
      }
      const next = applyWorkflowEffectApprovalDecision(
        current.record,
        values.decision,
        values.binding,
        this.#authority,
        values.reasonHash,
        this.#now(),
      );
      const { prepareWorkflowEffectAuthorityDecision, commitWorkflowEffectAuthorityDecision } =
        await authorityRecovery();
      const durableNext = await prepareWorkflowEffectAuthorityDecision(
        this.#root,
        current.record,
        next,
        values.binding,
      );
      try {
        await atomicWrite(prepared, values.runId, values.approvalId, durableNext, current.stat);
      } catch (commitError) {
        const observed = await boundedRead(prepared, values.runId, values.approvalId).catch(
          () => undefined,
        );
        if (!observed?.bytes.equals(workflowEffectApprovalBytes(durableNext))) throw commitError;
      }
      await commitWorkflowEffectAuthorityDecision(this.#root, durableNext);
      this.#observe(values.runId);
      return durableNext;
    } finally {
      await releaseLock(lock);
    }
  }

  async markAuditProjected(
    inputValue: MarkWorkflowEffectApprovalAuditProjectedInput,
  ): Promise<WorkflowEffectApprovalRecord> {
    if (
      typeof inputValue !== 'object' ||
      inputValue === null ||
      Array.isArray(inputValue) ||
      nodeTypes.isProxy(inputValue) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(inputValue) as never) ||
      Reflect.ownKeys(inputValue).length !== 4 ||
      !['runId', 'approvalId', 'expectedRevision', 'eventId'].every((field) =>
        Object.hasOwn(inputValue, field),
      )
    ) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
        'Approval audit projection input is not closed.',
      );
    }
    const values = Object.fromEntries(
      Reflect.ownKeys(inputValue).map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(inputValue, key);
        if (
          typeof key !== 'string' ||
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        ) {
          return fail(
            'WORKFLOW_EFFECT_APPROVAL_STORE_RECORD_INVALID',
            'Approval audit projection input must contain only data fields.',
          );
        }
        return [key, descriptor.value];
      }),
    ) as unknown as MarkWorkflowEffectApprovalAuditProjectedInput;
    assertSafeScope(values.runId, 'runId');
    assertSafeScope(values.approvalId, 'approvalId');
    if (values.expectedRevision !== 1) {
      return fail(
        'WORKFLOW_EFFECT_APPROVAL_STORE_CAS_MISMATCH',
        'Approval audit projection revision is invalid.',
      );
    }
    let prepared = await prepare(this.#root, false);
    const lock = await acquireLock(prepared);
    try {
      await recoverRecordTemporaries(prepared);
      prepared = await prepare(this.#root, false);
      const current = await boundedRead(prepared, values.runId, values.approvalId);
      if (current.record.revision !== values.expectedRevision) {
        if (
          hasWorkflowEffectAuthorityRoot(this.#root) &&
          current.record.revision === 2 &&
          current.record.auditProjection?.status === 'recorded' &&
          current.record.auditProjection.eventId === values.eventId
        ) {
          const { updateWorkflowEffectAuthorityAudit } = await authorityRecovery();
          await updateWorkflowEffectAuthorityAudit(this.#root, current.record);
          this.#observe(values.runId);
          return current.record;
        }
        return fail(
          'WORKFLOW_EFFECT_APPROVAL_STORE_CAS_MISMATCH',
          'Workflow effect approval revision no longer matches.',
        );
      }
      const next = markWorkflowEffectApprovalAuditRecorded(
        current.record,
        values.eventId,
        this.#now(),
      );
      try {
        await atomicWrite(prepared, values.runId, values.approvalId, next, current.stat);
      } catch (commitError) {
        const observed = await boundedRead(prepared, values.runId, values.approvalId).catch(
          () => undefined,
        );
        if (!observed?.bytes.equals(workflowEffectApprovalBytes(next))) throw commitError;
      }
      const { updateWorkflowEffectAuthorityAudit } = await authorityRecovery();
      await updateWorkflowEffectAuthorityAudit(this.#root, next);
      this.#observe(values.runId);
      return next;
    } finally {
      await releaseLock(lock);
    }
  }
}
