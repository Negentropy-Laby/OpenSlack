import { describe, it, expect } from 'vitest';
import { filterByCapability, filterByRisk, filterByPath, filterRedZonePaths } from '../task-filter.js';
import type { IssueTaskManifest } from '../manifest.js';

function makeManifest(overrides: Partial<IssueTaskManifest> = {}): IssueTaskManifest {
  return {
    schema: 'openslack.github_issue_task.v1',
    task_id: 'TASK-2026-000001',
    title: 'Test',
    agent_type: 'codex',
    risk_level: 'low',
    ...overrides,
  };
}

describe('filterByCapability', () => {
  it('allows when no capabilities required', () => {
    const result = filterByCapability(makeManifest(), { primary: ['typescript'] });
    expect(result.allowed).toBe(true);
  });

  it('allows when agent has required capabilities', () => {
    const result = filterByCapability(
      makeManifest({ required_capabilities: ['typescript', 'nodejs'] }),
      { primary: ['typescript', 'nodejs', 'git'] },
    );
    expect(result.allowed).toBe(true);
  });

  it('denies when agent lacks required capability', () => {
    const result = filterByCapability(
      makeManifest({ required_capabilities: ['python'] }),
      { primary: ['typescript'] },
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('python');
  });

  it('checks secondary capabilities too', () => {
    const result = filterByCapability(
      makeManifest({ required_capabilities: ['docker'] }),
      { primary: ['typescript'], secondary: ['docker', 'git'] },
    );
    expect(result.allowed).toBe(true);
  });
});

describe('filterByRisk', () => {
  it('allows low risk with medium max', () => {
    expect(filterByRisk(makeManifest({ risk_level: 'low' }), 'medium').allowed).toBe(true);
  });

  it('allows medium risk with medium max', () => {
    expect(filterByRisk(makeManifest({ risk_level: 'medium' }), 'medium').allowed).toBe(true);
  });

  it('denies high risk with medium max', () => {
    const result = filterByRisk(makeManifest({ risk_level: 'high' }), 'medium');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeds');
  });

  it('always denies critical risk', () => {
    const result = filterByRisk(makeManifest({ risk_level: 'critical' }), 'high');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('critical');
  });
});

describe('filterByPath', () => {
  it('allows path not matching forbidden patterns', () => {
    expect(filterByPath(makeManifest({ forbidden_paths: ['.github/**'] }), ['docs/test.md']).allowed).toBe(true);
  });

  it('denies path matching forbidden pattern', () => {
    const result = filterByPath(makeManifest({ forbidden_paths: ['.github/**'] }), ['.github/workflows/test.yml']);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('.github/**');
  });

  it('denies Black Zone .env', () => {
    const result = filterByPath(makeManifest(), ['.env']);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Black Zone');
  });

  it('denies .pem files', () => {
    expect(filterByPath(makeManifest(), ['certs/ca.pem']).allowed).toBe(false);
  });

  it('denies .key files', () => {
    expect(filterByPath(makeManifest(), ['server.key']).allowed).toBe(false);
  });

  it('denies secrets/ directory', () => {
    expect(filterByPath(makeManifest(), ['secrets/prod.key']).allowed).toBe(false);
  });

  it('handles ** glob correctly for nested directories', () => {
    const result = filterByPath(makeManifest({ forbidden_paths: ['packages/secret/**'] }), ['packages/secret/deep/nested/file.ts']);
    expect(result.allowed).toBe(false);
  });
});

describe('filterRedZonePaths', () => {
  it('identifies .github/ paths as red zone', () => {
    const red = filterRedZonePaths(['docs/test.md', '.github/workflows/test.yml', 'packages/core/src/foo.ts']);
    expect(red).toEqual(['.github/workflows/test.yml']);
  });

  it('identifies policies/ paths as red zone', () => {
    const red = filterRedZonePaths(['.openslack/policies/risk.yaml']);
    expect(red).toHaveLength(1);
  });

  it('identifies kernel/src/ paths as red zone', () => {
    const red = filterRedZonePaths(['packages/kernel/src/zones.ts']);
    expect(red).toHaveLength(1);
  });

  it('returns empty for all-green paths', () => {
    expect(filterRedZonePaths(['docs/test.md', 'packages/core/src/foo.ts'])).toHaveLength(0);
  });
});
