import { describe, it, expect, afterEach } from 'vitest';
import {
  createRollbackTask,
  executeRollback,
  expireStaleRollbackTasks,
  ROLLBACK_RATE_LIMIT_MS,
  ROLLBACK_TTL_DAYS,
} from '../rollback.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

let tmpRoot: string | undefined;

function makeRepoRoot(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'openslack-rollback-'));
  writeFileSync(join(tmpRoot, 'openslack.yaml'), 'schema: openslack.workspace.v1\n', 'utf-8');
  mkdirSync(join(tmpRoot, '.openslack', 'self', 'evolution_backlog'), { recursive: true });
  return tmpRoot;
}

function backlogPath(root: string, taskId: string): string {
  return join(root, '.openslack', 'self', 'evolution_backlog', `${taskId}.yaml`);
}

describe('createRollbackTask', () => {
  afterEach(() => {
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  it('creates a rollback EVOL YAML file with correct name', () => {
    const root = makeRepoRoot();
    const result = createRollbackTask('EXP-FAKE-ROLLBACK', { root, now: new Date('2026-05-24T00:00:00.000Z') });

    expect(result).toMatchObject({ created: true, updatedExisting: false, reason: 'created' });
    expect(result.taskId).toMatch(/^EVOL-2026-\d{6}$/);
    expect(existsSync(backlogPath(root, result.taskId!))).toBe(true);
  });

  it('deduplicates active rollback proposals for the same experiment', () => {
    const root = makeRepoRoot();
    const first = createRollbackTask('EXP-DEDUP-001', { root, now: new Date('2026-05-24T00:00:00.000Z') });
    const second = createRollbackTask('EXP-DEDUP-001', { root, now: new Date('2026-05-24T00:05:00.000Z') });

    expect(second).toEqual({
      taskId: first.taskId,
      created: false,
      updatedExisting: true,
      reason: 'deduplicated',
    });
    const backlog = join(root, '.openslack', 'self', 'evolution_backlog');
    expect(readFileSync(backlogPath(root, first.taskId!), 'utf-8')).toContain('detection_count: 2');
    expect(existsSync(join(backlog, 'EVOL-2026-000002.yaml'))).toBe(false);
  });

  it('does not create production rollback proposals for EXP-TEST artifacts', () => {
    const root = makeRepoRoot();
    const result = createRollbackTask('EXP-TEST-ROLLBACK', { root });

    expect(result).toEqual({ taskId: null, created: false, updatedExisting: false, reason: 'test_artifact' });
    expect(existsSync(join(root, '.openslack', 'self', 'evolution_backlog', 'EVOL-2026-000001.yaml'))).toBe(false);
  });

  it('keeps retry and TTL thresholds in one exported location', () => {
    expect(ROLLBACK_TTL_DAYS).toBe(7);
    expect(ROLLBACK_RATE_LIMIT_MS).toBe(60 * 60 * 1000);
  });

  it('rate limits new proposals when a recent non-active proposal exists', () => {
    const root = makeRepoRoot();
    const first = createRollbackTask('EXP-RATE-001', { root, now: new Date('2026-05-24T00:00:00.000Z') });
    const yamlPath = backlogPath(root, first.taskId!);
    const task = parseYaml(readFileSync(yamlPath, 'utf-8')) as Record<string, unknown>;
    task.status = 'rejected';
    writeFileSync(yamlPath, stringifyYaml(task), 'utf-8');

    const second = createRollbackTask('EXP-RATE-001', { root, now: new Date('2026-05-24T00:30:00.000Z') });

    expect(second).toEqual({ taskId: first.taskId, created: false, updatedExisting: false, reason: 'rate_limited' });
  });

  it('expires stale rollback proposals using a schema-valid rejected status', () => {
    const root = makeRepoRoot();
    const result = createRollbackTask('EXP-STALE-001', { root, now: new Date('2026-05-01T00:00:00.000Z') });

    const expired = expireStaleRollbackTasks({ root, now: new Date('2026-05-24T00:00:00.000Z') });

    expect(expired.expiredTaskIds).toEqual([result.taskId]);
    const task = parseYaml(readFileSync(backlogPath(root, result.taskId!), 'utf-8')) as Record<string, unknown>;
    expect(task.status).toBe('rejected');
  });
});

describe('executeRollback', () => {
  it('is callable without throwing', () => {
    // executeRollback prints advice; doesn't actually run git revert
    expect(() => executeRollback('EXP-TEST')).not.toThrow();
  });
});
