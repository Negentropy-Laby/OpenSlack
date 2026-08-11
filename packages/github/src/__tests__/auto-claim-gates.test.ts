import { describe, expect, it } from 'vitest';
import { riskLevelToZone, runAutoClaimGates } from '../task-filter.js';

function makeBody(overrides: Record<string, unknown> = {}): string {
  const manifest: Record<string, unknown> = {
    schema: 'openslack.github_issue_task.v1',
    task_id: 'TASK-2026-000001',
    title: 'Test task',
    status: 'ready',
    agent_type: 'codex',
    risk_level: 'low',
    ...overrides,
  };
  return `Some issue description\n\n\`\`\`openslack-task\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n`;
}

function runGate(
  body: string,
  overrides: {
    state?: 'open' | 'closed' | 'unknown';
    labels?: string[];
    maxRisk?: unknown;
    capabilities?: { primary?: string[]; secondary?: string[] };
  } = {},
) {
  return runAutoClaimGates({
    candidate: {
      body,
      state: overrides.state ?? 'open',
      labels: overrides.labels ?? ['openslack:task', 'openslack:ready', 'agent-type:codex'],
    },
    agentCapabilities: overrides.capabilities ?? { primary: ['typescript'], secondary: [] },
    agentMaxRiskLevel: overrides.maxRisk ?? 'high',
  });
}

describe('riskLevelToZone', () => {
  it.each([
    ['low', 'green'],
    ['medium', 'yellow'],
    ['high', 'red'],
    ['critical', 'black'],
  ] as const)('maps %s to %s', (level, zone) => {
    expect(riskLevelToZone(level)).toBe(zone);
  });
});

describe('runAutoClaimGates', () => {
  it('binds open state and both ready labels into the shared gate', () => {
    expect(runGate(makeBody(), { state: 'closed' }).reason).toContain('not open');
    expect(runGate(makeBody(), { state: 'unknown' }).reason).toContain('not open');
    expect(runGate(makeBody(), { labels: ['openslack:task'] }).reason).toContain('openslack:ready');
  });

  it('binds the manifest agent type to exactly one canonical routing label', () => {
    expect(runGate(makeBody(), { labels: ['openslack:task', 'openslack:ready'] })).toMatchObject({
      allowed: false,
      code: 'AGENT_TYPE_LABEL_INVALID',
      manifest: null,
    });
    expect(
      runGate(makeBody(), {
        labels: ['openslack:task', 'openslack:ready', 'agent-type:reviewer'],
      }),
    ).toMatchObject({ allowed: false, code: 'AGENT_TYPE_LABEL_INVALID', manifest: null });
    expect(
      runGate(makeBody(), {
        labels: ['openslack:task', 'openslack:ready', 'agent-type:codex', 'agent-type:reviewer'],
      }),
    ).toMatchObject({ allowed: false, code: 'AGENT_TYPE_LABEL_INVALID', manifest: null });
  });

  it('blocks when body has no manifest block', () => {
    const result = runGate('Just a plain issue body');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No openslack-task block');
    expect(result.manifest).toBeNull();
  });

  it('blocks invalid, missing-status, and non-ready manifests', () => {
    expect(runGate('```openslack-task\ninvalid: yaml\nschema: wrong\n```').allowed).toBe(false);
    expect(runGate(makeBody({ status: undefined })).reason).toContain('status');
    expect(runGate(makeBody({ status: 'blocked' })).reason).toContain('got blocked');
  });

  it('never exposes a parsed manifest on a rejected result', () => {
    for (const result of [
      runGate(makeBody({ status: 'blocked' })),
      runGate(makeBody({ risk_level: 'high' }), { maxRisk: 'low' }),
      runGate(makeBody({ required_capabilities: ['python'] })),
      runGate(
        makeBody({
          risk_level: 'critical',
          allowed_paths: ['.env'],
        }),
        { maxRisk: 'critical' },
      ),
    ]) {
      expect(result.allowed).toBe(false);
      expect(result.manifest).toBeNull();
      expect(result.code).not.toBe('ALLOWED');
    }
  });

  it('blocks when risk exceeds the agent ceiling or the ceiling is invalid', () => {
    expect(runGate(makeBody({ risk_level: 'high' }), { maxRisk: 'low' }).reason).toContain(
      'exceeds',
    );
    expect(runGate(makeBody(), { maxRisk: 'hig' }).reason).toContain('unsupported');
  });

  it('always blocks critical risk', () => {
    expect(runGate(makeBody({ risk_level: 'critical' }), { maxRisk: 'critical' }).reason).toContain(
      'Critical',
    );
  });

  it('blocks when the agent lacks required capabilities', () => {
    const result = runGate(makeBody({ required_capabilities: ['python', 'ml'] }), {
      capabilities: { primary: ['typescript'], secondary: ['nodejs'] },
    });
    expect(result.reason).toContain('python');
  });

  it('uses canonical path risk and rejects declared-risk understatements', () => {
    const red = runGate(
      makeBody({
        allowed_paths: ['AGENTS.md'],
        human_approval_required_for: ['red_zone_change'],
      }),
    );
    expect(red.allowed).toBe(false);
    expect(red.reason).toContain('understates declared path scope red');

    const plugin = runGate(
      makeBody({
        allowed_paths: ['.openslack/plugins/demo/plugin.json'],
        human_approval_required_for: ['red_zone_change'],
      }),
    );
    expect(plugin.reason).toContain('understates declared path scope red');

    const broadPackage = runGate(
      makeBody({
        risk_level: 'medium',
        allowed_paths: ['packages/**'],
        human_approval_required_for: ['red_zone_change'],
      }),
    );
    expect(broadPackage.reason).toContain('understates declared path scope red');
  });

  it('blocks canonical Black Zone paths', () => {
    for (const path of ['.env', 'private/token.txt', 'production-tokens/live.txt']) {
      const result = runGate(makeBody({ risk_level: 'critical', allowed_paths: [path] }), {
        maxRisk: 'critical',
      });
      expect(result.allowed, path).toBe(false);
      expect(result.reason, path).toContain('Black Zone');
    }
  });

  it('allows a valid manifest and returns its declared scope and effective risk', () => {
    const result = runGate(makeBody({ risk_level: 'medium', allowed_paths: ['docs/**'] }));
    expect(result.allowed).toBe(true);
    expect(result.manifest).not.toBeNull();
    expect(result.riskZone).toBe('yellow');
    expect(result.declaredScope).toEqual(['docs/**']);
  });

  it('returns all declared paths and preserves an empty scope', () => {
    expect(
      runGate(makeBody({ risk_level: 'medium', allowed_paths: ['packages/runtime/**', 'docs/**'] }))
        .declaredScope,
    ).toEqual(['packages/runtime/**', 'docs/**']);
    expect(runGate(makeBody()).declaredScope).toEqual([]);
  });
});
