import { describe, it, expect } from 'vitest'
import {
  ALWAYS_FORBIDDEN,
  resolvePermissions,
  checkPermission,
  intersectPermissions,
  resolveTrustLevel,
  getPermissionsForTrustLevel,
  fullCheckPermission,
} from '../permission-checker.js'
import type { TrustLevel, WorkflowPermissions, ExecutionMode } from '../types.js'

// ── Extended ALWAYS_FORBIDDEN tests ─────────────────────────────────────────

describe('ALWAYS_FORBIDDEN (extended)', () => {
  it('contains all 7 permanently forbidden actions', () => {
    expect(ALWAYS_FORBIDDEN.size).toBe(7)
  })

  it('contains agent.registry.write', () => {
    expect(ALWAYS_FORBIDDEN.has('agent.registry.write')).toBe(true)
  })

  it('contains workflow.trust.upgrade', () => {
    expect(ALWAYS_FORBIDDEN.has('workflow.trust.upgrade')).toBe(true)
  })

  it('contains all original entries plus new ones', () => {
    const expected = [
      'github.pr.approve',
      'github.pr.merge',
      'ruleset.bypass',
      'secrets.read',
      'kernel.constitution.write',
      'agent.registry.write',
      'workflow.trust.upgrade',
    ]
    for (const action of expected) {
      expect(ALWAYS_FORBIDDEN.has(action)).toBe(true)
    }
  })
})

// ── resolveTrustLevel ────────────────────────────────────────────────────────

describe('resolveTrustLevel', () => {
  it('returns core for builtin workflows', () => {
    expect(resolveTrustLevel({ isBuiltin: true })).toBe('core')
  })

  it('returns core for builtin even when assignedLevel is untrusted', () => {
    expect(resolveTrustLevel({ isBuiltin: true, assignedLevel: 'untrusted' })).toBe('core')
  })

  it('returns assigned level for non-builtin workflows', () => {
    expect(resolveTrustLevel({ isBuiltin: false, assignedLevel: 'trusted' })).toBe('trusted')
  })

  it('returns untrusted when no assignment and not builtin', () => {
    expect(resolveTrustLevel({ isBuiltin: false })).toBe('untrusted')
  })

  it('returns assigned untrusted level', () => {
    expect(resolveTrustLevel({ isBuiltin: false, assignedLevel: 'untrusted' })).toBe('untrusted')
  })

  it('returns assigned core level for non-builtin', () => {
    expect(resolveTrustLevel({ isBuiltin: false, assignedLevel: 'core' })).toBe('core')
  })
})

// ── getPermissionsForTrustLevel ─────────────────────────────────────────────

describe('getPermissionsForTrustLevel', () => {
  it('returns read-only set for untrusted', () => {
    const perms = getPermissionsForTrustLevel('untrusted')
    expect(perms.has('github.issues.read')).toBe(true)
    expect(perms.has('github.prs.read')).toBe(true)
    // No write permissions
    expect(perms.has('github.issues.write')).toBe(false)
    expect(perms.has('filesystem.workspace.write')).toBe(false)
  })

  it('returns expanded set for trusted', () => {
    const perms = getPermissionsForTrustLevel('trusted')
    expect(perms.has('github.issues.read')).toBe(true)
    expect(perms.has('github.issues.create')).toBe(true)
    expect(perms.has('filesystem.workspace.write')).toBe(true)
  })

  it('returns full set for core', () => {
    const perms = getPermissionsForTrustLevel('core')
    expect(perms.has('github.issues.read')).toBe(true)
    expect(perms.has('openslack.task.checkout')).toBe(true)
    expect(perms.has('openslack.prms.requestMerge')).toBe(true)
  })

  it('untrusted set is a subset of trusted set', () => {
    const untrusted = getPermissionsForTrustLevel('untrusted')
    const trusted = getPermissionsForTrustLevel('trusted')
    for (const perm of untrusted) {
      expect(trusted.has(perm)).toBe(true)
    }
  })

  it('trusted set is a subset of core set', () => {
    const trusted = getPermissionsForTrustLevel('trusted')
    const core = getPermissionsForTrustLevel('core')
    for (const perm of trusted) {
      expect(core.has(perm)).toBe(true)
    }
  })

  it('never includes ALWAYS_FORBIDDEN actions', () => {
    for (const level of ['untrusted', 'trusted', 'core'] as TrustLevel[]) {
      const perms = getPermissionsForTrustLevel(level)
      for (const forbidden of ALWAYS_FORBIDDEN) {
        expect(perms.has(forbidden)).toBe(false)
      }
    }
  })

  it('returns a new Set each call (not shared reference)', () => {
    const a = getPermissionsForTrustLevel('trusted')
    const b = getPermissionsForTrustLevel('trusted')
    expect(a).not.toBe(b)
  })
})

