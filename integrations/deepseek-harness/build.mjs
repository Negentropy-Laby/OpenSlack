/** Independent artifact/type entrypoint: Harness is a read-only dependency, not a patched workspace. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { publicAliases } from './runtime-public.mjs';
const root = import.meta.dirname;
const harnessRoot = process.env.DEEPSEEK_HARNESS_CHECKOUT;
if (!harnessRoot) throw new Error('Set DEEPSEEK_HARNESS_CHECKOUT to the built, unmodified dependency');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const aliases = publicAliases(resolve(harnessRoot), true);
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
const external = Object.keys(manifest.peerDependencies);
const built = await Bun.build({
  entrypoints: ['index', 'initiator', 'readonly', 'sdk-host', 'startup', 'runtime', 'owned-sdk'].map(name => join(root, `src/${name}.ts`)),
  outdir: join(root, 'dist'), target: 'node', format: 'esm', splitting: false, sourcemap: 'none', external,
});
if (!built.success) { for (const log of built.logs) console.error(log); process.exit(1); }
const fixture = await Bun.build({ entrypoints: [join(root, 'tests/fixtures/scripted-model.ts')],
  outdir: join(root, '.build/fixtures'), target: 'node', format: 'esm', sourcemap: 'none', external });
if (!fixture.success) { for (const log of fixture.logs) console.error(log); process.exit(1); }
console.log('External plugin public-API typecheck and artifacts passed; no Harness files modified.');
