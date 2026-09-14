import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { AgentRegistryEntry } from '@openslack/kernel';
import { isSafeAgentId, parseAgentRegistryText } from '@openslack/workspace';
import { digest, OnboardingError, publishOnboarding } from './onboarding-publication.js';

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

const runtimes = {
  claude_code: { provider: 'anthropic', prompt: 'claude_routine_prompt.md' },
  codex: { provider: 'openai', prompt: 'codex_automation_prompt.md' },
  custom_runner: { provider: 'unconfigured', prompt: 'START_HERE.md' },
} as const;

function text(value: unknown, field: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value))
    throw new OnboardingError(
      'AGENT_HIRE_FIELD_INVALID',
      `${field} must be nonempty single-line text`,
    );
  return value;
}
// Numeric entities render as literal text, without creating Markdown delimiters or links.
function markdownText(value: string): string {
  return value.replace(/[&<>\\`*_{}\[\]()!#|~]/g, (char) => `&#${char.charCodeAt(0)};`);
}
function render(template: string, values: Record<string, string>): string {
  // User-controlled inline-code values must be escaped outside code spans (entities are
  // literal inside code spans). Machine-generated IDs/paths remain readable code.
  const userKeys = new Set([
    'DISPLAY_NAME',
    'DEPARTMENT',
    'ROLE',
    'MANAGER',
    'GITHUB_OWNER',
    'GITHUB_REPO',
  ]);
  template = template.replace(
    /`([^`\n]*\{\{(?:DEPARTMENT|ROLE|MANAGER|GITHUB_OWNER|GITHUB_REPO)\}\}[^`\n]*)`/g,
    '$1',
  );
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => {
    if (!(key in values))
      throw new OnboardingError('AGENT_HIRE_TEMPLATE_INVALID', `Unknown placeholder: ${key}`);
    return userKeys.has(key) ? markdownText(values[key]) : values[key];
  });
}

/** Create a new administrator-reviewed identity; never rewrite an existing identity. */
export function hireAgent(options: HireAgentOptions): { agentId: string; entrypoint: string } {
  if (!options || typeof options !== 'object')
    throw new OnboardingError('AGENT_HIRE_FIELD_INVALID', 'options must be an object');
  const { rootDir, agentId } = options;
  if (!isSafeAgentId(agentId))
    throw new OnboardingError(
      'AGENT_HIRE_ID_INVALID',
      'Agent ID must be a portable name of 1–128 characters',
    );
  text(rootDir, 'rootDir', '');
  if (typeof rootDir !== 'string')
    throw new OnboardingError('AGENT_HIRE_FIELD_INVALID', 'rootDir is required');
  const displayName = text(
    options.displayName === '' ? undefined : options.displayName,
    'displayName',
    agentId.replace(/[_-]/g, ' '),
  );
  const runtime = text(options.runtime, 'runtime', 'claude_code');
  if (!Object.hasOwn(runtimes, runtime))
    throw new OnboardingError(
      'AGENT_HIRE_RUNTIME_INVALID',
      'runtime must be claude_code, codex or custom_runner',
    );
  const runtimeConfig = runtimes[runtime as keyof typeof runtimes];
  const department = text(options.department, 'department', 'engineering');
  const role = text(options.role, 'role', 'developer');
  const manager = text(options.manager, 'manager', 'human:founder');
  const owner = text(options.githubOwner, 'githubOwner', 'wsman');
  const repo = text(options.githubRepo, 'githubRepo', 'OpenSlack');
  const base = `.openslack/agents/onboarding/${agentId}`;
  const entrypoint = `${base}/${runtimeConfig.prompt}`;
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
  const templateDir = join(rootDir, 'templates', 'new-agent');
  let documents: { name: string; content: string }[];
  try {
    const files = readdirSync(templateDir, { withFileTypes: true });
    if (
      files.some(
        (file) =>
          !file.isFile() || !(AGENT_ONBOARDING_DOCUMENTS as readonly string[]).includes(file.name),
      ) ||
      files.length !== AGENT_ONBOARDING_DOCUMENTS.length
    )
      throw new OnboardingError(
        'AGENT_HIRE_TEMPLATE_INVALID',
        'Template inventory differs from the reviewed document list',
      );
    documents = AGENT_ONBOARDING_DOCUMENTS.map((name) => ({
      name,
      content: render(readFileSync(join(templateDir, name), 'utf8'), values),
    }));
  } catch (error) {
    if (error instanceof OnboardingError) throw error;
    throw new OnboardingError(
      'AGENT_HIRE_TEMPLATES_UNAVAILABLE',
      'Run agent hire from a complete OpenSlack source workspace containing templates/new-agent; this installation does not provide readable onboarding templates',
    );
  }
  const registry = {
    schema: 'openslack.agent_registry.v2',
    agent_id: agentId,
    display_name: displayName,
    employee_type: 'ai_agent',
    identity: {
      uid: agentId,
      principal_id: `principal:${agentId}`,
      public_key_jwk: null,
      key_id: null,
      key_rotation: { last_rotated_at: null, rotation_interval_days: 90 },
      status: 'active',
    },
    vendor: { provider: runtimeConfig.provider, runtime, model: 'default' },
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
      max_risk_zone: 'yellow',
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
    task_matching: { max_risk_level: 'medium' },
    scheduler: { preferred_mode: 'manual', cadence_minutes: 0 },
  } satisfies AgentRegistryEntry;
  const registryText = stringify(registry);
  if (!parseAgentRegistryText(registryText, agentId))
    throw new OnboardingError(
      'AGENT_HIRE_REGISTRY_INVALID',
      'Generated registry failed validation',
    );
  publishOnboarding(
    rootDir,
    agentId,
    digest(
      JSON.stringify({
        values,
        documents,
        registry: { ...registry, employment: { ...registry.employment, hired_at: null } },
      }),
    ),
    documents,
    registryText,
  );
  return { agentId, entrypoint };
}
