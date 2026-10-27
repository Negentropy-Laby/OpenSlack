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
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type * as TypeScript from 'typescript';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
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
      'native-supervisor',
      'tests/fixtures/scripted-model.ts',
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(packageRoot, path), join(root, path), { recursive: true });
    }
    // Build the exact candidate's one pure leaf afresh, independently of ignored
    // repository dist or a copied node_modules tree.
    const ts: typeof TypeScript = createRequire(join(harnessRoot, 'package.json'))('typescript');
    const wireSource = join(root, '.build/wire-source/bridge-wire.ts');
    mkdirSync(dirname(wireSource), { recursive: true });
    cpSync(join(packageRoot, '../../packages/agent-runtime/src/bridge-wire.ts'), wireSource);
    const wireOutput = join(root, '.build/wire-output');
    const wireProgram = ts.createProgram([wireSource], { target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
      declaration: true, skipLibCheck: true, rootDir: dirname(wireSource), outDir: wireOutput,
      types: ['node'], typeRoots: [join(harnessRoot, 'node_modules/@types')] });
    expect(ts.getPreEmitDiagnostics(wireProgram).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    expect(wireProgram.emit().emitSkipped).toBe(false);
    const env = { ...testProcessEnvironment(), DEEPSEEK_HARNESS_CHECKOUT: harnessRoot,
      OPENSLACK_BRIDGE_WIRE_MODULE: join(wireOutput, 'bridge-wire.js') };
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
    expect(existsSync(join(root, 'dist/openslack-harness-supervisor.exe'))).toBe(true);
    for (const name of readdirSync(join(root, 'dist/types/src')).filter(name => name.endsWith('.d.ts'))) {
      expect(readFileSync(join(root, 'dist/types/src', name), 'utf8')).not.toContain('@openslack/agent-runtime');
    }
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
  it('binds the actual package and rejects both outside roots and unexported source inside a root', async () => {
    const deadlineAt = Date.now() + 330_000;
    const root = mkdtempSync(join(tmpdir(), 'openslack-two-roots-'));
    let passed = false;
    onTestFinished(() => {
      if (passed) rmSync(root, { recursive: true, force: true });
      else console.error(`Deployment validation failure retained at ${root}`);
    });
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
    const input = join(root, 'deployment-validation.json');
    writeFileSync(input, JSON.stringify({ root, deployment }), { flag: 'wx' });
    const timeoutMs = Math.min(300_000, deadlineAt - Date.now() - 10_000);
    if (timeoutMs < 1) throw new Error('Deployment fixture setup exhausted its verification deadline');
    // Seven complete, fresh production observations must not block Vitest's
    // worker RPC/event loop. This is only a verification-process budget.
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/deployment-validation.mjs', import.meta.url)), input],
      { cwd: root, env: testProcessEnvironment(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const output: Buffer[] = [], errors: Buffer[] = [];
      let bytes = 0, failure: Error | undefined, stopping = false, settled = false;
      let unconfirmed: ReturnType<typeof setTimeout> | undefined;
      const clear = () => { clearTimeout(timer); if (unconfirmed) clearTimeout(unconfirmed); };
      const stop = (reason: Error) => {
        failure ??= reason;
        if (stopping || settled) return;
        stopping = true;
        // This pure verification process owns no SDK/managed descendants.
        // Its hard computation cutoff cannot grow a graceful-running tail.
        child.kill('SIGKILL');
        unconfirmed = setTimeout(() => {
          if (settled) return;
          settled = true; clear();
          reject(new Error('Deployment validation process exit is unconfirmed; preserve the fixture', { cause: failure }));
        }, 10_000);
      };
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) stop(new Error('Deployment validation output exceeded its bound'));
        else target.push(chunk);
      };
      const timer = setTimeout(() => stop(new Error('Deployment validation exceeded its bounded verification deadline')), timeoutMs);
      child.stdout.on('data', collect(output)); child.stderr.on('data', collect(errors));
      child.stdout.on('error', stop); child.stderr.on('error', stop); child.once('error', stop);
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true; clear();
        if (failure) reject(failure);
        else resolve({ code, signal, stdout: Buffer.concat(output).toString('utf8'), stderr: Buffer.concat(errors).toString('utf8') });
      });
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout.trim().split('\n').map(line => JSON.parse(line))).toEqual([
      'valid', 'outside-root', 'unexported-source', 'private-subpath', 'bad-plugin-hash', 'bad-node-hash', 'peer-shadow',
    ].map(check => ({ check, passed: true })));
    passed = true;
  }, 330_000);
});
