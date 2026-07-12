import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { executeResume } from '../../execute.js'
import { RunStore } from '../../run-store.js'
import type { RunStoreFs, RunMeta } from '../../run-store.js'
import { checkResumable, prepareResume, forceResume, replayCachedPhases } from '../../resume.js'
import type { AgentLauncher } from '../../agent-shim.js'
import type { WorkflowMeta, WorkflowRuntime, RunResult, PhaseCheckpoint, ExecutionMode } from '../../types.js'
import { computeManifestHash } from '../../manifest.js'

// ── In-memory filesystem ────────────────────────────────────────────────────

function createMemFs(): RunStoreFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    async mkdir(dir: string) {
      files.set(dir.endsWith('/') ? dir : `${dir}/`, '')
    },
    async writeFile(path: string, content: string) {
      files.set(path, content)
    },
    async readFile(path: string) {
      return files.get(path) ?? null
    },
    async appendFile(path: string, line: string) {
      const existing = files.get(path) ?? ''
      files.set(path, existing + line)
    },
    async exists(path: string) {
      return files.has(path) || files.has(`${path}/`)
    },
  }
}

function makeStore(): { store: RunStore; fs: ReturnType<typeof createMemFs> } {
  const fs = createMemFs()
  const store = new RunStore({ baseDir: '/test/workflows', fs })
  return { store, fs }
}

const TEST_MANIFEST: WorkflowMeta = {
  name: 'test-resume-workflow',
  description: 'Test resume workflow',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Verify', detail: 'Verify phase' },
    { title: 'Report', detail: 'Report phase' },
  ],
  permissions: { github: ['issues:read'] },
  risk: 'low',
}

function makeMeta(manifest: WorkflowMeta, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: 'run-resume-001',
    workflowName: manifest.name,
    mode: 'execute' as ExecutionMode,
    manifestHash: computeManifestHash(manifest),
    args: {},
    startedAt: '2026-05-28T12:00:00.000Z',
    ...overrides,
  }
}

async function initPausedRun(
  store: RunStore,
  manifest: WorkflowMeta,
  completedPhaseNames: string[] = [],
  runId: string = 'run-resume-001',
): Promise<string> {
  const meta = makeMeta(manifest, { runId })
  await store.initRun(runId, meta)

  for (const name of completedPhaseNames) {
    const cp: PhaseCheckpoint = {
      phase: name,
      timestamp: new Date().toISOString(),
      status: 'completed',
    }
    await store.savePhaseCheckpoint(runId, cp)
  }

  await store.transitionStatus(runId, 'paused')
  return runId
}

