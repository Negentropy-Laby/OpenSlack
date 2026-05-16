#!/usr/bin/env node
import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
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

// Top-level aliases (user-friendly shortcuts)
program
  .command('ask')
  .description('Ask OpenSlack to do something (natural language)')
  .argument('<query...>', 'What do you want to do?')
  .action(async (queryParts: string[]) => {
    const root = process.cwd();
    const argv = ['"' + process.execPath + '"', '--import', 'tsx', '"' + join(root, 'apps', 'cli', 'src', 'index.ts') + '"', 'operator', 'ask', ...queryParts];
    try { execSync(argv.join(' '), { cwd: root, stdio: 'inherit' }); } catch { /* non-zero exit expected for some checks */ }
  });

program
  .command('status')
  .description('Quick workspace status overview')
  .action(() => {
    const root = process.cwd();
    const argv = ['"' + process.execPath + '"', '--import', 'tsx', '"' + join(root, 'apps', 'cli', 'src', 'index.ts') + '"', 'workspace', 'status'];
    try { execSync(argv.join(' '), { cwd: root, stdio: 'inherit' }); } catch { /* non-zero exit expected for some checks */ }
  });

program
  .command('doctor')
  .description('Quick GitHub integration doctor check')
  .action(() => {
    const root = process.cwd();
    const argv = ['"' + process.execPath + '"', '--import', 'tsx', '"' + join(root, 'apps', 'cli', 'src', 'index.ts') + '"', 'github', 'doctor'];
    try { execSync(argv.join(' '), { cwd: root, stdio: 'inherit' }); } catch { /* non-zero exit expected for some checks */ }
  });

// Command groups
program.addCommand(workspaceCommands());
program.addCommand(selfCommands());
program.addCommand(agentCommands());
program.addCommand(taskCommands());
program.addCommand(githubCommands());
program.addCommand(operatorCommands());

program.parse(process.argv);
