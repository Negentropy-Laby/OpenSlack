import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PUBLIC_VERSION,
  canonicalDirectoryManifest,
  stageManifest,
  validatePublicManifest,
} from '../lib.js';

const roots: string[] = [];
const definition = { name: '@openslack/plugin-host', directory: 'packages/plugin-host' };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function validManifest(): Record<string, unknown> {
  return {
    name: definition.name,
    version: PUBLIC_VERSION,
    type: 'module',
    main: './dist/index.js',
    types: './dist/index.d.ts',
    files: ['dist', 'README.md', 'LICENSE', 'NOTICE'],
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    engines: { node: '>=22.0.0' },
    repository: {
      type: 'git',
      url: 'git+https://github.com/Negentropy-Laby/OpenSlack.git',
      directory: definition.directory,
    },
    license: 'Apache-2.0',
    publishConfig: { access: 'public' },
    scripts: { test: 'vitest run' },
    dependencies: { '@openslack/plugin-api': 'workspace:*' },
  };
}

describe('public package contract', () => {
  it('rewrites workspace dependencies to the exact public version', () => {
    const staged = stageManifest(validManifest());
    expect(staged.dependencies).toEqual({ '@openslack/plugin-api': '0.2.0' });
    expect(staged.private).toBeUndefined();
  });

  it.each([
    ['private package', { private: true }, /remains private/],
    ['lifecycle script', { scripts: { install: 'node install.js' } }, /lifecycle script/],
    ['React dependency', { dependencies: { react: '^19.0.0' } }, /forbidden/],
    ['native dependency', { dependencies: { '@napi-rs/keyring': '1.3.0' } }, /forbidden/],
    ['unpublished runtime dependency', { dependencies: { '@openslack/kernel': 'workspace:*' } }, /unexpected/],
  ])('rejects a malicious %s manifest', (_name, patch, expected) => {
    expect(() => validatePublicManifest({ ...validManifest(), ...patch }, definition)).toThrow(
      expected,
    );
  });

  it('creates a sorted canonical manifest with content hashes', () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-public-pack-'));
    roots.push(root);
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'z.js'), 'z\n');
    writeFileSync(join(root, 'a.txt'), 'a\n');
    expect(canonicalDirectoryManifest(root).map((entry) => entry.path)).toEqual([
      'a.txt',
      'dist/z.js',
    ]);
    expect(canonicalDirectoryManifest(root)[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('rejects symlinks from the canonical package tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-public-pack-'));
    roots.push(root);
    writeFileSync(join(root, 'target.txt'), 'target\n');
    try {
      symlinkSync(join(root, 'target.txt'), join(root, 'link.txt'), 'file');
    } catch {
      return;
    }
    expect(() => canonicalDirectoryManifest(root)).toThrow(/Symlink is forbidden/);
  });
});
