import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  hashHarnessDeployment,
  hashHarnessNodeExecutable,
  hashHarnessPluginArtifacts,
} from '@openslack/agent-runtime/internal/harness';
import { prepareSdkFixture } from './fixtures/sdk-profile.ts';
import {
  testExecutable,
  testProcessEnvironment,
} from '../../../scripts/testing/process-fixture.mjs';

describe('external plugin build inputs', () => {
  it('builds in a path with spaces and resolves exactly its source inputs after relocation', () => {
    const harnessRoot = process.env.DEEPSEEK_HARNESS_CHECKOUT;
    if (!harnessRoot) throw new Error('An unmodified built Harness dependency is required');
    const packageRoot = fileURLToPath(new URL('../', import.meta.url));
    const root = realpathSync.native(
      mkdtempSync(join(realpathSync.native(tmpdir()), 'openslack plugin build ')),
    );
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    for (const path of [
      'build.mjs',
      'runtime-public.mjs',
      'package.json',
      'src',
      'tests/fixtures/scripted-model.ts',
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(packageRoot, path), join(root, path), { recursive: true });
    }
    const env = { ...testProcessEnvironment(), DEEPSEEK_HARNESS_CHECKOUT: harnessRoot };
    const built = spawnSync(testExecutable('bun', env), [join(root, 'build.mjs')], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    });
    expect(built.error).toBeUndefined();
    expect(built.status, built.stdout + built.stderr).toBe(0);
    expect(
      readdirSync(join(root, 'dist'))
        .filter((path) => path.endsWith('.js'))
        .sort(),
    ).toEqual(
      ['index', 'initiator', 'readonly', 'sdk-host', 'startup', 'runtime', 'owned-sdk']
        .map((name) => `${name}.js`)
        .sort(),
    );
    expect(existsSync(join(root, 'dist/types/src/index.d.ts'))).toBe(true);
    const ts: typeof import('typescript') = createRequire(join(harnessRoot, 'package.json'))(
      'typescript',
    );
    const normalize = (path: string) => resolve(path).replaceAll('\\', '/');
    const inputs = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true })
        .flatMap((entry) =>
          entry.isDirectory()
            ? inputs(join(directory, entry.name))
            : entry.name.endsWith('.ts')
              ? [normalize(join(directory, entry.name))]
              : [],
        )
        .sort();
    const check = (directory: string) => {
      const config = join(directory, '.build/tsconfig.json');
      const read = ts.readConfigFile(config, ts.sys.readFile);
      expect(read.error).toBeUndefined();
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(config));
      expect(parsed.errors).toEqual([]);
      expect(parsed.fileNames.map(normalize).sort()).toEqual(inputs(join(directory, 'src')));
      expect(parsed.fileNames.length).toBeGreaterThan(0);
    };
    check(root);
    // Relocate only the project inputs: an absolute include would still select
    // the old files, even on Linux, rather than this independent source tree.
    const relocated = join(root, 'relocated inputs with spaces');
    mkdirSync(join(relocated, '.build'), { recursive: true });
    cpSync(join(root, 'src'), join(relocated, 'src'), { recursive: true });
    cpSync(join(root, '.build/tsconfig.json'), join(relocated, '.build/tsconfig.json'));
    check(relocated);
  }, 180_000);
});

describe('deployment mounts remain an exact two-code-root set', () => {
  it('binds the actual package and rejects both outside roots and unexported source inside a root', () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-two-roots-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const fixture = prepareSdkFixture(root, []);
    const deployment = {
      harnessRoot: fixture.repository,
      pluginRoot: fixture.pluginRoot,
      pluginBuildHash: hashHarnessPluginArtifacts(fixture.pluginRoot),
      nodeVersion: '24.18.1' as const,
      nodeExecutable: process.execPath,
      nodeSha256: hashHarnessNodeExecutable(process.execPath),
      dshHome: fixture.home,
      workerPatch: fixture.patch,
      agentId: 'fixture-only',
      provider: 'fixture',
      model: 'fixture',
      exitGraceMs: 1_000,
    };
    expect(hashHarnessDeployment(deployment)).toMatch(/^[a-f0-9]{64}$/);
    const outside = join(root, 'outside.js');
    writeFileSync(outside, 'throw new Error("must not execute");');
    const patch = readFileSync(fixture.patch);
    for (const name of [outside, join(fixture.pluginRoot, 'src/index.ts')]) {
      writeFileSync(
        fixture.patch,
        JSON.stringify([{ insert: [{ id: 'not-approved', name: pathToFileURL(name).href }] }]),
      );
      expect(() => hashHarnessDeployment(deployment)).toThrow('separately bound');
    }
    writeFileSync(fixture.patch, patch);
    writeFileSync(
      fixture.patch,
      JSON.stringify([
        { insert: [{ id: 'not-bound', name: '@deepseek-ai/dsh-sdk-jsonrpc-server/src/index.ts' }] },
      ]),
    );
    expect(() => hashHarnessDeployment(deployment)).toThrow('package or subpath');
    writeFileSync(fixture.patch, patch);
    expect(() => hashHarnessDeployment({ ...deployment, pluginBuildHash: '0'.repeat(64) })).toThrow(
      'approved deployment',
    );
    expect(() => hashHarnessDeployment({ ...deployment, nodeSha256: '0'.repeat(64) })).toThrow(
      'approved deployment',
    );
    const shadow = join(fixture.home, 'profiles/sdk/node_modules/@deepseek-ai/schemastery');
    mkdirSync(shadow, { recursive: true });
    writeFileSync(
      join(shadow, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/schemastery', version: '4.0.0', main: 'index.js' }),
    );
    writeFileSync(
      join(shadow, 'index.js'),
      'throw new Error("must never load an unapproved same-name peer")',
    );
    expect(() => hashHarnessDeployment(deployment)).toThrow('runtime peer override');
  });
});
