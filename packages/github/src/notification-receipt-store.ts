import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createNotificationRouteRecordIdV2,
  isNotificationDeploymentDigest,
  isNotificationHandoffIdempotencyKey,
  isNotificationHandoffRouteId,
  isNotificationHandoffVendorId,
  isNotificationRouteRecordId,
} from './notification-handoff-contracts.js';
import { canonicalizeRepositoryName } from './repository-event.js';
import {
  cleanupNotificationTemporary,
  ensureSecureNotificationDirectory,
  fsyncNotificationDirectory,
  isNodeError,
  temporaryNotificationPath,
  withNotificationStorageLock,
  type NotificationStorageLockOptions,
} from './notification-storage-fs.js';

export const NOTIFICATION_RECEIPT_STORE_RELATIVE_PATH = join(
  '.openslack.local',
  'daemon',
  'notification-acceptance',
);

const RECEIPT_KEYS = [
  'schema',
  'route_record_id',
  'canonical_repository',
  'route_id',
  'routing_epoch',
  'vendor_id',
  'idempotency_key',
  'notification_id',
  'remote_request_id',
  'accepted_at',
  'idempotent_replay',
  'deployment_digest',
  'watch_config_digest',
  'recorded_at',
] as const;

export interface NotificationAcceptanceReceiptV1 {
  schema: 'openslack.notification_acceptance.v1';
  route_record_id: string;
  canonical_repository: string;
  route_id: string;
  routing_epoch: number;
  vendor_id: string;
  idempotency_key: string;
  notification_id: string;
  remote_request_id: string;
  accepted_at: string;
  idempotent_replay: boolean;
  deployment_digest: `sha256:${string}`;
  watch_config_digest: `sha256:${string}`;
  recorded_at: string;
}

export type NotificationReceiptStoreErrorCode =
  | 'RECEIPT_INVALID'
  | 'RECEIPT_NOT_FOUND'
  | 'RECEIPT_CONFLICT'
  | 'RECEIPT_NON_CANONICAL'
  | 'RECEIPT_READ_RACE'
  | 'RECEIPT_PATH_UNSAFE'
  | 'RECEIPT_FILE_UNSAFE'
  | 'RECEIPT_LOCK_TIMEOUT';

export class NotificationReceiptStoreError extends Error {
  constructor(
    readonly code: NotificationReceiptStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NotificationReceiptStoreError';
  }
}

export interface NotificationReceiptStoreOptions extends NotificationStorageLockOptions {
  rootPath: string;
}

export interface NotificationReceiptEnsureResult {
  receipt: NotificationAcceptanceReceiptV1;
  path: string;
  created: boolean;
}

export function notificationReceiptStorePath(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), NOTIFICATION_RECEIPT_STORE_RELATIVE_PATH);
}

export class NotificationReceiptStore {
  readonly rootPath: string;
  private readonly lockOptions: NotificationStorageLockOptions;
  private readonly nonce: () => string;

