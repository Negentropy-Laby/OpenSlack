/** Resolve only public package exports from the explicitly approved Harness installation. */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
export function publicHarnessPackages(harnessRoot) {
  const paths = [];
  for (const group of readdirSync(join(harnessRoot, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const entry of readdirSync(join(harnessRoot, 'packages', group.name), { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(join(harnessRoot, 'packages', group.name, entry.name));
    }
  }
  for (const entry of readdirSync(join(harnessRoot, 'vendor'), { withFileTypes: true })) {
    if (entry.isDirectory()) paths.push(join(harnessRoot, 'vendor', entry.name));
  }
  paths.push(join(harnessRoot, 'apps/cli'));
  const result = new Map();
  for (const directory of paths) {
    const manifestPath = join(directory, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.name !== 'string') continue;
    result.set(manifest.name, { directory, manifest, manifestPath });
  }
  const sdk = result.get('@deepseek-ai/dsh-sdk-client');
  const cli = result.get('@deepseek-ai/dsh');
  if (!sdk || !cli || sdk.manifest.version !== '0.2.1-rc.3' || cli.manifest.version !== sdk.manifest.version) {
    throw new Error('The external plugin requires unmodified same-version SDK/dsh 0.2.1-rc.3');
  }
  return result;
}

export function publicEntry(pkg) {
  const selected = value => typeof value === 'string' ? value
    : value && typeof value === 'object' ? ['import', 'node', 'default'].map(key => selected(value[key])).find(Boolean) : undefined;
  const path = selected(pkg.manifest.exports?.['.']);
  if (path) return resolve(pkg.directory, path);
  return createRequire(pkg.manifestPath).resolve(pkg.manifest.name);
}

export function publicAliases(harnessRoot, declarations = false) {
  const packages = publicHarnessPackages(harnessRoot);
  const aliases = {};
  for (const [name, pkg] of packages) {
    const types = pkg.manifest.exports?.['.']?.types ?? pkg.manifest.types;
    try {
      const path = declarations && typeof types === 'string' ? resolve(pkg.directory, types) : publicEntry(pkg);
      if (existsSync(path)) aliases[name] = path;
    } catch { /* Packages without a public root are not consumed by this integration. */ }
  }
  const mcp = packages.get('@deepseek-ai/dsh-mcp-client');
  if (!mcp) throw new Error('Native MCP public tool adapter is required');
  const require = createRequire(mcp.manifestPath);
  for (const name of ['@modelcontextprotocol/client', '@modelcontextprotocol/client/stdio']) {
    const entry = require.resolve(name);
    const packageRoot = resolve(dirname(entry), '..');
    const metadata = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    const exported = metadata.exports[name.endsWith('/stdio') ? './stdio' : '.'].import;
    aliases[name] = resolve(packageRoot, declarations ? exported.types : exported.default);
  }
  return aliases;
}
