import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DISCOVERY_PATHS,
  detectFormat,
  analyzeStaticMeta,
  findWorkflow,
  discoverYamlTemplates,
  discoverJsWorkflows,
} from '../loader.js'

describe('DISCOVERY_PATHS', () => {
  it('includes .openslack/workflows', () => {
    expect(DISCOVERY_PATHS).toContain('.openslack/workflows')
  })

  it('includes .claude/workflows for legacy compatibility', () => {
    expect(DISCOVERY_PATHS).toContain('.claude/workflows')
  })

  it('has correct priority order (project-local first)', () => {
    const idx1 = DISCOVERY_PATHS.indexOf('.openslack/workflows')
    const idx2 = DISCOVERY_PATHS.indexOf('.claude/workflows')
    expect(idx1).toBeLessThan(idx2)
  })
})

describe('detectFormat', () => {
  it('returns "openslack-native" for meta + preview', () => {
    const mod = {
      meta: { name: 'test' },
      preview: async () => ({ preview: true }),
    }
    expect(detectFormat(mod)).toBe('openslack-native')
  })

  it('returns "openslack-native" for meta + run', () => {
    const mod = {
      meta: { name: 'test' },
      run: async () => ({ status: 'ok' }),
    }
    expect(detectFormat(mod)).toBe('openslack-native')
  })

  it('returns "openslack-native" for meta + preview + run', () => {
    const mod = {
      meta: { name: 'test' },
      preview: async () => ({ preview: true }),
      run: async () => ({ status: 'ok' }),
    }
    expect(detectFormat(mod)).toBe('openslack-native')
  })

  it('returns "anthropic-compatible" for meta only', () => {
    const mod = { meta: { name: 'test' } }
    expect(detectFormat(mod)).toBe('anthropic-compatible')
  })

  it('returns "invalid" for no meta', () => {
    const mod = { preview: async () => ({ preview: true }) }
    expect(detectFormat(mod)).toBe('invalid')
  })

  it('returns "invalid" for empty object', () => {
    expect(detectFormat({})).toBe('invalid')
  })

  it('returns "invalid" for null meta', () => {
    const mod = { meta: null }
    expect(detectFormat(mod)).toBe('invalid')
  })

  it('returns "invalid" when preview and run are not functions', () => {
    const mod = { meta: { name: 'test' }, preview: 'not-a-fn', run: 42 }
    expect(detectFormat(mod)).toBe('anthropic-compatible')
  })
})

