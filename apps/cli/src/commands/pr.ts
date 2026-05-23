import { Command } from 'commander';
import {
  fetchPRDetails,
  classifyPRReport,
  checkMergeReadiness,
  generateReviewReport,
  loadPRReviewPolicy,
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

  return cmd;
}
