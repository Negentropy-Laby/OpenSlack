import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { hashHarnessDeployment, hashHarnessNodeExecutable, hashHarnessPluginArtifacts } from '@openslack/agent-runtime/internal/harness';
import { prepareSdkFixture } from './fixtures/sdk-profile.ts';

describe('deployment mounts remain an exact two-code-root set', () => {
  it('binds the actual package and rejects both outside roots and unexported source inside a root', () => {
    const root = mkdtempSync(join(tmpdir(), 'openslack-two-roots-'));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const fixture = prepareSdkFixture(root, []);
    const deployment = { harnessRoot: fixture.repository, pluginRoot: fixture.pluginRoot,
      pluginBuildHash: hashHarnessPluginArtifacts(fixture.pluginRoot), nodeVersion: '24.18.1' as const,
      nodeExecutable: process.execPath, nodeSha256: hashHarnessNodeExecutable(process.execPath),
      dshHome: fixture.home, workerPatch: fixture.patch, agentId: 'fixture-only', provider: 'fixture', model: 'fixture', exitGraceMs: 1_000 };
    expect(hashHarnessDeployment(deployment)).toMatch(/^[a-f0-9]{64}$/);
    const outside = join(root, 'outside.js');
    writeFileSync(outside, 'throw new Error("must not execute");');
    const patch = readFileSync(fixture.patch);
    for (const name of [outside, join(fixture.pluginRoot, 'src/index.ts')]) {
      writeFileSync(fixture.patch, JSON.stringify([{ insert: [{ id: 'not-approved', name: pathToFileURL(name).href }] }]));
      expect(() => hashHarnessDeployment(deployment)).toThrow('separately bound');
    }
    writeFileSync(fixture.patch, patch);
    writeFileSync(fixture.patch, JSON.stringify([{ insert: [{ id: 'not-bound', name: '@deepseek-ai/dsh-sdk-jsonrpc-server/src/index.ts' }] }]));
    expect(() => hashHarnessDeployment(deployment)).toThrow('package or subpath');
    writeFileSync(fixture.patch, patch);
    expect(() => hashHarnessDeployment({ ...deployment, pluginBuildHash: '0'.repeat(64) })).toThrow('approved deployment');
    expect(() => hashHarnessDeployment({ ...deployment, nodeSha256: '0'.repeat(64) })).toThrow('approved deployment');
    const shadow = join(fixture.home, 'profiles/sdk/node_modules/@deepseek-ai/schemastery');
    mkdirSync(shadow, { recursive: true });
    writeFileSync(join(shadow, 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery', version: '4.0.0', main: 'index.js' }));
    writeFileSync(join(shadow, 'index.js'), 'throw new Error("must never load an unapproved same-name peer")');
    expect(() => hashHarnessDeployment(deployment)).toThrow('runtime peer override');
  });
});
