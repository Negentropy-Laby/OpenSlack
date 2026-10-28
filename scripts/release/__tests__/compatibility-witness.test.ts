import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type * as ChildProcessModule from 'node:child_process';
import { captureCompatibilityInputs, captureCompatibilityOutputs, assertCompatibilityWitness } from '../../../integrations/deepseek-harness/compatibility-witness.mjs';
import { publicAliases } from '../../../integrations/deepseek-harness/runtime-public.mjs';

vi.mock('node:child_process', async load => {
  const child = await load<typeof ChildProcessModule>();
  return { ...child, spawnSync: vi.fn((...args: Parameters<typeof spawnSync>) => args[0] === 'go'
    ? { status: 0, stdout: 'fixture-only Go tool observation', stderr: '', signal: null }
    : child.spawnSync(...args)) };
});

describe('explicit compatibility preparation content witness (not runtime authority)', () => {
  it('rejects preserved-mtime source, lock, config, output, peer and compiler drift without building or rewriting the witness', () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-witness-policy-')), harness = join(root, 'original-peer-fixture');
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
    mkdirSync(join(root, 'apps'), { recursive: true });
    mkdirSync(join(harness, 'vendor'), { recursive: true });
    put(join(root, 'package.json'), '{}'); put(join(root, 'bun.lock'), 'fixture lock');
    put(join(root, 'tsconfig.json'), '{}');
    put(join(root, 'scripts/release/stage-schema-assets.ts'), '/* fixture staging input */');
    put(join(root, 'packages/agent-runtime/contracts/v1/schema.json'), '{}');
    put(join(root, 'packages/agent-runtime/src/harness.ts'), 'export const fixture = 1;');
    put(join(root, 'packages/agent-runtime/dist/harness.js'), 'export const fixture = 1;');
    put(join(root, 'packages/agent-runtime/dist/bridge-wire.js'), 'export const fixture = 1;');
    put(join(root, 'integrations/deepseek-harness/package.json'), '{}');
    put(join(root, 'integrations/deepseek-harness/vitest.config.ts'), 'export default {};');
    put(join(root, 'integrations/deepseek-harness/dist/startup.js'), 'export const fixture = 1;');
    put(join(root, 'node_modules/typescript/package.json'), '{"version":"fixture-only"}');
    put(join(harness, 'packages/sdk/client/package.json'), '{"name":"@deepseek-ai/dsh-sdk-client","version":"0.2.1-rc.3"}');
    put(join(harness, 'packages/sdk/client/lib/index.js'), 'export const fixture = 1;');
    put(join(harness, 'apps/cli/package.json'), '{"name":"@deepseek-ai/dsh","version":"0.2.1-rc.3"}');
    put(join(harness, 'packages/sdk/mcp/package.json'), '{"name":"@deepseek-ai/dsh-mcp-client","version":"0.2.1-rc.3"}');
    const mcp = join(harness, 'node_modules/@modelcontextprotocol/client');
    put(join(mcp, 'package.json'), JSON.stringify({ name: '@modelcontextprotocol/client', version: '2.2.0', exports: {
      '.': { import: { default: './lib/index.js', types: './lib/index.d.ts' }, require: { default: './lib/index.js' } },
      './stdio': { import: { default: './lib/stdio.js', types: './lib/stdio.d.ts' }, require: { default: './lib/stdio.js' } },
    } }));
    for (const name of ['index.js', 'stdio.js', 'chunk.js', 'index.d.ts', 'stdio.d.ts']) put(join(mcp, 'lib', name), 'export {};');
    put(join(harness, 'package.json'), '{}'); put(join(harness, 'pnpm-lock.yaml'), 'fixture lock');
    const witnessPath = join(root, 'integrations/deepseek-harness/.build/compatibility-witness.json');
    const witness = JSON.stringify({ schema: 'openslack.compatibility_witness.v1',
      harnessCommit: '22ddee3792402c3e70ec5f86a63c3e3e895a2f60',
      inputs: captureCompatibilityInputs(root, harness), outputs: captureCompatibilityOutputs(root) });
    put(witnessPath, witness);
    expect(() => assertCompatibilityWitness(root, harness)).not.toThrow();
    for (const path of ['packages/agent-runtime/src/harness.ts', 'bun.lock', 'tsconfig.json',
      'scripts/release/stage-schema-assets.ts', 'packages/agent-runtime/contracts/v1/schema.json',
      'packages/agent-runtime/dist/harness.js', 'integrations/deepseek-harness/dist/startup.js', 'integrations/deepseek-harness/vitest.config.ts',
      'original-peer-fixture/packages/sdk/client/lib/index.js', 'node_modules/typescript/package.json']) {
      const target = join(root, path), bytes = readFileSync(target), stamp = statSync(target);
      writeFileSync(target, Buffer.concat([bytes, Buffer.from(' ')])); utimesSync(target, stamp.atime, stamp.mtime);
      expect(() => assertCompatibilityWitness(root, harness), path).toThrow('Prepare explicitly:');
      expect(readFileSync(witnessPath, 'utf8')).toBe(witness);
      writeFileSync(target, bytes); utimesSync(target, stamp.atime, stamp.mtime);
    }
    for (const name of ['package.json', 'lib/index.js', 'lib/stdio.js', 'lib/chunk.js']) {
      const target = join(mcp, name), bytes = readFileSync(target), stamp = statSync(target);
      writeFileSync(target, Buffer.concat([bytes, Buffer.from(' ')])); utimesSync(target, stamp.atime, stamp.mtime);
      expect(() => assertCompatibilityWitness(root, harness), name).toThrow('Prepare explicitly:');
      expect(readFileSync(witnessPath, 'utf8')).toBe(witness);
      writeFileSync(target, bytes); utimesSync(target, stamp.atime, stamp.mtime);
    }
    expect(() => assertCompatibilityWitness(root, harness)).not.toThrow();
    const manifestPath = join(mcp, 'package.json'), original = readFileSync(manifestPath);
    for (const variant of ['version', 'root-string', 'stdio-string', 'missing-types', 'missing-default']) {
      const metadata = JSON.parse(original.toString('utf8'));
      if (variant === 'version') metadata.version = '2.3.0';
      if (variant === 'root-string') metadata.exports['.'].import = './lib/index.js';
      if (variant === 'stdio-string') metadata.exports['./stdio'].import = './lib/stdio.js';
      if (variant === 'missing-types') delete metadata.exports['.'].import.types;
      if (variant === 'missing-default') delete metadata.exports['.'].import.default;
      writeFileSync(manifestPath, JSON.stringify(metadata));
      try { expect(() => publicAliases(harness), variant).toThrow('Unsupported pinned MCP public export layout'); }
      finally { writeFileSync(manifestPath, original); }
    }
    expect(() => assertCompatibilityWitness(root, harness)).not.toThrow();
  }, 60_000);
  it.each(['OPENSLACK_BRIDGE_WIRE_MODULE', 'OPENSLACK_SCHEMA_STAGE_ROOT'])('refuses fixture-only %s before any real preparation or output write', variable => {
    const result = spawnSync(process.execPath, [join(import.meta.dirname, '../../../integrations/deepseek-harness/prepare-compatibility.mjs')], {
      encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, [variable]: '/not-approved/fixture' },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`Formal compatibility preparation rejects ${variable}`);
  });
});
