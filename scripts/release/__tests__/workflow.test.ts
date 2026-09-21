import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = readFileSync(
  resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'openslack-release.yml'),
  'utf-8',
);
const build = readFileSync(resolve(import.meta.dirname, '..', 'build.ts'), 'utf-8');

describe('native release workflow integrity', () => {
  it('runs PR release smoke and cleanup qualification for both native targets', () => {
    for (const path of [
      "'apps/**'",
      "'packages/**'",
      "'templates/**'",
      "'scripts/release/**'",
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
        'packages/pr/src/__tests__/cleanup-branch.test.ts',
        'packages/pr/src/__tests__/task-link.test.ts',
        'packages/github/src/__tests__/branch-evidence.test.ts',
        'apps/cli/src/__tests__/pr-cleanup-branch-command.test.ts',
        'packages/collaboration/src/__tests__/events.test.ts',
        'packages/runtime/src/__tests__/propose.test.ts',
      ].join(' '),
    });
    expect(steps[index + 1]).toEqual({
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
