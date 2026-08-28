import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const goCheckSource = readFileSync(join(repositoryRoot, 'scripts/go-check.sh'), 'utf8');
const workflowContractFamilyInventorySource = readFileSync(
  join(repositoryRoot, 'scripts/workflow-contract-families.generated.sh'),
  'utf8',
);
const workflowContractFamilyRegistry = JSON.parse(
  readFileSync(join(repositoryRoot, 'scripts/workflow-contract-families.json'), 'utf8'),
) as {
  families: Array<{ goMirror?: { package: string; version: string } }>;
};
const containerGateSource = readFileSync(
  join(repositoryRoot, 'scripts/go-check/container-gate.sh'),
  'utf8',
);
const gs9eQualificationFixture = Object.fromEntries(
  readFileSync(
    join(repositoryRoot, 'services/workflow-control/testdata/gs9e-qualification.conf'),
    'utf8',
  )
    .trim()
    .split('\n')
    .map((line) => line.split('=', 2) as [string, string]),
);
const temporaryRoots: string[] = [];
const describeOnBashHosts = process.platform === 'win32' ? describe.skip : describe;

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  // The fixtures intentionally use synchronous child processes. Yield once so
  // Vitest can flush worker RPC updates between otherwise back-to-back cases.
  await new Promise<void>((resolveYield) => setImmediate(resolveYield));
});

