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
const containerGateSource = readFileSync(
  join(repositoryRoot, 'scripts/go-check/container-gate.sh'),
  'utf8',
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
        'capabilities=database,distribution,http-openapi,prometheus',
        'docker_target=app',
        'runtime_profile=workflow-control-shadow-v1',
        '',
      ].join('\n'),
    );
    expect(goCheckSource).toContain(
      'golang:1.26.5@sha256:3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647',
    );
    expect(goCheckSource).toContain('test "$(go env GOWORK)" = "off"');
    expect(containerGateSource).toContain('go test -race ./... -count=5');
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
      'package app\n',
      'utf8',
    );
    writeFileSync(
      join(fixture.root, 'services/pure/internal/shadowstore/postgres/repository_test.go'),
      'package postgres\n',
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
    expect(log).toContain('MIGRATION_SOURCE=/migrations');
    expect(log).not.toContain('GOVERNANCE_AUTHORITY_MODE=');
    expect(log).not.toContain('CREDENTIAL_REF_SCHEME_ALLOWLIST=');
    expect(log).not.toContain('CREDENTIAL_PROFILE_VALIDATOR=');
  }, 15_000);

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
