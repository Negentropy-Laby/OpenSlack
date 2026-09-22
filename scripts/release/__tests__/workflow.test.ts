import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync(
  resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'openslack-release.yml'),
  'utf-8',
);
const build = readFileSync(resolve(import.meta.dirname, '..', 'build.ts'), 'utf-8');

describe('native release workflow integrity', () => {
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
    expect(steps[index]).toEqual({
      name: 'Qualify governed PR branch cleanup',
      run: [
        'bunx vitest run',
        'packages/delivery/src/__tests__/git-transport.test.ts',
        'packages/delivery/src/__tests__/branch-cleanup.test.ts',
        'packages/delivery/src/__tests__/cleanup-broker-channel.test.ts',
        'packages/delivery/src/__tests__/cleanup-broker-transport.test.ts',
        'packages/pr/src/__tests__/cleanup-branch.test.ts',
        'packages/pr/src/__tests__/cleanup-broker-client.test.ts',
        'packages/pr/src/__tests__/cleanup-broker-authorization.test.ts',
        'packages/pr/src/__tests__/cleanup-broker-digest.test.ts',
        'packages/pr/src/__tests__/task-link.test.ts',
        'packages/github/src/__tests__/branch-evidence.test.ts',
        'packages/github/src/__tests__/cleanup-broker-client-scope.test.ts',
        'apps/cli/src/__tests__/pr-cleanup-branch-command.test.ts',
        'packages/collaboration/src/__tests__/events.test.ts',
        'packages/runtime/src/__tests__/propose.test.ts',
      ].join(' '),
    });
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
