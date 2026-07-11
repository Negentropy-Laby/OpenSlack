import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We mock @openslack/runtime to control checkDirty/cleanupWorktree behavior
// without needing real git worktrees in CI.
const mockCheckDirty = vi.fn();
const mockCleanupWorktree = vi.fn();
const mockCreateWorktree = vi.fn();

vi.mock('@openslack/runtime', () => ({
  createWorktree: (...args: unknown[]) => mockCreateWorktree(...args),
  checkDirty: (...args: unknown[]) => mockCheckDirty(...args),
  cleanupWorktree: (...args: unknown[]) => mockCleanupWorktree(...args),
}));

import { createOpenSlackAgentLauncher, createRunStore, LocalExecutionAdapter } from '../index.js';
import { readTranscript } from '../transcript.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agent-dirty-test-'));
}

describe('Dirty-state-aware worktree cleanup', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
    mockCheckDirty.mockReset();
    mockCleanupWorktree.mockReset();
    mockCreateWorktree.mockReset();

    // Default: createWorktree succeeds
    mockCreateWorktree.mockReturnValue({
      success: true,
      worktreePath: join(root, '.worktrees', 'fake-wt'),
      branchName: 'agent/test/run-1/RUN-FAKE',
      errors: [],
    });

    // Default: clean worktree
    mockCheckDirty.mockReturnValue({ status: 'clean' });

    // Default: cleanup succeeds
    mockCleanupWorktree.mockReturnValue(true);
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('cleans up clean worktree', async () => {
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new LocalExecutionAdapter(),
    });

    await launcher('implement feature X', {
      label: 'implementer',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'code-implementer',
        source: 'claude-project',
        isolation: 'worktree',
      },
    });

    // checkDirty should have been called
    expect(mockCheckDirty).toHaveBeenCalledTimes(1);

    // cleanupWorktree should have been called because worktree is clean
    expect(mockCleanupWorktree).toHaveBeenCalledTimes(1);

    // Run should complete successfully
    const runs = store.listRuns();
    expect(runs[0].status).toBe('completed');

    // Clean worktree should NOT have a handoff
    expect(runs[0].worktreeHandoff).toBeUndefined();
  });

  it('preserves dirty worktree and records progress event', async () => {
    mockCheckDirty.mockReturnValue({
      status: 'dirty',
      reason: 'Uncommitted changes detected',
    });

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new LocalExecutionAdapter(),
    });

    await launcher('implement feature X', {
      label: 'implementer',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'code-implementer',
        source: 'claude-project',
        isolation: 'worktree',
      },
    });

    // checkDirty should have been called
    expect(mockCheckDirty).toHaveBeenCalledTimes(1);

    // cleanupWorktree should NOT have been called — worktree is preserved
    expect(mockCleanupWorktree).not.toHaveBeenCalled();

    // Transcript should contain worktree_dirty_preserved event
    const run = store.listRuns()[0];
    const transcript = readTranscript(run.runId, root);
    const preservedEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'worktree_dirty_preserved',
    );

    expect(preservedEvent).toBeDefined();
    expect((preservedEvent!.data as Record<string, unknown>).worktreePath).toBeDefined();
    // branchName should come from createWorktree result, not reconstructed
    expect((preservedEvent!.data as Record<string, unknown>).branchName).toBe('agent/test/run-1/RUN-FAKE');
    expect((preservedEvent!.data as Record<string, unknown>).reason).toContain('Uncommitted changes');

    // Run state should have worktreeHandoff for recovery
    const refreshedRun = store.getRun(run.runId);
    expect(refreshedRun).toBeDefined();
    expect(refreshedRun!.worktreeHandoff).toBeDefined();
    expect(refreshedRun!.worktreeHandoff!.worktreePath).toBeDefined();
    expect(refreshedRun!.worktreeHandoff!.branchName).toBeDefined();
    expect(refreshedRun!.worktreeHandoff!.reason).toContain('Uncommitted changes');
    expect(refreshedRun!.worktreeHandoff!.preservedAt).toBeTruthy();
  });

  it('attempts cleanup when dirty check returns error (fail-closed)', async () => {
    mockCheckDirty.mockReturnValue({
      status: 'error',
      reason: 'Path does not exist or is not a git repository',
    });

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new LocalExecutionAdapter(),
    });

    await launcher('implement feature X', {
      label: 'implementer',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'code-implementer',
        source: 'claude-project',
        isolation: 'worktree',
      },
    });

    // checkDirty should have been called
    expect(mockCheckDirty).toHaveBeenCalledTimes(1);

    // cleanupWorktree SHOULD have been called — fail-closed on error
    expect(mockCleanupWorktree).toHaveBeenCalledTimes(1);

    // Transcript should contain worktree_dirty_check_failed event
    const run = store.listRuns()[0];
    const transcript = readTranscript(run.runId, root);
    const failedCheckEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'worktree_dirty_check_failed',
    );

    expect(failedCheckEvent).toBeDefined();
    expect((failedCheckEvent!.data as Record<string, unknown>).reason).toBeDefined();
  });

  it('records cleanup_failed when cleanup throws', async () => {
    // checkDirty returns clean, but cleanupWorktree throws
    mockCheckDirty.mockReturnValue({ status: 'clean' });
    mockCleanupWorktree.mockImplementation(() => {
      throw new Error('worktree removal failed');
    });

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new LocalExecutionAdapter(),
    });

    // Should not throw — cleanup failure is logged, not propagated
    await launcher('implement feature X', {
      label: 'implementer',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'code-implementer',
        source: 'claude-project',
        isolation: 'worktree',
      },
    });

    // Run should still complete successfully (cleanup failure is non-fatal)
    const runs = store.listRuns();
    expect(runs[0].status).toBe('completed');

    // Transcript should contain worktree_cleanup_failed event
    const transcript = readTranscript(runs[0].runId, root);
    const cleanupFailedEvent = transcript.find(
      (e) => e.type === 'progress' && (e.data as Record<string, unknown>).step === 'worktree_cleanup_failed',
    );

    expect(cleanupFailedEvent).toBeDefined();
    expect((cleanupFailedEvent!.data as Record<string, unknown>).error).toContain('worktree removal failed');
  });

  it('does not check dirty state when no worktree was created', async () => {
    // No isolation configured → no worktree → no dirty check
    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      adapter: new LocalExecutionAdapter(),
    });

    await launcher('review this PR', {
      label: 'reviewer',
      phase: 'review',
      resolvedAgentConfig: {
        agentId: 'code-reviewer',
        source: 'claude-project',
        isolation: 'none',
      },
    });

    // Neither checkDirty nor cleanupWorktree should have been called
    expect(mockCheckDirty).not.toHaveBeenCalled();
    expect(mockCleanupWorktree).not.toHaveBeenCalled();
  });

  it('creates a worktree for write-capable Aby bridge runs', async () => {
    const worktreePath = join(root, '.worktrees', 'aby-wt');
    mkdirSync(worktreePath, { recursive: true });
    mockCreateWorktree.mockReturnValue({
      success: true,
      worktreePath,
      branchName: 'agent/aby/run-1/RUN-ABY',
      errors: [],
    });

    const bridgeScript = join(root, 'fake-bridge.mjs');
    writeFileSync(
      bridgeScript,
      [
        "import { stdin, stdout } from 'node:process';",
        "let buffer = '';",
        "stdin.setEncoding('utf8');",
        "function envelope(input, kind, payload) {",
        "  return JSON.stringify({ protocolVersion: input.protocolVersion, sessionId: input.sessionId, correlationId: input.correlationId, timestamp: new Date().toISOString(), kind, payload }) + '\\n';",
        "}",
        "stdin.on('data', chunk => {",
        "  buffer += chunk;",
        "  const lines = buffer.split('\\n');",
        "  buffer = lines.pop() ?? '';",
        "  for (const line of lines) {",
        "    if (!line.trim()) continue;",
        "    const input = JSON.parse(line);",
        "    if (input.kind === 'handshake_request') stdout.write(envelope(input, 'handshake_response', { accepted: true }));",
        "    if (input.kind === 'run_request') stdout.write(envelope(input, 'complete', { data: { cwd: process.cwd(), worktreePath: input.payload.worktreePath } }));",
        "  }",
        "});",
      ].join('\n'),
      'utf-8',
    );

    const store = createRunStore(root);
    const launcher = createOpenSlackAgentLauncher({
      runStore: store,
      rootDir: root,
      bridgeRuntimeResolver: {
        resolve: () => ({ command: process.execPath, args: [bridgeScript] }),
      },
    });

    const result = await launcher('write architecture notes', {
      label: 'aby',
      phase: 'execute',
      resolvedAgentConfig: {
        agentId: 'aby',
        source: 'openslack-registry',
        runtime: 'aby_assistant',
        bridgeMode: 'process',
        permissionMode: 'default',
      },
    });

    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
    expect(mockCheckDirty).toHaveBeenCalledTimes(1);
    expect(mockCleanupWorktree).toHaveBeenCalledTimes(1);
    expect((result.data as any).cwd).toBe(worktreePath);
    expect((result.data as any).worktreePath).toBe(worktreePath);
  });
});
