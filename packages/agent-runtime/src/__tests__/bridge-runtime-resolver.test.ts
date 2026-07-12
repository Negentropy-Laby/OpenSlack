import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BridgeRuntimeConfigError,
  createBridgeRuntimeResolver,
  isAbyRuntime,
  loadAbyBridgeRuntimeConfig,
} from '../index.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'bridge-runtime-resolver-test-'));
}

function cleanup(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function createFakeAbyRoot(root: string): string {
  const abyRoot = join(root, 'fake-aby');
  const entrypointDir = join(abyRoot, 'src', 'sidecar', 'entrypoints');
  mkdirSync(entrypointDir, { recursive: true });
  writeFileSync(join(entrypointDir, 'runEntrypoint.ts'), 'export {}\n', 'utf-8');
  writeFileSync(join(entrypointDir, 'agentRunBridge.ts'), 'export {}\n', 'utf-8');
  return abyRoot;
}

describe('BridgeRuntimeResolver', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('detects Aby runtime hints from the execution provider and legacy fields', () => {
    expect(isAbyRuntime({ agentId: 'a', source: 'test', runtimeProvider: 'aby' })).toBe(true);
    expect(isAbyRuntime({ agentId: 'a', source: 'test', runtime: 'aby_assistant' })).toBe(true);
    expect(isAbyRuntime({ agentId: 'a', source: 'test', runtime: 'aby' })).toBe(true);
    expect(isAbyRuntime({ agentId: 'a', source: 'test', provider: 'aby' })).toBe(true);
    expect(isAbyRuntime({ agentId: 'anthropic_architect_aby', source: 'test' })).toBe(false);
  });

  it('returns null for non-Aby runtimes', () => {
    const resolver = createBridgeRuntimeResolver({ rootDir: root });
    const resolved = resolver.resolve({ agentId: 'plain', source: 'test' });
    expect(resolved).toBeNull();
  });

  it('fails closed when an Aby runtime has no configured root', () => {
    const resolver = createBridgeRuntimeResolver({ rootDir: root, env: {} });
    expect(() =>
      resolver.resolve({ agentId: 'aby', source: 'test', runtime: 'aby_assistant' }),
    ).toThrow(BridgeRuntimeConfigError);
  });

  it('builds process command options from OPENSLACK_ABY_ROOT', () => {
    const abyRoot = createFakeAbyRoot(root);
    const resolver = createBridgeRuntimeResolver({
      rootDir: root,
      env: { OPENSLACK_ABY_ROOT: abyRoot },
    });

    const resolved = resolver.resolve({
      agentId: 'aby',
      source: 'test',
      runtime: 'aby_assistant',
    });

    expect(resolved?.command).toBe('bun');
    expect(resolved?.abyRoot).toBe(abyRoot);
    expect(resolved?.args?.[0]).toContain('runEntrypoint.ts');
    expect(resolved?.args?.[1]).toContain('agentRunBridge.ts');
  });

  it('resolves an explicit Aby execution provider without legacy runtime fields', () => {
    const abyRoot = createFakeAbyRoot(root);
    const resolver = createBridgeRuntimeResolver({
      rootDir: root,
      env: { OPENSLACK_ABY_ROOT: abyRoot },
    });

    const resolved = resolver.resolve({
      agentId: 'aby',
      source: 'test',
      runtimeProvider: 'aby',
      provider: 'anthropic',
    });

    expect(resolved?.abyRoot).toBe(abyRoot);
    expect(resolved?.command).toBe('bun');
  });

  it('loads .openslack.local agent-runtime config and filters unsafe env keys', () => {
    const abyRoot = createFakeAbyRoot(root);
    const configDir = join(root, '.openslack.local');
    mkdirSync(configDir, { recursive: true });
    const configPath = join(configDir, 'agent-runtime.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        aby: {
          root: abyRoot,
          command: 'bun',
          timeoutMs: 5000,
          env: {
            USER_TYPE: 'aby',
            AGENT_RUN_BRIDGE_RUNNER: 'fake',
            OPENSLACK_PRIVATE_KEY: 'blocked',
          },
        },
      }),
      'utf-8',
    );

    const loaded = loadAbyBridgeRuntimeConfig({ rootDir: root, env: {} });
    expect(loaded.root).toBe(abyRoot);

    const resolver = createBridgeRuntimeResolver({ rootDir: root, env: {} });
    const resolved = resolver.resolve({
      agentId: 'aby',
      source: 'test',
      runtime: 'aby_assistant',
    });

    expect(resolved?.timeoutMs).toBe(5000);
    expect(resolved?.env?.AGENT_RUN_BRIDGE_RUNNER).toBe('fake');
    expect(resolved?.env?.USER_TYPE).toBeUndefined();
    expect(resolved?.env?.OPENSLACK_PRIVATE_KEY).toBeUndefined();
  });
});
