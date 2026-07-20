import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createBridgeAdapter,
  BridgeFactory,
  BridgeFactoryError,
  LocalExecutionAdapter,
  ExternalCommandAdapter,
  BridgeProcessAdapter,
  FakeBridgeAdapter,
  createOpenSlackAgentLauncher,
  createRunStore,
} from '../index.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'bridge-factory-test-'));
}

function cleanup(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('createBridgeAdapter', () => {
  it('returns LocalExecutionAdapter for local mode', () => {
    const adapter = createBridgeAdapter({ bridgeMode: 'local' });
    expect(adapter).toBeInstanceOf(LocalExecutionAdapter);
    expect(adapter.adapterId).toBe('local');
  });

  it('has no implicit local adapter default', () => {
    expect(() => createBridgeAdapter()).toThrow(/bridgeMode is required/);
  });

  it('returns ExternalCommandAdapter for external-command mode', () => {
    const adapter = createBridgeAdapter({
      bridgeMode: 'external-command',
      command: 'echo',
    });
    expect(adapter).toBeInstanceOf(ExternalCommandAdapter);
    expect(adapter.adapterId).toBe('external-command');
  });

  it('throws for external-command mode without command', () => {
    expect(() => createBridgeAdapter({ bridgeMode: 'external-command' })).toThrow(
      BridgeFactoryError,
    );
  });

  it('returns BridgeProcessAdapter for process mode', () => {
    const adapter = createBridgeAdapter({
      bridgeMode: 'process',
      command: 'node',
    });
    expect(adapter).toBeInstanceOf(BridgeProcessAdapter);
    expect(adapter.adapterId).toBe('bridge-process');
  });

  it('throws for process mode without command', () => {
    expect(() => createBridgeAdapter({ bridgeMode: 'process' })).toThrow(BridgeFactoryError);
  });

  it('returns FakeBridgeAdapter for fake mode', () => {
    const adapter = createBridgeAdapter({ bridgeMode: 'fake' });
    expect(adapter).toBeInstanceOf(FakeBridgeAdapter);
    expect(adapter.adapterId).toBe('fake-bridge');
  });

  it('throws for unknown mode', () => {
    expect(() => createBridgeAdapter({ bridgeMode: 'unknown' as any })).toThrow(
      /Unknown bridge mode/,
    );
  });

  it('error message includes valid modes', () => {
    expect(() => createBridgeAdapter({ bridgeMode: 'bad' as any })).toThrow(
      /local.*external-command.*process.*fake/,
    );
  });

  it('passes availableMcpServers to process adapter', () => {
    const adapter = createBridgeAdapter({
      bridgeMode: 'process',
      command: 'node',
      availableMcpServers: ['git', 'github'],
    });
    expect(adapter).toBeInstanceOf(BridgeProcessAdapter);
  });

  it('passes availableMcpServers to fake adapter', () => {
    const adapter = createBridgeAdapter({
      bridgeMode: 'fake',
      availableMcpServers: ['filesystem'],
    });
    expect(adapter).toBeInstanceOf(FakeBridgeAdapter);
  });
});

describe('BridgeFactory', () => {
  it('create(local) returns LocalExecutionAdapter', () => {
    const adapter = BridgeFactory.create('local');
    expect(adapter).toBeInstanceOf(LocalExecutionAdapter);
  });

  it('create(fake) returns FakeBridgeAdapter', () => {
    const adapter = BridgeFactory.create('fake');
    expect(adapter).toBeInstanceOf(FakeBridgeAdapter);
  });

  it('createFake returns FakeBridgeAdapter', () => {
    const adapter = BridgeFactory.createFake();
    expect(adapter).toBeInstanceOf(FakeBridgeAdapter);
  });

  it('createFake passes options', () => {
    const adapter = BridgeFactory.createFake({
      responseDelayMs: 50,
      shouldFail: true,
    });
    expect(adapter).toBeInstanceOf(FakeBridgeAdapter);
  });

  it('createProcess returns BridgeProcessAdapter', () => {
    const adapter = BridgeFactory.createProcess('node');
    expect(adapter).toBeInstanceOf(BridgeProcessAdapter);
  });

  it('createProcess passes options', () => {
    const adapter = BridgeFactory.createProcess('node', {
      args: ['--version'],
      timeoutMs: 5000,
    });
    expect(adapter).toBeInstanceOf(BridgeProcessAdapter);
  });
});

describe('Launcher bridgeMode integration', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('uses fake adapter when bridgeMode is fake', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new FakeBridgeAdapter(),
      bridgeMode: 'fake',
    });

    const result = await launcher('review this code', {
      label: 'reviewer',
      phase: 'review',
    });

    expect((result.data as Record<string, unknown>).review).toBeDefined();

    const runs = store.listRuns();
    expect(runs[0].status).toBe('completed');
  });

  it('explicit adapter takes precedence over bridgeMode', async () => {
    const store = createRunStore(root);
    const customAdapter = new LocalExecutionAdapter();
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: customAdapter,
      bridgeMode: 'fake',
    });

    const result = await launcher('test', {
      label: 'test',
      phase: 'test',
    });

    expect(result.data).toBeDefined();
  });

  it('fails closed when no bridgeMode, adapter, or provider is configured', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
    });

    await expect(
      launcher('test', {
        label: 'test',
        phase: 'test',
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_NOT_CONFIGURED' });
    expect(store.listRuns()[0]).toMatchObject({
      status: 'failed',
      failureCode: 'RUNTIME_NOT_CONFIGURED',
    });
  });
});
