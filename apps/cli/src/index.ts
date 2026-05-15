#!/usr/bin/env node
import { Command } from 'commander';
import { workspaceCommands } from './commands/workspace.js';
import { selfCommands } from './commands/self.js';
import { reviewCommands } from './commands/review.js';
import { monitorCommands } from './commands/monitor.js';
import { agentCommands } from './commands/agent.js';
import { syncCommands } from './commands/sync.js';
import { taskCommands } from './commands/task.js';

const program = new Command();

program
  .name('openslack')
  .description('OpenSlack — Agent Company OS CLI')
  .version('0.1.0');

program.addCommand(workspaceCommands());
program.addCommand(selfCommands());
program.addCommand(reviewCommands());
program.addCommand(monitorCommands());
program.addCommand(agentCommands());
program.addCommand(syncCommands());
program.addCommand(taskCommands());

program.parse(process.argv);