describe('executeResume integration', () => {
  let executionRoot: string

  beforeEach(() => {
    executionRoot = mkdtempSync(join(tmpdir(), 'openslack-workflow-resume-'))
  })

  afterEach(() => {
    rmSync(executionRoot, { recursive: true, force: true })
  })

  it('executes the workflow run function', async () => {
    const runFn = vi.fn(async (ctx: WorkflowRuntime) => {
      ctx.phase('Scan')
      ctx.phase('Verify')
      ctx.phase('Report')
      return { status: 'complete' }
    })
    const workflow = { meta: TEST_MANIFEST, run: runFn }

    const result = await executeResume(workflow, {
      runId: 'run-resume-001',
      manifest: TEST_MANIFEST,
      onConfirm: async () => true,
      rootDir: executionRoot,
    })
    expect(result.status).toBe('complete')
    expect(runFn).toHaveBeenCalledTimes(1)
  })

  it('throws when workflow has no run function', async () => {
    const workflow = { meta: TEST_MANIFEST }
    await expect(
      executeResume(workflow, {
        runId: 'run-001',
        manifest: TEST_MANIFEST,
        onConfirm: async () => true,
        rootDir: executionRoot,
      }),
    ).rejects.toThrow('no run function')
  })

  it('passes args to the workflow', async () => {
    const runFn = vi.fn(async (ctx: WorkflowRuntime, args: Record<string, unknown>) => {
      return { status: 'complete', receivedArgs: args }
    })
    const workflow = { meta: TEST_MANIFEST, run: runFn }

    const result = await executeResume(workflow, {
      runId: 'run-resume-001',
      manifest: TEST_MANIFEST,
      args: { key: 'value' },
      onConfirm: async () => true,
      rootDir: executionRoot,
    })
    expect(result.receivedArgs).toEqual({ key: 'value' })
  })

  it('uses provided agent launcher', async () => {
    const launcher: AgentLauncher = vi.fn(async () => ({
      data: { resumed: true },
      tokenUsage: 5,
    }))
    const runFn = vi.fn(async (ctx: WorkflowRuntime) => {
      ctx.phase('Scan')
      const agentResult = await ctx.agent('test', { label: 'test', phase: 'Scan' })
      return { status: 'complete', agentResult }
    })
    const workflow = { meta: TEST_MANIFEST, run: runFn }

    const result = await executeResume(workflow, {
      runId: 'run-resume-001',
      manifest: TEST_MANIFEST,
      agentLauncher: launcher,
      onConfirm: async () => true,
      rootDir: executionRoot,
    })
    const agentResult = result.agentResult as { resumed: boolean }
    expect(agentResult).toEqual({ resumed: true })
  })

  it('uses provided onConfirm callback', async () => {
    const onConfirm = vi.fn(async () => true)
    const runFn = vi.fn(async (ctx: WorkflowRuntime) => {
      ctx.phase('Scan')
      await ctx.openslack.task.createIssue({ title: 'Bug' })
      return { status: 'complete' }
    })
    const workflow = { meta: TEST_MANIFEST, run: runFn }

    const result = await executeResume(workflow, {
      runId: 'run-resume-001',
      manifest: TEST_MANIFEST,
      onConfirm,
      rootDir: executionRoot,
    })
    expect(result.status).toBe('complete')
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('denies operation when onConfirm returns false', async () => {
    const onConfirm = vi.fn(async () => false)
    const runFn = vi.fn(async (ctx: WorkflowRuntime) => {
      ctx.phase('Scan')
      await ctx.openslack.task.createIssue({ title: 'Bug' })
      return { status: 'complete' }
    })
    const workflow = { meta: TEST_MANIFEST, run: runFn }

    await expect(
      executeResume(workflow, {
        runId: 'run-resume-001',
        manifest: TEST_MANIFEST,
        onConfirm,
        rootDir: executionRoot,
      }),
    ).rejects.toThrow('Execute denied')
  })
})

describe('resume with run store integration', () => {
  it('checkResumable works with in-memory store', async () => {
    const { store } = makeStore()
    await initPausedRun(store, TEST_MANIFEST, ['Scan'])

    const result = await checkResumable(store, 'run-resume-001', TEST_MANIFEST)
    expect(result.canResume).toBe(true)
    expect(result.manifestMatch).toBe(true)
  })

  it('prepareResume returns correct state after partial completion', async () => {
    const { store } = makeStore()
    await initPausedRun(store, TEST_MANIFEST, ['Scan', 'Verify'])

    const state = await prepareResume(store, 'run-resume-001', TEST_MANIFEST)
    expect(state.completedPhases).toHaveLength(2)
    expect(state.completedPhases[0].phase).toBe('Scan')
    expect(state.completedPhases[1].phase).toBe('Verify')
    expect(state.nextPhaseIndex).toBe(2)
  })

  it('forceResume transitions status back to running', async () => {
    const { store } = makeStore()
    await initPausedRun(store, TEST_MANIFEST, ['Scan'])

    const state = await forceResume(store, 'run-resume-001', TEST_MANIFEST)
    expect(state.runId).toBe('run-resume-001')

    const status = await store.loadStatus('run-resume-001')
    expect(status!.status).toBe('running')
  })

  it('can transition resumed run through lifecycle', async () => {
    const { store } = makeStore()
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan'])

    // Resume
    await forceResume(store, runId, TEST_MANIFEST)

    // Simulate completing another phase
    await store.savePhaseCheckpoint(runId, {
      phase: 'Verify',
      timestamp: new Date().toISOString(),
      status: 'completed',
    })

    // Complete the run
    await store.transitionStatus(runId, 'completed')

    const finalStatus = await store.loadStatus(runId)
    expect(finalStatus!.status).toBe('completed')
    expect(finalStatus!.phases).toHaveLength(2)
  })

  it('stores and retrieves output for resumed runs', async () => {
    const { store } = makeStore()
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan'])
    await forceResume(store, runId, TEST_MANIFEST)

    const output = { status: 'complete', data: 'test' }
    await store.saveOutput(runId, output)

    const loaded = await store.loadOutput(runId)
    expect(loaded).toEqual(output)
  })

  it('logs entries during resumed run', async () => {
    const { store } = makeStore()
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan'])
    await forceResume(store, runId, TEST_MANIFEST)

    await store.appendLog(runId, {
      ts: new Date().toISOString(),
      phase: 'Verify',
      message: 'Resumed verify phase',
      runId,
    })

    const log = await store.readLog(runId)
    expect(log).toHaveLength(1)
    expect(log[0].message).toBe('Resumed verify phase')
    expect(log[0].phase).toBe('Verify')
  })

  it('replayCachedPhases validates checkpoint order for resume', () => {
    const checkpoints: PhaseCheckpoint[] = [
      { phase: 'Scan', timestamp: '2026-01-01', status: 'completed' },
    ]
    const result = replayCachedPhases(TEST_MANIFEST, checkpoints)
    expect(result).toHaveLength(1)
    expect(result[0].phase).toBe('Scan')
  })

  it('detects mismatched manifest during resume check', async () => {
    const { store } = makeStore()
    await initPausedRun(store, TEST_MANIFEST, ['Scan'])

    const modifiedManifest: WorkflowMeta = {
      ...TEST_MANIFEST,
      description: 'Modified description',
    }

    const result = await checkResumable(store, 'run-resume-001', modifiedManifest)
    expect(result.canResume).toBe(false)
    expect(result.reason).toContain('Manifest hash mismatch')
  })
})
