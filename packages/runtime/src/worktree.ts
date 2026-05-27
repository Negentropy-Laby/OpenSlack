import { execFileSync, execSync } from 'node:child_process';
import { join, resolve } from 'node:path';

function findRepoRoot(): string {
  try {
    const cwd = process.cwd();
    let dir = cwd;
    for (let i = 0; i < 10; i++) {
      try { execSync('git rev-parse --git-dir', { cwd: dir, stdio: 'pipe' }); return dir; } catch { /* not here */ }
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* ignore */ }
  return process.cwd();
}

export interface WorktreeResult {
  success: boolean;
  worktreePath: string;
  branchName: string;
  errors: string[];
}

/**
 * Validate that a string is safe to use as a git ref or path segment.
 * Rejects empty strings, path traversal, and shell metacharacters.
 */
function assertSafeSegment(value: string, label: string): void {
  if (!value || value.length === 0) {
    throw new Error(`Invalid ${label}: must be non-empty`);
  }
  if (/[;&|`$(){}!#\\<>"'\n\r\t\0]/.test(value)) {
    throw new Error(`Invalid ${label}: contains disallowed characters`);
  }
  if (value.includes('..')) {
    throw new Error(`Invalid ${label}: path traversal detected`);
  }
}

export function createWorktree(taskId: string, agentId: string, runId: string): WorktreeResult {
  const root = findRepoRoot();
  const errors: string[] = [];

  // Validate all user-controlled inputs before any shell execution.
  assertSafeSegment(agentId, 'agentId');
  assertSafeSegment(taskId, 'taskId');
  assertSafeSegment(runId, 'runId');

  const branchName = `agent/${agentId}/${taskId}/${runId}`;
  const worktreeRoot = join(root, '.worktrees', runId);
  const worktreeAbs = resolve(worktreeRoot);

  try {
    // Create branch AND worktree in one operation — never switch main worktree.
    // Uses execFileSync with argument array to prevent shell injection.
    execFileSync('git', ['worktree', 'add', '-b', branchName, worktreeAbs, 'HEAD'], {
      cwd: root,
      stdio: 'pipe',
    });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() || '';
    if (stderr.includes('already exists') || stderr.includes('already checked out')) {
      // Branch already exists — reuse it without -b
      try {
        execFileSync('git', ['worktree', 'add', worktreeAbs, branchName], {
          cwd: root,
          stdio: 'pipe',
        });
      } catch (e2) {
        errors.push(`Failed to add existing worktree: ${(e2 as Error).message}`);
        return { success: false, worktreePath: '', branchName, errors };
      }
    } else {
      errors.push(`Failed to create worktree: ${stderr.slice(0, 300)}`);
      return { success: false, worktreePath: '', branchName, errors };
    }
  }

  return { success: true, worktreePath: worktreeAbs, branchName, errors };
}

export interface DirtyStatus {
  status: 'clean' | 'dirty' | 'error';
  reason?: string;
}

export function checkDirty(worktreePath: string): DirtyStatus {
  try {
    const result = execFileSync('git', ['status', '--porcelain'], { cwd: worktreePath, stdio: 'pipe' });
    const dirty = result.toString().trim().length > 0;
    return dirty
      ? { status: 'dirty', reason: 'Uncommitted changes detected' }
      : { status: 'clean' };
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === 'ENOENT' || (e as Error).message.includes('not a git repository')) {
      return { status: 'error', reason: 'Path does not exist or is not a git repository' };
    }
    return { status: 'error', reason: (e as Error).message };
  }
}

export function cleanupWorktree(runId: string): boolean {
  const root = findRepoRoot();

  // Validate user-controlled input.
  assertSafeSegment(runId, 'runId');

  const worktreePath = join(root, '.worktrees', runId);
  try {
    execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: root, stdio: 'pipe' });
    return true;
  } catch {
    try {
      execFileSync('rm', ['-rf', worktreePath], { cwd: root, stdio: 'pipe' });
      execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'pipe' });
    } catch {
      // Last resort cleanup
    }
    return false;
  }
}
