import { Command } from 'commander';
import { monitorPostMerge } from '@openslack/self-evolution';

export function monitorCommands(): Command {
  const cmd = new Command('monitor').description('Post-merge monitoring');

  cmd
    .command('check')
    .description('Check for post-merge regression')
    .option('--experiment <id>', 'Experiment ID')
    .action((options) => {
      const result = monitorPostMerge(options.experiment || 'unknown');
      console.log(`Experiment: ${result.experimentId}`);
      console.log(`Regression: ${result.regression ? 'YES' : 'NO'}`);
      console.log(`Recommendation: ${result.recommendation}`);
      for (const [name, metric] of Object.entries(result.metrics)) {
        console.log(`  ${name}: ${metric.current} (delta: ${metric.delta > 0 ? '+' : ''}${metric.delta})`);
      }
      if (result.observations.length > 0) {
        console.log('Observations:');
        for (const obs of result.observations) console.log(`  - ${obs}`);
      }
      if (result.regression) process.exit(1);
    });

  return cmd;
}
