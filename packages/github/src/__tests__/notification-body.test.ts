import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  materializeSlackNotificationBody,
  materializeWebhookNotificationBody,
  validateNotificationBodyForHandoff,
} from '../notification-body.js';
import type { NotificationPayload } from '../notification-payload.js';

interface FinalBodyVectorFile {
  schema: string;
  vectors: Array<{
    name: string;
    payload: NotificationPayload;
    channel: string;
    idempotency_key: string;
    expected_slack_body_utf8: string;
    expected_slack_size: number;
    expected_slack_digest: `sha256:${string}`;
    expected_webhook_body_utf8: string;
    expected_webhook_size: number;
    expected_webhook_digest: `sha256:${string}`;
  }>;
  boundary_vectors: Array<{
    name: string;
    title_repeat_count: number;
    expected_size: number;
    expected_digest: `sha256:${string}`;
    valid_for_handoff: boolean;
  }>;
}

const fixtures = JSON.parse(
  readFileSync(
    new URL('../__fixtures__/notification-handoff/final-body-vectors.v1.json', import.meta.url),
    'utf8',
  ),
) as FinalBodyVectorFile;

describe('notification final-body materializers', () => {
  it('matches exact Slack bytes, metadata, Unicode, escaping and field order', () => {
    expect(fixtures.schema).toBe('openslack.notification_final_body_vectors.v1');
    for (const vector of fixtures.vectors) {
      const body = materializeSlackNotificationBody(
        vector.payload,
        vector.channel,
        vector.idempotency_key,
      );
      expect(Buffer.from(body.bytes).toString('utf8'), vector.name).toBe(
        vector.expected_slack_body_utf8,
      );
      expect(body, vector.name).toMatchObject({
        digest: vector.expected_slack_digest,
        size: vector.expected_slack_size,
        mediaType: 'application/json',
        encoderVersion: 'openslack.slack_chat_post_message.v1',
      });
      expect(vector.expected_slack_body_utf8.startsWith('{"channel":')).toBe(true);
      expect(vector.expected_slack_body_utf8.indexOf('"text":')).toBeGreaterThan(
        vector.expected_slack_body_utf8.indexOf('"channel":'),
      );
      expect(vector.expected_slack_body_utf8.indexOf('"client_msg_id":')).toBeGreaterThan(
        vector.expected_slack_body_utf8.indexOf('"text":'),
      );
    }
  });

  it('stringifies the original webhook payload with exact insertion-order bytes', () => {
    for (const vector of fixtures.vectors) {
      const body = materializeWebhookNotificationBody(vector.payload);
      expect(Buffer.from(body.bytes).toString('utf8'), vector.name).toBe(
        vector.expected_webhook_body_utf8,
      );
      expect(Buffer.from(body.bytes).toString('utf8'), vector.name).toBe(
        JSON.stringify(vector.payload),
      );
      expect(body, vector.name).toMatchObject({
        digest: vector.expected_webhook_digest,
        size: vector.expected_webhook_size,
        mediaType: 'application/json',
        encoderVersion: 'openslack.webhook_notification.v1',
      });
    }
  });

  it('accepts 262144 bytes and rejects 262145 bytes only through the handoff validator', () => {
    const fixture = fixtures.vectors[0]!;
    for (const vector of fixtures.boundary_vectors) {
      const payload = {
        ...fixture.payload,
        title: 'x'.repeat(vector.title_repeat_count),
      } as NotificationPayload;
      const body = materializeWebhookNotificationBody(payload);
      expect(body.size, vector.name).toBe(vector.expected_size);
      expect(body.digest, vector.name).toBe(vector.expected_digest);
      expect(validateNotificationBodyForHandoff(body).valid, vector.name).toBe(
        vector.valid_for_handoff,
      );
    }
  });

  it('fails closed when materialized size metadata disagrees with the bytes', () => {
    const body = materializeWebhookNotificationBody(fixtures.vectors[0]!.payload);
    expect(validateNotificationBodyForHandoff({ bytes: body.bytes, size: body.size + 1 })).toEqual({
      valid: false,
      code: 'BODY_SIZE_MISMATCH',
      size: body.size,
      maxSize: 262_144,
    });
  });
});
