import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type WorkflowStep = {
  name?: string;
  run?: string;
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
      services: {
        postgres: {
          image: string;
          env: Record<string, string>;
          ports: string[];
          options: string;
        };
      };
      env: Record<string, string>;
      permissions?: unknown;
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

const checkoutAction = 'actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd';
const setupGoAction = 'actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16';
const setupBunAction = 'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6';
const postgresImage =
  'postgres:18.4@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a';
const prometheusImage =
  'prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893';
const exactHeadExpression = '${{ github.event.pull_request.head.sha || github.sha }}';
const triggerPaths = [
  'services/notification-delivery/**',
  'README.md',
  'docs/README.md',
  'design/cdd/module-index.md',
  'design/cdd/workstreams/notification-delivery/README.md',
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
  'scripts/documentation/**',
  'scripts/notification-docs/**',
  '.github/workflows/notification-delivery-service.yml',
  '.github/workflows/openslack-reusable-validate.yml',
  'packages/github/src/__tests__/notification-delivery-service-workflow.test.ts',
];

function stepIndex(name: string): number {
  return workflow.jobs.validate.steps.findIndex((step) => step.name === name);
}

function lines(...values: string[]): string {
  return `${values.join('\n')}\n`;
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
    expect(Object.keys(workflow.jobs)).toEqual(['validate']);

    const job = workflow.jobs.validate;
    expect(Object.keys(job).sort()).toEqual([
      'defaults',
      'env',
      'name',
      'runs-on',
      'services',
      'steps',
      'timeout-minutes',
    ]);
    expect(job).not.toHaveProperty('permissions');
    expect(job.name).toBe('Validate notification delivery service');
    expect(job['runs-on']).toBe('ubuntu-24.04');
    expect(job['timeout-minutes']).toBe(60);
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
    const setupBunIndex = job.steps.findIndex((step) => step.uses === setupBunAction);
    const installIndex = stepIndex('Install root dependencies');
    const rootDocsIndex = stepIndex('Verify root documentation governance');
    const docsIndex = stepIndex('Verify notification delivery documentation');
    const firstServiceCommandIndex = stepIndex('Verify module files');

    expect(checkoutIndex).toBe(0);
    expect(headGuardIndex).toBe(checkoutIndex + 1);
    expect(setupGoIndex).toBe(headGuardIndex + 1);
    expect(goGuardIndex).toBe(setupGoIndex + 1);
    expect(actionlintIndex).toBe(goGuardIndex + 1);
    expect(setupBunIndex).toBe(actionlintIndex + 1);
    expect(installIndex).toBe(setupBunIndex + 1);
    expect(rootDocsIndex).toBe(installIndex + 1);
    expect(docsIndex).toBe(rootDocsIndex + 1);
    expect(firstServiceCommandIndex).toBe(docsIndex + 1);
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
      'cache-dependency-path': 'services/notification-delivery/go.sum',
    });
    expect(job.steps[goGuardIndex]?.run).toContain('test "$(go env GOVERSION)" = "go1.26.5"');
    expect(job.steps[actionlintIndex]).toMatchObject({
      'working-directory': '.',
      run: 'go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/notification-delivery-service.yml .github/workflows/openslack-reusable-validate.yml',
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
    expect(actionUses).toEqual([checkoutAction, setupGoAction, setupBunAction]);
    expect(actionUses.every((action) => /@[0-9a-f]{40}$/u.test(action))).toBe(true);
  });

  it('pins the database and validates every inherited service build contract', () => {
    const job = workflow.jobs.validate;
    expect(job.services.postgres).toEqual({
      image: postgresImage,
      env: {
        POSTGRES_USER: 'rc_wsman',
        POSTGRES_PASSWORD: 'rc_wsman',
        POSTGRES_DB: 'rc_wsman',
      },
      ports: ['5432:5432'],
      options:
        '--health-cmd "pg_isready -U rc_wsman -d rc_wsman" --health-interval 5s --health-timeout 5s --health-retries 12',
    });
    expect(job.env).toEqual({
      EXPECTED_COMMIT: exactHeadExpression,
      DATABASE_URL: 'postgres://rc_wsman:rc_wsman@localhost:5432/rc_wsman?sslmode=disable',
      MIGRATION_DATABASE_URL: 'pgx5://rc_wsman:rc_wsman@localhost:5432/rc_wsman?sslmode=disable',
      NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST:
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      API_KEY_PEPPER_ACTIVE: '{"id":"v1","value":"ci-active-pepper"}',
      API_KEY_PEPPER_PREVIOUS: '{"id":"v0","value":"ci-previous-pepper"}',
      ENV_CREDENTIAL_ALLOWLIST: 'VENDOR_TEST_TOKEN',
    });

    const expectedStepNames = [
      'Check out the exact source head',
      'Require the exact source head',
      'Set up the exact Go toolchain',
      'Require the exact Go toolchain',
      'Validate the notification workflows',
      'Set up the exact Bun toolchain',
      'Install root dependencies',
      'Verify root documentation governance',
      'Verify notification delivery documentation',
      'Verify module files',
      'Verify Go formatting',
      'Build all packages',
      'Migrate the test database',
      'Vet all packages',
      'Run race tests',
      'Run race-test stability loop',
      'Render the Compose configuration',
      'Validate the Prometheus configuration',
      'Test the Prometheus rules',
      'Build the production image',
    ];
    expect(job.steps.map((step) => step.name)).toEqual(expectedStepNames);
    expect(new Set(expectedStepNames).size).toBe(expectedStepNames.length);

    const expectedRuns: Record<string, string> = {
      'Require the exact source head': lines(
        'set -euo pipefail',
        `checkout_commit="$(git rev-parse --verify 'HEAD^{commit}')"`,
        'test "$checkout_commit" = "$EXPECTED_COMMIT"',
      ),
      'Require the exact Go toolchain': lines(
        'set -euo pipefail',
        'test "$(go env GOVERSION)" = "go1.26.5"',
      ),
      'Validate the notification workflows':
        'go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 .github/workflows/notification-delivery-service.yml .github/workflows/openslack-reusable-validate.yml',
      'Install root dependencies': 'bun install --frozen-lockfile',
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
      'Verify module files': lines(
        'set -euo pipefail',
        'go mod tidy',
        'git diff --exit-code -- go.mod go.sum',
      ),
      'Verify Go formatting': lines(
        'set -euo pipefail',
        'unformatted="$(gofmt -l .)"',
        'if [ -n "$unformatted" ]; then',
        `  printf '%s\\n' "$unformatted"`,
        '  exit 1',
        'fi',
      ),
      'Build all packages': 'go build ./...',
      'Migrate the test database': lines(
        'set -euo pipefail',
        "go install -tags 'pgx5' github.com/golang-migrate/migrate/v4/cmd/migrate@v4.18.1",
        'migrate -path migrations -database "$MIGRATION_DATABASE_URL" up',
      ),
      'Vet all packages': 'go vet ./...',
      'Run race tests': 'go test -race ./...',
      'Run race-test stability loop': 'go test -race ./... -count=5',
      'Render the Compose configuration':
        'docker compose --env-file deploy/local.env.example config >/dev/null',
      'Validate the Prometheus configuration': `docker run --rm --entrypoint promtool -v "$PWD/deploy/prometheus:/etc/prometheus:ro" ${prometheusImage} check config /etc/prometheus/prometheus.yml`,
      'Test the Prometheus rules': `docker run --rm --entrypoint promtool -v "$PWD/deploy/prometheus:/etc/prometheus:ro" -w /etc/prometheus ${prometheusImage} test rules rules.test.yml`,
      'Build the production image':
        'docker build --target app --tag openslack-notification-delivery:ci .',
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
    expect(source).not.toMatch(/\b(?:slack|webhook|canary)\b/iu);
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
