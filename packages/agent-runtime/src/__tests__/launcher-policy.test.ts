import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOpenSlackAgentLauncher } from '../launcher.js';
import { createRunStore } from '../run-store.js';
import { readTranscript } from '../transcript.js';
import { AgentExecutionFailedError } from '../types.js';
import type { AgentExecutionAdapter } from '../adapter.js';

const worktree = vi.hoisted(() => ({
  create: vi.fn(), dirty: vi.fn(), cleanup: vi.fn(),
}));
vi.mock('@openslack/runtime', () => ({
  createWorktree: worktree.create,
  checkDirty: worktree.dirty,
  cleanupWorktree: worktree.cleanup,
}));

describe('trusted provider lifecycle policy', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'launcher-policy-'));
    const path = join(root, 'isolated-worktree');
    mkdirSync(path);
    worktree.create.mockReset().mockReturnValue({ success: true, worktreePath: path, branchName: 'agent/fixture' });
    worktree.dirty.mockReset().mockReturnValue({ status: 'clean' });
    worktree.cleanup.mockReset();
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it.each(['complete', 'fail'] as const)('preserves the original %s outcome if an advisory preservation receipt fails', async outcome => {
    const store = createRunStore(root);
    const update = store.updateRun;
    const injected = new Error('advisory handoff write failed');
    vi.spyOn(store, 'updateRun').mockImplementation((runId, patch) => {
      if (patch.worktreeHandoff) throw injected;
      return update(runId, patch);
    });
    const original = new Error('original adapter failure');
    const adapter: AgentExecutionAdapter = {
      adapterId: 'external-fixture',
      async execute<T>() {
        if (outcome === 'fail') throw original;
        return { data: { accepted: true } as T };
      },
    };
    const acceptance = vi.fn(async () => {});
    const launcher = createOpenSlackAgentLauncher({
      rootDir: root, runStore: store, adapter,
      adapterExecutionPolicy: { requiresHostAcceptance: true, worktreeForFileWrites: true, preserveWorktree: true },
      harnessResultAcceptance: acceptance,
    });
    const result = await launcher('fixture', { label: 'external', phase: 'execute', isolation: 'worktree' })
      .then(value => ({ value }), error => ({ error }));
    const state = store.listRuns()[0]!;
    if (outcome === 'complete') {
      expect(result).toMatchObject({ value: { data: { accepted: true }, runId: state.runId } });
      expect(state.status).toBe('completed');
      expect(acceptance).toHaveBeenCalledOnce();
    } else {
      expect(result).toHaveProperty('error');
      const failure = 'error' in result ? result.error : undefined;
      expect(failure).toBeInstanceOf(AgentExecutionFailedError);
      expect(failure).toHaveProperty('cause', original);
      expect(failure).not.toBe(injected);
      expect(state.status).toBe('failed');
      expect(acceptance).not.toHaveBeenCalled();
    }
    expect(readTranscript(state.runId, root)).toContainEqual(expect.objectContaining({
      type: 'progress', data: { step: 'worktree_preservation_receipt_unconfirmed' },
    }));
    expect(worktree.dirty).not.toHaveBeenCalled();
    expect(worktree.cleanup).not.toHaveBeenCalled();
  });

  it('applies acceptance and preservation by trusted policy, not by provider spelling', async () => {
    const store = createRunStore(root);
    const acceptance = vi.fn(async () => {});
    const launcher = createOpenSlackAgentLauncher({
      rootDir: root, runStore: store,
      adapter: { adapterId: 'renamed-external', async execute<T>() { return { data: { ok: true } as T }; } },
      adapterExecutionPolicy: { requiresHostAcceptance: true, worktreeForFileWrites: true, preserveWorktree: true },
      harnessResultAcceptance: acceptance,
    });
    const result = await launcher('fixture', { label: 'external', phase: 'execute',
      resolvedAgentConfig: { agentId: 'external', source: 'fixture', runtimeProvider: 'another-external-provider',
        permissionMode: 'acceptEdits', tools: ['Read', 'Write', 'Edit'] } });
    expect(acceptance).toHaveBeenCalledOnce();
    expect(worktree.create).toHaveBeenCalledOnce();
    expect(store.getRun(result.runId)?.worktreeHandoff).toMatchObject({ worktreePath: join(root, 'isolated-worktree') });
    expect(worktree.dirty).not.toHaveBeenCalled();
    expect(worktree.cleanup).not.toHaveBeenCalled();
  });

  it('rejects a provider requiring host acceptance before creating a worktree or executing it', async () => {
    const store = createRunStore(root);
    const execute = vi.fn();
    const launcher = createOpenSlackAgentLauncher({ rootDir: root, runStore: store,
      adapter: { adapterId: 'external-fixture', execute },
      adapterExecutionPolicy: { requiresHostAcceptance: true, worktreeForFileWrites: true, preserveWorktree: true },
    });
    await expect(launcher('fixture', { label: 'external', phase: 'execute', isolation: 'worktree' }))
      .rejects.toMatchObject({ code: 'RUNTIME_MISCONFIGURED' });
    expect(worktree.create).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
