import { describe, it, expect } from 'vitest'
import {
  parseManifest,
  validateManifest,
  computeManifestHash,
} from '../manifest.js'
import type { WorkflowMeta } from '../types.js'

describe('parseManifest', () => {
  it('parses a minimal valid manifest', () => {
    const raw = {
      name: 'my-workflow',
      description: 'A test workflow',
      phases: [{ title: 'Scan', detail: 'Scan the codebase' }],
    }
    const meta = parseManifest(raw)
    expect(meta.name).toBe('my-workflow')
    expect(meta.description).toBe('A test workflow')
    expect(meta.phases).toHaveLength(1)
    expect(meta.phases[0].title).toBe('Scan')
  })

  it('parses a full manifest with all optional fields', () => {
    const raw = {
      name: 'full-workflow',
      version: '1.2.3',
      description: 'Full workflow',
      whenToUse: 'When you need everything',
      phases: [
        { title: 'Scan', detail: 'Scan' },
        { title: 'Verify', detail: 'Verify' },
      ],
      inputs: {
        target: { type: 'string', description: 'Target path' },
        count: { type: 'number', default: 5, description: 'Count' },
      },
      permissions: {
        github: ['issues:read', 'prs:write'],
        filesystem: ['read'],
      },
      sideEffects: ['github.issues.create'],
      forbidden: ['github.pr.approve'],
      risk: 'high',
    }
    const meta = parseManifest(raw)
    expect(meta.version).toBe('1.2.3')
    expect(meta.whenToUse).toBe('When you need everything')
    expect(meta.phases).toHaveLength(2)
    expect(meta.inputs).toBeDefined()
    expect(meta.permissions).toBeDefined()
    expect(meta.sideEffects).toEqual(['github.issues.create'])
    expect(meta.forbidden).toEqual(['github.pr.approve'])
    expect(meta.risk).toBe('high')
  })

  it('throws on null input', () => {
    expect(() => parseManifest(null)).toThrow('non-null object')
  })

  it('throws on undefined input', () => {
    expect(() => parseManifest(undefined)).toThrow('non-null object')
  })

  it('throws on non-object input', () => {
    expect(() => parseManifest('string')).toThrow('non-null object')
    expect(() => parseManifest(42)).toThrow('non-null object')
  })

  it('throws on missing name', () => {
    const raw = { description: 'test', phases: [{ title: 'A', detail: 'B' }] }
    expect(() => parseManifest(raw)).toThrow('"name"')
  })

  it('throws on empty name', () => {
    const raw = { name: '', description: 'test', phases: [{ title: 'A', detail: 'B' }] }
    expect(() => parseManifest(raw)).toThrow('"name"')
  })

  it('throws on missing description', () => {
    const raw = { name: 'test', phases: [{ title: 'A', detail: 'B' }] }
    expect(() => parseManifest(raw)).toThrow('"description"')
  })

  it('throws on missing phases', () => {
    const raw = { name: 'test', description: 'desc' }
    expect(() => parseManifest(raw)).toThrow('"phases"')
  })

  it('throws on empty phases array', () => {
    const raw = { name: 'test', description: 'desc', phases: [] }
    expect(() => parseManifest(raw)).toThrow('"phases"')
  })

  it('throws on phase missing title', () => {
    const raw = { name: 'test', description: 'desc', phases: [{ detail: 'B' }] }
    expect(() => parseManifest(raw)).toThrow('non-empty "title"')
  })

  it('throws on phase missing detail', () => {
    const raw = { name: 'test', description: 'desc', phases: [{ title: 'A' }] }
    expect(() => parseManifest(raw)).toThrow('"detail"')
  })

  it('throws on non-object phase entry', () => {
    const raw = { name: 'test', description: 'desc', phases: [42] }
    expect(() => parseManifest(raw)).toThrow('must be an object')
  })

  it('throws on invalid risk value', () => {
    const raw = {
      name: 'test',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
      risk: 'extreme',
    }
    expect(() => parseManifest(raw)).toThrow('"risk"')
  })

  it('throws on non-string version', () => {
    const raw = {
      name: 'test',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
      version: 123,
    }
    expect(() => parseManifest(raw)).toThrow('"version"')
  })

  it('throws on non-array sideEffects', () => {
    const raw = {
      name: 'test',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
      sideEffects: 'not-array',
    }
    expect(() => parseManifest(raw)).toThrow('"sideEffects"')
  })

  it('throws on non-array forbidden', () => {
    const raw = {
      name: 'test',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
      forbidden: 42,
    }
    expect(() => parseManifest(raw)).toThrow('"forbidden"')
  })

  it('does not include optional fields when not provided', () => {
    const raw = {
      name: 'minimal',
      description: 'Minimal workflow',
      phases: [{ title: 'Run', detail: 'Do the thing' }],
    }
    const meta = parseManifest(raw)
    expect(meta.version).toBeUndefined()
    expect(meta.whenToUse).toBeUndefined()
    expect(meta.risk).toBeUndefined()
    expect(meta.inputs).toBeUndefined()
    expect(meta.permissions).toBeUndefined()
    expect(meta.sideEffects).toBeUndefined()
    expect(meta.forbidden).toBeUndefined()
  })
})

