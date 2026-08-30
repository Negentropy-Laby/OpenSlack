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
const workflowControlPostgresGateUrl = new URL(
  '../../../../scripts/qualification/workflow-control-postgres-gate.sh',
  import.meta.url,
);
const workflowControlPostgresGateSource = readFileSync(workflowControlPostgresGateUrl, 'utf8');
const gs9eQualificationFixture = Object.fromEntries(
  readFileSync(
    new URL(
      '../../../../services/workflow-control/testdata/gs9e-qualification.conf',
      import.meta.url,
    ),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => line.split('=', 2) as [string, string]),
);
const rootPackageUrl = new URL('../../../../package.json', import.meta.url);
const rootPackage = JSON.parse(readFileSync(rootPackageUrl, 'utf8')) as {
  scripts: Record<string, string>;
};
const workflowContractFamilyRegistry = JSON.parse(
  readFileSync(
    new URL('../../../../scripts/workflow-contract-families.json', import.meta.url),
    'utf8',
  ),
) as {
  schema: string;
  families: Array<{ id: string; generator: string; tsconfig: string }>;
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
  'packages/agent-runtime/src/adapter.ts',
  'packages/agent-runtime/src/index.ts',
  'packages/agent-runtime/src/launcher.ts',
  'packages/agent-runtime/src/openai-compatible-runtime.ts',
  'packages/agent-runtime/src/provider-usage-evidence.ts',
  'packages/agent-runtime/src/types.ts',
  'packages/agent-runtime/src/__tests__/launcher.test.ts',
  'packages/agent-runtime/src/__tests__/openai-compatible-runtime.test.ts',
  'packages/agent-runtime/src/__tests__/provider-usage-evidence.test.ts',
  'packages/organization-graph/**',
  'packages/operator/contracts/governed-plan/**',
  'packages/operator/contracts/governed-plan-authority/**',
  'packages/operator/src/governed-plan*.ts',
  'packages/workflows/contracts/workflow-*/**',
  'packages/workflows/src/workflow-control-contract.ts',
  'packages/workflows/src/workflow-control-authority-contract.ts',
  'packages/workflows/src/workflow-budget-authority-contract.ts',
  'packages/workflows/src/workflow-control-observation.ts',
  'packages/workflows/src/workflow-control-shadow*.ts',
  'packages/workflows/src/workflow-checkpoint-shadow*.ts',
  'packages/workflows/src/workflow-effect-*.ts',
  'packages/workflows/src/internal/workflow-effect-*.ts',
  'packages/workflows/src/__tests__/workflow-control-contract.test.ts',
  'packages/workflows/src/__tests__/workflow-control-authority-contract.test.ts',
  'packages/workflows/src/__tests__/workflow-budget-authority-contract.test.ts',
  'packages/workflows/src/__tests__/workflow-control-shadow*.ts',
  'packages/workflows/src/__tests__/workflow-checkpoint-shadow*.test.ts',
  'packages/workflows/src/__tests__/workflow-effect-*.test.ts',
  'packages/workflows/src/workflow-runner-contract.ts',
  'packages/workflows/src/workflow-runner*.ts',
  'packages/workflows/src/__tests__/workflow-runner*.test.ts',
  'packages/workflows/src/agent-shim.ts',
  'packages/workflows/src/execute.ts',
  'packages/workflows/src/loader.ts',
  'packages/workflows/src/runtime.ts',
  'packages/workflows/src/run-store.ts',
  'packages/workflows/src/workflow-runs.ts',
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
  'scripts/workflow-*-contracts/**',
  'scripts/workflow-contract-families.json',
  'scripts/workflow-contract-families.generated.sh',
  'scripts/workflow-contract-families/**',
  'scripts/qualification/workflow-control-postgres-gate.sh',
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

function gs9bAuthorityRun(): string {
  return 'bash scripts/qualification/workflow-control-postgres-gate.sh gs9b-authority';
}

function gs9cCheckpointRun(): string {
  return 'bash scripts/qualification/workflow-control-postgres-gate.sh gs9c-checkpoint';
}

function gs9dEffectRun(): string {
  return 'bash scripts/qualification/workflow-control-postgres-gate.sh gs9d-effect';
}

function gs9eBudgetRun(): string {
  return 'bash scripts/qualification/workflow-control-postgres-gate.sh gs9e-budget';
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
    const workflowContractFamiliesIndex = stepIndex(
      'Verify Workflow contract family golden contracts',
    );
    const workflowAuthorityTsIndex = stepIndex('Qualify GS9-A TypeScript authority contract');
    const workflowAuthorityGoIndex = stepIndex('Qualify GS9-A Go authority contract mirror');
    const workflowBudgetTsIndex = stepIndex(
      'Qualify GS9-E1 TypeScript budget operational contract',
    );
    const workflowBudgetGoIndex = stepIndex('Qualify GS9-E1 Go budget contract mirror');
    const workflowCheckpointTsIndex = stepIndex('Qualify GS9-C TypeScript checkpoint shadow');
    const workflowEffectTsIndex = stepIndex('Qualify GS9-D TypeScript effect decision observer');
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
    const gs9bAuthorityIndex = stepIndex('Qualify GS9-B Workflow Control authority');
    const gs9cCheckpointIndex = stepIndex('Qualify GS9-C Workflow checkpoint shadow');
    const gs9dEffectIndex = stepIndex('Qualify GS9-D Workflow effect shadow');
    const gs9eBudgetIndex = stepIndex('Qualify GS9-E Workflow budget authority');
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
    expect(workflowContractFamiliesIndex).toBe(governanceGoldenIndex + 1);
    expect(workflowAuthorityTsIndex).toBe(workflowContractFamiliesIndex + 1);
    expect(workflowAuthorityGoIndex).toBe(workflowAuthorityTsIndex + 1);
    expect(workflowBudgetTsIndex).toBe(workflowAuthorityGoIndex + 1);
    expect(workflowBudgetGoIndex).toBe(workflowBudgetTsIndex + 1);
    expect(workflowCheckpointTsIndex).toBe(workflowBudgetGoIndex + 1);
    expect(workflowEffectTsIndex).toBe(workflowCheckpointTsIndex + 1);
    expect(workflowRunnerLinuxIndex).toBe(workflowEffectTsIndex + 1);
    expect(graphDistIndex).toBe(workflowRunnerLinuxIndex + 1);
    expect(graphMirrorIndex).toBe(graphDistIndex + 1);
    expect(graphCanaryIndex).toBe(graphMirrorIndex + 1);
    expect(graphAuthorityIndex).toBe(graphCanaryIndex + 1);
    expect(imagePullIndex).toBe(graphAuthorityIndex + 1);
    expect(gs6CrossLanguageIndex).toBe(imagePullIndex + 1);
    expect(gs7bCrossLanguageIndex).toBe(gs6CrossLanguageIndex + 1);
    expect(gs8bRunnerIndex).toBe(gs7bCrossLanguageIndex + 1);
    expect(gs9bAuthorityIndex).toBe(gs8bRunnerIndex + 1);
    expect(gs9cCheckpointIndex).toBe(gs9bAuthorityIndex + 1);
    expect(gs9dEffectIndex).toBe(gs9cCheckpointIndex + 1);
    expect(gs9eBudgetIndex).toBe(gs9dEffectIndex + 1);
    expect(goCheckIndex).toBe(gs9eBudgetIndex + 1);
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
    expect(job.steps[workflowContractFamiliesIndex]).toEqual({
      name: 'Verify Workflow contract family golden contracts',
      'working-directory': '.',
      run: 'bun run workflow:contract-families -- --check',
    });
    expect(job.steps[workflowAuthorityTsIndex]).toEqual({
      name: 'Qualify GS9-A TypeScript authority contract',
      'working-directory': '.',
      run: 'bunx vitest run packages/workflows/src/__tests__/workflow-control-authority-contract.test.ts',
    });
    expect(job.steps[workflowAuthorityGoIndex]).toEqual({
      name: 'Qualify GS9-A Go authority contract mirror',
      'working-directory': 'services/workflow-control',
      run: 'go test -race ./authoritycontract -count=1',
    });
    expect(job.steps[workflowBudgetTsIndex]).toEqual({
      name: 'Qualify GS9-E1 TypeScript budget operational contract',
      'working-directory': '.',
      run: lines(
        'set -euo pipefail',
        'bun run build',
        'bunx vitest run \\',
        '  packages/workflows/src/__tests__/workflow-budget-authority-contract.test.ts \\',
        '  packages/agent-runtime/src/__tests__/provider-usage-evidence.test.ts \\',
        '  packages/agent-runtime/src/__tests__/openai-compatible-runtime.test.ts \\',
        '  packages/agent-runtime/src/__tests__/launcher.test.ts',
      ),
    });
    expect(job.steps[workflowBudgetGoIndex]).toEqual({
      name: 'Qualify GS9-E1 Go budget contract mirror',
      'working-directory': 'services/workflow-control',
      run: 'go test -race ./budgetcontract -count=1',
    });
    expect(job.steps[workflowCheckpointTsIndex]).toEqual({
      name: 'Qualify GS9-C TypeScript checkpoint shadow',
      'working-directory': '.',
      run: lines(
        'set -euo pipefail',
        'bun run build',
        'bunx vitest run \\',
        '  packages/workflows/src/__tests__/workflow-checkpoint-shadow.test.ts \\',
        '  packages/workflows/src/__tests__/workflow-runner-session.test.ts \\',
        '  packages/workflows/src/__tests__/workflow-runner-worker.test.ts \\',
        '  packages/workflows/src/__tests__/run-store.test.ts',
      ),
    });
    expect(job.steps[workflowEffectTsIndex]).toEqual({
      name: 'Qualify GS9-D TypeScript effect decision observer',
      'working-directory': '.',
      run: lines(
        'set -euo pipefail',
        'bun run build',
        'bunx vitest run \\',
        '  packages/workflows/src/__tests__/workflow-effect-control-contract.test.ts \\',
        '  packages/workflows/src/__tests__/workflow-effect-authorization.test.ts \\',
        '  packages/workflows/src/__tests__/workflow-effect-shadow.test.ts \\',
        '  packages/workflows/src/__tests__/workflow-runner-worker.test.ts',
      ),
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
    expect(job.steps[gs9bAuthorityIndex]).toEqual({
      name: 'Qualify GS9-B Workflow Control authority',
      'working-directory': '.',
      run: gs9bAuthorityRun(),
    });
    expect(job.steps[gs9cCheckpointIndex]).toEqual({
      name: 'Qualify GS9-C Workflow checkpoint shadow',
      'working-directory': '.',
      run: gs9cCheckpointRun(),
    });
    expect(job.steps[gs9dEffectIndex]).toEqual({
      name: 'Qualify GS9-D Workflow effect shadow',
      'working-directory': '.',
      run: gs9dEffectRun(),
    });
    expect(job.steps[gs9eBudgetIndex]).toEqual({
      name: 'Qualify GS9-E Workflow budget authority',
      'working-directory': '.',
      run: gs9eBudgetRun(),
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
      'Verify Workflow contract family golden contracts',
      'Qualify GS9-A TypeScript authority contract',
      'Qualify GS9-A Go authority contract mirror',
      'Qualify GS9-E1 TypeScript budget operational contract',
      'Qualify GS9-E1 Go budget contract mirror',
      'Qualify GS9-C TypeScript checkpoint shadow',
      'Qualify GS9-D TypeScript effect decision observer',
      'Qualify the sealed TypeScript Workflow Runner on Linux',
      'Clean-build and smoke Organization Graph distribution',
      'Qualify GS3-A real Go read mirror',
      'Qualify GS3-B bounded Go read canary',
      'Qualify GS3-C global Go Graph read authority',
      'Pull pinned Go verification images',
      'Qualify GS6 official-SDK single-writer cutover',
      'Qualify GS7-B TypeScript-to-Go shadow observation',
      'Qualify GS8-B real TypeScript runner lifecycle',
      'Qualify GS9-B Workflow Control authority',
      'Qualify GS9-C Workflow checkpoint shadow',
      'Qualify GS9-D Workflow effect shadow',
      'Qualify GS9-E Workflow budget authority',
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
      'Verify Workflow contract family golden contracts':
        'bun run workflow:contract-families -- --check',
      'Qualify GS9-A TypeScript authority contract':
        'bunx vitest run packages/workflows/src/__tests__/workflow-control-authority-contract.test.ts',
      'Qualify GS9-A Go authority contract mirror': 'go test -race ./authoritycontract -count=1',
      'Qualify GS9-E1 TypeScript budget operational contract': lines(
        'set -euo pipefail',
        'bun run build',
        'bunx vitest run \\',
        '  packages/workflows/src/__tests__/workflow-budget-authority-contract.test.ts \\',
        '  packages/agent-runtime/src/__tests__/provider-usage-evidence.test.ts \\',
        '  packages/agent-runtime/src/__tests__/openai-compatible-runtime.test.ts \\',
        '  packages/agent-runtime/src/__tests__/launcher.test.ts',
      ),
      'Qualify GS9-E1 Go budget contract mirror': 'go test -race ./budgetcontract -count=1',
      'Qualify GS9-C TypeScript checkpoint shadow': lines(
        'set -euo pipefail',
        'bun run build',
        'bunx vitest run \\',
        '  packages/workflows/src/__tests__/workflow-checkpoint-shadow.test.ts \\',
        '  packages/workflows/src/__tests__/workflow-runner-session.test.ts \\',
        '  packages/workflows/src/__tests__/workflow-runner-worker.test.ts \\',
        '  packages/workflows/src/__tests__/run-store.test.ts',
      ),
      'Qualify GS9-D TypeScript effect decision observer': lines(
        'set -euo pipefail',
        'bun run build',
        'bunx vitest run \\',
        '  packages/workflows/src/__tests__/workflow-effect-control-contract.test.ts \\',
        '  packages/workflows/src/__tests__/workflow-effect-authorization.test.ts \\',
        '  packages/workflows/src/__tests__/workflow-effect-shadow.test.ts \\',
        '  packages/workflows/src/__tests__/workflow-runner-worker.test.ts',
      ),
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
      'Qualify GS9-B Workflow Control authority': gs9bAuthorityRun(),
      'Qualify GS9-C Workflow checkpoint shadow': gs9cCheckpointRun(),
      'Qualify GS9-D Workflow effect shadow': gs9dEffectRun(),
      'Qualify GS9-E Workflow budget authority': gs9eBudgetRun(),
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

  it('binds every Workflow contract family to the checked root registry', () => {
    expect(workflowContractFamilyRegistry.schema).toBe(
      'openslack.workflow_contract_family_registry.v1',
    );
    expect(workflowContractFamilyRegistry.families.map((family) => family.id)).toEqual([
      'workflow-control',
      'workflow-authority',
      'workflow-budget-authority',
      'workflow-control-shadow',
      'workflow-checkpoint-shadow',
      'workflow-effect-control',
      'workflow-effect-shadow',
      'workflow-runner',
      'workflow-runner-authority-binding',
    ]);
    expect(rootPackage.scripts['workflow:contract-families']).toBe(
      'bun scripts/workflow-contract-families/index.ts',
    );
    expect(rootPackage.scripts.typecheck).toContain(
      'bun run workflow:contract-families -- --typecheck',
    );
    expect(rootPackage.scripts.typecheck).toContain(
      'bun run workflow:contract-families -- --check',
    );
    for (const family of workflowContractFamilyRegistry.families) {
      expect(family.tsconfig).toBe(family.generator.replace(/index\.ts$/u, 'tsconfig.json'));
    }
    expect(rootPackage.scripts['workflow:runner-golden']).toBe(
      'bun scripts/workflow-runner-contracts/index.ts',
    );
    expect(rootPackage.scripts['workflow:runner-authority-binding-golden']).toBe(
      'bun scripts/workflow-runner-authority-binding-contracts/index.ts',
    );
    expect(rootPackage.scripts['workflow:authority-golden']).toBe(
      'bun scripts/workflow-authority-contracts/index.ts',
    );
    expect(rootPackage.scripts['workflow:budget-authority-golden']).toBe(
      'bun scripts/workflow-budget-authority-contracts/index.ts',
    );
    expect(rootPackage.scripts['workflow:checkpoint-shadow-golden']).toBe(
      'bun scripts/workflow-checkpoint-shadow-contracts/index.ts',
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
      'packages/workflows/dist/workflow-runner-worker-bundle.cjs',
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
      name: 'Qualify GS8-B and GS9-F2b runtime delivery boundaries on Windows',
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
      'Qualify native Windows runner and GS9-F2b TypeScript boundaries',
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
      (step) => step.name === 'Qualify native Windows runner and GS9-F2b TypeScript boundaries',
    )?.run;
    for (const file of [
      'workflow-runner-descriptor.test.ts',
      'workflow-runner-worker.test.ts',
      'workflow-runner-session.test.ts',
      'workflow-runner-cancellation-boundaries.test.ts',
      'workflow-runner-source-invariants.test.ts',
      'workflow-runner-execute.test.ts',
      'workflow-runner-framing.test.ts',
      'workflow-runner-v2-foundation.test.ts',
      'workflow-runner-v2-session.test.ts',
      'workflow-runner-authority-binding-contract.test.ts',
      'workflow-runner-authority-binding-runtime.test.ts',
      'openai-compatible-runtime.test.ts',
      'workflow-effect-shadow.test.ts',
    ]) {
      expect(windowsTests).toContain(file);
    }
    for (const gs9f2bSuite of [
      'packages/workflows/src/__tests__/workflow-runner-v2-foundation.test.ts',
      'packages/workflows/src/__tests__/workflow-runner-v2-session.test.ts',
      'packages/workflows/src/__tests__/workflow-runner-authority-binding-contract.test.ts',
      'packages/workflows/src/__tests__/workflow-runner-authority-binding-runtime.test.ts',
      'packages/agent-runtime/src/__tests__/openai-compatible-runtime.test.ts',
    ]) {
      expect(windowsTests).toContain(gs9f2bSuite);
    }
    const processTests = windowsJob.steps.find(
      (step) => step.name === 'Qualify native Windows Job Object process trees',
    )?.run;
    expect(processTests).toContain('go test ./internal/processsupervisor ./cmd/runner-server');
  });

  it('qualifies the GS9-B authority store and server against pinned PostgreSQL without weakening earlier gates', () => {
    const step = workflow.jobs.validate.steps.find(
      (candidate) => candidate.name === 'Qualify GS9-B Workflow Control authority',
    );
    expect(step).toEqual({
      name: 'Qualify GS9-B Workflow Control authority',
      'working-directory': '.',
      run: gs9bAuthorityRun(),
    });
    for (const evidence of [
      postgresImage,
      'trap cleanup EXIT',
      'WORKFLOW_CONTROL_AUTHORITY_MODE=local-qualification-v1',
      'WORKFLOW_CONTROL_AUTHORITY_ROUTING_EPOCH=9',
      'export GOWORK=off',
      'go test -race ./internal/authorityapp',
      './internal/authorityapp',
      './internal/authoritystore/...',
      './internal/config',
      './tests/contracts',
      './tests/integration',
      '-count=1',
      'WORKFLOW_CONTROL_GS9B_QUALIFICATION=1',
      "-run '^TestGS9BQualification$'",
      'WORKFLOW_CONTROL_GS9B_RESTART_PHASE=seed',
      'docker restart "$postgres_container"',
      'WORKFLOW_CONTROL_GS9B_RESTART_PHASE=verify',
    ]) {
      expect(workflowControlPostgresGateSource).toContain(evidence);
    }
    expect(
      workflowControlPostgresGateSource.match(
        /published="\$\(docker port "\$postgres_container" 5432\/tcp\)"/gu,
      ),
    ).toHaveLength(1);
    expect(workflowControlPostgresGateSource).not.toMatch(/\|\|\s*true[^\n]*go test/iu);
    expect(workflowControlPostgresGateSource).toContain(
      'usage: workflow-control-postgres-gate.sh {gs9b-authority|gs9c-checkpoint|gs9d-effect|gs9e-budget}',
    );

    const names = workflow.jobs.validate.steps.map((candidate) => candidate.name);
    expect(names.indexOf('Qualify GS8-B real TypeScript runner lifecycle')).toBeLessThan(
      names.indexOf('Qualify GS9-B Workflow Control authority'),
    );
    expect(names.indexOf('Qualify GS9-B Workflow Control authority')).toBeLessThan(
      names.indexOf('Run reviewed Go workspace verifier'),
    );
  });

  it('qualifies the GS9-C checkpoint shadow against pinned PostgreSQL without transferring authority', () => {
    const step = workflow.jobs.validate.steps.find(
      (candidate) => candidate.name === 'Qualify GS9-C Workflow checkpoint shadow',
    );
    expect(step).toEqual({
      name: 'Qualify GS9-C Workflow checkpoint shadow',
      'working-directory': '.',
      run: gs9cCheckpointRun(),
    });
    for (const evidence of [
      postgresImage,
      'trap cleanup EXIT',
      'WORKFLOW_CONTROL_CHECKPOINT_SHADOW_MODE=local-qualification-v1',
      'WORKFLOW_CONTROL_CHECKPOINT_SHADOW_HTTP_BIND=127.0.0.1:8083',
      './internal/checkpointshadowapp',
      './internal/checkpointshadowstore/...',
      './tests/contracts',
      './tests/integration',
      'WORKFLOW_CONTROL_GS9C_QUALIFICATION=1',
      "-run '^TestGS9CQualification$'",
      'WORKFLOW_CONTROL_GS9C_RESTART_PHASE=seed',
      'docker restart "$postgres_container"',
      'WORKFLOW_CONTROL_GS9C_RESTART_PHASE=verify',
    ]) {
      expect(workflowControlPostgresGateSource).toContain(evidence);
    }
    expect(
      workflowControlPostgresGateSource.match(
        /published="\$\(docker port "\$postgres_container" 5432\/tcp\)"/gu,
      ),
    ).toHaveLength(1);
    expect(workflowControlPostgresGateSource).not.toMatch(
      /accept_new_records|accept-new-records/iu,
    );

    const names = workflow.jobs.validate.steps.map((candidate) => candidate.name);
    expect(names.indexOf('Qualify GS9-B Workflow Control authority')).toBeLessThan(
      names.indexOf('Qualify GS9-C Workflow checkpoint shadow'),
    );
    expect(names.indexOf('Qualify GS9-C Workflow checkpoint shadow')).toBeLessThan(
      names.indexOf('Run reviewed Go workspace verifier'),
    );
  });

  it('qualifies the GS9-D effect shadow against pinned PostgreSQL without transferring authority', () => {
    const step = workflow.jobs.validate.steps.find(
      (candidate) => candidate.name === 'Qualify GS9-D Workflow effect shadow',
    );
    expect(step).toEqual({
      name: 'Qualify GS9-D Workflow effect shadow',
      'working-directory': '.',
      run: gs9dEffectRun(),
    });
    for (const evidence of [
      postgresImage,
      'trap cleanup EXIT',
      'WORKFLOW_CONTROL_EFFECT_SHADOW_MODE=local-qualification-v1',
      'WORKFLOW_CONTROL_EFFECT_SHADOW_HTTP_BIND=127.0.0.1:8084',
      './internal/effectshadowapp',
      './internal/effectshadowstore/...',
      './tests/contracts',
      './tests/integration',
      'WORKFLOW_CONTROL_GS9D_QUALIFICATION=1',
      "-run '^TestGS9DQualification$'",
      'WORKFLOW_CONTROL_GS9D_RESTART_PHASE=seed',
      'docker restart "$postgres_container"',
      'WORKFLOW_CONTROL_GS9D_RESTART_PHASE=verify',
    ]) {
      expect(workflowControlPostgresGateSource).toContain(evidence);
    }
    expect(workflowControlPostgresGateSource).not.toMatch(
      /effect_authori[sz]ed|accept_new_records|accept-new-records/iu,
    );

    const names = workflow.jobs.validate.steps.map((candidate) => candidate.name);
    expect(names.indexOf('Qualify GS9-C Workflow checkpoint shadow')).toBeLessThan(
      names.indexOf('Qualify GS9-D Workflow effect shadow'),
    );
    expect(names.indexOf('Qualify GS9-D Workflow effect shadow')).toBeLessThan(
      names.indexOf('Run reviewed Go workspace verifier'),
    );
  });

  it('qualifies the GS9-E budget authority against pinned PostgreSQL without production cutover', () => {
    const step = workflow.jobs.validate.steps.find(
      (candidate) => candidate.name === 'Qualify GS9-E Workflow budget authority',
    );
    expect(step).toEqual({
      name: 'Qualify GS9-E Workflow budget authority',
      'working-directory': '.',
      run: gs9eBudgetRun(),
    });
    for (const evidence of [
      postgresImage,
      'trap cleanup EXIT',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE=local-qualification-v1',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_HTTP_BIND=127.0.0.1:8085',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS',
      'services/workflow-control/testdata/gs9e-qualification.conf',
      './internal/budgetapp',
      './internal/budgetstore/...',
      './tests/contracts',
      './tests/integration',
      'WORKFLOW_CONTROL_GS9E_QUALIFICATION=1',
      "-run '^TestGS9EQualification$'",
      'WORKFLOW_CONTROL_GS9E_RESTART_PHASE=seed',
      'docker restart "$postgres_container"',
      'WORKFLOW_CONTROL_GS9E_RESTART_PHASE=verify',
    ]) {
      expect(workflowControlPostgresGateSource).toContain(evidence);
    }
    expect(Object.keys(gs9eQualificationFixture).sort()).toEqual([
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_BEARER_TOKEN_SHA256',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_CALLER_ID',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA',
      'WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID',
    ]);
    expect(workflowControlPostgresGateSource).not.toMatch(
      /runner.?v2.*(?:enabled|delivered)|accept_new_records|accept-new-records/iu,
    );

    const names = workflow.jobs.validate.steps.map((candidate) => candidate.name);
    expect(names.indexOf('Qualify GS9-D Workflow effect shadow')).toBeLessThan(
      names.indexOf('Qualify GS9-E Workflow budget authority'),
    );
    expect(names.indexOf('Qualify GS9-E Workflow budget authority')).toBeLessThan(
      names.indexOf('Run reviewed Go workspace verifier'),
    );
  });

  it('qualifies GS9-F2b once through the reviewed all-workspace Go verifier', () => {
    const goChecks = workflow.jobs.validate.steps.filter((candidate) =>
      candidate.run?.includes('scripts/go-check.sh'),
    );
    expect(goChecks).toEqual([
      {
        name: 'Run reviewed Go workspace verifier',
        'working-directory': '.',
        run: 'bash scripts/go-check.sh --all',
      },
    ]);
  });

  it('binds the shared PostgreSQL gate to the four reviewed profiles', () => {
    expect(workflowControlPostgresGateSource).toContain(
      'gs9b-authority|gs9c-checkpoint|gs9d-effect|gs9e-budget) ;;',
    );
    expect(workflowControlPostgresGateSource).toContain('exit 2');
    expect(workflowControlPostgresGateSource).toContain('for attempt in $(seq 1 60)');
    expect(workflowControlPostgresGateSource).toContain('docker restart "$postgres_container"');
    expect(workflowControlPostgresGateSource).toContain('refresh_database_url');
    expect(workflowControlPostgresGateSource.match(/refresh_database_url/gu)).toHaveLength(3);
    expect(workflowControlPostgresGateSource).not.toContain('eval ');
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