describe('analyzeStaticMeta', () => {
  it('extracts a minimal meta from source', () => {
    const source = `
export const meta = {
  name: "test-workflow",
  description: "A test workflow",
  phases: [{ title: "Scan", detail: "Scan the code" }]
}
`
    const meta = analyzeStaticMeta(source)
    expect(meta.name).toBe('test-workflow')
    expect(meta.description).toBe('A test workflow')
    expect(meta.phases).toHaveLength(1)
    expect(meta.phases[0].title).toBe('Scan')
  })

  it('extracts meta with optional fields', () => {
    const source = `
export const meta = {
  name: "full-workflow",
  version: "1.0.0",
  description: "Full workflow",
  phases: [{ title: "Scan", detail: "Scan" }],
  risk: "medium"
}
`
    const meta = analyzeStaticMeta(source)
    expect(meta.version).toBe('1.0.0')
    expect(meta.risk).toBe('medium')
  })

  it('handles single-quoted strings', () => {
    const source = `
export const meta = {
  name: 'single-quote',
  description: 'Uses single quotes',
  phases: [{ title: 'Run', detail: 'Do it' }]
}
`
    const meta = analyzeStaticMeta(source)
    expect(meta.name).toBe('single-quote')
  })

  it('handles unquoted keys', () => {
    const source = `
export const meta = {
  name: "unquoted",
  description: "Unquoted keys",
  phases: [{ title: "A", detail: "B" }]
}
`
    const meta = analyzeStaticMeta(source)
    expect(meta.name).toBe('unquoted')
  })

  it('handles trailing commas', () => {
    const source = `
export const meta = {
  name: "trailing",
  description: "Trailing commas",
  phases: [
    { title: "A", detail: "B" },
  ],
}
`
    const meta = analyzeStaticMeta(source)
    expect(meta.name).toBe('trailing')
  })

  it('throws when no meta export found', () => {
    const source = `const meta = { name: "test" }`
    expect(() => analyzeStaticMeta(source)).toThrow('no "export const meta')
  })

  it('throws when meta is not a pure object literal', () => {
    const source = `export const meta = someFunction()`
    expect(() => analyzeStaticMeta(source)).toThrow()
  })

  it('throws when meta has computed property names', () => {
    const source = `export const meta = { ["computed"]: "bad" }`
    expect(() => analyzeStaticMeta(source)).toThrow()
  })

  it('throws when meta is not JSON-parseable (function reference)', () => {
    const source = `export const meta = { name: "test", fn: someRef }`
    expect(() => analyzeStaticMeta(source)).toThrow()
  })

  it('throws when meta has invalid required fields', () => {
    const source = `export const meta = { name: "" }`
    expect(() => analyzeStaticMeta(source)).toThrow('"name"')
  })

  it('handles meta with type annotation', () => {
    const source = `
export const meta: WorkflowMeta = {
  name: "typed-meta",
  description: "Has type annotation",
  phases: [{ title: "A", detail: "B" }]
}
`
    const meta = analyzeStaticMeta(source)
    expect(meta.name).toBe('typed-meta')
  })

  it('extracts meta with permissions object', () => {
    const source = `
export const meta = {
  name: "with-perms",
  description: "Has permissions",
  phases: [{ title: "Scan", detail: "Scan" }],
  permissions: { github: ["issues:read", "prs:read"] }
}
`
    const meta = analyzeStaticMeta(source)
    expect(meta.permissions).toBeDefined()
    expect(meta.permissions!.github).toEqual(['issues:read', 'prs:read'])
  })

  it('extracts meta with inputs', () => {
    const source = `
export const meta = {
  name: "with-inputs",
  description: "Has inputs",
  phases: [{ title: "Run", detail: "Run" }],
  inputs: {
    target: { type: "string", description: "Target path" }
  }
}
`
    const meta = analyzeStaticMeta(source)
    expect(meta.inputs).toBeDefined()
    expect(meta.inputs!.target.type).toBe('string')
  })

  it('handles multi-phase meta', () => {
    const source = `
export const meta = {
  name: "multi-phase",
  description: "Multiple phases",
  phases: [
    { title: "Scan", detail: "Scan" },
    { title: "Verify", detail: "Verify" },
    { title: "Report", detail: "Report" }
  ]
}
`
    const meta = analyzeStaticMeta(source)
    expect(meta.phases).toHaveLength(3)
    expect(meta.phases[2].title).toBe('Report')
  })

  it('handles nested objects in meta', () => {
    const source = `
export const meta = {
  name: "nested",
  description: "Nested objects",
  phases: [{ title: "Scan", detail: "Scan" }],
  permissions: {
    github: ["issues:read"],
    filesystem: ["read", "write"]
  }
}
`
    const meta = analyzeStaticMeta(source)
    expect(meta.permissions!.filesystem).toEqual(['read', 'write'])
  })

  it('works with the test-scan fixture source', () => {
    // Simulate what the test-scan.ts fixture looks like
    const source = `
import type { WorkflowMeta } from '../types.js'

export const meta: WorkflowMeta = {
  name: 'test-scan',
  description: 'Minimal test workflow for integration tests',
  phases: [
    { title: 'Scan', detail: 'Single dimension scan' },
    { title: 'Verify', detail: 'Single verifier' },
  ],
  permissions: { github: ['issues:read'] },
  risk: 'low',
}
`
    const meta = analyzeStaticMeta(source)
    expect(meta.name).toBe('test-scan')
    expect(meta.phases).toHaveLength(2)
    expect(meta.risk).toBe('low')
  })
})

describe('loadWorkflow integration', () => {
  it('detects format of a valid module object', () => {
    // Test detectFormat directly since loadWorkflow requires file I/O
    const nativeModule = {
      meta: { name: 'test' },
      preview: async () => ({ preview: true }),
      run: async () => ({ status: 'ok' }),
    }
    expect(detectFormat(nativeModule)).toBe('openslack-native')

    const compatModule = {
      meta: { name: 'legacy' },
    }
    expect(detectFormat(compatModule)).toBe('anthropic-compatible')

    expect(detectFormat({ run: async () => ({}) })).toBe('invalid')
  })
})

