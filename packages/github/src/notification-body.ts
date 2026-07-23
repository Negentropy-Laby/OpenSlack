/** Pure final-vendor-body materializers shared by direct and service delivery. */
import { createHash } from 'node:crypto';
import {
  NOTIFICATION_HANDOFF_POLICY,
  type MaterializedNotificationBody,
  type NotificationBodyEncoderVersion,
} from './notification-handoff-contracts.js';
import { formatNotification, type NotificationPayload } from './notification-payload.js';

export type NotificationBodyHandoffValidation =
  | { valid: true; size: number }
  | {
      valid: false;
      code: 'BODY_SIZE_MISMATCH' | 'BODY_TOO_LARGE';
      size: number;
      maxSize: number;
    };

export function materializeSlackNotificationBody(
  payload: NotificationPayload,
  channel: string,
  idempotencyKey: string,
): MaterializedNotificationBody {
  const bytes = Buffer.from(
    JSON.stringify({
      channel,
      text: formatNotification(payload),
      client_msg_id: idempotencyKey,
    }),
    'utf8',
  );
  return materializedBody(bytes, 'openslack.slack_chat_post_message.v1');
}

export function materializeWebhookNotificationBody(
  notificationPayload: NotificationPayload,
): MaterializedNotificationBody {
  // The original object is stringified directly. Do not clone, spread, canonicalize or reparse it:
  // insertion order is part of the v1 encoder contract.
  const bytes = Buffer.from(JSON.stringify(notificationPayload), 'utf8');
  return materializedBody(bytes, 'openslack.webhook_notification.v1');
}

/** Handoff/Blob admission check. Direct sinks deliberately do not call this validator. */
export function validateNotificationBodyForHandoff(
  body: Pick<MaterializedNotificationBody, 'bytes' | 'size'>,
): NotificationBodyHandoffValidation {
  const actualSize = body.bytes.byteLength;
  if (body.size !== actualSize) {
    return {
      valid: false,
      code: 'BODY_SIZE_MISMATCH',
      size: actualSize,
      maxSize: NOTIFICATION_HANDOFF_POLICY.maxVendorBodyBytes,
    };
  }
  if (actualSize > NOTIFICATION_HANDOFF_POLICY.maxVendorBodyBytes) {
    return {
      valid: false,
      code: 'BODY_TOO_LARGE',
      size: actualSize,
      maxSize: NOTIFICATION_HANDOFF_POLICY.maxVendorBodyBytes,
    };
  }
  return { valid: true, size: actualSize };
}

function materializedBody(
  bytes: Buffer,
  encoderVersion: NotificationBodyEncoderVersion,
): MaterializedNotificationBody {
  return {
    bytes,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.byteLength,
    mediaType: 'application/json',
    encoderVersion,
  };
}
