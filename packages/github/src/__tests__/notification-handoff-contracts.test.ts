import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_HANDOFF_NAMESPACE_V2,
  NOTIFICATION_HANDOFF_POLICY,
  NOTIFICATION_ROUTE_RECORD_NAMESPACE_V2,
  createNotificationHandoffKeyV2,
  createNotificationRouteRecordIdV2,
  isNotificationDeploymentDigest,
  isNotificationHandoffIdempotencyKey,
  isNotificationHandoffRouteId,
  isNotificationHandoffVendorId,
  isNotificationRouteRecordId,
} from '../notification-handoff-contracts.js';

interface KeyVectorFile {
  schema: string;
  namespace: string;
  vectors: Array<{
    name: string;
    event_stable_key: string;
    route_id: string;
    routing_epoch: number;
    expected_key: string;
  }>;
}

interface RouteRecordIdVectorFile {
  schema: string;
  namespace: string;
  vectors: Array<{
    name: string;
    canonical_repository: string;
    persisted_idempotency_key: string;
    expected_route_record_id: string;
  }>;
}

const keyVectors = JSON.parse(
  readFileSync(
    new URL('../__fixtures__/notification-handoff/key-vectors.v1.json', import.meta.url),
    'utf8',
  ),
) as KeyVectorFile;

