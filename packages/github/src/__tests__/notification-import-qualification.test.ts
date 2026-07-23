import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NOTIFICATION_IMPORT_QUALIFICATION_REQUIRED_DRILLS,
  createNotificationImportQualificationReport,
  ensureNotificationImportQualificationReport,
  readNotificationImportQualificationReport,
  type NotificationImportQualificationInput,
} from '../notification-import-qualification.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('notification import qualification', () => {
  it('passes exactly one complete 2x2 issue/push qualification run', () => {
    const report = createNotificationImportQualificationReport(input());

    expect(report).toMatchObject({
      schema: 'openslack.notification_import_qualification_report.v1',
      status: 'PASS',
      distinct_non_replay_accepted: 8,
      repositories: [
        'negentropy-laby/openslack-notification-canary-a',
        'negentropy-laby/openslack-notification-canary-b',
      ],
      vendor_ids: ['openslack-slack', 'openslack-webhook'],
      maximum_convergence_seconds: 120,
      failed_requirements: [],
    });
    expect(report.does_not_claim).toEqual([
      'G5_CANARY_PASS',
      'LIVE_VERIFIED',
      'IB7_CUTOVER',
      'OPENSLACK_0_3_0',
      'PRODUCTION_READY',
    ]);
  });

  it('fails closed when an observation is missing or convergence exceeds ten minutes', () => {
    const missing = input();
    missing.observations.pop();
    expect(createNotificationImportQualificationReport(missing)).toMatchObject({
      status: 'FAIL',
      distinct_non_replay_accepted: 7,
      failed_requirements: expect.arrayContaining([
        'ACCEPTED_COUNT_INSUFFICIENT',
        'EVENT_MATRIX_INCOMPLETE',
      ]),
    });

    const slow = input();
    slow.observations[0]!.delivered_at = '2026-07-24T00:10:01Z';
    expect(createNotificationImportQualificationReport(slow)).toMatchObject({
      status: 'FAIL',
      maximum_convergence_seconds: 601,
      failed_requirements: expect.arrayContaining(['DELIVERY_CONVERGENCE_EXCEEDED']),
    });
  });

  it('rejects replay observations and duplicate identities instead of counting them', () => {
    const replay = input();
    (replay.observations[0] as unknown as { idempotent_replay: boolean }).idempotent_replay = true;
    expect(() => createNotificationImportQualificationReport(replay)).toThrow(TypeError);

    const duplicate = input();
    duplicate.observations[1]!.idempotency_key_sha256 =
      duplicate.observations[0]!.idempotency_key_sha256;
    expect(() => createNotificationImportQualificationReport(duplicate)).toThrow(TypeError);
  });

  it('fails a run over sixty minutes and invalid response-loss or duplicate evidence', () => {
    const invalid = input();
    invalid.completed_at = '2026-07-24T01:00:01Z';
    invalid.response_loss_replay_same_notification_id = false;
    invalid.explained_duplicates_same_key_and_body_digest = false;
    invalid.external_timeout_count = 1;

    expect(createNotificationImportQualificationReport(invalid)).toMatchObject({
      status: 'FAIL',
      failed_requirements: expect.arrayContaining([
        'RUN_DURATION_EXCEEDED',
        'RESPONSE_LOSS_REPLAY_INVALID',
        'EXPLAINED_DUPLICATE_IDENTITY_INVALID',
        'EXTERNAL_STEP_TIMED_OUT',
      ]),
    });
  });

  it('publishes a byte-stable create-only report and checksum', () => {
    const root = temporaryRoot();
    const report = createNotificationImportQualificationReport(input());
    const first = ensureNotificationImportQualificationReport(root, report);
    const second = ensureNotificationImportQualificationReport(root, report);

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, sha256: first.sha256 });
    expect(readNotificationImportQualificationReport(root)).toEqual(report);
    expect(readFileSync(first.checksumPath, 'utf8')).toBe(
      `${first.sha256.slice('sha256:'.length)}  qualification-report.json\n`,
    );
    expect(readFileSync(first.reportPath, 'utf8')).not.toMatch(
      /"(?:payload|response_body|token|credential|endpoint)"\s*:/iu,
    );

    const conflicting = createNotificationImportQualificationReport({
      ...input(),
      correlation_id: 'different-run',
    });
    expect(() => ensureNotificationImportQualificationReport(root, conflicting)).toThrow(
      'QUALIFICATION_REPORT_CONFLICT',
    );

    writeFileSync(first.checksumPath, `${'0'.repeat(64)}  qualification-report.json\n`, {
      mode: 0o600,
    });
    expect(() => readNotificationImportQualificationReport(root)).toThrow(
      'QUALIFICATION_REPORT_CONFLICT',
    );
  });

  it('keeps the JSON Schema closed and permits sealed FAIL reports', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL('../notification-import-qualification.schema.json', import.meta.url),
        'utf8',
      ),
    ) as object;
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
    const pass = createNotificationImportQualificationReport(input());
    expect(validate(pass), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...pass, payload: 'forbidden' })).toBe(false);

    const failedInput = input();
    failedInput.observations = [];
    failedInput.routes = [];
    failedInput.vendor_configs = [];
    failedInput.drills = [];
    const fail = createNotificationImportQualificationReport(failedInput);
    expect(fail.status).toBe('FAIL');
    expect(validate(fail), JSON.stringify(validate.errors)).toBe(true);
  });

  it('rejects duplicate JSON report members even when the checksum matches', () => {
    const root = temporaryRoot();
    const written = ensureNotificationImportQualificationReport(
      root,
      createNotificationImportQualificationReport(input()),
    );
    const bytes = readFileSync(written.reportPath, 'utf8').replace(
      '"status": "PASS"',
      '"status": "FAIL",\n  "status": "PASS"',
    );
    const digest = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(written.reportPath, bytes, { mode: 0o600 });
    writeFileSync(written.checksumPath, `${digest}  qualification-report.json\n`, { mode: 0o600 });

    expect(() => readNotificationImportQualificationReport(root)).toThrow(
      'QUALIFICATION_REPORT_INVALID',
    );
  });
});

