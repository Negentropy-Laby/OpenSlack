#!/usr/bin/env node
import { Command } from 'commander';
import { workspaceCommands } from './commands/workspace.js';
import { selfCommands } from './commands/self.js';
import { agentCommands } from './commands/agent.js';
import { taskCommands } from './commands/task.js';
import { githubCommands } from './commands/github.js';
import { operatorCommands } from './commands/operator.js';

const program = new Command();

program
  .name('openslack')
  .description('OpenSlack — Agent Company OS CLI')
  .version('0.1.0');

program.addCommand(workspaceCommands());
program.addCommand(selfCommands());
program.addCommand(agentCommands());
program.addCommand(taskCommands());
program.addCommand(githubCommands());
program.addCommand(operatorCommands());

program.parse(process.argv);
