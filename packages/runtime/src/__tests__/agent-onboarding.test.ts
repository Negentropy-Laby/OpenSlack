import { authorizeAgentAction, resolvePermissionSnapshot } from '@openslack/kernel';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import {
  agentRegistryV2Schema,
  isSafeAgentId,
  migrateV1ToV2,
  parseAgentRegistryText,
} from '@openslack/workspace';
import {
  hireAgent,
  AGENT_ONBOARDING_DOCUMENTS,
  type HireAgentOptions,
} from '../agent-onboarding.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hire package with spaces '));
  roots.push(root);
  mkdirSync(join(root, 'templates'));
  cpSync(join(process.cwd(), 'templates/new-agent'), join(root, 'templates/new-agent'), {
    recursive: true,
  });
  return root;
}
const validate = new Ajv2020({ strict: false }).compile(agentRegistryV2Schema);
function registry(root: string, id = 'fixture-agent') {
  return readFileSync(join(root, '.openslack/agents/registry', `${id}.yaml`), 'utf8');
}

describe('onboarding public input and portable identity', () => {
  it.each([
    undefined,
    null,
    42,
    {},
    '',
    '../escape',
    'a/b',
    'tail.',
    'safe\n',
    'CON',
    'Nul.txt',
    'COM1',
    'lpt9.log',
    'a'.repeat(129),
  ])('rejects invalid ID %j before filesystem access', (agentId) => {
    expect(isSafeAgentId(agentId)).toBe(false);
    expect(() => hireAgent({ rootDir: 'not-created', agentId } as HireAgentOptions)).toThrow(
      'AGENT_HIRE_ID_INVALID',
    );
    expect(validate({ ...validEntry, agent_id: agentId })).toBe(false);
    expect(
      parseAgentRegistryText('schema: openslack.agent_registry.v1', agentId as string),
    ).toBeNull();
    expect(() =>
      migrateV1ToV2(
        { vendor: { provider: 'openai', runtime: 'codex' }, agent_id: agentId },
        agentId as string,
      ),
    ).toThrow();
  });
  it.each([
    'operator',
    'pr_reviewer',
    'codex.v2',
    'MyBot',
    'fixture-agent',
    'codex_qualification_rext',
    'a'.repeat(128),
  ])('preserves portable ID %s across all boundaries', (agentId) => {
    expect(isSafeAgentId(agentId)).toBe(true);
    expect(validate({ ...validEntry, agent_id: agentId })).toBe(true);
    expect(
      parseAgentRegistryText(`schema: openslack.agent_registry.v1\nagent_id: ${agentId}`, agentId)
        ?.agent_id,
    ).toBe(agentId);
    expect(
      migrateV1ToV2({ vendor: { provider: 'openai', runtime: 'codex' } }, agentId).agent_id,
    ).toBe(agentId);
    const rootDir = fixture();
    hireAgent({ rootDir, agentId });
    expect(parse(registry(rootDir, agentId)).agent_id).toBe(agentId);
  });
  it.each(['department', 'role', 'manager', 'githubOwner', 'githubRepo', 'runtime'])(
    'names empty field %s without publishing',
    (field) => {
      expect(() => hireAgent({ rootDir: 'not-created', agentId: 'safe', [field]: '' })).toThrow(
        field,
      );
    },
  );
  it('validates options and value types instead of coercing them', () => {
    for (const options of [
      null,
      undefined,
      { agentId: 'safe', rootDir: 2 },
      { agentId: 'safe', rootDir: 'x', role: {} },
    ])
      expect(() => hireAgent(options as HireAgentOptions)).toThrow('AGENT_HIRE_FIELD_INVALID');
  });
  it('restores empty display name fallback and emits a complete typed registry', () => {
    const rootDir = fixture();
    hireAgent({ rootDir, agentId: 'fixture-agent', displayName: '' });
    const entry = parse(registry(rootDir));
    expect(entry.display_name).toBe('fixture agent');
    expect(validate(entry), JSON.stringify(validate.errors)).toBe(true);
    expect(entry.identity).toMatchObject({
      public_key_jwk: null,
      key_id: null,
      key_rotation: { last_rotated_at: null, rotation_interval_days: 90 },
    });
    expect(entry.permissions.max_risk_zone).toBe('yellow');
    expect(entry.task_matching.max_risk_level).toBe('medium');
    expect(
      parseAgentRegistryText(registry(rootDir), 'fixture-agent')?.permissions.max_risk_zone,
    ).toBe('yellow');
  });
  it.each(['claude_code', 'codex', 'custom_runner'])(
    'selects a real entrypoint and explicit provider for %s',
    (runtime) => {
      const rootDir = fixture();
      const result = hireAgent({ rootDir, agentId: 'fixture-agent', runtime });
      expect(existsSync(join(rootDir, result.entrypoint))).toBe(true);
      expect(parse(registry(rootDir)).vendor.provider).toBe(
        { claude_code: 'anthropic', codex: 'openai', custom_runner: 'unconfigured' }[runtime],
      );
    },
  );
  it('rejects unknown runtime before template access', () => {
    expect(() => hireAgent({ rootDir: 'missing', agentId: 'safe', runtime: 'codex-cli' })).toThrow(
      'AGENT_HIRE_RUNTIME_INVALID',
    );
  });
});

