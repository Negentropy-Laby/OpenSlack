import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import {
  DeliveryError,
  GitHubDeliveryService,
  type GitHubDeliveryResult,
} from '@openslack/delivery';
import { resolveGitHubRepoTarget } from '@openslack/github';

export interface DeliveryCommandDependencies {
  publish?: (
    input: Parameters<GitHubDeliveryService['publish']>[0],
  ) => Promise<GitHubDeliveryResult>;
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
