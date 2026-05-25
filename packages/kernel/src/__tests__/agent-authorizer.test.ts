import { describe, it, expect } from 'vitest';
import { authorizeAgentAction, resolvePermissionSnapshot } from '../agent-authorizer.js';
import type {
  AgentPermissionSnapshot,
  AgentPrincipal,
  AgentRegistryEntry,
  AgentRuntimeIdentity,
  AuthorizationResult,
} from '../types.js';

function makeSnapshot(overrides: Partial<AgentPermissionSnapshot['permissions']> = {}): AgentPermissionSnapshot {
  const principal: AgentPrincipal = {
    registry_id: 'test_agent',
    runtime_uid: 'uid-001',
    run_id: 'RUN-001',
    provider: 'cli',
  };
  return {
    principal,
    registry_entry_agent_id: 'test_agent',
    permissions: {
      paths: { allow: ['**'], deny: ['.env'] },
      actions: { 'task.claim': 'allow', 'pr.propose': 'allow', 'pr.merge': 'deny', 'task.sync': 'ask' },
      github: { can_create_pr: true, can_comment: true, can_approve: false, can_merge: false },
      max_risk_zone: 'yellow',
      ...overrides,
    },
    resolved_at: new Date().toISOString(),
    source: 'registry_v2',
  };
}

