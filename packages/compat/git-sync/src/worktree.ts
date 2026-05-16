import { execSync } from 'node:child_process';
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

export function createWorktree(taskId: string, agentId: string, runId: string): WorktreeResult {
  const root = findRepoRoot();
  const errors: string[] = [];

  const branchName = `agent/${agentId}/${taskId}/${runId}`;
  const worktreeRoot = join(root, '.worktrees', runId);
  const worktreeAbs = resolve(worktreeRoot);

  try {
    // Create branch AND worktree in one operation — never switch main worktree.
    // Uses HEAD (current commit) as the base so the branch starts from the
    // same point without touching the main worktree's HEAD ref.
    execSync(`git worktree add -b "${branchName}" "${worktreeAbs}" HEAD`, {
      cwd: root,
      stdio: 'pipe',
    });
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() || '';
    if (stderr.includes('already exists') || stderr.includes('already checked out')) {
      // Branch already exists — reuse it without -b
      try {
        execSync(`git worktree add "${worktreeAbs}" "${branchName}"`, {
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
    const result = execSync('git status --porcelain', { cwd: worktreePath, stdio: 'pipe' });
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
  const worktreePath = join(root, '.worktrees', runId);
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { cwd: root, stdio: 'pipe' });
    return true;
  } catch {
    try {
      execSync(`rm -rf "${worktreePath}"`, { cwd: root, stdio: 'pipe' });
      execSync(`git worktree prune`, { cwd: root, stdio: 'pipe' });
    } catch {
      // Last resort cleanup
    }
    return false;
  }
}
