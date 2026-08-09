import { describe, it, expect } from 'vitest';
import { filterByCapability, filterByRisk, filterByPath } from '../task-filter.js';
import type { IssueTaskManifest } from '../manifest.js';

function makeManifest(overrides: Partial<IssueTaskManifest> = {}): IssueTaskManifest {
  return {
    schema: 'openslack.github_issue_task.v1',
    task_id: 'TASK-2026-000001',
    title: 'Test',
    status: 'ready',
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
    const result = filterByCapability(makeManifest({ required_capabilities: ['python'] }), {
      primary: ['typescript'],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('python');
  });

  it('checks secondary capabilities too', () => {
    const result = filterByCapability(makeManifest({ required_capabilities: ['docker'] }), {
      primary: ['typescript'],
      secondary: ['docker', 'git'],
    });
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

  it('fails closed on an unsupported agent ceiling', () => {
    const result = filterByRisk(makeManifest(), 'loww');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('unsupported');
  });
});

describe('filterByPath', () => {
  it('allows path not matching forbidden patterns', () => {
    expect(
      filterByPath(makeManifest({ forbidden_paths: ['.github/**'] }), ['docs/test.md']).allowed,
    ).toBe(true);
  });

  it('denies path matching forbidden pattern', () => {
    const result = filterByPath(makeManifest({ forbidden_paths: ['.github/**'] }), [
      '.github/workflows/test.yml',
    ]);
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

  it('uses canonical Black Zone paths beyond the former local regex list', () => {
    expect(filterByPath(makeManifest(), ['private/token.txt']).allowed).toBe(false);
    expect(filterByPath(makeManifest(), ['production-tokens/live.txt']).allowed).toBe(false);
  });

  it('handles ** glob correctly for nested directories', () => {
    const result = filterByPath(makeManifest({ forbidden_paths: ['packages/secret/**'] }), [
      'packages/secret/deep/nested/file.ts',
    ]);
    expect(result.allowed).toBe(false);
  });

  it('treats regex metacharacters as literal path text', () => {
    const manifest = makeManifest({ forbidden_paths: ['packages/(test/foo', '(a+)+', '[abc].ts'] });
    expect(() => filterByPath(manifest, ['packages/test/foo'])).not.toThrow();
    expect(filterByPath(manifest, ['a'.repeat(20_000) + '!']).allowed).toBe(true);
    expect(filterByPath(manifest, ['(a+)+']).allowed).toBe(false);
    expect(filterByPath(manifest, ['[abc].ts']).allowed).toBe(false);
    expect(filterByPath(manifest, ['a.ts']).allowed).toBe(true);
  });

  it('keeps single-star matching within one directory segment', () => {
    const manifest = makeManifest({ forbidden_paths: ['packages/*/file.ts'] });
    expect(filterByPath(manifest, ['packages/core/file.ts']).allowed).toBe(false);
    expect(filterByPath(manifest, ['packages/core/nested/file.ts']).allowed).toBe(true);
  });

  it('lets **/ match zero or more complete directory segments', () => {
    const manifest = makeManifest({ forbidden_paths: ['**/secret.txt'] });
    expect(filterByPath(manifest, ['secret.txt']).allowed).toBe(false);
    expect(filterByPath(manifest, ['deep/nested/secret.txt']).allowed).toBe(false);
    expect(filterByPath(manifest, ['deep/nested/not-secret.txt']).allowed).toBe(true);
  });
});
