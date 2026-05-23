import { Command } from 'commander';
import { getCODEOWNERS, commentOnPR } from '@openslack/github';
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
  postReviewComment,
  watchPR,
} from '@openslack/pr';
import { recordEvent } from '@openslack/collaboration';

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
    .option('--comment', 'Post the review report as a PR comment')
    .action(async (number: string, options: { comment?: boolean }) => {
      const prNumber = parseInt(number, 10);
      const report = await fetchPRDetails(prNumber);
      const classified = classifyPRReport(report);
      const policy = loadPRReviewPolicy();
      const ready = checkMergeReadiness(classified, policy);

      if (options.comment) {
        await postReviewComment(prNumber, ready);
        console.log(`Review comment posted on PR #${prNumber}`);
      } else {
        console.log(generateReviewReport(ready));
      }
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
    .option('--comment', 'Post the doctor report as a PR comment')
    .action(async (number: string, options: { comment?: boolean }) => {
      const prNumber = parseInt(number, 10);
      const report = await fetchPRDetails(prNumber);
      const classified = classifyPRReport(report);
      const policy = loadPRReviewPolicy();

      const codeownersContent = await getCODEOWNERS(classified.baseRef);
      const codeownersEntries = codeownersContent ? parseCODEOWNERS(codeownersContent) : [];
      const codeowners = resolveCodeowners(classified.changedFiles, codeownersEntries);

      const diagnosed = diagnosePR(classified, policy, codeowners);
      const doctorOutput = generateDoctorReport(diagnosed, codeowners);

      const isReady = diagnosed.decision === 'READY_TO_MERGE';
      try {
        recordEvent({
          type: isReady ? 'pr.doctor.ready' : 'pr.doctor.blocked',
          actor: { id: 'cli', kind: 'system', provider: 'cli' },
          object: { kind: 'pr', id: String(prNumber) },
          source: { kind: 'prms', ref: 'diagnosePR' },
          summary: isReady
            ? `PR #${prNumber} is ready to merge`
            : `PR #${prNumber} blocked: ${diagnosed.reason}`,
          visibility: 'local',
          redacted: false,
          containsSensitiveData: false,
          risk: isReady ? 'none' : 'medium',
          owner: isReady ? undefined : { id: diagnosed.recommendation?.includes('review') ? 'human' : 'agent', kind: 'human' },
          nextAction: isReady
            ? { owner: 'human', action: `Review and merge PR #${prNumber} on GitHub` }
            : { owner: 'human', action: diagnosed.recommendation },
        });
      } catch {
        // Event recording is best-effort; do not block the CLI flow
      }

      if (options.comment) {
        await commentOnPR(prNumber, doctorOutput);
        console.log(`Doctor report posted on PR #${prNumber}`);
      } else {
        console.log(doctorOutput);
      }
    });

  cmd
    .command('watch <number>')
    .description('Poll PR status until ready or timeout')
    .option('--timeout <seconds>', 'Timeout in seconds', '60')
    .option('--interval <seconds>', 'Polling interval in seconds', '10')
    .action(async (number: string, options: { timeout: string; interval: string }) => {
      const prNumber = parseInt(number, 10);
      const result = await watchPR(prNumber, {
        timeoutSeconds: parseInt(options.timeout, 10),
        intervalSeconds: parseInt(options.interval, 10),
      });
      console.log('');
      console.log(`Result: ${result.finalState}`);
      console.log(`Reason: ${result.reason}`);
      console.log(`Polls: ${result.polls} over ${Math.round(result.elapsedMs / 1000)}s`);
      if (result.finalState !== 'READY_TO_MERGE') {
        process.exit(1);
      }
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
