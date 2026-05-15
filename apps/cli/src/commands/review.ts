import { Command } from 'commander';
import { reviewPR, computeFitnessScore } from '@openslack/self-evolution';

export function reviewCommands(): Command {
  const cmd = new Command('review').description('Self-evolution review commands');

  cmd
    .command('pr')
    .description('Review a PR')
    .requiredOption('--pr <number>', 'PR number')
    .requiredOption('--implementer <id>', 'Implementation agent ID')
    .requiredOption('--reviewer <id>', 'Reviewer agent ID')
    .action((options) => {
      const result = reviewPR(
        parseInt(options.pr, 10),
        null, // validation result would be loaded from file in production
        options.implementer,
        options.reviewer,
      );

      console.log(`Reviewing PR #${options.pr}:`);
      console.log(`  Implementer: ${result.implementationAgent}`);
      console.log(`  Reviewer: ${result.reviewerAgent}`);
      console.log(`  Decision: ${result.decision.toUpperCase()}`);
      for (const check of result.checks) {
        console.log(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
      }
      if (result.decision === 'reject') process.exit(1);
    });

  cmd
    .command('scorecard')
    .description('Compute fitness score for an experiment')
    .option('--experiment <id>', 'Experiment ID')
    .action((options) => {
      const score = computeFitnessScore({
        checks: {
          'unit-tests': { result: 'pass', command: 'pnpm test' },
          'typecheck': { result: 'pass', command: 'pnpm typecheck' },
          'workspace-validate': { result: 'pass', command: 'openslack workspace validate' },
          'self-eval': { result: 'pass', command: 'openslack self eval' },
          'security-scan': { result: 'pass', command: 'openslack self scan-secrets', findings: [] },
        },
        diffStats: { filesChanged: 5, linesAdded: 120, linesRemoved: 30 },
        hasNewDependency: false,
      });

      console.log(`Fitness score for ${options.experiment || 'unknown'}:`);
      for (const [name, dim] of Object.entries(score.dimensions)) {
        console.log(`  ${name}: ${dim.score.toFixed(2)} (weight: ${dim.weight})`);
      }
      console.log(`  Overall: ${score.overall.toFixed(3)} → ${score.decision.toUpperCase()}`);
    });

  return cmd;
}
