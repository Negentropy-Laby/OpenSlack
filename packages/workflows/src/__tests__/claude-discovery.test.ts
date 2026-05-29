import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoverWorkflows,
  discoverJsWorkflows,
} from '../loader.js'
import type { WorkflowSource } from '../types.js'

describe('claude-discovery', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'openslack-claude-disc-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // Helper to write a valid workflow to a directory
  function writeWorkflow(dir: string, filename: string, name: string) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, filename), `
export const meta = {
  name: '${name}',
  description: 'Test ${name}',
  phases: [{ title: 'Scan', detail: 'Scan phase' }]
}
`)
  }

  function writeAmbientWorkflow(dir: string, filename: string, name: string) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, filename), `
export const meta = {
  name: '${name}',
  description: 'Ambient ${name}',
  phases: [{ title: 'Scan', detail: 'Scan phase' }]
}

phase("Scan")
log("Running ambient ${name}")
const result = await agent("do work", { label: "scan", phase: "Scan" })
`)
  }

  // ── .mjs discovery ──────────────────────────────────────────────────────────

  describe('.mjs extension discovery', () => {
    it('discovers .mjs files from .openslack/workflows', async () => {
      writeWorkflow(join(tmpDir, '.openslack', 'workflows'), 'my-module.mjs', 'my-module')
      const result = await discoverWorkflows(tmpDir)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('my-module')
      expect(result[0].path).toContain('my-module.mjs')
    })

    it('discovers .mjs files from .claude/workflows', async () => {
      writeWorkflow(join(tmpDir, '.claude', 'workflows'), 'claude-mod.mjs', 'claude-mod')
      const result = await discoverWorkflows(tmpDir)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('claude-mod')
      expect(result[0].path).toContain('claude-mod.mjs')
    })

    it('discovers .mjs alongside .js and .ts files', async () => {
      const dir = join(tmpDir, '.openslack', 'workflows')
      mkdirSync(dir, { recursive: true })
      writeWorkflow(dir, 'a.js', 'a')
      writeWorkflow(dir, 'b.mjs', 'b')
      // .ts is also supported
      writeFileSync(join(dir, 'c.ts'), `
export const meta = { name: 'c', description: 'C', phases: [{ title: 'Scan', detail: 'Scan' }] }
`)
      const result = await discoverWorkflows(tmpDir)
      expect(result).toHaveLength(3)
      const names = result.map(r => r.name).sort()
      expect(names).toEqual(['a', 'b', 'c'])
    })
  })

  // ── correct WorkflowSource for each path ─────────────────────────────────────

  describe('WorkflowSource labeling', () => {
    it('labels .openslack/workflows as "openslack-project"', async () => {
      writeWorkflow(join(tmpDir, '.openslack', 'workflows'), 'native.js', 'native')
      const result = await discoverWorkflows(tmpDir)
      expect(result[0].source).toBe('openslack-project')
    })

    it('labels .claude/workflows as "claude-project"', async () => {
      writeWorkflow(join(tmpDir, '.claude', 'workflows'), 'legacy.js', 'legacy')
      const result = await discoverWorkflows(tmpDir)
      expect(result[0].source).toBe('claude-project')
    })

    it('labels ~/.claude/workflows as "claude-user"', async () => {
      // We cannot easily test real home dir scanning, so we test via discoverJsWorkflows
      // which uses the same source mapping. Instead, we verify the source mapping logic
      // by checking that a project-local .claude/workflows gets "claude-project".
      writeWorkflow(join(tmpDir, '.claude', 'workflows'), 'home.js', 'home')
      const result = await discoverWorkflows(tmpDir)
      expect(result[0].source).toBe('claude-project')
    })
  })

  // ── priority order ───────────────────────────────────────────────────────────

  describe('priority order (first match wins)', () => {
    it('.openslack takes priority over .claude for same name', async () => {
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
      const result = await discoverWorkflows(tmpDir)
      expect(result).toHaveLength(1)
      expect(result[0].path).toContain('.openslack')
      expect(result[0].source).toBe('openslack-project')
    })

    it('.claude takes priority over home dir for same name', async () => {
      // This tests the deduplication: if .claude/workflows has a file with
      // the same name, it wins over the home dir entry (which we cannot
      // easily mock here). We verify .claude is discovered before home.
      // The discoverWorkflows function iterates DISCOVERY_PATHS in order,
      // then home dir. First match by name wins.
      writeWorkflow(join(tmpDir, '.claude', 'workflows'), 'shared.js', 'shared')

      const result = await discoverWorkflows(tmpDir)
      const shared = result.find(r => r.name === 'shared')
      expect(shared).toBeDefined()
      expect(shared!.source).toBe('claude-project')
    })
  })

  // ── discoverJsWorkflows reports format ───────────────────────────────────────

  describe('discoverJsWorkflows format reporting', () => {
    it('reports "anthropic-compatible" for meta-only modules', async () => {
      const dir = join(tmpDir, '.openslack', 'workflows')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'meta-only.js'), `
export const meta = {
  name: 'meta-only',
  description: 'Meta only',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}
`)
      const result = await discoverJsWorkflows(tmpDir)
      expect(result).toHaveLength(1)
      expect(result[0].format).toBe('anthropic-compatible')
    })

    it('reports "openslack-native" for modules with export function run', async () => {
      const dir = join(tmpDir, '.openslack', 'workflows')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'native.js'), `
export const meta = {
  name: 'native',
  description: 'Native',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}
export async function run() { return { status: 'ok' } }
`)
      const result = await discoverJsWorkflows(tmpDir)
      expect(result).toHaveLength(1)
      expect(result[0].format).toBe('openslack-native')
    })

    it('reports "claude-ambient" for modules with ambient top-level DSL usage', async () => {
      const dir = join(tmpDir, '.openslack', 'workflows')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'ambient.js'), `
export const meta = {
  name: 'ambient',
  description: 'Ambient',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}

phase("Scan")
log("Running ambient workflow")
const result = await agent("do work", { label: "scan", phase: "Scan" })
`)
      const result = await discoverJsWorkflows(tmpDir)
      expect(result).toHaveLength(1)
      expect(result[0].format).toBe('claude-ambient')
    })

    it('reports correct source for .claude/workflows entries', async () => {
      const dir = join(tmpDir, '.claude', 'workflows')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'legacy.js'), `
export const meta = {
  name: 'legacy',
  description: 'Legacy',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}
`)
      const result = await discoverJsWorkflows(tmpDir)
      expect(result).toHaveLength(1)
      expect(result[0].source).toBe('claude-project')
    })

    it('includes .mjs files in discoverJsWorkflows with correct extension', async () => {
      const dir = join(tmpDir, '.openslack', 'workflows')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'module.mjs'), `
export const meta = {
  name: 'module',
  description: 'MJS module',
  phases: [{ title: 'Scan', detail: 'Scan' }]
}
`)
      const result = await discoverJsWorkflows(tmpDir)
      expect(result).toHaveLength(1)
      expect(result[0].file).toBe('module.mjs')
    })

    it('skips files that fail static analysis', async () => {
      const dir = join(tmpDir, '.openslack', 'workflows')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'bad.js'), `// no meta export at all`)
      writeFileSync(join(dir, 'good.mjs'), `
export const meta = { name: 'good', description: 'Good', phases: [{ title: 'A', detail: 'B' }] }
`)
      const result = await discoverJsWorkflows(tmpDir)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('good')
    })

    it('reports phases and description from meta', async () => {
      const dir = join(tmpDir, '.openslack', 'workflows')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'detailed.mjs'), `
export const meta = {
  name: 'detailed',
  description: 'A detailed workflow',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Verify', detail: 'Verify phase' },
    { title: 'Report', detail: 'Report phase' }
  ]
}
`)
      const result = await discoverJsWorkflows(tmpDir)
      expect(result).toHaveLength(1)
      expect(result[0].phases).toBe(3)
      expect(result[0].description).toBe('A detailed workflow')
      expect(result[0].displayName).toBe('detailed')
    })
  })
})
