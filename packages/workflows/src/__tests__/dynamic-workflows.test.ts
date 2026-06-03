import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  exportWorkflowSkill,
  generateWorkflowDraft,
  getWorkflowPattern,
  listWorkflowPatterns,
  previewWorkflowDraft,
  readWorkflowPolicy,
  renderWorkflowDraftPreview,
  saveWorkflow,
  writeWorkflowPolicy,
} from '../index.js'

describe('dynamic workflow pattern registry', () => {
  it('lists Anthropic dynamic workflow patterns', () => {
    const ids = listWorkflowPatterns().map((pattern) => pattern.id)
    expect(ids).toEqual(expect.arrayContaining([
      'classify-and-act',
      'fanout-synthesize',
      'adversarial-verification',
      'generate-filter',
      'tournament',
      'loop-until-done',
      'model-router',
    ]))
  })

  it('returns a pattern manifest with phases', () => {
    const pattern = getWorkflowPattern('tournament')
    expect(pattern?.phases.length).toBeGreaterThan(0)
    expect(pattern?.requiredCapabilities).toContain('judging')
  })
})

describe('dynamic workflow drafts and policy', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openslack-dwp-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('generates and previews a workflow draft', async () => {
    const draft = await generateWorkflowDraft({
      prompt: 'audit every API endpoint',
      pattern: 'fanout-synthesize',
      rootDir: root,
      draftId: 'draft-test',
    })
    expect(existsSync(draft.path)).toBe(true)
    expect(draft.pattern).toBe('fanout-synthesize')

    const preview = await previewWorkflowDraft({ draftIdOrPath: 'draft-test', rootDir: root })
    expect(preview.draft.pattern).toBe('fanout-synthesize')
    expect(preview.trustRequirement).toBe('untrusted')
    expect(renderWorkflowDraftPreview(preview)).toContain('Budget:')
  })

  it('fails closed for unknown patterns', async () => {
    await expect(generateWorkflowDraft({
      prompt: 'audit',
      pattern: 'unknown',
      rootDir: root,
    })).rejects.toThrow('Unknown workflow pattern')
  })

  it('reads and writes workflow policy', () => {
    expect(readWorkflowPolicy({ rootDir: root }).enabled).toBe(true)
    const disabled = writeWorkflowPolicy({ enabled: false, reason: 'test' }, { rootDir: root })
    expect(disabled.enabled).toBe(false)
    expect(readWorkflowPolicy({ rootDir: root }).reason).toBe('test')
  })

  it('saves and exports generated workflows without run-local evidence', async () => {
    const draft = await generateWorkflowDraft({
      prompt: 'compare implementation strategies',
      pattern: 'tournament',
      rootDir: root,
      draftId: 'draft-save',
    })
    const saved = await saveWorkflow('draft-compare-implementation-strategies', {
      rootDir: root,
      to: 'project',
      sourcePath: draft.path,
    })
    expect(existsSync(saved.path)).toBe(true)

    const exported = await exportWorkflowSkill(saved.workflowName, { rootDir: root, outDir: 'skills/compare-strategy' })
    expect(existsSync(exported.skillPath)).toBe(true)
    const skill = readFileSync(exported.skillPath, 'utf-8')
    expect(skill).toContain('Workflow script:')
    expect(skill).not.toContain('.openslack.local')
  })
})
