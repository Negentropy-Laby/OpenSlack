import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  bindGitHubAppInstallation,
  completeClaim,
  defaultGitHubAppManifestRefs,
  diagnoseGitHubAppInstallation,
  getClient,
  heartbeatClaim,
  queryReadyItems,
  readGitHubAppLocalConfig,
  renderClaimLifecycleResult,
  resolveGitHubRepoTarget,
  reviewClaim,
} from '@openslack/github';
import type {
  ClaimLifecycleResult,
  GitHubAppInstallationDiagnosticReport,
} from '@openslack/github';
import { recordEvent as _recordEvent } from '@openslack/collaboration';
import type { RecordEventFn } from '@openslack/github';
import { createDefaultCredentialStore, type CredentialStore } from '@openslack/credentials';
import { resolveWorkspaceContext } from '@openslack/workspace';
import { renderGitHubAppInstallationDiagnostic } from './github-app-diagnostic.js';
const recordEvent = _recordEvent as unknown as RecordEventFn;
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

function renderRepairResults(
  results: Array<{ fixed: boolean; planned?: boolean; detail: string; issueNumber?: number }>,
): void {
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

function recordGithubRepair(
  scope: string,
  results: Array<{ fixed: boolean; planned?: boolean }>,
  applied: boolean,
): void {
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

function positiveInteger(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function printClaimLifecycleResult(result: ClaimLifecycleResult): void {
  const output = renderClaimLifecycleResult(result);
  if (result.outcome === 'completed') console.log(output);
  else {
    console.error(output);
    process.exitCode = 1;
  }
}

export interface GitHubCommandDependencies {
  credentialStore?: CredentialStore;
  getMetricsClient?: () => Promise<{ isDryRun: boolean }>;
  queryReadyMetrics?: () => Promise<readonly unknown[]>;
  getDoctorClient?: typeof getClient;
  diagnoseAppInstallation?: typeof diagnoseGitHubAppInstallation;
  startAppManifestServer?: (options: {
    workspaceRoot: string;
    organization: string;
    appName?: string;
    port?: number;
    homepageUrl?: string;
    webhookUrl?: string;
    credentialStore?: CredentialStore;
  }) => Promise<{ status: 'completed' | 'timed_out'; appId?: string; appSlug?: string }>;
}

export function githubCommands(dependencies: GitHubCommandDependencies = {}): Command {
  const cmd = new Command('github').description('GitHub integration commands');

  const app = cmd.command('app').description('Configure an organization-owned GitHub App');
  app
    .command('create')
    .description('Preview or start the loopback GitHub App Manifest flow')
    .requiredOption('--org <organization>', 'Organization that will own the GitHub App')
    .option('--name <name>', 'GitHub App name', 'OpenSlack Agent Operator')
    .option('--port <number>', 'Loopback callback port', '8200')
    .option('--homepage-url <https-url>', 'GitHub App homepage; defaults to target repository')
    .option('--webhook-url <https-url>', 'Webhook URL; delivery is disabled initially')
    .option('--apply', 'Start the loopback server after preview')
    .action(async (options) => {
      try {
        const port = Number.parseInt(String(options.port), 10);
        if (!Number.isInteger(port) || port < 1 || port > 65_535) {
          throw new Error('GitHub App Manifest callback port is invalid.');
        }
        const organization = String(options.org);
        const appName = String(options.name);
        const root = findRepoRoot();
        const homepageUrl = options.homepageUrl
          ? String(options.homepageUrl)
          : resolveManifestHomepage(root, organization);
        const refs = defaultGitHubAppManifestRefs(root);
        console.log('GitHub App Manifest preview');
        console.log(`- Owner: ${organization}`);
        console.log(`- App: ${appName}`);
        console.log(`- Homepage: ${homepageUrl}`);
        console.log(`- Callback: http://127.0.0.1:${port}/callback`);
        console.log(
          '- Permissions: metadata:read, contents:write, issues:write, pull_requests:write, workflows:write, checks:read',
        );
        console.log(
          '- Events: issues, pull_request, pull_request_review, push, check_run, check_suite',
        );
        console.log(`- Private key: ${refs.privateKeyRef}`);
        console.log(`- Webhook secret: ${refs.webhookSecretRef}`);
        console.log(`- Client secret: ${refs.clientSecretRef}`);
        if (!options.apply) {
          console.log('No server was started and no credential was written. Re-run with --apply.');
          return;
        }
        const start =
          dependencies.startAppManifestServer ??
          (await import('@openslack/auth-callback')).startAuthServer;
        const result = await start({
          workspaceRoot: root,
          organization,
          appName,
          port,
          homepageUrl,
          webhookUrl: options.webhookUrl ? String(options.webhookUrl) : undefined,
          credentialStore:
            dependencies.credentialStore ?? createDefaultCredentialStore(process.env),
        });
        if (result.status === 'timed_out') {
          throw new Error('GitHub App Manifest setup timed out without changing credentials.');
        }
        console.log(`GitHub App created: ${result.appSlug} (${result.appId})`);
        console.log(
          'Install the App on the selected repository, then run openslack github doctor.',
        );
      } catch (error) {
        console.error(
          error instanceof Error && error.message.startsWith('GitHub App Manifest')
            ? error.message
            : 'GitHub App Manifest setup failed safely.',
        );
        process.exitCode = 1;
      }
    });
  app
    .command('import')
    .description('Preview or import an existing App private key into the configured keychain')
    .requiredOption('--source <path>', 'Existing PEM source path; never pass PEM content in argv')
    .requiredOption('--app-id <id>', 'GitHub App ID')
    .requiredOption('--installation-id <id>', 'GitHub App installation ID')
    .requiredOption('--slug <slug>', 'GitHub App slug')
    .requiredOption('--key-ref <keychain:service/account>', 'Writable keychain reference')
    .option('--delete-source', 'Best-effort source deletion after successful storage')
    .option('--apply', 'Read and import the source after preview')
    .action(async (options) => {
      try {
        const root = findRepoRoot();
        const context = resolveWorkspaceContext({ workspaceRoot: root });
        const { applyGitHubAppImport, planGitHubAppImport } = await import('@openslack/github');
        const plan = planGitHubAppImport({
          localStateRoot: context.localStateRoot,
          sourcePath: String(options.source),
          appId: String(options.appId),
          installationId: String(options.installationId),
          appSlug: String(options.slug),
          privateKeyRef: String(options.keyRef),
          deleteSource: Boolean(options.deleteSource),
        });
        console.log('GitHub App import preview');
        for (const line of plan.summary) console.log(`- ${line}`);
        if (!options.apply) {
          console.log('No credential was read or written. Re-run with --apply after reviewing.');
          return;
        }
        const result = applyGitHubAppImport(plan, {
          credentialStore:
            dependencies.credentialStore ?? createDefaultCredentialStore(process.env),
        });
        console.log(`GitHub App reference stored: ${result.privateKeyRef}`);
        console.log(`Local config: ${result.configPath}`);
        for (const warning of result.warnings) console.log(`[WARN] ${warning}`);
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'GitHub App import failed.');
        process.exitCode = 1;
      }
    });

  app
    .command('bind-installation')
    .description('Bind a completed App Manifest setup to its installation ID')
    .requiredOption('--installation-id <id>', 'GitHub App installation ID')
    .option('--apply', 'Write the non-secret installation ID to local config')
    .action((options) => {
      try {
        const root = findRepoRoot();
        const context = resolveWorkspaceContext({ workspaceRoot: root });
        const installationId = String(options.installationId);
        const config = readGitHubAppLocalConfig(context.localStateRoot);
        if (!config) throw new Error('GitHub App local configuration is missing.');
        console.log('GitHub App installation binding preview');
        console.log(`- App: ${config.appSlug} (${config.appId})`);
        console.log(`- Installation ID: ${installationId}`);
        if (!options.apply) {
          console.log('No local config was changed. Re-run with --apply after verification.');
          return;
        }
        const result = bindGitHubAppInstallation(context.localStateRoot, installationId);
        console.log(
          result.changed
            ? 'GitHub App installation binding saved.'
            : 'GitHub App installation binding already matches.',
        );
      } catch (error) {
        console.error(
          error instanceof Error ? error.message : 'GitHub App installation binding failed.',
        );
        process.exitCode = 1;
      }
    });

  cmd
    .command('doctor')
    .description('Check GitHub setup readiness')
    .action(async () => {
      const root = findRepoRoot();
      const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
      let appDiagnostic: GitHubAppInstallationDiagnosticReport | null = null;

      // Auth tier check
      let client;
      try {
        client = await (dependencies.getDoctorClient ?? getClient)({
          cwd: root,
          credentialStore: dependencies.credentialStore,
        });
      } catch {
        client = { authMode: 'dry_run' as const, isDryRun: true, tokenExpiresAt: undefined };
      }
      const authTier =
        client.authMode === 'github_app_installation'
          ? 'GitHub App Installation Token'
          : client.authMode === 'token'
            ? 'PAT / GITHUB_TOKEN'
            : 'Dry-run (no credentials)';
      checks.push({
        name: 'Auth tier',
        passed: client.authMode !== 'dry_run',
        detail: `${authTier}${client?.tokenExpiresAt ? ` (expires: ${client.tokenExpiresAt})` : ''}`,
      });

      if (client.authMode === 'github_app_installation') {
        try {
          const context = resolveWorkspaceContext({ workspaceRoot: root });
          appDiagnostic = await (
            dependencies.diagnoseAppInstallation ?? diagnoseGitHubAppInstallation
          )({
            owner: client.owner,
            repo: client.repo,
            localStateRoot: context.localStateRoot,
            credentialStore: dependencies.credentialStore,
          });
          checks.push({
            name: 'GitHub App installation',
            passed: appDiagnostic.ready,
            detail: appDiagnostic.codes.join(', '),
          });
        } catch {
          checks.push({
            name: 'GitHub App installation',
            passed: false,
            detail:
              'APP_INSTALLATION_DIAGNOSTIC_FAILED — App JWT installation inspection failed safely',
          });
        }
      }

      try {
        const context = resolveWorkspaceContext({ workspaceRoot: root });
        const localConfig = readGitHubAppLocalConfig(context.localStateRoot);
        if (localConfig) {
          checks.push({
            name: 'GitHub App local config',
            passed: true,
            detail: `${localConfig.appSlug} (${localConfig.appId}); private key reference configured`,
          });
          checks.push({
            name: 'Local installation binding',
            passed: localConfig.installationId !== null,
            detail:
              localConfig.installationId === null
                ? 'Not bound — run github app bind-installation after installing the App'
                : `Installation ${localConfig.installationId}`,
          });
        }
      } catch {
        checks.push({
          name: 'GitHub App local config',
          passed: false,
          detail: 'Invalid local App metadata; no credential value was read',
        });
      }

      const appId = process.env.OPENSLACK_GITHUB_APP_ID;
      const installId = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID;
      const hasPrivateKey = !!process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY;
      if (appId || installId || hasPrivateKey) {
        checks.push({ name: 'GitHub App ID', passed: !!appId, detail: appId || 'Not set' });
        checks.push({
          name: 'Installation ID',
          passed: !!installId,
          detail: installId || 'Not set',
        });
        checks.push({
          name: 'Private key',
          passed: hasPrivateKey,
          detail: hasPrivateKey ? 'Set (masked)' : 'Not set',
        });
      }

      // Remote check
      checks.push({
        name: 'Git remote',
        passed: hasRemote(),
        detail: hasRemote() ? 'origin configured' : 'No remote',
      });

      // Integration config check
      const githubYaml = join(root, '.openslack', 'integrations', 'github.yaml');
      if (existsSync(githubYaml)) {
        const raw = readFileSync(githubYaml, 'utf-8');
        const hasNodeId =
          raw.includes('node_id:') && !raw.includes('node_id: ""') && !raw.includes("node_id: ''");
        checks.push({
          name: 'Project v2 (optional)',
          passed: true,
          detail: hasNodeId
            ? 'Configured'
            : 'Not configured — Project v2 is optional (issues-first default)',
        });
        checks.push({ name: 'Integration YAML', passed: true, detail: githubYaml });
      } else {
        checks.push({
          name: 'Integration YAML',
          passed: false,
          detail: 'Missing: .openslack/integrations/github.yaml',
        });
      }

      // CODEOWNERS check
      const codeowners = join(root, '.github', 'CODEOWNERS');
      checks.push({
        name: 'CODEOWNERS',
        passed: existsSync(codeowners),
        detail: existsSync(codeowners) ? 'Exists' : 'Missing',
      });

      // Branch protection (best-effort check)
      try {
        execSync('git branch --show-current', { stdio: 'pipe' });
        checks.push({
          name: 'Branch protection',
          passed: true,
          detail: 'Cannot verify remotely — check GitHub Settings > Rules',
        });
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
      if (appDiagnostic) {
        console.log('');
        console.log(renderGitHubAppInstallationDiagnostic(appDiagnostic));
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
      console.log(
        'Project inspect: Project v2 is optional. To configure, create a project on GitHub then run:',
      );
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
          console.error(
            'Project node_id is empty. Configure it in .openslack/integrations/github.yaml',
          );
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

  const claim = new Command('claim').description(
    'Manage claim heartbeat, review, and completion with verified postconditions',
  );

  claim
    .command('heartbeat')
    .description('Extend a claim lease after verifying the ref and owner')
    .requiredOption('--issue-number <n>', 'Issue number')
    .requiredOption('--agent-id <id>', 'Claim owner agent ID')
    .option('--ttl-minutes <n>', 'Lease extension in minutes (1-120)', '60')
    .action(async (options: { issueNumber: string; agentId: string; ttlMinutes: string }) => {
      const issueNumber = positiveInteger(options.issueNumber);
      const ttlMinutes = positiveInteger(options.ttlMinutes);
      if (!issueNumber || !ttlMinutes || ttlMinutes > 120) {
        console.error('CLAIM_INVALID_INPUT: issue number and TTL must be valid positive integers.');
        process.exitCode = 1;
        return;
      }
      try {
        printClaimLifecycleResult(
          await heartbeatClaim({ issueNumber, agentId: options.agentId, ttlMinutes }),
        );
      } catch {
        console.error('CLAIM_API_UNAVAILABLE: claim heartbeat failed safely.');
        process.exitCode = 1;
      }
    });

  claim
    .command('review')
    .description('Move a claimed Issue to review and verify its PR evidence')
    .requiredOption('--issue-number <n>', 'Issue number')
    .requiredOption('--agent-id <id>', 'Claim owner agent ID')
    .requiredOption('--pr-url <url>', 'Canonical GitHub pull request URL')
    .action(async (options: { issueNumber: string; agentId: string; prUrl: string }) => {
      const issueNumber = positiveInteger(options.issueNumber);
      if (!issueNumber) {
        console.error('CLAIM_INVALID_INPUT: issue number must be a positive integer.');
        process.exitCode = 1;
        return;
      }
      try {
        printClaimLifecycleResult(
          await reviewClaim({ issueNumber, agentId: options.agentId, prUrl: options.prUrl }),
        );
      } catch {
        console.error('CLAIM_API_UNAVAILABLE: claim review transition failed safely.');
        process.exitCode = 1;
      }
    });

  claim
    .command('complete')
    .description('Complete a claimed Issue and verify its final state')
    .requiredOption('--issue-number <n>', 'Issue number')
    .requiredOption('--agent-id <id>', 'Claim owner agent ID')
    .requiredOption('--pr-url <url>', 'Canonical GitHub pull request URL')
    .action(async (options: { issueNumber: string; agentId: string; prUrl: string }) => {
      const issueNumber = positiveInteger(options.issueNumber);
      if (!issueNumber) {
        console.error('CLAIM_INVALID_INPUT: issue number must be a positive integer.');
        process.exitCode = 1;
        return;
      }
      try {
        printClaimLifecycleResult(
          await completeClaim({ issueNumber, agentId: options.agentId, prUrl: options.prUrl }),
        );
      } catch {
        console.error('CLAIM_API_UNAVAILABLE: claim completion failed safely.');
        process.exitCode = 1;
      }
    });

  cmd.addCommand(claim);

  cmd
    .command('issue-done')
    .description('Deprecated compatibility alias for github claim complete')
    .requiredOption('--issue-number <n>', 'Issue number')
    .requiredOption('--agent-id <id>', 'Claim owner agent ID')
    .requiredOption('--pr-url <url>', 'Canonical GitHub pull request URL')
    .action(async (options: { issueNumber: string; agentId: string; prUrl: string }) => {
      const issueNumber = positiveInteger(options.issueNumber);
      if (!issueNumber) {
        console.error('CLAIM_INVALID_INPUT: issue number must be a positive integer.');
        process.exitCode = 1;
        return;
      }
      try {
        console.warn(
          'Deprecated: use `openslack github claim complete --issue-number <n> --agent-id <id> --pr-url <url>`.',
        );
        printClaimLifecycleResult(
          await completeClaim({ issueNumber, agentId: options.agentId, prUrl: options.prUrl }),
        );
      } catch {
        console.error('CLAIM_API_UNAVAILABLE: claim completion failed safely.');
        process.exitCode = 1;
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
        if (!options.apply)
          console.log('\nDry-run only. Re-run with --apply to mutate GitHub labels.');
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
        if (!options.apply)
          console.log('\nDry-run only. Re-run with --apply to mutate claim refs and labels.');
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
        if (!options.apply)
          console.log('\nDry-run only. Re-run with --apply to mutate GitHub state.');
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
      if (!options.apply)
        console.log('\nDry-run only. Re-run with --apply to mutate GitHub labels.');
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
      if (!options.apply)
        console.log('\nDry-run only. Re-run with --apply to mutate claim refs and labels.');
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
      if (!options.apply)
        console.log('\nDry-run only. Re-run with --apply to mutate GitHub state.');
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
      const { recordEvent: _rec } = await import('@openslack/collaboration');
      const recordEvent = _rec as unknown as import('@openslack/github').RecordEventFn;
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
        const daemon = new WatchDaemon(
          result.config!,
          '',
          undefined,
          sinkOptions,
          autoClaimFn,
          recordEvent,
        );
        const intervalSeconds = parseInt(options.pollInterval ?? '300', 10);

        const shutdown = async () => {
          console.log('\nStopping GitHub Watch Polling Daemon...');
          await daemon.stop();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        await daemon.startPolling(intervalSeconds);
        console.log(
          `Polling ${result.config!.repositories.length} repo(s) every ${intervalSeconds}s. Press Ctrl+C to stop.`,
        );
      } else {
        const secret = process.env.OPENSLACK_GITHUB_WEBHOOK_SECRET;
        if (!secret) {
          console.error('Missing OPENSLACK_GITHUB_WEBHOOK_SECRET environment variable');
          process.exit(1);
        }
        const daemon = new WatchDaemon(
          result.config!,
          secret,
          undefined,
          sinkOptions,
          autoClaimFn,
          recordEvent,
        );
        const port = parseInt(process.env.OPENSLACK_GITHUB_WATCH_PORT ?? '3100', 10);

        const shutdown = async () => {
          console.log('\nStopping GitHub Watch Daemon...');
          await daemon.stop();
          process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        await daemon.start(port);
        console.log(
          `Watching ${result.config!.repositories.length} repo(s). Press Ctrl+C to stop.`,
        );
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
    .action(
      async (options: {
        config: string;
        owner: string;
        repo: string;
        issueNumber: string;
        action: string;
      }) => {
        const { loadGitHubWatchConfig, WatchDaemon } = await import('@openslack/github');
        const { recordEvent: _rec } = await import('@openslack/collaboration');
        const recordEvent = _rec as unknown as import('@openslack/github').RecordEventFn;
        type NormalizedIssueEvent = import('@openslack/github').NormalizedIssueEvent;
        const result = loadGitHubWatchConfig(options.config);
        if (!result.valid) {
          console.error('Invalid watch config:');
          for (const err of result.errors) console.error(`  ${err}`);
          process.exit(1);
        }
        const hasAutoClaim = result.config!.repositories.some((r) => r.auto_claim?.enabled);
        const autoClaimFn = hasAutoClaim ? buildAutoClaimFn(process.cwd()) : undefined;
        const daemon = new WatchDaemon(
          result.config!,
          '',
          undefined,
          undefined,
          autoClaimFn,
          recordEvent,
        );
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
      },
    );

  watch
    .command('poll')
    .description('Run a single polling cycle across all configured repos')
    .requiredOption('--config <path>', 'Config file path')
    .action(async (options: { config: string }) => {
      const { loadGitHubWatchConfig, WatchDaemon } = await import('@openslack/github');
      const { recordEvent: _rec } = await import('@openslack/collaboration');
      const recordEvent = _rec as unknown as import('@openslack/github').RecordEventFn;
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
      const daemon = new WatchDaemon(
        result.config!,
        '',
        undefined,
        sinkOptions,
        autoClaimFn,
        recordEvent,
      );
      const pollResult = await daemon.pollAll();
      console.log(
        `Polled ${pollResult.reposPolled} repo(s), dispatched ${pollResult.eventsDispatched} event(s)`,
      );
      if (pollResult.errors.length > 0) {
        for (const err of pollResult.errors) console.error(`  Error: ${err}`);
      }
    });

  watch
    .command('status')
    .description('Show watch daemon status')
    .action(async () => {
      const { WatchDeliveryQueue, WatchCursorStore } = await import('@openslack/github');
      const store = new WatchDeliveryQueue();
      const stats = store.getStats();
      console.log('GitHub Watch Daemon Status');
      console.log('══════════════════════════');
      console.log(`Delivery records: ${stats.count}`);
      console.log(`  Pending: ${stats.pending}`);
      console.log(`  Processing: ${stats.processing}`);
      console.log(`  Retryable: ${stats.retryable}`);
      console.log(`  Completed: ${stats.completed}`);
      console.log(`  Failed: ${stats.failed}`);
      console.log(`  Active leases: ${stats.activeLeases}`);
      if (stats.nextRetryAt) console.log(`Next retry: ${stats.nextRetryAt}`);
      if (stats.oldestPendingAt) console.log(`Oldest pending: ${stats.oldestPendingAt}`);
      if (stats.lastFailure) {
        console.log(`Last failure: ${stats.lastFailure.code} (${stats.lastFailure.recordedAt})`);
      }
      if (stats.lastTimestamp) console.log(`Last event: ${stats.lastTimestamp}`);
      else console.log('No events processed yet.');

      const cursorStore = new WatchCursorStore();
      const cursors = cursorStore.getAllCursors();
      if (Object.keys(cursors).length > 0) {
        console.log('\nPoll Cursors:');
        for (const [repo, cursor] of Object.entries(cursors)) {
          console.log(
            `  ${repo}: lastSeenAt=${cursor.lastSeenAt}, lastIssueNumber=${cursor.lastIssueNumber}`,
          );
        }
      }
    });

  cmd.addCommand(watch);

  cmd
    .command('metrics')
    .description('Show OpenSlack task loop metrics')
    .action(async () => {
      try {
        const getMetricsClient = dependencies.getMetricsClient ?? getClient;
        const queryReadyMetrics =
          dependencies.queryReadyMetrics ??
          (async () => {
            const { queryReadyIssueTasks } = await import('@openslack/github');
            return queryReadyIssueTasks();
          });
        const client = await getMetricsClient();
        if (client.isDryRun) {
          console.log('[DRY RUN] Would compute metrics');
          return;
        }
        const ready = await queryReadyMetrics();
        console.log(`Ready: ${ready.length}`);
        console.log(
          '(Full metrics: claimed/running/review/done counts require label-based search.)',
        );
      } catch {
        console.error('Metrics failed: task-loop metrics are unavailable.');
        process.exitCode = 1;
      }
    });

  return cmd;
}

function resolveManifestHomepage(root: string, organization: string): string {
  try {
    const target = resolveGitHubRepoTarget({ cwd: root });
    return `https://github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  } catch {
    return `https://github.com/${encodeURIComponent(organization)}`;
  }
}
