/** Test-preparation witness only, never deployment/identity/execution authority. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { publicHarnessPackages, publicMcpRuntimePackages } from './runtime-public.mjs';

export const HARNESS_COMPATIBILITY_SHA = '22ddee3792402c3e70ec5f86a63c3e3e895a2f60';
export const PREPARE_COMPATIBILITY_COMMAND = 'DEEPSEEK_HARNESS_CHECKOUT=<built-original-checkout> bun integrations/deepseek-harness/prepare-compatibility.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error(`OpenSlack compatibility artifacts are missing or stale. Prepare explicitly: ${PREPARE_COMPATIBILITY_COMMAND}`); };

function files(base, path, output, skip = new Set()) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail();
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) if (!skip.has(name)) files(base, join(path, name), output, skip);
  } else if (stat.isFile()) output.push([relative(base, path).replaceAll('\\', '/'), stat.mode & 0o777, sha(readFileSync(path))]);
  else fail();
}
function command(command, args) {
  const value = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true,
    ...(command === 'go' ? { env: { ...process.env, GOTOOLCHAIN: 'local', GOWORK: 'off' } } : {}) });
  if (value.status !== 0 || value.error) fail();
  return value.stdout.trim();
}
function tools(root, harnessRoot) {
  const values = [];
  for (const name of ['node', 'bun']) {
    const path = command(name, ['-e', 'process.stdout.write(process.execPath)']);
    values.push([name, command(path, ['--version']), sha(readFileSync(path))]);
  }
  values.push(['go', command('go', ['version'])]);
  for (const [label, base] of [['openslack-typescript', root], ['harness-typescript', harnessRoot]]) {
    const path = join(base, 'node_modules/typescript');
    for (const name of ['package.json', 'bin/tsc', 'lib/_tsc.js', 'lib/typescript.js']) {
      if (existsSync(join(path, name))) values.push([label, name, sha(readFileSync(join(path, name)))]);
    }
  }
  return values;
}

/** Content hashes, not mtimes. Input collection excludes dependencies, credentials and identities. */
export function captureCompatibilityInputs(root, harnessRoot) {
  root = resolve(root); harnessRoot = resolve(harnessRoot);
  const source = [], dependency = [];
  for (const name of readdirSync(root).filter(name => /^tsconfig.*\.json$/.test(name) || ['package.json', 'bun.lock'].includes(name))) files(root, join(root, name), source);
  for (const group of ['packages', 'apps']) for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkg = join(root, group, entry.name);
    for (const name of readdirSync(pkg).filter(name => /^tsconfig.*\.json$/.test(name) || name === 'package.json')) files(root, join(pkg, name), source);
    files(root, join(pkg, 'src'), source, new Set(['__tests__', 'fixtures']));
    files(root, join(pkg, 'contracts'), source);
  }
  files(root, join(root, 'scripts/release/stage-schema-assets.ts'), source);
  const plugin = join(root, 'integrations/deepseek-harness');
  for (const name of readdirSync(plugin).filter(name => /\.(?:mjs|json)$/.test(name))) files(root, join(plugin, name), source);
  files(root, join(plugin, 'vitest.config.ts'), source);
  files(root, join(plugin, 'src'), source);
  files(root, join(plugin, 'native-supervisor'), source);
  for (const name of ['scripted-model', 'shutdown-probe']) files(root, join(plugin, `tests/fixtures/${name}.ts`), source);
  for (const name of ['package.json', 'pnpm-lock.yaml']) files(harnessRoot, join(harnessRoot, name), dependency);
  for (const pkg of publicHarnessPackages(harnessRoot).values()) {
    files(harnessRoot, pkg.manifestPath, dependency);
    for (const name of ['lib', 'dist', 'native']) files(harnessRoot, join(pkg.directory, name), dependency);
  }
  for (const pkg of publicMcpRuntimePackages(harnessRoot)) {
    files(harnessRoot, pkg.manifestPath, dependency);
    for (const name of ['lib', 'dist']) files(harnessRoot, join(pkg.directory, name), dependency);
  }
  return { source: source.sort(([a], [b]) => a.localeCompare(b)), dependency: dependency.sort(([a], [b]) => a.localeCompare(b)), tools: tools(root, harnessRoot) };
}

export function captureCompatibilityOutputs(root) {
  const output = [];
  for (const group of ['packages', 'apps']) for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
    if (entry.isDirectory()) files(root, join(root, group, entry.name, 'dist'), output);
  }
  files(root, join(root, 'integrations/deepseek-harness/dist'), output);
  files(root, join(root, 'integrations/deepseek-harness/.build/fixtures'), output);
  if (!output.some(([path]) => path === 'packages/agent-runtime/dist/harness.js') ||
    !output.some(([path]) => path === 'integrations/deepseek-harness/dist/startup.js')) fail();
  return output.sort(([a], [b]) => a.localeCompare(b));
}

export function assertCompatibilityWitness(root, harnessRoot) {
  try {
    const witness = JSON.parse(readFileSync(join(root, 'integrations/deepseek-harness/.build/compatibility-witness.json'), 'utf8'));
    if (witness.schema !== 'openslack.compatibility_witness.v1' || witness.harnessCommit !== HARNESS_COMPATIBILITY_SHA ||
      JSON.stringify(witness.inputs) !== JSON.stringify(captureCompatibilityInputs(root, harnessRoot)) ||
      JSON.stringify(witness.outputs) !== JSON.stringify(captureCompatibilityOutputs(root))) fail();
  } catch { fail(); }
}