  constructor(options: NotificationReceiptStoreOptions) {
    try {
      this.rootPath = ensureSecureNotificationDirectory(options.rootPath);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'STORAGE_PATH_UNSAFE') {
        throw receiptError('RECEIPT_PATH_UNSAFE', 'Acceptance receipt store path is unsafe.');
      }
      throw error;
    }
    this.nonce = options.nonce ?? randomUUID;
    this.lockOptions = {
      ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
      ...(options.lockStaleMs === undefined ? {} : { lockStaleMs: options.lockStaleMs }),
      nonce: this.nonce,
    };
  }

  pathFor(routeRecordId: string): string {
    if (!isNotificationRouteRecordId(routeRecordId)) {
      throw receiptError('RECEIPT_INVALID', 'Receipt route_record_id must be 64 lowercase hex.');
    }
    return join(this.rootPath, `${routeRecordId}.json`);
  }

  create(receipt: NotificationAcceptanceReceiptV1): NotificationReceiptEnsureResult {
    const canonical = validateAndOrderReceipt(receipt);
    const bytes = serializeNotificationAcceptanceReceipt(canonical);
    return this.withLock(() => this.createLocked(canonical, bytes));
  }

  read(routeRecordId: string): NotificationAcceptanceReceiptV1 {
    return this.withLock(() => this.readLocked(routeRecordId));
  }

  verify(receipt: NotificationAcceptanceReceiptV1): NotificationAcceptanceReceiptV1 {
    const expected = validateAndOrderReceipt(receipt);
    return this.withLock(() => {
      const actual = this.readLocked(expected.route_record_id);
      if (
        !Buffer.from(serializeNotificationAcceptanceReceipt(actual)).equals(
          serializeNotificationAcceptanceReceipt(expected),
        )
      ) {
        throw receiptError(
          'RECEIPT_CONFLICT',
          'Stored acceptance receipt conflicts with expected identity.',
        );
      }
      return actual;
    });
  }

  ensureFromEmbeddedReceipt(
    receipt: NotificationAcceptanceReceiptV1,
  ): NotificationReceiptEnsureResult {
    const canonical = validateAndOrderReceipt(receipt);
    const bytes = serializeNotificationAcceptanceReceipt(canonical);
    return this.withLock(() => {
      const path = this.pathFor(canonical.route_record_id);
      if (existsSync(path)) {
        const actual = this.readLocked(canonical.route_record_id);
        if (!Buffer.from(serializeNotificationAcceptanceReceipt(actual)).equals(bytes)) {
          throw receiptError(
            'RECEIPT_CONFLICT',
            'Embedded receipt conflicts with the stored receipt.',
          );
        }
        return { receipt: actual, path, created: false };
      }
      return this.createLocked(canonical, bytes);
    });
  }

  private createLocked(
    receipt: NotificationAcceptanceReceiptV1,
    bytes: Buffer,
  ): NotificationReceiptEnsureResult {
    const path = this.pathFor(receipt.route_record_id);
    if (existsSync(path)) {
      const actual = this.readLocked(receipt.route_record_id);
      if (!Buffer.from(serializeNotificationAcceptanceReceipt(actual)).equals(bytes)) {
        throw receiptError(
          'RECEIPT_CONFLICT',
          'Acceptance receipt already exists with different bytes.',
        );
      }
      return { receipt: actual, path, created: false };
    }

    const temporary = temporaryNotificationPath(this.rootPath, receipt.route_record_id, this.nonce);
    let descriptor: number | null = null;
    let created = false;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      try {
        linkSync(temporary, path);
        created = true;
        fsyncNotificationDirectory(this.rootPath);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
      const actual = this.readLocked(receipt.route_record_id);
      if (!Buffer.from(serializeNotificationAcceptanceReceipt(actual)).equals(bytes)) {
        throw receiptError(
          'RECEIPT_CONFLICT',
          'Acceptance receipt publish raced with conflicting bytes.',
        );
      }
      return { receipt: actual, path, created };
    } finally {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {
          // Best-effort descriptor cleanup; the original error remains authoritative.
        }
      }
      cleanupNotificationTemporary(temporary);
      fsyncNotificationDirectory(this.rootPath);
    }
  }

  private readLocked(routeRecordId: string): NotificationAcceptanceReceiptV1 {
    const path = this.pathFor(routeRecordId);
    if (!existsSync(path)) {
      throw receiptError('RECEIPT_NOT_FOUND', 'Acceptance receipt does not exist.');
    }
    const status = lstatSync(path, { bigint: true });
    if (status.isSymbolicLink() || !status.isFile()) {
      throw receiptError('RECEIPT_FILE_UNSAFE', 'Acceptance receipt path is not a regular file.');
    }
    if (process.platform !== 'win32' && (Number(status.mode) & 0o777) !== 0o600) {
      throw receiptError(
        'RECEIPT_FILE_UNSAFE',
        'Acceptance receipt file permissions must be 0600.',
      );
    }
    const descriptor = openSync(path, 'r');
    let bytes: Buffer;
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (!before.isFile() || before.dev !== status.dev || before.ino !== status.ino) {
        throw receiptError('RECEIPT_READ_RACE', 'Acceptance receipt changed while it was opened.');
      }
      bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      const afterPath = lstatSync(path, { bigint: true });
      if (
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        afterPath.isSymbolicLink() ||
        !afterPath.isFile() ||
        afterPath.dev !== before.dev ||
        afterPath.ino !== before.ino
      ) {
        throw receiptError('RECEIPT_READ_RACE', 'Acceptance receipt changed while it was read.');
      }
    } finally {
      closeSync(descriptor);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw receiptError('RECEIPT_INVALID', 'Acceptance receipt is not valid JSON.');
    }
    const receipt = validateAndOrderReceipt(parsed);
    if (receipt.route_record_id !== routeRecordId) {
      throw receiptError(
        'RECEIPT_CONFLICT',
        'Acceptance receipt filename does not match its identity.',
      );
    }
    if (!bytes.equals(serializeNotificationAcceptanceReceipt(receipt))) {
      throw receiptError('RECEIPT_NON_CANONICAL', 'Acceptance receipt bytes are not canonical.');
    }
    return receipt;
  }

  private withLock<T>(operation: () => T): T {
    try {
      return withNotificationStorageLock(
        this.rootPath,
        '.receipt-store.lock',
        this.lockOptions,
        operation,
      );
    } catch (error) {
      if ((error as { code?: unknown }).code === 'STORAGE_LOCK_TIMEOUT') {
        throw receiptError('RECEIPT_LOCK_TIMEOUT', 'Timed out waiting for the receipt store lock.');
      }
      if ((error as { code?: unknown }).code === 'STORAGE_PATH_UNSAFE') {
        throw receiptError('RECEIPT_PATH_UNSAFE', 'Acceptance receipt store path is unsafe.');
      }
      throw error;
    }
  }
}

