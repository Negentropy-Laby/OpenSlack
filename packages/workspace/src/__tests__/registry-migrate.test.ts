import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { migrateV1ToV2, migrateRegistry } from '../registry-migrate.js';

let fixtureRoot: string;

function registryDir(): string {
  return join(fixtureRoot, '.openslack', 'agents', 'registry');
}

function writeRegistry(agentId: string, yaml: string): void {
  mkdirSync(registryDir(), { recursive: true });
  writeFileSync(join(registryDir(), `${agentId}.yaml`), yaml, 'utf-8');
}

beforeEach(() => {
  fixtureRoot = join(tmpdir(), `openslack-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(fixtureRoot, { recursive: true });
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

const V1_YAML = `schema: openslack.agent_registry.v1
agent_id: "test_agent_bot"
display_name: "Test Agent"
vendor:
  provider: "anthropic"
  runtime: "claude_code"
  model: "sonnet"
employment:
  status: "active"
  hired_at: "2025-01-01T00:00:00Z"
  hired_by: "human:founder"
  department: "engineering"
  role: "developer"
capabilities:
  primary:
    - "typescript"
    - "nodejs"
  secondary:
    - "documentation"
repositories:
  workspace_repo:
    owner: "wsman"
    repo: "OpenSlack"
    default_branch: "main"
workspace_permissions:
  allow:
    - "src/**"
  deny:
    - ".github/**"
risk_level: "yellow"
execution:
  max_parallel_tasks: 2
  lease_ttl_minutes: 60
output_contract:
  must_create:
    - "workspace_run_record"
  may_create:
    - "workspace_pr"
  must_not_create:
    - "direct_main_push"
approval_rules:
  require_human_approval_for:
    - "merge_to_main"
`;

describe('migrateV1ToV2', () => {
  it('converts v1 entry to v2 schema', () => {
    const data = parseYaml(V1_YAML) as Record<string, unknown>;
    const result = migrateV1ToV2(data, 'test_agent_bot');

    expect(result.schema).toBe('openslack.agent_registry.v2');
    expect(result.agent_id).toBe('test_agent_bot');
    expect(result.display_name).toBe('Test Agent');
    expect(result.employee_type).toBe('ai_agent');
  });

  it('maps capabilities', () => {
    const data = parseYaml(V1_YAML) as Record<string, unknown>;
    const result = migrateV1ToV2(data, 'test_agent_bot');

    expect(result.capabilities.primary).toEqual(['typescript', 'nodejs']);
    expect(result.capabilities.secondary).toEqual(['documentation']);
  });

  it('maps permissions from workspace_permissions and risk_level', () => {
    const data = parseYaml(V1_YAML) as Record<string, unknown>;
    const result = migrateV1ToV2(data, 'test_agent_bot');

    expect(result.permissions.paths.allow).toEqual(['src/**']);
    expect(result.permissions.paths.deny).toEqual(['.github/**']);
    expect(result.permissions.max_risk_zone).toBe('yellow');
  });

  it('generates identity stub', () => {
    const data = parseYaml(V1_YAML) as Record<string, unknown>;
    const result = migrateV1ToV2(data, 'test_agent_bot');

    expect(result.identity.uid).toBe('test_agent_bot');
    expect(result.identity.principal_id).toBe('principal:test_agent_bot');
    expect(result.identity.status).toBe('active');
    expect(result.identity.public_key_jwk).toBeNull();
  });

  it('maps employment fields', () => {
    const data = parseYaml(V1_YAML) as Record<string, unknown>;
    const result = migrateV1ToV2(data, 'test_agent_bot');

    expect(result.employment.status).toBe('active');
    expect(result.employment.hired_at).toBe('2025-01-01T00:00:00Z');
    expect(result.employment.department).toBe('engineering');
    expect(result.employment.role).toBe('developer');
  });

  it('maps execution fields', () => {
    const data = parseYaml(V1_YAML) as Record<string, unknown>;
    const result = migrateV1ToV2(data, 'test_agent_bot');

    expect(result.execution.max_parallel_tasks).toBe(2);
    expect(result.execution.lease_ttl_minutes).toBe(60);
  });

  it('maps output_contract and approval_rules', () => {
    const data = parseYaml(V1_YAML) as Record<string, unknown>;
    const result = migrateV1ToV2(data, 'test_agent_bot');

    expect(result.output_contract.must_create).toEqual(['workspace_run_record']);
    expect(result.output_contract.must_not_create).toEqual(['direct_main_push']);
    expect(result.approval_rules.require_human_approval_for).toEqual(['merge_to_main']);
  });

  it('defaults missing optional fields', () => {
    const result = migrateV1ToV2({
      schema: 'openslack.agent_registry.v1',
      vendor: { provider: 'anthropic', runtime: 'claude_code' },
    } as Record<string, unknown>, 'minimal_agent_bot');

    expect(result.permissions.paths.allow).toEqual(['**']);
    expect(result.permissions.paths.deny).toEqual([]);
    expect(result.permissions.max_risk_zone).toBe('yellow');
    expect(result.vendor.provider).toBe('anthropic');
    expect(result.repositories.workspace_repo.owner).toBe('unknown');
  });

  it('sets default action permissions', () => {
    const result = migrateV1ToV2({
      schema: 'openslack.agent_registry.v1',
      vendor: { provider: 'anthropic', runtime: 'claude_code' },
    } as Record<string, unknown>, 'default_agent_bot');

    expect(result.permissions.actions['task.claim']).toBe('allow');
    expect(result.permissions.actions['pr.propose']).toBe('allow');
    expect(result.permissions.github.can_create_pr).toBe(true);
    expect(result.permissions.github.can_approve).toBe(false);
  });

  it('rejects agent ids that cannot satisfy v2 schema', () => {
    expect(() => migrateV1ToV2({ schema: 'openslack.agent_registry.v1' }, 'legacy')).toThrow('Invalid v2 agent_id');
  });

  it('rejects empty display names', () => {
    expect(() => migrateV1ToV2({
      schema: 'openslack.agent_registry.v1',
      display_name: '',
      vendor: { provider: 'anthropic', runtime: 'claude_code' },
    }, 'empty_name_agent')).toThrow('Invalid display_name');
  });

  it('rejects missing required vendor fields', () => {
    expect(() => migrateV1ToV2({ schema: 'openslack.agent_registry.v1' }, 'missing_vendor_agent')).toThrow('vendor.provider');
  });

  it('rejects invalid risk levels', () => {
    expect(() => migrateV1ToV2({
      schema: 'openslack.agent_registry.v1',
      vendor: { provider: 'anthropic', runtime: 'claude_code' },
      risk_level: 'purple',
    }, 'bad_risk_agent')).toThrow('Invalid risk_level');
  });
});

describe('migrateRegistry', () => {
  it('returns empty for no registry dir', () => {
    const results = migrateRegistry(fixtureRoot);
    expect(results).toEqual([]);
  });

  it('reports already_v2 for v2 entries', () => {
    writeRegistry('v2_agent_bot', `schema: openslack.agent_registry.v2\nagent_id: "v2_agent_bot"\n`);
    const results = migrateRegistry(fixtureRoot);
    expect(results).toEqual([{ agentId: 'v2_agent_bot', status: 'already_v2' }]);
  });

  it('converts v1 entries in preview mode', () => {
    writeRegistry('v1_agent_bot', V1_YAML);
    const results = migrateRegistry(fixtureRoot, { apply: false });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('converted');
    expect(results[0].agentId).toBe('v1_agent_bot');
  });

  it('does not write in preview mode', () => {
    writeRegistry('v1_agent_bot', V1_YAML);
    migrateRegistry(fixtureRoot, { apply: false });
    const content = readFileSync(join(registryDir(), 'v1_agent_bot.yaml'), 'utf-8');
    expect(content).toContain('openslack.agent_registry.v1');
  });

  it('writes v2 in apply mode', () => {
    writeRegistry('v1_agent_bot', V1_YAML);
    migrateRegistry(fixtureRoot, { apply: true });
    const content = readFileSync(join(registryDir(), 'v1_agent_bot.yaml'), 'utf-8');
    expect(content).toContain('openslack.agent_registry.v2');
  });

  it('backs up v1 file in apply mode', () => {
    writeRegistry('v1_agent_bot', V1_YAML);
    migrateRegistry(fixtureRoot, { apply: true });
    const backupPath = join(fixtureRoot, '.openslack', 'agents', 'registry.v1-backup', 'v1_agent_bot.yaml');
    expect(existsSync(backupPath)).toBe(true);
    const backup = readFileSync(backupPath, 'utf-8');
    expect(backup).toContain('openslack.agent_registry.v1');
  });

  it('reports error for unknown schema', () => {
    writeRegistry('weird_agent_bot', `schema: something.else\nagent_id: "weird_agent_bot"\n`);
    const results = migrateRegistry(fixtureRoot);
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('Unknown schema');
  });

  it('does not write invalid v2 ids in apply mode', () => {
    writeRegistry('legacy', `schema: openslack.agent_registry.v1\n`);
    const results = migrateRegistry(fixtureRoot, { apply: true });
    expect(results[0].status).toBe('error');
    expect(results[0].error).toContain('Invalid v2 agent_id');
    const content = readFileSync(join(registryDir(), 'legacy.yaml'), 'utf-8');
    expect(content).toContain('openslack.agent_registry.v1');
  });

  it('handles mixed entries', () => {
    writeRegistry('v1_agent_bot', V1_YAML);
    writeRegistry('v2_agent_bot', `schema: openslack.agent_registry.v2\nagent_id: "v2_agent_bot"\n`);
    writeRegistry('bad_agent_bot', `schema: unknown.schema\n`);
    const results = migrateRegistry(fixtureRoot);
    expect(results).toHaveLength(3);
    const statuses = results.map((r) => r.status);
    expect(statuses).toContain('converted');
    expect(statuses).toContain('already_v2');
    expect(statuses).toContain('error');
  });

  it('does not write any conversions in apply mode when any entry has an error', () => {
    writeRegistry('v1_agent_bot', V1_YAML);
    writeRegistry('bad_agent_bot', `schema: unknown.schema\n`);
    const results = migrateRegistry(fixtureRoot, { apply: true });

    expect(results.map((r) => r.status)).toContain('error');
    const content = readFileSync(join(registryDir(), 'v1_agent_bot.yaml'), 'utf-8');
    expect(content).toContain('openslack.agent_registry.v1');
    const backupPath = join(fixtureRoot, '.openslack', 'agents', 'registry.v1-backup', 'v1_agent_bot.yaml');
    expect(existsSync(backupPath)).toBe(false);
  });
});
