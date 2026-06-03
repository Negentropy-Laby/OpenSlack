import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupAbyRuntime } from '../index.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-runtime-setup-test-'));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function createFakeAbyRoot(root: string, options: { bridge?: boolean } = {}): string {
  const abyRoot = join(root, 'fake-aby');
  const entrypointDir = join(abyRoot, 'src', 'sidecar', 'entrypoints');
  mkdirSync(entrypointDir, { recursive: true });
  writeFileSync(join(entrypointDir, 'runEntrypoint.ts'), 'export {}\n', 'utf-8');
  if (options.bridge !== false) {
    writeFileSync(join(entrypointDir, 'agentRunBridge.ts'), 'export {}\n', 'utf-8');
  }
  return abyRoot;
}

describe('setupAbyRuntime', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('renders a redacted dry-run config without writing local config', () => {
    const abyRoot = createFakeAbyRoot(root);
    const report = setupAbyRuntime({
      rootDir: root,
      root: abyRoot,
      bridgeEnv: { AGENT_RUN_BRIDGE_RUNNER: 'real' },
      checkCommandAvailable: () => true,
    });

    expect(report.status).toBe('PASS');
    expect(report.mode).toBe('dry-run');
    expect(report.wroteConfig).toBe(false);
    expect(existsSync(join(root, '.openslack.local', 'agent-runtime.json'))).toBe(false);
    expect(JSON.stringify(report.configPreview)).toContain('AGENT_RUN_BRIDGE_RUNNER');
    expect(JSON.stringify(report.configPreview)).not.toContain('real');
  });

  it('writes minimal local config when --write checks pass', () => {
    const abyRoot = createFakeAbyRoot(root);
    const report = setupAbyRuntime({
      rootDir: root,
      root: abyRoot,
      write: true,
      checkCommandAvailable: () => true,
      diagnose: () => ({
        provider: 'aby',
        status: 'PASS',
        configSource: '.openslack.local/agent-runtime.json',
        configPath: join(root, '.openslack.local', 'agent-runtime.json'),
        root: abyRoot,
        resolvedRoot: abyRoot,
        command: 'bun',
        args: [],
        env: { allowedKeys: [], rejectedKeys: [] },
        checks: [],
        remediations: ['ok'],
        remediation: 'ok',
      }),
    });

    const configPath = join(root, '.openslack.local', 'agent-runtime.json');
    expect(report.status).toBe('PASS');
    expect(report.wroteConfig).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({
      aby: { root: abyRoot, command: 'bun', timeoutMs: 120000 },
    });
  });

  it('fails closed when an entrypoint or command is missing', () => {
    const abyRoot = createFakeAbyRoot(root, { bridge: false });
    const report = setupAbyRuntime({
      rootDir: root,
      root: abyRoot,
      write: true,
      checkCommandAvailable: () => false,
    });

    expect(report.status).toBe('FAIL');
    expect(report.checks.find((check) => check.name === 'agentRunBridge.ts')?.status).toBe('FAIL');
    expect(report.checks.find((check) => check.name === 'command')?.status).toBe('FAIL');
    expect(report.wroteConfig).toBe(false);
  });

  it('rejects unsafe bridge env keys without writing values', () => {
    const abyRoot = createFakeAbyRoot(root);
    const report = setupAbyRuntime({
      rootDir: root,
      root: abyRoot,
      write: true,
      bridgeEnv: {
        AGENT_RUN_SAFE_MODE: 'plan',
        OPENSLACK_PRIVATE_KEY: 'should-not-leak',
      },
      checkCommandAvailable: () => true,
    });

    expect(report.status).toBe('FAIL');
    expect(report.env.allowedKeys).toEqual(['AGENT_RUN_SAFE_MODE']);
    expect(report.env.rejectedKeys).toEqual(['OPENSLACK_PRIVATE_KEY']);
    expect(report.wroteConfig).toBe(false);
    expect(JSON.stringify(report)).not.toContain('should-not-leak');
  });
});
