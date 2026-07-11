import { Command } from 'commander';
import { getBuildInfo } from '../release/build-info.js';

export function versionCommand(): Command {
  return new Command('version')
    .description('Show release and schema compatibility information')
    .option('--format <format>', 'Output format: text or json', 'text')
    .action((options: { format: string }) => {
      const info = getBuildInfo();
      if (options.format === 'json') {
        console.log(JSON.stringify(info, null, 2));
        return;
      }
      if (options.format !== 'text') {
        console.error('Version format must be text or json.');
        process.exitCode = 1;
        return;
      }
      console.log(`OpenSlack ${info.version}`);
      console.log(`Commit: ${info.commit}`);
      console.log(`Channel: ${info.channel}`);
      console.log(`Target: ${info.target}`);
      console.log(`Runtime: ${info.runtime}`);
      console.log(`Artifact: ${info.artifactFormat}`);
      console.log(
        `Workspace schema: v${info.workspaceSchemaCompatibility.min}-v${info.workspaceSchemaCompatibility.max}`,
      );
      console.log(`State schemas: ${info.stateSchemaCompatibility.join(', ')}`);
    });
}
