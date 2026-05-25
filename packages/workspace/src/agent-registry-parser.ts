import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentRegistryEntry, AgentPermissions, RiskZone } from '@openslack/kernel';

export interface ParsedAgentRegistryEntry extends AgentRegistryEntry {
  _source_schema: 'openslack.agent_registry.v1' | 'openslack.agent_registry.v2';
}

export function parseAgentRegistry(root: string, agentId: string): ParsedAgentRegistryEntry | null {
  const regPath = join(root, '.openslack', 'agents', 'registry', `${agentId}.yaml`);
  if (!existsSync(regPath)) return null;

  const raw = readFileSync(regPath, 'utf-8');
  const data = parseYaml(raw) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;

  const schema = data.schema as string | undefined;
  if (!schema) {
    throw new Error(`Agent registry "${agentId}" missing required "schema" field`);
  }

  if (schema === 'openslack.agent_registry.v2') {
    return { ...parseV2(data, agentId), _source_schema: 'openslack.agent_registry.v2' };
  }

  if (schema === 'openslack.agent_registry.v1') {
    return { ...normalizeV1toV2(data, agentId), _source_schema: 'openslack.agent_registry.v1' };
  }

  throw new Error(`Agent registry "${agentId}" has unknown schema "${schema}"`);
}

function parseV2(data: Record<string, unknown>, agentId: string): AgentRegistryEntry {
  const identity = data.identity as Record<string, unknown>;
  const vendor = data.vendor as Record<string, unknown>;
  const employment = data.employment as Record<string, unknown>;
  const capabilities = data.capabilities as Record<string, unknown>;
  const repos = data.repositories as Record<string, unknown>;
  const perms = data.permissions as Record<string, unknown>;
  const paths = perms.paths as Record<string, unknown>;
  const actions = perms.actions as Record<string, import('@openslack/kernel').ActionVerdict>;
  const gh = perms.github as Record<string, boolean>;
  const execution = (data.execution as Record<string, unknown>) || {};
  const outputContract = data.output_contract as Record<string, unknown>;
  const approvalRules = data.approval_rules as Record<string, unknown>;
  const keyRotation = (identity?.key_rotation as Record<string, unknown>) || {};

  return {
    schema: 'openslack.agent_registry.v2',
    agent_id: (data.agent_id as string) || agentId,
    display_name: data.display_name as string,
    employee_type: 'ai_agent',
    identity: {
      uid: identity.uid as string,
      principal_id: identity.principal_id as string,
      public_key_jwk: identity.public_key_jwk ?? null,
      key_id: (identity.key_id as string) ?? null,
      key_rotation: {
        last_rotated_at: (keyRotation.last_rotated_at as string) ?? null,
        rotation_interval_days: (keyRotation.rotation_interval_days as number) ?? 90,
      },
      status: identity.status as 'active' | 'suspended' | 'retired',
    },
    vendor: {
      provider: vendor.provider as string,
      runtime: vendor.runtime as string,
      model: vendor.model as string | undefined,
    },
    employment: {
      status: employment.status as 'active' | 'paused' | 'onboarding' | 'retired',
      hired_at: employment.hired_at as string,
      hired_by: employment.hired_by as string | undefined,
      department: employment.department as string | undefined,
      role: employment.role as string | undefined,
      manager: employment.manager as string | undefined,
    },
    capabilities: {
      primary: (capabilities.primary as string[]) || [],
      secondary: (capabilities.secondary as string[]) || [],
    },
    repositories: {
      workspace_repo: {
        owner: (repos.workspace_repo as Record<string, unknown>).owner as string,
        repo: (repos.workspace_repo as Record<string, unknown>).repo as string,
        default_branch: (repos.workspace_repo as Record<string, unknown>).default_branch as string,
      },
      allowed_product_repos: repos.allowed_product_repos as string[] | undefined,
    },
    permissions: {
      paths: {
        allow: (paths.allow as string[]) || ['**'],
        deny: (paths.deny as string[]) || [],
      },
      actions: actions || {},
      github: {
        can_create_pr: gh.can_create_pr ?? false,
        can_comment: gh.can_comment ?? false,
        can_approve: false,
        can_merge: false,
      },
      max_risk_zone: (perms.max_risk_zone as RiskZone) || 'red',
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

function normalizeV1toV2(data: Record<string, unknown>, agentId: string): AgentRegistryEntry {
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

  return {
    schema: 'openslack.agent_registry.v2',
    agent_id: (data.agent_id as string) || agentId,
    display_name: data.display_name as string,
    employee_type: 'ai_agent',
    identity: {
      uid: agentId,
      principal_id: `principal:${agentId}`,
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
      primary: (capabilities.primary as string[]) || [],
      secondary: (capabilities.secondary as string[]) || [],
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
      max_risk_zone: 'yellow' as RiskZone,
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
