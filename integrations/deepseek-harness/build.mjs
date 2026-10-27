/** Independent artifact/type entrypoint: Harness is a read-only dependency, not a patched workspace. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { publicAliases } from './runtime-public.mjs';
const root = import.meta.dirname;
const harnessRoot = process.env.DEEPSEEK_HARNESS_CHECKOUT;
if (!harnessRoot) throw new Error('Set DEEPSEEK_HARNESS_CHECKOUT to the built, unmodified dependency');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const aliases = publicAliases(resolve(harnessRoot), true);
// Bundle only the pure shared wire leaf. No Agent Runtime state/identity module
// or second Harness runtime is imported into the external plugin.
const wireModule = process.env.OPENSLACK_BRIDGE_WIRE_MODULE ?? join(root, '../../packages/agent-runtime/dist/bridge-wire.js');
if (!isAbsolute(wireModule) || !wireModule.endsWith('bridge-wire.js')) throw new Error('The pure shared Bridge leaf must use its exact built public subpath');
const wireTypes = wireModule.replace(/\.js$/, '.d.ts');
aliases['@openslack/agent-runtime/internal/bridge-wire'] = wireTypes;
mkdirSync(join(root, '.build'), { recursive: true });
const config = join(root, '.build/tsconfig.json');
writeFileSync(config, JSON.stringify({ compilerOptions: {
  target: 'ES2024', module: 'ESNext', moduleResolution: 'Bundler', strict: true,
  skipLibCheck: true, allowImportingTsExtensions: true, declaration: true, emitDeclarationOnly: true, rootDir: root,
  outDir: join(root, 'dist/types'), types: ['node'],
  typeRoots: [join(harnessRoot, 'node_modules/@types')],
  paths: Object.fromEntries(Object.entries(aliases).map(([name, path]) => [name, [path]])),
}, include: ['../src/**/*.ts'] }));
const checked = spawnSync(process.execPath, [join(harnessRoot, 'node_modules/typescript/bin/tsc'), '-p', config], { stdio: 'inherit' });
if (checked.status !== 0) process.exit(checked.status ?? 1);
// The packed declarations must be independently consumable beside Harness peers,
// not accidentally depend on this private OpenSlack workspace after relocation.
const typesDirectory = join(root, 'dist/types/src');
copyFileSync(wireTypes, join(typesDirectory, 'bridge-wire.d.ts'));
for (const name of readdirSync(typesDirectory).filter(name => name.endsWith('.d.ts'))) {
  const path = join(typesDirectory, name);
  writeFileSync(path, readFileSync(path, 'utf8').replaceAll('@openslack/agent-runtime/internal/bridge-wire', './bridge-wire.js'));
}
const external = Object.keys(manifest.peerDependencies);
const wirePlugin = { name: 'openslack-pure-bridge-wire', setup(builder) {
  builder.onResolve({ filter: /^@openslack\/agent-runtime\/internal\/bridge-wire$/ }, () => ({ path: wireModule }));
} };
const built = await Bun.build({
  entrypoints: ['index', 'initiator', 'readonly', 'sdk-host', 'startup', 'runtime', 'owned-sdk'].map(name => join(root, `src/${name}.ts`)),
  outdir: join(root, 'dist'), target: 'node', format: 'esm', splitting: false, sourcemap: 'none', external,
  plugins: [wirePlugin],
});
if (!built.success) { for (const log of built.logs) console.error(log); process.exit(1); }
const goEnv = { ...process.env, GOWORK: 'off', GOTOOLCHAIN: 'local' };
const goVersion = spawnSync('go', ['version'], { env: goEnv, encoding: 'utf8' });
if (goVersion.status !== 0 || !/^go version go1\.26\.5\s/.test(goVersion.stdout)) {
  throw new Error('Building the private Windows supervisor requires Go 1.26.5');
}
const native = spawnSync('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags=-s -w -buildid=',
  '-o', join(root, 'dist/openslack-harness-supervisor.exe'), '.'], {
  cwd: join(root, 'native-supervisor'), stdio: 'inherit',
  env: { ...goEnv, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
});
if (native.status !== 0) process.exit(native.status ?? 1);
const fixture = await Bun.build({ entrypoints: [join(root, 'tests/fixtures/scripted-model.ts')],
  outdir: join(root, '.build/fixtures'), target: 'node', format: 'esm', sourcemap: 'none', external,
  plugins: [wirePlugin] });
if (!fixture.success) { for (const log of fixture.logs) console.error(log); process.exit(1); }
console.log('External plugin public-API typecheck and artifacts passed; no Harness files modified.');
