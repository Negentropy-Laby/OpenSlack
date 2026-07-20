import { execSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from './setup-report.js';

export interface WorktreeRepairItem {
  path: string;
  issue: 'orphaned_directory';
  planned: boolean;
  fixed: boolean;
  detail: string;
}

export interface WorktreeRepairResult {
  dryRun: boolean;
  items: WorktreeRepairItem[];
}

function registeredWorktreePaths(root: string): Set<string> {
  try {
    const raw = execSync('git worktree list --porcelain', {
      cwd: root,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    const paths = raw
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) =>
        line
          .replace(/^worktree\s+/, '')
          .trim()
          .replace(/\\/g, '/'),
      );
    return new Set(paths);
  } catch {
    return new Set();
  }
}

export function repairWorktrees(
  options: { root?: string; dryRun?: boolean } = {},
): WorktreeRepairResult {
  const root = options.root ?? findRepoRoot();
  const dryRun = options.dryRun ?? true;
  const worktreesDir = join(root, '.worktrees');
  const items: WorktreeRepairItem[] = [];

  if (!existsSync(worktreesDir)) return { dryRun, items };

  const registered = registeredWorktreePaths(root);
  for (const entry of readdirSync(worktreesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(worktreesDir, entry.name);
    const normalized = path.replace(/\\/g, '/');
    if (registered.has(normalized)) continue;

    if (!dryRun) {
      rmSync(path, { recursive: true, force: true });
    }

    items.push({
      path,
      issue: 'orphaned_directory',
      planned: dryRun,
      fixed: !dryRun,
      detail: dryRun
        ? 'Would remove orphaned worktree directory'
        : 'Removed orphaned worktree directory',
    });
  }

  return { dryRun, items };
}

export function renderWorktreeRepair(result: WorktreeRepairResult): string {
  const lines: string[] = [];
  lines.push(`Worktree Repair (${result.dryRun ? 'dry-run' : 'apply'})`);
  lines.push('='.repeat(24));

  if (result.items.length === 0) {
    lines.push('No orphaned worktree directories found.');
    return lines.join('\n');
  }

  for (const item of result.items) {
    lines.push(`[${item.fixed ? 'FIXED' : 'PLAN'}] ${item.path}`);
    lines.push(`  ${item.detail}`);
  }

  if (result.dryRun) {
    lines.push('');
    lines.push('Run with --apply to mutate local worktree state.');
  }

  return lines.join('\n');
}
