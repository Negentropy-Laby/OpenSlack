import { describe, it, expect, afterEach } from 'vitest';
import { createRollbackTask, executeRollback } from '../rollback.js';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openslack.yaml'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

describe('createRollbackTask', () => {
  afterEach(() => {
    // Clean up
    const root = findRepoRoot();
    const backlog = join(root, '.openslack', 'self', 'evolution_backlog');
    const yaml = join(backlog, 'rollback-test.yaml');
    try { unlinkSync(yaml); } catch { /* ok */ }
  });

  it('creates a rollback EVOL YAML file with correct name', () => {
    const taskId = createRollbackTask('EXP-TEST-ROLLBACK');
    expect(taskId).toMatch(/^EVOL-\d{4}-\d{6}$/);

    const root = findRepoRoot();
    const yamlPath = join(root, '.openslack', 'self', 'evolution_backlog', `${taskId}.yaml`);
    expect(existsSync(yamlPath)).toBe(true);
  });
});

describe('executeRollback', () => {
  it('is callable without throwing', () => {
    // executeRollback prints advice; doesn't actually run git revert
    expect(() => executeRollback('EXP-TEST')).not.toThrow();
  });
});
