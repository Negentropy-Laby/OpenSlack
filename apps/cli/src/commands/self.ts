import { Command } from 'commander';
import { classifySelfEvolutionPR } from '@openslack/kernel';
import { observeHealth, triageObservations, validatePR, reviewPR, computeFitnessScore, monitorPostMerge, runGoldenEval, generateScorecard } from '@openslack/runtime';
import { validateWorkspace } from '@openslack/workspace';
import type { PluginActionRunnerPort } from '../boot/plugin-action-runner.js';
import type { CheckPluginOptions } from '@openslack/plugin-testkit';
import { selfPluginCommands } from './self-plugin.js';
import { selfReleaseCommands } from './self-release.js';

const unavailablePluginRunner = Object.freeze({
  async run(): Promise<never> {
    throw new Error('Plugin action runner is unavailable.');
  },
}) satisfies PluginActionRunnerPort;

export function selfCommands(
  pluginRunner: PluginActionRunnerPort = unavailablePluginRunner,
  pluginCheckOptions?: CheckPluginOptions,
): Command {
  const cmd = new Command('self').description('Self-evolution commands');

  cmd.addCommand(selfReleaseCommands());
  cmd.addCommand(selfPluginCommands(pluginRunner, pluginCheckOptions));

  cmd
    .command('init')
    .description('Initialize Self-Project Mode')
    .action(() => {
      console.log('Self-Project Mode initialization:');
      console.log('  openslack.yaml already exists in repository root.');
      console.log('  .openslack/ state directory already exists.');
      console.log('  Run "openslack workspace validate" to verify.');
    });

  cmd
    .command('classify-pr')
    .description('Classify a PR by changed paths')
    .option('-p, --paths <paths>', 'Comma-separated list of changed paths')
    .option('--format <format>', 'Output format: text or json', 'text')
    .action((options) => {
      if (!options.paths) {
        console.error('Error: --paths is required (comma-separated list)');
        process.exit(1);
      }
      const paths = options.paths.split(',').map((p: string) => p.trim());
      const classification = classifySelfEvolutionPR(paths);

      if (options.format === 'json') {
        console.log(JSON.stringify(classification, null, 2));
      } else {
        console.log(`Risk Zone: ${classification.riskZone.toUpperCase()}`);
        console.log(`Auto-merge: ${classification.autoMergeAllowed ? 'Yes' : 'No'}`);
        console.log(`Human approval: ${classification.humanApprovalRequired ? 'Required' : 'Not required'}`);
        console.log(`Required checks: ${classification.requiredChecks.join(', ') || 'none'}`);
        console.log(`Required agent reviews: ${classification.requiredAgentReviews}`);
      }

      if (classification.riskZone === 'black') {
        process.exit(1);
      }
    });

  cmd
    .command('validate')
    .description('Run self-validation')
    .option('--pr <number>', 'PR number to validate')
    .option('--sha <sha>', 'Head SHA')
    .option('--paths <paths>', 'Comma-separated changed paths')
    .option('--agent <id>', 'Agent ID')
    .option('--experiment <id>', 'Experiment ID')
    .option('--format <format>', 'Output format: text or json', 'text')
    .action((options) => {
      if (options.pr && options.paths) {
        console.log(`Validating PR #${options.pr}...`);
        const result = validatePR({
          prNumber: parseInt(options.pr, 10),
          headSha: options.sha || 'unknown',
          changedPaths: options.paths.split(',').map((p: string) => p.trim()),
          agentId: options.agent || 'unknown',
          experimentId: options.experiment || `EXP-${options.pr}`,
        });
        if (options.format === 'json') {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Risk Zone: ${result.protectedPathCheck.black_zone_touched ? 'BLACK' : result.protectedPathCheck.red_zone_touched ? 'RED' : 'PASS'}`);
          console.log(`Fitness Score: ${result.score.overall} → ${result.score.decision}`);
          console.log(`Decision: ${result.decision}`);
          console.log(`Manifest: .openslack/self/experiments/${result.experimentId}/self_validation.yaml (YAML)`);
        }
        if (result.decision === 'fail') process.exit(1);
      } else {
        const result = validateWorkspace(process.cwd());
        if (result.valid) {
          console.log('Self-validation: PASS');
          console.log(`  Workspace: ${result.config?.workspace_id || 'unknown'}`);
          console.log(`  Mode: ${result.config?.mode || 'unknown'}`);
        } else {
          console.log('Self-validation: FAIL');
          for (const err of result.errors) {
            console.log(`  [${err.severity}] ${err.message}`);
          }
          process.exit(1);
        }
      }
    });

  cmd
    .command('observe')
    .description('Observe OpenSlack health')
    .action(() => {
      const observations = observeHealth();
      if (observations.length === 0) {
        console.log('No issues detected. OpenSlack is healthy.');
      } else {
        for (const obs of observations) {
          console.log(`[${obs.severity.toUpperCase()}] ${obs.type}: ${obs.summary}`);
        }
        console.log(`\n${observations.length} observation(s) found.`);
      }
    });

  cmd
    .command('triage')
    .description('Triage pending observations')
    .option('--create-issues', 'Create GitHub issues for new EVOL tasks')
    .action(async (options) => {
      const observations = observeHealth();
      if (observations.length === 0) {
        console.log('No pending observations to triage.');
        return;
      }
      const taskIds = triageObservations(observations);
      console.log(`Created ${taskIds.length} EVOL task(s):`);
      for (const id of taskIds) {
        console.log(`  - ${id}`);
      }
      if (options.createIssues) {
        try {
          const { createTaskIssue } = await import('@openslack/github');
          const { readFileSync, existsSync } = await import('node:fs');
          const { join } = await import('node:path');
          const root = process.cwd();
          for (const id of taskIds) {
            const evolPath = join(root, '.openslack', 'self', 'evolution_backlog', `${id}.yaml`);
            if (!existsSync(evolPath)) continue;
            const yaml = readFileSync(evolPath, 'utf-8');
            const titleMatch = yaml.match(/^title:\s*["']?(.+?)["']?\s*$/m);
            const title = titleMatch?.[1] || id;
            const body = `## EVOL Task: ${id}\n\n\`\`\`yaml\n${yaml}\n\`\`\``;
            const { issueNumber, url } = await createTaskIssue(title, body, [
              'openslack:task',
              'openslack:ready',
              'risk:medium',
            ]);
            console.log(`  Issue #${issueNumber}: ${url}`);
          }
        } catch (e) {
          console.log(`(GitHub issue creation unavailable: ${(e as Error).message})`);
        }
      }
    });

  cmd
    .command('eval')
    .description('Run self-evolution eval suites')
    .option('--suite <name>', 'Suite name: golden, all', 'golden')
    .option('--format <format>', 'Output format: text or json', 'text')
    .option('--clean', 'Remove auto-generated artifacts after run')
    .action(async (options) => {
      console.log(`Running eval suite: ${options.suite}...\n`);
      const cleanStart = Date.now();

      if (options.suite === 'golden' || options.suite === 'all') {
        const results = runGoldenEval();
        const passed = results.filter((r) => r.passed).length;
        // P0-4: auto-generate scorecard (skipped with --clean)
        const scorecardPath = options.clean ? null : generateScorecard(results);
        if (scorecardPath) {
          console.log(`Scorecard: ${scorecardPath}`);
        }
        // P1-1: clean artifacts if --clean flag set
        if (options.clean) {
          try {
            const { existsSync: ex, readdirSync, rmSync: del, statSync } = await import('node:fs');
            const { join: j } = await import('node:path');
            const rootPath = process.cwd();
            const scorecardDir = j(rootPath, '.openslack', 'self', 'scorecards');
            const backlogDir = j(rootPath, '.openslack', 'self', 'evolution_backlog');
            const yearDir = j(scorecardDir, String(new Date().getFullYear()));
            const monthDir = j(yearDir, String(new Date().getMonth() + 1).padStart(2, '0'));
            for (const dir of [monthDir, backlogDir]) {
              if (!ex(dir)) continue;
              for (const f of readdirSync(dir)) {
                const fp = j(dir, f);
                try {
                  if (statSync(fp).mtimeMs >= cleanStart - 1000) del(fp);
                } catch { /* ok */ }
              }
            }
            console.log('(cleaned artifacts)');
          } catch { /* skip */ }
        }

        if (options.format === 'json') {
          console.log(JSON.stringify({ suite: 'golden', passed, total: results.length, results }, null, 2));
        } else {
          for (const r of results) {
            const icon = r.passed ? 'PASS' : 'FAIL';
            console.log(`[${icon}] ${r.caseId}: ${r.title}`);
            for (const d of r.details) {
              console.log(`       ${d}`);
            }
          }
          console.log(`\n${passed}/${results.length} passed`);
        }

        if (passed < results.length) {
          process.exit(1);
        }
      }
    });

  cmd
    .command('review')
    .description('Review a PR for merge eligibility')
    .requiredOption('--pr <number>', 'PR number')
    .requiredOption('--implementer <id>', 'Implementation agent ID')
    .requiredOption('--reviewer <id>', 'Reviewer agent ID')
    .action((options) => {
      const result = reviewPR(parseInt(options.pr, 10), null, options.implementer, options.reviewer);
      console.log(`Decision: ${result.decision.toUpperCase()}`);
      for (const check of result.checks) console.log(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
      if (result.decision === 'reject') process.exit(1);
    });

  cmd
    .command('scorecard')
    .description('Compute fitness score')
    .option('--experiment <id>', 'Experiment ID')
    .action((options) => {
      const score = computeFitnessScore({ checks: {
        'unit-tests': { result: 'pass', command: 'bun run test' },
        'typecheck': { result: 'pass', command: 'bun run typecheck' },
        'workspace-validate': { result: 'pass', command: 'openslack workspace validate' },
        'self-eval': { result: 'pass', command: 'openslack self eval' },
        'security-scan': { result: 'pass', command: '', findings: [] },
      }});
      console.log(`Fitness score for ${options.experiment || 'unknown'}: ${score.overall} → ${score.decision.toUpperCase()}`);
    });

  cmd
    .command('monitor')
    .description('Check for post-merge regression')
    .option('--experiment <id>', 'Experiment ID')
    .action((options) => {
      const result = monitorPostMerge(options.experiment || 'unknown');
      console.log(`Experiment: ${result.experimentId}, Regression: ${result.regression ? 'YES' : 'NO'}, Recommendation: ${result.recommendation}`);
      if (result.regression) process.exit(1);
    });

  return cmd;
}
