import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import {
  CleanupBrokerRegistryError,
  validateCleanupBrokerRegistry,
} from '../internal/cleanup-broker-authorization.js';

const expected = {
  agentId: 'cleanup',
  principalId: 'principal:cleanup',
  runtimeUid: 'runtime-1',
  runId: 'run-1',
  repository: 'example/qualification',
};
function fixture() {
  return {
    schema: 'openslack.agent_registry.v2',
    agent_id: 'cleanup',
    display_name: 'Cleanup',
    employee_type: 'ai_agent',
    identity: { uid: expected.runtimeUid, principal_id: expected.principalId, status: 'active' },
    vendor: { provider: 'openai', runtime: 'codex' },
    employment: { status: 'active', hired_at: '2026-09-21T00:00:00.000Z' },
    capabilities: { primary: ['typescript'] },
    repositories: {
      workspace_repo: { owner: 'example', repo: 'qualification', default_branch: 'main' },
    },
    permissions: {
      paths: { allow: [], deny: [] },
      actions: { 'pr.cleanup_branch_scoped.v1': 'allow', 'pr.cleanup_branch': 'deny' },
      github: { can_create_pr: false, can_comment: false, can_approve: false, can_merge: false },
      max_risk_zone: 'yellow',
    },
    execution: {},
    output_contract: { must_create: [], may_create: [], must_not_create: [] },
    approval_rules: { require_human_approval_for: ['merge_to_main'] },
  };
}

describe('broker-acquired registry structure', () => {
  it('validates exact scope including the registered runtime UID', () => {
    const result = validateCleanupBrokerRegistry(stringify(fixture()), expected);
    expect(result).toEqual({ ...expected, action: 'pr.cleanup_branch_scoped.v1' });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each<[string, string, unknown]>([
    ['legacy-schema', 'schema', 'openslack.agent_registry.v1'],
    ['wrong-agent', 'agent_id', 'other'],
    ['wrong-principal', 'identity.principal_id', 'principal:other'],
    ['rotated-runtime-uid', 'identity.uid', 'runtime-2'],
    ['inactive-identity', 'identity.status', 'suspended'],
    ['onboarding', 'employment.status', 'onboarding'],
    ['missing-identity', 'identity', undefined],
    ['missing-actions', 'permissions.actions', undefined],
    ['missing-risk-default', 'permissions.max_risk_zone', undefined],
    ['missing-path-default', 'permissions.paths.allow', undefined],
    ['missing-scoped', 'permissions.actions', { 'pr.cleanup_branch': 'deny' }],
    [
      'ask-scoped',
      'permissions.actions',
      { 'pr.cleanup_branch_scoped.v1': 'ask', 'pr.cleanup_branch': 'deny' },
    ],
    ['missing-legacy-deny', 'permissions.actions', { 'pr.cleanup_branch_scoped.v1': 'allow' }],
    [
      'legacy-allow',
      'permissions.actions',
      { 'pr.cleanup_branch_scoped.v1': 'allow', 'pr.cleanup_branch': 'allow' },
    ],
    [
      'legacy-ask',
      'permissions.actions',
      { 'pr.cleanup_branch_scoped.v1': 'allow', 'pr.cleanup_branch': 'ask' },
    ],
    ['insufficient-risk', 'permissions.max_risk_zone', 'green'],
    ['invalid-risk', 'permissions.max_risk_zone', 'purple'],
    ['wrong-repository', 'repositories.workspace_repo.repo', 'other'],
    ['alternate-base', 'repositories.workspace_repo.default_branch', 'other'],
    ['approval-normalization', 'permissions.github.can_approve', true],
    ['merge-normalization', 'permissions.github.can_merge', true],
    ['unknown-permission', 'permissions.cleanup_override', true],
    ['unknown-identity', 'identity.authorized', true],
    ['unknown-repository', 'repositories.workspace_repo.alias', 'other'],
    ['unknown-approval-policy', 'approval_rules.skip', true],
    [
      'explicit-human-gate',
      'approval_rules.require_human_approval_for',
      ['pr.cleanup_branch_scoped.v1'],
    ],
    ['wildcard-human-gate', 'approval_rules.require_human_approval_for', ['*']],
    ['coerced-boolean', 'permissions.github.can_approve', 'false'],
  ])('rejects %s', (_name, path, value) => {
    const registry = fixture();
    const keys = path.split('.');
    let parent = registry as unknown as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    if (value === undefined) delete parent[keys.at(-1)!];
    else parent[keys.at(-1)!] = value;
    expect(() => validateCleanupBrokerRegistry(stringify(registry), expected)).toThrow(
      CleanupBrokerRegistryError,
    );
  });
  it.each([
    (s: string) => `${s}\nagent_id: other\n`,
    (s: string) => `---\n${s}\n---\n${s}`,
    (s: string) => s.replace('identity:', 'identity: &identity'),
    (s: string) => `${s}\nextra: *missing\n`,
    (s: string) => `${s}\n<<: {}\n`,
    (s: string) => s.replace('agent_id: cleanup', 'agent_id: !!str cleanup'),
    (s: string) => `${s}\n# ${'x'.repeat(65_536)}`,
    (s: string) => `${s}\n# \ud800`,
  ])('rejects ambiguous or oversized YAML without source leakage', (mutate) => {
    try {
      validateCleanupBrokerRegistry(mutate(stringify(fixture())), expected);
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(CleanupBrokerRegistryError);
      expect((error as CleanupBrokerRegistryError).code).toBe('BLOCKED_AUTHORIZATION');
      expect((error as Error).message).toBe('CLEANUP_BROKER_REGISTRY_REJECTED');
    }
  });

  it.each(['agentId', 'principalId', 'runtimeUid', 'runId', 'repository'] as const)(
    'rejects missing expected %s',
    (field) => {
      expect(() =>
        validateCleanupBrokerRegistry(stringify(fixture()), { ...expected, [field]: '' }),
      ).toThrow(CleanupBrokerRegistryError);
    },
  );
});
