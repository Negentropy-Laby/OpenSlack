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

  // Generate unique branch name
  const branchName = `agent/${agentId}/${taskId}/${runId}`;
  // Worktree root is within the repo's .worktrees/
  const worktreeRoot = join(root, '.worktrees', runId);
  const worktreeAbs = resolve(worktreeRoot);

  try {
    // Create branch starting from HEAD
    execSync(`git checkout -b "${branchName}"`, { cwd: root, stdio: 'pipe' });
  } catch {
    try {
      // Branch may already exist — use it
      execSync(`git checkout "${branchName}"`, { cwd: root, stdio: 'pipe' });
    } catch {
      errors.push(`Failed to create or switch to branch: ${branchName}`);
      return { success: false, worktreePath: '', branchName, errors };
    }
  }

  try {
    execSync(`git worktree add "${worktreeAbs}" "${branchName}"`, { cwd: root, stdio: 'pipe' });
  } catch {
    errors.push(`Failed to add worktree at: ${worktreeAbs}`);
    return { success: false, worktreePath: '', branchName, errors };
  }

  return { success: true, worktreePath: worktreeAbs, branchName, errors };
}

export function checkDirty(worktreePath: string): boolean {
  try {
    const result = execSync('git status --porcelain', { cwd: worktreePath, stdio: 'pipe' });
    return result.toString().trim().length > 0;
  } catch {
    // Non-existent path or not a git directory — treat as dirty for safety
    return true;
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