const routeRecordIdVectors = JSON.parse(
  readFileSync(
    new URL(
      '../__fixtures__/notification-handoff/route-record-id-vectors.v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as RouteRecordIdVectorFile;

const handoffSchema = JSON.parse(
  readFileSync(new URL('../notification-handoff-v2.schema.json', import.meta.url), 'utf8'),
) as {
  $id: string;
  $defs: {
    routeRecordId: { type: string; pattern: string };
    idempotencyKey: { type: string; pattern: string };
    acceptedEnvelope: {
      additionalProperties: boolean;
      required: string[];
      properties: {
        data: {
          additionalProperties: boolean;
          required: string[];
          properties: { state: { const: string } };
        };
      };
    };
    acceptanceLedger: {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
  };
};

const schemaValidator = new Ajv2020({ strict: false, validateFormats: false });
schemaValidator.addSchema(handoffSchema);
const validateAcceptedEnvelope = schemaValidator.getSchema(
  `${handoffSchema.$id}#/$defs/acceptedEnvelope`,
)!;
const validateAcceptanceLedger = schemaValidator.getSchema(
  `${handoffSchema.$id}#/$defs/acceptanceLedger`,
)!;

describe('notification handoff v2 contracts', () => {
  it('keeps the bounded retry and storage policy frozen', () => {
    expect(NOTIFICATION_HANDOFF_POLICY).toEqual({
      maxAttempts: 25,
      deadlineMs: 86_400_000,
      baseRetryMs: 5_000,
      retryCapMs: 3_600_000,
      maxVendorBodyBytes: 262_144,
      maxResponseBodyBytes: 16_384,
      queueStateMaxBytes: 16_777_216,
      blobStoreMaxBytes: 1_073_741_824,
      blobStoreWarningRatio: 0.8,
      acceptedBlobRetentionMs: 604_800_000,
      terminalBlobRetentionMs: 1_209_600_000,
    });
  });

  it('matches independently generated key vectors', () => {
    expect(keyVectors.schema).toBe('openslack.notification_handoff_key_vectors.v1');
    expect(keyVectors.namespace).toBe(NOTIFICATION_HANDOFF_NAMESPACE_V2);
    for (const vector of keyVectors.vectors) {
      expect(
        createNotificationHandoffKeyV2(
          vector.event_stable_key,
          vector.route_id,
          vector.routing_epoch,
        ),
        vector.name,
      ).toBe(vector.expected_key);
    }
  });

  it('matches independently generated route-record ID vectors, including copied v1 keys', () => {
    expect(routeRecordIdVectors.schema).toBe('openslack.notification_route_record_id_vectors.v1');
    expect(routeRecordIdVectors.namespace).toBe(NOTIFICATION_ROUTE_RECORD_NAMESPACE_V2);
    for (const vector of routeRecordIdVectors.vectors) {
      expect(
        createNotificationRouteRecordIdV2(
          vector.canonical_repository,
          vector.persisted_idempotency_key,
        ),
        vector.name,
      ).toBe(vector.expected_route_record_id);
      expect(isNotificationRouteRecordId(vector.expected_route_record_id), vector.name).toBe(true);
    }
  });

  it('rejects non-canonical route-record inputs rather than normalizing them', () => {
    const key = '480f3f0b-01e3-57fb-8f3a-6ffd3a16ecbe';
    expect(() => createNotificationRouteRecordIdV2('Negentropy-Laby/OpenSlack', key)).toThrow(
      'canonical lowercase owner/repo',
    );
    expect(() => createNotificationRouteRecordIdV2(' negentropy-laby/openslack', key)).toThrow(
      'canonical lowercase owner/repo',
    );
    expect(() => createNotificationRouteRecordIdV2('negentropy-laby/open\0slack', key)).toThrow(
      'must not contain NUL bytes',
    );
    expect(() => createNotificationRouteRecordIdV2('owner/team/repo', key)).toThrow(
      'canonical lowercase owner/repo',
    );
    expect(() =>
      createNotificationRouteRecordIdV2('negentropy-laby/openslack', 'legacy-free-form-key'),
    ).toThrow('frozen handoff key contract');
  });

  it('strictly validates persisted handoff keys and route-record IDs', () => {
    expect(isNotificationHandoffIdempotencyKey('480f3f0b-01e3-57fb-8f3a-6ffd3a16ecbe')).toBe(true);
    expect(isNotificationHandoffIdempotencyKey('480F3F0B-01E3-57FB-8F3A-6FFD3A16ECBE')).toBe(false);
    expect(isNotificationHandoffIdempotencyKey('480f3f0b-01e3-47fb-8f3a-6ffd3a16ecbe')).toBe(false);
    expect(isNotificationRouteRecordId('a'.repeat(64))).toBe(true);
    expect(isNotificationRouteRecordId('A'.repeat(64))).toBe(false);
    expect(isNotificationRouteRecordId('a'.repeat(63))).toBe(false);
  });

  it('rejects embedded NUL bytes before constructing the delimited preimage', () => {
    expect(() => createNotificationHandoffKeyV2('stable\0suffix', 'slack-primary', 1)).toThrow(
      'event_stable_key must not contain NUL bytes',
    );
  });

  it.each(['a', 'slack-primary', 'a1', `a${'-b'.repeat(31)}c`])(
    'accepts canonical route id %s',
    (routeId) => expect(isNotificationHandoffRouteId(routeId)).toBe(true),
  );

  it.each(['', 'Uppercase', '-leading', 'trailing-', 'space route', `a${'b'.repeat(64)}`])(
    'rejects non-canonical route id %s',
    (routeId) => expect(isNotificationHandoffRouteId(routeId)).toBe(false),
  );

  it('rejects invalid key inputs', () => {
    expect(() => createNotificationHandoffKeyV2('', 'slack-primary', 1)).toThrow(
      'event_stable_key',
    );
    expect(() => createNotificationHandoffKeyV2('stable', 'Slack', 1)).toThrow('route_id');
    expect(() => createNotificationHandoffKeyV2('stable', 'slack', 0)).toThrow('routing_epoch');
    expect(() =>
      createNotificationHandoffKeyV2('stable', 'slack', Number.MAX_SAFE_INTEGER + 1),
    ).toThrow('routing_epoch');
  });

  it('validates vendor IDs and deployment digests without accepting display variants', () => {
    expect(isNotificationHandoffVendorId('openslack-slack')).toBe(true);
    expect(isNotificationHandoffVendorId('OpenSlack-Slack')).toBe(false);
    expect(isNotificationDeploymentDigest(`sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isNotificationDeploymentDigest(`SHA256:${'a'.repeat(64)}`)).toBe(false);
    expect(isNotificationDeploymentDigest(`sha256:${'g'.repeat(64)}`)).toBe(false);
  });

  it('freezes strict accepted-envelope and local-ledger schemas', () => {
    expect(handoffSchema.$defs.routeRecordId).toEqual({
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
    });
    expect(handoffSchema.$defs.idempotencyKey.pattern).toBe(
      '^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',
    );
    const envelope = handoffSchema.$defs.acceptedEnvelope;
    expect(envelope.additionalProperties).toBe(false);
    expect(envelope.required).toEqual(['request_id', 'data']);
    expect(envelope.properties.data.additionalProperties).toBe(false);
    expect(envelope.properties.data.required).toEqual([
      'notification_id',
      'state',
      'accepted_at',
      'idempotent_replay',
    ]);
    expect(envelope.properties.data.properties.state.const).toBe('pending');

    const ledger = handoffSchema.$defs.acceptanceLedger;
    expect(ledger.additionalProperties).toBe(false);
    expect(ledger.required).toContain('deployment_digest');
    expect(ledger.required).toContain('watch_config_digest');
    expect(ledger.properties).not.toHaveProperty('payload');
    expect(ledger.properties).not.toHaveProperty('payload_base64');
    expect(ledger.properties).not.toHaveProperty('credential');
  });

  it('validates accepted envelopes and ledgers while rejecting unknown fields', () => {
    const acceptedEnvelope = {
      request_id: 'request-1',
      data: {
        notification_id: 'notification-1',
        state: 'pending',
        accepted_at: '2026-07-22T12:00:00Z',
        idempotent_replay: false,
      },
    };
    expect(validateAcceptedEnvelope(acceptedEnvelope)).toBe(true);
    expect(validateAcceptedEnvelope({ ...acceptedEnvelope, response_body: '{}' })).toBe(false);

    const ledger = {
      schema: 'openslack.notification_acceptance.v1',
      route_record_id: routeRecordIdVectors.vectors[0]!.expected_route_record_id,
      canonical_repository: 'negentropy-laby/openslack',
      route_id: 'slack-primary',
      routing_epoch: 1,
      vendor_id: 'openslack-slack',
      idempotency_key: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
      notification_id: 'notification-1',
      remote_request_id: 'request-1',
      accepted_at: '2026-07-22T12:00:00Z',
      idempotent_replay: false,
      deployment_digest: `sha256:${'a'.repeat(64)}`,
      watch_config_digest: `sha256:${'b'.repeat(64)}`,
      recorded_at: '2026-07-22T12:00:01Z',
    };
    expect(validateAcceptanceLedger(ledger)).toBe(true);
    expect(validateAcceptanceLedger({ ...ledger, payload: 'forbidden' })).toBe(false);
    expect(validateAcceptanceLedger({ ...ledger, route_record_id: 'route-record-1' })).toBe(false);
  });
});
