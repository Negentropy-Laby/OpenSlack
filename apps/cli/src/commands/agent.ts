import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapAgent } from '@openslack/agent-runtime';
import { tickAgent } from '@openslack/agent-runtime';

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

export function agentCommands(): Command {
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
      const root = findRepoRoot();
      const agentId = options.agentId;
      const displayName = options.displayName || agentId.replace(/_/g, ' ').replace(/-/g, ' ');
      const templateDir = join(root, 'templates', 'new-agent');

      if (!existsSync(templateDir)) {
        console.error('Error: templates/new-agent/ directory not found');
        process.exit(1);
      }

      // Create agent directories
      const registryDir = join(root, '.openslack', 'agents', 'registry');
      const promptsDir = join(root, '.openslack', 'agents', 'prompts');
      const onboardingDir = join(root, '.openslack', 'agents', 'onboarding', agentId);
      mkdirSync(onboardingDir, { recursive: true });

      // Template variables
      const vars: Record<string, string> = {
        '{{AGENT_ID}}': agentId,
        '{{DISPLAY_NAME}}': displayName,
        '{{DEPARTMENT}}': options.department,
        '{{ROLE}}': options.role,
        '{{RUNTIME}}': options.runtime,
        '{{MANAGER}}': options.manager,
        '{{GITHUB_OWNER}}': options.githubOwner,
        '{{GITHUB_REPO}}': options.githubRepo,
        '{{PROJECT_NUMBER}}': options.projectNumber,
        '{{MAX_RISK_LEVEL}}': 'medium',
        '{{HEARTBEAT_INTERVAL}}': '10',
        '{{LEASE_TTL_MINUTES}}': '60',
        '{{MAX_PARALLEL_TASKS}}': '1',
        '{{WORKSPACE_ROOT}}': root,
      };

      // Copy and substitute templates
      const templates = readdirSync(templateDir);
      for (const tmpl of templates) {
        let content = readFileSync(join(templateDir, tmpl), 'utf-8');
        for (const [key, value] of Object.entries(vars)) {
          content = content.replaceAll(key, value);
        }
        const destDir = tmpl === 'START_HERE.md' || tmpl.endsWith('.md') || tmpl.endsWith('.yml') || tmpl.endsWith('.yaml') || tmpl === 'local_cron.example'
          ? onboardingDir
          : tmpl === 'identity.yaml' ? onboardingDir : promptsDir;

        writeFileSync(join(destDir, tmpl), content, 'utf-8');
      }

      // Create registry entry
      const registryYaml = `schema: openslack.agent_registry.v1

agent_id: "${agentId}"
display_name: "${displayName}"
employee_type: ai_agent

vendor:
  provider: "anthropic"
  runtime: "${options.runtime}"
  model: "default"

employment:
  status: "onboarding"
  hired_at: "${new Date().toISOString()}"
  hired_by: "human:founder"
  department: "${options.department}"
  role: "${options.role}"
  manager: "${options.manager}"

capabilities:
  primary:
    - "typescript"
    - "nodejs"
  secondary:
    - "documentation"

repositories:
  workspace_repo:
    owner: "${options.githubOwner}"
    repo: "${options.githubRepo}"
    default_branch: "main"

workspace_permissions:
  allow:
    - ".openslack/tasks/**"
    - ".openslack/outbox/**"
  deny:
    - ".openslack/agents/**"
    - ".openslack/policies/**"
    - ".github/**"

execution:
  max_parallel_tasks: 1
  lease_ttl_minutes: 60
  heartbeat_interval_minutes: 10
  max_task_runtime_minutes: 120

output_contract:
  must_create:
    - "workspace_run_record"
  may_create:
    - "workspace_pr"
    - "review_comment"
  must_not_create:
    - "direct_main_push"
    - "production_deploy"

approval_rules:
  require_human_approval_for:
    - "merge_to_main"
    - "policy_change"
    - "permission_change"
    - "agent_registry_change"
`;
      writeFileSync(join(registryDir, `${agentId}.yaml`), registryYaml, 'utf-8');

      console.log(`Agent ${agentId} hired successfully.`);
      console.log(`  Registry: .openslack/agents/registry/${agentId}.yaml`);
      console.log(`  Prompts: .openslack/agents/prompts/${agentId}.md`);
      console.log(`  Onboarding: .openslack/agents/onboarding/${agentId}/`);
      console.log(`\nNext steps:`);
      console.log(`  1. Create local identity in .openslack.local/agents/${agentId}/identity.yaml`);
      console.log(`  2. Set credentials in the identity.yaml file`);
      console.log(`  3. Run: openslack agent bootstrap --agent-id ${agentId}`);
    });

  cmd
    .command('bootstrap')
    .description('Verify agent is ready to work')
    .requiredOption('--agent-id <id>', 'Agent ID')
    .action((options) => {
      const result = bootstrapAgent(options.agentId);
      console.log(`Agent bootstrap: ${result.agentId}`);
      for (const check of result.checks) {
        console.log(`  [${check.passed ? 'PASS' : 'FAIL'}] ${check.name}: ${check.detail}`);
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
    .action(async (options) => {
      const source = (options.source === 'github-issues' ? 'github-issues' : 'local') as 'local' | 'github-issues';
      const result = await tickAgent(options.agentId, { source });
      console.log(`Agent tick: ${result.agentId}`);
      console.log(`  Source: ${source}`);
      console.log(`  Action: ${result.action}`);
      if (result.taskId) console.log(`  Task: ${result.taskId}`);
      if (result.leaseId) console.log(`  Claim: ${result.leaseId}`);
      console.log(`  ${result.message}`);
      if (result.action === 'error') process.exit(1);
    });

  return cmd;
}
