import { describe, expect, it } from 'vitest';
import { buildPermissionProfile, isActionAllowed, normalizeToolName } from '../index.js';

describe('tool name normalization', () => {
  it('normalizes common Aby/OpenSlack tool names', () => {
    expect(normalizeToolName('bash')).toBe('Bash');
    expect(normalizeToolName('Read')).toBe('Read');
    expect(normalizeToolName('mcp__github__search')).toBe('mcp.github.search');
    expect(normalizeToolName('MCP__GitHub__PR')).toBe('mcp.github.pr');
    expect(normalizeToolName('mcp.GitHub.PR')).toBe('mcp.github.pr');
    expect(normalizeToolName('github__pr__merge')).toBe('github.pr.merge');
  });

  it('allows canonical tool aliases through permission checks', () => {
    const profile = buildPermissionProfile({
      agentId: 'reviewer',
      source: 'test',
      permissionMode: 'plan',
    });

    expect(isActionAllowed(profile, 'read')).toBe(true);
    expect(isActionAllowed(profile, 'Bash')).toBe(false);
  });

  it('blocks forbidden actions even when reported with bridge-style separators', () => {
    const profile = buildPermissionProfile({
      agentId: 'worker',
      source: 'test',
      permissionMode: 'default',
    });

    expect(isActionAllowed(profile, 'github__pr__merge')).toBe(false);
    expect(isActionAllowed(profile, 'secrets__read')).toBe(false);
    expect(isActionAllowed(profile, 'mcp__GitHub__pr_approve')).toBe(false);
    expect(isActionAllowed(profile, 'mcp__GitHub__pr__merge')).toBe(false);
  });
});
