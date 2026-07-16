#!/usr/bin/env node
import { Command } from 'commander';
import { workspaceCommands } from './commands/workspace.js';
import { selfCommands } from './commands/self.js';
import { agentCommands } from './commands/agent.js';
import { agentRuntimeCommands } from './commands/agent-runtime.js';
import { deliveryCommands } from './commands/delivery.js';
import { initCommand } from './commands/init.js';
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
import { conversationCommands } from './commands/conversation.js';
import { guideCommands } from './commands/guide.js';
import { tuiCommands } from './commands/tui.js';
import { versionCommand } from './commands/version.js';
import { createOpenSlackCliContext } from './boot/context.js';
import { getBuildInfo } from './release/build-info.js';
import { findWorkspaceRoot, resolveWorkspaceContext } from '@openslack/workspace';
import {
  assertLocalStateCompatibility,
  LocalStateCompatibilityError,
} from '@openslack/runtime';

const buildInfo = getBuildInfo();
const applicationContext = createOpenSlackCliContext({
  workspaceRoot: findWorkspaceRoot() ?? process.cwd(),
  openslackVersion: buildInfo.version,
});
const program = new Command();

program
  .name('openslack')
  .description('OpenSlack — Agent Company OS CLI')
  .version(buildInfo.version);

// Top-level ask alias (reuses operator ask directly)
program.addCommand(buildAskCommand(applicationContext.operator));
program.addCommand(versionCommand());

// Command groups
program.addCommand(workspaceCommands());
program.addCommand(selfCommands());
program.addCommand(agentCommands());
program.addCommand(agentRuntimeCommands());
program.addCommand(initCommand());
program.addCommand(deliveryCommands());
program.addCommand(taskCommands());
program.addCommand(githubCommands());
program.addCommand(prCommands());
program.addCommand(operatorCommands(applicationContext.operator));
program.addCommand(statusCommands());
program.addCommand(
  doctorCommands({ llmProviderRegistry: applicationContext.operator.llmProviderRegistry }),
);
program.addCommand(governanceCommands());
program.addCommand(
  setupCommands({ llmProviderRegistry: applicationContext.operator.llmProviderRegistry }),
);
program.addCommand(chatCommands(applicationContext.operator));
program.addCommand(collaborationCommands());
program.addCommand(conversationCommands());
program.addCommand(guideCommands());
program.addCommand(tuiCommands(applicationContext.operator));

if (enforceStartupStateCompatibility(process.argv)) program.parse(process.argv);

function enforceStartupStateCompatibility(argv: string[]): boolean {
  const topLevel = argv[2];
  if (
    topLevel === undefined ||
    topLevel === 'version' ||
    topLevel === 'init' ||
    topLevel === '--version' ||
    topLevel === '-V' ||
    topLevel === '--help' ||
    topLevel === '-h' ||
    (topLevel === 'setup' && (argv[3] === 'state' || argv[3] === 'migrate-state'))
  ) {
    return true;
  }
  const root = findWorkspaceRoot();
  if (!root) return true;
  const context = resolveWorkspaceContext({ workspaceRoot: root });
  try {
    assertLocalStateCompatibility(context.localStateRoot);
    return true;
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : 'Local OpenSlack state is incompatible; unsafe continuation was refused.',
    );
    if (error instanceof LocalStateCompatibilityError) {
      for (const check of error.report.checks.filter((item) => item.status === 'incompatible')) {
        console.error(`- ${check.file}: ${check.detail}`);
      }
    }
    console.error('Run openslack setup state for a read-only diagnosis.');
    process.exitCode = 1;
    return false;
  }
}
