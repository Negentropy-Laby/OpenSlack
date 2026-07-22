import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { GITHUB_WATCH_EVENT_KEYS } from '../repository-event.js';
import { parseGitHubWatchConfig } from '../watch-config.js';
import { parseGitHubWatchConfigV2 } from '../watch-config-v2.js';

const watchV2Schema = JSON.parse(
  readFileSync(new URL('../github-watch-v2.schema.json', import.meta.url), 'utf8'),
) as {
  additionalProperties: boolean;
  required: string[];
  $defs: {
    routeRecordId: {
      description: string;
      type: string;
      readOnly: boolean;
      pattern: string;
    };
    repository: {
      properties: { events: { items: { enum: string[] } } };
    };
  };
};

const validateWatchV2Schema = new Ajv2020({ strict: false, validateFormats: false }).compile(
  watchV2Schema,
);

const validConfig = `
schema: openslack.github_watch.v2
notification_service:
  endpoint: https://notification.internal
  credential_ref: keychain:openslack/notification-service
  expected_deployment_digest: sha256:${'a'.repeat(64)}
repositories:
  - owner: Negentropy-Laby
    repo: OpenSlack
    events: [issues.opened, push]
    labels:
      include: [openslack:task]
    routes:
      - id: console-local
        sink: console
        delivery:
          backend: local
          routing_epoch: 1
      - id: slack-primary
        sink: slack
        channel: C123
        delivery:
          backend: notification_service
          vendor_id: openslack-slack
          routing_epoch: 1
      - id: webhook-primary
        sink: webhook
        name: canary
        delivery:
          backend: direct
          routing_epoch: 1
    auto_claim:
      enabled: false
      agent_ids: [openai_developer_ci-bot]
`;

