import { Command } from 'commander';
import { proposeWorkspacePR } from '@openslack/git-sync';

export function syncCommands(): Command {
  const cmd = new Command('sync').description('Synchronization commands');

  cmd
    .command('propose')
    .description('Propose a workspace PR from local changes')
    .requiredOption('--agent-id <id>', 'Agent ID')
    .requiredOption('--task-id <id>', 'Task ID')
    .requiredOption('--run-id <id>', 'Run ID (e.g. RUN-2026-000001)')
    .requiredOption('--paths <paths>', 'Comma-separated changed paths')
    .option('--description <text>', 'PR description')
    .action((options) => {
      const paths = options.paths.split(',').map((p: string) => p.trim());
      const result = proposeWorkspacePR({
        agentId: options.agentId,
        taskId: options.taskId,
        runId: options.runId,
        changedPaths: paths,
        description: options.description,
      });

      if (!result.success) {
        console.error('PR proposal failed:');
        for (const err of result.errors) console.error(`  - ${err}`);
        process.exit(1);
      }

      console.log(`Branch: ${result.branchName}`);
      console.log(`Risk zone: ${result.riskZone.toUpperCase()}`);
      console.log(`\n--- PR Body ---`);
      console.log(result.prBody);
      console.log(`--- End PR Body ---`);
      console.log(`\nTo submit: create a branch "${result.branchName}" and push this PR body.`);
    });

  return cmd;
}
