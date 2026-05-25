import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { getClient, queryReadyItems } from '@openslack/github';
import { recordEvent } from '@openslack/collaboration';
import { buildAutoClaimFn } from './watch-auto-claim.js';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openslack.yaml'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function hasRemote(): boolean {
  try {
    execSync('git remote get-url origin', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function renderRepairResults(results: Array<{ fixed: boolean; planned?: boolean; detail: string; issueNumber?: number }>): void {
  if (results.length === 0) {
    console.log('No repair actions found.');
    return;
  }
  for (const r of results) {
    const label = r.fixed ? 'FIXED' : r.planned ? 'PLAN' : 'SKIP';
    const issue = r.issueNumber ? `Issue #${r.issueNumber}: ` : '';
    console.log(`  [${label}] ${issue}${r.detail}`);
  }
}

function recordGithubRepair(scope: string, results: Array<{ fixed: boolean; planned?: boolean }>, applied: boolean): void {
  try {
    const failed = results.some((r) => !r.fixed && !r.planned);
    recordEvent({
      type: failed ? 'repair.failed' : applied ? 'repair.applied' : 'repair.previewed',
      actor: { id: 'cli', kind: 'system', provider: 'cli' },
      object: { kind: 'workspace', id: `github:${scope}` },
      source: { kind: 'github', ref: `github.repair.${scope}` },
      summary: `${applied ? 'Applied' : 'Previewed'} GitHub ${scope} repair (${results.length} item(s))`,
      visibility: 'local',
      redacted: false,
      containsSensitiveData: false,
      risk: applied ? 'medium' : 'none',
    });
  } catch {
    // best-effort event recording
  }
}

export function githubCommands(): Command {
  const cmd = new Command('github').description('GitHub integration commands');

  cmd
    .command('doctor')
    .description('Check GitHub setup readiness')
    .action(async () => {
      const root = findRepoRoot();
      const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

      // Auth tier check
      let client;
      try {
        client = await getClient();
      } catch {
        client = { authMode: 'dry_run' as const, isDryRun: true, tokenExpiresAt: undefined };
      }
      const authTier = client.authMode === 'github_app_installation' ? 'GitHub App Installation Token' :
        client.authMode === 'token' ? 'PAT / GITHUB_TOKEN' : 'Dry-run (no credentials)';
      checks.push({
        name: 'Auth tier',
        passed: client.authMode !== 'dry_run',
        detail: `${authTier}${client?.tokenExpiresAt ? ` (expires: ${client.tokenExpiresAt})` : ''}`,
      });

      const appId = process.env.OPENSLACK_GITHUB_APP_ID;
      const installId = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID;
      const hasPrivateKey = !!process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY;
      if (appId || installId || hasPrivateKey) {
        checks.push({ name: 'GitHub App ID', passed: !!appId, detail: appId || 'Not set' });
        checks.push({ name: 'Installation ID', passed: !!installId, detail: installId || 'Not set' });
        checks.push({ name: 'Private key', passed: hasPrivateKey, detail: hasPrivateKey ? 'Set (masked)' : 'Not set' });
      }

      // Remote check
      checks.push({ name: 'Git remote', passed: hasRemote(), detail: hasRemote() ? 'origin configured' : 'No remote' });

      // Integration config check
      const githubYaml = join(root, '.openslack', 'integrations', 'github.yaml');
      if (existsSync(githubYaml)) {
        const raw = readFileSync(githubYaml, 'utf-8');
        const hasNodeId = raw.includes('node_id:') && !raw.includes('node_id: ""') && !raw.includes('node_id: \'\'');
        checks.push({ name: 'Project v2 (optional)', passed: true, detail: hasNodeId ? 'Configured' : 'Not configured — Project v2 is optional (issues-first default)' });
        checks.push({ name: 'Integration YAML', passed: true, detail: githubYaml });
      } else {
        checks.push({ name: 'Integration YAML', passed: false, detail: 'Missing: .openslack/integrations/github.yaml' });
      }

      // CODEOWNERS check
      const codeowners = join(root, '.github', 'CODEOWNERS');
      checks.push({ name: 'CODEOWNERS', passed: existsSync(codeowners), detail: existsSync(codeowners) ? 'Exists' : 'Missing' });

      // Branch protection (best-effort check)
      try {
        execSync('git branch --show-current', { stdio: 'pipe' });
        checks.push({ name: 'Branch protection', passed: true, detail: 'Cannot verify remotely — check GitHub Settings > Rules' });
      } catch {
        checks.push({ name: 'Branch protection', passed: false, detail: 'Cannot verify' });
      }

      console.log('GitHub Doctor\n');
      let allPassed = true;
      for (const c of checks) {
        const icon = c.passed ? 'PASS' : 'FAIL';
        console.log(`[${icon}] ${c.name}: ${c.detail}`);
        if (!c.passed) allPassed = false;
      }
      if (!allPassed) process.exit(1);
    });

  cmd
    .command('project-inspect')
    .description('Dump Project v2 fields and options')
    .action(async () => {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        console.log('[DRY RUN] Would query Project v2 fields via GraphQL');
        console.log('Set GITHUB_TOKEN to run for real.');
        return;
      }
      console.log('Project inspect: Project v2 is optional. To configure, create a project on GitHub then run:');
      console.log('  openslack setup github    # guided setup');
    });

  cmd
    .command('project-sync-fields')
    .description('Sync field IDs from GitHub to local config')
    .action(async () => {
      console.log('Field sync: Available when Project v2 is configured.');
      console.log('  openslack setup github    # guided project setup');
    });

  cmd
    .command('project-query-ready')
    .description('List Ready items from OpenSlack Evolution Board')
    .action(async () => {
      try {
        const client = await getClient();
        if (client.isDryRun) {
          console.log('[DRY RUN] Would query Ready items from Project v2');
          return;
        }
        const root = findRepoRoot();
        const githubYaml = join(root, '.openslack', 'integrations', 'github.yaml');
        if (!existsSync(githubYaml)) {
          console.error('No integration config found.');
          process.exit(1);
        }
        const raw = readFileSync(githubYaml, 'utf-8');
        const match = raw.match(/node_id:\s*["']?([^"'\n]+)["']?/);
        const nodeId = match?.[1]?.trim();
        if (!nodeId || nodeId === '') {
          console.error('Project node_id is empty. Configure it in .openslack/integrations/github.yaml');
          process.exit(1);
        }
        const items = await queryReadyItems(nodeId);
        if (items.length === 0) {
          console.log('No Ready items found.');
        } else {
          for (const item of items) {
            console.log(`  ${item.issueNodeId}: ${item.title} [${item.riskLevel}]`);
          }
        }
      } catch (e) {
        console.error(`Query failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command('issue-done')
    .description('Mark an issue as done and release its claim')
    .requiredOption('--issue-number <n>', 'Issue number')
    .option('--pr-url <url>', 'PR URL for the completion record')
    .action(async (options) => {
      try {
        const { releaseIssueClaim } = await import('@openslack/github');
        await releaseIssueClaim(parseInt(options.issueNumber, 10));
        console.log(`Issue #${options.issueNumber}: claim released, labels → done`);
        if (options.prUrl) {
          console.log(`  PR: ${options.prUrl}`);
        }
      } catch (e) {
        console.error(`Issue done failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command('repair-labels')
    .description('Preview or apply required OpenSlack label repair')
    .option('--apply', 'Apply label repair; default is dry-run')
    .action(async (options: { apply?: boolean }) => {
      try {
        const { repairLabels } = await import('@openslack/github');
        const results = await repairLabels({ dryRun: !options.apply });
        renderRepairResults(results);
        recordGithubRepair('labels', results, Boolean(options.apply));
        if (!options.apply) console.log('\nDry-run only. Re-run with --apply to mutate GitHub labels.');
      } catch (e) {
        console.error(`Repair labels failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command('repair-claims')
    .description('Preview or apply stale claim repair')
    .option('--apply', 'Apply claim repair; default is dry-run')
    .action(async (options: { apply?: boolean }) => {
      try {
        const { repairExpiredClaims } = await import('@openslack/github');
        const results = await repairExpiredClaims({ dryRun: !options.apply });
        renderRepairResults(results);
        recordGithubRepair('claims', results, Boolean(options.apply));
        if (!options.apply) console.log('\nDry-run only. Re-run with --apply to mutate claim refs and labels.');
      } catch (e) {
        console.error(`Repair claims failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command('repair-all')
    .description('Preview or apply all GitHub repair operations')
    .option('--apply', 'Apply repairs; default is dry-run')
    .action(async (options: { apply?: boolean }) => {
      try {
        const { repairLabels, repairExpiredClaims } = await import('@openslack/github');
        const labelResults = await repairLabels({ dryRun: !options.apply });
        console.log('--- Labels ---');
        renderRepairResults(labelResults);
        recordGithubRepair('labels', labelResults, Boolean(options.apply));
        const claimResults = await repairExpiredClaims({ dryRun: !options.apply });
        console.log('--- Claims ---');
        renderRepairResults(claimResults);
        recordGithubRepair('claims', claimResults, Boolean(options.apply));
        if (!options.apply) console.log('\nDry-run only. Re-run with --apply to mutate GitHub state.');
      } catch (e) {
        console.error(`Repair all failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  const repair = new Command('repair').description('Preview or apply GitHub repairs');

  repair
    .command('labels')
    .description('Preview or apply required label repair')
    .option('--apply', 'Apply label repair; default is dry-run')
    .action(async (options: { apply?: boolean }) => {
      const { repairLabels } = await import('@openslack/github');
      const results = await repairLabels({ dryRun: !options.apply });
      renderRepairResults(results);
      recordGithubRepair('labels', results, Boolean(options.apply));
      if (!options.apply) console.log('\nDry-run only. Re-run with --apply to mutate GitHub labels.');
    });

  repair
    .command('claims')
    .description('Preview or apply stale claim repair')
    .option('--apply', 'Apply claim repair; default is dry-run')
    .action(async (options: { apply?: boolean }) => {
      const { repairExpiredClaims } = await import('@openslack/github');
      const results = await repairExpiredClaims({ dryRun: !options.apply });
      renderRepairResults(results);
      recordGithubRepair('claims', results, Boolean(options.apply));
      if (!options.apply) console.log('\nDry-run only. Re-run with --apply to mutate claim refs and labels.');
    });

  repair
    .command('all')
    .description('Preview or apply all GitHub repairs')
    .option('--apply', 'Apply repairs; default is dry-run')
    .action(async (options: { apply?: boolean }) => {
      const { repairLabels, repairExpiredClaims } = await import('@openslack/github');
      console.log('--- Labels ---');
      const labelResults = await repairLabels({ dryRun: !options.apply });
      renderRepairResults(labelResults);
      recordGithubRepair('labels', labelResults, Boolean(options.apply));
      console.log('--- Claims ---');
      const claimResults = await repairExpiredClaims({ dryRun: !options.apply });
      renderRepairResults(claimResults);
      recordGithubRepair('claims', claimResults, Boolean(options.apply));
      if (!options.apply) console.log('\nDry-run only. Re-run with --apply to mutate GitHub state.');
    });

  cmd.addCommand(repair);

  // ── Watch daemon commands ──────────────────────────────────
  const watch = new Command('watch').description('GitHub repository watching');

  watch
    .command('start')
    .description('Start the GitHub watch daemon')
    .option('--config <path>', 'Config file path', '.openslack/monitors/github-watch.yaml')
    .option('--poll', 'Use polling instead of webhooks')
    .option('--poll-interval <seconds>', 'Polling interval in seconds', '300')
    .action(async (options: { config: string; poll?: boolean; pollInterval?: string }) => {
      const { loadGitHubWatchConfig, WatchDaemon } = await import('@openslack/github');
      const result = loadGitHubWatchConfig(options.config);
      if (!result.valid) {
        console.error('Invalid watch config:');
        for (const err of result.errors) console.error(`  ${err}`);
        process.exit(1);
      }
      const sinkOptions = {
        slackBotToken: process.env.OPENSLACK_SLACK_BOT_TOKEN,
        webhookUrl: process.env.OPENSLACK_DAEMON_WEBHOOK_URL,
      };

      const hasAutoClaim = result.config!.repositories.some((r) => r.auto_claim?.enabled);
      const autoClaimFn = hasAutoClaim ? buildAutoClaimFn(process.cwd()) : undefined;

      if (options.poll) {
        const daemon = new WatchDaemon(result.config!, '', undefined, sinkOptions, autoClaimFn);
        const intervalSeconds = parseInt(options.pollInterval ?? '300', 10);

        const shutdown = async () => {
          console.log('\nStopping GitHub Watch Polling Daemon...');
          await daemon.stop();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        await daemon.startPolling(intervalSeconds);
        console.log(`Polling ${result.config!.repositories.length} repo(s) every ${intervalSeconds}s. Press Ctrl+C to stop.`);
      } else {
        const secret = process.env.OPENSLACK_GITHUB_WEBHOOK_SECRET;
        if (!secret) {
          console.error('Missing OPENSLACK_GITHUB_WEBHOOK_SECRET environment variable');
          process.exit(1);
        }
        const daemon = new WatchDaemon(result.config!, secret, undefined, sinkOptions, autoClaimFn);
        const port = parseInt(process.env.OPENSLACK_GITHUB_WATCH_PORT ?? '3100', 10);

        const shutdown = async () => {
          console.log('\nStopping GitHub Watch Daemon...');
          await daemon.stop();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        await daemon.start(port);
        console.log(`Watching ${result.config!.repositories.length} repo(s). Press Ctrl+C to stop.`);
      }
    });

  watch
    .command('once')
    .description('Process a single issue event without starting the server')
    .requiredOption('--config <path>', 'Config file path')
    .requiredOption('--owner <owner>', 'Repository owner')
    .requiredOption('--repo <repo>', 'Repository name')
    .requiredOption('--issue-number <n>', 'Issue number')
    .requiredOption('--action <action>', 'Issue action (opened, reopened, labeled)')
    .action(async (options: { config: string; owner: string; repo: string; issueNumber: string; action: string }) => {
      const { loadGitHubWatchConfig, WatchDaemon } = await import('@openslack/github');
      type NormalizedIssueEvent = import('@openslack/github').NormalizedIssueEvent;
      const result = loadGitHubWatchConfig(options.config);
      if (!result.valid) {
        console.error('Invalid watch config:');
        for (const err of result.errors) console.error(`  ${err}`);
        process.exit(1);
      }
      const hasAutoClaim = result.config!.repositories.some((r) => r.auto_claim?.enabled);
      const autoClaimFn = hasAutoClaim ? buildAutoClaimFn(process.cwd()) : undefined;
      const daemon = new WatchDaemon(result.config!, '', undefined, undefined, autoClaimFn);
      const event: NormalizedIssueEvent = {
        action: options.action,
        owner: options.owner,
        repo: options.repo,
        issueNumber: parseInt(options.issueNumber, 10),
        title: '(manual test)',
        url: `https://github.com/${options.owner}/${options.repo}/issues/${options.issueNumber}`,
        labels: [],
        body: '',
        senderLogin: 'cli',
        deliveryId: '',
        updatedAt: new Date().toISOString(),
      };
      const collabEvent = await daemon.once(event);
      if (collabEvent) {
        console.log(`Event recorded: ${collabEvent.id} (${collabEvent.type})`);
      } else {
        console.log('No event recorded (filtered or duplicate).');
      }
    });

  watch
    .command('poll')
    .description('Run a single polling cycle across all configured repos')
    .requiredOption('--config <path>', 'Config file path')
    .action(async (options: { config: string }) => {
      const { loadGitHubWatchConfig, WatchDaemon } = await import('@openslack/github');
      const result = loadGitHubWatchConfig(options.config);
      if (!result.valid) {
        console.error('Invalid watch config:');
        for (const err of result.errors) console.error(`  ${err}`);
        process.exit(1);
      }
      const sinkOptions = {
        slackBotToken: process.env.OPENSLACK_SLACK_BOT_TOKEN,
        webhookUrl: process.env.OPENSLACK_DAEMON_WEBHOOK_URL,
      };
      const hasAutoClaim = result.config!.repositories.some((r) => r.auto_claim?.enabled);
      const autoClaimFn = hasAutoClaim ? buildAutoClaimFn(process.cwd()) : undefined;
      const daemon = new WatchDaemon(result.config!, '', undefined, sinkOptions, autoClaimFn);
      const pollResult = await daemon.pollAll();
      console.log(`Polled ${pollResult.reposPolled} repo(s), dispatched ${pollResult.eventsDispatched} event(s)`);
      if (pollResult.errors.length > 0) {
        for (const err of pollResult.errors) console.error(`  Error: ${err}`);
      }
    });

  watch
    .command('status')
    .description('Show watch daemon status')
    .action(async () => {
      const { WatchDedupeStore, WatchCursorStore } = await import('@openslack/github');
      const store = new WatchDedupeStore();
      const stats = store.getStats();
      console.log('GitHub Watch Daemon Status');
      console.log('══════════════════════════');
      console.log(`Processed events: ${stats.count}`);
      if (stats.lastTimestamp) console.log(`Last event: ${stats.lastTimestamp}`);
      else console.log('No events processed yet.');

      const cursorStore = new WatchCursorStore();
      const cursors = cursorStore.getAllCursors();
      if (Object.keys(cursors).length > 0) {
        console.log('\nPoll Cursors:');
        for (const [repo, cursor] of Object.entries(cursors)) {
          console.log(`  ${repo}: lastSeenAt=${cursor.lastSeenAt}, lastIssueNumber=${cursor.lastIssueNumber}`);
        }
      }
    });

  cmd.addCommand(watch);

  cmd
    .command('metrics')
    .description('Show OpenSlack task loop metrics')
    .action(async () => {
      try {
        const { queryReadyIssueTasks, getClient } = await import('@openslack/github');
        const client = await getClient();
        if (client.isDryRun) { console.log('[DRY RUN] Would compute metrics'); return; }
        const ready = await queryReadyIssueTasks();
        console.log(`Ready: ${ready.length}`);
        console.log('(Full metrics: claimed/running/review/done counts require label-based search.)');
      } catch (e) {
        console.error(`Metrics failed: ${(e as Error).message}`);
      }
    });

  return cmd;
}
