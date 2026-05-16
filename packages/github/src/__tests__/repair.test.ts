import { describe, it, expect } from 'vitest';

// repairLabels and repairExpiredClaims require Octokit (live GitHub API).
// These tests validate the export structure and type contracts only.
// Full integration is tested via `openslack github repair-all` smoke tests.

describe('repair module', () => {
  it('exports repairLabels function', async () => {
    const { repairLabels } = await import('../repair.js');
    expect(typeof repairLabels).toBe('function');
  });

  it('exports repairExpiredClaims function', async () => {
    const { repairExpiredClaims } = await import('../repair.js');
    expect(typeof repairExpiredClaims).toBe('function');
  });
});
