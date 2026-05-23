import { Command } from 'commander';
import { getCODEOWNERS } from '@openslack/github';
import {
  fetchPRDetails,
  classifyPRReport,
  checkMergeReadiness,
  generateReviewReport,
  generateDoctorReport,
  loadPRReviewPolicy,
  diagnosePR,
  parseCODEOWNERS,
  resolveCodeowners,
} from '@openslack/pr';

export function prCommands(): Command {
  const cmd = new Command('pr').description('PR Review & Merge Steward');

  cmd
    .command('status <number>')
    .description('Show PR status and merge readiness')
    .action(async (number: string) => {
      const prNumber = parseInt(number, 10);
      const report = await fetchPRDetails(prNumber);
      const classified = classifyPRReport(report);
      const policy = loadPRReviewPolicy();
      const ready = checkMergeReadiness(classified, policy);
      console.log(generateReviewReport(ready));
    });

  cmd
    .command('review <number>')
    .description('Generate and display a review report for a PR')
    .action(async (number: string) => {
      const prNumber = parseInt(number, 10);
      const report = await fetchPRDetails(prNumber);
      const classified = classifyPRReport(report);
      const policy = loadPRReviewPolicy();
      const ready = checkMergeReadiness(classified, policy);
      console.log(generateReviewReport(ready));
    });

  cmd
    .command('recommend <number>')
    .description('Recommend next action for a PR')
    .action(async (number: string) => {
      const prNumber = parseInt(number, 10);
      const report = await fetchPRDetails(prNumber);
      const classified = classifyPRReport(report);
      const policy = loadPRReviewPolicy();
      const ready = checkMergeReadiness(classified, policy);

      if (ready.decision === 'NEEDS_HUMAN_APPROVAL') {
        console.log('Human approval required.');
        console.log(
          `Suggested command: gh pr review ${prNumber} --repo ${
            process.env.GITHUB_OWNER || 'Negentropy-Laby'
          }/${process.env.GITHUB_REPO || 'OpenSlack'} --approve --body "LGTM"`,
        );
      } else if (ready.decision === 'READY_TO_MERGE') {
        console.log('Ready to merge.');
        console.log(
          `Suggested command: gh pr merge ${prNumber} --repo ${
            process.env.GITHUB_OWNER || 'Negentropy-Laby'
          }/${process.env.GITHUB_REPO || 'OpenSlack'} --merge`,
        );
      } else if (ready.decision === 'BLOCKED_BLACK_ZONE') {
        console.log(`BLOCKED — Black Zone: ${ready.reason}`);
        console.log('Recommendation: Close this PR.');
      } else if (ready.decision === 'CHECKS_PENDING') {
        console.log(`PENDING — ${ready.reason}`);
        console.log('Recommendation: Wait for checks to complete.');
      } else if (ready.decision === 'CHECKS_FAILED') {
        console.log(`FAILED — ${ready.reason}`);
        console.log('Recommendation: Fix failing checks before merge.');
      } else {
        console.log(`Status: ${ready.decision}`);
        console.log(`Reason: ${ready.reason}`);
        console.log(`Recommendation: ${ready.recommendation}`);
      }
    });

  cmd
    .command('doctor <number>')
    .description('Run comprehensive governance diagnosis on a PR')
    .action(async (number: string) => {
      const prNumber = parseInt(number, 10);
      const report = await fetchPRDetails(prNumber);
      const classified = classifyPRReport(report);
      const policy = loadPRReviewPolicy();

      const codeownersContent = await getCODEOWNERS(classified.baseRef);
      const codeownersEntries = codeownersContent ? parseCODEOWNERS(codeownersContent) : [];
      const codeowners = resolveCodeowners(classified.changedFiles, codeownersEntries);

      const diagnosed = diagnosePR(classified, policy, codeowners);
      console.log(generateDoctorReport(diagnosed, codeowners));
    });

  cmd
    .command('merge <number>')
    .description('Merge a PR after passing all governance gates')
    .option('--method <method>', 'Merge method: merge, squash, or rebase', 'merge')
    .action(async (number: string, options: { method: string }) => {
      const prNumber = parseInt(number, 10);
      const { mergeIfReady, loadPRReviewPolicy } = await import('@openslack/pr');
      const policy = loadPRReviewPolicy();

      const result = await mergeIfReady(prNumber, policy, {
        method: options.method as 'merge' | 'squash' | 'rebase',
      });

      if (!result.merged) {
        console.log('Merge blocked.');
        console.log('');
        console.log(`Decision: ${result.decision}`);
        console.log(`Reason: ${result.reason}`);
        console.log('');
        console.log(result.message);
        process.exit(1);
      }

      console.log('Merge Steward: PR merged successfully.');
      console.log(`Decision: ${result.decision}`);
      if (result.sha) console.log(`SHA: ${result.sha}`);
      console.log(result.message);
    });

  return cmd;
}
