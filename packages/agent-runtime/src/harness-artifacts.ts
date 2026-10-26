import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

/** Exact external entry set; the qualification model is compiled outside the published package payload. */
export const HARNESS_PLUGIN_ENTRIES = ['index', 'initiator', 'readonly', 'sdk-host', 'startup', 'runtime', 'owned-sdk'] as const;

function artifactBytes(path: string, maxBytes = 64 * 1024 * 1024): Buffer {
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const directory = lstatSync(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Harness artifact cannot traverse a directory link');
    if (parent === dirname(parent)) break;
  }
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxBytes) throw new Error('Unsafe Harness deployment artifact');
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (before.ino !== entry.ino || before.dev !== entry.dev || before.size !== bytes.length || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode) throw new Error('Harness deployment artifact changed');
    return bytes;
  } finally { closeSync(descriptor); }
}

export function harnessPluginMountFiles(root: string): string[] {
  const canonical = realpathSync(root);
  const equal = process.platform === 'win32' ? canonical.toLowerCase() === resolve(root).toLowerCase() : canonical === resolve(root);
  if (!equal || lstatSync(root).isSymbolicLink()) throw new Error('External plugin root must be canonical');
  const files = HARNESS_PLUGIN_ENTRIES.map(name => join(root, 'dist', `${name}.js`));
  const fixture = join(root, '.build/fixtures/scripted-model.js');
  if (existsSync(fixture)) files.push(fixture);
  return files;
}

export function hashHarnessPluginArtifacts(root: string): string {
  const manifest = JSON.parse(artifactBytes(join(root, 'package.json')).toString('utf8')) as { name?: string };
  if (manifest.name !== '@openslack/deepseek-harness-plugin') throw new Error('Unexpected external Harness plugin');
  const digest = createHash('sha256');
  for (const path of [join(root, 'package.json'), join(root, 'plugin.patch.yml'), ...harnessPluginMountFiles(root)].sort()) {
    digest.update(relative(root, path).replaceAll('\\', '/')).update(artifactBytes(path));
  }
  return digest.digest('hex');
}

export function hashHarnessNodeExecutable(path: string): string {
  return createHash('sha256').update(artifactBytes(path, 256 * 1024 * 1024)).digest('hex');
}

/** Bind the real split tsc callback modules, not merely the CLI's small entry file. No local state or secrets are traversed. */
export function hashOpenSlackHarnessCallback(cliModule: string): string {
  const root = resolve(dirname(cliModule), '../../..');
  if (relative(root, cliModule).replaceAll('\\', '/') !== 'apps/cli/dist/index.js') {
    throw new Error('Harness callbacks require the matching built OpenSlack workspace CLI');
  }
  const digest = createHash('sha256');
  const file = (path: string): Buffer => {
    const bytes = artifactBytes(path, 16 * 1024 * 1024);
    digest.update(relative(root, path)).update(bytes);
    return bytes;
  };
  const packages = new Map<string, { path: string; manifest: Record<string, unknown> }>();
  const add = (path: string) => {
    const manifest = JSON.parse(artifactBytes(join(path, 'package.json'), 512 * 1024).toString('utf8')) as Record<string, unknown>;
    if (typeof manifest.name === 'string') packages.set(manifest.name, { path, manifest });
  };
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'package.json'))) add(join(root, 'packages', entry.name));
  }
  add(join(root, 'apps/cli')); add(join(root, 'apps/mcp'));
  const visited = new Set<string>();
  const walk = (path: string): void => {
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error('Callback artifact directory must not be linked');
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (entry.isSymbolicLink()) throw new Error('Callback artifact links are unsupported');
      if (entry.isDirectory()) walk(join(path, entry.name));
      else if (/\.(?:js|json)$/.test(entry.name)) file(join(path, entry.name));
    }
  };
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const pkg = packages.get(name);
    if (!pkg) throw new Error('Callback workspace package is missing');
    file(join(pkg.path, 'package.json'));
    if (existsSync(join(pkg.path, 'dist'))) walk(join(pkg.path, 'dist'));
    else throw new Error('Build the complete callback dependency closure before dispatch');
    for (const field of ['dependencies', 'optionalDependencies']) {
      const entries = pkg.manifest[field];
      if (entries && typeof entries === 'object') for (const dependency of Object.keys(entries).sort()) {
        const target = packages.get(dependency);
        if (!target) continue;
        let found = false;
        for (let current = pkg.path;; current = dirname(current)) {
          const candidate = join(current, 'node_modules', dependency);
          if (existsSync(candidate)) {
            found = true;
            if (realpathSync(candidate) !== realpathSync(target.path)) throw new Error('Callback workspace dependency resolves outside approved root');
          }
          if (current === root) break;
          if (current === dirname(current)) throw new Error('Callback package root is invalid');
        }
        if (!found) throw new Error('Callback workspace dependency is not installed');
        visit(dependency);
      }
    }
  };
  visit('@openslack/cli');
  visit('@openslack/mcp');
  file(join(root, 'bun.lock'));
  return digest.digest('hex');
}
