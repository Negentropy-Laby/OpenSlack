import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

type ReceiptArtifact = {
  role?: string;
  path: string;
  sha256: string;
};

type ProductizationRecord = {
  phase: string;
  pull_request: number;
  scope: string;
  base_commit: string;
  head_commit: string;
  head_tree: string;
  merge_commit: string;
  merge_tree: string;
  merge_parents: string[];
  merge_tree_equals_head_tree: boolean;
  changed_paths: {
    comparison: string;
    count: number;
    digest: string;
    algorithm: string;
  };
  hosted_validation: {
    mode: 'EXACT_HEAD' | 'SYNTHETIC_MERGE_TREE_EQUAL_CONTENT';
    governed_head: string;
    execution_commit: string;
    execution_parents?: string[];
    validated_content_tree: string;
    literal_head_execution: boolean;
    check_name: string;
    conclusion: string;
    run_id: number;
    job_id: number;
    details_url: string;
  };
};

type PhaseFReceipt = {
  [key: string]: unknown;
  $schema: string;
  schema: string;
  receipt_id: string;
  recorded_at: string;
  gate: {
    name: string;
    status: string;
    closed: boolean;
    effectivity: string;
    canonical_base: string;
    px2_exit: string;
  };
  repository_base: {
    role: string;
    commit: string;
    tree: string;
    canonical_branch: string;
    service_subtree: string;
  };
  predecessor_manifest: {
    path: string;
    sha256: string;
    phase_f_binding: {
      status: string;
      path_base: string;
      expected_path: string;
    };
    fulfillment: {
      receipt_path: string;
      resolution: string;
    };
  };
  source_history: {
    review_baseline: { commit: string; ancestor_of_frozen_source: boolean };
    archive_tag: {
      name: string;
      object: string;
      object_type: string;
      target_commit: string;
    };
    frozen_source: {
      repository: string;
      commit: string;
      tree: string;
      reachable_commit_count: number;
    };
  };
  authorization: {
    scope: string;
    decision: string;
    owner: string;
    provenance: {
      kind: string;
      governed_summary_url: string;
      governed_summary_merge_commit: string;
    };
    bound_envelope: {
      openslack_base_commit: string;
      openslack_base_tree: string;
      archive_tag: string;
      archive_tag_object: string;
      source_commit: string;
      source_tree: string;
      source_reachable_commit_count: number;
      import_path: string;
      readiness_report_sha256: string;
      tag_immutability_exception: string;
    };
  };
  import_binding: {
    pure_import: { commit: string; tree: string; parents: string[] };
    openslack_merge: { commit: string; tree: string; parents: string[] };
    target_repository: string;
    target_path: string;
    imported_subtree: string;
    pure_import_tree_equals_readiness_candidate: boolean;
    openslack_merge_tree_equals_pure_import_tree: boolean;
    imported_subtree_equals_frozen_source_tree: boolean;
  };
  productization_chain: ProductizationRecord[];
  final_state: {
    service: {
      path: string;
      go_module: string;
      subtree: string;
      workspace_manifest_entries: number;
    };
    artifacts: ReceiptArtifact[];
  };
  registry_state: {
    modules: ReceiptArtifact;
    generated_status: ReceiptArtifact;
    absent_component_ids: string[];
    notification_delivery_component_absent: boolean;
    registry_relocation: { status: string; next: string };
  };
  pending_external: {
    status: string;
    artifacts: ReceiptArtifact[];
  };
  review: {
    scope: string;
    independent_blockers: number;
    receipt_pr_included: boolean;
  };
  scope: {
    authorizes: string[];
    not_claimed: string[];
  };
  self_reference_policy: {
    receipt_path: string;
    contains_own_sha256: boolean;
    contains_receipt_pr_head: boolean;
    contains_receipt_pr_approval_or_check_ids: boolean;
    contains_receipt_merge_commit: boolean;
    external_bindings: string[];
  };
};

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
      name: string;
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
          name: string;
          'timeout-minutes': number;
          steps: Array<{
            env?: Record<string, string>;
            name?: string;
            run?: string;
            uses?: string;
            with?: Record<string, string | boolean>;
          }>;
        };
        qualification: {
          environment: string;
          env: Record<string, string | boolean>;
          name: string;
          needs: string;
          'timeout-minutes': number;
          steps: Array<{
            name?: string;
            run?: string;
            uses?: string;
            with?: Record<string, string | boolean>;
          }>;
        };
      };
    };

    expect(workflow.name).toBe('Notification Post-Import Qualification');
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
    expect(workflow.jobs['require-main-ref'].name).toContain('post-import qualification');
    const hostedCheckoutIndex = workflow.jobs['require-main-ref'].steps.findIndex(
      (step) => step.uses === 'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    );
    const hostedGuardIndex = workflow.jobs['require-main-ref'].steps.findIndex(
      (step) => step.name === 'Require the imported service and governed IB6 receipt',
    );
    expect(hostedCheckoutIndex).toBeGreaterThan(0);
    expect(hostedGuardIndex).toBe(hostedCheckoutIndex + 1);
    expect(workflow.jobs['require-main-ref'].steps[hostedCheckoutIndex]?.with).toEqual({
      ref: '${{ inputs.expected_commit }}',
      'persist-credentials': false,
    });
    const hostedGuard = workflow.jobs['require-main-ref'].steps[hostedGuardIndex]?.run ?? '';
    expect(hostedGuard).toContain("rev-parse --verify 'HEAD^{commit}'");
    expect(hostedGuard).toContain('test "$checkout_commit" = "$GITHUB_SHA"');
    expect(hostedGuard).toContain('test "$checkout_commit" = "$EXPECTED_COMMIT"');
    expect(hostedGuard).toContain('"${checkout_commit}:services/notification-delivery"');
    expect(hostedGuard).toContain('"${checkout_commit}:integration/gates/ib6-history-import.json"');
    expect(hostedGuard).toMatch(
      /"\$\{checkout_commit\}:services\/notification-delivery"\s+\)" = "tree"/u,
    );
    expect(hostedGuard).toMatch(
      /"\$\{checkout_commit\}:integration\/gates\/ib6-history-import\.json"\s+\)" = "blob"/u,
    );
    expect(hostedGuard).toContain('test -d "$GITHUB_WORKSPACE/services/notification-delivery"');
    expect(hostedGuard).toContain(
      'test -f "$GITHUB_WORKSPACE/integration/gates/ib6-history-import.json"',
    );
    expect(hostedGuard).toContain('test ! -L "$GITHUB_WORKSPACE/services/notification-delivery"');
    expect(hostedGuard).toContain(
      'test ! -L "$GITHUB_WORKSPACE/integration/gates/ib6-history-import.json"',
    );
    expect(workflow.jobs.qualification.needs).toBe('require-main-ref');
    expect(workflow.jobs.qualification.name).toBe('Run protected G5 post-import qualification');
    expect(workflow.jobs.qualification.environment).toBe('notification-canary');
    expect(workflow.jobs.qualification['timeout-minutes']).toBe(60);
    expect(workflow.jobs.qualification.env).toHaveProperty(
      'OPENSLACK_NOTIFICATION_QUALIFICATION_EXPECTED_COMMIT',
      '${{ inputs.expected_commit }}',
    );
    const protectedCheckoutIndex = workflow.jobs.qualification.steps.findIndex(
      (step) => step.uses === 'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd',
    );
    const protectedGuardIndex = workflow.jobs.qualification.steps.findIndex(
      (step) => step.name === 'Reconfirm the imported service and governed IB6 receipt',
    );
    const protectedInputGuardIndex = workflow.jobs.qualification.steps.findIndex(
      (step) => step.name === 'Require the expected main commit and complete deployment inputs',
    );
    const protectedSetupIndex = workflow.jobs.qualification.steps.findIndex(
      (step) => step.uses === 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6',
    );
    const protectedCredentialIndex = workflow.jobs.qualification.steps.findIndex(
      (step) => step.name === 'Materialize run-scoped credentials',
    );
    expect(protectedCheckoutIndex).toBe(0);
    expect(protectedGuardIndex).toBe(1);
    expect(protectedGuardIndex).toBeLessThan(protectedSetupIndex);
    expect(protectedGuardIndex).toBeLessThan(protectedInputGuardIndex);
    expect(protectedGuardIndex).toBeLessThan(protectedCredentialIndex);
    expect(workflow.jobs.qualification.steps[protectedCheckoutIndex]?.with).toEqual({
      ref: '${{ inputs.expected_commit }}',
      'persist-credentials': false,
    });
    const protectedGuard = workflow.jobs.qualification.steps[protectedGuardIndex]?.run ?? '';
    expect(protectedGuard).toContain("rev-parse --verify 'HEAD^{commit}'");
    expect(protectedGuard).toContain('test "$checkout_commit" = "$GITHUB_SHA"');
    expect(protectedGuard).toContain('"$OPENSLACK_NOTIFICATION_QUALIFICATION_EXPECTED_COMMIT"');
    expect(protectedGuard).toContain('"${checkout_commit}:services/notification-delivery"');
    expect(protectedGuard).toContain(
      '"${checkout_commit}:integration/gates/ib6-history-import.json"',
    );
    expect(protectedGuard).toMatch(
      /"\$\{checkout_commit\}:services\/notification-delivery"\s+\)" = "tree"/u,
    );
    expect(protectedGuard).toMatch(
      /"\$\{checkout_commit\}:integration\/gates\/ib6-history-import\.json"\s+\)" = "blob"/u,
    );
    expect(protectedGuard).toContain('test -d "$GITHUB_WORKSPACE/services/notification-delivery"');
    expect(protectedGuard).toContain(
      'test -f "$GITHUB_WORKSPACE/integration/gates/ib6-history-import.json"',
    );
    expect(protectedGuard).toContain(
      'test ! -L "$GITHUB_WORKSPACE/services/notification-delivery"',
    );
    expect(protectedGuard).toContain(
      'test ! -L "$GITHUB_WORKSPACE/integration/gates/ib6-history-import.json"',
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
    expect(source).not.toContain('Run protected IB6 import qualification');
    expect(source).not.toContain('IB6_HISTORY_IMPORT_ONLY');
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

  it('preserves the closed historical v1 pending-external environment manifest', () => {
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
      gate: 'G5-IMPORT-QUALIFICATION',
      scope: 'IB6_HISTORY_IMPORT_ONLY',
      environment: { deployment_branch: 'main' },
      does_not_claim: expect.arrayContaining(['LIVE_VERIFIED', 'IB7_CUTOVER']),
    });
  });

  it('publishes a closed post-import v2 manifest without premature authorization', () => {
    type Manifest = {
      [key: string]: unknown;
      does_not_claim: string[];
      environment: Record<string, unknown>;
      pending_variables: string[];
      repositories: Array<Record<string, unknown>>;
      required_secrets: string[];
    };
    const manifest = readRepositoryJson(
      'deploy/notification-import-qualification/environment-manifest.v2.json',
    ) as Manifest;
    const schema = readRepositoryJson(
      'deploy/notification-import-qualification/environment-manifest.v2.schema.json',
    );
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);

    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...manifest, authorizes: ['IB7_CUTOVER'] })).toBe(false);
    expect(
      validate({
        ...manifest,
        environment: { ...manifest.environment, secret_value: 'forbidden' },
      }),
    ).toBe(false);
    expect(
      validate({
        ...manifest,
        repositories: [manifest.repositories[0], manifest.repositories[0]],
      }),
    ).toBe(false);
    expect(
      validate({
        ...manifest,
        pending_variables: manifest.pending_variables.slice(0, -1),
      }),
    ).toBe(false);
    expect(
      validate({
        ...manifest,
        required_secrets: [...manifest.required_secrets].reverse(),
      }),
    ).toBe(false);
    expect(
      validate({
        ...manifest,
        does_not_claim: manifest.does_not_claim.filter((claim) => claim !== 'IB7_CUTOVER'),
      }),
    ).toBe(false);
    expect(validate({ ...manifest, gate: 'G5-IMPORT-QUALIFICATION' })).toBe(false);
    expect(validate({ ...manifest, scope: 'IB6_HISTORY_IMPORT_ONLY' })).toBe(false);
    expect(validate({ ...manifest, status: 'PASS' })).toBe(false);
    expect(manifest).toMatchObject({
      schema: 'openslack.notification_import_qualification_environment_manifest.v2',
      status: 'PENDING_EXTERNAL',
      gate: 'G5-POST-IMPORT-QUALIFICATION',
      scope: 'IB7_EVALUATION_ONLY',
      prerequisite_gates: [
        'G3-QUEUE',
        'IB6-HISTORY-IMPORT',
        'IB6-MERGE-TRAIN/PX2-EXIT',
        'OPENSLACK-V0.2.0-IMMUTABLE-RELEASE',
        'G4-E2E',
      ],
      external_inputs_after: 'IB6-MERGE-TRAIN/PX2-EXIT',
      repository_preflight: {
        required_ref: 'refs/heads/main',
        checkout_ref_source: 'expected_commit',
        checkout_persist_credentials: false,
        required_directory: 'services/notification-delivery',
        required_receipt: 'integration/gates/ib6-history-import.json',
      },
      does_not_claim: expect.arrayContaining([
        'G5_POST_IMPORT_QUALIFICATION_PASS',
        'IB7_CUTOVER',
        'LIVE_VERIFIED',
      ]),
    });
    expect(Object.hasOwn(manifest, 'authorizes')).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain('"authorizes"');
  });

  it('validates the append-only order decision and its historical byte bindings', () => {
    type OrderDecision = {
      [key: string]: unknown;
      historical_bindings: Array<{
        path: string;
        role: string;
        sha256: string;
      }>;
      scope: {
        authorizes: string[];
        does_not_authorize: string[];
      };
      supersedes: {
        preserved_gate: { executed: boolean; gate: string; status: string };
        superseded_role: { executed: boolean; gate: string; role: string; status: string };
      };
    };
    const historicalDecisionBytes = readRepositoryBytes(
      'integration/gates/g5-import-qualification-supersession.json',
    );
    const historicalDecision = JSON.parse(historicalDecisionBytes.toString('utf8')) as object;
    const historicalSchema = readRepositoryJson(
      'docs/integration/notification-delivery-gate-supersession.v1.schema.json',
    );
    const validateHistorical = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(historicalSchema);
    expect(validateHistorical(historicalDecision), JSON.stringify(validateHistorical.errors)).toBe(
      true,
    );
    expect(historicalDecision).toMatchObject({
      superseded_gate: {
        gate: 'G5-CANARY',
        status: 'SUPERSEDED_NOT_RUN',
        executed: false,
      },
      replacement_gate: {
        gate: 'G5-IMPORT-QUALIFICATION',
        status: 'ACTIVE_PENDING_EXECUTION',
      },
      scope: { authorizes: ['IB6_HISTORY_IMPORT_ONLY'] },
    });

    const decision = readRepositoryJson(
      'integration/gates/ib6-repository-import-order-supersession.json',
    ) as OrderDecision;
    const schema = readRepositoryJson(
      'docs/integration/notification-delivery-ib6-order-supersession.v1.schema.json',
    );
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
    expect(validate(decision), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...decision, premature_authorization: true })).toBe(false);
    expect(
      validate({
        ...decision,
        scope: { ...decision.scope, authorizes: ['IB6_HISTORY_IMPORT_ONLY'] },
      }),
    ).toBe(false);

    for (const binding of decision.historical_bindings) {
      const digest = `sha256:${createHash('sha256')
        .update(readRepositoryBytes(binding.path))
        .digest('hex')}`;
      expect(digest, `STOP: HISTORICAL_GATE_BYTES_DRIFT: ${binding.path}`).toBe(binding.sha256);
    }

    expect(decision.historical_bindings).toEqual([
      {
        role: 'PRIOR_DECISION',
        path: 'integration/gates/g5-import-qualification-supersession.json',
        sha256: 'sha256:2d1ee8da4bf3433732384bc1b70afd264b3455c9c8a0764e7c16b24f65ba54d6',
      },
      {
        role: 'PRIOR_DECISION_SCHEMA',
        path: 'docs/integration/notification-delivery-gate-supersession.v1.schema.json',
        sha256: 'sha256:23e756e1160a569c145b8dd38059089b7607727532ca21f7faa97c68ca95940c',
      },
      {
        role: 'PRIOR_AMENDMENT',
        path: 'docs/integration/notification-delivery-pre-ib6-gate-amendment.md',
        sha256: 'sha256:d36e0d0303303c07e6ed7b057294605d44577aec4d5595f10c97f013d597f154',
      },
      {
        role: 'PRIOR_ENVIRONMENT_MANIFEST',
        path: 'deploy/notification-import-qualification/environment-manifest.v1.json',
        sha256: 'sha256:818851072f5d9705242ba2825fe47afc2ce4d937b22e22141a76d62db7d8b760',
      },
      {
        role: 'PRIOR_ENVIRONMENT_MANIFEST_SCHEMA',
        path: 'deploy/notification-import-qualification/environment-manifest.schema.json',
        sha256: 'sha256:c8b53ff58c3aa9c6cc51a8b6888e486026e856a0093957783f47f533facf1c79',
      },
    ]);
    expect(decision).toMatchObject({
      effectivity: {
        status: 'EFFECTIVE_ON_GOVERNED_MAIN_MERGE',
        canonical_base: 'main',
        exact_head_human_approval_required: true,
        separate_import_authorization_required: true,
      },
      order: {
        replacement_pre_import_gate: {
          gate: 'IB6-REPOSITORY-IMPORT-READINESS',
          role: 'TECHNICAL_READINESS_ONLY',
          result_authorizes_import: false,
        },
        import_authorization: {
          scope: 'IB6_HISTORY_IMPORT_ONLY',
          status: 'NOT_GRANTED',
        },
        deferred_gate: {
          gate: 'G5-POST-IMPORT-QUALIFICATION',
          scope: 'IB7_EVALUATION_ONLY',
          authorizes_ib7: false,
        },
        external_inputs_after: 'IB6-MERGE-TRAIN/PX2-EXIT',
        external_inputs_terminal_gate: 'PX2-EXIT',
        v0_2_0_release_source: 'POST_IB6_MAIN',
        v0_2_0_release_policy: {
          requires_refreeze: true,
          prior_evidence_reusable: false,
        },
      },
    });
    expect(decision.supersedes).toEqual({
      decision_id: 'g5-canary-to-g5-import-qualification-2026-07-24',
      schema: 'negentropy_laby.integration_gate_supersession.v1',
      path: 'integration/gates/g5-import-qualification-supersession.json',
      superseded_role: {
        gate: 'G5-IMPORT-QUALIFICATION',
        role: 'PRE_IB6_AUTHORIZATION_GATE',
        status: 'SUPERSEDED_UNEXECUTED',
        executed: false,
      },
      preserved_gate: {
        gate: 'G5-CANARY',
        status: 'SUPERSEDED_NOT_RUN',
        executed: false,
      },
    });
    expect(decision.scope.authorizes).toEqual([]);
    expect(decision.scope.does_not_authorize).toEqual(
      expect.arrayContaining([
        'IB6_HISTORY_IMPORT_ONLY',
        'IB7_CUTOVER',
        'LIVE_VERIFIED',
        'REPOSITORY_ARCHIVE',
      ]),
    );

    const currentTruth = [
      readRepositoryBytes('docs/developer/notification-delivery-integration.md'),
      readRepositoryBytes('docs/user-guide.md'),
      readRepositoryBytes('deploy/notification-import-qualification/README.md'),
    ]
      .map((bytes) => bytes.toString('utf8'))
      .join('\n');
    expect(currentTruth).toContain('G5-POST-IMPORT-QUALIFICATION');
    expect(currentTruth).toContain('IB7_EVALUATION_ONLY');
    expect(currentTruth).toContain('IB6-MERGE-TRAIN/PX2-EXIT');
    expect(currentTruth).not.toMatch(/PASS[` ]+authorizes only IB6 history-import eligibility/u);
    expect(currentTruth).not.toContain('G5-IMPORT-QUALIFICATION=PENDING');

    const receipt = readRepositoryJson(
      'integration/gates/ib6-history-import.json',
    ) as PhaseFReceipt;
    const receiptSchema = readRepositoryJson(
      'docs/integration/notification-delivery-ib6-history-import.v1.schema.json',
    );
    const validateReceipt = new Ajv2020({
      strict: false,
      validateFormats: false,
    }).compile(receiptSchema);
    expect(validateReceipt(receipt), JSON.stringify(validateReceipt.errors)).toBe(true);
    expectEveryObjectSchemaClosed(receiptSchema);

    const expectMutationRejected = (
      label: string,
      mutate: (candidate: PhaseFReceipt) => void,
    ): void => {
      const candidate = structuredClone(receipt);
      mutate(candidate);
      expect(
        validateReceipt(candidate),
        `${label}: ${JSON.stringify(validateReceipt.errors)}`,
      ).toBe(false);
    };

    expectMutationRejected('unknown root authority', (candidate) => {
      candidate.premature_authority = true;
    });
    expectMutationRejected('unknown nested gate field', (candidate) => {
      Object.assign(candidate.gate, { premature_authority: true });
    });
    expectMutationRejected('closed gate changed', (candidate) => {
      candidate.gate.status = 'PENDING';
    });
    expectMutationRejected('PX2 cannot be pre-completed', (candidate) => {
      candidate.gate.px2_exit = 'PASS';
    });
    expectMutationRejected('predecessor fulfillment is mandatory', (candidate) => {
      delete (candidate.predecessor_manifest as unknown as Record<string, unknown>).fulfillment;
    });
    expectMutationRejected('predecessor fulfillment cannot drift', (candidate) => {
      candidate.predecessor_manifest.fulfillment.resolution = 'PENDING';
    });
    expectMutationRejected('authorization scope cannot expand', (candidate) => {
      candidate.authorization.scope = 'RELEASE';
    });
    expectMutationRejected('readiness digest cannot drift', (candidate) => {
      candidate.authorization.bound_envelope.readiness_report_sha256 = `sha256:${'0'.repeat(64)}`;
    });
    expectMutationRejected('tag exception cannot widen', (candidate) => {
      candidate.authorization.bound_envelope.tag_immutability_exception = 'ACCEPT_ALL_TAG_DRIFT';
    });
    expectMutationRejected('import parent order is binding', (candidate) => {
      candidate.import_binding.pure_import.parents.reverse();
    });
    expectMutationRejected('productization record cannot be dropped', (candidate) => {
      candidate.productization_chain.pop();
    });
    expectMutationRejected('productization order is binding', (candidate) => {
      candidate.productization_chain.reverse();
    });
    expectMutationRejected('productization record cannot be duplicated', (candidate) => {
      candidate.productization_chain.splice(
        1,
        0,
        structuredClone(candidate.productization_chain[0]!),
      );
    });
    expectMutationRejected('productization object cannot drift', (candidate) => {
      candidate.productization_chain[0]!.head_commit = '0'.repeat(40);
    });
    expectMutationRejected('changed-path digest cannot drift', (candidate) => {
      candidate.productization_chain[0]!.changed_paths.digest = `sha256:${'0'.repeat(64)}`;
    });
    expectMutationRejected('changed-path algorithm cannot drift', (candidate) => {
      candidate.productization_chain[0]!.changed_paths.algorithm = 'SHA256_UNKNOWN';
    });
    expectMutationRejected('validation mode cannot drift', (candidate) => {
      candidate.productization_chain[0]!.hosted_validation.mode = 'EXACT_HEAD';
    });
    expectMutationRejected('validation execution cannot drift', (candidate) => {
      candidate.productization_chain[2]!.hosted_validation.execution_commit = '0'.repeat(40);
    });
    expectMutationRejected('artifact cannot be dropped', (candidate) => {
      candidate.final_state.artifacts.pop();
    });
    expectMutationRejected('artifact order is binding', (candidate) => {
      candidate.final_state.artifacts.reverse();
    });
    expectMutationRejected('artifact cannot be duplicated', (candidate) => {
      candidate.final_state.artifacts.splice(
        1,
        0,
        structuredClone(candidate.final_state.artifacts[0]!),
      );
    });
    expectMutationRejected('artifact hash cannot drift', (candidate) => {
      candidate.final_state.artifacts[0]!.sha256 = `sha256:${'0'.repeat(64)}`;
    });
    expectMutationRejected('registry relocation cannot drift', (candidate) => {
      candidate.registry_state.registry_relocation.status = 'COMPLETE';
    });
    expectMutationRejected('registry component cannot be added', (candidate) => {
      candidate.registry_state.absent_component_ids.push('new_notification_component');
    });
    expectMutationRejected('pending external gate cannot pass', (candidate) => {
      candidate.pending_external.status = 'PASS';
    });
    expectMutationRejected('pending external artifact cannot be dropped', (candidate) => {
      candidate.pending_external.artifacts.pop();
    });
    expectMutationRejected('review blockers must remain zero', (candidate) => {
      candidate.review.independent_blockers = 1;
    });
    expectMutationRejected('receipt cannot add authority', (candidate) => {
      candidate.scope.authorizes.push('G5_POST_IMPORT_QUALIFICATION_PASS');
    });
    expectMutationRejected('non-claim cannot be dropped', (candidate) => {
      candidate.scope.not_claimed.pop();
    });
    expectMutationRejected('non-claim order is binding', (candidate) => {
      candidate.scope.not_claimed.reverse();
    });
    expectMutationRejected('non-claim cannot be added', (candidate) => {
      candidate.scope.not_claimed.push('UNREVIEWED_AUTHORITY');
    });
    expectMutationRejected('self reference cannot be enabled', (candidate) => {
      candidate.self_reference_policy.contains_own_sha256 = true;
    });
    expectMutationRejected('receipt head cannot be embedded', (candidate) => {
      Object.assign(candidate.self_reference_policy, { receipt_pr_head: '0'.repeat(40) });
    });

    const root = repositoryRoot();
    const receiptPath = fileURLToPath(
      new URL('../../../../integration/gates/ib6-history-import.json', import.meta.url),
    );
    const receiptPathStat = lstatSync(receiptPath);
    expect(receiptPathStat.isFile()).toBe(true);
    expect(receiptPathStat.isSymbolicLink()).toBe(false);
    expect(receipt.$schema).toBe(
      '../../docs/integration/notification-delivery-ib6-history-import.v1.schema.json',
    );
    expect(receipt.gate).toEqual({
      name: 'IB6-HISTORY-IMPORT',
      status: 'PASS',
      closed: true,
      effectivity: 'EFFECTIVE_ON_GOVERNED_CANONICAL_MAIN_MERGE',
      canonical_base: 'main',
      px2_exit: 'PENDING_POST_MERGE_AUDIT',
    });
    expect(receipt.scope.authorizes).toEqual([]);
    expect(receipt.review).toEqual({
      scope: 'COMPLETED_D_AND_E1_THROUGH_E6_PRODUCTIZATION_ONLY',
      independent_blockers: 0,
      receipt_pr_included: false,
    });

    expect(git(root, ['cat-file', '-t', receipt.repository_base.commit])).toBe('commit');
    expect(git(root, ['rev-parse', `${receipt.repository_base.commit}^{tree}`])).toBe(
      receipt.repository_base.tree,
    );
    expect(
      git(root, [
        'rev-parse',
        `${receipt.repository_base.commit}:${receipt.final_state.service.path}`,
      ]),
    ).toBe(receipt.repository_base.service_subtree);
    expect(receipt.final_state.service.subtree).toBe(receipt.repository_base.service_subtree);

    const source = receipt.source_history.frozen_source;
    const tag = receipt.source_history.archive_tag;
    expect(git(root, ['rev-parse', `refs/tags/${tag.name}`])).toBe(tag.object);
    expect(git(root, ['cat-file', '-t', tag.object])).toBe(tag.object_type);
    expect(git(root, ['rev-parse', `${tag.object}^{commit}`])).toBe(tag.target_commit);
    expect(tag.target_commit).toBe(source.commit);
    expect(git(root, ['rev-parse', `${source.commit}^{tree}`])).toBe(source.tree);
    expect(Number(git(root, ['rev-list', '--count', source.commit]))).toBe(
      source.reachable_commit_count,
    );
    expect(() =>
      git(root, [
        'merge-base',
        '--is-ancestor',
        receipt.source_history.review_baseline.commit,
        source.commit,
      ]),
    ).not.toThrow();

    const envelope = receipt.authorization.bound_envelope;
    expect(git(root, ['rev-parse', `${envelope.openslack_base_commit}^{tree}`])).toBe(
      envelope.openslack_base_tree,
    );
    expect(envelope.archive_tag).toBe(tag.name);
    expect(envelope.archive_tag_object).toBe(tag.object);
    expect(envelope.source_commit).toBe(source.commit);
    expect(envelope.source_tree).toBe(source.tree);
    expect(envelope.source_reachable_commit_count).toBe(source.reachable_commit_count);
    expect(envelope.import_path).toBe(receipt.import_binding.target_path);

    const pureImport = receipt.import_binding.pure_import;
    const openslackImport = receipt.import_binding.openslack_merge;
    expect(gitCommitParents(root, pureImport.commit)).toEqual(pureImport.parents);
    expect(git(root, ['rev-parse', `${pureImport.commit}^{tree}`])).toBe(pureImport.tree);
    expect(
      git(root, ['rev-parse', `${pureImport.commit}:${receipt.import_binding.target_path}`]),
    ).toBe(receipt.import_binding.imported_subtree);
    expect(receipt.import_binding.imported_subtree).toBe(source.tree);
    expect(gitCommitParents(root, openslackImport.commit)).toEqual(openslackImport.parents);
    expect(git(root, ['rev-parse', `${openslackImport.commit}^{tree}`])).toBe(openslackImport.tree);
    expect(openslackImport.tree).toBe(pureImport.tree);
    expect(receipt.authorization.provenance.governed_summary_merge_commit).toBe(
      openslackImport.commit,
    );

    expect(receipt.productization_chain.map((record) => record.phase)).toEqual([
      'D',
      'E1',
      'E2',
      'E3',
      'E4',
      'E5',
      'E6',
    ]);
    for (const [index, record] of receipt.productization_chain.entries()) {
      expect(git(root, ['cat-file', '-t', record.base_commit])).toBe('commit');
      expect(git(root, ['cat-file', '-t', record.head_commit])).toBe('commit');
      expect(git(root, ['cat-file', '-t', record.merge_commit])).toBe('commit');
      expect(git(root, ['rev-parse', `${record.head_commit}^{tree}`])).toBe(record.head_tree);
      expect(git(root, ['rev-parse', `${record.merge_commit}^{tree}`])).toBe(record.merge_tree);
      expect(gitCommitParents(root, record.merge_commit)).toEqual(record.merge_parents);
      expect(() =>
        git(root, ['merge-base', '--is-ancestor', record.base_commit, record.head_commit]),
      ).not.toThrow();
      expect(record.merge_tree_equals_head_tree).toBe(true);
      expect(record.merge_tree).toBe(record.head_tree);
      if (index > 0) {
        expect(record.base_commit).toBe(receipt.productization_chain[index - 1]!.merge_commit);
      }

      const changedPaths = gitChangedPathEvidence(root, record.base_commit, record.head_commit);
      expect(record.changed_paths).toEqual({
        comparison: 'GIT_DIFF_NAME_ONLY_NO_RENAMES_BASE_TO_HEAD',
        count: changedPaths.count,
        digest: changedPaths.digest,
        algorithm: 'SHA256_SORTED_LF_PATHS_V1',
      });

      const validation = record.hosted_validation;
      expect(validation.governed_head).toBe(record.head_commit);
      expect(validation.validated_content_tree).toBe(record.head_tree);
      expect(validation.conclusion).toBe('SUCCESS');
      expect(validation.details_url).toBe(
        `https://github.com/Negentropy-Laby/OpenSlack/actions/runs/${validation.run_id}/job/${validation.job_id}`,
      );
      if (validation.mode === 'EXACT_HEAD') {
        expect(validation.literal_head_execution).toBe(true);
        expect(validation.execution_commit).toBe(record.head_commit);
        expect(git(root, ['rev-parse', `${validation.execution_commit}^{tree}`])).toBe(
          record.head_tree,
        );
      } else {
        expect(validation.literal_head_execution).toBe(false);
        expect(validation.execution_parents).toEqual([record.base_commit, record.head_commit]);
      }
    }
    expect(receipt.productization_chain[0]!.base_commit).toBe(
      receipt.authorization.bound_envelope.openslack_base_commit,
    );
    expect(receipt.productization_chain.at(-1)!.merge_commit).toBe(receipt.repository_base.commit);

    const repositoryBindings = [
      ...receipt.final_state.artifacts,
      receipt.registry_state.modules,
      receipt.registry_state.generated_status,
      ...receipt.pending_external.artifacts,
      {
        path: receipt.predecessor_manifest.path,
        sha256: receipt.predecessor_manifest.sha256,
      },
    ];
    const snapshotBlobs = gitBatchFiles(root, receipt.repository_base.commit, [
      ...new Set(repositoryBindings.map((binding) => binding.path)),
    ]);
    for (const binding of repositoryBindings) {
      expect(
        sha256(snapshotBlobs.get(binding.path)!),
        `STOP: PHASE_F_ARTIFACT_BYTES_DRIFT: ${binding.path}`,
      ).toBe(binding.sha256);
    }

    const artifactRoles = receipt.final_state.artifacts.map((artifact) => artifact.role);
    const artifactPaths = receipt.final_state.artifacts.map((artifact) => artifact.path);
    expect(new Set(artifactRoles).size).toBe(artifactRoles.length);
    expect(new Set(artifactPaths).size).toBe(artifactPaths.length);
    expect(artifactPaths).not.toContain(receipt.self_reference_policy.receipt_path);
    expect(artifactPaths).not.toContain(
      'docs/integration/notification-delivery-ib6-history-import.v1.schema.json',
    );
    expect(artifactPaths).not.toContain(
      'packages/github/src/__tests__/notification-import-qualification-deployment.test.ts',
    );

    expect(
      receipt.final_state.artifacts
        .filter((artifact) => artifact.role?.startsWith('E6_'))
        .map((artifact) => artifact.path),
    ).toEqual([
      'README.md',
      'docs/README.md',
      'docs/developer/notification-delivery-integration.md',
      'services/notification-delivery/README.md',
      'services/notification-delivery/docs/api/openapi.yaml',
      'services/notification-delivery/docs/architecture/architecture.md',
      'services/notification-delivery/docs/design.md',
      'services/notification-delivery/docs/development-plan.md',
      'services/notification-delivery/docs/testing/workspace-manifest.sha256',
    ]);

    const predecessor = JSON.parse(
      snapshotBlobs.get(receipt.predecessor_manifest.path)!.toString('utf8'),
    ) as {
      phase_f_receipt: {
        status: string;
        path_base: string;
        expected_path: string;
      };
    };
    expect(predecessor.phase_f_receipt).toEqual(receipt.predecessor_manifest.phase_f_binding);
    expect(receipt.predecessor_manifest.fulfillment).toEqual({
      receipt_path: receipt.self_reference_policy.receipt_path,
      resolution: 'FULFILLED_BY_THIS_APPEND_ONLY_RECEIPT',
    });

    const goMod = snapshotBlobs.get('services/notification-delivery/go.mod')!.toString('utf8');
    const moduleDirectives = (goMod.match(/^module[^\r\n]*$/gmu) ?? []).map((line) => line.trim());
    expect(moduleDirectives).toEqual([`module ${receipt.final_state.service.go_module}`]);

    const codeowners = snapshotBlobs.get('.github/CODEOWNERS')!.toString('utf8');
    expect(
      codeowners
        .split(/\r?\n/u)
        .filter((line) => line.trim().startsWith('services/notification-delivery/**')),
    ).toEqual(['services/notification-delivery/**              @wsman']);
    const servicePaths = git(root, [
      'ls-tree',
      '-r',
      '--name-only',
      receipt.repository_base.commit,
      '--',
      receipt.final_state.service.path,
    ]).split(/\r?\n/u);
    expect(servicePaths).toHaveLength(211);
    expect(
      servicePaths.every((path) => path.startsWith(`${receipt.final_state.service.path}/`)),
    ).toBe(true);

    const workspaceManifest = snapshotBlobs
      .get('services/notification-delivery/docs/testing/workspace-manifest.sha256')!
      .toString('utf8')
      .trimEnd()
      .split(/\r?\n/u);
    expect(workspaceManifest).toHaveLength(receipt.final_state.service.workspace_manifest_entries);
    const manifestPaths = workspaceManifest.map((row) => row.slice(66));
    expect(manifestPaths).toEqual([...manifestPaths].sort());
    expect(new Set(manifestPaths).size).toBe(manifestPaths.length);

    const registry = parse(
      snapshotBlobs.get(receipt.registry_state.modules.path)!.toString('utf8'),
    ) as {
      schema: string;
      modules: Array<{ id: string; packages?: string[] }>;
    };
    expect(registry.schema).toBe('openslack.modules.v2');
    expect(registry.modules.map((module) => module.id)).toEqual([
      'self_evolution',
      'github_task_loop',
      'operator',
      'pr_review_merge',
      'collaboration',
    ]);
    const registryText = [
      snapshotBlobs.get(receipt.registry_state.modules.path)!.toString('utf8'),
      snapshotBlobs.get(receipt.registry_state.generated_status.path)!.toString('utf8'),
    ]
      .join('\n')
      .toLowerCase();
    for (const absentId of [
      ...receipt.registry_state.absent_component_ids,
      'notification-delivery',
      'notification delivery service',
    ]) {
      expect(registryText, `STOP: REGISTRY_COMPONENT_PRESENT: ${absentId}`).not.toContain(absentId);
    }
    expect(registry.modules.flatMap((module) => module.packages ?? [])).not.toContain(
      receipt.final_state.service.go_module,
    );
    expect(receipt.registry_state).toMatchObject({
      notification_delivery_component_absent: true,
      registry_relocation: {
        status: 'N/A_CURRENT_BASELINE',
        next: 'DEFERRED_TO_PX0',
      },
    });

    const pendingManifestBinding = receipt.pending_external.artifacts.find(
      (artifact) => artifact.role === 'ENVIRONMENT_MANIFEST_V2',
    )!;
    const pendingManifest = JSON.parse(
      snapshotBlobs.get(pendingManifestBinding.path)!.toString('utf8'),
    ) as {
      schema: string;
      status: string;
      gate: string;
      scope: string;
      external_inputs_after: string;
      does_not_claim: string[];
    };
    expect(pendingManifest).toMatchObject({
      schema: 'openslack.notification_import_qualification_environment_manifest.v2',
      status: 'PENDING_EXTERNAL',
      gate: 'G5-POST-IMPORT-QUALIFICATION',
      scope: 'IB7_EVALUATION_ONLY',
      external_inputs_after: 'IB6-MERGE-TRAIN/PX2-EXIT',
      does_not_claim: expect.arrayContaining([
        'G5_POST_IMPORT_QUALIFICATION_PASS',
        'IB7_CUTOVER',
        'LIVE_VERIFIED',
      ]),
    });
    expect(receipt.pending_external.status).toBe('PENDING_EXTERNAL');
    expect(receipt.self_reference_policy).toMatchObject({
      contains_own_sha256: false,
      contains_receipt_pr_head: false,
      contains_receipt_pr_approval_or_check_ids: false,
      contains_receipt_merge_commit: false,
    });
  }, 30_000);
});

