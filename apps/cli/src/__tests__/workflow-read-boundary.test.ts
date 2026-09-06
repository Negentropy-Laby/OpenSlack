import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('drains a controlled async read failure with the primary code and inspect guidance', () => {
  const root = mkdtempSync(join(tmpdir(), 'workflow-cli-read-'));
  try {
    for (const suffix of [[], ['go-recovery-projections']])
      mkdirSync(join(root, '.openslack.local', 'workflows', ...suffix, 'runs', 'run.conflict'), {
        recursive: true,
      });
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
        'collaboration',
        'workflow',
        'runs',
        'show',
        'run.conflict',
      ],
      { cwd: root, encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('WORKFLOW_RUN_EVIDENCE_RECONCILIATION_REQUIRED');
    expect(result.stderr).toContain('Use runs inspect');
    expect(result.stderr).not.toMatch(
      /UnhandledPromiseRejection|triggerUncaughtException|node:internal/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
