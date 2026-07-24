import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  verifyNotificationQualificationFaultEvidence,
  verifyNotificationQualificationFrozenRun,
} from '../notification-import-qualification-verifier.js';
import {
  createNotificationImportQualificationReport,
  type NotificationImportQualificationInput,
} from '../notification-import-qualification.js';
import { computeGitHubWatchConfigDigestV2 } from '../watch-config-digest-v2.js';
import { parseGitHubWatchConfigV2 } from '../watch-config-v2.js';

const roots: string[] = [];
const frozenEnvironment = new Map<string, string | undefined>();

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [name, value] of frozenEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  frozenEnvironment.clear();
});

describe('notification import qualification deployment', () => {
  it('keeps the protected workflow single-run and bounded to sixty minutes', () => {
    const source = readFileSync(
      new URL(
        '../../../../.github/workflows/notification-import-qualification.yml',
        import.meta.url,
      ),
      'utf8',
    );
    const workflow = parse(source) as {
      on: {
        workflow_dispatch: {
          inputs: {
            expected_commit: { required: boolean; type: string };
          };
        };
      };
      permissions: Record<string, string>;
      concurrency: { 'cancel-in-progress': boolean };
      jobs: {
        'require-main-ref': {
          'timeout-minutes': number;
          steps: Array<{ env?: Record<string, string>; run?: string }>;
        };
        qualification: {
          environment: string;
          env: Record<string, string | boolean>;
          needs: string;
          'timeout-minutes': number;
          steps: Array<{ run?: string; uses?: string }>;
        };
      };
    };

    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(workflow.on.workflow_dispatch.inputs.expected_commit).toMatchObject({
      required: true,
      type: 'string',
    });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
    expect(workflow.jobs['require-main-ref']['timeout-minutes']).toBe(1);
    expect(workflow.jobs['require-main-ref'].steps[0]?.run).toContain('refs/heads/main');
    expect(workflow.jobs['require-main-ref'].steps[0]?.run).toContain(
      '"$EXPECTED_COMMIT" != "$GITHUB_SHA"',
    );
    expect(workflow.jobs.qualification.needs).toBe('require-main-ref');
    expect(workflow.jobs.qualification.environment).toBe('notification-canary');
    expect(workflow.jobs.qualification['timeout-minutes']).toBe(60);
    expect(workflow.jobs.qualification.env).toHaveProperty(
      'OPENSLACK_NOTIFICATION_QUALIFICATION_EXPECTED_COMMIT',
      '${{ inputs.expected_commit }}',
    );
    const serialized = JSON.stringify(workflow);
    const credentialDirFormula =
      'credential_dir="$RUNNER_TEMP/notification-qualification-credentials-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"';
    expect(serialized).toContain('timeout --signal=TERM --kill-after=30s 50m');
    expect(serialized).toContain('notification:qualification');
    expect(workflow.jobs.qualification.env).not.toHaveProperty(
      'OPENSLACK_NOTIFICATION_QUALIFICATION_CREDENTIAL_DIR',
    );
    expect(JSON.stringify(workflow.jobs.qualification.env)).not.toContain('runner.temp');
    expect(source).not.toContain('${{ runner.temp }}');
    expect(source.split(credentialDirFormula)).toHaveLength(3);
    expect(source).toContain('test ! -e "$credential_dir"');
    expect(source).toContain('test ! -e "$evidence_root"');
    expect(source).toContain('require_safe_directory');
    expect(source).toContain('realpath -e --');
    expect(source).toContain('"$evidence_root"/fault-runs/*.sha256');
    expect(serialized).not.toMatch(/336|14\s*day|sleep\s+[1-9][0-9]{3,}/iu);
    expect(serialized).not.toMatch(/id-token|contents["']?\s*:\s*write/iu);
  });

  it('binds the sealer to checkout, watch config, deployment and fault sidecars', () => {
    const source = readFileSync(
      new URL('../notification-import-qualification-verifier.ts', import.meta.url),
      'utf8',
    );

    expect(source).toContain('computeGitHubWatchConfigDigestV2');
    expect(source).toContain("requiredEnvironment('GITHUB_SHA')");
    expect(source).toContain("requiredEnvironment('GITHUB_WORKSPACE')");
    expect(source).toContain('OPENSLACK_NOTIFICATION_SERVICE_COMMIT');
    expect(source).toContain('OPENSLACK_NOTIFICATION_SERVICE_TREE');
    expect(source).toContain('OPENSLACK_NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST');
    expect(source).toContain('OPENSLACK_NOTIFICATION_CANARY_ROUTE_SLACK');
    expect(source).toContain('OPENSLACK_NOTIFICATION_CANARY_ROUTE_WEBHOOK');
    expect(source).toContain("path.replace(/\\.json$/u, '.sha256')");
  });

  it('rejects a report that is not bound to the protected checkout and route config', () => {
    const root = temporaryRoot();
    const configPath = join(root, 'github-watch.yaml');
    const digest = `sha256:${'e'.repeat(64)}` as const;
    const parsed = parseGitHubWatchConfigV2(configYaml(digest));
    expect(parsed.valid).toBe(true);
    writeFileSync(configPath, configYaml(digest), { encoding: 'utf8', mode: 0o600 });
    git(root, ['init']);
    git(root, ['add', 'github-watch.yaml']);
    git(root, [
      '-c',
      'user.name=OpenSlack Test',
      '-c',
      'user.email=openslack-test@example.invalid',
      'commit',
      '-m',
      'test: freeze qualification config',
    ]);
    const checkoutCommit = git(root, ['rev-parse', 'HEAD']);
    const checkoutTree = git(root, ['rev-parse', 'HEAD^{tree}']);
    const report = createNotificationImportQualificationReport(
      qualificationInput(
        computeGitHubWatchConfigDigestV2(parsed.config!),
        digest,
        checkoutCommit,
        checkoutTree,
      ),
    );
    setEnvironment({
      GITHUB_SHA: checkoutCommit,
      GITHUB_WORKSPACE: root,
      OPENSLACK_NOTIFICATION_QUALIFICATION_CONFIG_PATH: configPath,
      OPENSLACK_NOTIFICATION_SERVICE_COMMIT: 'c'.repeat(40),
      OPENSLACK_NOTIFICATION_SERVICE_TREE: 'd'.repeat(40),
      OPENSLACK_NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST: digest,
      OPENSLACK_NOTIFICATION_SERVICE_ORIGIN: 'https://notifications.example.test',
      OPENSLACK_NOTIFICATION_CANARY_REPO_A: 'Negentropy-Laby/openslack-notification-canary-a',
      OPENSLACK_NOTIFICATION_CANARY_REPO_B: 'Negentropy-Laby/openslack-notification-canary-b',
      OPENSLACK_NOTIFICATION_CANARY_VENDOR_SLACK: 'openslack-slack',
      OPENSLACK_NOTIFICATION_CANARY_VENDOR_WEBHOOK: 'openslack-webhook',
      OPENSLACK_NOTIFICATION_CANARY_ROUTE_SLACK: 'slack-primary',
      OPENSLACK_NOTIFICATION_CANARY_ROUTE_WEBHOOK: 'webhook-primary',
      OPENSLACK_NOTIFICATION_CANARY_ROUTING_EPOCH: '1',
    });

    expect(() => verifyNotificationQualificationFrozenRun(report)).not.toThrow();
    process.env.OPENSLACK_NOTIFICATION_SERVICE_TREE = 'f'.repeat(40);
    expect(() => verifyNotificationQualificationFrozenRun(report)).toThrow(
      'QUALIFICATION_FROZEN_IDENTITY_MISMATCH',
    );
  });

  it('requires each fault manifest to match its create-only checksum sidecar', () => {
    const root = temporaryRoot();
    const path = join(root, 'response_loss.json');
    const bytes = Buffer.from('{"status":"PASS"}\n', 'utf8');
    const digest = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(path, bytes, { mode: 0o600 });
    writeFileSync(join(root, 'response_loss.sha256'), `${digest}  response_loss.json\n`, {
      mode: 0o600,
    });

    expect(() =>
      verifyNotificationQualificationFaultEvidence(path, `sha256:${digest}`),
    ).not.toThrow();
    writeFileSync(join(root, 'response_loss.sha256'), `${'0'.repeat(64)}  response_loss.json\n`, {
      mode: 0o600,
    });
    expect(() => verifyNotificationQualificationFaultEvidence(path, `sha256:${digest}`)).toThrow(
      'QUALIFICATION_FAULT_CHECKSUM_MISMATCH',
    );
  });

  it('publishes a closed pending-external environment manifest', () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL(
          '../../../../deploy/notification-import-qualification/environment-manifest.v1.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as object;
    const schema = JSON.parse(
      readFileSync(
        new URL(
          '../../../../deploy/notification-import-qualification/environment-manifest.schema.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as object;
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);

    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...manifest, secret_value: 'forbidden' })).toBe(false);
    expect(manifest).toMatchObject({
      status: 'PENDING_EXTERNAL',
      timeout_minutes: 60,
      environment: { deployment_branch: 'main' },
      does_not_claim: expect.arrayContaining(['LIVE_VERIFIED', 'IB7_CUTOVER']),
    });
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-import-qualification-deployment-'));
  roots.push(root);
  return root;
}

function setEnvironment(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!frozenEnvironment.has(name)) frozenEnvironment.set(name, process.env[name]);
    process.env[name] = value;
  }
}

function configYaml(digest: `sha256:${string}`): string {
  return `
schema: openslack.github_watch.v2
notification_service:
  endpoint: https://notifications.example.test
  credential_ref: env:OPENSLACK_NOTIFICATION_SERVICE_KEY
  expected_deployment_digest: ${digest}
repositories:
  - owner: Negentropy-Laby
    repo: openslack-notification-canary-a
    events: [issues.opened]
    routes:
      - id: slack-primary
        sink: slack
        channel: canary
        delivery:
          backend: notification_service
          vendor_id: openslack-slack
          routing_epoch: 1
      - id: webhook-primary
        sink: webhook
        name: canary
        delivery:
          backend: notification_service
          vendor_id: openslack-webhook
          routing_epoch: 1
  - owner: Negentropy-Laby
    repo: openslack-notification-canary-b
    events: [issues.opened]
    routes:
      - id: slack-primary
        sink: slack
        channel: canary
        delivery:
          backend: notification_service
          vendor_id: openslack-slack
          routing_epoch: 1
      - id: webhook-primary
        sink: webhook
        name: canary
        delivery:
          backend: notification_service
          vendor_id: openslack-webhook
          routing_epoch: 1
`;
}

function qualificationInput(
  watchConfigDigest: `sha256:${string}`,
  deploymentDigest: `sha256:${string}`,
  openslackCommit: string,
  openslackTree: string,
): NotificationImportQualificationInput {
  const repositories = [
    'negentropy-laby/openslack-notification-canary-a',
    'negentropy-laby/openslack-notification-canary-b',
  ];
  const vendors = ['openslack-slack', 'openslack-webhook'];
  let index = 0;
  return {
    correlation_id: 'qualification-boundary-test',
    started_at: '2026-07-24T00:00:00Z',
    completed_at: '2026-07-24T00:10:00Z',
    openslack_commit: openslackCommit,
    openslack_tree: openslackTree,
    service_commit: 'c'.repeat(40),
    service_tree: 'd'.repeat(40),
    service_deployment_digest: deploymentDigest,
    watch_config_digest: watchConfigDigest,
    routes: repositories.flatMap((canonical_repository) =>
      vendors.map((vendor_id, vendorIndex) => ({
        canonical_repository,
        route_id: vendorIndex === 0 ? 'slack-primary' : 'webhook-primary',
        routing_epoch: 1,
        vendor_id,
        encoder_version:
          vendorIndex === 0
            ? ('openslack.slack_chat_post_message.v1' as const)
            : ('openslack.webhook_notification.v1' as const),
      })),
    ),
    vendor_configs: vendors.map((vendor_id, index) => ({
      vendor_id,
      config_version: index + 1,
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
    observations: repositories.flatMap((canonical_repository) =>
      (['issue', 'push'] as const).flatMap((event_kind) =>
        vendors.map((vendor_id) => {
          index += 1;
          return {
            route_record_id: index.toString(16).padStart(64, '0'),
            notification_id: `notification-${index}`,
            idempotency_key_sha256: `sha256:${index.toString(16).padStart(64, '0')}` as const,
            canonical_repository,
            event_kind,
            vendor_id,
            accepted_at: '2026-07-24T00:01:00Z',
            delivered_at: '2026-07-24T00:02:00Z',
            idempotent_replay: false as const,
            reconciliation: 'consistent' as const,
          };
        }),
      ),
    ),
    drills: [
      'openslack_restart',
      'response_loss',
      'accepted_ledger_recovery',
      'blob_queue_pre_post_boundary',
      'service_restart_pending_outbox',
      'vendor_result_commit_ambiguity',
      'http_protocol_matrix',
      'integrity_identity_permissions',
    ].map((kind, drillIndex) => ({
      kind: kind as NotificationImportQualificationInput['drills'][number]['kind'],
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
    explained_vendor_duplicates: 0,
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

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}
