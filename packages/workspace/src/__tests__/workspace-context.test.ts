import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWorkspaceContext } from '../workspace-context.js';
import type { WorkspaceContextError } from '../workspace-context.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceContext', () => {
  it('resolves project and local state roots from a nested directory', () => {
    const root = temp();
    mkdirSync(join(root, 'src', 'nested'), { recursive: true });
    writeFileSync(
      join(root, 'openslack.yaml'),
      'schema: openslack.workspace.v1\nworkspace:\n  state_root: .openslack\n',
      'utf-8',
    );
    const context = resolveWorkspaceContext({
      startDir: join(root, 'src', 'nested'),
      productHome: join(root, 'product'),
    });
    expect(context.workspaceRoot).toBe(root);
    expect(context.projectStateRoot).toBe(join(root, '.openslack'));
    expect(context.localStateRoot).toBe(join(root, '.openslack.local'));
    expect(context.productHome).toBe(join(root, 'product'));
  });

  it('rejects a configured state root that escapes the workspace', () => {
    const root = temp();
    writeFileSync(
      join(root, 'openslack.yaml'),
      'schema: openslack.workspace.v1\nworkspace:\n  state_root: ../outside\n',
      'utf-8',
    );
    expect(() => resolveWorkspaceContext({ workspaceRoot: root })).toThrowError(
      expect.objectContaining<Partial<WorkspaceContextError>>({ code: 'WORKSPACE_PATH_ESCAPE' }),
    );
  });
});

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-context-'));
  roots.push(root);
  return root;
}
