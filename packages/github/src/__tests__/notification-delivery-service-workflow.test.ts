import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  name?: string;
  run?: string;
  shell?: string;
  uses?: string;
  with?: Record<string, boolean | number | string>;
  'working-directory'?: string;
};

type WorkflowTrigger = {
  branches: string[];
  paths: string[];
};

type ServiceWorkflow = {
  name: string;
  on: {
    pull_request: WorkflowTrigger;
    push: WorkflowTrigger;
    workflow_dispatch: null;
  };
  permissions: Record<string, string>;
  jobs: {
    validate: {
      name: string;
      'runs-on': string;
      'timeout-minutes': number;
      defaults: {
        run: {
          shell: string;
          'working-directory': string;
        };
      };
      env: Record<string, string>;
      permissions?: unknown;
      steps: WorkflowStep[];
    };
    'workflow-runner-windows': {
      name: string;
      'runs-on': string;
      'timeout-minutes': number;
      env: Record<string, string>;
      steps: WorkflowStep[];
    };
  };
};

type ReusableValidateWorkflow = {
  jobs: {
    validate: {
      steps: WorkflowStep[];
    };
  };
};

const workflowUrl = new URL(
  '../../../../.github/workflows/notification-delivery-service.yml',
  import.meta.url,
);
const source = readFileSync(workflowUrl, 'utf8');
const workflow = parse(source) as ServiceWorkflow;
const reusableWorkflowUrl = new URL(
  '../../../../.github/workflows/openslack-reusable-validate.yml',
  import.meta.url,
);
const reusableSource = readFileSync(reusableWorkflowUrl, 'utf8');
const reusableWorkflow = parse(reusableSource) as ReusableValidateWorkflow;
const rootPackageUrl = new URL('../../../../package.json', import.meta.url);
const rootPackage = JSON.parse(readFileSync(rootPackageUrl, 'utf8')) as {
  scripts: Record<string, string>;
};
const gs6McpClientUrl = new URL(
  '../../../../scripts/governance-control-contracts/gs6-mcp-client.ts',
  import.meta.url,
);
const gs6McpClientSource = readFileSync(gs6McpClientUrl, 'utf8');
const pendingAuditSchemaUrl = new URL(
  '../../../../packages/operator/contracts/governed-plan-authority/v1/schemas/governance-authority-pending-audit.v1.schema.json',
  import.meta.url,
);
const pendingAuditSchemaBytes = readFileSync(pendingAuditSchemaUrl);
const pendingAuditSchema = JSON.parse(pendingAuditSchemaBytes.toString('utf8')) as Record<
  string,
  unknown
>;
const authorityManifestUrl = new URL(
  '../../../../packages/operator/contracts/governed-plan-authority/v1/manifest.json',
  import.meta.url,
);
const authorityManifest = JSON.parse(readFileSync(authorityManifestUrl, 'utf8')) as Record<
  string,
  unknown
>;
const authorityGoldenUrl = new URL(
  '../../../../packages/operator/contracts/governed-plan-authority/v1/golden-vectors.json',
  import.meta.url,
);
const authorityGolden = JSON.parse(readFileSync(authorityGoldenUrl, 'utf8')) as Record<
  string,
  unknown
>;
const pendingAuditMirrorUrl = new URL(
  '../../../../services/governance-control/internal/contractmirror/generated/authority/v1/schemas/governance-authority-pending-audit.v1.schema.json',
  import.meta.url,
);

const checkoutAction = 'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd';
const setupGoAction = 'actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16';
const setupNodeAction = 'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e';
const setupBunAction = 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6';
const postgresImage =
  'postgres:18.4@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a';
const prometheusImage =
  'prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893';
const goImage =
  'golang:1.26.5@sha256:3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647';
const exactHeadExpression = '${{ github.event.pull_request.head.sha || github.sha }}';
const triggerPaths = [
  'services/notification-delivery/**',
  'services/organization-graph/**',
  'services/governance-control/**',
  'services/workflow-control/**',
  'services/*/go.mod',
  'services/*/go.sum',
  'packages/organization-graph/**',
  'packages/operator/contracts/governed-plan/**',
  'packages/operator/contracts/governed-plan-authority/**',
  'packages/operator/src/governed-plan*.ts',
  'packages/workflows/contracts/workflow-control/**',
  'packages/workflows/contracts/workflow-control-shadow/**',
  'packages/workflows/contracts/workflow-runner/**',
  'packages/workflows/src/workflow-control-contract.ts',
  'packages/workflows/src/workflow-control-observation.ts',
  'packages/workflows/src/workflow-control-shadow*.ts',
  'packages/workflows/src/__tests__/workflow-control-contract.test.ts',
  'packages/workflows/src/__tests__/workflow-control-shadow*.ts',
  'packages/workflows/src/workflow-runner-contract.ts',
  'packages/workflows/src/workflow-runner*.ts',
  'packages/workflows/src/__tests__/workflow-runner*.test.ts',
  'packages/workflows/src/agent-shim.ts',
  'packages/workflows/src/execute.ts',
  'packages/workflows/src/loader.ts',
  'packages/workflows/src/runtime.ts',
  'packages/workflows/src/run-store.ts',
  'packages/workflows/src/workflow-runs.ts',
  'packages/workflows/src/workflow-effect-approval-store.ts',
  'packages/workflows/src/index.ts',
  'README.md',
  'docs/README.md',
  'design/cdd/module-index.md',
  'design/cdd/workstreams/notification-delivery/README.md',
  'design/cdd/workstreams/workflow-runtime/README.md',
  'docs/architecture/components/workflow-runtime.md',
  'docs/architecture/contracts/workflow-control.md',
  'docs/architecture/contracts/workflow-runner.md',
  'docs/architecture/ts-to-go-migration-roadmap.md',
  'docs/user/guides/notification-delivery-operations.md',
  'docs/user/guides/core-workflows.md',
  'docs/user/cli-reference.md',
  'docs/architecture/integrations/notification-delivery.md',
  'docs/contributor/notification-delivery/**',
  'docs/security/notification-delivery-boundary.md',
  'docs/evidence/notification-delivery-evidence.md',
  'docs/reference/**',
  'memory_bank/**',
  'production/**',
  'integration/gates/ib6-history-import.json',
  '.openslack/modules.yaml',
  'bun.lock',
  'package.json',
  'vitest.config.ts',
  'go.work',
  'go.work.sum',
  'scripts/go-check.sh',
  'scripts/go-check/**',
  'scripts/organization-graph-contracts/**',
  'scripts/governance-control-contracts/**',
  'scripts/workflow-control-contracts/**',
  'scripts/workflow-control-shadow-contracts/**',
  'scripts/workflow-runner-contracts/**',
  'scripts/release/stage-schema-assets.ts',
  'scripts/documentation/**',
  'scripts/notification-docs/**',
  '.github/workflows/notification-delivery-service.yml',
  '.github/workflows/openslack-reusable-validate.yml',
  'packages/github/src/__tests__/notification-delivery-service-workflow.test.ts',
  'packages/workspace/src/__tests__/go-check-script.test.ts',
];