function input(): NotificationImportQualificationInput {
  const repositories = [
    'negentropy-laby/openslack-notification-canary-a',
    'negentropy-laby/openslack-notification-canary-b',
  ];
  const vendors = ['openslack-slack', 'openslack-webhook'];
  let index = 0;
  return {
    correlation_id: 'qualification-2026-07-24',
    started_at: '2026-07-24T00:00:00Z',
    completed_at: '2026-07-24T00:20:00Z',
    openslack_commit: 'a'.repeat(40),
    openslack_tree: 'b'.repeat(40),
    service_commit: 'c'.repeat(40),
    service_tree: 'd'.repeat(40),
    service_deployment_digest: `sha256:${'e'.repeat(64)}`,
    watch_config_digest: `sha256:${'f'.repeat(64)}`,
    routes: repositories
      .flatMap((repository, repositoryIndex) =>
        vendors.map((vendor, vendorIndex) => ({
          canonical_repository: repository,
          route_id: vendorIndex === 0 ? 'slack-primary' : 'webhook-primary',
          routing_epoch: 1,
          vendor_id: vendor,
          encoder_version:
            vendorIndex === 0
              ? ('openslack.slack_chat_post_message.v1' as const)
              : ('openslack.webhook_notification.v1' as const),
          repositoryIndex,
        })),
      )
      .map(({ repositoryIndex: _repositoryIndex, ...route }) => route),
    vendor_configs: vendors.map((vendor_id, configIndex) => ({
      vendor_id,
      config_version: configIndex + 1,
    })),
    caller_scope: {
      principal_id: 'openslack-handoff-caller',
      capabilities: ['submit_notification'],
      vendor_ids: vendors,
    },
    auditor_scope: {
      principal_id: 'openslack-import-qualification-auditor',
      capabilities: ['read_notifications'],
      vendor_ids: vendors,
    },
    observations: repositories.flatMap((repository) =>
      (['issue', 'push'] as const).flatMap((event_kind) =>
        vendors.map((vendor_id) => {
          index += 1;
          return {
            route_record_id: index.toString(16).padStart(64, '0'),
            notification_id: `notification-${index}`,
            idempotency_key_sha256: `sha256:${index.toString(16).padStart(64, '0')}` as const,
            canonical_repository: repository,
            event_kind,
            vendor_id,
            accepted_at: '2026-07-24T00:00:00Z',
            delivered_at: '2026-07-24T00:02:00Z',
            idempotent_replay: false as const,
            reconciliation: 'consistent' as const,
          };
        }),
      ),
    ),
    drills: NOTIFICATION_IMPORT_QUALIFICATION_REQUIRED_DRILLS.map((kind, drillIndex) => ({
      kind,
      status: 'PASS' as const,
      evidence_sha256: `sha256:${(drillIndex + 100).toString(16).padStart(64, '0')}` as const,
    })),
    caller_read_ops_denied: true,
    auditor_submit_denied: true,
    final_pending: 0,
    final_dead: 0,
    final_unexplained_conflicts: 0,
    final_authority_fallbacks: 0,
    unexplained_vendor_duplicates: 0,
    explained_vendor_duplicates: 1,
    response_loss_replay_same_key: true,
    response_loss_replay_same_notification_id: true,
    response_loss_vendor_duplicates: 0,
    explained_duplicates_same_key_and_body_digest: true,
    external_timeout_count: 0,
    payload_secret_marker_findings: 0,
    receipt_reconciliation_sha256: `sha256:${'1'.repeat(64)}`,
    security_review_sha256: `sha256:${'2'.repeat(64)}`,
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-import-qualification-'));
  roots.push(root);
  return root;
}
