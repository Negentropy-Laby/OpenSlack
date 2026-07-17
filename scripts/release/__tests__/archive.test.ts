import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createReleaseArchive, extractReleaseArchive } from '../archive.js';

describe('release archive creation', () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  (process.platform === 'linux' ? it : it.skip)(
    'creates and consumes a real gzip-compressed tar on Linux',
    () => {
      root = mkdtempSync(join(tmpdir(), 'openslack-release-archive-'));
      const bundle = join(root, 'openslack-v0.1.1-linux-x64');
      const archive = join(root, 'openslack-v0.1.1-linux-x64.tar.gz');
      const extracted = join(root, 'extracted');
      mkdirSync(bundle);
      writeFileSync(join(bundle, 'build-info.json'), '{"version":"0.1.1"}\n', 'utf-8');

      createReleaseArchive(bundle, archive, 'linux-x64');
      expect([...readFileSync(archive).subarray(0, 3)]).toEqual([0x1f, 0x8b, 0x08]);
      extractReleaseArchive(archive, extracted, 'linux-x64');
      expect(
        readFileSync(join(extracted, 'openslack-v0.1.1-linux-x64', 'build-info.json'), 'utf-8'),
      ).toBe('{"version":"0.1.1"}\n');
    },
  );

  (process.platform === 'win32' ? it : it.skip)(
    'creates and consumes a real ZIP on Windows',
    () => {
      root = mkdtempSync(join(tmpdir(), 'openslack-release-archive-'));
      const bundle = join(root, 'openslack-v0.1.1-windows-x64');
      const archive = join(root, 'openslack-v0.1.1-windows-x64.zip');
      const extracted = join(root, 'extracted');
      mkdirSync(bundle);
      writeFileSync(join(bundle, 'build-info.json'), '{"version":"0.1.1"}\n', 'utf-8');

      createReleaseArchive(bundle, archive, 'windows-x64');
      expect([...readFileSync(archive).subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      extractReleaseArchive(archive, extracted, 'windows-x64');
      expect(
        readFileSync(join(extracted, 'openslack-v0.1.1-windows-x64', 'build-info.json'), 'utf-8'),
      ).toBe('{"version":"0.1.1"}\n');
    },
  );

  it('pins Windows creation and extraction to native ZIP cmdlets', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', 'archive.ts'), 'utf-8');
    expect(source).toContain('Compress-Archive -LiteralPath');
    expect(source).toContain('Expand-Archive -LiteralPath');
    expect(source).not.toContain("run('tar', ['-a'");
  });

  it('pins portable smoke inputs and uses a disposable bundle copy before archiving', () => {
    const source = readFileSync(resolve(import.meta.dirname, '..', 'build.ts'), 'utf-8');
    expect(source).toContain("mkdtempSync(join(tmpdir(), 'openslack-bundle-smoke-'))");
    expect(source).toContain('cpSync(bundleDir, smokeBundleDir');
    expect(source).toContain('smokeBundle(smokeBundleDir, target)');
    expect(source).not.toContain('smokeBundle(bundleDir, target)');

    const smokeSource = readFileSync(resolve(import.meta.dirname, '..', 'smoke.ts'), 'utf-8');
    expect(smokeSource).toContain("'Lifecycle: ACTIVE | Maturity: LOCAL_READY'");
    expect(smokeSource).not.toContain("'Deferred (excluded)'");

    const attributes = readFileSync(resolve(import.meta.dirname, '..', '..', '..', '.gitattributes'));
    expect(attributes.toString('utf-8')).toContain(
      'packages/integration-negentropy/src/schema/negentropy.slot-contribution.v1.schema.json text eol=lf',
    );
  });
});
