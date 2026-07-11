import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearCommandAvailabilityCache,
  diagnoseAbyRuntime,
  diagnoseAgentRuntime,
} from '../index.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-runtime-doctor-test-'));
}

function cleanup(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
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

describe('diagnoseAbyRuntime', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    clearCommandAvailabilityCache();
    cleanup(root);
  });

  it('fails closed when no Aby root is configured', () => {
    const report = diagnoseAbyRuntime({
      rootDir: root,
      env: {},
      checkCommand: () => ({ available: true, detail: 'available for test' }),
    });

    expect(report.status).toBe('FAIL');
    expect(report.readiness).toBe('not_configured');
    expect(report.configSource).toBe('none');
    expect(report.checks.find((check) => check.name === 'config-source')?.status).toBe('FAIL');
    expect(report.remediation).toContain('OPENSLACK_ABY_ROOT');
  });

  it('passes when OPENSLACK_ABY_ROOT points at a bridge-capable checkout', () => {
    const abyRoot = createFakeAbyRoot(root);
    const report = diagnoseAbyRuntime({
      rootDir: root,
      env: { OPENSLACK_ABY_ROOT: abyRoot },
      checkCommand: () => ({ available: true, detail: 'bun test-version' }),
    });

    expect(report.status).toBe('PASS');
    expect(report.readiness).toBe('ready');
    expect(report.configSource).toBe('OPENSLACK_ABY_ROOT');
    expect(report.command).toBe('bun');
    expect(report.args[0]).toContain('runEntrypoint.ts');
    expect(report.args[1]).toContain('agentRunBridge.ts');
  });

  it('fails when agentRunBridge.ts is missing', () => {
    const abyRoot = createFakeAbyRoot(root, { bridge: false });
    const report = diagnoseAbyRuntime({
      rootDir: root,
      env: { OPENSLACK_ABY_ROOT: abyRoot },
    });

    expect(report.status).toBe('FAIL');
    expect(report.readiness).toBe('misconfigured');
    expect(report.checks.find((check) => check.name === 'agentRunBridge.ts')?.status).toBe('FAIL');
    expect(report.remediation).toContain('agentRunBridge.ts');
  });

  it('audits unsafe env keys without exposing values', () => {
    const abyRoot = createFakeAbyRoot(root);
    const configDir = join(root, '.openslack.local');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'agent-runtime.json'),
      JSON.stringify({
        aby: {
          root: abyRoot,
          env: {
            AGENT_RUN_BRIDGE_RUNNER: 'fake',
            OPENSLACK_PRIVATE_KEY: 'should-not-print',
          },
        },
      }),
      'utf-8',
    );

    const report = diagnoseAbyRuntime({
      rootDir: root,
      env: {},
      checkCommand: () => ({ available: true, detail: 'available for test' }),
    });

    expect(report.status).toBe('FAIL');
    expect(report.env.allowedKeys).toEqual(['AGENT_RUN_BRIDGE_RUNNER']);
    expect(report.env.rejectedKeys).toEqual(['OPENSLACK_PRIVATE_KEY']);
    expect(JSON.stringify(report)).not.toContain('should-not-print');
  });

  it('distinguishes configured but unavailable commands', () => {
    const abyRoot = createFakeAbyRoot(root);
    const report = diagnoseAbyRuntime({
      rootDir: root,
      env: { OPENSLACK_ABY_ROOT: abyRoot },
      checkCommand: () => ({ available: false, detail: 'Command unavailable' }),
    });

    expect(report.status).toBe('FAIL');
    expect(report.readiness).toBe('unavailable');
    expect(report.checks.find((check) => check.name === 'command-available')).toMatchObject({
      status: 'FAIL',
    });
    expect(report.remediation).toContain('Install the configured bridge command');
  });

  it('caches identical command probes for the process lifetime', () => {
    const abyRoot = createFakeAbyRoot(root);
    const checkCommand = vi.fn(() => ({ available: true, detail: 'bun test-version' }));
    const options = {
      rootDir: root,
      env: { OPENSLACK_ABY_ROOT: abyRoot },
      checkCommand,
    };

    expect(diagnoseAbyRuntime(options).readiness).toBe('ready');
    expect(diagnoseAbyRuntime(options).readiness).toBe('ready');
    expect(checkCommand).toHaveBeenCalledOnce();
  });

  it('aggregates additional provider diagnostics without hardcoding their IDs', () => {
    const report = diagnoseAgentRuntime({
      rootDir: root,
      env: {},
      providerDiagnostics: [
        {
          id: 'openai-compatible',
          diagnose: () => ({
            provider: 'openai-compatible',
            status: 'PASS',
            readiness: 'ready',
            remediations: [],
          }),
        },
      ],
    });

    expect(report.status).toBe('PASS');
    expect(report.readiness).toBe('ready');
    expect(report.providers['openai-compatible']).toMatchObject({
      provider: 'openai-compatible',
      readiness: 'ready',
    });
  });

  it('reports remediation for every failed check', () => {
    const abyRoot = createFakeAbyRoot(root, { bridge: false });
    const configDir = join(root, '.openslack.local');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'agent-runtime.json'),
      JSON.stringify({
        aby: {
          root: abyRoot,
          env: {
            OPENSLACK_PRIVATE_KEY: 'should-not-print',
          },
        },
      }),
      'utf-8',
    );

    const report = diagnoseAbyRuntime({
      rootDir: root,
      env: {},
      checkCommand: () => ({ available: true, detail: 'available for test' }),
    });

    expect(report.status).toBe('FAIL');
    expect(report.checks.find((check) => check.name === 'agentRunBridge.ts')?.status).toBe('FAIL');
    expect(report.checks.find((check) => check.name === 'safe-env')?.status).toBe('FAIL');
    expect(report.remediation).toContain('agentRunBridge.ts');
    expect(report.remediation).toContain('Remove unsafe env keys');
    expect(report.remediation.split('\n')).toHaveLength(2);
    expect(JSON.stringify(report)).not.toContain('should-not-print');
  });

  it('reports aggregate readiness when the built-in provider is configured', () => {
    const configDir = join(root, '.openslack.local');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'agent-runtime.json'),
      JSON.stringify({
        providers: {
          'openai-compatible': {
            baseUrl: 'https://example.test/v1',
            model: 'test-model',
            credentialRef: 'env:TEST_RUNTIME_KEY',
          },
        },
      }),
      'utf-8',
    );
    const report = diagnoseAgentRuntime({
      rootDir: root,
      env: { TEST_RUNTIME_KEY: 'transport-only-test-value' },
    });
    expect(report).toMatchObject({ status: 'PASS', readiness: 'ready' });
    expect(Object.keys(report.providers)).toEqual(['openai-compatible']);
    expect(JSON.stringify(report)).not.toContain('transport-only-test-value');
  });
});