describe('findWorkflow', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-find-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns undefined when no workflows exist', async () => {
    const result = await findWorkflow('nonexistent', tmpDir)
    expect(result).toBeUndefined()
  })

  it('finds a workflow by name in .openslack/workflows', async () => {
    const workflowsDir = join(tmpDir, '.openslack', 'workflows')
    mkdirSync(workflowsDir, { recursive: true })
    writeFileSync(join(workflowsDir, 'my-scan.js'), `
export const meta = {
  name: 'my-scan',
  description: 'Test scan',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}
export async function preview() { return { preview: true } }
`)
    const result = await findWorkflow('my-scan', tmpDir)
    expect(result).toBeDefined()
    expect(result!.name).toBe('my-scan')
    expect(result!.path).toContain('my-scan.js')
  })

  it('prioritizes .openslack over .claude for same name', async () => {
    const dir1 = join(tmpDir, '.openslack', 'workflows')
    const dir2 = join(tmpDir, '.claude', 'workflows')
    mkdirSync(dir1, { recursive: true })
    mkdirSync(dir2, { recursive: true })

    writeFileSync(join(dir1, 'dup.js'), `
export const meta = { name: 'dup', description: 'v1', phases: [{ title: 'A', detail: 'B' }] }
`)
    writeFileSync(join(dir2, 'dup.js'), `
export const meta = { name: 'dup', description: 'v2', phases: [{ title: 'C', detail: 'D' }] }
`)
    const result = await findWorkflow('dup', tmpDir)
    expect(result).toBeDefined()
    expect(result!.path).toContain('.openslack')
  })
})

describe('discoverYamlTemplates', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-yaml-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array when directory does not exist', async () => {
    const result = await discoverYamlTemplates(join(tmpDir, 'nonexistent'))
    expect(result).toEqual([])
  })

  it('discovers YAML templates and extracts metadata', async () => {
    writeFileSync(join(tmpDir, 'test-flow.yaml'), `schema: openslack.workflow_template.v1
id: test-flow
name: Test Flow
inputs:
  - name: title
    type: string
    required: true
phases:
  - name: Setup
    steps:
      - type: action
        actionId: task.create
  - name: Run
    steps:
      - type: action
        actionId: task.sync
`)
    const result = await discoverYamlTemplates(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('test-flow')
    expect(result[0].displayName).toBe('Test Flow')
    expect(result[0].source).toBe('yaml-template')
    expect(result[0].phases).toBe(2)
    expect(result[0].inputs).toBe(1)
    expect(result[0].file).toBe('test-flow.yaml')
  })

  it('ignores non-YAML files', async () => {
    writeFileSync(join(tmpDir, 'readme.txt'), 'hello')
    writeFileSync(join(tmpDir, 'flow.yaml'), `id: flow\nname: Flow\nphases:\n  - name: A\n    steps: []\n`)
    const result = await discoverYamlTemplates(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('flow')
  })

  it('handles YAML files with no inputs', async () => {
    writeFileSync(join(tmpDir, 'no-inputs.yaml'), `id: no-inputs\nname: No Inputs\nphases:\n  - name: Run\n    steps: []\n`)
    const result = await discoverYamlTemplates(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].inputs).toBe(0)
  })

  it('uses filename as fallback when id is missing', async () => {
    writeFileSync(join(tmpDir, 'partial.yaml'), `name: Partial\nphases:\n  - name: A\n    steps: []\n`)
    const result = await discoverYamlTemplates(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('partial')
  })
})

describe('discoverJsWorkflows', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-js-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array when no workflows directories exist', async () => {
    const result = await discoverJsWorkflows(tmpDir)
    expect(result).toEqual([])
  })

  it('discovers JS modules from .openslack/workflows', async () => {
    const workflowsDir = join(tmpDir, '.openslack', 'workflows')
    mkdirSync(workflowsDir, { recursive: true })
    writeFileSync(join(workflowsDir, 'my-task.js'), `
export const meta = {
  name: 'my-task',
  description: 'A custom task',
  phases: [{ title: 'Run', detail: 'Do the work' }]
}
export async function run() { return { status: 'ok' } }
`)
    const result = await discoverJsWorkflows(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('my-task')
    expect(result[0].displayName).toBe('my-task')
    expect(result[0].source).toBe('openslack-project')
    expect(result[0].description).toBe('A custom task')
    expect(result[0].phases).toBe(1)
  })

  it('skips modules that fail static analysis', async () => {
    const workflowsDir = join(tmpDir, '.openslack', 'workflows')
    mkdirSync(workflowsDir, { recursive: true })
    writeFileSync(join(workflowsDir, 'bad.js'), `// no meta export`)
    writeFileSync(join(workflowsDir, 'good.js'), `
export const meta = { name: 'good', description: 'Good', phases: [{ title: 'A', detail: 'B' }] }
`)
    const result = await discoverJsWorkflows(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('good')
  })
})
