import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { getClient, queryReadyItems } from '@openslack/github-provider';

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

      // Token check
      const token = process.env.GITHUB_TOKEN;
      checks.push({ name: 'GITHUB_TOKEN', passed: !!token, detail: token ? 'Set (masked)' : 'Not set — dry-run mode active' });

      // Remote check
      checks.push({ name: 'Git remote', passed: hasRemote(), detail: hasRemote() ? 'origin configured' : 'No remote' });

      // Integration config check
      const githubYaml = join(root, '.openslack', 'integrations', 'github.yaml');
      if (existsSync(githubYaml)) {
        const raw = readFileSync(githubYaml, 'utf-8');
        const hasNodeId = raw.includes('node_id:') && !raw.includes('node_id: ""') && !raw.includes('node_id: \'\'');
        checks.push({ name: 'Project node_id', passed: hasNodeId, detail: hasNodeId ? 'Configured' : 'Empty — Project v2 not connected' });
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
      console.log('Project inspect: requires `@octokit/graphql` or gh CLI.');
      console.log('Run: gh api graphql -f query=\'query { node(id: "PVT_...") { ... on ProjectV2 { fields(first:50) { nodes { ... on ProjectV2Field { id name } ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }\'');
    });

  cmd
    .command('project-sync-fields')
    .description('Sync field IDs from GitHub to local config')
    .action(async () => {
      console.log('Field sync: run `gh api graphql` to get field IDs, then update .openslack/integrations/github.yaml manually.');
      console.log('Automated sync not yet implemented (needs GraphQL field response parser).');
    });

  cmd
    .command('project-query-ready')
    .description('List Ready items from OpenSlack Evolution Board')
    .action(async () => {
      try {
        const client = getClient();
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

  return cmd;
}
