import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { hireAgent, AGENT_ONBOARDING_DOCUMENTS } from '@openslack/runtime';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'onboarding with spaces '));
  roots.push(root);
  const destination = join(root, 'templates', 'new-agent');
  mkdirSync(destination, { recursive: true });
  for (const name of AGENT_ONBOARDING_DOCUMENTS)
    copyFileSync(join(process.cwd(), 'templates', 'new-agent', name), join(destination, name));
  return root;
}
describe('new-agent template format safety', () => {
  it('generates executable Codex guidance and a typed manual registry in a path with spaces', () => {
    const rootDir = fixture();
    const result = hireAgent({
      rootDir,
      agentId: 'fixture-agent',
      runtime: 'codex',
      displayName: 'Quoted "name": C:\\fixtures',
      githubOwner: 'owner',
      githubRepo: 'repo',
    });
    const registry = parse(
      readFileSync(join(rootDir, '.openslack/agents/registry/fixture-agent.yaml'), 'utf8'),
    );
    expect(registry.display_name).toBe('Quoted "name": C:\\fixtures');
    expect(registry.vendor).toMatchObject({ provider: 'openai', runtime: 'codex' });
    expect(registry.scheduler).toEqual({ preferred_mode: 'manual', cadence_minutes: 0 });
    expect(registry.execution).toEqual({ max_parallel_tasks: 1, max_task_runtime_minutes: 120 });
    expect(registry.permissions.github).toMatchObject({ can_approve: false, can_merge: false });
    expect(existsSync(join(rootDir, result.entrypoint))).toBe(true);
    const folder = join(rootDir, '.openslack/agents/onboarding/fixture-agent');
    expect(readdirSync(folder).sort()).toEqual([...AGENT_ONBOARDING_DOCUMENTS].sort());
    for (const file of readdirSync(folder)) {
      const content = readFileSync(join(folder, file), 'utf8');
      expect(content).not.toMatch(
        /\{\{[A-Z_]+\}\}|\/v1\/claims|--claim-one|--source (?:github-project|local-cron)|schedule.github-actions|local_cron/,
      );
      expect(content).not.toContain(rootDir);
      expect(content).not.toMatch(/agents\/prompts\/[^\s`]+\.md/);
    }
    expect(readFileSync(join(rootDir, result.entrypoint), 'utf8')).toContain('claim receipt');
  });
  it('does not overwrite a deployed identity', () => {
    const rootDir = fixture();
    hireAgent({ rootDir, agentId: 'fixture-agent' });
    const registry = join(rootDir, '.openslack/agents/registry/fixture-agent.yaml');
    const before = readFileSync(registry, 'utf8');
    expect(() => hireAgent({ rootDir, agentId: 'fixture-agent', runtime: 'codex' })).toThrow(
      'already exists',
    );
    expect(readFileSync(registry, 'utf8')).toBe(before);
  });
  it.each(['../escape', 'a/b', 'C:escape', ''])(
    'rejects an unsafe agent ID %j before writing',
    (agentId) => {
      const rootDir = fixture();
      expect(() => hireAgent({ rootDir, agentId })).toThrow('Agent ID');
      expect(existsSync(join(rootDir, '.openslack'))).toBe(false);
    },
  );
});
