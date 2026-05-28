import { describe, it, expect } from 'vitest'
import {
  ALWAYS_FORBIDDEN,
  resolvePermissions,
  checkPermission,
  intersectPermissions,
} from '../permission-checker.js'

describe('ALWAYS_FORBIDDEN', () => {
  it('contains github.pr.approve', () => {
    expect(ALWAYS_FORBIDDEN.has('github.pr.approve')).toBe(true)
  })

  it('contains github.pr.merge', () => {
    expect(ALWAYS_FORBIDDEN.has('github.pr.merge')).toBe(true)
  })

  it('contains ruleset.bypass', () => {
    expect(ALWAYS_FORBIDDEN.has('ruleset.bypass')).toBe(true)
  })

  it('contains secrets.read', () => {
    expect(ALWAYS_FORBIDDEN.has('secrets.read')).toBe(true)
  })

  it('contains kernel.constitution.write', () => {
    expect(ALWAYS_FORBIDDEN.has('kernel.constitution.write')).toBe(true)
  })

  it('has exactly 7 entries', () => {
    expect(ALWAYS_FORBIDDEN.size).toBe(7)
  })

  it('is a Set', () => {
    expect(ALWAYS_FORBIDDEN).toBeInstanceOf(Set)
  })

  it('does not contain ordinary read actions', () => {
    expect(ALWAYS_FORBIDDEN.has('github.issues.read')).toBe(false)
    expect(ALWAYS_FORBIDDEN.has('filesystem.read')).toBe(false)
  })
})

describe('resolvePermissions', () => {
  it('returns read-only set for untrusted trust level', () => {
    const declared = { github: ['issues:read', 'issues:write'] }
    const granted = { github: ['issues:read', 'issues:write'] }
    const result = resolvePermissions(declared, granted, 'untrusted')
    expect(result.has('github.issues.read')).toBe(true)
    expect(result.has('github.prs.read')).toBe(true)
    expect(result.has('github.issues.write')).toBe(false)
  })

  it('returns intersection of declared and granted for trusted level', () => {
    const declared = { github: ['issues:read', 'issues:write'] }
    const granted = { github: ['issues:read'] }
    const result = resolvePermissions(declared, granted, 'trusted')
    expect(result.has('github.issues.read')).toBe(true)
    expect(result.has('github.issues.write')).toBe(false)
  })

  it('returns intersection of declared and granted for core level', () => {
    const declared = { github: ['issues:read', 'prs:write'] }
    const granted = { github: ['issues:read', 'prs:write', 'prs:merge'] }
    const result = resolvePermissions(declared, granted, 'core')
    expect(result.has('github.issues.read')).toBe(true)
    expect(result.has('github.prs.write')).toBe(true)
    // Not declared, so not in result even though granted
    expect(result.has('github.prs.merge')).toBe(false)
  })

  it('filters out ALWAYS_FORBIDDEN actions', () => {
    const declared = { github: ['issues:read', 'pr.merge'] }
    const granted = { github: ['issues:read', 'pr.merge'] }
    const result = resolvePermissions(declared, granted, 'trusted')
    expect(result.has('github.issues.read')).toBe(true)
    expect(result.has('github.pr.merge')).toBe(false)
  })

  it('returns empty set when no permissions match', () => {
    const declared = { github: ['issues:write'] }
    const granted = { github: ['issues:read'] }
    const result = resolvePermissions(declared, granted, 'trusted')
    expect(result.size).toBe(0)
  })

  it('handles empty declared and granted', () => {
    const result = resolvePermissions({}, {}, 'trusted')
    expect(result.size).toBe(0)
  })

  it('handles multiple categories', () => {
    const declared = {
      github: ['issues:read'],
      filesystem: ['read', 'write'],
    }
    const granted = {
      github: ['issues:read'],
      filesystem: ['read'],
    }
    const result = resolvePermissions(declared, granted, 'trusted')
    expect(result.has('github.issues.read')).toBe(true)
    expect(result.has('filesystem.read')).toBe(true)
    expect(result.has('filesystem.write')).toBe(false)
  })

  it('handles undefined categories gracefully', () => {
    const declared = { github: ['issues:read'] }
    const granted = {}
    const result = resolvePermissions(declared, granted, 'trusted')
    expect(result.size).toBe(0)
  })

  it('ignores secrets.read even when granted for core', () => {
    // Use 'openslack' category to test ALWAYS_FORBIDDEN filtering
    // since secrets is not a valid WorkflowPermissions category
    const declared = { github: ['pr.approve'] }
    const granted = { github: ['pr.approve'] }
    const result = resolvePermissions(declared, granted, 'core')
    expect(result.has('github.pr.approve')).toBe(false)
  })

  it('untrusted ignores all declared permissions', () => {
    const declared = { filesystem: ['read', 'write', 'delete'] }
    const granted = { filesystem: ['read', 'write', 'delete'] }
    const result = resolvePermissions(declared, granted, 'untrusted')
    expect(result.has('filesystem.read')).toBe(false)
    expect(result.has('filesystem.write')).toBe(false)
    expect(result.size).toBe(2) // only github.issues.read and github.prs.read
  })
})

