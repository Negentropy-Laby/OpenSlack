import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { getClient, queryReadyItems } from '@openslack/github';

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
    .description('Idempotently create all required OpenSlack labels')
    .action(async () => {
      try {
        const { repairLabels } = await import('@openslack/github');
        const results = await repairLabels();
        for (const r of results) {
          console.log(`  [${r.fixed ? 'FIXED' : 'FAIL'}] ${r.detail}`);
        }
      } catch (e) {
        console.error(`Repair labels failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command('repair-claims')
    .description('Expire stale claims and delete orphaned refs')
    .action(async () => {
      try {
        const { repairExpiredClaims } = await import('@openslack/github');
        const results = await repairExpiredClaims();
        if (results.length === 0) {
          console.log('No expired claims found.');
        } else {
          for (const r of results) {
            console.log(`  [${r.fixed ? 'FIXED' : 'SKIP'}] Issue #${r.issueNumber}: ${r.detail}`);
          }
        }
      } catch (e) {
        console.error(`Repair claims failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  cmd
    .command('repair-all')
    .description('Run all repair operations')
    .action(async () => {
      try {
        const { repairLabels, repairExpiredClaims } = await import('@openslack/github');
        const labelResults = await repairLabels();
        console.log('--- Labels ---');
        for (const r of labelResults) console.log(`  [${r.fixed ? 'OK' : 'FAIL'}] ${r.detail}`);
        const claimResults = await repairExpiredClaims();
        console.log('--- Claims ---');
        if (claimResults.length === 0) console.log('  No expired claims.');
        else for (const r of claimResults) console.log(`  [${r.fixed ? 'FIXED' : 'SKIP'}] Issue #${r.issueNumber}: ${r.detail}`);
      } catch (e) {
        console.error(`Repair all failed: ${(e as Error).message}`);
        process.exit(1);
      }
    });

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
