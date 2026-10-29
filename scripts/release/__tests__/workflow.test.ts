import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parse } from 'yaml';
import {
  testProcessEnvironment,
  testTemporaryDirectory,
  testBash,
} from '../../testing/process-fixture.mjs';
import { HARNESS_COMPATIBILITY_SHA } from '../../../integrations/deepseek-harness/compatibility-witness.mjs';

const workflow = readFileSync(
  resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'openslack-release.yml'),
  'utf-8',
);
const build = readFileSync(resolve(import.meta.dirname, '..', 'build.ts'), 'utf-8');

describe('native release workflow integrity', () => {
  it('prepares pinned Go before plugin build and verifies its private module without service scaffolding', () => {
    const root = resolve(import.meta.dirname, '../../..');
    for (const [name, job] of [['openslack-release.yml', 'build'], ['openslack-reusable-validate.yml', 'validate']] as const) {
      const steps = parse(readFileSync(join(root, '.github/workflows', name), 'utf8')).jobs[job].steps;
      const plugin = steps.findIndex((step: { name?: string }) => step.name === 'Build the OpenSlack-owned external plugin');
      const go = steps.findIndex((step: { uses?: string; with?: Record<string, unknown> }) => step.uses?.startsWith('actions/setup-go@') && step.with?.['go-version'] === '1.26.5');
      expect(go, name).toBeGreaterThanOrEqual(0);
      expect(go, name).toBeLessThan(plugin);
      const verification = steps.find((step: { name?: string }) => step.name === 'Verify the private supervisor module');
      expect(verification.workingDirectory ?? verification['working-directory']).toBe('integrations/deepseek-harness/native-supervisor');
      expect(verification.env).toEqual({ GOWORK: 'off', GOTOOLCHAIN: 'local' });
      expect(verification.run).toContain('go test ./...');
      expect(verification.run).toContain('go vet ./...');
      expect(verification.run).not.toContain('services/');
    }
  });
  it('keeps both required Harness compatibility preparations and dependency pins identical', () => {
    const reusable = parse(readFileSync(resolve(import.meta.dirname, '../../../.github/workflows/openslack-reusable-validate.yml'), 'utf8'));
    const release = parse(workflow);
    const jobs = [reusable.jobs.validate, release.jobs.build];
    const preparation = jobs.map(job => job.steps.find((step: { name?: string }) =>
      step.name === 'Prepare original Harness artifacts and public declarations'));
    expect(preparation[0]).toBeDefined();
    expect(preparation[1]).toEqual(preparation[0]);
    const helperPath = resolve(import.meta.dirname, '../../ci/prepare-harness-deps.sh');
    const helper = readFileSync(helperPath, 'utf8');
    const bash = testBash();
    const syntax = bash.spawn(['-n', bash.path(helperPath)]);
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(preparation[0].run).toBe('bash scripts/ci/prepare-harness-deps.sh');
    expect(preparation[0]['working-directory']).toBeUndefined();
    expect(helper).toContain('HARNESS_COMPATIBILITY_SHA');
    expect(helper).toContain('capture_harness_inputs');
    expect(helper).toContain("git('ls-files', '--stage')");
    expect(helper).toContain("git('for-each-ref'");
    expect(helper).toContain('--side-effects-cache=false');
    expect(helper).toContain('--verify-store-integrity=true');
    expect(helper).toContain('--store-dir "$openslack_ci_store"');
    expect(helper).not.toMatch(/(?:git\s+(?:reset|clean)|--no-frozen|--ignore-integrity)/);
    for (const job of jobs) {
      expect(job.env.OPENSLACK_HARNESS_COMPATIBILITY).toBe('required');
      const steps = job.steps;
      const checkout = steps.find((step: { with?: Record<string, string> }) =>
        step.with?.repository === 'deepseek-ai/deepseek-harness');
      expect(checkout.with).toMatchObject({ ref: HARNESS_COMPATIBILITY_SHA, 'persist-credentials': false });
      expect(checkout.id).toBe('harness-source');
      expect(steps.find((step: { uses?: string }) => step.uses?.startsWith('actions/setup-node@')).with['node-version']).toBe('24.18.1');
      expect(helper).toContain('pnpm@11.28.5');
      const prepareIndex = steps.indexOf(preparation[jobs.indexOf(job)]);
      const pluginIndex = steps.findIndex((step: { name?: string }) => step.name === 'Build the OpenSlack-owned external plugin');
      expect(prepareIndex).toBeGreaterThan(steps.indexOf(checkout));
      expect(pluginIndex).toBeGreaterThan(prepareIndex);
      expect(steps.slice(0, prepareIndex).some((step: { run?: string }) => /vitest\s+run/.test(step.run ?? ''))).toBe(false);
      expect(helper).toContain('pnpm install --frozen-lockfile');
      expect(helper).toContain('pnpm run build:artifacts');
      expect(helper).toContain('pnpm run build:check');
      const cache = steps.find((step: { name?: string }) => step.name === 'Cache original Harness downloads');
      expect(cache.uses).toBe('actions/cache@cdf6c1fa76f9f475f3d7449005a359c84ca0f306');
      expect(cache.with.path).toBe('.openslack.local/ci/pnpm-store');
      expect(cache.with['restore-keys']).toBeUndefined();
      expect(cache.with.key).toContain('${{ runner.os }}');
      expect(cache.with.key).toContain('${{ steps.harness-source.outputs.commit }}');
      expect(cache.with.key).toContain("${{ hashFiles('.openslack.local/ci/harness-original/pnpm-lock.yaml') }}");
      expect(cache.with.key).toContain('node24.18.1-pnpm11.28.5');
      expect(cache.with.key.endsWith('-end')).toBe(true);
      expect(steps.indexOf(cache)).toBeGreaterThan(steps.indexOf(checkout));
      expect(steps.indexOf(cache)).toBeLessThan(prepareIndex);
      expect(preparation[0].if).toBeUndefined();
    }
  });

  it('canonicalizes the existing Windows temporary directory before native validation', () => {
    const steps = parse(workflow).jobs.build.steps;
    const index = steps.findIndex(
      (step: { name?: string }) => step.name === 'Canonicalize Windows validation temporary paths',
    );
    expect(index).toBeGreaterThan(
      steps.findIndex((step: { uses?: string }) => step.uses?.startsWith('actions/setup-node@')),
    );
    expect(index).toBeLessThan(
      steps.findIndex(
        (step: { name?: string }) =>
          step.name === 'Prepare original Harness artifacts and public declarations',
      ),
    );
    const step = steps[index];
    expect(step.if).toBe("${{ matrix.target == 'windows-x64' }}");
    expect(step.shell).toBe('bash');
    const program = /^node --input-type=module <<'NODE'\n([\s\S]+)\nNODE\n?$/.exec(step.run)?.[1];
    expect(program).toBeTypeOf('string');
    const root = testTemporaryDirectory('openslack-ci-temp-');
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const target = join(root, 'physical temporary directory with spaces');
    const alias = join(root, 'temporary alias');
    mkdirSync(target);
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const output = join(root, 'github-env');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program!], {
      env: { ...testProcessEnvironment(), TEMP: alias, TMP: alias, TMPDIR: alias, GITHUB_ENV: output },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const canonical = realpathSync.native(target);
    expect(readFileSync(output, 'utf8')).toBe(`TEMP=${canonical}\nTMP=${canonical}\n`);
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readdirSync(target)).toEqual([]);
  });

  it('pins every Bun setup and its local types to the reviewed toolchain', () => {
    const root = resolve(import.meta.dirname, '../../..');
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    expect(manifest.devDependencies['bun-types']).toBe('1.4.0');
    const directory = resolve(root, '.github/workflows');
    let setups = 0;
    for (const name of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
      const config = parse(readFileSync(resolve(directory, name), 'utf8'));
      for (const job of Object.values(config.jobs ?? {}) as Array<{
        steps?: Array<{ uses?: string; with?: Record<string, unknown> }>;
      }>) {
        for (const step of job.steps ?? []) {
          if (!step.uses?.startsWith('oven-sh/setup-bun@')) continue;
          setups++;
          expect(step.with?.['bun-version'], name).toBe('1.4.0');
          expect(step.with?.['bun-version-file'], name).toBeUndefined();
        }
      }
    }
    expect(setups).toBeGreaterThan(0);
  });

  it('runs PR release smoke and cleanup qualification for both native targets', () => {
    for (const path of [
      "'apps/**'",
      "'packages/**'",
      "'services/cleanup-broker/**'",
      "'templates/**'",
      "'scripts/release/**'",
      "'scripts/cleanup-broker/**'",
      "'.openslack/modules.yaml'",
      "'docs/user/guides/install-openslack.md'",
      "'docs/user/guides/manual-upgrade-rollback.md'",
      "'package.json'",
      "'bun.lock'",
      "'tsconfig.json'",
    ]) {
      expect(workflow).toContain(`- ${path}`);
    }
    const config = parse(workflow);
    expect(config.permissions).toEqual({ contents: 'read' });
    expect(config.jobs.build.strategy.matrix.include).toEqual([
      { target: 'windows-x64', runner: 'windows-2022' },
      { target: 'linux-x64', runner: 'ubuntu-24.04' },
    ]);
    const steps = config.jobs.build.steps;
    const index = steps.findIndex(
      (step: { name?: string }) => step.name === 'Qualify governed PR branch cleanup',
    );
    const typecheckIndex = steps.findIndex(
      (step: { name?: string }) => step.name === 'Typecheck release and runtime sources',
    );
    expect(typecheckIndex).toBeGreaterThanOrEqual(0);
    expect(index).toBeGreaterThan(typecheckIndex);
    expect(index).toBeLessThan(
      steps.findIndex(
        (step: { name?: string }) =>
          step.name === 'Build unsigned PR or development archive and run unpacked smoke',
      ),
    );
    const qualification = steps[index];
    expect(qualification.name).toBe('Qualify governed PR branch cleanup');
    const scopes = [...qualification.run.matchAll(/--project\s+(@openslack\/[^\s]+)/g)].map(
      (match) => match[1],
    );
    expect(new Set(scopes)).toEqual(
      new Set([
        '@openslack/core',
        '@openslack/github',
        '@openslack/delivery',
        '@openslack/pr',
        '@openslack/runtime',
        '@openslack/collaboration',
        '@openslack/cli',
      ]),
    );
    expect(qualification.run.startsWith('bunx vitest run')).toBe(true);
    expect(qualification.run).not.toContain('__tests__/');
    expect(qualification.if).toBeUndefined();
    expect(steps[index + 1]).toEqual({
      name: 'Set up Go for cleanup broker components',
      if: "${{ matrix.target == 'linux-x64' }}",
      uses: 'actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16',
      with: { 'go-version': '1.26.5', cache: false },
    });
    expect(steps[index + 2]).toEqual({
      name: 'Validate cleanup broker components',
      if: "${{ matrix.target == 'linux-x64' }}",
      'working-directory': 'services/cleanup-broker',
      env: { GOWORK: 'off' },
      run: 'go test -race ./... -count=1',
    });
    expect(steps[index + 3]).toEqual({
      name: 'Build pinned cleanup executor candidate',
      if: "${{ matrix.target == 'linux-x64' }}",
      run: 'bun scripts/cleanup-broker/build-executor.ts --outdir /tmp/openslack-cleanup-executor-candidate',
    });
    expect(steps[index + 4]).toEqual({
      name: 'Verify Go to pinned executor protocol',
      if: "${{ matrix.target == 'linux-x64' }}",
      'working-directory': 'services/cleanup-broker',
      env: {
        GOWORK: 'off',
        CLEANUP_EXECUTOR_BUNDLE: '/tmp/openslack-cleanup-executor-candidate/executor.mjs',
      },
      run: 'go test -race -tags=integration ./internal/runner -count=1',
    });
    expect(steps[index + 5]).toEqual({
      name: 'Verify cleanup executor input contract',
      run: 'bunx vitest run packages/pr/src/__tests__/cleanup-broker-executor.test.ts -t "fixed executor boundary"',
    });
    expect(steps[index + 6]).toEqual({
      name: 'Qualify cleanup executor fixture composition',
      if: "${{ matrix.target == 'linux-x64' }}",
      run: 'bunx vitest run packages/pr/src/__tests__/cleanup-broker-executor.test.ts -t "private FD fixture composition"',
    });
    expect(steps[index + 7]).toEqual({
      name: 'Qualify notification blob storage races',
      run: [
        'bunx vitest run',
        'packages/github/src/__tests__/notification-blob-store.test.ts',
        'packages/github/src/__tests__/notification-blob-store-race.test.ts',
      ].join(' '),
    });
  });

  it('packages release guides from their canonical user-documentation paths', () => {
    expect(build).toContain("join(root, 'docs', 'user', 'guides', file)");
    expect(build).not.toContain("join(root, 'docs', 'guides', file)");
  });

  it('requires trusted signatures for tags and never clobbers release assets', () => {
    expect(workflow).toContain('--require-signature');
    expect(workflow).toContain('OPENSLACK_RELEASE_SIGNING_PRIVATE_KEY');
    expect(workflow).toContain('OPENSLACK_RELEASE_TRUSTED_PUBLIC_KEY');
    expect(workflow).toContain('immutable-assets.ts');
    expect(workflow).toContain('GITHUB_REF_NAME');
    expect(workflow).toContain('package version v${package_version}');
    expect(workflow).toContain('oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6');
    expect(workflow).not.toContain('setup-bun@v2');
    expect(workflow).not.toContain('--clobber');
    expect(workflow).toContain("if: ${{ matrix.target == 'windows-x64' }}");
    expect(workflow).toContain(
      'bunx vitest run packages/workflows/src/__tests__/workflow-control-shadow-journal.test.ts',
    );
  });
});
