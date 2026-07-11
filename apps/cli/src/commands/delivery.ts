import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  DeliveryError,
  GitHubDeliveryProbe,
  GitHubDeliveryService,
  type GitHubDeliveryDiagnosticResult,
  type GitHubDeliveryProbeResult,
  type GitHubDeliveryResult,
} from '@openslack/delivery';
import { resolveGitHubRepoTarget } from '@openslack/github';

export interface DeliveryCommandDependencies {
  publish?: (
    input: Parameters<GitHubDeliveryService['publish']>[0],
  ) => Promise<GitHubDeliveryResult>;
  probe?: (input: Parameters<GitHubDeliveryProbe['run']>[0]) => Promise<GitHubDeliveryProbeResult>;
  cleanupRef?: (input: Parameters<GitHubDeliveryProbe['cleanupRef']>[0]) => Promise<void>;
  diagnose?: (
    input: Parameters<GitHubDeliveryProbe['diagnose']>[0],
  ) => Promise<GitHubDeliveryDiagnosticResult>;
}

export function deliveryCommands(dependencies: DeliveryCommandDependencies = {}): Command {
  const command = new Command('delivery').description(
    'Publish a branch and draft PR through one GitHub App installation identity',
  );
  command
    .command('publish')
    .requiredOption('--branch <branch>', 'Remote delivery branch')
    .requiredOption('--title <title>', 'Draft pull request title')
    .option('--body <body>', 'Draft pull request body')
    .option('--body-file <path>', 'Read the draft pull request body from a file')
    .option('--base <branch>', 'Base branch', 'main')
    .option('--remote <name>', 'Git remote', 'origin')
    .option('--repo <owner/repo>', 'Explicit GitHub repository')
    .option('--require-issues-write', 'Require full task-loop issues:write permission')
    .action(async (options) => {
      try {
        if (options.body && options.bodyFile) {
          throw new Error('Choose either --body or --body-file, not both.');
        }
        const rootDir = findRepoRoot();
        const body = options.bodyFile
          ? readFileSync(resolve(rootDir, String(options.bodyFile)), 'utf-8')
          : String(options.body ?? '');
        if (!body.trim()) {
          throw new Error('Pass --body or --body-file with a non-empty PR description.');
        }
        const target = resolveGitHubRepoTarget({ cwd: rootDir, repoFullName: options.repo });
        const publish =
          dependencies.publish ?? ((input) => new GitHubDeliveryService().publish(input));
        const result = await publish({
          rootDir,
          owner: target.owner,
          repo: target.repo,
          branch: String(options.branch),
          base: String(options.base),
          remote: String(options.remote),
          title: String(options.title),
          body,
          requireIssuesWrite: Boolean(options.requireIssuesWrite),
        });
        console.log(renderDeliveryResult(result));
      } catch (error) {
        console.error(renderDeliveryError(error));
        process.exitCode = 1;
      }
    });
  command
    .command('doctor')
    .description('Check GitHub App permissions and selected-repository installation scope')
    .option('--repo <owner/repo>', 'Explicit GitHub repository')
    .option('--require-issues-write', 'Require full task-loop issues:write permission')
    .action(async (options) => {
      try {
        const rootDir = findRepoRoot();
        const target = resolveGitHubRepoTarget({ cwd: rootDir, repoFullName: options.repo });
        const diagnose =
          dependencies.diagnose ?? ((input) => new GitHubDeliveryProbe().diagnose(input));
        const result = await diagnose({
          rootDir,
          owner: target.owner,
          repo: target.repo,
          requireIssuesWrite: Boolean(options.requireIssuesWrite),
        });
        console.log(renderDeliveryDiagnosticResult(result, target));
      } catch (error) {
        console.error(renderDeliveryError(error));
        process.exitCode = 1;
      }
    });
  command
    .command('probe')
    .description('Preview or run a temporary-ref GitHub App installation write probe')
    .option('--remote <name>', 'Git remote', 'origin')
    .option('--repo <owner/repo>', 'Explicit GitHub repository')
    .option('--require-issues-write', 'Require full task-loop issues:write permission')
    .option('--apply', 'Push and delete a temporary openslack/probes ref')
    .action(async (options) => {
      try {
        const rootDir = findRepoRoot();
        const target = resolveGitHubRepoTarget({ cwd: rootDir, repoFullName: options.repo });
        console.log('GitHub delivery probe preview');
        console.log(`- Repository: ${target.owner}/${target.repo}`);
        console.log('- Check installation repository scope and required write permissions');
        console.log('- Push current HEAD to a unique openslack/probes ref');
        console.log('- Delete and verify removal of that ref in the same operation');
        if (!options.apply) {
          console.log('No remote ref was written. Re-run with --apply after reviewing.');
          return;
        }
        const probe = dependencies.probe ?? ((input) => new GitHubDeliveryProbe().run(input));
        const result = await probe({
          rootDir,
          owner: target.owner,
          repo: target.repo,
          remote: String(options.remote),
          requireIssuesWrite: Boolean(options.requireIssuesWrite),
        });
        console.log(renderDeliveryProbeResult(result));
      } catch (error) {
        console.error(renderDeliveryError(error));
        process.exitCode = 1;
      }
    });
  command
    .command('cleanup-ref')
    .description('Preview or remove a stranded OpenSlack temporary probe ref')
    .requiredOption('--branch <branch>', 'Exact openslack/probes/write-* ref name')
    .option('--remote <name>', 'Git remote', 'origin')
    .option('--repo <owner/repo>', 'Explicit GitHub repository')
    .option('--apply', 'Delete and verify removal of the temporary ref')
    .action(async (options) => {
      try {
        const rootDir = findRepoRoot();
        const target = resolveGitHubRepoTarget({ cwd: rootDir, repoFullName: options.repo });
        const branch = String(options.branch);
        console.log(`Temporary ref cleanup preview: ${target.owner}/${target.repo} ${branch}`);
        if (!options.apply) {
          console.log('No remote ref was deleted. Re-run with --apply after reviewing.');
          return;
        }
        const cleanupRef =
          dependencies.cleanupRef ?? ((input) => new GitHubDeliveryProbe().cleanupRef(input));
        await cleanupRef({
          rootDir,
          owner: target.owner,
          repo: target.repo,
          remote: String(options.remote),
          branch,
        });
        console.log(`Temporary probe ref removed: ${branch}`);
      } catch (error) {
        console.error(renderDeliveryError(error));
        process.exitCode = 1;
      }
    });
  return command;
}

