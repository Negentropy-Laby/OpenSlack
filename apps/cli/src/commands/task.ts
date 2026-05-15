import { Command } from 'commander';
import { createWorktree, cleanupWorktree, checkDirty } from '@openslack/git-sync';

export function taskCommands(): Command {
  const cmd = new Command('task').description('Task management commands');

  cmd
    .command('checkout')
    .description('Create an isolated worktree for a task')
    .requiredOption('--task-id <id>', 'Task ID')
    .requiredOption('--agent-id <id>', 'Agent ID')
    .requiredOption('--run-id <id>', 'Run ID')
    .action((options) => {
      console.log(`Creating worktree for task ${options.taskId}...`);
      const result = createWorktree(options.taskId, options.agentId, options.runId);
      if (result.success) {
        console.log(`Worktree created: ${result.worktreePath}`);
        console.log(`Branch: ${result.branchName}`);
        console.log(`\nTo work in isolation: cd "${result.worktreePath}"`);
      } else {
        console.error('Failed to create worktree:');
        for (const err of result.errors) console.error(`  - ${err}`);
        process.exit(1);
      }
    });

  cmd
    .command('cleanup')
    .description('Remove a task worktree')
    .requiredOption('--run-id <id>', 'Run ID of the worktree to clean up')
    .action((options) => {
      console.log(`Cleaning up worktree for run ${options.runId}...`);
      const ok = cleanupWorktree(options.runId);
      if (ok) {
        console.log('Worktree removed successfully.');
      } else {
        console.error('Failed to remove worktree. Manual cleanup may be needed.');
        console.error(`  rm -rf .worktrees/${options.runId}`);
        console.error('  git worktree prune');
        process.exit(1);
      }
    });

  cmd
    .command('status')
    .description('Check if worktree has uncommitted changes')
    .requiredOption('--worktree <path>', 'Path to worktree')
    .action((options) => {
      const dirty = checkDirty(options.worktree);
      if (dirty) {
        console.log('DIRTY: Uncommitted changes detected.');
      } else {
        console.log('CLEAN: No uncommitted changes.');
      }
    });

  return cmd;
}