describe('authorizeAgentAction', () => {
  it('denies unknown principal (null snapshot)', () => {
    const result = authorizeAgentAction({ snapshot: null, action: 'task.claim' });
    expect(result.decision).toBe('deny');
    expect(result.evidence.rule).toBe('unknown_principal');
  });

  it('denies black zone unconditionally', () => {
    const result = authorizeAgentAction({ snapshot: makeSnapshot(), action: 'task.claim', riskZone: 'black' });
    expect(result.decision).toBe('deny');
    expect(result.evidence.rule).toBe('black_zone');
  });

  it('denies when risk zone exceeds max_risk_zone', () => {
    const result = authorizeAgentAction({ snapshot: makeSnapshot(), action: 'task.claim', riskZone: 'red' });
    expect(result.decision).toBe('deny');
    expect(result.evidence.rule).toBe('risk_ceiling');
  });

  it('denies when path matches deny glob', () => {
    const result = authorizeAgentAction({ snapshot: makeSnapshot(), action: 'task.claim', changedPaths: ['.env'] });
    expect(result.decision).toBe('deny');
    expect(result.evidence.rule).toBe('path_denied');
  });

  it('denies when path outside allow list', () => {
    const snapshot = makeSnapshot({ paths: { allow: ['packages/runtime/**'], deny: [] } });
    const result = authorizeAgentAction({ snapshot, action: 'task.claim', changedPaths: ['apps/cli/index.ts'] });
    expect(result.decision).toBe('deny');
    expect(result.evidence.rule).toBe('path_not_allowed');
  });

  it('denies github.approve for any agent', () => {
    const result = authorizeAgentAction({ snapshot: makeSnapshot(), action: 'github.approve' });
    expect(result.decision).toBe('deny');
    expect(result.evidence.rule).toBe('github_approve_forbidden');
  });

  it('denies github.merge when can_merge is false', () => {
    const result = authorizeAgentAction({ snapshot: makeSnapshot(), action: 'github.merge' });
    expect(result.decision).toBe('deny');
    expect(result.evidence.rule).toBe('github_merge_forbidden');
  });

  it('denies explicitly denied action', () => {
    const result = authorizeAgentAction({ snapshot: makeSnapshot(), action: 'pr.merge' });
    expect(result.decision).toBe('deny');
    expect(result.evidence.rule).toBe('action_denied');
  });

  it('returns ask for ask action', () => {
    const result = authorizeAgentAction({ snapshot: makeSnapshot(), action: 'task.sync' });
    expect(result.decision).toBe('ask');
    expect(result.evidence.rule).toBe('action_ask');
    expect(result.prompt_message).toBeDefined();
  });

  it('allows explicitly allowed action', () => {
    const result = authorizeAgentAction({ snapshot: makeSnapshot(), action: 'task.claim' });
    expect(result.decision).toBe('allow');
    expect(result.evidence.rule).toBe('action_allowed');
  });

  it('denies unknown action (fail closed)', () => {
    const result = authorizeAgentAction({ snapshot: makeSnapshot(), action: 'unknown.action' });
    expect(result.decision).toBe('deny');
    expect(result.evidence.rule).toBe('unknown_action');
  });

  it('does not allow wildcard permissions for unknown actions', () => {
    const snapshot = makeSnapshot({ actions: { '*': 'allow' } });
    const result = authorizeAgentAction({ snapshot, action: 'arbitrary.new.action' });
    expect(result.decision).toBe('deny');
    expect(result.evidence.rule).toBe('unknown_action');
  });

  it('allows within risk zone ceiling', () => {
    const result = authorizeAgentAction({ snapshot: makeSnapshot(), action: 'task.claim', riskZone: 'green' });
    expect(result.decision).toBe('allow');
  });

  it('deny overrides allow for path globs', () => {
    const snapshot = makeSnapshot({ paths: { allow: ['**'], deny: ['secrets/**'] } });
    const result = authorizeAgentAction({ snapshot, action: 'task.claim', changedPaths: ['secrets/key.pem'] });
    expect(result.decision).toBe('deny');
    expect(result.evidence.rule).toBe('path_denied');
  });

  it('always includes diagnostics', () => {
    const result = authorizeAgentAction({ snapshot: makeSnapshot(), action: 'task.claim' });
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('resolvePermissionSnapshot', () => {
  it('returns null when registry is null', () => {
    const identity: AgentRuntimeIdentity = {
      schema: 'openslack.agent_runtime_identity.v1',
      agent_id: 'test',
      agent_uid: 'uid',
      run_id: 'RUN',
      public_key_jwk: null,
      key_id: null,
      key_generated_at: null,
      provider: 'cli',
      started_at: new Date().toISOString(),
    };
    expect(resolvePermissionSnapshot({ registry: null, runtimeIdentity: identity })).toBeNull();
  });

  it('returns null when runtime identity is null', () => {
    const registry = {} as AgentRegistryEntry;
    expect(resolvePermissionSnapshot({ registry, runtimeIdentity: null })).toBeNull();
  });

  it('returns snapshot when both provided', () => {
    const registry = {
      schema: 'openslack.agent_registry.v2' as const,
      agent_id: 'test_agent',
      display_name: 'Test Agent',
      employee_type: 'ai_agent' as const,
      identity: { uid: 'uid-001', principal_id: 'principal:test_agent', public_key_jwk: null, key_id: null, key_rotation: { last_rotated_at: null, rotation_interval_days: 90 }, status: 'active' as const },
      vendor: { provider: 'test', runtime: 'test' },
      employment: { status: 'active' as const, hired_at: new Date().toISOString() },
      capabilities: { primary: ['testing'], secondary: [] },
      repositories: { workspace_repo: { owner: 'test', repo: 'test', default_branch: 'main' } },
      permissions: {
        paths: { allow: ['**'], deny: [] },
        actions: { 'task.claim': 'allow' as const },
        github: { can_create_pr: true, can_comment: true, can_approve: false, can_merge: false },
        max_risk_zone: 'yellow' as const,
      },
      execution: {},
      output_contract: { must_create: [], may_create: [], must_not_create: [] },
      approval_rules: { require_human_approval_for: [] },
    } satisfies AgentRegistryEntry;
    const identity: AgentRuntimeIdentity = {
      schema: 'openslack.agent_runtime_identity.v1',
      agent_id: 'test_agent',
      agent_uid: 'uid-001',
      run_id: 'RUN-001',
      public_key_jwk: null,
      key_id: null,
      key_generated_at: null,
      provider: 'cli',
      started_at: new Date().toISOString(),
    };
    const snapshot = resolvePermissionSnapshot({ registry, runtimeIdentity: identity });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.principal.registry_id).toBe('test_agent');
    expect(snapshot!.principal.run_id).toBe('RUN-001');
    expect(snapshot!.source).toBe('registry_v2');
  });
});