export function renderDeliveryError(error: unknown): string {
  if (error instanceof DeliveryError) return `${error.code}: ${error.message}`;
  if (error instanceof Error && isSafeInputError(error.message)) return error.message;
  return 'DELIVERY_FAILED: Governed GitHub delivery failed. See diagnostics for remediation.';
}

function isSafeInputError(message: string): boolean {
  return (
    message === 'Choose either --body or --body-file, not both.' ||
    message === 'Pass --body or --body-file with a non-empty PR description.'
  );
}

export function renderDeliveryResult(result: GitHubDeliveryResult): string {
  return [
    'GitHub Delivery',
    `State: ${result.state}`,
    `Operation: PR ${result.action}`,
    `PR: #${result.prNumber} ${result.prUrl}`,
    `Branch SHA: ${result.branchSha}`,
    `PR head SHA: ${result.prHeadSha}`,
    `Checks: ${result.checksStatus} (${result.checks.length})`,
    `Evidence time: ${result.evidenceTimestamp}`,
    `Next: openslack pr doctor ${result.prNumber}`,
  ].join('\n');
}

export function renderDeliveryProbeResult(result: GitHubDeliveryProbeResult): string {
  return [
    'GitHub Delivery Probe',
    `State: ${result.state}`,
    `Repository access: PASS (${result.repositoryAccess.totalAccessibleRepositories} accessible)`,
    `Permissions: ${result.permissions.map((check) => `${check.capability}:${check.status}`).join(', ')}`,
    `Temporary ref: ${result.probeRef}`,
    `Remote SHA: ${result.remoteSha}`,
    `Cleanup: ${result.cleanup}`,
    `Evidence time: ${result.evidenceTimestamp}`,
  ].join('\n');
}

function renderDeliveryDiagnosticResult(
  result: GitHubDeliveryDiagnosticResult,
  target: { owner: string; repo: string },
): string {
  return [
    'GitHub Delivery Doctor',
    `State: ${result.state}`,
    `Repository: ${target.owner}/${target.repo}`,
    `Installation scope: PASS (${result.repositoryAccess.totalAccessibleRepositories} accessible)`,
    `Permissions: ${result.permissions.map((check) => `${check.capability}:${check.status}`).join(', ')}`,
    `Evidence time: ${result.evidenceTimestamp}`,
    'Next: openslack delivery probe --apply',
  ].join('\n');
}

function findRepoRoot(): string {
  let current = resolve(process.cwd());
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(current, 'openslack.yaml')) || existsSync(join(current, '.git'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(process.cwd());
}