describe('validateManifest', () => {
  it('returns empty array for valid manifest', () => {
    const meta: WorkflowMeta = {
      name: 'valid-workflow',
      description: 'A valid workflow',
      phases: [{ title: 'Scan', detail: 'Scan code' }],
    }
    expect(validateManifest(meta)).toEqual([])
  })

  it('returns error for name with uppercase', () => {
    const meta: WorkflowMeta = {
      name: 'BadName',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
    }
    const errors = validateManifest(meta)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toContain('name')
  })

  it('returns error for name starting with number', () => {
    const meta: WorkflowMeta = {
      name: '1workflow',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
    }
    const errors = validateManifest(meta)
    expect(errors.some(e => e.includes('name'))).toBe(true)
  })

  it('returns error for name with spaces', () => {
    const meta: WorkflowMeta = {
      name: 'my workflow',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
    }
    const errors = validateManifest(meta)
    expect(errors.some(e => e.includes('name'))).toBe(true)
  })

  it('accepts valid semver version', () => {
    const meta: WorkflowMeta = {
      name: 'test',
      version: '1.0.0',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
    }
    expect(validateManifest(meta)).toEqual([])
  })

  it('accepts prerelease semver version', () => {
    const meta: WorkflowMeta = {
      name: 'test',
      version: '1.0.0-beta.1',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
    }
    expect(validateManifest(meta)).toEqual([])
  })

  it('returns error for invalid version string', () => {
    const meta: WorkflowMeta = {
      name: 'test',
      version: 'not-semver',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
    }
    const errors = validateManifest(meta)
    expect(errors.some(e => e.includes('version'))).toBe(true)
  })

  it('returns error for invalid side effect format', () => {
    const meta: WorkflowMeta = {
      name: 'test',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
      sideEffects: ['invalid-format'],
    }
    const errors = validateManifest(meta)
    expect(errors.some(e => e.includes('Side effect'))).toBe(true)
  })

  it('accepts valid side effect with wildcards', () => {
    const meta: WorkflowMeta = {
      name: 'test',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
      sideEffects: ['github.*.create'],
    }
    expect(validateManifest(meta)).toEqual([])
  })

  it('returns error for empty forbidden entry', () => {
    const meta: WorkflowMeta = {
      name: 'test',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
      forbidden: [''],
    }
    const errors = validateManifest(meta)
    expect(errors.some(e => e.includes('Forbidden'))).toBe(true)
  })

  it('returns error for permissions with non-array value', () => {
    const meta: WorkflowMeta = {
      name: 'test',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
      permissions: { github: 'not-array' } as unknown as { github?: string[] },
    }
    const errors = validateManifest(meta)
    expect(errors.some(e => e.includes('github'))).toBe(true)
  })

  it('returns error for permission action that is not a string', () => {
    const meta: WorkflowMeta = {
      name: 'test',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
      permissions: { github: [42] } as unknown as { github?: string[] },
    }
    const errors = validateManifest(meta)
    expect(errors.some(e => e.includes('github'))).toBe(true)
  })

  it('returns error for input with invalid type', () => {
    const meta: WorkflowMeta = {
      name: 'test',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
      inputs: {
        foo: { type: 'object' as 'string', description: 'bad type' },
      },
    }
    const errors = validateManifest(meta)
    expect(errors.some(e => e.includes('foo'))).toBe(true)
  })

  it('returns error for input missing description', () => {
    const meta: WorkflowMeta = {
      name: 'test',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
      inputs: {
        foo: { type: 'string' } as { type: 'string'; description: string },
      },
    }
    const errors = validateManifest(meta)
    expect(errors.some(e => e.includes('foo'))).toBe(true)
  })

  it('validates phases require title and detail', () => {
    const meta = {
      name: 'test',
      description: 'desc',
      phases: [{ title: '', detail: 'ok' }],
    } as unknown as WorkflowMeta
    const errors = validateManifest(meta)
    expect(errors.some(e => e.includes('non-empty "title"'))).toBe(true)
  })

  it('accepts name with hyphens and digits', () => {
    const meta: WorkflowMeta = {
      name: 'my-workflow-2',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
    }
    expect(validateManifest(meta)).toEqual([])
  })
})

describe('computeManifestHash', () => {
  it('returns a 16-char hex string', () => {
    const meta: WorkflowMeta = {
      name: 'test',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
    }
    const hash = computeManifestHash(meta)
    expect(hash).toHaveLength(16)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('returns different hashes for different manifests', () => {
    const meta1: WorkflowMeta = {
      name: 'workflow-a',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
    }
    const meta2: WorkflowMeta = {
      name: 'workflow-b',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
    }
    expect(computeManifestHash(meta1)).not.toBe(computeManifestHash(meta2))
  })

  it('returns same hash for identical manifests', () => {
    const meta: WorkflowMeta = {
      name: 'test',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
    }
    expect(computeManifestHash(meta)).toBe(computeManifestHash(meta))
  })

  it('is deterministic across calls', () => {
    const meta: WorkflowMeta = {
      name: 'deterministic',
      description: 'desc',
      phases: [{ title: 'A', detail: 'B' }],
      risk: 'low',
    }
    const hashes = new Set<string>()
    for (let i = 0; i < 10; i++) {
      hashes.add(computeManifestHash(meta))
    }
    expect(hashes.size).toBe(1)
  })
})
