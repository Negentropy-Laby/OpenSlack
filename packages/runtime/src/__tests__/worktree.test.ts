import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => Buffer.from('')),
  execSync: vi.fn(() => ''),
}));

vi.mock('node:fs', () => ({
  rmSync: vi.fn(),
}));

import { createWorktree, cleanupWorktree } from '../worktree.js';
import { execFileSync } from 'node:child_process';

const mockedExecFileSync = execFileSync as unknown as ReturnType<typeof vi.fn>;

/** Return all execFileSync calls that invoke git worktree (not rev-parse from findRepoRoot). */
function worktreeCalls() {
  return mockedExecFileSync.mock.calls.filter((call) => call[1]?.includes?.('worktree'));
}

describe('assertSafeSegment (via createWorktree)', () => {
  beforeEach(() => {
    mockedExecFileSync.mockClear();
  });

  it('rejects agentId with shell metacharacters', () => {
    expect(() => createWorktree('task-1', 'agent;rm -rf /', 'run-1')).toThrow(/Invalid agentId/);
    expect(worktreeCalls()).toHaveLength(0);
  });

  it('rejects taskId with shell metacharacters', () => {
    expect(() => createWorktree('task$(whoami)', 'agent-1', 'run-1')).toThrow(/Invalid taskId/);
    expect(worktreeCalls()).toHaveLength(0);
  });

  it('rejects runId with shell metacharacters', () => {
    expect(() => createWorktree('task-1', 'agent-1', 'run`cmd`')).toThrow(/Invalid runId/);
    expect(worktreeCalls()).toHaveLength(0);
  });

  it('rejects path traversal in agentId', () => {
    expect(() => createWorktree('task-1', '../etc/passwd', 'run-1')).toThrow(
      /Invalid agentId.*path traversal/,
    );
    expect(worktreeCalls()).toHaveLength(0);
  });

  it('rejects path traversal in taskId', () => {
    expect(() => createWorktree('../../etc', 'agent-1', 'run-1')).toThrow(
      /Invalid taskId.*path traversal/,
    );
    expect(worktreeCalls()).toHaveLength(0);
  });

  it('rejects empty agentId', () => {
    expect(() => createWorktree('task-1', '', 'run-1')).toThrow(/Invalid agentId.*non-empty/);
    expect(worktreeCalls()).toHaveLength(0);
  });

  it('rejects newline in runId', () => {
    expect(() => createWorktree('task-1', 'agent-1', 'run\n1')).toThrow(/Invalid runId/);
    expect(worktreeCalls()).toHaveLength(0);
  });

  it('passes valid IDs through to git worktree add with argument array', () => {
    const result = createWorktree('task-123', 'my_agent', 'run-456');
    expect(result.branchName).toBe('agent/my_agent/task-123/run-456');
    expect(result.success).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining([
        'worktree',
        'add',
        '-b',
        'agent/my_agent/task-123/run-456',
        expect.any(String),
        'HEAD',
      ]),
      expect.any(Object),
    );
  });

  it('does not fall back to process cwd when explicit rootDir is not a git repo', () => {
    mockedExecFileSync.mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });

    const result = createWorktree('task-123', 'my_agent', 'run-456', '/tmp/not-a-repo');

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain('Provided rootDir is not a git repository');
    expect(worktreeCalls()).toHaveLength(0);
  });
});

describe('assertSafeSegment (via cleanupWorktree)', () => {
  beforeEach(() => {
    mockedExecFileSync.mockClear();
  });

  it('rejects runId with shell metacharacters', () => {
    expect(() => cleanupWorktree('run;rm -rf /')).toThrow(/Invalid runId/);
    expect(worktreeCalls()).toHaveLength(0);
  });

  it('rejects path traversal in runId', () => {
    expect(() => cleanupWorktree('../etc')).toThrow(/Invalid runId/);
    expect(worktreeCalls()).toHaveLength(0);
  });

  it('does not fall back to process cwd when explicit cleanup rootDir is not a git repo', () => {
    mockedExecFileSync.mockImplementationOnce(() => {
      throw new Error('not a git repo');
    });

    expect(cleanupWorktree('run-456', '/tmp/not-a-repo')).toBe(false);
    expect(worktreeCalls()).toHaveLength(0);
  });

  it('deletes local agent branches that belong to the cleaned run', () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args[0] === 'for-each-ref') {
        return Buffer.from('agent/my_agent/task-123/run-456\nagent/other/task/run-999\n');
      }
      return Buffer.from('');
    });

    expect(cleanupWorktree('run-456')).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'agent/my_agent/task-123/run-456'],
      expect.any(Object),
    );
  });

  it('does not delete branches that do not match the canonical agent format', () => {
    mockedExecFileSync.mockImplementation((_cmd, args) => {
      if (Array.isArray(args) && args[0] === 'for-each-ref') {
        // Mix of canonical and non-canonical branch names ending in /run-456
        return Buffer.from(
          // Too few segments: agent/runId (no agentId or taskId)
          'agent/run-456\n' +
            // Canonical 4-segment: agent/<agentId>/<taskId>/<runId> — SHOULD be deleted
            'agent/my_agent/task-123/run-456\n' +
            // Too many segments: agent/a/b/c/run-456
            'agent/a/b/c/run-456\n',
        );
      }
      return Buffer.from('');
    });

    expect(cleanupWorktree('run-456')).toBe(true);
    // Only the canonical 4-segment branch should be deleted
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'agent/my_agent/task-123/run-456'],
      expect.any(Object),
    );
    // Should NOT have been called with non-canonical branches
    expect(mockedExecFileSync).not.toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'agent/run-456'],
      expect.any(Object),
    );
    expect(mockedExecFileSync).not.toHaveBeenCalledWith(
      'git',
      ['branch', '-D', 'agent/a/b/c/run-456'],
      expect.any(Object),
    );
  });
});
