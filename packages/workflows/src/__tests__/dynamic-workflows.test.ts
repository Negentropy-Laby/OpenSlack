import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  controlWorkflowRun,
  exportWorkflowSkill,
  generateWorkflowDraft,
  getWorkflowPattern,
  inferWorkflowPatternId,
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

  it('uses one pattern inference helper for generated drafts and operator recommendations', () => {
    expect(inferWorkflowPatternId('compare three implementation alternatives')).toBe('tournament')
    expect(inferWorkflowPatternId('研究所有 package 边界')).toBe('fanout-synthesize')
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
    expect(preview.draft.createdAt).toBe(draft.createdAt)
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

  it('applies valid workflow run control transitions', async () => {
    const statusPath = writeWorkflowRunStatus(root, 'run-control', 'running')

    const result = await controlWorkflowRun('run-control', 'pause', { rootDir: root })

    expect(result.status).toBe('applied')
    const status = JSON.parse(readFileSync(statusPath, 'utf-8')) as { status: string; controlEvents?: Array<{ action: string }> }
    expect(status.status).toBe('paused')
    expect(status.controlEvents?.at(-1)?.action).toBe('pause')
  })

  it('rejects invalid workflow run control transitions without mutating status', async () => {
    const statusPath = writeWorkflowRunStatus(root, 'run-paused', 'paused')

    const result = await controlWorkflowRun('run-paused', 'pause', { rootDir: root })

    expect(result.status).toBe('rejected')
    const status = JSON.parse(readFileSync(statusPath, 'utf-8')) as { status: string; controlEvents?: unknown[] }
    expect(status.status).toBe('paused')
    expect(status.controlEvents).toBeUndefined()
  })

  it('allows saveScript evidence without changing terminal run status', async () => {
    const statusPath = writeWorkflowRunStatus(root, 'run-complete', 'completed')

    const result = await controlWorkflowRun('run-complete', 'saveScript', { rootDir: root })

    expect(result.status).toBe('applied')
    const status = JSON.parse(readFileSync(statusPath, 'utf-8')) as { status: string; controlEvents?: Array<{ action: string }> }
    expect(status.status).toBe('completed')
    expect(status.controlEvents?.at(-1)?.action).toBe('saveScript')
  })
})

function writeWorkflowRunStatus(root: string, runId: string, status: string): string {
  const runDir = join(root, '.openslack.local', 'workflows', 'runs', runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'meta.json'), JSON.stringify({
    runId,
    workflowName: 'test-workflow',
    mode: 'execute',
    args: {},
    startedAt: '2026-01-01T00:00:00.000Z',
  }, null, 2))
  const statusPath = join(runDir, 'status.json')
  writeFileSync(statusPath, JSON.stringify({
    status,
    updatedAt: '2026-01-01T00:00:00.000Z',
    phases: [],
  }, null, 2))
  return statusPath
}