const validEntry = {
  schema: 'openslack.agent_registry.v2',
  agent_id: 'safe',
  display_name: 'safe',
  employee_type: 'ai_agent',
  identity: { uid: 'safe', principal_id: 'principal:safe', status: 'active' },
  vendor: { provider: 'openai', runtime: 'codex' },
  employment: { status: 'onboarding', hired_at: '2026-01-01' },
  capabilities: { primary: [] },
  repositories: { workspace_repo: { owner: 'test', repo: 'test', default_branch: 'main' } },
  permissions: {
    paths: { allow: [], deny: [] },
    actions: {},
    github: { can_create_pr: false, can_comment: false, can_approve: false, can_merge: false },
    max_risk_zone: 'yellow',
  },
  execution: {},
  output_contract: { must_create: [], may_create: [], must_not_create: [] },
  approval_rules: { require_human_approval_for: [] },
};

describe('onboarding template inventory and rendering', () => {
  it('reports a missing source template package without leaking machine paths or writing', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'missing onboarding '));
    roots.push(rootDir);
    try {
      hireAgent({ rootDir, agentId: 'safe' });
      throw new Error('expected failure');
    } catch (error) {
      expect(String(error)).toContain('AGENT_HIRE_TEMPLATES_UNAVAILABLE');
      expect(String(error)).not.toContain(rootDir);
    }
    expect(existsSync(join(rootDir, '.openslack'))).toBe(false);
  });
  it.each(['fifth.md', 'identity.yaml'])(
    'rejects unreviewed inventory %s before publishing',
    (name) => {
      const rootDir = fixture();
      writeFileSync(join(rootDir, 'templates/new-agent', name), 'non-sensitive fixture');
      expect(() => hireAgent({ rootDir, agentId: 'safe' })).toThrow('AGENT_HIRE_TEMPLATE_INVALID');
      expect(existsSync(join(rootDir, '.openslack'))).toBe(false);
    },
  );
  it('rejects a missing required file before publishing', () => {
    const rootDir = fixture();
    rmSync(join(rootDir, 'templates/new-agent/START_HERE.md'));
    expect(() => hireAgent({ rootDir, agentId: 'safe' })).toThrow('AGENT_HIRE_TEMPLATE_INVALID');
    expect(existsSync(join(rootDir, '.openslack'))).toBe(false);
  });
  it('renders user punctuation as literal text without creating Markdown references', () => {
    const rootDir = fixture();
    const value = 'CI `docs/missing.md` [link](bad) <tag> & bot';
    hireAgent({
      rootDir,
      agentId: 'fixture-agent',
      displayName: value,
      role: value,
      manager: value,
      githubRepo: value,
    });
    expect(parse(registry(rootDir)).display_name).toBe(value);
    const folder = join(rootDir, '.openslack/agents/onboarding/fixture-agent');
    expect(readdirSync(folder).sort()).toEqual([...AGENT_ONBOARDING_DOCUMENTS].sort());
    const content = readFileSync(join(folder, 'START_HERE.md'), 'utf8');
    expect(content).not.toContain('`docs/missing.md`');
    expect(content).not.toContain('[link](bad)');
    expect(content).toContain('&#96;docs/missing.md&#96;');
    expect(content).not.toContain(rootDir);
    expect(existsSync(join(rootDir, '.openslack/agents/prompts'))).toBe(true);
    expect(existsSync(join(rootDir, '.openslack.local'))).toBe(false);
  });
});

describe('registry permission fallback', () => {
  it.each([undefined, '', 'green', 'yellow', 'red', 'black'])(
    'preserves valid explicit zones and defaults %j to Yellow',
    (zone) => {
      const entry = {
        ...validEntry,
        permissions: { ...validEntry.permissions, max_risk_zone: zone },
      };
      expect(parseAgentRegistryText(JSON.stringify(entry), 'safe')?.permissions.max_risk_zone).toBe(
        zone || 'yellow',
      );
    },
  );
  it.each([null, false, 'RED', 'unknown'])('rejects invalid explicit zone %j', (zone) => {
    expect(() =>
      parseAgentRegistryText(
        JSON.stringify({
          ...validEntry,
          permissions: { ...validEntry.permissions, max_risk_zone: zone },
        }),
        'safe',
      ),
    ).toThrow('AGENT_RISK_ZONE_INVALID');
  });
});

describe('generated registry authorization', () => {
  it('enforces deny even against an overlapping allow and rejects task-external paths', () => {
    const rootDir = fixture();
    hireAgent({ rootDir, agentId: 'fixture-agent' });
    const entry = parseAgentRegistryText(registry(rootDir), 'fixture-agent')!;
    const runtimeIdentity = {
      schema: 'openslack.agent_runtime_identity.v1' as const,
      agent_id: 'fixture-agent',
      agent_uid: 'fixture',
      run_id: 'fixture',
      public_key_jwk: null,
      key_id: null,
      key_generated_at: null,
      provider: 'cli' as const,
      started_at: '2026-09-14T00:00:00Z',
    };
    const snapshot = resolvePermissionSnapshot({ registry: entry, runtimeIdentity });
    expect(
      authorizeAgentAction({
        snapshot,
        action: 'task.sync',
        changedPaths: ['packages/runtime/src/file.ts'],
      }).decision,
    ).toBe('deny');
    const overlapping = resolvePermissionSnapshot({
      registry: {
        ...entry,
        permissions: {
          ...entry.permissions,
          max_risk_zone: 'red',
          paths: { ...entry.permissions.paths, allow: ['**'] },
        },
      },
      runtimeIdentity,
    });
    const result = authorizeAgentAction({
      snapshot: overlapping,
      action: 'task.sync',
      changedPaths: ['.github/workflows/test.yml'],
    });
    expect(result.decision).toBe('deny');
    expect(result.evidence.rule).toBe('path_denied');
  });
});
