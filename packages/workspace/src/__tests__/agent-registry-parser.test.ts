import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentRegistry } from '../agent-registry-parser.js';

let fixtureRoot: string;

function registryDir(): string {
  return join(fixtureRoot, '.openslack', 'agents', 'registry');
}

function writeRegistry(agentId: string, yaml: string): void {
  mkdirSync(registryDir(), { recursive: true });
  writeFileSync(join(registryDir(), `${agentId}.yaml`), yaml, 'utf-8');
}

beforeEach(() => {
  fixtureRoot = join(
    tmpdir(),
    `openslack-registry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(fixtureRoot, { recursive: true });
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('parseAgentRegistry', () => {
  it('returns null for nonexistent agent', () => {
    const result = parseAgentRegistry(fixtureRoot, 'nonexistent_agent_xyz');
    expect(result).toBeNull();
  });

  it('parses v1 registry and normalizes to v2 shape', () => {
    writeRegistry(
      'test_architect',
      `
schema: openslack.agent_registry.v1
agent_id: test_architect
display_name: Test Architect
vendor:
  provider: anthropic
  runtime: cli
  model: test
employment:
  status: active
  hired_at: "2026-01-01T00:00:00.000Z"
capabilities:
  primary:
    - typescript
  secondary:
    - schema_design
repositories:
  workspace_repo:
    owner: test
    repo: OpenSlack
    default_branch: main
workspace_permissions:
  allow:
    - "**"
  deny:
    - .openslack.local/**
execution:
  max_parallel_tasks: 1
  lease_ttl_minutes: 120
output_contract:
  must_create: []
  may_create: []
  must_not_create: []
approval_rules:
  require_human_approval_for: []
`,
    );

    const result = parseAgentRegistry(fixtureRoot, 'test_architect');
    expect(result).not.toBeNull();
    expect(result!.schema).toBe('openslack.agent_registry.v2');
    expect(result!._source_schema).toBe('openslack.agent_registry.v1');
    expect(result!.agent_id).toBe('test_architect');
    expect(result!.display_name).toBe('Test Architect');
    expect(result!.employee_type).toBe('ai_agent');

    expect(result!.identity.uid).toBe('test_architect');
    expect(result!.identity.principal_id).toBe('principal:test_architect');
    expect(result!.identity.status).toBe('active');

    expect(result!.permissions.actions['task.claim']).toBe('allow');
    expect(result!.permissions.actions['task.sync']).toBe('allow');
    expect(result!.permissions.actions['pr.propose']).toBe('allow');
    expect(result!.permissions.actions['*']).toBeUndefined();
    expect(result!.permissions.github.can_approve).toBe(false);
    expect(result!.permissions.github.can_merge).toBe(false);
    expect(result!.permissions.github.can_create_pr).toBe(true);
    expect(result!.permissions.max_risk_zone).toBe('yellow');

    expect(result!.permissions.paths.allow).toContain('**');
    expect(result!.permissions.paths.deny).toContain('.openslack.local/**');
    expect(result!.capabilities.primary).toContain('typescript');
    expect(result!.capabilities.secondary).toContain('schema_design');
    expect(result!.execution.max_parallel_tasks).toBe(1);
    expect(result!.execution.lease_ttl_minutes).toBe(120);
  });

  it('parses v2 registry without wildcard permissions', () => {
    writeRegistry(
      'reviewer',
      `
schema: openslack.agent_registry.v2
agent_id: reviewer
display_name: Reviewer
identity:
  uid: reviewer-uid
  principal_id: principal:reviewer
  public_key_jwk: null
  key_id: null
  key_rotation:
    last_rotated_at: null
    rotation_interval_days: 90
  status: active
vendor:
  provider: test
  runtime: cli
employment:
  status: active
  hired_at: "2026-01-01T00:00:00.000Z"
capabilities:
  primary:
    - review
  secondary: []
repositories:
  workspace_repo:
    owner: test
    repo: OpenSlack
    default_branch: main
permissions:
  paths:
    allow:
      - packages/pr/**
    deny: []
  actions:
    pr.review: allow
  github:
    can_create_pr: false
    can_comment: true
    can_approve: false
    can_merge: false
  max_risk_zone: yellow
execution: {}
output_contract:
  must_create: []
  may_create: []
  must_not_create: []
approval_rules:
  require_human_approval_for: []
`,
    );

    const result = parseAgentRegistry(fixtureRoot, 'reviewer');
    expect(result).not.toBeNull();
    expect(result!.schema).toBe('openslack.agent_registry.v2');
    expect(result!._source_schema).toBe('openslack.agent_registry.v2');
    expect(result!.agent_id).toBe('reviewer');
    expect(result!.identity.uid).toBe('reviewer-uid');
    expect(result!.permissions.actions['pr.review']).toBe('allow');
    expect(result!.permissions.actions['*']).toBeUndefined();
  });
});
