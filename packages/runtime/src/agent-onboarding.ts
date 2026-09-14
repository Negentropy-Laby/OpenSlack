import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';

export interface HireAgentOptions {
  rootDir: string;
  agentId: string;
  displayName?: string;
  department?: string;
  role?: string;
  runtime?: string;
  manager?: string;
  githubOwner?: string;
  githubRepo?: string;
  /** Accepted for CLI compatibility; GitHub Issues do not require a Project. */
  projectNumber?: string;
}

export const AGENT_ONBOARDING_DOCUMENTS = [
  'START_HERE.md',
  'first_day_checklist.md',
  'codex_automation_prompt.md',
  'claude_routine_prompt.md',
] as const;

/** Create a new administrator-reviewed identity; never rewrite an existing identity. */
export function hireAgent(options: HireAgentOptions): { agentId: string; entrypoint: string } {
  const { rootDir, agentId } = options;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(agentId)) {
    throw new Error('Agent ID must be a bounded name containing only letters, digits, _ or -.');
  }
  const displayName = options.displayName ?? agentId.replace(/[_-]/g, ' ');
  const runtime = options.runtime ?? 'claude_code';
  const department = options.department ?? 'engineering';
  const role = options.role ?? 'developer';
  const manager = options.manager ?? 'human:founder';
  const owner = options.githubOwner ?? 'wsman';
  const repo = options.githubRepo ?? 'OpenSlack';
  for (const value of [displayName, runtime, department, role, manager, owner, repo]) {
    if (!value.trim() || /[\r\n\0]/.test(value))
      throw new Error('Agent configuration values must be nonempty single-line text.');
  }
  const base = `.openslack/agents/onboarding/${agentId}`;
  const entrypoint = `${base}/${runtime === 'codex' ? 'codex_automation_prompt.md' : runtime === 'claude_code' ? 'claude_routine_prompt.md' : 'START_HERE.md'}`;
  const registryPath = join(rootDir, '.openslack', 'agents', 'registry', `${agentId}.yaml`);
  const onboardingDir = join(rootDir, base);
  if (existsSync(registryPath) || existsSync(onboardingDir)) {
    throw new Error(
      'Agent registry or onboarding already exists; use a governed maintenance change.',
    );
  }
  const values: Record<string, string> = {
    AGENT_ID: agentId,
    DISPLAY_NAME: displayName,
    DEPARTMENT: department,
    ROLE: role,
    RUNTIME: runtime,
    MANAGER: manager,
    GITHUB_OWNER: owner,
    GITHUB_REPO: repo,
    ENTRYPOINT: entrypoint,
  };
  // Read only the explicit non-secret document inventory, never local identity templates.
  const documents = AGENT_ONBOARDING_DOCUMENTS.map((name) => {
    const template = readFileSync(join(rootDir, 'templates', 'new-agent', name), 'utf8');
    const content = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
      if (!(key in values)) throw new Error(`Unknown onboarding placeholder: ${key}`);
      return values[key];
    });
    return { name, content };
  });
  const registry = {
    schema: 'openslack.agent_registry.v2',
    agent_id: agentId,
    display_name: displayName,
    employee_type: 'ai_agent',
    identity: { uid: agentId, principal_id: `principal:${agentId}`, status: 'active' },
    vendor: { provider: runtime === 'codex' ? 'openai' : 'anthropic', runtime, model: 'default' },
    employment: {
      status: 'onboarding',
      hired_at: new Date().toISOString(),
      hired_by: 'human:founder',
      department,
      role,
      manager,
    },
    capabilities: { primary: ['typescript', 'nodejs'], secondary: ['documentation'] },
    permissions: {
      paths: {
        allow: ['.openslack/tasks/**', '.openslack/outbox/**'],
        deny: ['.openslack/agents/**', '.openslack/policies/**', '.github/**'],
      },
      actions: {
        'task.claim': 'allow',
        'task.sync': 'allow',
        'pr.propose': 'allow',
        'pr.comment': 'allow',
        'github.comment': 'allow',
      },
      github: { can_create_pr: true, can_comment: true, can_approve: false, can_merge: false },
      max_risk_zone: 'red',
    },
    repositories: { workspace_repo: { owner, repo, default_branch: 'main' } },
    execution: { max_parallel_tasks: 1, max_task_runtime_minutes: 120 },
    output_contract: {
      must_create: ['workspace_run_record'],
      may_create: ['workspace_pr', 'review_comment'],
      must_not_create: ['direct_main_push', 'production_deploy'],
    },
    approval_rules: {
      require_human_approval_for: [
        'merge_to_main',
        'policy_change',
        'permission_change',
        'agent_registry_change',
      ],
    },
    scheduler: { preferred_mode: 'manual', cadence_minutes: 0 },
  };
  const registryText = stringify(registry);
  mkdirSync(join(rootDir, '.openslack', 'agents', 'registry'), { recursive: true });
  mkdirSync(onboardingDir, { recursive: true });
  for (const document of documents)
    writeFileSync(join(onboardingDir, document.name), document.content, 'utf8');
  writeFileSync(registryPath, registryText, 'utf8');
  return { agentId, entrypoint };
}
