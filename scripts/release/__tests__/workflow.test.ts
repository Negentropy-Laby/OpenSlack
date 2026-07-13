import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'openslack-release.yml'),
  'utf-8',
);

describe('native release workflow integrity', () => {
  it('runs PR release smoke for every broad compiled or packaged input family', () => {
    for (const path of [
      "'apps/**'",
      "'packages/**'",
      "'templates/**'",
      "'scripts/release/**'",
      "'.openslack/modules.yaml'",
      "'docs/guides/install-openslack.md'",
      "'docs/guides/manual-upgrade-rollback.md'",
      "'package.json'",
      "'bun.lock'",
      "'tsconfig.json'",
    ]) {
      expect(workflow).toContain(`- ${path}`);
    }
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
  });
});
