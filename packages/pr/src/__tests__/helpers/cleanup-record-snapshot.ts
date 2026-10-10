import { stringify } from 'yaml';
import type { AgentPermissionSnapshot } from '@openslack/kernel';
import { validateCleanupBrokerRegistry } from '../../internal/cleanup-broker-authorization.js';

/**
 * Build a real permission snapshot through the production registry validator,
 * rather than hand-writing one. Tests then exercise the same authorizer the CLI
 * uses, including its deny-precedence and empty-allow-list behaviour.
 */
const BINDING = {
  agentId: 'cleanup',
  principalId: 'principal:cleanup',
  runtimeUid: 'runtime-1',
  runId: 'run-1',
  repository: 'example/qualification',
} as const;

function registry(paths: { allow: string[]; deny: string[] }): string {
  return stringify({
    schema: 'openslack.agent_registry.v2',
    agent_id: BINDING.agentId,
    display_name: 'Cleanup',
    employee_type: 'ai_agent',
    identity: {
      uid: BINDING.runtimeUid,
      principal_id: BINDING.principalId,
      status: 'active',
    },
    vendor: { provider: 'openai', runtime: 'codex' },
    employment: { status: 'active', hired_at: '2026-09-21T00:00:00.000Z' },
    capabilities: { primary: ['typescript'] },
    repositories: {
      workspace_repo: { owner: 'Negentropy-Laby', repo: 'OpenSlack', default_branch: 'main' },
      allowed_product_repos: [BINDING.repository],
    },
    permissions: {
      paths,
      actions: { 'pr.cleanup_branch_scoped.v1': 'allow', 'pr.cleanup_branch': 'deny' },
      github: { can_create_pr: false, can_comment: false, can_approve: false, can_merge: false },
      max_risk_zone: 'yellow',
    },
    execution: {},
    output_contract: { must_create: [], may_create: [], must_not_create: [] },
    approval_rules: { require_human_approval_for: ['merge_to_main'] },
  });
}

/** A snapshot that permits the record outbox path. */
export function snapshotAllowingOutbox(): AgentPermissionSnapshot {
  return validateCleanupBrokerRegistry(
    registry({ allow: ['.openslack/outbox/**'], deny: [] }),
    BINDING,
  ).snapshot;
}

/** A snapshot whose deny list excludes the outbox path, overriding the allow. */
export function snapshotDenyingOutbox(): AgentPermissionSnapshot {
  return validateCleanupBrokerRegistry(
    registry({ allow: ['.openslack/outbox/**'], deny: ['.openslack/outbox/**'] }),
    BINDING,
  ).snapshot;
}

/** A snapshot that allows nothing, exercising the empty-allow-list denial. */
export function snapshotAllowingNothing(): AgentPermissionSnapshot {
  return validateCleanupBrokerRegistry(registry({ allow: [], deny: [] }), BINDING).snapshot;
}
