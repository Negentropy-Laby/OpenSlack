import { Command } from 'commander';
import { PluginHostError } from '@openslack/plugin-host';
import {
  checkPlugin,
  renderPluginCheckPlain,
  type CheckPluginOptions,
} from '@openslack/plugin-testkit';

import {
  PluginActionRoutingError,
  type PluginActionRunnerPort,
} from '../boot/plugin-action-runner.js';

function renderFailure(error: unknown): void {
  const code =
    error instanceof PluginHostError
      ? (error.findings[0]?.code ?? 'PLUGIN_HOST_ERROR')
      : error instanceof PluginActionRoutingError
        ? error.code
        : 'PLUGIN_ACTION_RUN_FAILED';
  console.error(`Plugin action failed: ${code}.`);
  process.exitCode = 1;
}

function renderSuccessOutput(output: string): void {
  const normalized = output.trimEnd();
  if (normalized.length > 0) console.log(normalized);
}

export function selfPluginCommands(
  runner: PluginActionRunnerPort,
  checkOptions: CheckPluginOptions = {
    workspaceRoot: process.cwd(),
    openslackVersion: '0.1.1',
  },
): Command {
  const plugin = new Command('plugin').description('Check and run governed plugins');

  plugin
    .command('check')
    .description('Validate a declarative plugin before governed registration')
    .argument('<path>', 'Path to plugin.json or its containing directory')
    .option('--format <format>', 'Output format: plain or json', 'plain')
    .option('--verify-integrity', 'Verify workspace manifest bytes against plugins.lock')
    .action(
      async (manifestPath: string, options: { format: string; verifyIntegrity?: boolean }) => {
        if (options.format !== 'plain' && options.format !== 'json') {
          console.error('Plugin check failed: PLUGIN_CHECK_FORMAT_INVALID.');
          process.exitCode = 1;
          return;
        }
        try {
          const report = await checkPlugin(manifestPath, {
            ...checkOptions,
            verifyIntegrity: options.verifyIntegrity === true,
          });
          console.log(
            options.format === 'json'
              ? JSON.stringify(report, null, 2)
              : renderPluginCheckPlain(report),
          );
          if (report.readiness !== 'READY_TO_REGISTER') process.exitCode = 1;
        } catch {
          console.error('Plugin check failed: PLUGIN_CHECK_FAILED.');
          process.exitCode = 1;
        }
      },
    );

  plugin
    .command('run')
    .description('Route one registered plugin action through the sealed host')
    .argument('<plugin-id>', 'Registered plugin ID')
    .argument('<action-id>', 'Plugin-local action ID')
    .action(async (pluginId: string, actionId: string) => {
      try {
        const result = await runner.run(pluginId, actionId);
        if (result.outcome === 'shadowed') {
          console.log('Plugin action visibility: SHADOW');
          console.log(`Contribution: ${result.contributedActionId}`);
          console.log(`Target: ${result.targetActionId}`);
          console.log('Executed: no');
          return;
        }

        console.log('Plugin action routing: ENFORCE');
        console.log(`Contribution: ${result.contributedActionId}`);
        console.log(`Target: ${result.targetActionId}`);
        if (result.execution.status !== 'success') {
          console.error(`Plugin action execution failed: ${result.execution.status}.`);
          process.exitCode = 1;
          return;
        }
        for (const step of result.execution.steps) {
          if (step.status === 'success') renderSuccessOutput(step.output);
        }
      } catch (error) {
        renderFailure(error);
      }
    });

  return plugin;
}
