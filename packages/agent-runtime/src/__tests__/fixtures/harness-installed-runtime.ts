/** Isolated installed byte fixtures. No SDK, model, credential or production source is replaced. */
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashHarnessRuntimeArtifacts } from '../../harness-task-execution.js';
import { hashOpenSlackHarnessCallback } from '../../harness-artifacts.js';
function put(path: string, value: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function manifest(path: string, value: object): void { put(join(path, 'package.json'), JSON.stringify(value)); }

export function createInstalledRuntimeFixture(kind: 'harness' | 'callback') {
  const root = mkdtempSync(join(tmpdir(), 'harness-installed-closure-'));
  const packages = kind === 'harness' ? [
    ['packages/sdk/client', '@deepseek-ai/dsh-sdk-client'], ['packages/sdk/server', '@deepseek-ai/dsh-sdk-jsonrpc-server'],
    ['packages/mcp/client', '@deepseek-ai/dsh-mcp-client'], ['apps/cli', '@deepseek-ai/dsh'],
    ['packages/llm/llm', '@deepseek-ai/dsh-llm'], ['vendor/cordis', '@deepseek-ai/cordis'],
    ['vendor/schemastery', '@deepseek-ai/schemastery'], ['packages/sdk/protocol', '@deepseek-ai/dsh-sdk-protocol'],
  ] : [['apps/cli', '@openslack/cli'], ['apps/mcp', '@openslack/mcp']];
  mkdirSync(join(root, 'packages'), { recursive: true }); mkdirSync(join(root, 'vendor'), { recursive: true });
  for (const [path, name] of packages) {
    const directory = join(root, path!), output = kind === 'harness' ? 'lib' : 'dist';
    manifest(directory, { name, version: '0.2.1-rc.3', type: 'module', exports: { '.': `./${output}/index.js` },
      dependencies: { '@modelcontextprotocol/client': '2.2.0', ...(name === '@deepseek-ai/dsh-sdk-client'
        ? Object.fromEntries(packages.filter(([, dependency]) => dependency !== name).map(([, dependency]) => [dependency, 'workspace:*'])) : {}) } });
    put(join(directory, output, 'index.js'), 'export {};');
    const link = join(root, 'node_modules', name!);
    mkdirSync(dirname(link), { recursive: true }); symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  }
  const peer = join(root, 'node_modules/@modelcontextprotocol/client');
  manifest(peer, { name: '@modelcontextprotocol/client', version: '2.2.0', type: 'module',
    exports: { '.': './dist/index.js', './stdio': './dist/stdio.js' }, dependencies: { 'fixture-transitive': '1.0.0' } });
  for (const name of ['index', 'stdio']) put(join(peer, `dist/${name}.js`), 'export { observed } from "./chunks/session.js";');
  const split = join(peer, 'dist/chunks/session.js');
  put(split, 'import { value } from "fixture-transitive";export const observed=value+"A";');
  const transitive = join(peer, 'node_modules/fixture-transitive');
  manifest(transitive, { name: 'fixture-transitive', version: '1.0.0', type: 'module', exports: './index.js' });
  put(join(transitive, 'index.js'), 'export const value="one";');
  const lock = join(root, kind === 'harness' ? 'pnpm-lock.yaml' : 'bun.lock'); put(lock, 'fixed fixture lock');
  const hash = () => kind === 'harness' ? hashHarnessRuntimeArtifacts(root) : hashOpenSlackHarnessCallback(join(root, 'apps/cli/dist/index.js'));
  return { root, peer, split, transitive, lock, hash };
}
