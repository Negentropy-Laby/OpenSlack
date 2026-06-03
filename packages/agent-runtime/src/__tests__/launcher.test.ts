import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpenSlackAgentLauncher, createRunStore, FakeBridgeAdapter, BridgeFactory } from '../index.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-launcher-test-'));
}

function cleanup(root: string) {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('createOpenSlackAgentLauncher', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it('does not throw "No agent launcher configured"', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    const result = await launcher('review this code', {
      label: 'reviewer',
      phase: 'review',
    });

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
  });

  it('creates a run record', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    await launcher('research something', {
      label: 'researcher',
      phase: 'research',
      agentType: 'research-agent',
      resolvedAgentConfig: {
        agentId: 'research-agent',
        source: 'claude-project',
        model: 'sonnet',
        permissionMode: 'plan',
      },
    });

    const runs = store.listRuns();
    expect(runs.length).toBe(1);
    expect(runs[0].agentId).toBe('research-agent');
    expect(runs[0].status).toBe('completed');
    expect(runs[0].model).toBe('sonnet');
  });

  it('writes transcript events', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    await launcher('plan this feature', {
      label: 'planner',
      phase: 'plan',
      resolvedAgentConfig: {
        agentId: 'planner',
        source: 'claude-project',
        permissionMode: 'plan',
      },
    });

    const run = store.listRuns()[0];
    const { readTranscript } = await import('../transcript.js');
    const transcript = readTranscript(run.runId, root);

    expect(transcript.length).toBeGreaterThan(0);
    expect(transcript[0].type).toBe('start');
    expect(transcript.some((e) => e.type === 'complete')).toBe(true);
  });

  it('respects permission mode in profile', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    await launcher('do something', {
      label: 'worker',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'worker',
        source: 'claude-project',
        permissionMode: 'plan',
        tools: ['Read', 'Grep'],
      },
    });

    const run = store.listRuns()[0];
    const { readTranscript } = await import('../transcript.js');
    const transcript = readTranscript(run.runId, root);
    const startEvent = transcript.find((e) => e.type === 'start');

    expect(startEvent).toBeDefined();
    expect(startEvent!.data.permissionMode).toBe('plan');
    expect(startEvent!.data.allowedTools).toContain('Read');
    expect(startEvent!.data.allowedTools).not.toContain('Bash');
  });

  it('returns different result shapes based on prompt', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    const reviewResult = await launcher('review PR #42', {
      label: 'reviewer',
      phase: 'review',
    });
    expect((reviewResult.data as any).review).toBeDefined();

    const researchResult = await launcher('research this topic', {
      label: 'researcher',
      phase: 'research',
    });
    expect((researchResult.data as any).summary).toBeDefined();

    const planResult = await launcher('plan this feature', {
      label: 'planner',
      phase: 'plan',
    });
    expect((planResult.data as any).plan).toBeDefined();
  });

  it('uses per-run bridgeMode from resolvedConfig to select bridge adapter', async () => {
    const store = createRunStore(root);
    // Create launcher with NO global bridgeMode — defaults to local adapter
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    // Run with per-run bridgeMode='fake' — should use FakeBridgeAdapter
    const result = await launcher('review this code', {
      label: 'bridge-test',
      phase: 'review',
      resolvedAgentConfig: {
        agentId: 'bridge-test',
        source: 'openslack-registry',
        bridgeMode: 'fake',
      },
    });

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();

    // Verify bridge_lifecycle_complete event is present (proves bridge adapter was used)
    const run = store.listRuns()[0];
    const { readTranscript } = await import('../transcript.js');
    const transcript = readTranscript(run.runId, root);

    const lifecycleEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'bridge_lifecycle_complete',
    );
    expect(lifecycleEvent).toBeDefined();
    expect((lifecycleEvent!.data as Record<string, unknown>).status).toBe('completed');
  });

  it('does not emit bridge_lifecycle_complete for local adapter runs', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir: root });

    // No bridgeMode — uses default LocalExecutionAdapter
    await launcher('review this code', {
      label: 'local-test',
      phase: 'review',
      resolvedAgentConfig: {
        agentId: 'local-test',
        source: 'test',
      },
    });

    const run = store.listRuns()[0];
    const { readTranscript } = await import('../transcript.js');
    const transcript = readTranscript(run.runId, root);

    const lifecycleEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'bridge_lifecycle_complete',
    );
    expect(lifecycleEvent).toBeUndefined();
  });
});
