import { decodeStrictJSON } from '@openslack/core';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CleanupBrokerRequest } from './cleanup-broker-client.js';
import { cleanupBrokerExecutionDigest } from './internal/cleanup-broker-digest.js';

/**
 * An independent historical query record for a cleanup execute request.
 *
 * The record carries the versioned schema, the creation time, the original
 * execute request and its production digest — nothing else. It holds no
 * credential material and is **not** an authorization: it cannot admit a
 * preview or execute, and it is not a result. The broker continues to verify
 * the operating-system peer and the original durable binding; this file only
 * lets an administrator look up what was originally requested.
 */
export const CLEANUP_OPERATION_RECORD_SCHEMA = 'openslack.cleanup_operation_record.v1';

/** Bounded decode limit; the record is a small fixed-shape document. */
export const CLEANUP_OPERATION_RECORD_MAX_BYTES = 16 * 1024;

/** Directory, relative to the workspace root, that holds published records. */
export const CLEANUP_OPERATION_RECORD_DIRECTORY = '.openslack/outbox/cleanup-operations';

const recordKeys = ['schema', 'createdAt', 'request', 'requestDigest'] as const;
const requestKeys = [
  'schema',
  'mode',
  'agentId',
  'principalId',
  'runtimeUid',
  'runId',
  'repo',
  'remote',
  'prNumber',
  'permitId',
  'operationId',
] as const;

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/**
 * Identity claims use the wider charset the production digest accepts, so a
 * request that is valid on the wire is never rejected here for a reason the
 * wire format allows.
 */
const wireClaim = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;
const digest = /^[0-9a-f]{64}$/;

/** Paths that must never be written to or read as a record. */
const sensitive = [
  /(^|[/\\])\.env(\.[^/\\]*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|[/\\])secrets([/\\]|$)/i,
  /(^|[/\\])credentials([/\\]|$)/i,
];

export type CleanupOperationRecordErrorCode =
  | 'INVALID_RECORD'
  | 'INVALID_PATH'
  | 'SENSITIVE_PATH'
  | 'SYMLINK_REJECTED'
  | 'BINDING_CONFLICT'
  | 'PERSISTENCE_FAILED';

export class CleanupOperationRecordError extends Error {
  constructor(
    public readonly code: CleanupOperationRecordErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CleanupOperationRecordError';
  }
}

/**
 * An execute request as recorded. `operationId` is optional on the wire but
 * required in a record: it is the only key an administrator can query by.
 */
export type CleanupOperationRequest = CleanupBrokerRequest & { operationId: string };

export interface CleanupOperationQueryRecord {
  schema: typeof CLEANUP_OPERATION_RECORD_SCHEMA;
  createdAt: string;
  request: CleanupOperationRequest;
  requestDigest: string;
}

export interface SaveCleanupOperationRecordResult {
  /** `published` when this call created the file; `reused` when an identical
   * record for the same operation and binding already existed. */
  status: 'published' | 'reused';
  path: string;
}

function fail(code: CleanupOperationRecordErrorCode, message: string): never {
  throw new CleanupOperationRecordError(code, message);
}

function assertNotSensitive(path: string): void {
  if (sensitive.some((pattern) => pattern.test(path))) {
    fail('SENSITIVE_PATH', `Refusing to use a sensitive path for a cleanup operation record.`);
  }
}

/** The record file for an operation, inside the authorized outbox directory. */
export function cleanupOperationRecordPath(rootDir: string, operationId: string): string {
  if (!identifier.test(operationId)) {
    fail('INVALID_PATH', 'Operation ID must be a bounded identifier.');
  }
  return resolve(rootDir, CLEANUP_OPERATION_RECORD_DIRECTORY, `${operationId}.json`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reject any key outside the declared set, and any missing key. */
function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  what: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail('INVALID_RECORD', `${what} has unexpected or missing keys.`);
  }
}

function assertIdentifier(value: unknown, name: string): string {
  if (typeof value !== 'string' || !identifier.test(value)) {
    fail('INVALID_RECORD', `${name} must be a bounded identifier.`);
  }
  return value;
}

