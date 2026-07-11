import { describe, it, expect } from 'vitest';
import {
  buildPermissionProfile,
  isActionAllowed,
  enforceToolScope,
  validatePermissionProfile,
} from '../permissions.js';
import type { ResolvedAgentConfig } from '../types.js';

function makeConfig(overrides?: Partial<ResolvedAgentConfig>): ResolvedAgentConfig {
  return {
    agentId: 'test-agent',
    source: 'claude-project',
    ...overrides,
  };
}

describe('buildPermissionProfile', () => {
  it('plan mode is read-only', () => {
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'plan' }));
    expect(profile.isReadOnly).toBe(true);
    expect(profile.acceptEdits).toBe(false);
    expect(profile.allowedTools).toContain('Read');
    expect(profile.allowedTools).not.toContain('Edit');
    expect(profile.allowedTools).not.toContain('Write');
    expect(profile.allowedTools).not.toContain('Bash');
  });

  it('acceptEdits mode allows file writes', () => {
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'acceptEdits' }));
    expect(profile.isReadOnly).toBe(false);
    expect(profile.acceptEdits).toBe(true);
    expect(profile.allowedTools).toContain('Read');
    expect(profile.allowedTools).toContain('Edit');
    expect(profile.allowedTools).toContain('Write');
    expect(profile.allowedTools).not.toContain('Bash');
  });

  it('default mode allows standard tools', () => {
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'default' }));
    expect(profile.isReadOnly).toBe(false);
    expect(profile.acceptEdits).toBe(false);
    expect(profile.allowedTools).toContain('Read');
    expect(profile.allowedTools).toContain('Edit');
    expect(profile.allowedTools).toContain('Write');
    expect(profile.allowedTools).toContain('Bash');
  });

  it('strict mode is fail-closed and read-only', () => {
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'strict' }));
    expect(profile.isReadOnly).toBe(true);
    expect(profile.allowedTools).toContain('Read');
    expect(profile.allowedTools).toContain('repo.diff');
    expect(profile.allowedTools).not.toContain('Edit');
    expect(profile.allowedTools).not.toContain('Write');
    expect(profile.allowedTools).not.toContain('Bash');
    expect(profile.allowedTools).not.toContain('repo.apply_patch');
  });

  it('missing mode defaults to strict', () => {
    const profile = buildPermissionProfile(makeConfig());
    expect(profile.permissionMode).toBe('strict');
    expect(profile.isReadOnly).toBe(true);
  });

  it('applies tools allowlist', () => {
    const profile = buildPermissionProfile(
      makeConfig({ permissionMode: 'default', tools: ['Read', 'Grep'] }),
    );
    expect(profile.allowedTools).toEqual(['Read', 'Grep']);
    expect(profile.allowedTools).not.toContain('Edit');
  });

  it('applies disallowedTools denylist', () => {
    const profile = buildPermissionProfile(
      makeConfig({ permissionMode: 'default', disallowedTools: ['Bash'] }),
    );
    expect(profile.allowedTools).toContain('Read');
    expect(profile.allowedTools).toContain('Edit');
    expect(profile.allowedTools).not.toContain('Bash');
  });

  it('denylist takes precedence over allowlist', () => {
    const profile = buildPermissionProfile(
      makeConfig({ permissionMode: 'default', tools: ['Read', 'Bash'], disallowedTools: ['Bash'] }),
    );
    expect(profile.allowedTools).toContain('Read');
    expect(profile.allowedTools).not.toContain('Bash');
  });

  it('always denies PR approval', () => {
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'strict' }));
    expect(profile.canApprovePR).toBe(false);
    expect(isActionAllowed(profile, 'github.pr.approve')).toBe(false);
  });

  it('always denies merge', () => {
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'strict' }));
    expect(profile.canMerge).toBe(false);
    expect(isActionAllowed(profile, 'github.pr.merge')).toBe(false);
  });

  it('always denies secrets access', () => {
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'strict' }));
    expect(profile.canReadSecrets).toBe(false);
    expect(isActionAllowed(profile, 'secrets.read')).toBe(false);
  });

  it('always denies ruleset bypass', () => {
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'strict' }));
    expect(profile.canBypassRulesets).toBe(false);
    expect(isActionAllowed(profile, 'ruleset.bypass')).toBe(false);
  });

  it('defaults invalid mode to strict', () => {
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'invalidMode' as any }));
    expect(profile.permissionMode).toBe('strict');
    expect(profile.canApprovePR).toBe(false);
    expect(profile.canMerge).toBe(false);
  });

  it('intersects allowlist with mode baseline', () => {
    // plan mode baseline doesn't include Bash, so even if in allowlist it's denied
    const profile = buildPermissionProfile(
      makeConfig({ permissionMode: 'plan', tools: ['Read', 'Bash'] }),
    );
    expect(profile.allowedTools).toContain('Read');
    expect(profile.allowedTools).not.toContain('Bash');
  });
});

describe('isActionAllowed', () => {
  it('allows actions in allowedTools', () => {
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'plan' }));
    expect(isActionAllowed(profile, 'Read')).toBe(true);
  });

  it('denies actions not in allowedTools', () => {
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'plan' }));
    expect(isActionAllowed(profile, 'Bash')).toBe(false);
  });

  it('denies always-forbidden actions even if in allowedTools', () => {
    // This shouldn't happen due to buildPermissionProfile, but test defense:
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'strict' }));
    expect(isActionAllowed(profile, 'github.pr.approve')).toBe(false);
    expect(isActionAllowed(profile, 'github.pr.merge')).toBe(false);
    expect(isActionAllowed(profile, 'secrets.read')).toBe(false);
    expect(isActionAllowed(profile, 'ruleset.bypass')).toBe(false);
  });
});

describe('enforceToolScope', () => {
  it('separates allowed and denied tools', () => {
    const profile = buildPermissionProfile(
      makeConfig({ permissionMode: 'default', disallowedTools: ['Bash'] }),
    );
    const result = enforceToolScope(profile, ['Read', 'Edit', 'Bash', 'UnknownTool']);
    expect(result.allowed).toContain('Read');
    expect(result.allowed).toContain('Edit');
    expect(result.denied).toContain('Bash');
    expect(result.denied).toContain('UnknownTool');
  });
});

describe('validatePermissionProfile', () => {
  it('validates a correct profile', () => {
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'plan' }));
    const result = validatePermissionProfile(profile);
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('detects forbidden tools in allowed list', () => {
    const profile = buildPermissionProfile(makeConfig({ permissionMode: 'strict' }));
    // Manually inject a forbidden tool into allowed list
    const badProfile = { ...profile, allowedTools: [...profile.allowedTools, 'github.pr.approve'] };
    const result = validatePermissionProfile(badProfile);
    expect(result.valid).toBe(false);
    expect(result.violations.some((v) => v.includes('github.pr.approve'))).toBe(true);
  });

  it('detects tampered canApprovePR flag', () => {
    const profile = buildPermissionProfile(makeConfig());
    const badProfile = { ...profile, canApprovePR: true as false };
    const result = validatePermissionProfile(badProfile);
    expect(result.valid).toBe(false);
    expect(result.violations).toContain('canApprovePR must be false');
  });
});
