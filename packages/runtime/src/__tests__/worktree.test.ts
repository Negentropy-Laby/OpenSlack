import { describe, it, expect } from 'vitest';
import { createWorktree, cleanupWorktree } from '../worktree.js';

describe('assertSafeSegment (via createWorktree)', () => {
  it('rejects agentId with shell metacharacters', () => {
    expect(() => createWorktree('task-1', 'agent;rm -rf /', 'run-1')).toThrow(/Invalid agentId/);
  });

  it('rejects taskId with shell metacharacters', () => {
    expect(() => createWorktree('task$(whoami)', 'agent-1', 'run-1')).toThrow(/Invalid taskId/);
  });

  it('rejects runId with shell metacharacters', () => {
    expect(() => createWorktree('task-1', 'agent-1', 'run`cmd`')).toThrow(/Invalid runId/);
  });

  it('rejects path traversal in agentId', () => {
    expect(() => createWorktree('task-1', '../etc/passwd', 'run-1')).toThrow(/Invalid agentId.*path traversal/);
  });

  it('rejects path traversal in taskId', () => {
    expect(() => createWorktree('../../etc', 'agent-1', 'run-1')).toThrow(/Invalid taskId.*path traversal/);
  });

  it('rejects empty agentId', () => {
    expect(() => createWorktree('task-1', '', 'run-1')).toThrow(/Invalid agentId.*non-empty/);
  });

  it('rejects newline in runId', () => {
    expect(() => createWorktree('task-1', 'agent-1', 'run\n1')).toThrow(/Invalid runId/);
  });

  it('allows valid IDs with hyphens and underscores', () => {
    // Should NOT throw on validation — may fail at git worktree add but that's OK.
    // We just verify it doesn't throw an assertion error.
    try {
      createWorktree('task-123', 'my_agent', 'run-456');
    } catch (e) {
      expect((e as Error).message).not.toMatch(/Invalid/);
    }
  });
});

describe('assertSafeSegment (via cleanupWorktree)', () => {
  it('rejects runId with shell metacharacters', () => {
    expect(() => cleanupWorktree('run;rm -rf /')).toThrow(/Invalid runId/);
  });

  it('rejects path traversal in runId', () => {
    expect(() => cleanupWorktree('../etc')).toThrow(/Invalid runId/);
  });
});