function stepIndex(name: string): number {
  return workflow.jobs.validate.steps.findIndex((step) => step.name === name);
}

function lines(...values: string[]): string {
  return `${values.join('\n')}\n`;
}

function gs6CrossLanguageRun(): string {
  return lines(
    'set -euo pipefail',
    'cd "$GITHUB_WORKSPACE"',
    'bun run build',
    'cd services/governance-control',
    'postgres_container="openslack-gs6-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    'cleanup() {',
    '  docker rm --force "$postgres_container" >/dev/null 2>&1 || true',
    '}',
    'trap cleanup EXIT',
    'cleanup',
    'docker run --detach \\',
    '  --name "$postgres_container" \\',
    '  --env POSTGRES_USER=openslack \\',
    '  --env POSTGRES_PASSWORD=openslack \\',
    '  --env POSTGRES_DB=openslack \\',
    '  --publish 127.0.0.1::5432 \\',
    `  ${postgresImage} >/dev/null`,
    'for attempt in $(seq 1 60); do',
    '  if docker exec "$postgres_container" pg_isready --username openslack --dbname openslack >/dev/null 2>&1; then',
    '    break',
    '  fi',
    '  if [ "$attempt" -eq 60 ]; then',
    '    docker logs "$postgres_container"',
    '    exit 1',
    '  fi',
    '  sleep 1',
    'done',
    'published="$(docker port "$postgres_container" 5432/tcp)"',
    'postgres_port="${published##*:}"',
    'test "$postgres_port" -ge 1',
    'export DATABASE_URL="postgres://openslack:openslack@127.0.0.1:${postgres_port}/openslack?sslmode=disable"',
    "OPENSLACK_GS6_CROSS_LANGUAGE=1 go test ./cmd/server -run '^TestGS6CrossLanguageAuthorityCutover$' -count=1",
  );
}

function gs7bCrossLanguageRun(): string {
  return lines(
    'set -euo pipefail',
    'postgres_container="openslack-gs7b-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    'cleanup() {',
    '  docker rm --force "$postgres_container" >/dev/null 2>&1 || true',
    '}',
    'trap cleanup EXIT',
    'cleanup',
    'docker run --detach \\',
    '  --name "$postgres_container" \\',
    '  --env POSTGRES_USER=openslack \\',
    '  --env POSTGRES_PASSWORD=openslack \\',
    '  --env POSTGRES_DB=openslack \\',
    '  --publish 127.0.0.1::5432 \\',
    `  ${postgresImage} >/dev/null`,
    'for attempt in $(seq 1 60); do',
    '  if docker exec "$postgres_container" pg_isready --username openslack --dbname openslack >/dev/null 2>&1; then',
    '    break',
    '  fi',
    '  if [ "$attempt" -eq 60 ]; then',
    '    docker logs "$postgres_container"',
    '    exit 1',
    '  fi',
    '  sleep 1',
    'done',
    'published="$(docker port "$postgres_container" 5432/tcp)"',
    'postgres_port="${published##*:}"',
    'test "$postgres_port" -ge 1',
    'export DATABASE_URL="postgres://openslack:openslack@127.0.0.1:${postgres_port}/openslack?sslmode=disable"',
    "OPENSLACK_GS7B_CROSS_LANGUAGE=1 go test ./cmd/server -run '^TestGS7BCrossLanguageShadowObservation$' -count=1",
  );
}

describe('notification delivery service workflow', () => {
  it('runs only for the service contract on main and manual dispatch', () => {
    expect(workflow.name).toBe('Notification Delivery Service CI');
    expect(Object.keys(workflow).sort()).toEqual(['jobs', 'name', 'on', 'permissions']);
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
    expect(workflow.on.pull_request).toEqual({
      branches: ['main'],
      paths: triggerPaths,
    });
    expect(workflow.on.push).toEqual({
      branches: ['main'],
      paths: triggerPaths,
    });
    expect(workflow.on).toHaveProperty('workflow_dispatch', null);
  });

  it('uses a read-only exact-head checkout before any service command', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(workflow.jobs)).toEqual(['validate', 'workflow-runner-windows']);

    const job = workflow.jobs.validate;
    expect(Object.keys(job).sort()).toEqual([
      'defaults',
      'env',
      'name',
      'runs-on',
      'steps',
      'timeout-minutes',
    ]);
    expect(job).not.toHaveProperty('permissions');
    expect(job.name).toBe('Validate notification delivery service');
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(90);
    expect(job.defaults.run).toEqual({
      shell: 'bash',
      'working-directory': 'services/notification-delivery',
    });
    expect(job.env.EXPECTED_COMMIT).toBe(exactHeadExpression);

    const checkoutIndex = job.steps.findIndex((step) => step.uses === checkoutAction);
    const headGuardIndex = stepIndex('Require the exact source head');
    const setupGoIndex = job.steps.findIndex((step) => step.uses === setupGoAction);
    const goGuardIndex = stepIndex('Require the exact Go toolchain');
    const actionlintIndex = stepIndex('Validate the notification workflows');
    const setupNodeIndex = job.steps.findIndex((step) => step.uses === setupNodeAction);
    const setupBunIndex = job.steps.findIndex((step) => step.uses === setupBunAction);
    const installIndex = stepIndex('Install root dependencies');
    const graphGoldenIndex = stepIndex('Verify Organization Graph golden contracts');
    const governanceGoldenIndex = stepIndex('Verify Governance Control golden contracts');
    const workflowGoldenIndex = stepIndex('Verify Workflow Control golden contracts');
    const workflowShadowGoldenIndex = stepIndex('Verify Workflow Control shadow golden contracts');
    const workflowRunnerGoldenIndex = stepIndex('Verify Workflow Runner golden contracts');
    const workflowRunnerLinuxIndex = stepIndex(
      'Qualify the sealed TypeScript Workflow Runner on Linux',
    );
    const graphDistIndex = stepIndex('Clean-build and smoke Organization Graph distribution');
    const graphMirrorIndex = stepIndex('Qualify GS3-A real Go read mirror');
    const graphCanaryIndex = stepIndex('Qualify GS3-B bounded Go read canary');
    const graphAuthorityIndex = stepIndex('Qualify GS3-C global Go Graph read authority');
    const imagePullIndex = stepIndex('Pull pinned Go verification images');
    const gs6CrossLanguageIndex = stepIndex('Qualify GS6 official-SDK single-writer cutover');
    const gs7bCrossLanguageIndex = stepIndex('Qualify GS7-B TypeScript-to-Go shadow observation');
    const gs8bRunnerIndex = stepIndex('Qualify GS8-B real TypeScript runner lifecycle');
    const goCheckIndex = stepIndex('Run reviewed Go workspace verifier');
    const rootDocsIndex = stepIndex('Verify root documentation governance');
    const docsIndex = stepIndex('Verify notification delivery documentation');
    const composeIndex = stepIndex('Render the Compose configuration');

    expect(checkoutIndex).toBe(0);
    expect(headGuardIndex).toBe(checkoutIndex + 1);
    expect(setupGoIndex).toBe(headGuardIndex + 1);
    expect(goGuardIndex).toBe(setupGoIndex + 1);
    expect(actionlintIndex).toBe(goGuardIndex + 1);
    expect(setupNodeIndex).toBe(actionlintIndex + 1);
    expect(setupBunIndex).toBe(setupNodeIndex + 1);
    expect(installIndex).toBe(setupBunIndex + 1);
    expect(graphGoldenIndex).toBe(installIndex + 1);
    expect(governanceGoldenIndex).toBe(graphGoldenIndex + 1);
    expect(workflowGoldenIndex).toBe(governanceGoldenIndex + 1);
    expect(workflowShadowGoldenIndex).toBe(workflowGoldenIndex + 1);
    expect(workflowRunnerGoldenIndex).toBe(workflowShadowGoldenIndex + 1);
    expect(workflowRunnerLinuxIndex).toBe(workflowRunnerGoldenIndex + 1);
    expect(graphDistIndex).toBe(workflowRunnerLinuxIndex + 1);
    expect(graphMirrorIndex).toBe(graphDistIndex + 1);
    expect(graphCanaryIndex).toBe(graphMirrorIndex + 1);
    expect(graphAuthorityIndex).toBe(graphCanaryIndex + 1);
    expect(imagePullIndex).toBe(graphAuthorityIndex + 1);
    expect(gs6CrossLanguageIndex).toBe(imagePullIndex + 1);
    expect(gs7bCrossLanguageIndex).toBe(gs6CrossLanguageIndex + 1);
    expect(gs8bRunnerIndex).toBe(gs7bCrossLanguageIndex + 1);
    expect(goCheckIndex).toBe(gs8bRunnerIndex + 1);
    expect(rootDocsIndex).toBe(goCheckIndex + 1);
    expect(docsIndex).toBe(rootDocsIndex + 1);
    expect(composeIndex).toBe(docsIndex + 1);
    expect(job.steps[checkoutIndex]?.with).toEqual({
      ref: exactHeadExpression,
      'persist-credentials': false,
      'fetch-depth': 1,
    });
    expect(job.steps[headGuardIndex]?.run).toContain("git rev-parse --verify 'HEAD^{commit}'");
    expect(job.steps[headGuardIndex]?.run).toContain(
      'test "$checkout_commit" = "$EXPECTED_COMMIT"',
    );
    expect(job.steps[setupGoIndex]?.with).toEqual({
      'go-version': '1.26.5',
      cache: true,
      'cache-dependency-path': 'services/*/go.sum',
    });
    expect(job.steps[goGuardIndex]?.run).toContain('test "$(go env GOVERSION)" = "go1.26.5"');
    expect(job.steps[goGuardIndex]?.run).toContain('test "$(go env GOWORK)" = "off"');
    expect(job.steps[goGuardIndex]?.run).toContain(
      'go work edit -json "$GITHUB_WORKSPACE/go.work" >/dev/null',
    );
    expect(job.steps[goGuardIndex]?.run).toContain('GO111MODULE=off go test .');
    expect(job.steps[goCheckIndex]).toEqual({
      name: 'Run reviewed Go workspace verifier',
      'working-directory': '.',
      run: 'bash scripts/go-check.sh --all',
    });
    expect(job.steps[actionlintIndex]).toMatchObject({
      'working-directory': '.',
      run: 'go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/notification-delivery-service.yml .github/workflows/openslack-reusable-validate.yml',
    });
    expect(job.steps[setupNodeIndex]).toEqual({
      name: 'Set up the exact Node toolchain',
      uses: setupNodeAction,
      with: { 'node-version': '22.14.0' },
    });
    expect(job.steps[setupBunIndex]).toEqual({
      name: 'Set up the exact Bun toolchain',
      uses: setupBunAction,
      with: { 'bun-version': '1.3.11' },
    });
    expect(job.steps[installIndex]).toEqual({
      name: 'Install root dependencies',
      'working-directory': '.',
      run: 'bun install --frozen-lockfile',
    });
    expect(job.steps[graphGoldenIndex]).toEqual({
      name: 'Verify Organization Graph golden contracts',
      'working-directory': '.',
      run: 'bun run graph:golden -- --check',
    });
    expect(job.steps[governanceGoldenIndex]).toEqual({
      name: 'Verify Governance Control golden contracts',
      'working-directory': '.',
      run: 'bun run governance:golden -- --check',
    });
    expect(job.steps[workflowGoldenIndex]).toEqual({
      name: 'Verify Workflow Control golden contracts',
      'working-directory': '.',
      run: 'bun run workflow:golden -- --check',
    });
    expect(job.steps[workflowShadowGoldenIndex]).toEqual({
      name: 'Verify Workflow Control shadow golden contracts',
      'working-directory': '.',
      run: 'bun run workflow:shadow-golden -- --check',
    });
    expect(job.steps[workflowRunnerGoldenIndex]).toEqual({
      name: 'Verify Workflow Runner golden contracts',
      'working-directory': '.',
      run: 'bun run workflow:runner-golden -- --check',
    });
    expect(job.steps[workflowRunnerLinuxIndex]).toEqual({
      name: 'Qualify the sealed TypeScript Workflow Runner on Linux',
      'working-directory': '.',
      run: lines(
        'set -euo pipefail',
        'bun run build',
        'bunx vitest run packages/workflows/src/__tests__/workflow-runner*.test.ts',
      ),
    });
    expect(job.steps[graphDistIndex]).toEqual({
      name: 'Clean-build and smoke Organization Graph distribution',
      'working-directory': '.',
      run: lines('set -euo pipefail', 'bun run graph:dist-build', 'bun run graph:dist-smoke'),
    });
    expect(job.steps[graphMirrorIndex]).toEqual({
      name: 'Qualify GS3-A real Go read mirror',
      'working-directory': 'services/organization-graph',
      run: "OPENSLACK_GS3A_CROSS_LANGUAGE=1 go test ./internal/app -run '^TestGS3ARealGoReadMirror$' -count=1",
    });
    expect(job.steps[graphCanaryIndex]).toEqual({
      name: 'Qualify GS3-B bounded Go read canary',
      'working-directory': 'services/organization-graph',
      run: "OPENSLACK_GS3B_CROSS_LANGUAGE=1 go test ./internal/app -run '^TestGS3BRealGoReadCanary$' -count=1",
    });
    expect(job.steps[graphAuthorityIndex]).toEqual({
      name: 'Qualify GS3-C global Go Graph read authority',
      'working-directory': 'services/organization-graph',
      run: "OPENSLACK_GS3C_CROSS_LANGUAGE=1 go test ./internal/app -run '^TestGS3CRealGoReadAuthority$' -count=1",
    });
    expect(job.steps[gs6CrossLanguageIndex]).toEqual({
      name: 'Qualify GS6 official-SDK single-writer cutover',
      'working-directory': 'services/governance-control',
      run: gs6CrossLanguageRun(),
    });
    expect(job.steps[gs7bCrossLanguageIndex]).toEqual({
      name: 'Qualify GS7-B TypeScript-to-Go shadow observation',
      'working-directory': 'services/workflow-control',
      run: gs7bCrossLanguageRun(),
    });
    expect(job.steps[gs8bRunnerIndex]).toMatchObject({
      name: 'Qualify GS8-B real TypeScript runner lifecycle',
      'working-directory': 'services/workflow-control',
    });
    expect(job.steps[rootDocsIndex]).toEqual({
      name: 'Verify root documentation governance',
      'working-directory': '.',
      run: lines(
        'set -euo pipefail',
        'bun run docs:verify',
        'bun run docs:migration-check',
        'bun run docs:generate',
        'git diff --exit-code -- \\',
        '  memory_bank/t0_core/current_state.md \\',
        '  memory_bank/t0_core/release_state.md \\',
        '  memory_bank/t2_execution/current_roadmap.md \\',
        '  production/project-roadmap.md',
      ),
    });
    expect(job.steps[docsIndex]).toEqual({
      name: 'Verify notification delivery documentation',
      'working-directory': '.',
      run: 'bun run docs:notification-verify',
    });

    const actionUses = job.steps.flatMap((step) => (step.uses === undefined ? [] : [step.uses]));
    expect(actionUses).toEqual([checkoutAction, setupGoAction, setupNodeAction, setupBunAction]);
    expect(actionUses.every((action) => /@[0-9a-f]{40}$/u.test(action))).toBe(true);
  });

  it('keeps the wrapper as the single mechanical service gate', () => {
    const job = workflow.jobs.validate;
    expect(job.env).toEqual({
      EXPECTED_COMMIT: exactHeadExpression,
      GOWORK: 'off',
    });

    const expectedStepNames = [
      'Check out the exact source head',
      'Require the exact source head',
      'Set up the exact Go toolchain',
      'Require the exact Go toolchain',
      'Validate the notification workflows',
      'Set up the exact Node toolchain',
      'Set up the exact Bun toolchain',
      'Install root dependencies',
      'Verify Organization Graph golden contracts',
      'Verify Governance Control golden contracts',
      'Verify Workflow Control golden contracts',
      'Verify Workflow Control shadow golden contracts',
      'Verify Workflow Runner golden contracts',
      'Qualify the sealed TypeScript Workflow Runner on Linux',
      'Clean-build and smoke Organization Graph distribution',
      'Qualify GS3-A real Go read mirror',
      'Qualify GS3-B bounded Go read canary',
      'Qualify GS3-C global Go Graph read authority',
      'Pull pinned Go verification images',
      'Qualify GS6 official-SDK single-writer cutover',
      'Qualify GS7-B TypeScript-to-Go shadow observation',
      'Qualify GS8-B real TypeScript runner lifecycle',
      'Run reviewed Go workspace verifier',
      'Verify root documentation governance',
      'Verify notification delivery documentation',
      'Render the Compose configuration',
    ];
    expect(job.steps.map((step) => step.name)).toEqual(expectedStepNames);
    expect(new Set(expectedStepNames).size).toBe(expectedStepNames.length);

    const gs8bRunnerRun = job.steps.find(
      (step) => step.name === 'Qualify GS8-B real TypeScript runner lifecycle',
    )?.run;
    expect(gs8bRunnerRun).toEqual(expect.any(String));
    const expectedRuns: Record<string, string> = {
      'Require the exact source head': lines(
        'set -euo pipefail',
        `checkout_commit="$(git rev-parse --verify 'HEAD^{commit}')"`,
        'test "$checkout_commit" = "$EXPECTED_COMMIT"',
      ),
      'Require the exact Go toolchain': lines(
        'set -euo pipefail',
        'test "$(go env GOVERSION)" = "go1.26.5"',
        'test "$(go env GOWORK)" = "off"',
        'go work edit -json "$GITHUB_WORKSPACE/go.work" >/dev/null',
        'test -z "$(gofmt -l "$GITHUB_WORKSPACE/scripts/go-check/"*.go)"',
        '(',
        '  cd "$GITHUB_WORKSPACE/scripts/go-check"',
        '  GO111MODULE=off go test .',
        ')',
      ),
      'Validate the notification workflows':
        'go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/notification-delivery-service.yml .github/workflows/openslack-reusable-validate.yml',
      'Install root dependencies': 'bun install --frozen-lockfile',
      'Verify Organization Graph golden contracts': 'bun run graph:golden -- --check',
      'Verify Governance Control golden contracts': 'bun run governance:golden -- --check',
      'Verify Workflow Control golden contracts': 'bun run workflow:golden -- --check',
      'Verify Workflow Control shadow golden contracts':
        'bun run workflow:shadow-golden -- --check',
      'Verify Workflow Runner golden contracts': 'bun run workflow:runner-golden -- --check',
      'Qualify the sealed TypeScript Workflow Runner on Linux': lines(
        'set -euo pipefail',
        'bun run build',
        'bunx vitest run packages/workflows/src/__tests__/workflow-runner*.test.ts',
      ),
      'Clean-build and smoke Organization Graph distribution': lines(
        'set -euo pipefail',
        'bun run graph:dist-build',
        'bun run graph:dist-smoke',
      ),
      'Qualify GS3-A real Go read mirror':
        "OPENSLACK_GS3A_CROSS_LANGUAGE=1 go test ./internal/app -run '^TestGS3ARealGoReadMirror$' -count=1",
      'Qualify GS3-B bounded Go read canary':
        "OPENSLACK_GS3B_CROSS_LANGUAGE=1 go test ./internal/app -run '^TestGS3BRealGoReadCanary$' -count=1",
      'Qualify GS3-C global Go Graph read authority':
        "OPENSLACK_GS3C_CROSS_LANGUAGE=1 go test ./internal/app -run '^TestGS3CRealGoReadAuthority$' -count=1",
      'Pull pinned Go verification images': lines(
        'set -euo pipefail',
        `docker pull ${goImage}`,
        `docker pull ${postgresImage}`,
        `docker pull ${prometheusImage}`,
      ),
      'Qualify GS6 official-SDK single-writer cutover': gs6CrossLanguageRun(),
      'Qualify GS7-B TypeScript-to-Go shadow observation': gs7bCrossLanguageRun(),
      'Qualify GS8-B real TypeScript runner lifecycle': gs8bRunnerRun as string,
      'Run reviewed Go workspace verifier': 'bash scripts/go-check.sh --all',
      'Verify root documentation governance': lines(
        'set -euo pipefail',
        'bun run docs:verify',
        'bun run docs:migration-check',
        'bun run docs:generate',
        'git diff --exit-code -- \\',
        '  memory_bank/t0_core/current_state.md \\',
        '  memory_bank/t0_core/release_state.md \\',
        '  memory_bank/t2_execution/current_roadmap.md \\',
        '  production/project-roadmap.md',
      ),
      'Verify notification delivery documentation': 'bun run docs:notification-verify',
      'Render the Compose configuration':
        'docker compose --env-file deploy/local.env.example config >/dev/null',
    };
    const actualRuns = Object.fromEntries(
      job.steps.flatMap((step) =>
        step.run === undefined || step.name === undefined ? [] : [[step.name, step.run]],
      ),
    );
    expect(actualRuns).toEqual(expectedRuns);

    for (const step of job.steps) {
      if (step.uses !== undefined) {
        expect(Object.keys(step).sort()).toEqual(['name', 'uses', 'with']);
      } else if (step['working-directory'] !== undefined) {
        expect(Object.keys(step).sort()).toEqual(['name', 'run', 'working-directory']);
      } else {
        expect(Object.keys(step).sort()).toEqual(['name', 'run']);
      }
    }
  });

  it('binds the Workflow Runner contract step to a checked root script', () => {
    expect(rootPackage.scripts['workflow:runner-golden']).toBe(
      'bun scripts/workflow-runner-contracts/index.ts',
    );
    expect(rootPackage.scripts.typecheck).toContain(
      'tsc --noEmit -p scripts/workflow-runner-contracts/tsconfig.json',
    );
  });

  it('runs the non-skippable GS6 official-SDK single-writer contract against real Go HTTP', () => {
    const step = workflow.jobs.validate.steps.find(
      (candidate) => candidate.name === 'Qualify GS6 official-SDK single-writer cutover',
    );
    expect(step).toEqual({
      name: 'Qualify GS6 official-SDK single-writer cutover',
      'working-directory': 'services/governance-control',
      run: gs6CrossLanguageRun(),
    });
    expect(step?.run).toContain('OPENSLACK_GS6_CROSS_LANGUAGE=1');
    expect(step?.run).toContain("-run '^TestGS6CrossLanguageAuthorityCutover$'");
    expect(step?.run).toContain(`docker run --detach \\\n`);
    expect(step?.run).toContain(postgresImage);
    expect(step?.run).toContain('trap cleanup EXIT');
    expect(step?.run).toContain('export DATABASE_URL=');
    expect(step?.run).not.toMatch(/\|\|\s*true[^\n]*go test/iu);

    for (const name of [
      'OPENSLACK_GS6_AUTHORITY_ORIGIN',
      'OPENSLACK_GS6_AUTHORITY_BUILD_SHA',
      'OPENSLACK_GS6_AUTHORITY_CALLER_ID',
      'OPENSLACK_GS6_AUTHORITY_ROUTING_EPOCH',
      'OPENSLACK_GS6_AUTHORITY_WORKSPACE_ID',
    ]) {
      expect(gs6McpClientSource).toContain(name);
    }
    expect(gs6McpClientSource).toContain('mcpCommands(dependencies).parseAsync');
    expect(gs6McpClientSource).toContain('createOpenSlackAgentBoundMutationComposition(options)');
    expect(gs6McpClientSource).toContain('InMemoryTransport.createLinkedPair()');
    expect(gs6McpClientSource).toContain('createGovernanceAuthorityHttpClient({');
    expect(gs6McpClientSource).toContain('new LocalGovernedPlanStore');
    expect(gs6McpClientSource).toContain("record.status !== 'needs_confirmation'");
    expect(gs6McpClientSource).not.toContain("record.status !== 'awaiting_confirmation'");
    expect(gs6McpClientSource).toContain("schema: 'openslack.gs6_mcp_authority_qualification.v1'");
    expect(gs6McpClientSource).not.toMatch(
      /\b(?:vi\.|jest\.|mockImplementation|mockResolvedValue)\b/u,
    );

    const properties = pendingAuditSchema.properties as Record<
      string,
      { const?: unknown; enum?: unknown[] }
    >;
    const responseKeys = [
      'schema',
      'status',
      'workspaceId',
      'planId',
      'revision',
      'operation',
      'route',
      'recordHash',
      'serviceBuildSha',
    ];
    const operations = [
      'accept',
      'claim_execution',
      'complete_execution',
      'cancel',
      'expire',
      'require_reconciliation',
    ];
    expect(pendingAuditSchema.additionalProperties).toBe(false);
    expect((pendingAuditSchema.required as string[]).sort()).toEqual([...responseKeys].sort());
    expect(Object.keys(properties).sort()).toEqual([...responseKeys].sort());
    expect(properties.schema?.const).toBe('openslack.governance_authority_pending_audit.v1');
    expect(properties.status?.const).toBe('pending');
    expect(properties.operation?.enum).toEqual(operations);
    expect(properties).not.toHaveProperty('record');
    expect(properties).not.toHaveProperty('state');

    const manifest = authorityManifest as {
      transport: { pendingAuditRead: Record<string, unknown> };
      pendingAuditRecoverySemantics: Record<string, unknown>;
      semanticConstraints: string[];
      artifacts: Record<string, { byteLength: number; sha256: string }>;
    };
    expect(manifest.transport.pendingAuditRead).toEqual({
      method: 'GET',
      path: '/v1/governance/plans/{planId}/authority-events/{revision}:pending',
      headers: [
        'X-OpenSlack-Governance-Caller-ID',
        'X-OpenSlack-Governance-Workspace-ID',
        'X-OpenSlack-Governance-Routing-Epoch',
        'X-OpenSlack-Governance-Expected-Build-SHA',
      ],
      query: 'forbidden',
      body: 'forbidden',
    });
    expect(manifest.pendingAuditRecoverySemantics).toMatchObject({
      lookup: ['workspaceId', 'planId', 'revision'],
      status: 'pending',
      operations,
      atMostOnePendingPerPlan: true,
      pendingRevisionEqualsCurrentHead: true,
      nextTransitionBlockedWhilePending: true,
      authoritativeRecordLoadedSeparately: true,
      responseIncludesRecord: false,
      responseIncludesState: false,
      absentOrAlreadyRecorded: 404,
      routeEpochMismatch: 409,
      invalidBindingOrIdentity: 422,
      internalFailure: 500,
      unavailable: 503,
      restartRecovery: 'bounded-local-sidecar-enumeration-plus-point-read',
    });
    expect(manifest.semanticConstraints).toEqual(
      expect.arrayContaining([
        'at-most-one-pending-audit-delivery-per-plan',
        'pending-audit-revision-equals-current-authority-head',
        'next-transition-requires-current-revision-audit-delivery-recorded',
      ]),
    );
    const artifactPath = 'schemas/governance-authority-pending-audit.v1.schema.json';
    expect(manifest.artifacts[artifactPath]).toEqual({
      path: artifactPath,
      byteLength: pendingAuditSchemaBytes.length,
      sha256: createHash('sha256').update(pendingAuditSchemaBytes).digest('hex'),
    });
    expect(readFileSync(pendingAuditMirrorUrl)).toEqual(pendingAuditSchemaBytes);

    const recoveries = authorityGolden.pendingAuditRecoveries as Array<{
      request: { method: string; path: string; headers: Record<string, string> };
      response: Record<string, unknown>;
    }>;
    expect(recoveries).toHaveLength(2);
    expect(authorityGolden.pendingAuditRecoverySemantics).toMatchObject({
      atMostOnePendingPerPlan: true,
      pendingRevisionEqualsCurrentHead: true,
      nextTransitionBlockedWhilePending: true,
    });
    for (const recovery of recoveries) {
      expect(recovery.request.method).toBe('GET');
      expect(recovery.request.path).toMatch(
        /^\/v1\/governance\/plans\/GPLAN-[0-9a-f-]+\/authority-events\/[12]:pending$/u,
      );
      expect(Object.keys(recovery.request.headers)).toEqual([
        'X-OpenSlack-Governance-Caller-ID',
        'X-OpenSlack-Governance-Workspace-ID',
        'X-OpenSlack-Governance-Routing-Epoch',
        'X-OpenSlack-Governance-Expected-Build-SHA',
      ]);
      expect(Object.keys(recovery.response).sort()).toEqual([...responseKeys].sort());
      expect(recovery.response).not.toHaveProperty('record');
      expect(recovery.response).not.toHaveProperty('state');
    }
  });

  it('runs the non-skippable GS7-B TypeScript-to-Go shadow contract against PostgreSQL', () => {
    const step = workflow.jobs.validate.steps.find(
      (candidate) => candidate.name === 'Qualify GS7-B TypeScript-to-Go shadow observation',
    );
    expect(step).toEqual({
      name: 'Qualify GS7-B TypeScript-to-Go shadow observation',
      'working-directory': 'services/workflow-control',
      run: gs7bCrossLanguageRun(),
    });
    expect(step?.run).toContain('OPENSLACK_GS7B_CROSS_LANGUAGE=1');
    expect(step?.run).toContain("-run '^TestGS7BCrossLanguageShadowObservation$'");
    expect(step?.run).toContain(postgresImage);
    expect(step?.run).toContain('trap cleanup EXIT');
    expect(step?.run).toContain('export DATABASE_URL=');
    expect(step?.run).not.toMatch(/\|\|\s*true[^\n]*go test/iu);
  });

  it('qualifies the GS8-B sealed runner, durable restart, and default-off image boundary', () => {
    const linuxStep = workflow.jobs.validate.steps.find(
      (candidate) => candidate.name === 'Qualify GS8-B real TypeScript runner lifecycle',
    );
    expect(linuxStep).toMatchObject({
      name: 'Qualify GS8-B real TypeScript runner lifecycle',
      'working-directory': 'services/workflow-control',
    });
    for (const evidence of [
      'bun run build',
      'bun run --cwd packages/workflows build:runner-worker',
      'packages/workflows/dist/workflow-runner-worker-bundle.mjs',
      '"$bundle_root/workflow-runner-worker.js"',
      'runner-node',
      'workflow-runner-bundle.v1.json',
      '\\"runnerBuildHash\\":\\"${entrypoint_hash}\\"',
      '\\"entrypointMode\\":\\"first-argument\\"',
      'WORKFLOW_RUNNER_GS8B_BUNDLE_MANIFEST_SHA256',
      'go test ./internal/runnerstore/postgres -count=1',
      'WORKFLOW_RUNNER_GS8B_QUALIFICATION=1',
      "-run '^TestGS8BQualification$'",
      'WORKFLOW_RUNNER_GS8B_RESTART_PHASE=seed',
      'docker restart "$postgres_container"',
      'WORKFLOW_RUNNER_GS8B_RESTART_PHASE=verify',
    ]) {
      expect(linuxStep?.run).toContain(evidence);
    }
    expect(linuxStep?.run).toContain(postgresImage);
    expect(linuxStep?.run).toContain('trap cleanup EXIT');
    expect(
      linuxStep?.run?.match(/published="\$\(docker port "\$postgres_container" 5432\/tcp\)"/gu),
    ).toHaveLength(2);
    expect(linuxStep?.run).not.toContain('cp -R packages/workflows/dist');
    expect(linuxStep?.run).not.toMatch(/\|\|\s*true[^\n]*go test/iu);

    const windowsJob = workflow.jobs['workflow-runner-windows'];
    expect(windowsJob).toMatchObject({
      name: 'Qualify GS8-B runner on Windows',
      'runs-on': 'windows-2022',
      'timeout-minutes': 45,
      env: { EXPECTED_COMMIT: exactHeadExpression, GOWORK: 'off' },
    });
    expect(windowsJob.steps.map((step) => step.name)).toEqual([
      'Check out the exact source head',
      'Require the exact source head',
      'Set up the exact Go toolchain',
      'Set up the exact Node toolchain',
      'Set up the exact Bun toolchain',
      'Install and build the sealed TypeScript runner',
      'Qualify native Windows descriptor ACL and reparse boundaries',
      'Qualify native Windows Job Object process trees',
    ]);
    const windowsActions = windowsJob.steps.flatMap((step) =>
      step.uses === undefined ? [] : [step.uses],
    );
    expect(windowsActions).toEqual([
      checkoutAction,
      setupGoAction,
      setupNodeAction,
      setupBunAction,
    ]);
    expect(windowsActions.every((action) => /@[0-9a-f]{40}$/u.test(action))).toBe(true);
    const windowsTests = windowsJob.steps.find(
      (step) => step.name === 'Qualify native Windows descriptor ACL and reparse boundaries',
    )?.run;
    for (const file of [
      'workflow-runner-descriptor.test.ts',
      'workflow-runner-worker.test.ts',
      'workflow-runner-session.test.ts',
      'workflow-runner-cancellation-boundaries.test.ts',
      'workflow-runner-source-invariants.test.ts',
      'workflow-runner-execute.test.ts',
      'workflow-runner-framing.test.ts',
    ]) {
      expect(windowsTests).toContain(file);
    }
    const processTests = windowsJob.steps.find(
      (step) => step.name === 'Qualify native Windows Job Object process trees',
    )?.run;
    expect(processTests).toContain('go test ./internal/processsupervisor ./cmd/runner-server');
  });

  it('does not expand into deployment, external-input, or broad repository authority', () => {
    const serialized = JSON.stringify(workflow);
    expect(serialized).not.toMatch(/\$\{\{\s*secrets\./u);
    expect(serialized).not.toMatch(/"environment"\s*:/u);
    expect(serialized).not.toMatch(/self-hosted/iu);
    expect(serialized).not.toMatch(/write-all|id-token|contents["']?\s*:\s*["']?write/iu);
    expect(source).not.toMatch(/\bdocker\s+(?:login|push)\b/iu);
    expect(source).not.toMatch(/\bdocker\s+compose\s+up\b/iu);
    expect(source).not.toMatch(/\b(?:npm|npx|pnpm|yarn)\b/iu);
    expect(source).not.toMatch(/\b(?:curl|wget|gh|kubectl|helm|terraform|aws|az|gcloud)\b/iu);
    expect(source).not.toMatch(/\b(?:slack|webhook)\b/iu);
    expect(source).not.toContain('services/notification-delivery/.github/workflows/tests.yml');
  });

  it('runs the docs verifier beside status consistency in reusable validation', () => {
    const steps = reusableWorkflow.jobs.validate.steps;
    const regenerateIndex = steps.findIndex((step) => step.name === 'Regenerate status doc');
    const diffIndex = steps.findIndex(
      (step) => step.name === 'Check for uncommitted status changes',
    );
    const statusIndex = steps.findIndex((step) => step.name === 'Status consistency check');
    const docsIndex = steps.findIndex(
      (step) => step.name === 'Notification delivery documentation consistency',
    );
    const workspaceIndex = steps.findIndex((step) => step.name === 'Workspace validate');

    expect(regenerateIndex).toBeGreaterThan(-1);
    expect(diffIndex).toBe(regenerateIndex + 1);
    expect(statusIndex).toBe(diffIndex + 1);
    expect(docsIndex).toBe(statusIndex + 1);
    expect(workspaceIndex).toBe(docsIndex + 1);
    expect(steps[docsIndex]).toEqual({
      name: 'Notification delivery documentation consistency',
      run: 'bun run docs:notification-verify',
    });
    expect(reusableSource).toContain('run: bun run openslack status generate');
    expect(reusableSource).toContain('run: git diff --exit-code docs/status/current.md');
    expect(reusableSource).toContain('run: bun run openslack status verify');
  });
});