function repositoryRoot(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function gitCommitParents(root: string, commit: string): string[] {
  return git(root, ['show', '-s', '--format=%P', commit]).split(' ').filter(Boolean);
}

function gitChangedPathEvidence(
  root: string,
  base: string,
  head: string,
): { count: number; digest: string } {
  const output = execFileSync(
    'git',
    ['-C', root, 'diff', '--name-only', '--no-renames', '-z', base, head],
    {
      encoding: null,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  const paths: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index > start) paths.push(Buffer.from(output.subarray(start, index)));
    start = index + 1;
  }
  paths.sort(Buffer.compare);
  const serialized = Buffer.concat(paths.flatMap((path) => [path, Buffer.from('\n', 'utf8')]));
  return {
    count: paths.length,
    digest: sha256(serialized),
  };
}

function gitBatchFiles(root: string, commit: string, paths: string[]): Map<string, Buffer> {
  const input = paths.map((path) => `${commit}:${path}\n`).join('');
  const output = execFileSync('git', ['-C', root, 'cat-file', '--batch'], {
    input,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const result = new Map<string, Buffer>();
  let offset = 0;

  for (const path of paths) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`STOP: GIT_BATCH_HEADER_MISSING: ${path}`);
    const header = output.subarray(offset, headerEnd).toString('utf8');
    const headerParts = header.split(' ');
    if (headerParts.at(-1) === 'missing') {
      throw new Error(`STOP: GIT_BATCH_OBJECT_MISSING: ${commit}:${path}`);
    }
    if (headerParts[1] !== 'blob') {
      throw new Error(`STOP: GIT_BATCH_NOT_BLOB: ${commit}:${path}: ${header}`);
    }
    const size = Number(headerParts[2]);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`STOP: GIT_BATCH_SIZE_INVALID: ${commit}:${path}: ${header}`);
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (output[contentEnd] !== 0x0a) {
      throw new Error(`STOP: GIT_BATCH_SEPARATOR_MISSING: ${commit}:${path}`);
    }
    result.set(path, Buffer.from(output.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
  }

  if (offset !== output.length) {
    throw new Error('STOP: GIT_BATCH_TRAILING_OUTPUT');
  }
  return result;
}

function expectEveryObjectSchemaClosed(schema: object): void {
  const visit = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node.type === 'object') {
      expect(node.additionalProperties, `STOP: SCHEMA_OBJECT_OPEN: ${path}`).toBe(false);
      expect(Array.isArray(node.required), `STOP: SCHEMA_REQUIRED_MISSING: ${path}`).toBe(true);
      expect(node.properties, `STOP: SCHEMA_PROPERTIES_MISSING: ${path}`).toBeTruthy();
    }
    if (node.type === 'array') {
      expect(node.items, `STOP: SCHEMA_ARRAY_OPEN: ${path}`).toBe(false);
      if (node.maxItems === 0) {
        expect(node.minItems, `STOP: EMPTY_ARRAY_MIN_ITEMS_DRIFT: ${path}`).toBe(0);
        expect(node.prefixItems, `STOP: EMPTY_ARRAY_PREFIX_ITEMS_PRESENT: ${path}`).toBeUndefined();
      } else {
        expect(Array.isArray(node.prefixItems), `STOP: ARRAY_PREFIX_ITEMS_MISSING: ${path}`).toBe(
          true,
        );
        expect(node.minItems, `STOP: ARRAY_MIN_ITEMS_DRIFT: ${path}`).toBe(node.maxItems);
        expect((node.prefixItems as unknown[]).length, `STOP: ARRAY_LENGTH_DRIFT: ${path}`).toBe(
          node.maxItems,
        );
      }
    }
    for (const [key, child] of Object.entries(node)) visit(child, `${path}/${key}`);
  };
  visit(schema, '$');
}

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

function readRepositoryBytes(path: string): Buffer {
  return readFileSync(new URL(`../../../../${path}`, import.meta.url));
}

function readRepositoryJson(path: string): object {
  return JSON.parse(readRepositoryBytes(path).toString('utf8')) as object;
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