describeOnBashHosts('reviewed Go module verifier', () => {
  it('freezes the root workspace and fail-closed verifier contract', () => {
    expect(readFileSync(join(repositoryRoot, 'go.work'), 'utf8')).toBe(
      [
        'go 1.26.5',
        '',
        'use (',
        '\t./services/governance-control',
        '\t./services/notification-delivery',
        '\t./services/organization-graph',
        '\t./services/workflow-control',
        ')',
        '',
      ].join('\n'),
    );
    expect(
      readFileSync(
        join(repositoryRoot, 'scripts/go-check/services/governance-control.conf'),
        'utf8',
      ),
    ).toBe(
      [
        'capabilities=database,distribution,http-openapi,prometheus',
        'docker_target=app',
        'runtime_profile=governance-control-v2',
        '',
      ].join('\n'),
    );
    expect(
      readFileSync(
        join(repositoryRoot, 'scripts/go-check/services/organization-graph.conf'),
        'utf8',
      ),
    ).toBe(
      [
        'capabilities=database,distribution,http-openapi,prometheus',
        'docker_target=app',
        'runtime_profile=organization-graph-v1',
        '',
      ].join('\n'),
    );
    expect(
      readFileSync(join(repositoryRoot, 'scripts/go-check/services/workflow-control.conf'), 'utf8'),
    ).toBe(
      [
        'capabilities=database,distribution,http-openapi,prometheus,worker',
        'docker_target=app',
        'runtime_profile=workflow-control-runner-v2-runtime-delivery-v1',
        '',
      ].join('\n'),
    );
    expect(goCheckSource).toContain(
      'golang:1.26.5@sha256:3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647',
    );
    expect(goCheckSource).toContain('test "$(go env GOWORK)" = "off"');
    expect(containerGateSource).toContain('go test -race ./... -count=5');
    expect(goCheckSource).toContain('go test "${package}" -list "^${test_name}$"');
    expect(goCheckSource).toContain('Workflow Control runner test selector matched no tests:');
    expect(goCheckSource).toContain('type=volume,source=${MOD_CACHE_VOLUME}');
    expect(goCheckSource).toContain('type=volume,source=${BUILD_CACHE_VOLUME}');
    expect(goCheckSource).not.toContain('go work sync');
    expect(goCheckSource).not.toContain('.gomodcache');
    expect(goCheckSource).not.toContain('.gocache');
    expect(`${goCheckSource}\n${containerGateSource}`).not.toContain('host.docker.internal');
    expect(goCheckSource).not.toMatch(/\bdocker\s+(?:login|push|prune)\b/u);
    for (const reviewedGovernanceSource of [
      "'!audit.go'",
      "'!contract.go'",
      "'!governancecontrol.go'",
    ]) {
      expect(goCheckSource).toContain(reviewedGovernanceSource);
    }
    expect(goCheckSource).toContain('source "${workflow_contract_family_inventory}"');
    const mirrors = workflowContractFamilyRegistry.families.flatMap((family) =>
      family.goMirror ? [family.goMirror] : [],
    );
    expect(mirrors).toEqual([
      { package: 'authoritycontract', version: 'v2' },
      { package: 'budgetcontract', version: 'v1' },
      { package: 'runnerbindingcontract', version: 'v1' },
    ]);
    for (const mirror of mirrors) {
      for (const reviewedWorkflowAuthoritySource of [
        `'${mirror.package}'`,
        `'!${mirror.package}/'`,
        `'!${mirror.package}/*.go'`,
        `'!${mirror.package}/generated/${mirror.version}/schemas/*.json'`,
      ]) {
        expect(workflowContractFamilyInventorySource).toContain(reviewedWorkflowAuthoritySource);
      }
    }
  });

  it('rejects malformed invocations before contacting Docker', () => {
    const fixture = createFixture();
    const cases = [
      { args: [], status: 2 },
      { args: ['services/pure', 'extra'], status: 2 },
      { args: ['--unknown'], status: 1 },
      { args: ['./services/pure'], status: 1 },
      { args: ['services/pure/child'], status: 1 },
      { args: ['../services/pure'], status: 1 },
    ];

    for (const testCase of cases) {
      const result = runGoCheck(fixture, testCase.args);
      expect(result.status).toBe(testCase.status);
    }
    expect(readFileSync(fixture.dockerLog, 'utf8')).toBe('');
  });

  it('fails when Docker is installed but its daemon is unavailable', () => {
    const fixture = createFixture();
    const result = runGoCheck(fixture, ['services/pure'], {
      FAKE_DOCKER_INFO: 'fail',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Docker daemon is unavailable');
    expect(readFileSync(fixture.dockerLog, 'utf8')).not.toContain(' run ');
  });

  it('requires the pinned image and exact Go version', () => {
    const missingImage = createFixture();
    const missingResult = runGoCheck(missingImage, ['services/pure'], {
      FAKE_IMAGE_INSPECT: 'fail',
    });
    expect(missingResult.status).toBe(1);
    expect(missingResult.stderr).toContain('required pinned image is missing');

    const wrongVersion = createFixture();
    const versionResult = runGoCheck(wrongVersion, ['services/pure'], {
      FAKE_GO_VERSION: 'go1.26.4',
    });
    expect(versionResult.status).toBe(1);
    expect(versionResult.stderr).toContain('expected go1.26.5');
  });

  it('runs a pure module through isolated common gates without PostgreSQL', () => {
    const fixture = createFixture();
    const originalMod = readFileSync(join(fixture.root, 'services/pure/go.mod'), 'utf8');

    const result = runGoCheck(fixture, ['services/pure']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('services/pure passed');
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain('openslack-go-check-mod-go1-26-5-3aff6657219a');
    expect(log).toContain('openslack-go-check-build-go1-26-5-3aff6657219a');
    expect(log).toContain('GOWORK=off');
    expect(log).toContain('openslack-go-check-stage.');
    expect(log).not.toContain(`${fixture.root}/services/pure`);
    expect(log).toContain('/input/container-gate.sh');
    expect(log).toContain('GO_CHECK_MODULE_RELATIVE_PATH=services/pure');
    expect(log).toContain('/repository\\,target=/source\\,readonly');
    expect(log).not.toContain('network create');
    expect(log).not.toContain('postgres:18.4');
    expect(readFileSync(join(fixture.root, 'services/pure/go.mod'), 'utf8')).toBe(originalMod);
  });

  it('validates every workspace module once in deterministic order', () => {
    const fixture = createFixture(['alpha', 'zulu']);
    const result = runGoCheck(fixture, ['--all']);

    expect(result.status).toBe(0);
    const output = result.stdout;
    expect(output.indexOf('validating services/alpha')).toBeLessThan(
      output.indexOf('validating services/zulu'),
    );
    expect(output.match(/services\/alpha passed/gu)).toHaveLength(1);
    expect(output.match(/services\/zulu passed/gu)).toHaveLength(1);
    const repositoryMounts = readFileSync(fixture.dockerLog, 'utf8').match(
      /source=.+?\/repository\\,target=\/source\\,readonly/gu,
    );
    expect(repositoryMounts).toHaveLength(2);
    expect(new Set(repositoryMounts).size).toBe(1);

    const trailingHyphen = createFixture(['a-']);
    expect(runGoCheck(trailingHyphen, ['services/a-']).status).toBe(0);
  });

  it('rejects malformed, duplicate, and incomplete workspace module sets', () => {
    const incomplete = createFixture(['alpha', 'zulu']);
    const incompleteResult = runGoCheck(incomplete, ['--all'], {
      FAKE_WORKSPACE_MODULES: './services/alpha\n',
    });
    expect(incompleteResult.status).toBe(1);
    expect(incompleteResult.stderr).toContain('every and only repository service module');

    const duplicate = createFixture(['alpha']);
    const duplicateResult = runGoCheck(duplicate, ['--all'], {
      FAKE_WORKSPACE_MODULES: './services/alpha\n./services/alpha\n',
    });
    expect(duplicateResult.status).toBe(1);
    expect(duplicateResult.stderr).toContain('every and only repository service module');

    const malformed = createFixture(['alpha']);
    const malformedResult = runGoCheck(malformed, ['--all'], {
      FAKE_PARSER_STATUS: '3',
    });
    expect(malformedResult.status).toBe(1);
    expect(malformedResult.stderr).toContain('could not parse go.work');
  });

  it('rejects a workspace module whose directory is a symbolic link', () => {
    const fixture = createFixture([]);
    const external = join(fixture.root, 'external-module');
    writeModule(external, 'linked');
    symlinkSync(external, join(fixture.root, 'services/linked'), 'dir');
    writeWorkspace(fixture.root, ['linked']);

    const result = runGoCheck(fixture, ['services/linked'], {
      FAKE_WORKSPACE_MODULES: './services/linked\n',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('regular non-symlink directory');
  });

  it('fails closed when a database capability is only partially declared', () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.root, 'services/pure/migrations'), { recursive: true });
    writeFileSync(
      join(fixture.root, 'services/pure/migrations/000001_init.up.sql'),
      'SELECT 1;\n',
      'utf8',
    );
    writeServiceConfig(fixture.root, 'pure', {
      capabilities: 'database',
    });
    commitFixture(fixture.root);

    const result = runGoCheck(fixture, ['services/pure']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('database capability requires tests/integration');
    expect(readFileSync(fixture.dockerLog, 'utf8')).not.toContain('network create');
  });

  it('runs database, Prometheus, image, and health gates with isolated cleanup', () => {
    const fixture = createFixture();
    addFullServiceCapabilities(join(fixture.root, 'services/pure'));
    writeServiceConfig(fixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'notification-delivery-v1',
    });
    commitFixture(fixture.root);

    const result = runGoCheck(fixture, ['services/pure']);

    expect(result.status).toBe(0);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain('network create');
    expect(log).toContain(
      'postgres:18.4@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a',
    );
    expect(log).toContain(
      'prom/prometheus:v3.13.1@sha256:3c42b892cf723fa54d2f262c37a0e1f80aa8c8ddb1da7b9b0df9455a35a7f893',
    );
    expect(log).toContain('MSYS= build --pull=false --label');
    expect(log).toContain('--target app --tag');
    expect(log).toContain('--read-only');
    expect(log).toContain('run -d --pull=never');
    expect(log).toContain('CREDENTIAL_REF_SCHEME_ALLOWLIST=env');
    expect(log).toContain('CREDENTIAL_PROFILE_VALIDATOR=bearer-env-v1');
    expect(log).toContain('MIGRATION_SOURCE=/migrations');
    expect(log).toContain('network rm');
    expect(log).toContain('volume rm');
    expect(log).toContain('image rm');
  });

  it('runs the organization graph HTTP profile without notification credentials', () => {
    const fixture = createFixture();
    addFullServiceCapabilities(join(fixture.root, 'services/pure'));
    writeServiceConfig(fixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus',
      dockerTarget: 'app',
      runtimeProfile: 'organization-graph-v1',
    });
    commitFixture(fixture.root);

    const result = runGoCheck(fixture, ['services/pure']);

    expect(result.status).toBe(0);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain('GRAPH_QUERY_CURSOR_SECRET=organization-graph-go-check-cursor-secret-v1');
    expect(log).toContain(
      'GRAPH_QUERY_CURSOR_SECRET_PREVIOUS=organization-graph-go-check-cursor-secret-v0',
    );
    expect(log).toContain(
      'GRAPH_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    expect(log).toContain('GRAPH_HTTP_BIND=:8080');
    expect(log).toContain('GRAPH_NETWORK_MODE=internal');
    expect(log).toContain('MIGRATION_SOURCE=/migrations');
    expect(log).toContain('GRAPH_GS1C_SCHEMA_QUALIFICATION=1');
    expect(log).toContain('GRAPH_GS1C_LARGE_QUALIFICATION=1');
    expect(log).toContain('GRAPH_GS1C_RESTART_PHASE=seed');
    expect(log).toContain('GRAPH_GS1C_RESTART_PHASE=verify');
    expect(goCheckSource).toContain('local restart_token="${run_token,,}"');
    const restartSchemas = [
      ...log.matchAll(/GRAPH_GS1C_RESTART_SCHEMA=(organization_graph_gs1c_restart_[a-z0-9]+)/gu),
    ].map((match) => match[1]);
    expect(restartSchemas).toHaveLength(2);
    expect(new Set(restartSchemas).size).toBe(1);
    expect(log).toContain(' restart ');
    expect(log.match(/go test -race \.\/cmd\/server -run/g)).toHaveLength(3);
    expect(log).not.toContain('IDEMPOTENCY_KEY_PEPPER=');
    expect(log).not.toContain('CREDENTIAL_REF_SCHEME_ALLOWLIST=');
    expect(log).not.toContain('CREDENTIAL_PROFILE_VALIDATOR=');
  }, 15_000);

  it('runs the Governance Control durable shadow and authority-cutover qualifications without secrets', () => {
    const fixture = createFixture();
    addFullServiceCapabilities(join(fixture.root, 'services/pure'));
    writeServiceConfig(fixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus',
      dockerTarget: 'app',
      runtimeProfile: 'governance-control-v2',
    });
    commitFixture(fixture.root);

    const result = runGoCheck(fixture, ['services/pure']);

    expect(result.status).toBe(0);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain(
      'GOVERNANCE_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    expect(log).toContain('GOVERNANCE_HTTP_BIND=:8080');
    expect(log).toContain('GOVERNANCE_NETWORK_MODE=internal');
    expect(log).toContain('GOVERNANCE_GS5_QUALIFICATION=1');
    expect(log).toContain('GOVERNANCE_GS5_RESTART_PHASE=seed');
    expect(log).toContain('GOVERNANCE_GS5_RESTART_PHASE=verify');
    expect(log).toContain('GOVERNANCE_GS6_QUALIFICATION=1');
    expect(log).toContain('GOVERNANCE_GS6_RESTART_PHASE=seed');
    expect(log).toContain('GOVERNANCE_GS6_RESTART_PHASE=verify');
    expect(log).toContain('GOVERNANCE_AUTHORITY_ACCEPT_NEW_RECORDS=true');
    expect(log).toContain('GOVERNANCE_AUTHORITY_DRAIN_EPOCHS=6');
    expect(log).toContain('-run \\^TestGS6Qualification\\$');
    expect(log).toContain('-run \\^TestGS6RestartQualification\\$');
    expect(log).toContain('-run \\^TestGS6ImageSmoke\\$');
    expect(log).toContain('--network-alias application');
    expect(log).toContain('GOVERNANCE_GS5_SMOKE_ORIGIN=http://application:8080');
    expect(log).toContain('GOVERNANCE_GS5_EXPECT_AUTHORITY_ENABLED=true');
    expect(log).toContain('GOVERNANCE_GS6_SMOKE_ORIGIN=http://application:8080');
    expect(goCheckSource).toContain('local restart_token="${run_token,,}"');
    const restartSchemas = [
      ...log.matchAll(/GOVERNANCE_GS5_RESTART_SCHEMA=(governance_control_gs5_restart_[a-z0-9]+)/gu),
    ].map((match) => match[1]);
    expect(restartSchemas).toHaveLength(2);
    expect(new Set(restartSchemas).size).toBe(1);
    const authorityRestartSchemas = [
      ...log.matchAll(/GOVERNANCE_GS6_RESTART_SCHEMA=(governance_control_gs6_restart_[a-z0-9]+)/gu),
    ].map((match) => match[1]);
    expect(authorityRestartSchemas).toHaveLength(2);
    expect(new Set(authorityRestartSchemas).size).toBe(1);
    expect(log).toContain(' restart ');
    expect(log.match(/go test -race \.\/cmd\/server -run/g)).toHaveLength(8);
    expect(log).not.toContain('confirmationToken=');
    expect(log).not.toContain('CONFIRMATION_TOKEN=');
    expect(log).not.toContain('CREDENTIAL_REF_SCHEME_ALLOWLIST=');
    expect(log).not.toContain('CREDENTIAL_PROFILE_VALIDATOR=');
  }, 15_000);

  it('runs the Workflow Control PostgreSQL shadow profile without authority credentials', () => {
    const fixture = createFixture();
    addFullServiceCapabilities(join(fixture.root, 'services/pure'));
    mkdirSync(join(fixture.root, 'services/pure/internal/app'), { recursive: true });
    mkdirSync(join(fixture.root, 'services/pure/internal/shadowstore/postgres'), {
      recursive: true,
    });
    writeFileSync(
      join(fixture.root, 'services/pure/internal/app/handlers_test.go'),
      [
        'package app',
        '',
        'import "testing"',
        '',
        'func TestObservationProjectionAndClosedRouteSurface(t *testing.T) {}',
        'func TestObservationRejectsStoreReceiptStateDrift(t *testing.T) {}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(fixture.root, 'services/pure/internal/shadowstore/postgres/repository_test.go'),
      [
        'package postgres',
        '',
        'import "testing"',
        '',
        'func TestUnknownCommitPersistsStableReconciliationReceipt(t *testing.T) {}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(fixture.root, 'services/pure/tests/contracts/openapi_contract_test.go'),
      [
        'package contracts',
        '',
        'import "testing"',
        '',
        'func TestOpenAPIIsValidAndContainsOnlyShadowRoutes(t *testing.T) {}',
        '',
      ].join('\n'),
      'utf8',
    );
    writeServiceConfig(fixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-shadow-v1',
    });
    commitFixture(fixture.root);

    const result = runGoCheck(fixture, ['services/pure']);

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain(
      'WORKFLOW_CONTROL_SERVICE_BUILD_SHA=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    expect(log).toContain('WORKFLOW_CONTROL_HTTP_BIND=:8080');
    expect(log).toContain('WORKFLOW_CONTROL_NETWORK_MODE=internal');
    expect(log).toContain('WORKFLOW_CONTROL_GS7B_QUALIFICATION=1');
    expect(log).toContain('WORKFLOW_CONTROL_GS7B_RESTART_PHASE=seed');
    expect(log).toContain('WORKFLOW_CONTROL_GS7B_RESTART_PHASE=verify');
    expect(log).toContain('-run \\^TestGS7BQualification\\$');
    expect(log).toContain('-run \\^TestGS7BRestartQualification\\$');
    expect(log).toContain('-run \\^TestGS7BImageSmoke\\$');
    expect(log).toContain('--network-alias application');
    expect(log).toContain('WORKFLOW_CONTROL_GS7B_SMOKE_ORIGIN=http://application:8080');
    expect(log).toContain('MIGRATION_SOURCE=/migrations');
    const restartSchemas = [
      ...log.matchAll(
        /WORKFLOW_CONTROL_GS7B_RESTART_SCHEMA=(workflow_control_gs7b_restart_[a-z0-9]+)/gu,
      ),
    ].map((match) => match[1]);
    expect(restartSchemas).toHaveLength(2);
    expect(new Set(restartSchemas).size).toBe(1);
    expect(log).toContain(' restart ');
    expect(log.match(/go test -race \.\/cmd\/server -run/gu)).toHaveLength(4);
    expect(log).not.toContain('GOVERNANCE_AUTHORITY_MODE=');
    expect(log).not.toContain('CREDENTIAL_REF_SCHEME_ALLOWLIST=');
    expect(log).not.toContain('CREDENTIAL_PROFILE_VALIDATOR=');
  }, 15_000);

  it('runs the Workflow Control GS8-B runner profile with durable restart and default-off image gates', () => {
    const fixture = createFixture();
    const moduleRoot = join(fixture.root, 'services/pure');
    addFullServiceCapabilities(moduleRoot);
    addWorkflowRunnerEvidence(moduleRoot);
    writeServiceConfig(fixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-runner-v1',
    });
    commitFixture(fixture.root);

    const result = runGoCheck(fixture, ['services/pure']);

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain('WORKFLOW_CONTROL_GS7B_QUALIFICATION=1');
    expect(log).toContain('WORKFLOW_RUNNER_GS8B_RESTART_PHASE=seed');
    expect(log).toContain('WORKFLOW_RUNNER_GS8B_RESTART_PHASE=verify');
    expect(log).toContain('./internal/runnerstore/postgres');
    expect(log).toContain('-qualification-runner-cancel-ack-stability');
    expect(log).toContain(
      '-run \\^Test\\(CancelAckMustBindPersistedCancel\\|LateAlreadyTerminalCancelAckPreservesReceiptProvenTerminal\\)\\$',
    );
    expect(log).toContain('-count=100');
    expect(
      readFileSync(join(moduleRoot, 'cmd/runner-server/qualification_test.go'), 'utf8'),
    ).toContain('TestGS8BQualificationProcessIdentityIsStableWithinOneProcess');
    expect(log).toContain('-run \\^TestGS8BRestartQualification\\$');
    expect(log).toContain('-run \\^TestGS8BImageDefaultOff\\$');
    expect(log).toContain('WORKFLOW_RUNNER_GS8B_DEFAULT_ORIGIN=http://application:8080');
    const runnerBoundsIndex = log.indexOf('-qualification-runner-bounds');
    const cancelAckStabilityIndex = log.indexOf('-qualification-runner-cancel-ack-stability');
    const runnerRestartSeedIndex = log.indexOf('WORKFLOW_RUNNER_GS8B_RESTART_PHASE=seed');
    expect(runnerBoundsIndex).toBeGreaterThan(-1);
    expect(cancelAckStabilityIndex).toBeGreaterThan(runnerBoundsIndex);
    expect(runnerRestartSeedIndex).toBeGreaterThan(cancelAckStabilityIndex);
    const restartSchemas = [
      ...log.matchAll(
        /WORKFLOW_RUNNER_GS8B_RESTART_SCHEMA=(workflow_control_gs8b_restart_[a-z0-9]+)/gu,
      ),
    ].map((match) => match[1]);
    // Each seed/verify phase is logged once for selector discovery and once for execution.
    expect(restartSchemas).toHaveLength(4);
    expect(new Set(restartSchemas).size).toBe(1);
    expect(log.match(/ restart /gu)).toHaveLength(2);
    expect(log).not.toContain('WORKFLOW_RUNNER_GS8B_QUALIFICATION=1');
    expect(log).not.toContain('GOVERNANCE_AUTHORITY_MODE=');

    const failureFixture = createFixture();
    const failureModuleRoot = join(failureFixture.root, 'services/pure');
    addFullServiceCapabilities(failureModuleRoot);
    addWorkflowRunnerEvidence(failureModuleRoot);
    writeServiceConfig(failureFixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-runner-v1',
    });
    commitFixture(failureFixture.root);

    const failure = runGoCheck(failureFixture, ['services/pure'], {
      FAKE_GS8B_FAIL_PHASE: 'runner-cancel-ack-stability',
      FAKE_GS8B_FAIL_STATUS: '47',
    });
    expect(failure.status).toBe(47);
    const failureLog = readFileSync(failureFixture.dockerLog, 'utf8');
    expect(failureLog).toContain('-qualification-runner-cancel-ack-stability');
    expect(failureLog).not.toContain('WORKFLOW_RUNNER_GS8B_RESTART_PHASE=seed');
  }, 15_000);

  it('runs the Workflow Control GS9-B authority profile as a GS7/GS8 superset with durable default-off gates', () => {
    const fixture = createFixture();
    const moduleRoot = join(fixture.root, 'services/pure');
    addFullServiceCapabilities(moduleRoot);
    addWorkflowRunnerEvidence(moduleRoot);
    addWorkflowAuthorityEvidence(moduleRoot);
    writeServiceConfig(fixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-authority-v2',
    });
    commitFixture(fixture.root);

    const result = runGoCheck(fixture, ['services/pure']);

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain('WORKFLOW_CONTROL_GS7B_QUALIFICATION=1');
    expect(log).toContain('-qualification-runner-bounds');
    expect(log).toContain('WORKFLOW_RUNNER_GS8B_RESTART_PHASE=seed');
    expect(log).toContain('WORKFLOW_CONTROL_AUTHORITY_MODE=local-qualification-v1');
    expect(log).toContain('WORKFLOW_CONTROL_AUTHORITY_HTTP_BIND=127.0.0.1:8082');
    expect(log).toContain('WORKFLOW_CONTROL_AUTHORITY_ROUTING_EPOCH=9');
    expect(log).toContain('WORKFLOW_CONTROL_GS9B_QUALIFICATION=1');
    expect(log).toContain('-run \\^TestGS9BQualification\\$');
    expect(log).toContain('WORKFLOW_CONTROL_GS9B_RESTART_PHASE=seed');
    expect(log).toContain('WORKFLOW_CONTROL_GS9B_RESTART_PHASE=verify');
    expect(log).toContain('-run \\^TestGS9BRestartQualification\\$');
    expect(log).toContain('--entrypoint /authority-server');
    expect(log).toContain('--network container:');
    expect(log).toContain('WORKFLOW_CONTROL_GS9B_DEFAULT_ORIGIN=http://127.0.0.1:8082');
    expect(log).toContain('-run \\^TestGS9BImageDefaultOff\\$');
    const authorityDefaultOffRun = log
      .split('\n')
      .find((line) => line.includes('--entrypoint /authority-server'));
    expect(authorityDefaultOffRun).toContain('--network none');
    expect(authorityDefaultOffRun).toContain('--health-cmd kill\\ -0\\ 1');
    expect(authorityDefaultOffRun).not.toContain('DATABASE_URL=');
    expect(authorityDefaultOffRun).not.toContain('WORKFLOW_CONTROL_AUTHORITY_MODE=');
    for (const requiredStoreTest of [
      'TestGS9BAuthorityAcceptAndByteIdenticalReplay',
      'TestGS9BAuthorityReadRejectsTamperedCanonicalRecordBytes',
      'TestGS9BAuthorityReadRejectsTamperedCanonicalOutboxBytes',
      'TestGS9BAuthorityRejectsCorruptStoredReceiptAsIntegrityFailure',
      'TestGS9BAuthorityReadyUsesLightweightProbe',
      'TestGS9BAuthoritySameKeyDifferentFingerprintConflicts',
      'TestGS9BAuthorityTransitionCASAndOutboxAtomicity',
      'TestGS9BAuthorityRouteDriftConflicts',
      'TestGS9BAuthorityConcurrentCASHasOneWinner',
      'TestGS9BAuthorityCommittedResponseLossRecoversExactReceipt',
      'TestGS9BAuthorityUnknownCommitPersistsReconciliationWithoutHead',
      'TestGS9BAuthorityDoubleUnknownFailsClosed',
      'TestPrepareRequestRejectsNonCanonicalAndInvalidTransition',
      'TestServiceMapsCommitUnknownToStableNon2xx',
      'TestServiceMapsStoredIntegrityFailureTo500',
      'TestQualificationReadinessUsesLightweightProbe',
      'TestQualificationReadinessFailureIsNotReady',
      'TestAuthorityTimeoutBudgetsLeaveWriteSlack',
      'TestMigrationCreatesIsolatedShadowRunnerAndAuthorityNamespacesWithImmutableEvidence',
      'TestAuthorityMigrationDoesNotClaimLaterGS9OrRunnerLifecycle',
      'TestAuthorityDownMigrationIsIsolatedAndRefusesRegisteredEpochs',
    ]) {
      expect(goCheckSource).toContain(requiredStoreTest);
    }
    const restartSchemas = [
      ...log.matchAll(
        /WORKFLOW_CONTROL_GS9B_RESTART_SCHEMA=(workflow_control_gs9b_restart_[a-z0-9]+)/gu,
      ),
    ].map((match) => match[1]);
    expect(restartSchemas).toHaveLength(2);
    expect(new Set(restartSchemas).size).toBe(1);
    expect(log.match(/ restart /gu)).toHaveLength(3);

    const failureFixture = createFixture();
    const failureModuleRoot = join(failureFixture.root, 'services/pure');
    addFullServiceCapabilities(failureModuleRoot);
    addWorkflowRunnerEvidence(failureModuleRoot);
    addWorkflowAuthorityEvidence(failureModuleRoot);
    writeServiceConfig(failureFixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-authority-v2',
    });
    commitFixture(failureFixture.root);

    const failure = runGoCheck(failureFixture, ['services/pure'], {
      FAKE_GS9B_FAIL_PHASE: 'authority-bounds',
      FAKE_GS9B_FAIL_STATUS: '48',
    });
    expect(failure.status).toBe(48);
    const failureLog = readFileSync(failureFixture.dockerLog, 'utf8');
    expect(failureLog).toContain('-qualification-authority-bounds');
    expect(failureLog).not.toContain('WORKFLOW_CONTROL_GS9B_RESTART_PHASE=seed');
  }, 15_000);

  it('runs the Workflow Control GS9-C checkpoint profile as a strict GS7/GS8/GS9-B superset', () => {
    const fixture = createFixture();
    const moduleRoot = join(fixture.root, 'services/pure');
    addFullServiceCapabilities(moduleRoot);
    addWorkflowRunnerEvidence(moduleRoot);
    addWorkflowAuthorityEvidence(moduleRoot);
    addWorkflowCheckpointShadowEvidence(moduleRoot);
    writeServiceConfig(fixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-checkpoint-shadow-v1',
    });
    commitFixture(fixture.root);

    const result = runGoCheck(fixture, ['services/pure']);

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain('WORKFLOW_CONTROL_GS7B_QUALIFICATION=1');
    expect(log).toContain('WORKFLOW_RUNNER_GS8B_RESTART_PHASE=seed');
    expect(log).toContain('WORKFLOW_CONTROL_GS9B_QUALIFICATION=1');
    expect(log).toContain('WORKFLOW_CONTROL_CHECKPOINT_SHADOW_MODE=local-qualification-v1');
    expect(log).toContain('WORKFLOW_CONTROL_CHECKPOINT_SHADOW_HTTP_BIND=127.0.0.1:8083');
    expect(log).toContain('WORKFLOW_CONTROL_GS9C_QUALIFICATION=1');
    expect(log).toContain('-run \\^TestGS9CQualification\\$');
    expect(log).toContain('WORKFLOW_CONTROL_GS9C_RESTART_PHASE=seed');
    expect(log).toContain('WORKFLOW_CONTROL_GS9C_RESTART_PHASE=verify');
    expect(log).toContain('-run \\^TestGS9CRestartQualification\\$');
    expect(log).toContain('--entrypoint /checkpoint-shadow-server');
    expect(log).toContain('WORKFLOW_CONTROL_GS9C_DEFAULT_ORIGIN=http://127.0.0.1:8083');
    expect(log).toContain('-run \\^TestGS9CImageDefaultOff\\$');
    const checkpointDefaultOffRun = log
      .split('\n')
      .find((line) => line.includes('--entrypoint /checkpoint-shadow-server'));
    expect(checkpointDefaultOffRun).toContain('--network none');
    expect(checkpointDefaultOffRun).not.toContain('DATABASE_URL=');
    expect(checkpointDefaultOffRun).not.toContain('WORKFLOW_CONTROL_CHECKPOINT_SHADOW_MODE=');
    const restartSchemas = [
      ...log.matchAll(
        /WORKFLOW_CONTROL_GS9C_RESTART_SCHEMA=(workflow_control_gs9c_restart_[a-z0-9]+)/gu,
      ),
    ].map((match) => match[1]);
    expect(restartSchemas).toHaveLength(2);
    expect(new Set(restartSchemas).size).toBe(1);
    expect(log.match(/ restart /gu)).toHaveLength(4);

    const failureFixture = createFixture();
    const failureModuleRoot = join(failureFixture.root, 'services/pure');
    addFullServiceCapabilities(failureModuleRoot);
    addWorkflowRunnerEvidence(failureModuleRoot);
    addWorkflowAuthorityEvidence(failureModuleRoot);
    addWorkflowCheckpointShadowEvidence(failureModuleRoot);
    writeServiceConfig(failureFixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-checkpoint-shadow-v1',
    });
    commitFixture(failureFixture.root);

    const failure = runGoCheck(failureFixture, ['services/pure'], {
      FAKE_GS9C_FAIL_PHASE: 'checkpoint-bounds',
      FAKE_GS9C_FAIL_STATUS: '49',
    });
    expect(failure.status).toBe(49);
    const failureLog = readFileSync(failureFixture.dockerLog, 'utf8');
    expect(failureLog).toContain('-qualification-checkpoint-bounds');
    expect(failureLog).not.toContain('WORKFLOW_CONTROL_GS9C_RESTART_PHASE=seed');
  }, 30_000);

  it('runs the Workflow Control GS9-D effect profile as a strict GS7/GS8/GS9-B/GS9-C superset', () => {
    const fixture = createFixture();
    const moduleRoot = join(fixture.root, 'services/pure');
    addFullServiceCapabilities(moduleRoot);
    addWorkflowRunnerEvidence(moduleRoot);
    addWorkflowAuthorityEvidence(moduleRoot);
    addWorkflowCheckpointShadowEvidence(moduleRoot);
    addWorkflowEffectShadowEvidence(moduleRoot);
    writeServiceConfig(fixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-effect-shadow-v1',
    });
    commitFixture(fixture.root);

    const result = runGoCheck(fixture, ['services/pure']);

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain('WORKFLOW_CONTROL_GS7B_QUALIFICATION=1');
    expect(log).toContain('WORKFLOW_RUNNER_GS8B_RESTART_PHASE=seed');
    expect(log).toContain('WORKFLOW_CONTROL_GS9B_QUALIFICATION=1');
    expect(log).toContain('WORKFLOW_CONTROL_GS9C_QUALIFICATION=1');
    expect(log).toContain('WORKFLOW_CONTROL_EFFECT_SHADOW_MODE=local-qualification-v1');
    expect(log).toContain('WORKFLOW_CONTROL_EFFECT_SHADOW_HTTP_BIND=127.0.0.1:8084');
    expect(log).toContain(
      'WORKFLOW_CONTROL_EFFECT_SHADOW_CALLER_ID=typescript:workflow-effect-shadow',
    );
    expect(log).toContain('WORKFLOW_CONTROL_GS9D_QUALIFICATION=1');
    expect(log).toContain('-run \\^TestGS9DQualification\\$');
    expect(log).toContain('WORKFLOW_CONTROL_GS9D_RESTART_PHASE=seed');
    expect(log).toContain('WORKFLOW_CONTROL_GS9D_RESTART_PHASE=verify');
    expect(log).toContain('-run \\^TestGS9DRestartQualification\\$');
    expect(log).toContain('--entrypoint /effect-shadow-server');
    expect(log).toContain('WORKFLOW_CONTROL_GS9D_DEFAULT_ORIGIN=http://127.0.0.1:8084');
    expect(log).toContain('-run \\^TestGS9DImageDefaultOff\\$');
    for (const requiredName of [
      'TestWorkflowEffectShadowGoldenVectors',
      'TestWorkflowEffectShadowRejectsFramingAndAuthorityDrift',
      'TestGS9DEffectShadowLifecycleOutboxAndExactReplay',
      'TestGS9DEffectShadowOutboxPaginationTraversesBeyondFirstHundred',
      'TestGS9DEffectShadowMismatchDoesNotCreateOutbox',
      'TestGS9DEffectShadowCommittedResponseLossKeepsOutboxAtomic',
      'TestGS9DEffectShadowRejectsCorruptOutboxPayload',
      'TestGS9DEffectShadowConflictsConcurrencyAndStoredIntegrity',
      'TestGS9DEffectShadowCommitUnknownReconciliationAndDoubleUnknown',
      'TestGS9DEffectShadowCommitUnknownRereadsReceiptAfterScopeLock',
      'TestEffectShadowDownMigrationIsIsolatedAndRefusesEvidence',
    ]) {
      expect(goCheckSource).toContain(requiredName);
    }
    const effectDefaultOffRun = log
      .split('\n')
      .find((line) => line.includes('--entrypoint /effect-shadow-server'));
    expect(effectDefaultOffRun).toContain('--network none');
    expect(effectDefaultOffRun).not.toContain('DATABASE_URL=');
    expect(effectDefaultOffRun).not.toContain('WORKFLOW_CONTROL_EFFECT_SHADOW_MODE=');
    const restartSchemas = [
      ...log.matchAll(
        /WORKFLOW_CONTROL_GS9D_RESTART_SCHEMA=(workflow_control_gs9d_restart_[a-z0-9]+)/gu,
      ),
    ].map((match) => match[1]);
    expect(restartSchemas).toHaveLength(2);
    expect(new Set(restartSchemas).size).toBe(1);
    expect(log.match(/ restart /gu)).toHaveLength(5);

    const failureFixture = createFixture();
    const failureModuleRoot = join(failureFixture.root, 'services/pure');
    addFullServiceCapabilities(failureModuleRoot);
    addWorkflowRunnerEvidence(failureModuleRoot);
    addWorkflowAuthorityEvidence(failureModuleRoot);
    addWorkflowCheckpointShadowEvidence(failureModuleRoot);
    addWorkflowEffectShadowEvidence(failureModuleRoot);
    writeServiceConfig(failureFixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-effect-shadow-v1',
    });
    commitFixture(failureFixture.root);

    const failure = runGoCheck(failureFixture, ['services/pure'], {
      FAKE_GS9D_FAIL_PHASE: 'effect-bounds',
      FAKE_GS9D_FAIL_STATUS: '50',
    });
    expect(failure.status).toBe(50);
    const failureLog = readFileSync(failureFixture.dockerLog, 'utf8');
    expect(failureLog).toContain('-qualification-effect-bounds');
    expect(failureLog).not.toContain('WORKFLOW_CONTROL_GS9D_RESTART_PHASE=seed');
  }, 30_000);

  it('runs the Workflow Control GS9-E budget profile as a strict GS7/GS8/GS9-B/C/D superset', () => {
    const fixture = createFixture();
    const moduleRoot = join(fixture.root, 'services/pure');
    addFullServiceCapabilities(moduleRoot);
    addWorkflowRunnerEvidence(moduleRoot);
    addWorkflowAuthorityEvidence(moduleRoot);
    addWorkflowCheckpointShadowEvidence(moduleRoot);
    addWorkflowEffectShadowEvidence(moduleRoot);
    addWorkflowBudgetAuthorityEvidence(moduleRoot);
    writeServiceConfig(fixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-budget-authority-v1',
    });
    commitFixture(fixture.root);

    const result = runGoCheck(fixture, ['services/pure']);

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain('WORKFLOW_CONTROL_GS7B_QUALIFICATION=1');
    expect(log).toContain('WORKFLOW_RUNNER_GS8B_RESTART_PHASE=seed');
    expect(log).toContain('WORKFLOW_CONTROL_GS9B_QUALIFICATION=1');
    expect(log).toContain('WORKFLOW_CONTROL_GS9C_QUALIFICATION=1');
    expect(log).toContain('WORKFLOW_CONTROL_GS9D_QUALIFICATION=1');
    expect(log).toContain('WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE=local-qualification-v1');
    expect(log).toContain('WORKFLOW_CONTROL_BUDGET_AUTHORITY_HTTP_BIND=127.0.0.1:8085');
    expect(log).toContain(
      `WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH=${gs9eQualificationFixture.WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH}`,
    );
    expect(log).toContain(
      `WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH=${gs9eQualificationFixture.WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH}`,
    );
    expect(log).toContain(
      `WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS=${gs9eQualificationFixture.WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS}`,
    );
    expect(log).toContain(
      `WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD=${gs9eQualificationFixture.WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD}`,
    );
    expect(log).toContain(
      `WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS=${gs9eQualificationFixture.WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS}`,
    );
    expect(goCheckSource).toContain('${staged_module_dir}/testdata/gs9e-qualification.conf');
    expect(log).toContain('WORKFLOW_CONTROL_GS9E_QUALIFICATION=1');
    expect(log).toContain('-run \\^TestGS9EQualification\\$');
    expect(log).toContain('WORKFLOW_CONTROL_GS9E_RESTART_PHASE=seed');
    expect(log).toContain('WORKFLOW_CONTROL_GS9E_RESTART_PHASE=verify');
    expect(log).toContain('-run \\^TestGS9ERestartQualification\\$');
    expect(log).toContain('--entrypoint /budget-authority-server');
    expect(log).toContain('WORKFLOW_CONTROL_GS9E_DEFAULT_ORIGIN=http://127.0.0.1:8085');
    expect(log).toContain('-run \\^TestGS9EImageDefaultOff\\$');
    const budgetDefaultOffRun = log
      .split('\n')
      .find((line) => line.includes('--entrypoint /budget-authority-server'));
    expect(budgetDefaultOffRun).toContain('--network none');
    expect(budgetDefaultOffRun).not.toContain('DATABASE_URL=');
    expect(budgetDefaultOffRun).not.toContain('WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE=');
    expect(budgetDefaultOffRun).not.toContain('WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH=');
    const restartSchemas = [
      ...log.matchAll(
        /WORKFLOW_CONTROL_GS9E_RESTART_SCHEMA=(workflow_control_gs9e_restart_[a-z0-9]+)/gu,
      ),
    ].map((match) => match[1]);
    expect(restartSchemas).toHaveLength(2);
    expect(new Set(restartSchemas).size).toBe(1);
    expect(log.match(/ restart /gu)).toHaveLength(6);

    const failureFixture = createFixture();
    const failureModuleRoot = join(failureFixture.root, 'services/pure');
    addFullServiceCapabilities(failureModuleRoot);
    addWorkflowRunnerEvidence(failureModuleRoot);
    addWorkflowAuthorityEvidence(failureModuleRoot);
    addWorkflowCheckpointShadowEvidence(failureModuleRoot);
    addWorkflowEffectShadowEvidence(failureModuleRoot);
    addWorkflowBudgetAuthorityEvidence(failureModuleRoot);
    writeServiceConfig(failureFixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-budget-authority-v1',
    });
    commitFixture(failureFixture.root);

    const failure = runGoCheck(failureFixture, ['services/pure'], {
      FAKE_GS9E_FAIL_PHASE: 'budget-bounds',
      FAKE_GS9E_FAIL_STATUS: '51',
    });
    expect(failure.status).toBe(51);
    const failureLog = readFileSync(failureFixture.dockerLog, 'utf8');
    expect(failureLog).toContain('-qualification-budget-bounds');
    expect(failureLog).not.toContain('WORKFLOW_CONTROL_GS9E_RESTART_PHASE=seed');
  }, 30_000);

  it('runs the Workflow Control GS9-F1 foundation profile as a default-off GS9-E superset', () => {
    const fixture = createFixture();
    const moduleRoot = join(fixture.root, 'services/pure');
    addFullServiceCapabilities(moduleRoot);
    addWorkflowRunnerEvidence(moduleRoot);
    addWorkflowRunnerV2FoundationEvidence(moduleRoot);
    addWorkflowAuthorityEvidence(moduleRoot);
    addWorkflowCheckpointShadowEvidence(moduleRoot);
    addWorkflowEffectShadowEvidence(moduleRoot);
    addWorkflowBudgetAuthorityEvidence(moduleRoot);
    writeServiceConfig(fixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-runner-v2-foundation-v1',
    });
    commitFixture(fixture.root);

    const result = runGoCheck(fixture, ['services/pure']);

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain('WORKFLOW_CONTROL_GS9E_QUALIFICATION=1');
    expect(log).toContain('WORKFLOW_RUNNER_GS9F1_QUALIFICATION=1');
    expect(log).toContain('./internal/runnerstore/postgres');
    expect(log).toContain('-run \\^TestGS9F1QualificationFoundation\\$');
    expect(log).toContain('WORKFLOW_RUNNER_GS9F1_RESTART_PHASE=seed');
    expect(log).toContain('WORKFLOW_RUNNER_GS9F1_RESTART_PHASE=verify');
    expect(log).toContain('-run \\^TestGS9F1RestartFoundation\\$');
    expect(log).toContain('-run \\^TestGS9F1ImageDefaultOff\\$');
    expect(log).toContain('WORKFLOW_RUNNER_GS9F1_DEFAULT_ORIGIN=http://application:8080');
    expect(log).not.toContain('./cmd/runner-server -list \\^TestGS9F1');
    expect(log).not.toContain('WORKFLOW_RUNNER_V2_SUBMISSION_ENABLED=true');
    expect(log).not.toContain('WORKFLOW_RUNNER_V2_ROUTING_ENABLED=true');
    for (const deferredAdapter of [
      'WORKFLOW_RUNNER_V2_CHECKPOINT_ADAPTER',
      'WORKFLOW_RUNNER_V2_EFFECT_ADAPTER',
      'WORKFLOW_RUNNER_V2_BUDGET_ADAPTER',
      'WORKFLOW_RUNNER_V2_RESUME_ADAPTER',
      'WORKFLOW_RUNNER_GS9F2',
    ]) {
      expect(log).not.toContain(deferredAdapter);
      expect(goCheckSource).not.toContain(deferredAdapter);
    }
    const restartSchemas = [
      ...log.matchAll(
        /WORKFLOW_RUNNER_GS9F1_RESTART_SCHEMA=(workflow_control_gs9f1_restart_[a-z0-9]+)/gu,
      ),
    ].map((match) => match[1]);
    // Each seed/verify phase is logged once for selector discovery and once for execution.
    expect(restartSchemas).toHaveLength(4);
    expect(new Set(restartSchemas).size).toBe(1);
    expect(log.match(/ restart /gu)).toHaveLength(7);

    const failureFixture = createFixture();
    const failureModuleRoot = join(failureFixture.root, 'services/pure');
    addFullServiceCapabilities(failureModuleRoot);
    addWorkflowRunnerEvidence(failureModuleRoot);
    addWorkflowRunnerV2FoundationEvidence(failureModuleRoot);
    addWorkflowAuthorityEvidence(failureModuleRoot);
    addWorkflowCheckpointShadowEvidence(failureModuleRoot);
    addWorkflowEffectShadowEvidence(failureModuleRoot);
    addWorkflowBudgetAuthorityEvidence(failureModuleRoot);
    writeServiceConfig(failureFixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-runner-v2-foundation-v1',
    });
    commitFixture(failureFixture.root);

    const failure = runGoCheck(failureFixture, ['services/pure'], {
      FAKE_GS9F1_FAIL_PHASE: 'runner-v2-foundation-bounds',
      FAKE_GS9F1_FAIL_STATUS: '52',
    });
    expect(failure.status).toBe(52);
    const failureLog = readFileSync(failureFixture.dockerLog, 'utf8');
    expect(failureLog).toContain('-qualification-runner-v2-foundation-bounds');
    expect(failureLog).not.toContain('WORKFLOW_RUNNER_GS9F1_RESTART_PHASE=seed');

    const emptySelection = runGoCheck(failureFixture, ['services/pure'], {
      FAKE_GO_TEST_LIST_EMPTY: '1',
    });
    expect(emptySelection.status).toBe(1);
    expect(emptySelection.stderr).toContain(
      'Workflow Control runner test selector matched no tests:',
    );
  }, 30_000);

  it('runs the Workflow Control GS9-F2b runtime-delivery profile as a real F1 superset', () => {
    const fixture = createFixture();
    const moduleRoot = join(fixture.root, 'services/pure');
    addFullServiceCapabilities(moduleRoot);
    addWorkflowRunnerEvidence(moduleRoot);
    addWorkflowRunnerV2FoundationEvidence(moduleRoot);
    addWorkflowRunnerV2RuntimeDeliveryEvidence(moduleRoot);
    addWorkflowAuthorityEvidence(moduleRoot);
    addWorkflowCheckpointShadowEvidence(moduleRoot);
    addWorkflowEffectShadowEvidence(moduleRoot);
    addWorkflowBudgetAuthorityEvidence(moduleRoot);
    writeServiceConfig(fixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-runner-v2-runtime-delivery-v1',
    });
    commitFixture(fixture.root);

    const result = runGoCheck(fixture, ['services/pure']);

    expect(result.status, result.stderr).toBe(0);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain('WORKFLOW_RUNNER_GS9F1_QUALIFICATION=1');
    expect(log).toContain('WORKFLOW_RUNNER_GS9F2_QUALIFICATION=1');
    expect(log).toContain('-run \\^TestGS9F2AuthorityBindingRuntimeDelivery\\$');
    expect(log).toContain('-run \\^TestGS9F2AuthorityBindingMigrationGuards\\$');
    expect(log).toContain('-run \\^TestGS9F2Qualification\\$');
    expect(log).toContain('WORKFLOW_RUNNER_GS9F2_RESTART_PHASE=seed');
    expect(log).toContain('WORKFLOW_RUNNER_GS9F2_RESTART_PHASE=verify');
    expect(log).toContain('-run \\^TestGS9F2AuthorityBindingRestartRecovery\\$');
    expect(log).toContain('-run \\^TestGS9F2ImageDefaultOff\\$');
    expect(log).toContain(
      'WORKFLOW_RUNNER_GS9F2_DEFAULT_ORIGIN=http://runner-v2-runtime-delivery-default-off:8081',
    );
    expect(log).toContain('--entrypoint /runner-server');
    expect(log).toContain('WORKFLOW_RUNNER_CONTROL_V2_QUALIFICATION_ENABLED=1');
    expect(log).not.toContain('WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_ENABLED=1');
    expect(log).not.toContain('WORKFLOW_RUNNER_V2_SUBMISSION_ENABLED=true');
    expect(log).not.toContain('WORKFLOW_RUNNER_V2_ROUTING_ENABLED=true');
    const restartSchemas = [
      ...log.matchAll(
        /WORKFLOW_RUNNER_GS9F2_RESTART_SCHEMA=(workflow_control_gs9f2_restart_[a-z0-9]+)/gu,
      ),
    ].map((match) => match[1]);
    expect(restartSchemas).toHaveLength(4);
    expect(new Set(restartSchemas).size).toBe(1);
    expect(log.match(/ restart /gu)).toHaveLength(8);

    const failureFixture = createFixture();
    const failureModuleRoot = join(failureFixture.root, 'services/pure');
    addFullServiceCapabilities(failureModuleRoot);
    addWorkflowRunnerEvidence(failureModuleRoot);
    addWorkflowRunnerV2FoundationEvidence(failureModuleRoot);
    addWorkflowRunnerV2RuntimeDeliveryEvidence(failureModuleRoot);
    addWorkflowAuthorityEvidence(failureModuleRoot);
    addWorkflowCheckpointShadowEvidence(failureModuleRoot);
    addWorkflowEffectShadowEvidence(failureModuleRoot);
    addWorkflowBudgetAuthorityEvidence(failureModuleRoot);
    writeServiceConfig(failureFixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'workflow-control-runner-v2-runtime-delivery-v1',
    });
    commitFixture(failureFixture.root);

    const failure = runGoCheck(failureFixture, ['services/pure'], {
      FAKE_GS9F2_FAIL_PHASE: 'runner-v2-runtime-delivery-bounds',
      FAKE_GS9F2_FAIL_STATUS: '53',
    });
    expect(failure.status).toBe(53);
    const failureLog = readFileSync(failureFixture.dockerLog, 'utf8');
    expect(failureLog).toContain('-qualification-runner-v2-runtime-delivery-bounds');
    expect(failureLog).not.toContain('WORKFLOW_RUNNER_GS9F2_RESTART_PHASE=seed');

    for (const phase of [
      'runner-v2-runtime-delivery-migration',
      'runner-v2-runtime-delivery-worker',
      'runner-v2-runtime-delivery-restart-seed',
      'runner-v2-runtime-delivery-restart-verify',
      'runner-v2-runtime-delivery-image-default-off',
    ]) {
      const phaseFailure = runGoCheck(failureFixture, ['services/pure'], {
        FAKE_GS9F2_FAIL_PHASE: phase,
        FAKE_GS9F2_FAIL_STATUS: '53',
      });
      expect(phaseFailure.status, phase).toBe(53);
    }

    const skipped = runGoCheck(failureFixture, ['services/pure'], {
      FAKE_GS9F2_SKIP_TEST: 'TestGS9F2AuthorityBindingRuntimeDelivery',
    });
    expect(skipped.status).toBe(1);
    expect(skipped.stderr).toContain('Workflow Control GS9-F2b qualification test skipped');
  }, 90_000);

  it.each(['bounds', 'restart-seed', 'restart-verify', 'image-smoke'])(
    'propagates a Workflow Control GS7-B %s qualification failure before completion',
    (phase) => {
      const fixture = createFixture();
      addFullServiceCapabilities(join(fixture.root, 'services/pure'));
      mkdirSync(join(fixture.root, 'services/pure/internal/app'), { recursive: true });
      mkdirSync(join(fixture.root, 'services/pure/internal/shadowstore/postgres'), {
        recursive: true,
      });
      writeFileSync(
        join(fixture.root, 'services/pure/internal/app/handlers_test.go'),
        'package app\n\nimport "testing"\n\nfunc TestObservationProjectionAndClosedRouteSurface(t *testing.T) {}\nfunc TestObservationRejectsStoreReceiptStateDrift(t *testing.T) {}\n',
        'utf8',
      );
      writeFileSync(
        join(fixture.root, 'services/pure/internal/shadowstore/postgres/repository_test.go'),
        'package postgres\n\nimport "testing"\n\nfunc TestUnknownCommitPersistsStableReconciliationReceipt(t *testing.T) {}\n',
        'utf8',
      );
      writeFileSync(
        join(fixture.root, 'services/pure/tests/contracts/openapi_contract_test.go'),
        'package contracts\n\nimport "testing"\n\nfunc TestOpenAPIIsValidAndContainsOnlyShadowRoutes(t *testing.T) {}\n',
        'utf8',
      );
      writeServiceConfig(fixture.root, 'pure', {
        capabilities: 'database,distribution,http-openapi,prometheus',
        dockerTarget: 'app',
        runtimeProfile: 'workflow-control-shadow-v1',
      });
      commitFixture(fixture.root);

      const result = runGoCheck(fixture, ['services/pure'], {
        FAKE_GS7B_FAIL_PHASE: phase,
        FAKE_GS7B_FAIL_STATUS: '46',
      });

      expect(result.status).toBe(46);
      const log = readFileSync(fixture.dockerLog, 'utf8');
      expect(log).toContain(`-qualification-${phase}`);
      expect(log).toContain(' rm -f ');
      if (phase === 'bounds') {
        expect(log).not.toContain('WORKFLOW_CONTROL_GS7B_RESTART_PHASE=seed');
      }
      if (phase === 'restart-seed') {
        expect(log).not.toContain(' restart ');
      }
    },
  );

  it.each(['bounds', 'restart-seed', 'restart-verify'])(
    'propagates a Governance Control %s qualification failure before later gates',
    (phase) => {
      const fixture = createFixture();
      addFullServiceCapabilities(join(fixture.root, 'services/pure'));
      writeServiceConfig(fixture.root, 'pure', {
        capabilities: 'database,distribution,http-openapi,prometheus',
        dockerTarget: 'app',
        runtimeProfile: 'governance-control-v2',
      });
      commitFixture(fixture.root);

      const result = runGoCheck(fixture, ['services/pure'], {
        FAKE_GS5_FAIL_PHASE: phase,
        FAKE_GS5_FAIL_STATUS: '44',
      });

      expect(result.status).toBe(44);
      const log = readFileSync(fixture.dockerLog, 'utf8');
      expect(log).toContain(`-qualification-${phase}`);
      expect(log).toContain(' rm -f ');
      expect(log.split('\n').some((line) => line.startsWith('MSYS= build '))).toBe(false);
      if (phase === 'bounds') {
        expect(log).not.toContain('GOVERNANCE_GS5_RESTART_PHASE=seed');
      }
      if (phase === 'restart-seed') {
        expect(log).not.toContain(' restart ');
      }
    },
  );

  it.each(['authority-bounds', 'authority-restart-seed', 'authority-restart-verify'])(
    'propagates a Governance Control GS6 %s qualification failure before later gates',
    (phase) => {
      const fixture = createFixture();
      addFullServiceCapabilities(join(fixture.root, 'services/pure'));
      writeServiceConfig(fixture.root, 'pure', {
        capabilities: 'database,distribution,http-openapi,prometheus',
        dockerTarget: 'app',
        runtimeProfile: 'governance-control-v2',
      });
      commitFixture(fixture.root);

      const result = runGoCheck(fixture, ['services/pure'], {
        FAKE_GS6_FAIL_PHASE: phase,
        FAKE_GS6_FAIL_STATUS: '45',
      });

      expect(result.status).toBe(45);
      const log = readFileSync(fixture.dockerLog, 'utf8');
      expect(log).toContain(`-qualification-${phase}`);
      expect(log).toContain(' rm -f ');
      expect(log.split('\n').some((line) => line.startsWith('MSYS= build '))).toBe(false);
      if (phase === 'authority-bounds') {
        expect(log).not.toContain('GOVERNANCE_GS6_RESTART_PHASE=seed');
      }
      if (phase === 'authority-restart-seed') {
        expect(log.match(/ restart /gu)).toHaveLength(1);
      }
    },
  );

  it.each(['bounds', 'restart-seed', 'restart-verify'])(
    'propagates an Organization Graph %s qualification failure before later gates',
    (phase) => {
      const fixture = createFixture();
      addFullServiceCapabilities(join(fixture.root, 'services/pure'));
      writeServiceConfig(fixture.root, 'pure', {
        capabilities: 'database,distribution,http-openapi,prometheus',
        dockerTarget: 'app',
        runtimeProfile: 'organization-graph-v1',
      });
      commitFixture(fixture.root);

      const result = runGoCheck(fixture, ['services/pure'], {
        FAKE_GS1C_FAIL_PHASE: phase,
        FAKE_GS1C_FAIL_STATUS: '43',
      });

      expect(result.status).toBe(43);
      const log = readFileSync(fixture.dockerLog, 'utf8');
      expect(log).toContain(`-qualification-${phase}`);
      expect(log).toContain(' rm -f ');
      expect(log.split('\n').some((line) => line.startsWith('MSYS= build '))).toBe(false);
      if (phase === 'bounds') {
        expect(log).not.toContain('GRAPH_GS1C_RESTART_PHASE=seed');
      }
      if (phase === 'restart-seed') {
        expect(log).not.toContain(' restart ');
      }
    },
  );

  it('preserves failures and cleans exact resources without running later gates', () => {
    const fixture = createFixture();
    addFullServiceCapabilities(join(fixture.root, 'services/pure'));
    writeServiceConfig(fixture.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus,worker',
      dockerTarget: 'app',
      runtimeProfile: 'notification-delivery-v1',
    });
    commitFixture(fixture.root);

    const result = runGoCheck(fixture, ['services/pure'], {
      FAKE_MODULE_RUN_STATUS: '41',
    });

    expect(result.status).toBe(41);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log.split('\n').some((line) => line.startsWith('MSYS= build '))).toBe(false);
    expect(log).toContain(' rm -f ');
    expect(log).toContain('network rm');
    expect(log).toContain('volume rm');
    expect(log.split('\n').some((line) => /volume rm.*openslack-go-check-mod/u.test(line))).toBe(
      false,
    );

    const collision = createFullServiceFixture();
    const collisionResult = runGoCheck(collision, ['services/pure'], {
      FAKE_OWNERSHIP_MISMATCH: '1',
    });
    expect(collisionResult.status).toBe(1);
    const collisionLog = readFileSync(collision.dockerLog, 'utf8');
    expect(collisionLog).not.toContain('network rm');
    expect(collisionLog).not.toContain('volume rm -f');
  }, 15_000);

  it('uses cygpath and disables MSYS argument conversion under Git Bash', () => {
    const fixture = createFixture();
    const result = runGoCheck(fixture, ['services/pure'], {
      FAKE_UNAME_S: 'MSYS_NT-10.0',
      FAKE_UNAME_R: '3.5.4',
      FAKE_DOCKER_CLIENT_OS: 'windows',
    });

    expect(result.status).toBe(0);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain('MSYS=1');
    expect(log).toContain('source=C:\\\\converted');
  });

  it('uses wslpath only for a Windows Docker client under WSL', () => {
    const fixture = createFixture();
    const result = runGoCheck(fixture, ['services/pure'], {
      FAKE_UNAME_S: 'Linux',
      FAKE_UNAME_R: '6.6.87.2-microsoft-standard-WSL2',
      FAKE_DOCKER_CLIENT_OS: 'windows',
    });

    expect(result.status).toBe(0);
    const log = readFileSync(fixture.dockerLog, 'utf8');
    expect(log).toContain('source=D:\\\\converted');
    expect(log).not.toContain(`source=${fixture.root}/services/pure`);
  });

  it('rejects unsafe repository and committed module material before execution', () => {
    const rootModule = createFixture();
    writeFileSync(join(rootModule.root, 'go.mod'), 'module forbidden\n', 'utf8');
    expect(runGoCheck(rootModule, ['services/pure']).stderr).toContain('root go.mod is forbidden');

    const missingSum = createFixture();
    rmSync(join(missingSum.root, 'services/pure/go.sum'));
    commitFixture(missingSum.root);
    expect(runGoCheck(missingSum, ['services/pure']).stderr).toContain(
      'module is missing a regular go.sum',
    );

    const credential = createFixture();
    writeFileSync(join(credential.root, 'services/pure/client.p12'), 'not-a-secret\n', 'utf8');
    commitFixture(credential.root);
    expect(runGoCheck(credential, ['services/pure']).stderr).toContain(
      'forbidden credential material',
    );

    const repositoryCredential = createFixture();
    mkdirSync(join(repositoryCredential.root, 'packages/unrelated'), { recursive: true });
    writeFileSync(
      join(repositoryCredential.root, 'packages/unrelated/client.p12'),
      'not-a-secret\n',
      'utf8',
    );
    commitFixture(repositoryCredential.root);
    const repositoryCredentialResult = runGoCheck(repositoryCredential, ['services/pure']);
    expect(repositoryCredentialResult.status).toBe(1);
    expect(repositoryCredentialResult.stderr).toContain(
      'committed repository snapshot contains forbidden credential material',
    );
    expect(readFileSync(repositoryCredential.dockerLog, 'utf8')).not.toContain(
      '/input/container-gate.sh',
    );

    const repositoryCredentialDirectory = createFixture();
    mkdirSync(join(repositoryCredentialDirectory.root, 'packages/unrelated/credentials'), {
      recursive: true,
    });
    writeFileSync(
      join(repositoryCredentialDirectory.root, 'packages/unrelated/credentials/token.txt'),
      'not-a-secret\n',
      'utf8',
    );
    commitFixture(repositoryCredentialDirectory.root);
    expect(runGoCheck(repositoryCredentialDirectory, ['services/pure']).stderr).toContain(
      'committed repository snapshot contains forbidden credential material',
    );
  }, 15_000);

  it('requires a closed reviewed capability declaration and all of its artifacts', () => {
    const cases = [
      {
        capabilities: 'database',
        expected: 'database capability requires migrations',
      },
      {
        capabilities: 'http-openapi',
        runtimeProfile: 'notification-delivery-v1',
        expected: 'HTTP capability requires docs/api/openapi.yaml',
      },
      {
        capabilities: 'prometheus',
        expected: 'Prometheus capability requires deploy/prometheus',
      },
      {
        capabilities: 'worker',
        expected: 'worker capability requires cmd/worker/main.go',
      },
      {
        capabilities: 'distribution',
        dockerTarget: 'app',
        expected: 'distribution capability requires a Dockerfile',
      },
    ];

    for (const testCase of cases) {
      const fixture = createFixture();
      writeServiceConfig(fixture.root, 'pure', {
        capabilities: testCase.capabilities,
        dockerTarget: testCase.dockerTarget,
        runtimeProfile: testCase.runtimeProfile,
      });
      commitFixture(fixture.root);
      const result = runGoCheck(fixture, ['services/pure']);
      expect(result.status, testCase.capabilities).toBe(1);
      expect(result.stderr, testCase.capabilities).toContain(testCase.expected);
    }

    const incompleteGovernanceProfile = createFixture();
    addFullServiceCapabilities(join(incompleteGovernanceProfile.root, 'services/pure'));
    rmSync(
      join(incompleteGovernanceProfile.root, 'services/pure/cmd/server/qualification_test.go'),
    );
    writeServiceConfig(incompleteGovernanceProfile.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus',
      dockerTarget: 'app',
      runtimeProfile: 'governance-control-v2',
    });
    commitFixture(incompleteGovernanceProfile.root);
    const incompleteGovernanceResult = runGoCheck(incompleteGovernanceProfile, ['services/pure']);
    expect(incompleteGovernanceResult.status).toBe(1);
    expect(incompleteGovernanceResult.stderr).toContain(
      'Governance Control runtime profile is missing cmd/server/qualification_test.go',
    );

    const noGS6Qualification = createFixture();
    addFullServiceCapabilities(join(noGS6Qualification.root, 'services/pure'));
    writeFileSync(
      join(noGS6Qualification.root, 'services/pure/cmd/server/qualification_test.go'),
      'package main\n',
      'utf8',
    );
    writeServiceConfig(noGS6Qualification.root, 'pure', {
      capabilities: 'database,distribution,http-openapi,prometheus',
      dockerTarget: 'app',
      runtimeProfile: 'governance-control-v2',
    });
    commitFixture(noGS6Qualification.root);
    const noGS6Result = runGoCheck(noGS6Qualification, ['services/pure']);
    expect(noGS6Result.status).toBe(1);
    expect(noGS6Result.stderr).toContain(
      'Governance Control v2 runtime profile is missing TestGS6Qualification',
    );

    const reopenedContext = createFullServiceFixture();
    const dockerignore = join(reopenedContext.root, 'services/pure/.dockerignore');
    writeFileSync(dockerignore, `${readFileSync(dockerignore, 'utf8')}\n !** \n`, 'utf8');
    commitFixture(reopenedContext.root);
    const reopenedResult = runGoCheck(reopenedContext, ['services/pure']);
    expect(reopenedResult.status).toBe(1);
    expect(reopenedResult.stderr).toContain('unreviewed allow rule');

    const unicodeContext = createFullServiceFixture();
    const unicodeDockerignore = join(unicodeContext.root, 'services/pure/.dockerignore');
    writeFileSync(
      unicodeDockerignore,
      `${readFileSync(unicodeDockerignore, 'utf8')}\n\u00a0!**\u00a0\n`,
      'utf8',
    );
    commitFixture(unicodeContext.root);
    const unicodeResult = runGoCheck(unicodeContext, ['services/pure']);
    expect(unicodeResult.status).toBe(1);
    expect(unicodeResult.stderr).toContain('non-ASCII or control characters');

    for (const requiredIntegrationEvidence of [
      'tests/integration/notificationstore_test.go',
      'tests/integration/operations_observability_test.go',
    ]) {
      const missingEvidence = createFullServiceFixture();
      rmSync(join(missingEvidence.root, 'services/pure', requiredIntegrationEvidence));
      commitFixture(missingEvidence.root);
      const missingEvidenceResult = runGoCheck(missingEvidence, ['services/pure']);
      expect(missingEvidenceResult.status, requiredIntegrationEvidence).toBe(1);
      expect(missingEvidenceResult.stderr, requiredIntegrationEvidence).toContain(
        `Notification Delivery worker capability is missing ${requiredIntegrationEvidence}`,
      );
    }
  }, 35_000);

  it('fails closed for missing, unhealthy, and exited application health contracts', () => {
    for (const health of ['no-healthcheck', 'unhealthy']) {
      const fixture = createFullServiceFixture();
      const result = runGoCheck(fixture, ['services/pure'], {
        FAKE_APP_HEALTH: health,
      });
      expect(result.status, health).toBe(1);
      expect(result.stderr, health).toContain(`application container health is ${health}`);
      expect(readFileSync(fixture.dockerLog, 'utf8')).toContain('rm -f');
    }

    const exited = createFullServiceFixture();
    const exitedResult = runGoCheck(exited, ['services/pure'], {
      FAKE_APP_STATE: 'exited',
    });
    expect(exitedResult.status).toBe(1);
    expect(exitedResult.stderr).toContain('application container state is exited');

    const paused = createFullServiceFixture();
    const pausedResult = runGoCheck(paused, ['services/pure'], {
      FAKE_APP_STATE: 'paused',
    });
    expect(pausedResult.status).toBe(1);
    expect(pausedResult.stderr).toContain('application container state is paused');
  }, 45_000);

  it('maps termination to failure and still cleans registered resources', async () => {
    const fixture = createFixture();
    const marker = join(fixture.root, 'blocked');
    const running = spawn(
      '/bin/bash',
      [join(fixture.root, 'scripts/go-check.sh'), 'services/pure'],
      {
        cwd: fixture.root,
        detached: true,
        env: goCheckEnvironment(fixture, {
          FAKE_BLOCK_MODULE_RUN: '1',
          FAKE_BLOCK_MARKER: marker,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    await waitForPath(marker);
    const signalStartedAt = Date.now();
    process.kill(running.pid!, 'SIGTERM');
    const status = await new Promise<number | null>((resolveStatus) => {
      running.once('close', resolveStatus);
    });

    expect(status).not.toBe(0);
    expect(Date.now() - signalStartedAt).toBeLessThan(2_000);
    expect(readFileSync(fixture.dockerLog, 'utf8')).toContain(' rm -f ');
  });
});

describeOnBashHosts('Go module container gate', () => {
  it('executes the common gate in strict order with a closed fake toolchain', () => {
    const fixture = createContainerGateFixture();
    const result = runContainerGate(fixture);

    expect(result.status).toBe(0);
    expect(readFileSync(join(fixture.work, 'repository/LICENSE'), 'utf8')).toBe(
      'repository context\n',
    );
    expect(readFileSync(join(fixture.work, 'repository/services/pure/go.mod'), 'utf8')).toContain(
      'github.com/Negentropy-Laby/OpenSlack/services/pure',
    );
    expect(readFileSync(fixture.commandLog, 'utf8').trim().split('\n')).toEqual([
      'go env GOWORK',
      'go env GOVERSION',
      'go env GOMODCACHE',
      'go env GOCACHE',
      'go list -m -f {{.Path}}',
      'go list -m -f {{.GoVersion}}',
      'go mod verify',
      'go mod tidy',
      'gofmt -l .',
      'go build ./...',
      'go vet ./...',
      'go test -race ./...',
    ]);
  });

  it('executes migration and repeated race gates only for database modules', () => {
    const fixture = createContainerGateFixture();
    const result = runContainerGate(fixture, {
      DATABASE_URL: 'postgres://database',
      MIGRATION_DATABASE_URL: 'pgx5://database',
    });

    expect(result.status).toBe(0);
    const log = readFileSync(fixture.commandLog, 'utf8');
    expect(log).toContain('go list -m -f {{.Version}} github.com/golang-migrate/migrate/v4');
    expect(log).toContain('go install -tags pgx5');
    expect(log).toContain('migrate -path migrations -database pgx5://database up');
    expect(log).toContain('go test -race ./... -count=5');
  });

  it('propagates every common command failure without running later gates', () => {
    for (const command of [
      'mod verify',
      'mod tidy',
      'build ./...',
      'vet ./...',
      'test -race ./...',
    ]) {
      const fixture = createContainerGateFixture();
      const result = runContainerGate(fixture, { FAKE_GO_FAIL: command });
      expect(result.status, command).toBe(42);
      const log = readFileSync(fixture.commandLog, 'utf8');
      expect(log, command).not.toContain('go test -race ./... -count=5');
    }
  });

  it('rejects tidy drift and unformatted Go before build', () => {
    const modDrift = createContainerGateFixture();
    expect(runContainerGate(modDrift, { FAKE_TIDY_DRIFT: 'go.mod' }).status).toBe(1);

    const sumDrift = createContainerGateFixture();
    expect(runContainerGate(sumDrift, { FAKE_TIDY_DRIFT: 'go.sum' }).status).toBe(1);

    const formatting = createContainerGateFixture();
    const formattingResult = runContainerGate(formatting, {
      FAKE_GOFMT_OUTPUT: 'main.go',
    });
    expect(formattingResult.status).toBe(1);
    expect(readFileSync(formatting.commandLog, 'utf8')).not.toContain('go build');
  });

  it('requires literal off and exact module and Go versions', () => {
    const cases: Array<Record<string, string>> = [
      { FAKE_GOWORK: '' },
      { FAKE_GO_VERSION: 'go1.26.4' },
      { FAKE_MODULE_PATH: 'example.com/forged' },
      { FAKE_MODULE_GO_VERSION: '1.26.4' },
      { GO_CHECK_MODULE_RELATIVE_PATH: '../services/pure' },
      { GO_CHECK_MODULE_RELATIVE_PATH: 'services/pure/child' },
    ];
    for (const env of cases) {
      const fixture = createContainerGateFixture();
      expect(runContainerGate(fixture, env).status).toBe(1);
    }

    const trailingHyphen = createContainerGateFixture();
    const trailingModule = join(trailingHyphen.source, 'services/pure-');
    mkdirSync(trailingModule, { recursive: true });
    for (const file of ['go.mod', 'go.sum', 'main.go']) {
      copyFileSync(join(trailingHyphen.source, 'services/pure', file), join(trailingModule, file));
    }
    expect(
      runContainerGate(trailingHyphen, {
        GO_CHECK_MODULE_RELATIVE_PATH: 'services/pure-',
      }).status,
    ).toBe(0);
  });
});

type Fixture = {
  root: string;
  bin: string;
  dockerLog: string;
  ownerFile: string;
  modules: string[];
};

function createFixture(modules: string[] = ['pure']): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'openslack-go-check-'));
  temporaryRoots.push(root);
  const bin = join(root, 'bin');
  const scripts = join(root, 'scripts');
  const parserDirectory = join(scripts, 'go-check');
  const serviceConfigDirectory = join(parserDirectory, 'services');
  const dockerLog = join(root, 'docker.log');
  const ownerFile = join(root, 'owner');
  mkdirSync(bin, { recursive: true });
  mkdirSync(serviceConfigDirectory, { recursive: true });
  mkdirSync(join(root, 'services'), { recursive: true });
  mkdirSync(join(root, 'packages/credentials'), { recursive: true });
  writeFileSync(dockerLog, '', 'utf8');
  writeFileSync(ownerFile, '', 'utf8');
  writeFileSync(
    join(root, 'packages/credentials/package.json'),
    '{"name":"@openslack/credentials","private":true}\n',
    'utf8',
  );

  copyFileSync(join(repositoryRoot, 'scripts/go-check.sh'), join(scripts, 'go-check.sh'));
  copyFileSync(
    join(repositoryRoot, 'scripts/workflow-contract-families.generated.sh'),
    join(scripts, 'workflow-contract-families.generated.sh'),
  );
  copyFileSync(
    join(repositoryRoot, 'scripts/go-check/parse-work-json.go'),
    join(parserDirectory, 'parse-work-json.go'),
  );
  copyFileSync(
    join(repositoryRoot, 'scripts/go-check/parse-work-json_test.go'),
    join(parserDirectory, 'parse-work-json_test.go'),
  );
  copyFileSync(
    join(repositoryRoot, 'scripts/go-check/container-gate.sh'),
    join(parserDirectory, 'container-gate.sh'),
  );
  chmodSync(join(scripts, 'go-check.sh'), 0o755);
  chmodSync(join(parserDirectory, 'container-gate.sh'), 0o755);
  for (const module of modules) {
    writeModule(join(root, 'services', module), module);
    writeServiceConfig(root, module);
  }
  writeWorkspace(root, modules);
  writeFakeExecutables(bin);

  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Go Check Test'], { cwd: root, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'go-check@example.invalid'], {
    cwd: root,
    stdio: 'pipe',
  });
  commitFixture(root);
  return { root, bin, dockerLog, ownerFile, modules };
}

