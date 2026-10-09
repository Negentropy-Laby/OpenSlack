import { decodeStrictJSON } from '@openslack/core';
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
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
    assertIdentifier(value[name], `request.${name}`);
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
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    fail('SYMLINK_REJECTED', 'Refusing to follow a symlink to a cleanup operation record.');
  }
  if (!stats.isFile()) {
    fail('INVALID_PATH', 'Cleanup operation record must be a regular file.');
  }
  if (stats.size > CLEANUP_OPERATION_RECORD_MAX_BYTES) {
    fail('INVALID_RECORD', 'Cleanup operation record exceeds the bounded decode limit.');
  }
  let decoded: unknown;
  try {
    decoded = decodeStrictJSON(readFileSync(path), CLEANUP_OPERATION_RECORD_MAX_BYTES);
  } catch {
    fail('INVALID_RECORD', 'Cleanup operation record is not valid bounded strict JSON.');
  }
  return assertCleanupOperationRecord(decoded);
}

/**
 * Publish the record for an execute request **before** it is sent.
 *
 * The publish is exclusive: an identical record for the same operation and
 * binding is reused, a different binding for the same operation is refused, and
 * any persistence failure is refused rather than downgraded. The file and its
 * containing directory are both fsynced so a crash cannot leave a half-written
 * record that a later query would misread as an original intent.
 */
export function saveCleanupOperationRecord(
  record: CleanupOperationQueryRecord,
  options: { rootDir: string },
): SaveCleanupOperationRecordResult {
  const validated = assertCleanupOperationRecord(record);
  const path = cleanupOperationRecordPath(options.rootDir, validated.request.operationId);
  assertNotSensitive(path);

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const bytes = encode(validated);
  let handle: number;
  try {
    // `wx` fails when the path exists, which is what makes the publish exclusive.
    handle = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      fail('PERSISTENCE_FAILED', 'Cleanup operation record could not be created.');
    }
    // Same operation: reuse only when the binding is identical.
    const existing = readCleanupOperationRecord(path);
    if (existing.requestDigest !== validated.requestDigest) {
      fail(
        'BINDING_CONFLICT',
        'A record for this operation exists with a different binding; refusing to send.',
      );
    }
    return { status: 'reused', path };
  }

  try {
    writeSync(handle, bytes);
    fsyncSync(handle);
  } catch {
    fail('PERSISTENCE_FAILED', 'Cleanup operation record could not be durably written.');
  } finally {
    closeSync(handle);
  }
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
