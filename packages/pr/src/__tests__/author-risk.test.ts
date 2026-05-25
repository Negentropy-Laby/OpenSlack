import { describe, it, expect } from 'vitest';
import { assessPRAuthorRisk } from '../author-risk.js';

describe('assessPRAuthorRisk', () => {
  it('blocks Red Zone PR creation when current author is the sole CODEOWNER', () => {
    const result = assessPRAuthorRisk({
      author: 'wsman',
      changedPaths: ['.github/workflows/ci.yml'],
      codeowners: ['@wsman'],
    });

    expect(result.status).toBe('red_zone_sole_codeowner_deadlock');
    expect(result.recommendation).toContain('bot/agent-authored PR');
    expect(result.recommendation).toContain('human CODEOWNER approval');
  });

  it('allows bot-authored Red Zone PRs that still require human CODEOWNER approval', () => {
    const result = assessPRAuthorRisk({
      author: 'openslack-github-app',
      authorIsBot: true,
      changedPaths: ['.github/workflows/ci.yml'],
      codeowners: ['@wsman'],
    });

    expect(result.status).toBe('safe');
    expect(result.reason).toContain('bot/agent-authored');
    expect(result.recommendation).toContain('@wsman');
  });

  it('requires a human CODEOWNER when Red Zone paths have no owner', () => {
    const result = assessPRAuthorRisk({
      author: 'bot',
      authorIsBot: true,
      changedPaths: ['.github/workflows/ci.yml'],
      codeowners: [],
    });

    expect(result.status).toBe('needs_human_codeowner');
  });

  it('does not block non-Red Zone changes', () => {
    const result = assessPRAuthorRisk({
      author: 'wsman',
      changedPaths: ['docs/readme.md'],
      codeowners: ['@wsman'],
    });

    expect(result.status).toBe('safe');
  });
});
