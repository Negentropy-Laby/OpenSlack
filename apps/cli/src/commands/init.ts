import { basename, resolve } from 'node:path';
import { Command } from 'commander';
import {
  applyWorkspaceInit,
  planWorkspaceInit,
  renderWorkspaceInitPlan,
  validateWorkspace,
} from '@openslack/workspace';
import { resolveGitHubRepoTarget } from '@openslack/github';

export function initCommand(): Command {
  return new Command('init')
    .description('Initialize an ordinary Git repository as an OpenSlack workspace')
    .option('--root <path>', 'Target Git repository root', '.')
    .option('--name <name>', 'Workspace display name')
    .option('--repo <owner/repo>', 'GitHub repository; inferred from origin when omitted')
    .option('--default-branch <branch>', 'Canonical default branch', 'main')
    .option('--apply', 'Create the previewed files')
    .action((options) => {
      const targetRoot = resolve(String(options.root));
      try {
        const target = resolveGitHubRepoTarget({
          cwd: targetRoot,
          repoFullName: options.repo ? String(options.repo) : undefined,
        });
        const plan = planWorkspaceInit({
          targetRoot,
          name: String(options.name ?? basename(targetRoot)),
          owner: target.owner,
          repo: target.repo,
          defaultBranch: String(options.defaultBranch),
        });
        console.log(renderWorkspaceInitPlan(plan));
        if (!plan.applicable) {
          process.exitCode = 1;
          return;
        }
        if (!options.apply) return;
        applyWorkspaceInit(plan);
        const validation = validateWorkspace(targetRoot);
        if (!validation.valid) {
          console.error(
            'Workspace files were created but validation failed. Run openslack workspace validate.',
          );
          process.exitCode = 1;
          return;
        }
        console.log('Workspace initialized and validated.');
        console.log('Next: openslack agent-runtime setup openai-compatible ...');
      } catch (error) {
        console.error(error instanceof Error ? error.message : 'Workspace initialization failed.');
        process.exitCode = 1;
      }
    });
}
