import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Component {
  type: 'application' | 'library';
  name: string;
  version: string;
  purl: string;
}

export function buildCycloneDxSbom(root: string, version: string): Record<string, unknown> {
  const components = new Map<string, Component>();
  const lock = readFileSync(join(root, 'bun.lock'), 'utf-8');
  for (const line of lock.split(/\r?\n/)) {
    const match = line.match(/^\s{4}"[^"]+": \["([^"]+@[^"@]+)"/);
    if (!match) continue;
    const at = match[1].lastIndexOf('@');
    const name = match[1].slice(0, at);
    const dependencyVersion = match[1].slice(at + 1);
    if (!name || !dependencyVersion) continue;
    components.set(`${name}@${dependencyVersion}`, component('library', name, dependencyVersion));
  }
  for (const parent of ['packages', 'apps']) {
    const directory = join(root, parent);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(directory, entry.name, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
        name: string;
        version: string;
      };
      components.set(
        `${manifest.name}@${manifest.version}`,
        component('library', manifest.name, manifest.version),
      );
    }
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: component('application', 'openslack', version),
      tools: [{ vendor: 'OpenSlack', name: 'scripts/release/sbom.ts', version: '1' }],
    },
    components: [...components.values()].sort((a, b) => a.purl.localeCompare(b.purl)),
  };
}

function component(type: Component['type'], name: string, version: string): Component {
  return {
    type,
    name,
    version,
    purl: `pkg:npm/${name.replace(/^@/, '%40')}@${version}`,
  };
}