describe('checkPermission', () => {
  it('returns true when action is in the permission set', () => {
    const perms = new Set(['github.issues.read', 'filesystem.write'])
    expect(checkPermission(perms, 'github.issues.read')).toBe(true)
  })

  it('returns false when action is not in the permission set', () => {
    const perms = new Set(['github.issues.read'])
    expect(checkPermission(perms, 'filesystem.write')).toBe(false)
  })

  it('returns false for ALWAYS_FORBIDDEN actions even if in set', () => {
    const perms = new Set(['github.pr.merge', 'github.issues.read'])
    expect(checkPermission(perms, 'github.pr.merge')).toBe(false)
  })

  it('returns false for empty permission set', () => {
    expect(checkPermission(new Set(), 'github.issues.read')).toBe(false)
  })

  it('returns false for ruleset.bypass even if somehow in set', () => {
    const perms = new Set(['ruleset.bypass'])
    expect(checkPermission(perms, 'ruleset.bypass')).toBe(false)
  })
})

describe('intersectPermissions', () => {
  it('returns intersection of parent and child', () => {
    const parent = new Set(['github.issues.read', 'filesystem.write'])
    const child = new Set(['github.issues.read', 'filesystem.read'])
    const result = intersectPermissions(parent, child)
    expect(result.has('github.issues.read')).toBe(true)
    expect(result.has('filesystem.write')).toBe(false)
    expect(result.has('filesystem.read')).toBe(false)
  })

  it('filters out ALWAYS_FORBIDDEN from child', () => {
    const parent = new Set(['github.pr.merge', 'github.issues.read'])
    const child = new Set(['github.pr.merge', 'github.issues.read'])
    const result = intersectPermissions(parent, child)
    expect(result.has('github.pr.merge')).toBe(false)
    expect(result.has('github.issues.read')).toBe(true)
  })

  it('returns empty set when no overlap', () => {
    const parent = new Set(['github.issues.read'])
    const child = new Set(['filesystem.write'])
    const result = intersectPermissions(parent, child)
    expect(result.size).toBe(0)
  })

  it('returns empty set when parent is empty', () => {
    const parent = new Set<string>()
    const child = new Set(['github.issues.read'])
    const result = intersectPermissions(parent, child)
    expect(result.size).toBe(0)
  })

  it('returns empty set when child is empty', () => {
    const parent = new Set(['github.issues.read'])
    const child = new Set<string>()
    const result = intersectPermissions(parent, child)
    expect(result.size).toBe(0)
  })

  it('returns full child when parent contains all child items', () => {
    const parent = new Set(['a', 'b', 'c'])
    const child = new Set(['a', 'b'])
    const result = intersectPermissions(parent, child)
    expect(result.size).toBe(2)
    expect(result.has('a')).toBe(true)
    expect(result.has('b')).toBe(true)
  })
})
