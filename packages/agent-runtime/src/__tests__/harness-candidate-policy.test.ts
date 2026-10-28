/** Candidate-policy evidence only. This never provisions a runtime identity or
 * claims that a synthetic unit snapshot qualifies the real integration subject. */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentRegistryText } from '@openslack/workspace';
import { authorizeAgentAction, compilePathGlob, resolvePermissionSnapshot, type AgentRuntimeIdentity } from '@openslack/kernel';
import { resolveAgentPrincipal } from '@openslack/runtime';

const agentId = 'custom_developer_harness-integration';
const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const candidate = readFileSync(join(repository, '.openslack/agents/registry', `${agentId}.yaml`), 'utf8');
const fixturePath = 'fixtures/harness-closed-loop.txt';
const fixtureBytes = readFileSync(join(repository, fixturePath));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function policy() {
  const registry = parseAgentRegistryText(candidate, agentId)!;
  // In-memory unit data, never a production resolver result or identity file.
  const syntheticIdentity: AgentRuntimeIdentity = { schema: 'openslack.agent_runtime_identity.v1', agent_id: agentId,
    agent_uid: registry.identity.uid, run_id: 'RUN-UNIT-CANDIDATE-POLICY-ONLY', provider: 'cli', public_key_jwk: null,
    key_id: null, key_generated_at: null, started_at: '2026-10-28T00:00:00.000Z' };
  return { registry, snapshot: resolvePermissionSnapshot({ registry, runtimeIdentity: syntheticIdentity })! };
}

describe('exact proposed Harness subject scope (not provisioning)', () => {
  it('locks the one text fixture, two actions, Yellow ceiling and all-false GitHub capabilities', () => {
    const { registry, snapshot } = policy();
    expect(fixtureBytes).toEqual(Buffer.from('before\n'));
    expect(registry.permissions.paths.allow).toEqual([fixturePath]);
    expect(registry.permissions.actions).toEqual({ 'harness.task.dispatch': 'allow', 'harness.task.report': 'allow' });
    expect(registry.permissions.max_risk_zone).toBe('yellow');
    expect(registry.permissions.github).toEqual({ can_create_pr: false, can_comment: false, can_approve: false, can_merge: false });
    expect(compilePathGlob(fixturePath)(fixturePath)).toBe(true);
    for (const action of ['harness.task.dispatch', 'harness.task.report']) {
      expect(authorizeAgentAction({ snapshot, action, changedPaths: [fixturePath], riskZone: 'yellow' }).decision).toBe('allow');
    }
  });

  it.each(['fixtures/harness-closed-loop.txt.bak', 'fixtures/neighbor.txt', '.github/workflows/example.yml',
    'AGENTS.md', 'packages/kernel/src/index.ts', '.env', 'secrets/example.txt'])('denies neighboring or protected path %s', path => {
    const { snapshot } = policy();
    expect(compilePathGlob(fixturePath)(path)).toBe(false);
    for (const action of ['harness.task.dispatch', 'harness.task.report']) expect(authorizeAgentAction({ snapshot, action, changedPaths: [path] }).decision).toBe('deny');
  });

  it('denies broader declared scope, Red/Black and GitHub writes/approval/merge', () => {
    const { snapshot } = policy();
    expect(authorizeAgentAction({ snapshot, action: 'harness.task.dispatch', declaredScope: ['fixtures/**'] }).decision).toBe('deny');
    for (const riskZone of ['red', 'black'] as const) expect(authorizeAgentAction({ snapshot, action: 'harness.task.report', changedPaths: [fixturePath], riskZone }).decision).toBe('deny');
    for (const action of ['github.approve', 'github.merge', 'github.comment', 'pr.propose', 'unknown.action']) expect(authorizeAgentAction({ snapshot, action }).decision).toBe('deny');
  });

  it('exercises a permitted text round trip only on an isolated synthetic copy', () => {
    const { snapshot } = policy();
    const root = mkdtempSync(join(tmpdir(), 'harness-unit-policy-')); roots.push(root);
    mkdirSync(join(root, 'fixtures')); const path = join(root, fixturePath); writeFileSync(path, fixtureBytes);
    expect(authorizeAgentAction({ snapshot, action: 'harness.task.dispatch', changedPaths: [fixturePath] }).decision).toBe('allow');
    writeFileSync(path, 'after\n'); expect(readFileSync(path, 'utf8')).toBe('after\n');
    expect(authorizeAgentAction({ snapshot, action: 'harness.task.report', changedPaths: [fixturePath] }).decision).toBe('allow');
    expect(readFileSync(join(repository, fixturePath))).toEqual(fixtureBytes);
  });

  it('keeps the production resolver fail-closed without creating the missing runtime identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-candidate-no-identity-')); roots.push(root);
    const directory = join(root, '.openslack/agents/registry'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${agentId}.yaml`), candidate);
    const before = readdirSync(root);
    const result = resolveAgentPrincipal({ root, agentId, provider: 'cli' });
    expect(result).toHaveProperty('error', expect.stringContaining('No runtime identity'));
    expect(readdirSync(root)).toEqual(before);
    expect(existsSync(join(root, '.openslack.local'))).toBe(false);
  });
});
