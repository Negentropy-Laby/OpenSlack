import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertLocalStateCompatibility,
  diagnoseLocalStateCompatibility,
  migrateLocalStateSchemas,
} from '../state-compatibility.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local state compatibility', () => {
  it('rejects corrupt and future state before continuation', () => {
    const root = localRoot();
    writeFileSync(join(root, 'onboarding.json'), '{bad', 'utf-8');
    writeFileSync(
      join(root, 'github-app.json'),
      JSON.stringify({ schema: 'openslack.github_app_local.v99' }),
      'utf-8',
    );
    const report = diagnoseLocalStateCompatibility(root);
    expect(report.compatible).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: 'onboarding.json', status: 'incompatible' }),
        expect.objectContaining({ file: 'github-app.json', status: 'incompatible' }),
      ]),
    );
    expect(() => assertLocalStateCompatibility(root)).toThrow('Unsafe continuation was refused');
  });

  it('backs up legacy runtime config before applying its schema migration', () => {
    const root = localRoot();
    const path = join(root, 'agent-runtime.json');
    const original = JSON.stringify({ providers: { 'openai-compatible': { model: 'test' } } });
    writeFileSync(path, original, 'utf-8');
    expect(migrateLocalStateSchemas(root)).toEqual([
      expect.objectContaining({ file: 'agent-runtime.json', applied: false }),
    ]);

    const [action] = migrateLocalStateSchemas(root, {
      apply: true,
      now: () => new Date('2026-07-11T00:00:00.000Z'),
    });
    expect(action.applied).toBe(true);
    expect(action.backupPath).toBeDefined();
    expect(readFileSync(action.backupPath!, 'utf-8')).toBe(original);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
      schema: 'openslack.agent_runtime.v1',
      providers: { 'openai-compatible': { model: 'test' } },
    });
  });
});

function localRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openslack-state-compat-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}
