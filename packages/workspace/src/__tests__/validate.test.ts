import { describe, it, expect } from 'vitest';
import { validateWorkspace } from '../validate.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function createTempWorkspace(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'openslack-test-'));
  writeFileSync(
    join(dir, 'openslack.yaml'),
    [
      `schema: openslack.workspace.v1`,
      `workspace_id: ${config.workspace_id || 'test-workspace'}`,
      `name: ${config.name || 'Test Workspace'}`,
      `mode: ${config.mode || 'self_project'}`,
      `canonical_remote:`,
      `  provider: github`,
      `  owner: test-org`,
      `  repo: test-repo`,
      `  default_branch: main`,
      `workspace:`,
      `  root: "."`,
      `  state_root: "${config.state_root || '.openslack'}"`,
      `product:`,
      `  repo_role: self`,
      `  source_roots:`,
      `    - apps`,
      `  protected_roots:`,
      `    - .github`,
      ...(config.extra ? [String(config.extra)] : []),
    ].join('\n'),
  );
  return dir;
}

function setupStateDir(dir: string, stateRoot = '.openslack'): void {
  const root = join(dir, stateRoot);
  for (const sub of [
    'agents/registry',
    'agents/prompts',
    'policies',
    'self',
    'tasks',
    'leases',
    'audit',
    'collaboration',
  ]) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  writeFileSync(join(root, 'self', 'constitution.md'), '# Test Constitution\n');
}

describe('validateWorkspace', () => {
  it('passes for valid workspace with complete state directory', () => {
    const dir = createTempWorkspace({});
    setupStateDir(dir);
    const result = validateWorkspace(dir);
    expect(result.valid).toBe(true);
    expect(result.errors.filter((e) => e.severity === 'error')).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails when openslack.yaml is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openslack-test-'));
    const result = validateWorkspace(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('not found'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails when state_root directory is missing', () => {
    const dir = createTempWorkspace({});
    const result = validateWorkspace(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('does not exist'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails with invalid mode', () => {
    const dir = createTempWorkspace({ mode: 'invalid_mode' });
    setupStateDir(dir);
    const result = validateWorkspace(dir);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('mode'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails when required state subdirectories are missing', () => {
    const dir = createTempWorkspace({});
    // Create state root but missing subdirs
    mkdirSync(join(dir, '.openslack'), { recursive: true });
    const result = validateWorkspace(dir);
    expect(result.valid).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
