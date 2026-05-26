import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { AgentRegistryEntry, RiskZone } from '@openslack/kernel';

export interface MigrationResult {
  agentId: string;
  status: 'converted' | 'already_v2' | 'error';
  error?: string;
}

export function migrateV1ToV2(data: Record<string, unknown>, agentId: string): AgentRegistryEntry {
  const vendor = (data.vendor as Record<string, unknown>) || {};
  const employment = (data.employment as Record<string, unknown>) || {};
  const capabilities = (data.capabilities as Record<string, unknown>) || {};
  const repos = (data.repositories as Record<string, unknown>) || {};
  const repoWorkspace = (repos.workspace_repo as Record<string, unknown>) || {};
  const wp = (data.workspace_permissions as Record<string, unknown>) || { allow: ['**'], deny: [] };
  const execution = (data.execution as Record<string, unknown>) || {};
  const outputContract = (data.output_contract as Record<string, unknown>) || {};
  const approvalRules = (data.approval_rules as Record<string, unknown>) || {};
  const empStatus = (employment.status as string) || 'active';
  const riskLevel = (data.risk_level as RiskZone) || 'yellow';

  const primaryCaps = (capabilities.primary as string[]) || (capabilities as unknown as string[]) || [];
  const secondaryCaps = (capabilities.secondary as string[]) || [];

  // Use YAML agent_id if present, otherwise fall back to filename-derived agentId.
  // Canonical ID is used consistently across agent_id and identity fields.
  const canonicalId = (data.agent_id as string) || agentId;
  const displayName = (data.display_name as string) || canonicalId.replace(/_/g, ' ').replace(/-/g, ' ');

  return {
    schema: 'openslack.agent_registry.v2',
    agent_id: canonicalId,
    display_name: displayName,
    employee_type: 'ai_agent',
    identity: {
      uid: canonicalId,
      principal_id: `principal:${canonicalId}`,
      public_key_jwk: null,
      key_id: null,
      key_rotation: {
        last_rotated_at: null,
        rotation_interval_days: 90,
      },
      status: (empStatus === 'active' || empStatus === 'onboarding') ? 'active' : 'suspended',
    },
    vendor: {
      provider: vendor.provider as string,
      runtime: vendor.runtime as string,
      model: vendor.model as string | undefined,
    },
    employment: {
      status: empStatus as 'active' | 'paused' | 'onboarding' | 'retired',
      hired_at: (employment.hired_at as string) || new Date().toISOString(),
      hired_by: employment.hired_by as string | undefined,
      department: employment.department as string | undefined,
      role: employment.role as string | undefined,
      manager: employment.manager as string | undefined,
    },
    capabilities: {
      primary: primaryCaps,
      secondary: secondaryCaps,
    },
    repositories: {
      workspace_repo: {
        owner: (repoWorkspace.owner as string) || 'unknown',
        repo: (repoWorkspace.repo as string) || 'unknown',
        default_branch: (repoWorkspace.default_branch as string) || 'main',
      },
      allowed_product_repos: repos.allowed_product_repos as string[] | undefined,
    },
    permissions: {
      paths: {
        allow: (wp.allow as string[]) || ['**'],
        deny: (wp.deny as string[]) || [],
      },
      actions: {
        'task.claim': 'allow',
        'task.sync': 'allow',
        'pr.propose': 'allow',
        'pr.comment': 'allow',
        'github.comment': 'allow',
      } as Record<string, import('@openslack/kernel').ActionVerdict>,
      github: {
        can_create_pr: true,
        can_comment: true,
        can_approve: false,
        can_merge: false,
      },
      max_risk_zone: riskLevel,
    },
    execution: {
      max_parallel_tasks: execution.max_parallel_tasks as number | undefined,
      lease_ttl_minutes: execution.lease_ttl_minutes as number | undefined,
      heartbeat_interval_minutes: execution.heartbeat_interval_minutes as number | undefined,
      max_task_runtime_minutes: execution.max_task_runtime_minutes as number | undefined,
      max_daily_tasks: execution.max_daily_tasks as number | undefined,
    },
    output_contract: {
      must_create: (outputContract.must_create as string[]) || [],
      may_create: (outputContract.may_create as string[]) || [],
      must_not_create: (outputContract.must_not_create as string[]) || [],
    },
    approval_rules: {
      require_human_approval_for: (approvalRules.require_human_approval_for as string[]) || [],
    },
    task_matching: data.task_matching as AgentRegistryEntry['task_matching'],
    scheduler: data.scheduler as AgentRegistryEntry['scheduler'],
  };
}

export function migrateRegistry(
  root: string,
  options: { apply: boolean } = { apply: false },
): MigrationResult[] {
  const dir = join(root, '.openslack', 'agents', 'registry');
  if (!existsSync(dir)) return [];

  const results: MigrationResult[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  for (const file of files) {
    const path = join(dir, file);
    const agentId = file.replace(/\.(yaml|yml)$/, '');

    try {
      const raw = readFileSync(path, 'utf-8');
      const data = parseYaml(raw) as Record<string, unknown>;
      const schema = data.schema as string;

      if (schema === 'openslack.agent_registry.v2') {
        results.push({ agentId, status: 'already_v2' });
        continue;
      }

      if (schema !== 'openslack.agent_registry.v1') {
        results.push({ agentId, status: 'error', error: `Unknown schema: ${schema}` });
        continue;
      }

      const converted = migrateV1ToV2(data, agentId);

      if (options.apply) {
        const backupDir = join(root, '.openslack', 'agents', 'registry.v1-backup');
        if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
        writeFileSync(join(backupDir, file), raw, 'utf-8');
        writeFileSync(path, stringifyYaml(converted, { lineWidth: 0 }), 'utf-8');
      }

      results.push({ agentId, status: 'converted' });
    } catch (err) {
      results.push({ agentId, status: 'error', error: (err as Error).message });
    }
  }

  return results;
}
