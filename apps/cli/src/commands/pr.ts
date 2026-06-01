import { Command } from 'commander';
import { renderFindingsPlain } from '@openslack/runtime';
import type { PlainFinding } from '@openslack/runtime';
import { getCODEOWNERS, commentOnPR, getClient, GitHubAuthRequiredError } from '@openslack/github';
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
  buildPRQueue,
  renderPRQueue,
} from '@openslack/pr';
import { recordEvent } from '@openslack/collaboration';
import {
  buildPRDoctorClientOptions,
  renderAuthRequiredMessage,
  renderDoctorDryRunReport,
  renderDoctorEvidenceBanner,
} from './pr-doctor-evidence.js';

export function prCommands(): Command {
  const cmd = new Command('pr').description('PR Review & Merge Steward');

  cmd
    .command('queue')
    .description('Show open PRs grouped by readiness and blocker owner')
    .option('--limit <n>', 'Maximum open PRs to inspect', '20')
    .option('--format <format>', 'Output format: standard or tui', 'standard')
    .action(async (options: { limit: string; format: string }) => {
      const limit = parseInt(options.limit, 10);
      const items = await buildPRQueue(Number.isFinite(limit) ? limit : 20);

      if (options.format === 'tui') {
        try {
          const { renderPrQueueTui } = await import('@openslack/tui');
          await renderPrQueueTui(items);
        } catch (error) {
          console.error('TUI unavailable. Falling back to standard output.');
          console.log(renderPRQueue(items));
        }
      } else {
        console.log(renderPRQueue(items));
      }
    });

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
    .option('--format <format>', 'Output format: standard, plain, or tui', 'standard')
    .option('--dry-run', 'Simulate the diagnosis plan without fetching live GitHub evidence')
    .option('--repo <owner/name>', 'Target GitHub repository')
    .option('--auth <mode>', 'Auth mode: auto, app, token, or dry-run', 'auto')
    .action(async (number: string, options: { comment?: boolean; format: string; dryRun?: boolean; repo?: string; auth?: string }) => {
      const prNumber = parseInt(number, 10);
      let clientOptions;
      let client;
      try {
        clientOptions = buildPRDoctorClientOptions(options);
        client = await getClient(clientOptions);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (err instanceof GitHubAuthRequiredError || err.message.includes('AUTH_REQUIRED')) {
          console.error(renderAuthRequiredMessage(prNumber, err));
          process.exitCode = 1;
          return;
        }
        console.error(err.message);
        process.exitCode = 1;
        return;
      }

      if (client.isDryRun) {
        console.log(renderDoctorDryRunReport(prNumber, client));
        return;
      }

      if (options.comment && client.authMode !== 'github_app_installation') {
        console.error('BOT_AUTH_REQUIRED: pr doctor --comment requires GitHub App bot authentication.');
        console.error('Try: powershell -ExecutionPolicy Bypass -File scripts\\openslack-bot.ps1 pr doctor ' + prNumber + ' --comment');
        process.exitCode = 1;
        return;
      }

      const evidenceBanner = renderDoctorEvidenceBanner(client);
      const report = await fetchPRDetails(prNumber, clientOptions);
      if (report.state === 'unknown') {
        console.error(`PR_FETCH_FAILED: Could not fetch PR #${prNumber} from ${client.owner}/${client.repo}.`);
        process.exitCode = 1;
        return;
      }
      const classified = classifyPRReport(report);
      const policy = loadPRReviewPolicy();

      const codeownersContent = await getCODEOWNERS(classified.baseRef, clientOptions);
      const codeownersEntries = codeownersContent ? parseCODEOWNERS(codeownersContent) : [];
      const codeowners = resolveCodeowners(classified.changedFiles, codeownersEntries);

      const diagnosed = diagnosePR(classified, policy, codeowners);
      const doctorOutput = `${evidenceBanner}\n\n${generateDoctorReport(diagnosed, codeowners)}`;

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
        await commentOnPR(prNumber, doctorOutput, clientOptions);
        console.log(`Doctor report posted on PR #${prNumber}`);
      } else if (options.format === 'tui') {
        try {
          const { summarizePRDecision } = await import('@openslack/pr');
          const summary = summarizePRDecision(diagnosed, codeowners);
          const { renderDoctorTui } = await import('@openslack/tui');
          await renderDoctorTui(diagnosed, {
            evidence: [
              ...evidenceBanner.split('\n'),
              ...summary.evidence,
            ],
            profileSyncGate: diagnosed.profileSyncGate && diagnosed.profileSyncGate.overall !== 'N/A'
              ? { passed: diagnosed.profileSyncGate.overall === 'PASS', detail: diagnosed.profileSyncGate.criteria.map(c => `${c.name}: ${c.status}${c.detail ? ' - ' + c.detail : ''}`).join('; ') }
              : undefined,
          });
        } catch (error) {
          console.error('TUI unavailable. Falling back to standard output.');
          console.log(doctorOutput);
        }
      } else if (options.format === 'plain') {
        const findings: PlainFinding[] = [];
        findings.push({
          status: 'PASS',
          title: 'GitHub evidence',
          detail: `LIVE; Repo: ${client.owner}/${client.repo}; Auth: ${client.authMode}`,
        });
        findings.push({
          status: diagnosed.draft ? 'FAIL' : 'PASS',
          title: 'Draft state',
          detail: diagnosed.draft ? 'PR is in draft state' : 'Ready for review',
        });
        findings.push({
          status: diagnosed.state !== 'open' ? 'FAIL' : 'PASS',
          title: 'PR state',
          detail: diagnosed.state !== 'open' ? `PR is ${diagnosed.state}` : 'Open',
        });
        findings.push({
          status: diagnosed.mergeable === false ? 'FAIL' : 'PASS',
          title: 'Merge conflicts',
          detail: diagnosed.mergeable === false ? 'Has merge conflicts' : 'No merge conflicts',
        });
        // Workflow Gate
        if (diagnosed.workflowGate && diagnosed.workflowGate.overall !== 'N/A') {
          findings.push({
            status: diagnosed.workflowGate.overall === 'PASS' ? 'PASS' : 'FAIL',
            title: 'Workflow Gate',
            detail: diagnosed.workflowGate.criteria
              .filter((c) => c.status !== 'N/A')
              .map((c) => `${c.name}: ${c.status}`)
              .join('; '),
            nextAction: diagnosed.workflowGate.overall === 'FAIL'
              ? 'Link proposal/review issues, add hash and trust decision to PR body'
              : undefined,
          });
        }
        const failing = diagnosed.checks.filter((c) => c.conclusion && c.conclusion !== 'success' && c.conclusion !== 'neutral');
        const pending = diagnosed.checks.filter((c) => c.status !== 'completed');
        if (pending.length > 0) {
          findings.push({ status: 'WARN', title: 'CI Checks', detail: `${pending.length} pending`, nextAction: 'Wait for checks' });
        } else if (failing.length > 0) {
          findings.push({ status: 'FAIL', title: 'CI Checks', detail: `${failing.length} failing`, nextAction: 'Fix failing checks' });
        } else {
          findings.push({ status: 'PASS', title: 'CI Checks', detail: `All ${diagnosed.checks.length} passed` });
        }
        const validApprovals = diagnosed.reviews.filter((r) => r.state === 'APPROVED' && r.user !== diagnosed.author);
        findings.push({
          status: validApprovals.length === 0 && diagnosed.decision !== 'READY_TO_MERGE' ? 'requires_human_approval' : 'PASS',
          title: 'Approvals',
          detail: `${validApprovals.length} valid approval(s)`,
          nextAction: validApprovals.length === 0 ? diagnosed.recommendation : undefined,
        });
        findings.push({
          status: diagnosed.riskZone === 'black' ? 'FAIL' : diagnosed.riskZone === 'red' ? 'WARN' : 'PASS',
          title: 'Risk zone',
          detail: `Zone: ${diagnosed.riskZone.toUpperCase()}`,
        });
        const blocked = diagnosed.decision !== 'READY_TO_MERGE';
        findings.push({
          status: blocked ? 'FAIL' : 'PASS',
          title: 'Merge decision',
          detail: `${diagnosed.decision}: ${diagnosed.reason}`,
          nextAction: blocked ? diagnosed.recommendation : undefined,
        });
        console.log(renderFindingsPlain(findings));
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
    .command('comment <number>')
    .description('Post a comment on a pull request')
    .requiredOption('--body <text>', 'Comment body (markdown)')
    .option('--agent-id <id>', 'Agent ID for authorization')
    .action(async (number: string, options: { body: string; agentId?: string }) => {
      const prNumber = parseInt(number, 10);

      if (options.agentId) {
        const { resolveAgentPrincipal } = await import('@openslack/runtime');
        const { authorizeAgentAction } = await import('@openslack/kernel');
        const { existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        let dir = process.cwd();
        for (let i = 0; i < 10; i++) {
          if (existsSync(join(dir, 'openslack.yaml'))) break;
          const parent = join(dir, '..');
          if (parent === dir) break;
          dir = parent;
        }
        const resolved = resolveAgentPrincipal({ root: dir, agentId: options.agentId, provider: 'cli' });
        if ('error' in resolved) {
          console.error(`Authorization failed: ${resolved.error}`);
          process.exit(1);
        }
        const auth = authorizeAgentAction({ snapshot: resolved.snapshot, action: 'pr.comment' });
        if (auth.decision !== 'allow') {
          console.error(`Action denied: ${auth.diagnostics.join('; ')}`);
          process.exit(1);
        }
      }

      await commentOnPR(prNumber, options.body);
      console.log(`Comment posted on PR #${prNumber}`);

      try {
        recordEvent({
          type: 'pr.review.commented',
          actor: options.agentId
            ? { id: options.agentId, kind: 'agent', provider: 'cli' }
            : { id: 'cli', kind: 'system', provider: 'cli' },
          object: { kind: 'pr', id: String(prNumber) },
          source: { kind: 'prms', ref: 'pr.comment' },
          summary: `Comment posted on PR #${prNumber}`,
          visibility: 'local',
          redacted: false,
          containsSensitiveData: false,
        });
      } catch {
        // best-effort event recording
      }
    });

  cmd
    .command('merge <number>')
    .description('Merge a PR after passing all governance gates')
    .option('--method <method>', 'Merge method: merge, squash, or rebase', 'merge')
    .option('--agent-id <id>', 'Agent ID for authorization')
    .action(async (number: string, options: { method: string; agentId?: string }) => {
      const prNumber = parseInt(number, 10);
      const { mergeIfReady, loadPRReviewPolicy } = await import('@openslack/pr');
      const policy = loadPRReviewPolicy();

      // Resolve agent principal if --agent-id provided
      let authOptions: { principal?: import('@openslack/kernel').AgentPrincipal; snapshot?: import('@openslack/kernel').AgentPermissionSnapshot } = {};
      if (options.agentId) {
        const { resolveAgentPrincipal } = await import('@openslack/runtime');
        const { existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        let dir = process.cwd();
        for (let i = 0; i < 10; i++) {
          if (existsSync(join(dir, 'openslack.yaml'))) break;
          const parent = join(dir, '..');
          if (parent === dir) break;
          dir = parent;
        }
        const resolved = resolveAgentPrincipal({ root: dir, agentId: options.agentId, provider: 'cli' });
        if ('error' in resolved) {
          console.error(`Authorization failed: ${resolved.error}`);
          process.exit(1);
        }
        authOptions = { principal: resolved.principal, snapshot: resolved.snapshot };
      }

      const result = await mergeIfReady(prNumber, policy, {
        method: options.method as 'merge' | 'squash' | 'rebase',
        ...authOptions,
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
