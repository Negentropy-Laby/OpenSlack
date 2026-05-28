#!/usr/bin/env node
import { Command } from 'commander';
import { workspaceCommands } from './commands/workspace.js';
import { selfCommands } from './commands/self.js';
import { agentCommands } from './commands/agent.js';
import { taskCommands } from './commands/task.js';
import { githubCommands } from './commands/github.js';
import { operatorCommands } from './commands/operator.js';
import { buildAskCommand } from './commands/operator.js';
import { prCommands } from './commands/pr.js';
import { setupCommands } from './commands/setup.js';
import { statusCommands } from './commands/status.js';
import { doctorCommands } from './commands/doctor.js';
import { governanceCommands } from './commands/governance.js';
import { chatCommands } from './commands/chat.js';
import { collaborationCommands } from './commands/collaboration.js';
import { guideCommands } from './commands/guide.js';

const program = new Command();

program
  .name('openslack')
  .description('OpenSlack — Agent Company OS CLI')
  .version('0.1.0');

// Top-level ask alias (reuses operator ask directly)
program.addCommand(buildAskCommand());

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
program.addCommand(collaborationCommands());
program.addCommand(guideCommands());

program.parse(process.argv);
