import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapAgent, resolveAgentPrincipal, hireAgent } from '@openslack/runtime';
import { tickAgent, validateTickTargetOptions } from '@openslack/runtime';
import type { TickOptions, TickResult } from '@openslack/runtime';
import { migrateRegistry } from '@openslack/workspace';

export interface AgentCommandDependencies {
  tickAgent?: (agentId: string, options?: TickOptions) => Promise<TickResult>;
}

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

export function agentCommands(dependencies: AgentCommandDependencies = {}): Command {
  const cmd = new Command('agent').description('Agent lifecycle commands');

  cmd
    .command('hire')
    .description('Hire a new agent and create onboarding package')
    .requiredOption('--agent-id <id>', 'Agent ID (e.g. codex_developer_ci-bot)')
    .option('--display-name <name>', 'Display name')
    .option('--department <dept>', 'Department', 'engineering')
    .option('--role <role>', 'Role', 'developer')
    .option('--runtime <runtime>', 'Runtime: claude_code, codex, custom_runner', 'claude_code')
    .option('--manager <id>', 'Manager ID', 'human:founder')
    .option('--github-owner <owner>', 'GitHub owner', 'wsman')
    .option('--github-repo <repo>', 'GitHub repo', 'OpenSlack')
    .option('--project-number <n>', 'GitHub Project number', '1')
    .action((options) => {
      process.exitCode = undefined;
      try {
        const result = hireAgent({ rootDir: findRepoRoot(), ...options });
        console.log(`Agent ${result.agentId} hired successfully.`);
        console.log(`  Registry: .openslack/agents/registry/${result.agentId}.yaml`);
        console.log(`  Entrypoint: ${result.entrypoint}`);
        console.log(`  Onboarding: .openslack/agents/onboarding/${result.agentId}/`);
        console.log(
          'Manual execution only. Administrator review and local identity setup are required.',
        );
        console.log(
          `  1. Create local identity in .openslack.local/agents/${result.agentId}/identity.yaml`,
        );
        console.log(
          '  2. Have the administrator configure runtime and bot authentication through the supported setup path.',
        );
        console.log(`  3. Run: bun run openslack agent bootstrap --agent-id ${result.agentId}`);
      } catch (error) {
        console.error((error as Error).message);
        process.exitCode = 1;
      }
    });

  cmd
    .command('bootstrap')
    .description('Verify agent is ready to work')
    .requiredOption('--agent-id <id>', 'Agent ID')
    .action(async (options) => {
      const root = findRepoRoot();
      const result = bootstrapAgent(options.agentId);
      console.log(`Agent bootstrap: ${result.agentId}`);
      for (const check of result.checks) {
        console.log(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
      }

      // Additional v2 identity and runtime identity checks
      try {
        const resolved = resolveAgentPrincipal({ root, agentId: options.agentId, provider: 'cli' });
        if ('error' in resolved) {
          console.log(`  [WARN] Identity resolution: ${resolved.error}`);
        } else {
          console.log(
            `  [PASS] Principal resolved: ${resolved.principal.registry_id} run=${resolved.principal.run_id}`,
          );
          console.log(`  [PASS] Permission snapshot source: ${resolved.snapshot.source}`);
        }
      } catch (err) {
        console.log(`  [WARN] Identity resolution: ${(err as Error).message}`);
      }

      if (result.passed) {
        console.log('\nBootstrap: PASSED — agent is ready to work.');
      } else {
        console.log('\nBootstrap: FAILED — fix the issues above before running agent tick.');
        process.exit(1);
      }
    });

  cmd
    .command('tick')
    .description('Run one agent work cycle')
    .requiredOption('--agent-id <id>', 'Agent ID')
    .option('--source <source>', 'Task source: local, github-issues', 'local')
    .option('--issue-number <n>', 'Claim one exact GitHub Issue number')
    .action(async (options) => {
      process.exitCode = undefined;
      const source = options.source as TickOptions['source'];
      const targetOptions = validateTickTargetOptions({
        source,
        issueNumber: options.issueNumber as string | undefined,
      });
      if (!targetOptions.valid) {
        console.error(targetOptions.message);
        process.exitCode = 1;
        return;
      }
      const issueNumber = targetOptions.issueNumber;
      const runTick = dependencies.tickAgent ?? tickAgent;
      const result = await runTick(options.agentId, { source, issueNumber });
      console.log(`Agent tick: ${result.agentId}`);
      console.log(`  Source: ${source}`);
      if (issueNumber !== undefined) console.log(`  Target Issue: #${issueNumber}`);
      console.log(`  Action: ${result.action}`);
      if (result.principal)
        console.log(`  Principal: ${result.principal.registry_id} run=${result.principal.run_id}`);
      if (result.taskId) console.log(`  Task: ${result.taskId}`);
      if (result.leaseId) console.log(`  Claim: ${result.leaseId}`);
      if (result.lease) {
        console.log(`  Expires: ${result.lease.expiresAt}`);
        console.log(`  Heartbeat: every ${result.lease.heartbeatMinutes} minutes`);
        console.log(`  Next heartbeat: ${result.lease.nextHeartbeatAt}`);
      }
      for (const rejection of result.candidateRejections ?? []) {
        console.warn(
          `  Rejected #${rejection.issueNumber} [${rejection.code}]: ${rejection.reason}`,
        );
      }
      if (result.projection?.status === 'repair_required') {
        console.warn(
          `  Claim label projection requires repair: ${result.projection.recoveryCommand}`,
        );
      }
      console.log(`  ${result.message}`);
      if (result.action === 'error') process.exitCode = 1;
    });

  cmd
    .command('migrate-registry')
    .description('Migrate v1 agent registry entries to v2 schema')
    .option('--preview', 'Show what would change without writing', false)
    .option('--apply', 'Write converted entries (backs up v1 files)', false)
    .action((options) => {
      const root = findRepoRoot();
      const apply = options.apply === true;
      if (!apply && !options.preview) {
        console.error('Specify --preview to see changes or --apply to write them.');
        process.exit(1);
      }
      const results = migrateRegistry(root, { apply });
      if (results.length === 0) {
        console.log('No agent registry entries found.');
        return;
      }
      const errors = results.filter((r) => r.status === 'error').length;
      const writeBlocked = apply && errors > 0;
      for (const r of results) {
        if (r.status === 'converted') {
          const suffix = apply
            ? writeBlocked
              ? ' (blocked; not written)'
              : ' (written)'
            : ' (preview)';
          console.log(`[CONVERT] ${r.agentId}: v1 → v2${suffix}`);
        } else if (r.status === 'already_v2') {
          console.log(`[OK] ${r.agentId}: already v2`);
        } else {
          console.log(`[ERROR] ${r.agentId}: ${r.error}`);
        }
      }
      const converted = results.filter((r) => r.status === 'converted').length;
      console.log(
        `\n${converted} converted, ${results.length - converted - errors} already v2, ${errors} errors.`,
      );
      if (apply && converted > 0) {
        if (errors === 0) {
          console.log('V1 backups saved to .openslack/agents/registry.v1-backup/');
        } else {
          console.log('No files were written because migration errors were found.');
        }
      }
      if (errors > 0) process.exit(1);
    });

  return cmd;
}
