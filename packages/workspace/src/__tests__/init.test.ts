import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyWorkspaceInit, planWorkspaceInit } from '../init.js';
import { validateWorkspace } from '../validate.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workspace initialization', () => {
  it('previews, applies, validates, and reruns idempotently in an ordinary Git repository', () => {
    const root = gitRoot();
    const input = {
      targetRoot: root,
      name: 'Example Product',
      owner: 'acme',
      repo: 'example',
      defaultBranch: 'main',
    };
    const preview = planWorkspaceInit(input);
    expect(preview.applicable).toBe(true);
    expect(preview.operations.some((operation) => operation.action === 'create')).toBe(true);
    expect(existsSync(join(root, 'openslack.yaml'))).toBe(false);

    applyWorkspaceInit(preview);
    expect(validateWorkspace(root).valid).toBe(true);
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toContain('.openslack.local/');
    expect(
      readFileSync(join(root, '.openslack', 'templates', 'agent-runtime.example.json'), 'utf-8'),
    ).toContain('env:OPENSLACK_MODEL_API_KEY');

    const rerun = planWorkspaceInit(input);
    expect(rerun.applicable).toBe(true);
    expect(rerun.operations.every((operation) => operation.action === 'unchanged')).toBe(true);
  });

  it('refuses to overwrite an existing conflicting workspace file', () => {
    const root = gitRoot();
    writeFileSync(join(root, 'openslack.yaml'), 'existing: true\n', 'utf-8');
    const plan = planWorkspaceInit({
      targetRoot: root,
      name: 'Example Product',
      owner: 'acme',
      repo: 'example',
    });
    expect(plan.applicable).toBe(false);
    expect(plan.operations).toContainEqual(
      expect.objectContaining({ path: 'openslack.yaml', action: 'conflict' }),
    );
    expect(() => applyWorkspaceInit(plan)).toThrow('has conflicts');
    expect(readFileSync(join(root, 'openslack.yaml'), 'utf-8')).toBe('existing: true\n');
  });

  it('fails closed when the repository changes after preview', () => {
    const root = gitRoot();
    const plan = planWorkspaceInit({
      targetRoot: root,
      name: 'Example Product',
      owner: 'acme',
      repo: 'example',
    });
    writeFileSync(join(root, 'openslack.yaml'), 'created after preview\n', 'utf-8');
    expect(() => applyWorkspaceInit(plan)).toThrow('changed after preview');
    expect(readFileSync(join(root, 'openslack.yaml'), 'utf-8')).toBe('created after preview\n');
    expect(existsSync(join(root, '.openslack', 'agents'))).toBe(false);
  });
});

function gitRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-init-'));
  roots.push(root);
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  return root;
}