// ── fullCheckPermission ─────────────────────────────────────────────────────

describe('fullCheckPermission', () => {
  const baseDeclared: WorkflowPermissions = {
    github: ['issues:read', 'issues:create'],
    filesystem: ['read', 'workspace:write'],
  }
  const baseGranted: WorkflowPermissions = {
    github: ['issues:read', 'issues:create'],
    filesystem: ['read', 'workspace:write'],
  }

  function check(
    action: string,
    trustLevel: TrustLevel,
    mode: ExecutionMode,
    declared: WorkflowPermissions = baseDeclared,
    granted: WorkflowPermissions = baseGranted,
  ) {
    return fullCheckPermission({ action, trustLevel, mode, declared, granted })
  }

  // Step 1: Hardcoded blocklist
  it('blocks permanently forbidden actions even for core in execute mode', () => {
    const result = check('github.pr.merge', 'core', 'execute')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('Permanently forbidden')
  })

  it('blocks secrets.read for core in execute mode', () => {
    const result = check('secrets.read', 'core', 'execute')
    expect(result.allowed).toBe(false)
  })

  it('blocks workflow.trust.upgrade', () => {
    const result = check('workflow.trust.upgrade', 'core', 'execute')
    expect(result.allowed).toBe(false)
  })

  // Step 2: Execution mode restrictions
  it('blocks all actions in validate mode', () => {
    const result = check('github.issues.read', 'trusted', 'validate')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('validate')
  })

  it('blocks write actions in preview mode for trusted', () => {
    const result = check('github.issues.create', 'trusted', 'preview')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('preview')
  })

  it('simulates (blocks) actions in dry-run mode', () => {
    const result = check('github.issues.create', 'trusted', 'dry-run')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('dry-run')
  })

  // Step 3: Trust level restrictions
  it('blocks write actions for untrusted in execute mode', () => {
    const result = check('github.issues.create', 'untrusted', 'execute')
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('trusted level')
  })

  // Step 4: Declared permissions
  it('allows declared write actions for trusted in execute mode', () => {
    const result = check('github.issues.create', 'trusted', 'execute')
    expect(result.allowed).toBe(true)
  })

  it('blocks undeclared actions for trusted in execute mode', () => {
    const result = check('github.prs.create', 'trusted', 'execute', baseDeclared, baseGranted)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('not in effective')
  })

  // Step 5: Allowed
  it('allows read actions for untrusted in execute mode when in declared set', () => {
    // Untrusted always gets the read-only set, regardless of declared
    const result = check('github.issues.read', 'untrusted', 'execute')
    // Note: untrusted ignores declared, so the action needs to be in UNTRUSTED_READONLY
    expect(result.allowed).toBe(true)
  })

  it('allows filesystem.write for trusted when declared and granted', () => {
    const result = check('filesystem.workspace.write', 'trusted', 'execute')
    expect(result.allowed).toBe(true)
  })

  it('blocks action not in granted even if declared', () => {
    const declared: WorkflowPermissions = { github: ['issues:read', 'issues:create'] }
    const granted: WorkflowPermissions = { github: ['issues:read'] }
    const result = fullCheckPermission({
      action: 'github.issues.create',
      trustLevel: 'trusted',
      mode: 'execute',
      declared,
      granted,
    })
    expect(result.allowed).toBe(false)
  })

  it('returns reason for denied actions', () => {
    const result = check('github.pr.approve', 'trusted', 'execute')
    expect(result.allowed).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  it('returns no reason for allowed actions', () => {
    const result = check('github.issues.create', 'trusted', 'execute')
    expect(result.allowed).toBe(true)
    expect(result.reason).toBeUndefined()
  })
})

// ── existing function compatibility ──────────────────────────────────────────

describe('existing resolvePermissions (backward compat)', () => {
  it('still works with untrusted returning read-only set', () => {
    const result = resolvePermissions(
      { github: ['issues:read', 'issues:write'] },
      { github: ['issues:read', 'issues:write'] },
      'untrusted',
    )
    expect(result.has('github.issues.read')).toBe(true)
    expect(result.has('github.prs.read')).toBe(true)
    expect(result.has('github.issues.write')).toBe(false)
  })

  it('still works with trusted intersection', () => {
    const result = resolvePermissions(
      { github: ['issues:read'] },
      { github: ['issues:read', 'issues:write'] },
      'trusted',
    )
    expect(result.has('github.issues.read')).toBe(true)
    expect(result.size).toBe(1)
  })
})