function assertRequest(value: unknown): CleanupOperationRequest {
  if (!isPlainObject(value)) fail('INVALID_RECORD', 'request must be an object.');
  assertExactKeys(value, requestKeys, 'request');
  if (value.schema !== 'openslack.cleanup_request.v1') {
    fail('INVALID_RECORD', 'request.schema must be openslack.cleanup_request.v1.');
  }
  if (value.mode !== 'execute') {
    // Only an execute request is recorded; a preview is not a durable intent.
    fail('INVALID_RECORD', 'request.mode must be execute.');
  }
  if (typeof value.prNumber !== 'number' || !Number.isSafeInteger(value.prNumber)) {
    fail('INVALID_RECORD', 'request.prNumber must be a safe integer.');
  }
  for (const name of ['repo', 'remote'] as const) {
    if (typeof value[name] !== 'string' || value[name].length === 0) {
      fail('INVALID_RECORD', `request.${name} must be a non-empty string.`);
    }
  }
  for (const name of ['agentId', 'principalId', 'runtimeUid', 'runId', 'permitId'] as const) {
    if (typeof value[name] !== 'string' || !wireClaim.test(value[name])) {
      fail('INVALID_RECORD', `request.${name} must be a bounded claim.`);
    }
  }
  // operationId is optional on the wire but required for a query record: it is
  // the only key an administrator can look the operation up by.
  assertIdentifier(value.operationId, 'request.operationId');
  return value as unknown as CleanupOperationRequest;
}

/** Validate a record and confirm its digest matches the request it carries. */
export function assertCleanupOperationRecord(value: unknown): CleanupOperationQueryRecord {
  if (!isPlainObject(value)) fail('INVALID_RECORD', 'Record must be an object.');
  assertExactKeys(value, recordKeys, 'record');
  if (value.schema !== CLEANUP_OPERATION_RECORD_SCHEMA) {
    fail('INVALID_RECORD', `Record schema must be ${CLEANUP_OPERATION_RECORD_SCHEMA}.`);
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    fail('INVALID_RECORD', 'Record createdAt must be an ISO timestamp.');
  }
  const request = assertRequest(value.request);
  if (typeof value.requestDigest !== 'string' || !digest.test(value.requestDigest)) {
    fail('INVALID_RECORD', 'Record requestDigest must be a SHA-256 hex digest.');
  }
  if (cleanupBrokerExecutionDigest(request) !== value.requestDigest) {
    fail('INVALID_RECORD', 'Record digest does not match the request it carries.');
  }
  return value as unknown as CleanupOperationQueryRecord;
}

/**
 * fsync the directory that holds a record. On Windows a directory cannot be
 * opened for sync, so this follows the repository convention of skipping it
 * there; the file itself is still fsynced. On other platforms a failure is
 * fatal — the caller must refuse to send.
 */
function syncContainingDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const handle = openSync(dirname(path), fsConstants.O_RDONLY);
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

/**
 * fsync an existing file through its own descriptor.
 *
 * Opened `O_RDWR` because Windows refuses to fsync a handle opened read-only
 * (`EPERM`). The record is our own mode-0600 file, and a failure here is fatal
 * to the caller rather than downgraded.
 */
