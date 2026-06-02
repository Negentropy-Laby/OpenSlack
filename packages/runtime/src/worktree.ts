import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

function findRepoRoot(): string {
  try {
    const cwd = process.cwd();
    let dir = cwd;
    for (let i = 0; i < 10; i++) {
      try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd: dir, stdio: 'pipe' }); return dir; } catch { /* not here */ }
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

function resolveRepoRoot(rootDir?: string): { root: string } | { error: string } {
  if (!rootDir) return { root: findRepoRoot() };

  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: rootDir, stdio: 'pipe' });
    return { root: rootDir };
  } catch {
    return { error: `Provided rootDir is not a git repository: ${rootDir}` };
  }
}

function deleteBranchesForRun(root: string, runId: string): void {
  let branches: string[] = [];
  try {
    // Escape runId for use in regex (assertSafeSegment already validated it).
    const escaped = runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match the canonical agent branch format: agent/<agentId>/<taskId>/<runId>
    const branchPattern = new RegExp(`^agent/[^/]+/[^/]+/${escaped}$`);

    const raw = execFileSync(
      'git',
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/agent'],
      { cwd: root, stdio: 'pipe' },
    ).toString();
    branches = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => branchPattern.test(line));
  } catch {
    return;
  }

  for (const branch of branches) {
    try {
      execFileSync('git', ['branch', '-D', branch], { cwd: root, stdio: 'pipe' });
    } catch {
      // Best-effort branch cleanup. Worktree cleanup should not fail because a
      // local branch was already removed or is still protected by Git.
    }
  }
}

export function createWorktree(taskId: string, agentId: string, runId: string, rootDir?: string): WorktreeResult {
  // Validate all user-controlled inputs before any shell execution.
  assertSafeSegment(agentId, 'agentId');
  assertSafeSegment(taskId, 'taskId');
  assertSafeSegment(runId, 'runId');

  const branchName = `agent/${agentId}/${taskId}/${runId}`;
  const resolvedRoot = resolveRepoRoot(rootDir);
  if ('error' in resolvedRoot) {
    return { success: false, worktreePath: '', branchName, errors: [resolvedRoot.error] };
  }

  const root = resolvedRoot.root;
  const errors: string[] = [];
  const worktreeRoot = join(root, '.worktrees', runId);
  const worktreeAbs = resolve(worktreeRoot);

  try {
    // Create branch AND worktree in one operation — never switch main worktree.
    // Uses execFileSync with argument array to prevent shell injection.
    // Uses HEAD (current commit) as the base so the branch starts from the
    // same point without touching the main worktree's HEAD ref.
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

export function cleanupWorktree(runId: string, rootDir?: string): boolean {
  // Validate user-controlled input.
  assertSafeSegment(runId, 'runId');

  const resolvedRoot = resolveRepoRoot(rootDir);
  if ('error' in resolvedRoot) return false;

  const root = resolvedRoot.root;
  const worktreePath = join(root, '.worktrees', runId);
  try {
    execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], { cwd: root, stdio: 'pipe' });
    deleteBranchesForRun(root, runId);
    return true;
  } catch {
    try {
      rmSync(worktreePath, { recursive: true, force: true });
      execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'pipe' });
    } catch {
      // Last resort cleanup
    }
    deleteBranchesForRun(root, runId);
    return false;
  }
}