describe('GitHub watch v2 config contract', () => {
  it('keeps the JSON schema and runtime event registries aligned', () => {
    expect(watchV2Schema.$defs.repository.properties.events.items.enum).toEqual(
      GITHUB_WATCH_EVENT_KEYS,
    );
  });

  it('declares a strict-shape JSON Schema 2020-12 contract', () => {
    expect(watchV2Schema.additionalProperties).toBe(false);
    expect(watchV2Schema.required).toEqual(['schema', 'repositories']);
    expect(watchV2Schema.$defs.routeRecordId).toMatchObject({
      type: 'string',
      readOnly: true,
      pattern: '^[0-9a-f]{64}$',
    });
    expect(watchV2Schema.$defs.routeRecordId.description).toContain(
      'never accepted in watch config',
    );
  });

  it('parses and normalizes a valid v2 config without changing the v1 parser', () => {
    const result = parseGitHubWatchConfigV2(validConfig);
    expect(result).toEqual({
      valid: true,
      config: {
        schema: 'openslack.github_watch.v2',
        notification_service: {
          endpoint: 'https://notification.internal',
          credential_ref: 'keychain:openslack/notification-service',
          expected_deployment_digest: `sha256:${'a'.repeat(64)}`,
        },
        repositories: [
          {
            owner: 'Negentropy-Laby',
            repo: 'OpenSlack',
            events: ['issues.opened', 'push'],
            labels: { include: ['openslack:task'] },
            routes: [
              {
                id: 'console-local',
                sink: 'console',
                delivery: { backend: 'local', routing_epoch: 1 },
              },
              {
                id: 'slack-primary',
                sink: 'slack',
                channel: 'C123',
                delivery: {
                  backend: 'notification_service',
                  routing_epoch: 1,
                  vendor_id: 'openslack-slack',
                },
              },
              {
                id: 'webhook-primary',
                sink: 'webhook',
                name: 'canary',
                delivery: { backend: 'direct', routing_epoch: 1 },
              },
            ],
            auto_claim: { enabled: false, agent_ids: ['openai_developer_ci-bot'] },
          },
        ],
      },
      errors: [],
    });
    expect(validateWatchV2Schema(result.config)).toBe(true);

    expect(
      parseGitHubWatchConfig(`
schema: openslack.github_watch.v1
repositories:
  - owner: Negentropy-Laby
    repo: OpenSlack
    events: [issues.opened]
`),
    ).toMatchObject({ valid: true, config: { schema: 'openslack.github_watch.v1' } });
  });

  it('requires explicit unique route IDs and positive safe routing epochs', () => {
    const result = parseGitHubWatchConfigV2(
      validConfig
        .replace('id: webhook-primary', 'id: slack-primary')
        .replace(
          'routing_epoch: 1\n      - id: slack-primary',
          'routing_epoch: 0\n      - id: slack-primary',
        ),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('positive safe integer'))).toBe(true);
    expect(result.errors.some((error) => error.includes('duplicates route ID'))).toBe(true);
  });

  it('requires service routes to use a canonical vendor and root service config', () => {
    const withoutService = validConfig.replace(/notification_service:\n(?: {2}.*\n){3}/, '');
    const missing = parseGitHubWatchConfigV2(withoutService);
    expect(missing.valid).toBe(false);
    expect(missing.errors).toContain(
      'notification_service is required when any route uses notification_service',
    );
    const missingSchemaInput = structuredClone(parseGitHubWatchConfigV2(validConfig).config!);
    delete missingSchemaInput.notification_service;
    expect(validateWatchV2Schema(missingSchemaInput)).toBe(false);

    const invalidVendor = parseGitHubWatchConfigV2(
      validConfig.replace('vendor_id: openslack-slack', 'vendor_id: OpenSlack/Slack'),
    );
    expect(invalidVendor.valid).toBe(false);
    expect(invalidVendor.errors.some((error) => error.includes('^[a-z0-9-]'))).toBe(true);
  });

  it('enforces sink/backend ownership combinations', () => {
    const consoleDirect = parseGitHubWatchConfigV2(
      validConfig.replace('backend: local', 'backend: direct'),
    );
    expect(consoleDirect.valid).toBe(false);
    expect(
      consoleDirect.errors.some((error) => error.includes('console routes must use backend local')),
    ).toBe(true);

    const slackLocal = parseGitHubWatchConfigV2(
      validConfig.replace('backend: notification_service', 'backend: local'),
    );
    expect(slackLocal.valid).toBe(false);
    expect(
      slackLocal.errors.some((error) => error.includes('external routes cannot use backend local')),
    ).toBe(true);

    const schemaInput = structuredClone(parseGitHubWatchConfigV2(validConfig).config!);
    schemaInput.repositories[0]!.routes![1]!.delivery.backend = 'local';
    delete schemaInput.repositories[0]!.routes![1]!.delivery.vendor_id;
    expect(validateWatchV2Schema(schemaInput)).toBe(false);
  });

  it('accepts HTTP only for an explicitly allowed loopback development origin', () => {
    const rejected = parseGitHubWatchConfigV2(
      validConfig.replace('https://notification.internal', 'http://notification.internal'),
    );
    expect(rejected.valid).toBe(false);
    expect(rejected.errors.some((error) => error.includes('HTTPS origin'))).toBe(true);
    const rejectedSchemaInput = structuredClone(parseGitHubWatchConfigV2(validConfig).config!);
    rejectedSchemaInput.notification_service!.endpoint = 'http://notification.internal';
    expect(validateWatchV2Schema(rejectedSchemaInput)).toBe(false);

    const accepted = parseGitHubWatchConfigV2(
      validConfig
        .replace('https://notification.internal', 'http://127.0.0.1:8080')
        .replace(
          'expected_deployment_digest:',
          'allow_insecure_loopback: true\n  expected_deployment_digest:',
        ),
    );
    expect(accepted.valid).toBe(true);
    expect(accepted.config?.notification_service?.endpoint).toBe('http://127.0.0.1:8080');
    expect(validateWatchV2Schema(accepted.config)).toBe(true);
  });

  it.each([
    ['endpoint path', 'https://notification.internal/v1'],
    ['endpoint query', 'https://notification.internal?secret=value'],
    ['endpoint userinfo', 'https://user@notification.internal'],
  ])('rejects %s', (_name, endpoint) => {
    const result = parseGitHubWatchConfigV2(
      validConfig.replace('https://notification.internal', endpoint),
    );
    expect(result.valid).toBe(false);
  });

  it('rejects raw credentials, unknown properties and v1 input', () => {
    const rawCredential = parseGitHubWatchConfigV2(
      validConfig.replace('keychain:openslack/notification-service', 'this-is-a-raw-secret-value'),
    );
    expect(rawCredential.valid).toBe(false);
    expect(rawCredential.errors.some((error) => error.includes('env: or keychain:'))).toBe(true);

    const unknown = parseGitHubWatchConfigV2(
      validConfig.replace('repositories:', 'extra: true\nrepositories:'),
    );
    expect(unknown.valid).toBe(false);
    expect(unknown.errors).toContain('config: unknown property "extra"');

    const v1 = parseGitHubWatchConfigV2(
      validConfig.replace('openslack.github_watch.v2', 'openslack.github_watch.v1'),
    );
    expect(v1.valid).toBe(false);
    expect(v1.errors[0]).toContain('Invalid schema');
  });
});
