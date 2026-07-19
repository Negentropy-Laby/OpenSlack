import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { repairWorktrees } from '../repair.js';

function makeRoot(): string {
  const root = join(
    tmpdir(),
    `openslack-repair-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(root, '.worktrees', 'RUN-1'), { recursive: true });
  writeFileSync(join(root, 'openslack.yaml'), 'schema: openslack.workspace.v1\n', 'utf-8');
  return root;
}

describe('repairWorktrees', () => {
  it('previews orphaned worktree cleanup without mutation by default', () => {
    const root = makeRoot();
    try {
      const result = repairWorktrees({ root });
      expect(result.dryRun).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].planned).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies orphaned worktree cleanup only when dryRun is false', () => {
    const root = makeRoot();
    try {
      const result = repairWorktrees({ root, dryRun: false });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].fixed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
