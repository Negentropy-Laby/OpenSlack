import { Command } from 'commander';
import { validateWorkspace, buildIndex } from '@openslack/workspace-engine';

export function workspaceCommands(): Command {
  const cmd = new Command('workspace').description('Workspace management commands');

  cmd
    .command('validate')
    .description('Validate the OpenSlack workspace')
    .option('-r, --root <path>', 'Workspace root path')
    .action((options) => {
      const result = validateWorkspace(options.root || process.cwd());
      if (result.valid) {
        console.log('PASS: Workspace is valid');
        process.exit(0);
      } else {
        console.error('FAIL: Workspace validation failed');
        for (const err of result.errors) {
          console.error(`  - [${err.severity}] ${err.message}`);
          if (err.path) console.error(`    at: ${err.path}`);
        }
        process.exit(1);
      }
    });

  cmd
    .command('index')
    .description('Rebuild the workspace index from plain text state')
    .action(() => {
      console.log('Building workspace index...');
      const index = buildIndex();
      console.log(`Tasks: ${index.tasks.length} (${Object.entries(index.taskCounts).map(([k, v]) => `${k}: ${v}`).join(', ')})`);
      console.log(`Evolutions: ${index.evolutions.length}`);
      console.log(`Agents: ${index.agents.length}`);
      console.log('Index written to .openslack/index.json');
    });

  cmd
    .command('status')
    .description('Show workspace index summary')
    .action(() => {
      const index = buildIndex();
      console.log(`Workspace: openslack-self`);
      console.log(`Indexed: ${index.indexedAt}`);
      console.log(`\nTasks:`);
      for (const [category, count] of Object.entries(index.taskCounts)) {
        console.log(`  ${category}: ${count}`);
      }
      console.log(`  total: ${index.tasks.length}`);
      console.log(`\nEvolutions: ${index.evolutions.length}`);
      for (const ev of index.evolutions) {
        console.log(`  [${ev.id}] ${ev.status}: ${ev.title}`);
      }
      console.log(`\nAgents: ${index.agents.length}`);
      for (const a of index.agents) {
        console.log(`  ${a.agentId} (${a.status}): ${a.displayName} [${a.department}]`);
      }
    });

  return cmd;
}
