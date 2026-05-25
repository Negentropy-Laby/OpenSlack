import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRuntimeIdentity, loadRuntimeIdentity, resolveAgentPrincipal } from '../identity.js';

const AGENT_ID = 'test_agent';

let fixtureRoot: string;

function writeRegistry(agentId = AGENT_ID): void {
  const registryDir = join(fixtureRoot, '.openslack', 'agents', 'registry');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(registryDir, `${agentId}.yaml`), `
schema: openslack.agent_registry.v1
agent_id: ${agentId}
display_name: Test Agent
vendor:
  provider: test
  runtime: local
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
    - packages/**
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
`, 'utf-8');
}

beforeEach(() => {
  fixtureRoot = join(tmpdir(), `openslack-identity-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(fixtureRoot, { recursive: true });
  writeRegistry();
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('generateRuntimeIdentity', () => {
  it('generates identity and writes to .openslack.local', () => {
    const identity = generateRuntimeIdentity({
      root: fixtureRoot,
      agentId: AGENT_ID,
      provider: 'cli',
    });

    expect(identity.schema).toBe('openslack.agent_runtime_identity.v1');
    expect(identity.agent_id).toBe(AGENT_ID);
    expect(identity.run_id).toMatch(/^RUN-/);
    expect(identity.provider).toBe('cli');
    expect(identity.started_at).toBeDefined();

    const identityPath = join(fixtureRoot, '.openslack.local', 'agents', AGENT_ID, 'identity.yaml');
    expect(existsSync(identityPath)).toBe(true);
  });
});

describe('loadRuntimeIdentity', () => {
  it('loads previously generated identity', () => {
    generateRuntimeIdentity({ root: fixtureRoot, agentId: AGENT_ID, provider: 'cli' });
    const loaded = loadRuntimeIdentity(fixtureRoot, AGENT_ID);

    expect(loaded).not.toBeNull();
    expect(loaded!.schema).toBe('openslack.agent_runtime_identity.v1');
    expect(loaded!.agent_id).toBe(AGENT_ID);
    expect(loaded!.run_id).toMatch(/^RUN-/);
  });

  it('returns null for nonexistent agent identity', () => {
    const result = loadRuntimeIdentity(fixtureRoot, 'nonexistent_agent_xyz');
    expect(result).toBeNull();
  });
});

describe('resolveAgentPrincipal', () => {
  it('fails closed when runtime identity is missing', () => {
    const result = resolveAgentPrincipal({ root: fixtureRoot, agentId: AGENT_ID, provider: 'cli' });

    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('No runtime identity');
    expect((result as { error: string }).error).toContain('bootstrap');
    expect(existsSync(join(fixtureRoot, '.openslack.local', 'agents', AGENT_ID, 'identity.yaml'))).toBe(false);
  });

  it('resolves principal after identity is explicitly generated', () => {
    generateRuntimeIdentity({ root: fixtureRoot, agentId: AGENT_ID, provider: 'cli' });

    const result = resolveAgentPrincipal({ root: fixtureRoot, agentId: AGENT_ID });

    expect('error' in result).toBe(false);
    if ('principal' in result) {
      expect(result.principal.registry_id).toBe(AGENT_ID);
      expect(result.principal.run_id).toMatch(/^RUN-/);
      expect(result.snapshot.source).toBe('registry_v1');
    }
  });

  it('returns error for nonexistent agent', () => {
    const result = resolveAgentPrincipal({ root: fixtureRoot, agentId: 'nonexistent_agent' });
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('not found');
  });

  it('returns the same run_id on repeated calls', () => {
    generateRuntimeIdentity({ root: fixtureRoot, agentId: AGENT_ID, provider: 'test' });

    const first = resolveAgentPrincipal({ root: fixtureRoot, agentId: AGENT_ID });
    const second = resolveAgentPrincipal({ root: fixtureRoot, agentId: AGENT_ID });

    expect('principal' in first).toBe(true);
    expect('principal' in second).toBe(true);
    if ('principal' in first && 'principal' in second) {
      expect(first.principal.run_id).toBe(second.principal.run_id);
    }
  });
});