function writeModule(path: string, name: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'go.mod'),
    `module github.com/Negentropy-Laby/OpenSlack/services/${name}\n\ngo 1.26.5\n`,
    'utf8',
  );
  writeFileSync(join(path, 'go.sum'), '', 'utf8');
  writeFileSync(join(path, 'main.go'), `package ${name.replaceAll('-', '_')}\n`, 'utf8');
}

function writeServiceConfig(
  root: string,
  module: string,
  options: {
    capabilities?: string;
    dockerTarget?: string;
    runtimeProfile?: string;
  } = {},
): void {
  const configRoot = join(root, 'scripts/go-check/services');
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(
    join(configRoot, `${module}.conf`),
    [
      `capabilities=${options.capabilities ?? 'pure'}`,
      `docker_target=${options.dockerTarget ?? 'none'}`,
      `runtime_profile=${options.runtimeProfile ?? 'none'}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

function commitFixture(root: string): void {
  execFileSync('git', ['add', '--all'], { cwd: root, stdio: 'pipe' });
  const result = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: root, stdio: 'pipe' });
  if (result.status === 0) return;
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: root, stdio: 'pipe' });
}

function writeWorkspace(root: string, modules: string[]): void {
  const use =
    modules.length === 1
      ? `use ./services/${modules[0]}\n`
      : `use (\n${modules.map((module) => `\t./services/${module}`).join('\n')}\n)\n`;
  writeFileSync(join(root, 'go.work'), `go 1.26.5\n\n${use}`, 'utf8');
}

function addFullServiceCapabilities(moduleRoot: string): void {
  for (const directory of [
    'migrations',
    'tests/integration',
    'tests/contracts',
    'docs/api',
    'deploy/prometheus',
    'integration',
    'cmd/server',
    'internal/delivery',
    'internal/leaserecovery',
    'internal/reliability',
  ]) {
    mkdirSync(join(moduleRoot, directory), { recursive: true });
  }
  writeFileSync(join(moduleRoot, 'migrations/000001_init.up.sql'), 'SELECT 1;\n', 'utf8');
  writeFileSync(
    join(moduleRoot, 'tests/integration/integration_test.go'),
    'package integration\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'tests/contracts/openapi_contract_test.go'),
    'package contracts\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'cmd/server/qualification_test.go'),
    [
      'package main',
      '',
      'import "testing"',
      '',
      'func TestGS5Fixture(t *testing.T) {}',
      'func TestGS6Qualification(t *testing.T) {}',
      'func TestGS6RestartQualification(t *testing.T) {}',
      'func TestGS6ImageSmoke(t *testing.T) {}',
      'func TestGS7BQualification(t *testing.T) {}',
      'func TestGS7BRestartQualification(t *testing.T) {}',
      'func TestGS7BImageSmoke(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(join(moduleRoot, 'docs/api/openapi.yaml'), 'openapi: 3.1.0\n', 'utf8');
  writeFileSync(join(moduleRoot, 'Dockerfile'), 'FROM scratch\n', 'utf8');
  writeFileSync(join(moduleRoot, 'SBOM.cdx.json'), '{}\n', 'utf8');
  writeFileSync(join(moduleRoot, 'LICENSE'), 'test\n', 'utf8');
  writeFileSync(join(moduleRoot, 'NOTICE'), 'test\n', 'utf8');
  writeFileSync(join(moduleRoot, 'THIRD_PARTY_NOTICES.md'), '# Test\n', 'utf8');
  writeFileSync(join(moduleRoot, '.dockerignore'), '**\n', 'utf8');
  writeFileSync(join(moduleRoot, 'integration/source-manifest.v2.json'), '{}\n', 'utf8');
  for (const workerEvidence of [
    'internal/delivery/worker_test.go',
    'internal/delivery/backoff_test.go',
    'internal/leaserecovery/runner_test.go',
    'internal/reliability/service_test.go',
    'tests/integration/delivery_test.go',
    'tests/integration/notificationstore_test.go',
    'tests/integration/operations_observability_test.go',
  ]) {
    writeFileSync(
      join(moduleRoot, workerEvidence),
      workerEvidence.startsWith('tests/integration/')
        ? 'package integration\n'
        : 'package worker\n',
      'utf8',
    );
  }
  writeFileSync(join(moduleRoot, 'deploy/prometheus/prometheus.yml'), 'global: {}\n', 'utf8');
  writeFileSync(join(moduleRoot, 'deploy/prometheus/alerts.yml'), 'groups: []\n', 'utf8');
  writeFileSync(join(moduleRoot, 'deploy/prometheus/rules.test.yml'), 'rule_files: []\n', 'utf8');
}

function addWorkflowRunnerEvidence(moduleRoot: string): void {
  for (const directory of [
    'cmd/runner-server',
    'internal/app',
    'internal/processsupervisor',
    'internal/runnerscheduler',
    'internal/runnerstore/postgres',
    'internal/shadowstore/postgres',
  ]) {
    mkdirSync(join(moduleRoot, directory), { recursive: true });
  }
  writeFileSync(join(moduleRoot, 'cmd/runner-server/main.go'), 'package main\n', 'utf8');
  writeFileSync(
    join(moduleRoot, 'cmd/runner-server/qualification_test.go'),
    [
      'package main',
      '',
      'import "testing"',
      '',
      'func TestGS8BQualification(t *testing.T) {}',
      'func TestGS8BQualificationProcessIdentityIsStableWithinOneProcess(t *testing.T) {}',
      'func TestGS8BRestartQualification(t *testing.T) {}',
      'func TestGS8BImageDefaultOff(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/processsupervisor/supervisor_test.go'),
    'package processsupervisor\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/runnerscheduler/session_test.go'),
    'package runnerscheduler\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/runnerstore/postgres/runner_runtime_integration_test.go'),
    'package postgres\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/app/handlers_test.go'),
    'package app\n\nimport "testing"\n\nfunc TestObservationProjectionAndClosedRouteSurface(t *testing.T) {}\nfunc TestObservationRejectsStoreReceiptStateDrift(t *testing.T) {}\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/shadowstore/postgres/repository_test.go'),
    'package postgres\n\nimport "testing"\n\nfunc TestUnknownCommitPersistsStableReconciliationReceipt(t *testing.T) {}\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'tests/contracts/openapi_contract_test.go'),
    'package contracts\n\nimport "testing"\n\nfunc TestOpenAPIIsValidAndContainsOnlyShadowRoutes(t *testing.T) {}\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'tests/contracts/runner_openapi_contract_test.go'),
    'package contracts\n',
    'utf8',
  );
  writeFileSync(join(moduleRoot, 'docs/api/runner-openapi.yaml'), 'openapi: 3.1.0\n', 'utf8');
}

function addWorkflowRunnerV2FoundationEvidence(moduleRoot: string): void {
  const qualificationPath = join(
    moduleRoot,
    'internal/runnerstore/postgres/v2_foundation_integration_test.go',
  );
  mkdirSync(join(moduleRoot, 'internal/runnerstore/postgres'), { recursive: true });
  writeFileSync(
    qualificationPath,
    `package postgres\n\nimport "testing"\n\nfunc TestGS9F1QualificationFoundation(t *testing.T) { _ = "WORKFLOW_RUNNER_GS9F1_QUALIFICATION" }\nfunc TestGS9F1RestartFoundation(t *testing.T) {\n\t_ = "WORKFLOW_RUNNER_GS9F1_RESTART_PHASE"\n\tswitch "seed" {\n\tcase "seed":\n\tcase "verify":\n\t}\n}\nfunc TestGS9F1ImageDefaultOff(t *testing.T) { _ = "WORKFLOW_RUNNER_GS9F1_DEFAULT_ORIGIN" }\n`,
    'utf8',
  );
}

function addWorkflowRunnerV2RuntimeDeliveryEvidence(moduleRoot: string): void {
  for (const directory of [
    'migrations',
    'internal/runnerconfig',
    'internal/runnerstore',
    'internal/runnerstore/postgres',
  ]) {
    mkdirSync(join(moduleRoot, directory), { recursive: true });
  }
  writeFileSync(
    join(moduleRoot, 'migrations/000008_deliver_workflow_runner_authority_bindings.up.sql'),
    'BEGIN;\nCOMMIT;\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'migrations/000008_deliver_workflow_runner_authority_bindings.down.sql'),
    'BEGIN;\nCOMMIT;\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/runnerstore/v2_binding.go'),
    'package runnerstore\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/runnerstore/postgres/v2_binding.go'),
    'package postgres\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/runnerconfig/gs9f2.go'),
    'package runnerconfig\n\nconst marker = "WORKFLOW_RUNNER_CONTROL_V2_RUNTIME_DELIVERY_ENABLED"\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/runnerstore/postgres/gs9f2_runtime_integration_test.go'),
    [
      'package postgres',
      '',
      'import "testing"',
      '',
      'func TestGS9F2AuthorityBindingRuntimeDelivery(t *testing.T) { _ = "WORKFLOW_RUNNER_GS9F2_QUALIFICATION" }',
      'func TestGS9F2AuthorityBindingRestartRecovery(t *testing.T) {',
      '\t_ = "WORKFLOW_RUNNER_GS9F2_RESTART_PHASE"',
      '\t_ = "WORKFLOW_RUNNER_GS9F2_RESTART_SCHEMA"',
      '}',
      'func TestGS9F2AuthorityBindingMigrationGuards(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'cmd/runner-server/gs9f2_qualification_test.go'),
    [
      'package main',
      '',
      'import "testing"',
      '',
      'func TestGS9F2Qualification(t *testing.T) { _ = "WORKFLOW_RUNNER_GS9F2_QUALIFICATION" }',
      'func TestGS9F2ImageDefaultOff(t *testing.T) { _ = "WORKFLOW_RUNNER_GS9F2_DEFAULT_ORIGIN" }',
      '',
    ].join('\n'),
    'utf8',
  );
}

function addWorkflowAuthorityEvidence(moduleRoot: string): void {
  for (const directory of [
    'cmd/authority-server',
    'internal/authorityapp',
    'internal/authoritystore/postgres',
  ]) {
    mkdirSync(join(moduleRoot, directory), { recursive: true });
  }
  writeFileSync(join(moduleRoot, 'cmd/authority-server/main.go'), 'package main\n', 'utf8');
  writeFileSync(
    join(moduleRoot, 'cmd/authority-server/qualification_test.go'),
    [
      'package main',
      '',
      'import "testing"',
      '',
      'func TestGS9BQualification(t *testing.T) {}',
      'func TestGS9BRestartQualification(t *testing.T) {}',
      'func TestGS9BImageDefaultOff(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/authorityapp/server_test.go'),
    [
      'package authorityapp',
      '',
      'import "testing"',
      '',
      'func TestServiceDefaultsToHealthOnly(t *testing.T) {}',
      'func TestServiceMapsCommitUnknownToStableNon2xx(t *testing.T) {}',
      'func TestServiceMapsStoredIntegrityFailureTo500(t *testing.T) {}',
      'func TestQualificationReadinessUsesLightweightProbe(t *testing.T) {}',
      'func TestQualificationReadinessFailureIsNotReady(t *testing.T) {}',
      'func TestAuthorityTimeoutBudgetsLeaveWriteSlack(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/authoritystore/postgres/repository_test.go'),
    [
      'package postgres',
      '',
      'import "testing"',
      '',
      'func TestGS9BAuthorityAcceptAndByteIdenticalReplay(t *testing.T) {}',
      'func TestGS9BAuthorityReadRejectsTamperedCanonicalRecordBytes(t *testing.T) {}',
      'func TestGS9BAuthorityReadRejectsTamperedCanonicalOutboxBytes(t *testing.T) {}',
      'func TestGS9BAuthorityRejectsCorruptStoredReceiptAsIntegrityFailure(t *testing.T) {}',
      'func TestGS9BAuthorityReadyUsesLightweightProbe(t *testing.T) {}',
      'func TestGS9BAuthorityMutationRemainsCompatibleWithoutBudgetNamespace(t *testing.T) {}',
      'func TestGS9BAuthoritySameKeyDifferentFingerprintConflicts(t *testing.T) {}',
      'func TestGS9BAuthorityTransitionCASAndOutboxAtomicity(t *testing.T) {}',
      'func TestGS9BAuthorityRouteDriftConflicts(t *testing.T) {}',
      'func TestGS9BAuthorityConcurrentCASHasOneWinner(t *testing.T) {}',
      'func TestGS9BAuthorityCommittedResponseLossRecoversExactReceipt(t *testing.T) {}',
      'func TestGS9BAuthorityUnknownCommitPersistsReconciliationWithoutHead(t *testing.T) {}',
      'func TestGS9BAuthorityDoubleUnknownFailsClosed(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/authoritystore/request_test.go'),
    'package authoritystore\n\nimport "testing"\n\nfunc TestPrepareRequestRejectsNonCanonicalAndInvalidTransition(t *testing.T) {}\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'tests/integration/migration_test.go'),
    [
      'package integration',
      '',
      'import "testing"',
      '',
      'func TestMigrationCreatesIsolatedShadowRunnerAndAuthorityNamespacesWithImmutableEvidence(t *testing.T) {}',
      'func TestAuthorityMigrationDoesNotClaimLaterGS9OrRunnerLifecycle(t *testing.T) {}',
      'func TestAuthorityDownMigrationIsIsolatedAndRefusesRegisteredEpochs(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'tests/contracts/authority_openapi_contract_test.go'),
    'package contracts\n\nimport "testing"\n\nfunc TestAuthorityOpenAPIContract(t *testing.T) {}\n',
    'utf8',
  );
  writeFileSync(join(moduleRoot, 'docs/api/authority-openapi.yaml'), 'openapi: 3.1.0\n', 'utf8');
}

function addWorkflowCheckpointShadowEvidence(moduleRoot: string): void {
  const fixtureRoot = resolve(moduleRoot, '../..');
  for (const directory of [
    'scripts/workflow-checkpoint-shadow-contracts',
    'packages/workflows/contracts/workflow-checkpoint-shadow/v1',
  ]) {
    mkdirSync(join(fixtureRoot, directory), { recursive: true });
  }
  writeFileSync(
    join(fixtureRoot, 'scripts/workflow-checkpoint-shadow-contracts/index.ts'),
    'export {};\n',
    'utf8',
  );
  writeFileSync(
    join(fixtureRoot, 'scripts/workflow-checkpoint-shadow-contracts/tsconfig.json'),
    '{}\n',
    'utf8',
  );
  writeFileSync(
    join(fixtureRoot, 'packages/workflows/contracts/workflow-checkpoint-shadow/v1/manifest.json'),
    '{}\n',
    'utf8',
  );
  writeFileSync(
    join(
      fixtureRoot,
      'packages/workflows/contracts/workflow-checkpoint-shadow/v1/golden-vectors.json',
    ),
    '{}\n',
    'utf8',
  );
  for (const directory of [
    'cmd/checkpoint-shadow-server',
    'internal/checkpointshadowapp',
    'internal/checkpointshadowstore/postgres',
  ]) {
    mkdirSync(join(moduleRoot, directory), { recursive: true });
  }
  writeFileSync(join(moduleRoot, 'cmd/checkpoint-shadow-server/main.go'), 'package main\n', 'utf8');
  writeFileSync(
    join(moduleRoot, 'cmd/checkpoint-shadow-server/qualification_test.go'),
    [
      'package main',
      '',
      'import "testing"',
      '',
      'func TestGS9CQualification(t *testing.T) {}',
      'func TestGS9CRestartQualification(t *testing.T) {}',
      'func TestGS9CImageDefaultOff(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/checkpointshadowapp/server_test.go'),
    'package checkpointshadowapp\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/checkpointshadowstore/postgres/repository_test.go'),
    'package postgres\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'migrations/000004_create_workflow_control_checkpoint_shadow.up.sql'),
    'SELECT 1;\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'migrations/000004_create_workflow_control_checkpoint_shadow.down.sql'),
    'SELECT 1;\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'tests/contracts/checkpoint_shadow_openapi_contract_test.go'),
    'package contracts\n\nimport "testing"\n\nfunc TestCheckpointShadowOpenAPIIsClosedAndValid(t *testing.T) {}\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'docs/api/checkpoint-shadow-openapi.yaml'),
    'openapi: 3.1.0\n',
    'utf8',
  );
}

function addWorkflowEffectShadowEvidence(moduleRoot: string): void {
  const fixtureRoot = resolve(moduleRoot, '../..');
  for (const directory of [
    'scripts/workflow-effect-shadow-contracts',
    'packages/workflows/contracts/workflow-effect-shadow/v1',
  ]) {
    mkdirSync(join(fixtureRoot, directory), { recursive: true });
  }
  writeFileSync(
    join(fixtureRoot, 'scripts/workflow-effect-shadow-contracts/index.ts'),
    'export {};\n',
    'utf8',
  );
  writeFileSync(
    join(fixtureRoot, 'scripts/workflow-effect-shadow-contracts/tsconfig.json'),
    '{}\n',
    'utf8',
  );
  writeFileSync(
    join(fixtureRoot, 'packages/workflows/contracts/workflow-effect-shadow/v1/manifest.json'),
    '{}\n',
    'utf8',
  );
  writeFileSync(
    join(fixtureRoot, 'packages/workflows/contracts/workflow-effect-shadow/v1/golden-vectors.json'),
    '{}\n',
    'utf8',
  );
  for (const directory of [
    'cmd/effect-shadow-server',
    'internal/effectshadowapp',
    'internal/effectshadowstore/postgres',
  ]) {
    mkdirSync(join(moduleRoot, directory), { recursive: true });
  }
  writeFileSync(join(moduleRoot, 'cmd/effect-shadow-server/main.go'), 'package main\n', 'utf8');
  writeFileSync(
    join(moduleRoot, 'cmd/effect-shadow-server/qualification_test.go'),
    [
      'package main',
      '',
      'import "testing"',
      '',
      'func TestGS9DQualification(t *testing.T) {}',
      'func TestGS9DRestartQualification(t *testing.T) {}',
      'func TestGS9DImageDefaultOff(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/effectshadowapp/server_test.go'),
    'package effectshadowapp\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/effectshadowstore/contract_test.go'),
    [
      'package effectshadowstore',
      '',
      'import "testing"',
      '',
      'func TestWorkflowEffectShadowGoldenVectors(t *testing.T) {}',
      'func TestWorkflowEffectShadowRejectsFramingAndAuthorityDrift(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/effectshadowstore/postgres/repository_test.go'),
    [
      'package postgres',
      '',
      'import "testing"',
      '',
      'func TestGS9DEffectShadowLifecycleOutboxAndExactReplay(t *testing.T) {}',
      'func TestGS9DEffectShadowOutboxPaginationTraversesBeyondFirstHundred(t *testing.T) {}',
      'func TestGS9DEffectShadowMismatchDoesNotCreateOutbox(t *testing.T) {}',
      'func TestGS9DEffectShadowCommittedResponseLossKeepsOutboxAtomic(t *testing.T) {}',
      'func TestGS9DEffectShadowRejectsCorruptOutboxPayload(t *testing.T) {}',
      'func TestGS9DEffectShadowConflictsConcurrencyAndStoredIntegrity(t *testing.T) {}',
      'func TestGS9DEffectShadowCommitUnknownReconciliationAndDoubleUnknown(t *testing.T) {}',
      'func TestGS9DEffectShadowCommitUnknownRereadsReceiptAfterScopeLock(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'migrations/000005_create_workflow_control_effect_shadow.up.sql'),
    'SELECT 1;\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'migrations/000005_create_workflow_control_effect_shadow.down.sql'),
    'SELECT 1;\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'tests/contracts/effect_shadow_openapi_contract_test.go'),
    'package contracts\n\nimport "testing"\n\nfunc TestEffectShadowOpenAPIIsClosedAndValid(t *testing.T) {}\n',
    'utf8',
  );
  const migrationTestPath = join(moduleRoot, 'tests/integration/migration_test.go');
  writeFileSync(
    migrationTestPath,
    `${readFileSync(migrationTestPath, 'utf8')}\nfunc TestEffectShadowDownMigrationIsIsolatedAndRefusesEvidence(t *testing.T) {}\n`,
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'docs/api/effect-shadow-openapi.yaml'),
    'openapi: 3.1.0\n',
    'utf8',
  );
}

function addWorkflowBudgetAuthorityEvidence(moduleRoot: string): void {
  const fixtureRoot = resolve(moduleRoot, '../..');
  for (const directory of [
    'scripts/workflow-budget-authority-contracts',
    'packages/workflows/contracts/workflow-budget-authority/v1',
  ]) {
    mkdirSync(join(fixtureRoot, directory), { recursive: true });
  }
  writeFileSync(
    join(fixtureRoot, 'scripts/workflow-budget-authority-contracts/index.ts'),
    'export {};\n',
    'utf8',
  );
  writeFileSync(
    join(fixtureRoot, 'scripts/workflow-budget-authority-contracts/tsconfig.json'),
    '{}\n',
    'utf8',
  );
  writeFileSync(
    join(fixtureRoot, 'packages/workflows/contracts/workflow-budget-authority/v1/manifest.json'),
    '{}\n',
    'utf8',
  );
  writeFileSync(
    join(
      fixtureRoot,
      'packages/workflows/contracts/workflow-budget-authority/v1/golden-vectors.json',
    ),
    '{}\n',
    'utf8',
  );
  for (const directory of [
    'cmd/budget-authority-server',
    'internal/budgetapp',
    'internal/budgetstore/postgres',
    'internal/config',
    'internal/databaseready',
    'testdata',
  ]) {
    mkdirSync(join(moduleRoot, directory), { recursive: true });
  }
  writeFileSync(
    join(moduleRoot, 'testdata/gs9e-qualification.conf'),
    [...Object.entries(gs9eQualificationFixture).map(([key, value]) => `${key}=${value}`), ''].join(
      '\n',
    ),
    'utf8',
  );
  writeFileSync(join(moduleRoot, 'cmd/budget-authority-server/main.go'), 'package main\n', 'utf8');
  writeFileSync(
    join(moduleRoot, 'cmd/budget-authority-server/main_test.go'),
    'package main\n\nimport "testing"\n\nfunc TestBudgetAuthorityServerAcceptsSchemaVersionsSixThroughEight(t *testing.T) {}\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'cmd/budget-authority-server/qualification_test.go'),
    [
      'package main',
      '',
      'import "testing"',
      '',
      'func TestGS9EQualification(t *testing.T) {}',
      'func TestGS9ERestartQualification(t *testing.T) {}',
      'func TestGS9EImageDefaultOff(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/budgetapp/server_test.go'),
    [
      'package budgetapp',
      '',
      'import "testing"',
      '',
      'func TestBudgetServiceDefaultsToHealthOnlyWithoutMetrics(t *testing.T) {}',
      'func TestBudgetServiceRejectsIncompleteComposition(t *testing.T) {}',
      'func TestBudgetServicePinsBearerAndAllQualificationBindings(t *testing.T) {}',
      'func TestBudgetServiceEnforcesCanonicalContentAndExactHeaders(t *testing.T) {}',
      'func TestBudgetServiceReturnsClosedExactOriginalResponseOnReplay(t *testing.T) {}',
      'func TestBudgetServiceFreshRejectedReserveStillReturnsDurableCreatedResponse(t *testing.T) {}',
      'func TestBudgetServiceClassifiesAllClosedFreshMutationStatuses(t *testing.T) {}',
      'func TestBudgetServiceReadEndpointsReturnExactDurableRecords(t *testing.T) {}',
      'func TestBudgetServiceMapsStableStoreErrors(t *testing.T) {}',
      'func TestBudgetQualificationRouteDriftReturnsRepositoryConflict(t *testing.T) {}',
      'func TestBudgetQualificationExactReplaySurvivesActiveBuildDrift(t *testing.T) {}',
      'func TestBudgetQualificationReadinessIsLightweightAndMetricsAreTyped(t *testing.T) {}',
      'func TestBudgetQualificationReadinessFailureReturns503(t *testing.T) {}',
      'func TestBudgetAuthorityTimeoutBudgetsLeaveResponseSlack(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/budgetapp/qualification_ordering_test.go'),
    [
      'package budgetapp',
      '',
      'import "testing"',
      '',
      'func TestQualificationOnlyOrderingHarnessGatesProviderAndCachePublishOnDurability(t *testing.T) {}',
      'func TestQualificationOnlyOrderingHarnessCacheHitPerformsNoRepositoryMutation(t *testing.T) {}',
      'func TestQualificationOnlyOrderingHarnessFailsClosedBeforeCallbacks(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/budgetstore/postgres/repository_test.go'),
    [
      'package postgres',
      '',
      'import "testing"',
      '',
      'func TestBudgetStoreQualification(t *testing.T) {}',
      'func TestBudgetStoreRejectedReserveExactReplay(t *testing.T) {}',
      'func TestBudgetStoreConcurrentNoOverspend(t *testing.T) {}',
      'func TestBudgetStoreFingerprintAndSemanticConflicts(t *testing.T) {}',
      'func TestBudgetStoreSuccessfulAndFailedUsageSettlement(t *testing.T) {}',
      'func TestBudgetStoreCacheHitHasZeroMutation(t *testing.T) {}',
      'func TestBudgetStoreRejectsNonzeroResumeGeneration(t *testing.T) {}',
      'func TestBudgetStoreRouteEpochAndBuildDriftConflictWithoutMutation(t *testing.T) {}',
      'func TestBudgetStoreResponseLossRecovery(t *testing.T) {}',
      'func TestBudgetStoreDatabaseReconciliationResponseLossReplaysLatchedRun(t *testing.T) {}',
      'func TestBudgetStoreDatabaseReconciliationRejectsRunDriftWithoutLatch(t *testing.T) {}',
      'func TestBudgetStoreProviderAndDatabaseUnknownAreSeparate(t *testing.T) {}',
      'func TestBudgetStoreDoubleUnknownFailsClosed(t *testing.T) {}',
      'func TestBudgetStoreSettledReservationCannotSettleTwice(t *testing.T) {}',
      'func TestBudgetStoreRestartRebuild(t *testing.T) {}',
      'func TestBudgetStoreRebuildCoversClosedLedgerKinds(t *testing.T) {}',
      'func TestBudgetStoreRebuildFailsClosedOnAnchorAndLedgerDrift(t *testing.T) {}',
      'func TestBudgetStoreGenesisAnchorIsImmutable(t *testing.T) {}',
      'func TestBudgetStoreKnownReceiptRequiresSafeAcceptedRevisions(t *testing.T) {}',
      'func TestBudgetStoreReservationCloseTimeBindsTerminalLedger(t *testing.T) {}',
      'func TestBudgetStoreRebuildQueryCountIsIndependentOfLedgerLength(t *testing.T) {}',
      'func TestBudgetStoreMigrationIndexesMatchPointReadAndRebuildAccess(t *testing.T) {}',
      'func TestBudgetStoreReservationTerminalShapeIsClosed(t *testing.T) {}',
      'func TestBudgetStoreInt64RoundingAndOverflow(t *testing.T) {}',
      'func TestBudgetStoreAccountRunRevisionDriftIsAConflict(t *testing.T) {}',
      'func TestBudgetStoreImmutableAccountBindingDriftIsIntegrityFailure(t *testing.T) {}',
      'func TestBudgetStoreIntegrityFailure(t *testing.T) {}',
      'func TestBudgetStoreLegacyApprovalCannotReserve(t *testing.T) {}',
      'var concurrencyCases = []struct { name string }{{name: "tokens only"}, {name: "nano usd only"}, {name: "calls only"}, {name: "combined"}}',
      'func testProviderAttemptReceiptBinding(t *testing.T) { t.Run("ledger provider attempt receipt binding", func(t *testing.T) {}) }',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/budgetstore/postgres/cross_authority_test.go'),
    [
      'package postgres',
      '',
      'import "testing"',
      '',
      'func TestBudgetDatabaseReconciliationSerializesAndGatesAuthorityMutation(t *testing.T) {}',
      'func TestAuthorityBudgetGateUsesValidatedStartupSchemaVersion(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/budgetstore/postgres/replay_order_test.go'),
    [
      'package postgres',
      '',
      'import "testing"',
      '',
      'func TestBudgetStoreExactReplayPrecedesActiveBuildAndPolicyChecks(t *testing.T) {}',
      'func TestBudgetStoreFreshPolicyDriftConflictsWithoutMutation(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/budgetstore/durable_test.go'),
    'package budgetstore\n\nimport "testing"\n\nfunc TestDurableRecordExactAuthorityAndProjectionBinding(t *testing.T) {}\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/budgetstore/response_test.go'),
    'package budgetstore\n\nimport "testing"\n\nfunc TestMutationResponseExactEnvelopeAndCrossSpliceRejection(t *testing.T) {}\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/config/budget_authority_test.go'),
    [
      'package config',
      '',
      'import "testing"',
      '',
      'func TestBudgetAuthorityRejectsNonCanonicalQualificationSeed(t *testing.T) {}',
      'func TestBudgetAuthorityDisabledDoesNotRetainDatabaseOrIdentityBindings(t *testing.T) {}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'internal/databaseready/databaseready_test.go'),
    'package databaseready\n\nimport "testing"\n\nfunc TestSchemaProfilesAcceptMigrationEightWithoutRaisingExistingMinimums(t *testing.T) {}\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'migrations/000006_create_workflow_control_budget_authority.up.sql'),
    'SELECT 1;\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'migrations/000006_create_workflow_control_budget_authority.down.sql'),
    'SELECT 1;\n',
    'utf8',
  );
  const migrationTestPath = join(moduleRoot, 'tests/integration/migration_test.go');
  writeFileSync(
    migrationTestPath,
    `${readFileSync(migrationTestPath, 'utf8')}\nfunc TestBudgetAuthorityMigrationLocksSemanticIndexInventory(t *testing.T) {}\nfunc TestBudgetAuthorityDownMigrationIsIsolatedAndRefusesEvidence(t *testing.T) {}\n`,
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'tests/contracts/budget_authority_openapi_contract_test.go'),
    'package contracts\n\nimport "testing"\n\nfunc TestBudgetAuthorityOpenAPIContract(t *testing.T) {}\n',
    'utf8',
  );
  writeFileSync(
    join(moduleRoot, 'docs/api/budget-authority-openapi.yaml'),
    'openapi: 3.1.0\n',
    'utf8',
  );
}

function createFullServiceFixture(): Fixture {
  const fixture = createFixture();
  addFullServiceCapabilities(join(fixture.root, 'services/pure'));
  writeServiceConfig(fixture.root, 'pure', {
    capabilities: 'database,distribution,http-openapi,prometheus,worker',
    dockerTarget: 'app',
    runtimeProfile: 'notification-delivery-v1',
  });
  commitFixture(fixture.root);
  return fixture;
}

function writeFakeExecutables(bin: string): void {
  writeExecutable(
    join(bin, 'uname'),
    [
      '#!/usr/bin/env bash',
      'case "${1:-}" in',
      '  -s) printf "%s\\n" "${FAKE_UNAME_S:-Linux}" ;;',
      '  -r) printf "%s\\n" "${FAKE_UNAME_R:-6.8.0}" ;;',
      '  *) exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  writeExecutable(
    join(bin, 'cygpath'),
    [
      '#!/usr/bin/env bash',
      'value="${!#}"',
      'printf "C:\\\\converted\\\\%s\\n" "${value##*/}"',
      '',
    ].join('\n'),
  );
  writeExecutable(
    join(bin, 'wslpath'),
    [
      '#!/usr/bin/env bash',
      'value="${!#}"',
      'printf "D:\\\\converted\\\\%s\\n" "${value##*/}"',
      '',
    ].join('\n'),
  );
  writeExecutable(
    join(bin, 'docker'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '{',
      '  printf "MSYS=%s" "${MSYS_NO_PATHCONV:-}"',
      '  printf " %q" "$@"',
      '  printf "\\n"',
      '} >> "$FAKE_DOCKER_LOG"',
      'joined="$(printf "%s " "$@")"',
      'for ((index = 1; index <= $#; index++)); do',
      '  if [ "${!index}" = "--label" ]; then',
      '    next=$((index + 1))',
      '    label="${!next}"',
      '    case "$label" in',
      '      com.openslack.go-check.run=*) printf "%s\\n" "${label#*=}" > "$FAKE_OWNER_FILE" ;;',
      '    esac',
      '  fi',
      'done',
      'owner="$(cat "$FAKE_OWNER_FILE")"',
      '[ "${FAKE_OWNERSHIP_MISMATCH:-0}" = "0" ] || owner=forged-owner',
      'case "${1:-}" in',
      '  info)',
      '    [ "${FAKE_DOCKER_INFO:-ok}" = "ok" ] || exit 31',
      '    ;;',
      '  version)',
      '    printf "%s\\n" "${FAKE_DOCKER_CLIENT_OS:-linux}"',
      '    ;;',
      '  image)',
      '    if [ "${2:-}" = "inspect" ]; then',
      '      if [[ "$joined" == *"com.openslack.go-check.run"* ]]; then',
      '        printf "%s\\n" "$owner"',
      '      elif [[ "${!#}" == openslack-gocheck-* ]]; then',
      '        [ "${FAKE_EXISTING_IMAGE:-0}" = "0" ] || exit 0',
      '        exit 1',
      '      else',
      '        [ "${FAKE_IMAGE_INSPECT:-ok}" = "ok" ] || exit 32',
      '      fi',
      '    fi',
      '    ;;',
      '  volume)',
      '    if [ "${2:-}" = "inspect" ]; then',
      '      printf "%s\\n" "$owner"',
      '    elif [ "${2:-}" = "create" ]; then',
      '      printf "%s\\n" "fake-resource"',
      '    fi',
      '    ;;',
      '  network)',
      '    if [ "${2:-}" = "inspect" ]; then',
      '      printf "%s\\n" "$owner"',
      '    elif [ "${2:-}" = "create" ]; then',
      '      printf "%064d\\n" 0',
      '    fi',
      '    ;;',
      '  inspect)',
      '    if [[ "$joined" == *"com.openslack.go-check.run"* ]]; then',
      '      printf "%s\\n" "$owner"',
      '    elif [[ "$joined" == *".State.Status"* ]]; then',
      '      if [[ "$joined" == *"-app"* ]]; then',
      '        printf "%s\\n" "${FAKE_APP_STATE:-running}"',
      '      else',
      '        printf "%s\\n" "${FAKE_CONTAINER_STATE:-running}"',
      '      fi',
      '    else',
      '      if [[ "$joined" == *"-app"* ]]; then',
      '        printf "%s\\n" "${FAKE_APP_HEALTH:-healthy}"',
      '      else',
      '        printf "%s\\n" "${FAKE_HEALTH:-healthy}"',
      '      fi',
      '    fi',
      '    ;;',
      '  run)',
      '    if [[ "$joined" == *" go test "* && "$joined" == *" -list "* ]]; then',
      '      [ "${FAKE_GO_TEST_LIST_EMPTY:-0}" = "0" ] && printf "%s\\n" TestFake',
      '      exit "${FAKE_GO_TEST_LIST_STATUS:-0}"',
      '    fi',
      '    if [[ "$joined" == *"go work edit -json"* ]]; then',
      '      printf "%b" "${FAKE_WORKSPACE_MODULES:-./services/pure\\n}"',
      '      exit "${FAKE_PARSER_STATUS:-0}"',
      '    fi',
      '    if [[ "$joined" == *"go env GOVERSION"* && "$joined" != *"/work/module"* ]]; then',
      '      printf "%s\\n" "${FAKE_GO_VERSION:-go1.26.5}"',
      '      exit 0',
      '    fi',
      '    if [[ "$joined" == *"/input/container-gate.sh"* ]]; then',
      '      if [ "${FAKE_BLOCK_MODULE_RUN:-0}" = "1" ]; then',
      '        : > "${FAKE_BLOCK_MARKER:?}"',
      '        while :; do sleep 1; done',
      '      fi',
      '      exit "${FAKE_MODULE_RUN_STATUS:-0}"',
      '    fi',
      '    if [ -n "${FAKE_GS1C_FAIL_PHASE:-}" ] && [[ "$joined" == *"-qualification-${FAKE_GS1C_FAIL_PHASE}"* ]]; then',
      '      exit "${FAKE_GS1C_FAIL_STATUS:-43}"',
      '    fi',
      '    if [ -n "${FAKE_GS5_FAIL_PHASE:-}" ] && [[ "$joined" == *"-qualification-${FAKE_GS5_FAIL_PHASE}"* ]]; then',
      '      exit "${FAKE_GS5_FAIL_STATUS:-44}"',
      '    fi',
      '    if [ -n "${FAKE_GS6_FAIL_PHASE:-}" ] && [[ "$joined" == *"-qualification-${FAKE_GS6_FAIL_PHASE}"* ]]; then',
      '      exit "${FAKE_GS6_FAIL_STATUS:-45}"',
      '    fi',
      '    if [ -n "${FAKE_GS7B_FAIL_PHASE:-}" ] && [[ "$joined" == *"-qualification-${FAKE_GS7B_FAIL_PHASE}"* ]]; then',
      '      exit "${FAKE_GS7B_FAIL_STATUS:-46}"',
      '    fi',
      '    if [ -n "${FAKE_GS8B_FAIL_PHASE:-}" ] && [[ "$joined" == *"-qualification-${FAKE_GS8B_FAIL_PHASE}"* ]]; then',
      '      exit "${FAKE_GS8B_FAIL_STATUS:-47}"',
      '    fi',
      '    if [ -n "${FAKE_GS9B_FAIL_PHASE:-}" ] && [[ "$joined" == *"-qualification-${FAKE_GS9B_FAIL_PHASE}"* ]]; then',
      '      exit "${FAKE_GS9B_FAIL_STATUS:-48}"',
      '    fi',
      '    if [ -n "${FAKE_GS9C_FAIL_PHASE:-}" ] && [[ "$joined" == *"-qualification-${FAKE_GS9C_FAIL_PHASE}"* ]]; then',
      '      exit "${FAKE_GS9C_FAIL_STATUS:-49}"',
      '    fi',
      '    if [ -n "${FAKE_GS9D_FAIL_PHASE:-}" ] && [[ "$joined" == *"-qualification-${FAKE_GS9D_FAIL_PHASE}"* ]]; then',
      '      exit "${FAKE_GS9D_FAIL_STATUS:-50}"',
      '    fi',
      '    if [ -n "${FAKE_GS9E_FAIL_PHASE:-}" ] && [[ "$joined" == *"-qualification-${FAKE_GS9E_FAIL_PHASE}"* ]]; then',
      '      exit "${FAKE_GS9E_FAIL_STATUS:-51}"',
      '    fi',
      '    if [ -n "${FAKE_GS9F1_FAIL_PHASE:-}" ] && [[ "$joined" == *"-qualification-${FAKE_GS9F1_FAIL_PHASE}"* ]]; then',
      '      exit "${FAKE_GS9F1_FAIL_STATUS:-52}"',
      '    fi',
      '    if [ -n "${FAKE_GS9F2_FAIL_PHASE:-}" ] && [[ "$joined" == *"-qualification-${FAKE_GS9F2_FAIL_PHASE}"* ]]; then',
      '      exit "${FAKE_GS9F2_FAIL_STATUS:-53}"',
      '    fi',
      '    if [[ "$joined" == *"go test -json -race"* && "$joined" =~ OPENSLACK_GO_CHECK_EXPECT_TEST=([A-Za-z0-9_]+) ]]; then',
      '      selected_test="${BASH_REMATCH[1]}"',
      '      if [ "${FAKE_GS9F2_SKIP_TEST:-}" = "$selected_test" ]; then',
      '        printf "{\\\"Action\\\":\\\"skip\\\",\\\"Test\\\":\\\"%s\\\"}\\n" "$selected_test"',
      '      else',
      '        printf "{\\\"Action\\\":\\\"pass\\\",\\\"Test\\\":\\\"%s\\\"}\\n" "$selected_test"',
      '      fi',
      '      exit 0',
      '    fi',
      '    if [[ "$joined" == *" -d "* ]]; then',
      '      printf "%s\\n" "fake-container"',
      '    fi',
      '    ;;',
      '  build)',
      '    exit "${FAKE_BUILD_STATUS:-0}"',
      '    ;;',
      'esac',
      '',
    ].join('\n'),
  );
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function runGoCheck(fixture: Fixture, args: string[], env: Record<string, string> = {}) {
  return spawnSync('/bin/bash', [join(fixture.root, 'scripts/go-check.sh'), ...args], {
    cwd: fixture.root,
    env: goCheckEnvironment(fixture, env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function goCheckEnvironment(fixture: Fixture, env: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fixture.bin}:${process.env.PATH ?? ''}`,
    FAKE_DOCKER_LOG: fixture.dockerLog,
    FAKE_OWNER_FILE: fixture.ownerFile,
    FAKE_WORKSPACE_MODULES:
      env.FAKE_WORKSPACE_MODULES ??
      fixture.modules
        .map((module) => `./services/${module}`)
        .join('\n')
        .concat('\n'),
    ...env,
  };
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnSync('/usr/bin/test', ['-e', path]).status === 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

type ContainerGateFixture = {
  root: string;
  bin: string;
  source: string;
  work: string;
  commandLog: string;
};

function createContainerGateFixture(): ContainerGateFixture {
  const root = mkdtempSync(join(tmpdir(), 'openslack-container-gate-'));
  temporaryRoots.push(root);
  const bin = join(root, 'bin');
  const source = join(root, 'source');
  const work = join(root, 'work');
  const commandLog = join(root, 'commands.log');
  const moduleSource = join(source, 'services/pure');
  mkdirSync(bin, { recursive: true });
  mkdirSync(moduleSource, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(source, 'LICENSE'), 'repository context\n', 'utf8');
  writeFileSync(
    join(moduleSource, 'go.mod'),
    'module github.com/Negentropy-Laby/OpenSlack/services/pure\n\ngo 1.26.5\n',
    'utf8',
  );
  writeFileSync(join(moduleSource, 'go.sum'), '', 'utf8');
  writeFileSync(join(moduleSource, 'main.go'), 'package pure\n', 'utf8');
  writeFileSync(commandLog, '', 'utf8');

  for (const command of ['cp', 'mkdir', 'cmp']) {
    writeExecutable(join(bin, command), `#!/bin/sh\nexec /usr/bin/${command} "$@"\n`);
  }
  writeExecutable(
    join(bin, 'gofmt'),
    [
      '#!/bin/sh',
      'printf "gofmt" >> "${FAKE_COMMAND_LOG}"',
      'for arg in "$@"; do printf " %s" "${arg}" >> "${FAKE_COMMAND_LOG}"; done',
      'printf "\\n" >> "${FAKE_COMMAND_LOG}"',
      'printf "%s" "${FAKE_GOFMT_OUTPUT:-}"',
      '',
    ].join('\n'),
  );
  writeExecutable(
    join(bin, 'migrate'),
    [
      '#!/bin/sh',
      'printf "migrate" >> "${FAKE_COMMAND_LOG}"',
      'for arg in "$@"; do printf " %s" "${arg}" >> "${FAKE_COMMAND_LOG}"; done',
      'printf "\\n" >> "${FAKE_COMMAND_LOG}"',
      '[ "${FAKE_MIGRATE_FAIL:-0}" = "0" ] || exit 43',
      '',
    ].join('\n'),
  );
  writeExecutable(
    join(bin, 'go'),
    [
      '#!/bin/sh',
      'joined="$*"',
      'printf "go %s\\n" "${joined}" >> "${FAKE_COMMAND_LOG}"',
      'case "${joined}" in',
      '  "env GOWORK") printf "%s\\n" "${FAKE_GOWORK-off}"; exit 0 ;;',
      '  "env GOVERSION") printf "%s\\n" "${FAKE_GO_VERSION:-go1.26.5}"; exit 0 ;;',
      '  "env GOMODCACHE") printf "%s\\n" "/go/pkg/mod"; exit 0 ;;',
      '  "env GOCACHE") printf "%s\\n" "/root/.cache/go-build"; exit 0 ;;',
      '  "list -m -f {{.Path}}") printf "%s\\n" "${FAKE_MODULE_PATH:-github.com/Negentropy-Laby/OpenSlack/services/pure}"; exit 0 ;;',
      '  "list -m -f {{.GoVersion}}") printf "%s\\n" "${FAKE_MODULE_GO_VERSION:-1.26.5}"; exit 0 ;;',
      '  "list -m -f {{.Version}} github.com/golang-migrate/migrate/v4") printf "%s\\n" "v4.18.1"; exit 0 ;;',
      'esac',
      'case "${joined}" in',
      '  *"${FAKE_GO_FAIL:-__never__}"*) exit 42 ;;',
      'esac',
      'if [ "${joined}" = "mod tidy" ] && [ -n "${FAKE_TIDY_DRIFT:-}" ]; then',
      '  printf "%s\\n" "drift" >> "${FAKE_TIDY_DRIFT}"',
      'fi',
      '',
    ].join('\n'),
  );

  return { root, bin, source, work, commandLog };
}

function runContainerGate(fixture: ContainerGateFixture, env: Record<string, string> = {}) {
  const driftTarget =
    env.FAKE_TIDY_DRIFT === 'go.mod' || env.FAKE_TIDY_DRIFT === 'go.sum'
      ? join(fixture.work, 'repository/services/pure', env.FAKE_TIDY_DRIFT)
      : env.FAKE_TIDY_DRIFT;
  return spawnSync(
    '/bin/sh',
    [join(repositoryRoot, 'scripts/go-check/container-gate.sh'), fixture.source, fixture.work],
    {
      cwd: fixture.root,
      env: {
        PATH: fixture.bin,
        FAKE_COMMAND_LOG: fixture.commandLog,
        GO_CHECK_EXPECTED_MODULE: 'github.com/Negentropy-Laby/OpenSlack/services/pure',
        GO_CHECK_MODULE_RELATIVE_PATH: 'services/pure',
        ...env,
        ...(driftTarget ? { FAKE_TIDY_DRIFT: driftTarget } : {}),
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}