export function serializeNotificationAcceptanceReceipt(
  value: NotificationAcceptanceReceiptV1,
): Buffer {
  return Buffer.from(JSON.stringify(validateAndOrderReceipt(value)), 'utf8');
}

function validateAndOrderReceipt(value: unknown): NotificationAcceptanceReceiptV1 {
  if (!isRecord(value) || !hasOnlyKeys(value, RECEIPT_KEYS)) {
    throw receiptError('RECEIPT_INVALID', 'Acceptance receipt has missing or unknown fields.');
  }
  const canonicalRepository = parseCanonicalRepository(value.canonical_repository);
  if (
    value.schema !== 'openslack.notification_acceptance.v1' ||
    !isNotificationRouteRecordId(value.route_record_id) ||
    !canonicalRepository ||
    !isNotificationHandoffRouteId(value.route_id) ||
    !Number.isSafeInteger(value.routing_epoch) ||
    (value.routing_epoch as number) <= 0 ||
    !isNotificationHandoffVendorId(value.vendor_id) ||
    !isNotificationHandoffIdempotencyKey(value.idempotency_key) ||
    !isNonEmptyString(value.notification_id) ||
    !isNonEmptyString(value.remote_request_id) ||
    value.remote_request_id.length > 128 ||
    !isTimestamp(value.accepted_at) ||
    typeof value.idempotent_replay !== 'boolean' ||
    !isNotificationDeploymentDigest(value.deployment_digest) ||
    !isNotificationDeploymentDigest(value.watch_config_digest) ||
    !isTimestamp(value.recorded_at)
  ) {
    throw receiptError('RECEIPT_INVALID', 'Acceptance receipt fields are invalid.');
  }
  if (
    createNotificationRouteRecordIdV2(canonicalRepository, value.idempotency_key) !==
    value.route_record_id
  ) {
    throw receiptError('RECEIPT_INVALID', 'Acceptance receipt route identity is inconsistent.');
  }

  return {
    schema: 'openslack.notification_acceptance.v1',
    route_record_id: value.route_record_id,
    canonical_repository: canonicalRepository,
    route_id: value.route_id,
    routing_epoch: value.routing_epoch as number,
    vendor_id: value.vendor_id,
    idempotency_key: value.idempotency_key,
    notification_id: value.notification_id,
    remote_request_id: value.remote_request_id,
    accepted_at: value.accepted_at,
    idempotent_replay: value.idempotent_replay,
    deployment_digest: value.deployment_digest,
    watch_config_digest: value.watch_config_digest,
    recorded_at: value.recorded_at,
  };
}

function parseCanonicalRepository(value: unknown): string | null {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  const parts = value.split('/');
  const repository = parts.length === 2 ? canonicalizeRepositoryName(parts[0]!, parts[1]!) : null;
  return repository?.canonicalFullName === value ? value : null;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function receiptError(
  code: NotificationReceiptStoreErrorCode,
  message: string,
): NotificationReceiptStoreError {
  return new NotificationReceiptStoreError(code, message);
}