function syncFile(path: string): void {
  const handle = openSync(path, fsConstants.O_RDWR | noFollow());
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

/**
 * `O_NOFOLLOW` is not implemented on Windows, where it is 0. The explicit
 * `lstat` checks below are then the protection instead of a silent gap.
 */
function noFollow(): number {
  return typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
}

/**
 * Every ancestor of the path must be a real directory. A symlinked ancestor
 * would let a record be written to or read from outside the workspace, so this
 * walks from the containing directory up to the filesystem root.
 */
function assertSafeAncestry(path: string): void {
  let current = dirname(resolve(path));
  for (;;) {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(current);
    } catch {
      fail('INVALID_PATH', `Cleanup operation record ancestor is not readable: ${current}`);
    }
    if (stats.isSymbolicLink()) {
      fail('SYMLINK_REJECTED', `Cleanup operation record ancestor is a symlink: ${current}`);
    }
    if (!stats.isDirectory()) {
      fail('INVALID_PATH', `Cleanup operation record ancestor is not a directory: ${current}`);
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/**
 * Read at most `MAX + 1` bytes from an already-open descriptor.
 *
 * The bound is applied to the read itself, never after reading the whole file,
 * and the descriptor's own identity is what is inspected — so replacing the
 * path between a check and the read cannot substitute different content.
 */
function readBoundedNoFollow(path: string): Buffer {
  // `O_NOFOLLOW` is unavailable on Windows, so the link check is explicit and
  // platform-independent; the flag is still passed where the platform supports
  // it, to close the window between this check and the open.
  let linkStats: ReturnType<typeof lstatSync>;
  try {
    linkStats = lstatSync(path);
  } catch {
    fail('INVALID_PATH', 'Cleanup operation record could not be inspected.');
  }
  if (linkStats.isSymbolicLink()) {
    fail('SYMLINK_REJECTED', 'Refusing to follow a symlink to a cleanup operation record.');
  }
  if (!linkStats.isFile()) {
    fail('INVALID_PATH', 'Cleanup operation record must be a regular file.');
  }
  let handle: number;
  try {
    handle = openSync(path, fsConstants.O_RDONLY | noFollow());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      fail('SYMLINK_REJECTED', 'Refusing to follow a symlink to a cleanup operation record.');
    }
    fail('INVALID_PATH', 'Cleanup operation record could not be opened.');
  }
  try {
    const stats = fstatSync(handle);
    if (!stats.isFile()) {
      fail('INVALID_PATH', 'Cleanup operation record must be a regular file.');
    }
    if (stats.size > CLEANUP_OPERATION_RECORD_MAX_BYTES) {
      fail('INVALID_RECORD', 'Cleanup operation record exceeds the bounded decode limit.');
    }
    const buffer = Buffer.allocUnsafe(CLEANUP_OPERATION_RECORD_MAX_BYTES + 1);
    let total = 0;
    for (;;) {
      const read = readSync(
        handle,
        buffer,
        total,
        CLEANUP_OPERATION_RECORD_MAX_BYTES + 1 - total,
        total,
      );
      if (read === 0) break;
      total += read;
      if (total > CLEANUP_OPERATION_RECORD_MAX_BYTES) {
        fail('INVALID_RECORD', 'Cleanup operation record exceeds the bounded decode limit.');
      }
    }
    return buffer.subarray(0, total);
  } finally {
    closeSync(handle);
  }
}

function encode(record: CleanupOperationQueryRecord): Buffer {
  // Fixed key order so the published bytes are canonical for a given record.
  return Buffer.from(
    `${JSON.stringify({
      schema: record.schema,
      createdAt: record.createdAt,
      request: record.request,
      requestDigest: record.requestDigest,
    })}\n`,
    'utf8',
  );
}

/** Read an already-published record without creating or repairing anything. */
export function readCleanupOperationRecord(path: string): CleanupOperationQueryRecord {
  assertNotSensitive(path);
  assertSafeAncestry(path);
  const bytes = readBoundedNoFollow(path);
  let decoded: unknown;
  try {
    decoded = decodeStrictJSON(bytes, CLEANUP_OPERATION_RECORD_MAX_BYTES);
  } catch {
    fail('INVALID_RECORD', 'Cleanup operation record is not valid bounded strict JSON.');
  }
  return assertCleanupOperationRecord(decoded);
}

/**
 * Build a record from an execute request, deriving the production digest so a
 * caller cannot publish a record whose digest disagrees with its request.
 */
export function buildCleanupOperationRecord(
  request: CleanupOperationRequest,
  createdAt: string = new Date().toISOString(),
): CleanupOperationQueryRecord {
  return {
    schema: CLEANUP_OPERATION_RECORD_SCHEMA,
    createdAt,
    request,
    requestDigest: cleanupBrokerExecutionDigest(request),
  };
}

/** Write every byte, refusing rather than spinning when a write makes no progress. */
function writeAll(handle: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(handle, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) {
      fail('PERSISTENCE_FAILED', 'Cleanup operation record write made no progress.');
    }
    offset += written;
  }
}

/**
 * Reuse an existing record only after independently re-establishing that its
 * bytes are complete, identical and durable. A previously failed fsync is
 * therefore never bypassed by a later reuse.
 */
function reuseExisting(path: string, validated: CleanupOperationQueryRecord): SaveCleanupOperationRecordResult {
  const existing = readCleanupOperationRecord(path);
  if (existing.requestDigest !== validated.requestDigest) {
    fail(
      'BINDING_CONFLICT',
      'A record for this operation exists with a different binding; refusing to send.',
    );
  }
  try {
    syncFile(path);
    syncContainingDirectory(path);
  } catch {
    fail('PERSISTENCE_FAILED', 'Existing cleanup operation record could not be re-synced.');
  }
  return { status: 'reused', path };
}

/** Identity of a file, used to prove a temp file is still the one we created. */
function identityOf(path: string): string | null {
  try {
    const stats = lstatSync(path);
    return `${stats.dev}:${stats.ino}:${stats.size}`;
  } catch {
    return null;
  }
}

/**
 * Publish the record for an execute request **before** it is sent.
 *
 * The publish is exclusive and atomic: this call writes its own `O_EXCL` temp
 * file in the same directory, fsyncs it, and then publishes with `link`, whose
 * `EEXIST` is what prevents overwriting another writer's record. A plain
 * `rename` is never used, because it would silently replace the target and
 * destroy the exclusivity guarantee. The published bytes are read back and
 * compared before the temp file is removed, and the containing directory is
 * fsynced last. Any failure refuses the send.
 */
export function saveCleanupOperationRecord(
  record: CleanupOperationQueryRecord,
  options: { rootDir: string },
): SaveCleanupOperationRecordResult {
  const validated = assertCleanupOperationRecord(record);
  const path = cleanupOperationRecordPath(options.rootDir, validated.request.operationId);
  assertNotSensitive(path);

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  assertSafeAncestry(path);

  const bytes = encode(validated);
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let tempIdentity: string | null = null;
  const discardTemp = () => {
    // Only remove a temp file this call created and whose identity still matches.
    if (tempIdentity === null) return;
    if (identityOf(temp) !== tempIdentity) return;
    try {
      unlinkSync(temp);
    } catch {
      // Already gone; nothing to clean up.
    }
  };

  let handle: number;
  try {
    handle = openSync(
      temp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
  } catch {
    fail('PERSISTENCE_FAILED', 'Cleanup operation record temp file could not be created.');
  }
  tempIdentity = identityOf(temp);
  try {
    writeAll(handle, bytes);
    fsyncSync(handle);
  } catch {
    closeSync(handle);
    discardTemp();
    fail('PERSISTENCE_FAILED', 'Cleanup operation record could not be durably written.');
  }
  closeSync(handle);

  try {
    // `link` fails with EEXIST when the record already exists, which is what
    // makes the publish exclusive without ever overwriting.
    linkSync(temp, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    discardTemp();
    if (code === 'EEXIST') return reuseExisting(path, validated);
    fail('PERSISTENCE_FAILED', 'Cleanup operation record could not be published.');
  }

  try {
    const published = readBoundedNoFollow(path);
    if (!published.equals(bytes)) {
      fail('PERSISTENCE_FAILED', 'Published cleanup operation record does not match its bytes.');
    }
  } catch (error) {
    discardTemp();
    throw error;
  }
  discardTemp();

  try {
    syncContainingDirectory(path);
  } catch {
    fail('PERSISTENCE_FAILED', 'Cleanup operation record directory could not be fsynced.');
  }
  return { status: 'published', path };
}

/** Convenience for callers that only know the workspace root and operation. */
export function readCleanupOperationRecordFor(
  rootDir: string,
  operationId: string,
): CleanupOperationQueryRecord {
  return readCleanupOperationRecord(cleanupOperationRecordPath(rootDir, operationId));
}
