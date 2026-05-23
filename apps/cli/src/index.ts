#!/usr/bin/env node
import { Command } from 'commander';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspaceCommands } from './commands/workspace.js';
import { selfCommands } from './commands/self.js';
import { agentCommands } from './commands/agent.js';
import { taskCommands } from './commands/task.js';
import { githubCommands } from './commands/github.js';
import { operatorCommands } from './commands/operator.js';
import { prCommands } from './commands/pr.js';
import { setupCommands } from './commands/setup.js';
import { statusCommands } from './commands/status.js';
import { doctorCommands } from './commands/doctor.js';
import { governanceCommands } from './commands/governance.js';
import { chatCommands } from './commands/chat.js';

const program = new Command();

program
  .name('openslack')
  .description('OpenSlack — Agent Company OS CLI')
  .version('0.1.0');

// Top-level aliases (user-friendly shortcuts)
program
  .command('ask')
  .description('Ask OpenSlack to do something (natural language)')
  .argument('<query...>', 'What do you want to do?')
  .action(async (queryParts: string[]) => {
    const root = process.cwd();
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'apps', 'cli', 'src', 'index.ts'), 'operator', 'ask', ...queryParts], { cwd: root, stdio: 'inherit' });
    if (result.error) console.error('ask: failed to execute:', result.error.message);
  });

// Command groups
program.addCommand(workspaceCommands());
program.addCommand(selfCommands());
program.addCommand(agentCommands());
program.addCommand(taskCommands());
program.addCommand(githubCommands());
program.addCommand(prCommands());
program.addCommand(operatorCommands());
program.addCommand(statusCommands());
program.addCommand(doctorCommands());
program.addCommand(governanceCommands());
program.addCommand(setupCommands());
program.addCommand(chatCommands());

program.parse(process.argv);
