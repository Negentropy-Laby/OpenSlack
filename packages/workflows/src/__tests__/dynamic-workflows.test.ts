import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  controlWorkflowRun,
  exportWorkflowSkill,
  generateWorkflowDraft,
  getWorkflowCatalogEntry,
  getWorkflowRunProgress,
  getWorkflowPattern,
  inferWorkflowPatternId,
  listWorkflowCatalog,
  listWorkflowPatterns,
  previewWorkflowDraft,
  readWorkflowPolicy,
  renderWorkflowRunProgress,
  renderWorkflowDraftPreview,
  saveWorkflow,
  saveWorkflowRunScript,
  writeWorkflowPolicy,
} from '../index.js'
import { executeAgentCall } from '../agent-shim.js'

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

  it('lists workflow catalog entries backed by dynamic patterns', () => {
    const ids = listWorkflowCatalog().map((entry) => entry.id)
    expect(ids).toEqual(expect.arrayContaining([
      'deep-research',
      'codebase-audit',
      'pr-deep-verification',
      'refactor-migration',
    ]))
    expect(getWorkflowCatalogEntry('deep-research')?.requiredEvidence).toContain('citations')
    expect(getWorkflowCatalogEntry('pr-deep-verification')?.requiredEvidence).toContain('file/line references')
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

  it('saves the workflow source associated with a recorded run', async () => {
    writeWorkflowSource(root, 'test-workflow')
    writeWorkflowRunStatus(root, 'run-save', 'completed')

    const result = await saveWorkflowRunScript('run-save', { rootDir: root, to: 'claude-project' })

    expect(result.sourceRunId).toBe('run-save')
    expect(result.source).toBe('claude-project')
    expect(result.path).toContain(join('.claude', 'workflows'))
    expect(existsSync(result.path)).toBe(true)
  })

  it('builds workflow run progress from phase, agent, transcript, and budget evidence', async () => {
    writeWorkflowSource(root, 'test-workflow')
    writeWorkflowRunStatus(root, 'run-progress', 'running')
    writeFileSync(join(root, '.openslack.local', 'workflows', 'runs', 'run-progress', 'status.json'), JSON.stringify({
      status: 'running',
      currentPhase: 'Scan',
      updatedAt: '2026-01-01T00:01:00.000Z',
      phases: [{ phase: 'Scan', timestamp: '2026-01-01T00:00:30.000Z', status: 'completed', result: { files: 2 } }],
    }, null, 2))
    const agentsDir = join(root, '.openslack.local', 'workflows', 'runs', 'run-progress', 'agents')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(join(agentsDir, 'agent-1.json'), JSON.stringify({
      data: { finding: 'ok' },
      runId: 'RUN-20260101-ABCDEFGH',
      tokenUsage: 12,
      workflowEvidence: {
        label: 'scan-api',
        phase: 'Scan',
        agentRunId: 'RUN-20260101-ABCDEFGH',
        model: 'cheap',
        isolation: 'none',
        promptSummary: 'scan all api endpoints',
        promptHash: 'abc123',
        startedAt: '2026-01-01T00:00:10.000Z',
        completedAt: '2026-01-01T00:00:20.000Z',
        tokenUsage: 12,
      },
    }, null, 2))
    const agentDir = join(root, '.openslack.local', 'agents', 'runs', 'RUN-20260101-ABCDEFGH')
    mkdirSync(agentDir, { recursive: true })
    writeFileSync(join(agentDir, 'run.json'), JSON.stringify({
      runId: 'RUN-20260101-ABCDEFGH',
      status: 'completed',
      agentId: 'architect',
      model: 'cheap',
      startedAt: '2026-01-01T00:00:10.000Z',
      completedAt: '2026-01-01T00:00:20.000Z',
      tokensUsed: 12,
      tokensRemaining: 88,
      toolCalls: 1,
      transcriptPath: join(agentDir, 'transcript.jsonl'),
    }, null, 2))
    writeFileSync(join(agentDir, 'transcript.jsonl'), [
      JSON.stringify({ timestamp: '2026-01-01T00:00:10.000Z', type: 'start', data: { provider: 'local' } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:11.000Z', type: 'tool_call', data: { tool: 'read_file', path: 'packages/api.ts' } }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:20.000Z', type: 'complete', data: { result: { ok: true }, terminalReason: 'completed' } }),
    ].join('\n'))

    const progress = await getWorkflowRunProgress('run-progress', { rootDir: root })

    expect(progress?.agentCount).toBe(1)
    expect(progress?.budget.tokensUsed).toBe(12)
    expect(progress?.phases[0].agents[0].recentTools[0].name).toBe('read_file')
    expect(renderWorkflowRunProgress(progress!)).toContain('scan-api')
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

  it('records pending stopAgent when no live handle exists', async () => {
    const statusPath = writeWorkflowRunStatus(root, 'run-stop-agent', 'running')

    const result = await controlWorkflowRun('run-stop-agent', 'stopAgent', {
      rootDir: root,
      target: {
        runId: 'run-stop-agent',
        phase: 'Scan',
        agentRunId: 'RUN-20260101-NOHANDLE',
        agentId: 'scan-api',
      },
    })

    expect(result.status).toBe('recorded')
    const status = JSON.parse(readFileSync(statusPath, 'utf-8')) as {
      pendingAgentControls?: Array<{ action: string; target?: { agentRunId?: string } }>
    }
    expect(status.pendingAgentControls?.[0].action).toBe('stopAgent')
    expect(status.pendingAgentControls?.[0].target?.agentRunId).toBe('RUN-20260101-NOHANDLE')
  })

  it('blocks a matching future agent launch after pending stopAgent', async () => {
    writeWorkflowRunStatus(root, 'run-block-agent', 'running')
    await controlWorkflowRun('run-block-agent', 'stopAgent', {
      rootDir: root,
      target: {
        runId: 'run-block-agent',
        phase: 'Scan',
        agentRunId: 'RUN-20260101-BLOCKED',
        agentId: 'scan-api',
      },
    })

    await expect(executeAgentCall('scan packages/api.ts', {
      label: 'scan-api',
      phase: 'Scan',
    }, {
      runId: 'run-block-agent',
      mode: 'execute',
      budget: { tokensUsed: 0, tokensRemaining: 100, costUsd: 0, agentCalls: 0 },
      permissions: new Set(),
      cache: { async load() { return null }, async save() {} },
      launcher: async () => ({ data: { ok: true }, tokenUsage: 1 }),
      log: () => {},
      cacheKey: 'cache-key',
      agentRunId: 'RUN-20260101-BLOCKED',
      rootDir: root,
    })).rejects.toThrow(/Pending stop recorded/)
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

function writeWorkflowSource(root: string, name: string): string {
  const dir = join(root, '.openslack', 'workflows')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}.mjs`)
  writeFileSync(path, `export const meta = {
  name: ${JSON.stringify(name)},
  description: 'Test workflow',
  phases: [{ title: 'Scan', detail: 'Scan evidence' }],
  risk: 'low',
  budgetPolicy: { tokenBudget: 100, maxAgents: 10, maxConcurrency: 2, onExceeded: 'pause' }
}

export async function preview() {
  return { preview: true }
}
`, 'utf-8')
  return path
}
