/**
 * CONTRACT FREEZE: these v2 handoff contracts are not wired into the watch daemon.
 * Do not add runtime consumers before the G2/G3 gates in notification-delivery-integration.md.
 */
import { createHash } from 'node:crypto';
import { canonicalizeRepositoryName } from './repository-event.js';

export const NOTIFICATION_HANDOFF_NAMESPACE_V2 = 'openslack.watch.handoff.v2';
export const NOTIFICATION_ROUTE_RECORD_NAMESPACE_V2 = 'openslack.watch.route-record.v2';
export const NOTIFICATION_HANDOFF_ROUTE_ID_PATTERN = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const NOTIFICATION_HANDOFF_VENDOR_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
export const NOTIFICATION_HANDOFF_DEPLOYMENT_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
export const NOTIFICATION_HANDOFF_IDEMPOTENCY_KEY_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const NOTIFICATION_ROUTE_RECORD_ID_PATTERN = /^[0-9a-f]{64}$/;

export const NOTIFICATION_HANDOFF_POLICY = Object.freeze({
  maxAttempts: 25,
  deadlineMs: 24 * 60 * 60 * 1_000,
  baseRetryMs: 5_000,
  retryCapMs: 60 * 60 * 1_000,
  maxVendorBodyBytes: 262_144,
  maxResponseBodyBytes: 16 * 1_024,
  queueStateMaxBytes: 16 * 1_024 * 1_024,
  blobStoreMaxBytes: 1_024 * 1_024 * 1_024,
  blobStoreWarningRatio: 0.8,
  acceptedBlobRetentionMs: 7 * 24 * 60 * 60 * 1_000,
  terminalBlobRetentionMs: 14 * 24 * 60 * 60 * 1_000,
});

export type NotificationDeliveryBackend = 'local' | 'direct' | 'notification_service';

export type NotificationHandoffIdempotencyKey = string;
export type NotificationRouteRecordId = string;

export type HandoffRouteState =
  | 'pending'
  | 'processing'
  | 'retryable'
  | 'accepted'
  | 'rejected'
  | 'quarantined'
  | 'handoff_dead';

export type RemoteDeliveryState = 'unknown' | 'pending' | 'delivered' | 'dead';

export type HandoffTerminalReason =
  | 'attempts_exhausted'
  | 'deadline_exhausted'
  | 'deterministic_rejection'
  | 'protocol_redirect'
  | 'unexpected_client_error'
  | 'unexpected_success_status'
  | 'deployment_digest_mismatch'
  | 'idempotency_conflict'
  | 'receipt_conflict'
  | 'blob_digest_mismatch'
  | 'blob_size_mismatch'
  | 'blob_not_available';

export type NotificationBodyEncoderVersion =
  | 'openslack.slack_chat_post_message.v1'
  | 'openslack.webhook_notification.v1';

export interface MaterializedNotificationBody {
  bytes: Uint8Array;
  digest: `sha256:${string}`;
  size: number;
  mediaType: 'application/json';
  encoderVersion: NotificationBodyEncoderVersion;
}

/**
 * The state is the service outbox state. Receiving this receipt transfers handoff authority to
 * the service and maps the local route state to `accepted`.
 */
export interface AcceptedReceipt {
  requestId: string;
  notificationId: string;
  state: 'pending';
  acceptedAt: string;
  idempotentReplay: boolean;
  deploymentDigest: `sha256:${string}`;
}

export type HandoffResult =
  | { kind: 'accepted'; receipt: AcceptedReceipt }
  | { kind: 'retryable'; code: string; status?: number; retryAfterMs?: number }
  | { kind: 'rejected'; code: string; status: number }
  | { kind: 'conflict'; code: 'IDEMPOTENCY_CONFLICT'; status: 409 }
  | { kind: 'protocol_error'; retryable: boolean; code: string; status?: number };

export function isNotificationHandoffRouteId(value: unknown): value is string {
  return typeof value === 'string' && NOTIFICATION_HANDOFF_ROUTE_ID_PATTERN.test(value);
}

export function isNotificationHandoffVendorId(value: unknown): value is string {
  return typeof value === 'string' && NOTIFICATION_HANDOFF_VENDOR_ID_PATTERN.test(value);
}

export function isNotificationDeploymentDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && NOTIFICATION_HANDOFF_DEPLOYMENT_DIGEST_PATTERN.test(value);
}

export function isNotificationHandoffIdempotencyKey(
  value: unknown,
): value is NotificationHandoffIdempotencyKey {
  return typeof value === 'string' && NOTIFICATION_HANDOFF_IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function isNotificationRouteRecordId(value: unknown): value is NotificationRouteRecordId {
  return typeof value === 'string' && NOTIFICATION_ROUTE_RECORD_ID_PATTERN.test(value);
}

/**
 * Derives the immutable local route-record identity from already-canonical repository identity
 * and the persisted route key. Legacy migration passes through its copied v1 key unchanged.
 */
export function createNotificationRouteRecordIdV2(
  canonicalRepository: string,
  persistedIdempotencyKey: string,
): NotificationRouteRecordId {
  if (typeof canonicalRepository !== 'string' || canonicalRepository.includes('\0')) {
    throw new TypeError('canonical_repository must not contain NUL bytes');
  }
  const parts = canonicalRepository.split('/');
  const repository = parts.length === 2 ? canonicalizeRepositoryName(parts[0]!, parts[1]!) : null;
  if (!repository || repository.canonicalFullName !== canonicalRepository) {
    throw new TypeError('canonical_repository must be a canonical lowercase owner/repo');
  }
  if (!isNotificationHandoffIdempotencyKey(persistedIdempotencyKey)) {
    throw new TypeError('persisted_idempotency_key must match the frozen handoff key contract');
  }

  return createHash('sha256')
    .update(NOTIFICATION_ROUTE_RECORD_NAMESPACE_V2, 'utf8')
    .update('\0')
    .update(repository.canonicalFullName, 'utf8')
    .update('\0')
    .update(persistedIdempotencyKey, 'utf8')
    .digest('hex');
}

export function createNotificationHandoffKeyV2(
  eventStableKey: string,
  routeId: string,
  routingEpoch: number,
): string {
  if (typeof eventStableKey !== 'string' || !eventStableKey) {
    throw new TypeError('event_stable_key must be a non-empty string');
  }
  if (eventStableKey.includes('\0')) {
    throw new TypeError('event_stable_key must not contain NUL bytes');
  }
  if (!isNotificationHandoffRouteId(routeId)) {
    throw new TypeError('route_id must match the notification handoff v2 route ID contract');
  }
  if (!Number.isSafeInteger(routingEpoch) || routingEpoch <= 0) {
    throw new TypeError('routing_epoch must be a positive safe integer');
  }

  const digest = createHash('sha256')
    .update(NOTIFICATION_HANDOFF_NAMESPACE_V2, 'utf8')
    .update('\0')
    .update(eventStableKey, 'utf8')
    .update('\0')
    .update(routeId, 'utf8')
    .update('\0')
    .update(String(routingEpoch), 'ascii')
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
