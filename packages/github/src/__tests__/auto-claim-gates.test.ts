import { describe, it, expect } from 'vitest';
import { riskLevelToZone, runAutoClaimGates } from '../task-filter.js';

function makeBody(overrides: Record<string, unknown> = {}): string {
  const manifest: Record<string, unknown> = {
    schema: 'openslack.github_issue_task.v1',
    task_id: 'TASK-2026-000001',
    title: 'Test task',
    agent_type: 'codex',
    risk_level: 'low',
    ...overrides,
  };
  return (
    'Some issue description\n\n```openslack-task\n' + JSON.stringify(manifest, null, 2) + '\n```\n'
  );
}

describe('riskLevelToZone', () => {
  it('maps low to green', () => {
    expect(riskLevelToZone('low')).toBe('green');
  });

  it('maps medium to yellow', () => {
    expect(riskLevelToZone('medium')).toBe('yellow');
  });

  it('maps high to red', () => {
    expect(riskLevelToZone('high')).toBe('red');
  });

  it('maps critical to black', () => {
    expect(riskLevelToZone('critical')).toBe('black');
  });
});

describe('runAutoClaimGates', () => {
  const defaultCapabilities = { primary: ['typescript'], secondary: [] };
  const defaultMaxRisk = 'high';

  it('blocks when body has no manifest block', () => {
    const result = runAutoClaimGates({
      body: 'Just a plain issue body',
      agentCapabilities: defaultCapabilities,
      agentMaxRiskLevel: defaultMaxRisk,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No openslack-task block');
    expect(result.manifest).toBeNull();
  });

  it('blocks when manifest is invalid', () => {
    const body = '```openslack-task\ninvalid: yaml\nschema: wrong\n```\n';
    const result = runAutoClaimGates({
      body,
      agentCapabilities: defaultCapabilities,
      agentMaxRiskLevel: defaultMaxRisk,
    });
    expect(result.allowed).toBe(false);
    expect(result.manifest).toBeNull();
  });

  it('blocks when risk exceeds agent max', () => {
    const result = runAutoClaimGates({
      body: makeBody({ risk_level: 'high' }),
      agentCapabilities: defaultCapabilities,
      agentMaxRiskLevel: 'low',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeds');
  });

  it('always blocks critical risk', () => {
    const result = runAutoClaimGates({
      body: makeBody({ risk_level: 'critical' }),
      agentCapabilities: defaultCapabilities,
      agentMaxRiskLevel: 'critical',
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Critical');
  });

  it('blocks when agent lacks required capabilities', () => {
    const result = runAutoClaimGates({
      body: makeBody({ required_capabilities: ['python', 'ml'] }),
      agentCapabilities: { primary: ['typescript'], secondary: ['nodejs'] },
      agentMaxRiskLevel: defaultMaxRisk,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('python');
  });

  it('blocks when allowed_paths contain black zone paths', () => {
    const result = runAutoClaimGates({
      body: makeBody({ allowed_paths: ['.env', 'docs/test.md'] }),
      agentCapabilities: defaultCapabilities,
      agentMaxRiskLevel: defaultMaxRisk,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Black Zone');
  });

  it('allows valid manifest with matching capabilities and acceptable risk', () => {
    const result = runAutoClaimGates({
      body: makeBody({ risk_level: 'medium', allowed_paths: ['docs/**'] }),
      agentCapabilities: defaultCapabilities,
      agentMaxRiskLevel: 'high',
    });
    expect(result.allowed).toBe(true);
    expect(result.manifest).not.toBeNull();
    expect(result.riskZone).toBe('yellow');
    expect(result.changedPaths).toEqual(['docs/**']);
  });

  it('defaults changedPaths to manifest allowed_paths', () => {
    const result = runAutoClaimGates({
      body: makeBody({ allowed_paths: ['packages/runtime/**', 'docs/**'] }),
      agentCapabilities: defaultCapabilities,
      agentMaxRiskLevel: 'high',
    });
    expect(result.allowed).toBe(true);
    expect(result.changedPaths).toEqual(['packages/runtime/**', 'docs/**']);
  });

  it('returns empty changedPaths when manifest has no allowed_paths', () => {
    const result = runAutoClaimGates({
      body: makeBody(),
      agentCapabilities: defaultCapabilities,
      agentMaxRiskLevel: 'high',
    });
    expect(result.allowed).toBe(true);
    expect(result.changedPaths).toEqual([]);
  });
});
