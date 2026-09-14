import { obsoleteOnboarding } from './onboarding-fixture.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgentRegistry } from '@openslack/workspace';
import { authorizeAgentAction, resolvePermissionSnapshot } from '@openslack/kernel';
import { filterByCapability, runAutoClaimGates, type IssueTaskManifest } from '@openslack/github';

const root = process.cwd();
const agentId = 'codex_qualification_rext';
const registry = parseAgentRegistry(root, agentId)!;
// A public, in-memory fixture only: this never loads or assumes the target runtime identity.
const snapshot = resolvePermissionSnapshot({
  registry,
  runtimeIdentity: {
    schema: 'openslack.agent_runtime_identity.v1',
    agent_id: agentId,
    agent_uid: 'fixture-only',
    run_id: 'FIXTURE',
    public_key_jwk: null,
    key_id: null,
    key_generated_at: null,
    provider: 'cli',
    started_at: '2026-09-14T00:00:00Z',
  },
});
const capabilities = ['go', 'typescript', 'postgresql', 'test_writing'];
const manifest: IssueTaskManifest = {
  schema: 'openslack.github_issue_task.v1',
  task_id: 'TASK-2026-000411',
  title: 'Qualification scope fixture',
  status: 'blocked',
  agent_type: 'codex',
  risk_level: 'medium',
  required_capabilities: capabilities,
};
function taskGate(path: string, forbiddenPaths: string[] = []) {
  return runAutoClaimGates({
    candidate: {
      state: 'open',
      labels: ['openslack:task', 'openslack:ready', 'agent-type:codex'],
      body:
        '```openslack-task\n' +
        JSON.stringify({
          ...manifest,
          status: 'ready',
          allowed_paths: [path],
          forbidden_paths: forbiddenPaths,
        }) +
        '\n```',
    },
    agentCapabilities: registry.capabilities!,
    agentMaxRiskLevel: 'medium',
  });
}
describe('manual R-EXT onboarding package', () => {
  it('keeps the administrator capability set complete', () => {
    expect(filterByCapability(manifest, registry.capabilities!).allowed).toBe(true);
    for (const missing of capabilities) {
      expect(
        filterByCapability(manifest, { primary: capabilities.filter((item) => item !== missing) })
          .allowed,
      ).toBe(false);
    }
  });
  it.each([
    '.openslack/workflows/r-ext-go-qualification.mjs',
    'scripts/r-ext-go-qualification/new-fixture.ts',
    'packages/workflows/src/__tests__/r-ext-go-qualification.test.ts',
  ])('authorizes planned creation through task and registry gates: %s', (path) => {
    const gate = taskGate(path);
    expect(gate.allowed).toBe(true);
    expect(gate.declaredScope).toEqual([path]);
    expect(
      authorizeAgentAction({
        snapshot,
        action: 'task.claim',
        riskZone: gate.riskZone,
        declaredScope: gate.declaredScope,
      }).decision,
    ).toBe('allow');
  });
  it.each([
    'packages/runtime/src/tick.ts',
    '.openslack/workflows/unrelated.mjs',
    '.openslack/agents/registry/codex_qualification_rext.yaml',
    '.github/workflows/run.yml',
    'scripts/r-ext-go-qualification/private.key',
  ])('denies an outside or denied path: %s', (path) => {
    expect(
      authorizeAgentAction({ snapshot, action: 'task.sync', changedPaths: [path] }).decision,
    ).toBe('deny');
  });
  it('honors a task prohibition on a registry-authorized path and forbids approval', () => {
    const path = 'scripts/r-ext-go-qualification/other.ts';
    expect(
      authorizeAgentAction({ snapshot, action: 'task.claim', declaredScope: [path] }).decision,
    ).toBe('allow');
    expect(taskGate(path, ['scripts/r-ext-go-qualification/**'])).toMatchObject({
      allowed: false,
      code: 'MANIFEST_INVALID',
      reason: expect.stringContaining('Path conflict'),
    });
    expect(authorizeAgentAction({ snapshot, action: 'github.approve' }).decision).toBe('deny');
  });
  it('ships only manual guidance with resolvable tracked references', () => {
    const folder = join(root, '.openslack/agents/onboarding', agentId);
    expect(readdirSync(folder).sort()).toEqual([
      'START_HERE.md',
      'claude_routine_prompt.md',
      'codex_automation_prompt.md',
      'first_day_checklist.md',
    ]);
    for (const file of readdirSync(folder)) {
      const text = readFileSync(join(folder, file), 'utf8');
      expect(text).not.toMatch(obsoleteOnboarding);
      for (const [, path] of text.matchAll(
        /`((?:\.openslack\/(?:agents|policies)\/|docs\/)[^`]+)`/g,
      )) {
        expect(existsSync(join(root, path)), `${file}: ${path}`).toBe(true);
      }
    }
    const raw = readFileSync(join(root, '.openslack/agents/registry', `${agentId}.yaml`), 'utf8');
    expect(raw).not.toMatch(/lease_ttl_minutes|heartbeat_interval_minutes/);
    expect(registry.scheduler).toEqual({ preferred_mode: 'manual', cadence_minutes: 0 });
    expect(registry.execution.max_parallel_tasks).toBe(1);
    expect(registry.permissions.max_risk_zone).toBe('yellow');
  });
});
