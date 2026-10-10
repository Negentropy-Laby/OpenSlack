import { decodeStrictJSON } from '@openslack/core';
import { authorizeAgentAction, type AgentPermissionSnapshot } from '@openslack/kernel';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import {
  CleanupDirectoryAnchor,
  CleanupFileBoundaryError,
  assertCleanupDescriptorSupport,
  inodeIdentity,
  readCleanupDescriptor,
  withCleanupFile,
} from './internal/cleanup-file-boundary.js';
import { dirname, relative, resolve, sep } from 'node:path';
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
  | 'BLOCKED_AUTHORIZATION'
  | 'PERSISTENCE_FAILED'
  | 'UNSUPPORTED_PLATFORM'
  | 'FILE_CHANGED';

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

function fileFailure(error: unknown): never {
  if (error instanceof CleanupOperationRecordError) throw error;
  if (error instanceof CleanupFileBoundaryError) {
    const code =
      error.code === 'TOO_LARGE'
        ? 'INVALID_RECORD'
        : error.code === 'UNSAFE_FILE'
          ? 'INVALID_PATH'
          : error.code;
    fail(code, error.message);
  }
  fail('PERSISTENCE_FAILED', 'Safe cleanup record access or persistence failed; refusing to send.');
}
function decodeRecord(bytes: Buffer): CleanupOperationQueryRecord {
  try {
    return assertCleanupOperationRecord(
      decodeStrictJSON(bytes, CLEANUP_OPERATION_RECORD_MAX_BYTES),
    );
  } catch (error) {
    if (error instanceof CleanupOperationRecordError) throw error;
    fail('INVALID_RECORD', 'Cleanup operation record is not valid bounded strict JSON.');
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
  try {
    return withCleanupFile(resolve(path), CLEANUP_OPERATION_RECORD_MAX_BYTES, decodeRecord);
  } catch (error) {
    return fileFailure(error);
  }
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

function reuseExisting(
  path: string,
  validated: CleanupOperationQueryRecord,
): SaveCleanupOperationRecordResult {
  withCleanupFile(path, CLEANUP_OPERATION_RECORD_MAX_BYTES, (bytes, fd, directory) => {
    const existing = decodeRecord(bytes);
    if (existing.requestDigest !== validated.requestDigest)
      fail(
        'BINDING_CONFLICT',
        'A record for this operation exists with a different binding; refusing to send.',
      );
    fsyncSync(fd);
    directory.sync();
    if (!readCleanupDescriptor(fd, CLEANUP_OPERATION_RECORD_MAX_BYTES).equals(bytes))
      fail('FILE_CHANGED', 'Record content changed while establishing durability.');
  });
  return { status: 'reused', path };
}

/**
 * Options for publishing a record.
 *
 * `snapshot` is required rather than optional so that a caller cannot skip the
 * authorization step by omitting it: a null snapshot is an unknown principal
 * and the production authorizer denies it.
 */
export interface SaveCleanupOperationRecordOptions {
  rootDir: string;
  snapshot: AgentPermissionSnapshot | null;
}

/**
 * Authorize the action against the record's real workspace-relative path, with
 * deny precedence, before any directory or file is created.
 */
function assertRecordPathAuthorized(
  snapshot: AgentPermissionSnapshot | null,
  rootDir: string,
  path: string,
): void {
  const relativePath = relative(resolve(rootDir), path).split(sep).join('/');
  const result = authorizeAgentAction({
    snapshot,
    action: 'pr.cleanup_branch_scoped.v1',
    changedPaths: [relativePath],
    riskZone: 'yellow',
  });
  if (result.decision !== 'allow') {
    fail('BLOCKED_AUTHORIZATION', 'Cleanup operation record path is not authorized.');
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
  options: SaveCleanupOperationRecordOptions,
): SaveCleanupOperationRecordResult {
  const validated = assertCleanupOperationRecord(record);
  const path = cleanupOperationRecordPath(options.rootDir, validated.request.operationId);
  assertNotSensitive(path);
  // Authorize before anything is created: a denial must leave no directory, no
  // record and no send behind it.
  assertRecordPathAuthorized(options.snapshot, options.rootDir, path);

  let directory: CleanupDirectoryAnchor | undefined;
  let handle: number | undefined;
  let temporary: string | undefined;
  let temporaryIdentity: string | undefined;
  const discard = () => {
    if (temporaryIdentity === undefined || directory === undefined || temporary === undefined)
      return;
    const internal = directory.path(temporary);
    const current = lstatSync(internal);
    if (!current.isFile() || inodeIdentity(current) !== temporaryIdentity)
      fail('FILE_CHANGED', 'The owned temporary record was replaced; it was not removed.');
    unlinkSync(internal);
    temporaryIdentity = undefined;
    directory.sync();
  };
  try {
    assertCleanupDescriptorSupport();
    directory = CleanupDirectoryAnchor.open(dirname(path), resolve(options.rootDir));
    directory.verify();
    // Existing records are read, compared and synced through one descriptor.
    try {
      lstatSync(directory.path(`${validated.request.operationId}.json`));
      return reuseExisting(path, validated);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const bytes = encode(validated);
    temporary = `${validated.request.operationId}.json.${randomBytes(8).toString('hex')}.tmp`;
    directory.verify();
    handle = openSync(
      directory.path(temporary),
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    temporaryIdentity = inodeIdentity(fstatSync(handle));
    writeAll(handle, bytes);
    fsyncSync(handle);
    directory.verify();
    const final = directory.path(`${validated.request.operationId}.json`);
    try {
      linkSync(directory.path(temporary), final);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      discard();
      return reuseExisting(path, validated);
    }
    discard();
    if (
      inodeIdentity(lstatSync(final)) !== inodeIdentity(fstatSync(handle)) ||
      !readCleanupDescriptor(handle, CLEANUP_OPERATION_RECORD_MAX_BYTES).equals(bytes)
    )
      fail('FILE_CHANGED', 'Published cleanup operation record changed before send.');
    directory.sync();
    if (inodeIdentity(lstatSync(final)) !== inodeIdentity(fstatSync(handle)))
      fail('FILE_CHANGED', 'Published cleanup operation record was replaced.');
    if (!readCleanupDescriptor(handle, CLEANUP_OPERATION_RECORD_MAX_BYTES).equals(bytes))
      fail('FILE_CHANGED', 'Record bytes changed while establishing durability.');
    directory.verify();
    return { status: 'published', path };
  } catch (error) {
    try {
      discard();
    } catch (cleanup) {
      return fileFailure(cleanup);
    }
    return fileFailure(error);
  } finally {
    if (handle !== undefined) closeSync(handle);
    directory?.close();
  }
}

/** Convenience for callers that only know the workspace root and operation. */
export function readCleanupOperationRecordFor(
  rootDir: string,
  operationId: string,
): CleanupOperationQueryRecord {
  return readCleanupOperationRecord(cleanupOperationRecordPath(rootDir, operationId));
}
