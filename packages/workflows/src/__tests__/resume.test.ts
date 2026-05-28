import { describe, it, expect } from 'vitest'
import { checkResumable, prepareResume, forceResume, replayCachedPhases } from '../resume.js'
import type { ResumeState } from '../resume.js'
import { RunStore } from '../run-store.js'
import type { RunStoreFs, RunMeta } from '../run-store.js'
import type { PhaseCheckpoint, WorkflowMeta, ExecutionMode } from '../types.js'
import { computeManifestHash } from '../manifest.js'

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
  name: 'test-scan',
  description: 'Test workflow for resume tests',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Verify', detail: 'Verify phase' },
    { title: 'Report', detail: 'Report phase' },
  ],
}

function makeMeta(manifest: WorkflowMeta, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    runId: 'run-001',
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
): Promise<string> {
  const runId = 'run-001'
  const meta = makeMeta(manifest)
  await store.initRun(runId, meta)

  // Save checkpoints for completed phases
  for (const name of completedPhaseNames) {
    const cp: PhaseCheckpoint = {
      phase: name,
      timestamp: new Date().toISOString(),
      status: 'completed',
    }
    await store.savePhaseCheckpoint(runId, cp)
  }

  // Transition to paused
  await store.transitionStatus(runId, 'paused')
  return runId
}

describe('checkResumable', () => {
  it('returns false for non-existent run', async () => {
    const { store } = makeStore()
    const result = await checkResumable(store, 'nope', TEST_MANIFEST)
    expect(result.canResume).toBe(false)
    expect(result.reason).toContain('not found')
  })

  it('returns false for running status', async () => {
    const { store } = makeStore()
    const meta = makeMeta(TEST_MANIFEST)
    await store.initRun('run-001', meta)
    // Run is in "running" state by default

    const result = await checkResumable(store, 'run-001', TEST_MANIFEST)
    expect(result.canResume).toBe(false)
    expect(result.reason).toContain('running')
  })

  it('returns false for completed status', async () => {
    const { store } = makeStore()
    const meta = makeMeta(TEST_MANIFEST)
    await store.initRun('run-001', meta)
    await store.transitionStatus('run-001', 'completed')

    const result = await checkResumable(store, 'run-001', TEST_MANIFEST)
    expect(result.canResume).toBe(false)
    expect(result.reason).toContain('completed')
  })

  it('returns true for paused run with matching manifest', async () => {
    const { store } = makeStore()
    await initPausedRun(store, TEST_MANIFEST, ['Scan'])

    const result = await checkResumable(store, 'run-001', TEST_MANIFEST)
    expect(result.canResume).toBe(true)
    expect(result.manifestMatch).toBe(true)
    expect(result.reason).toBeUndefined()
  })

  it('returns false for paused run with mismatched manifest hash', async () => {
    const { store } = makeStore()
    await initPausedRun(store, TEST_MANIFEST, ['Scan'])

    const modifiedManifest: WorkflowMeta = {
      ...TEST_MANIFEST,
      description: 'Modified description',
    }

    const result = await checkResumable(store, 'run-001', modifiedManifest)
    expect(result.canResume).toBe(false)
    expect(result.manifestMatch).toBe(false)
    expect(result.reason).toContain('Manifest hash mismatch')
    expect(result.storedManifestHash).toBeDefined()
    expect(result.currentManifestHash).toBeDefined()
    expect(result.storedManifestHash).not.toBe(result.currentManifestHash)
  })

  it('includes status in result', async () => {
    const { store } = makeStore()
    await initPausedRun(store, TEST_MANIFEST, ['Scan'])

    const result = await checkResumable(store, 'run-001', TEST_MANIFEST)
    expect(result.status).not.toBeNull()
    expect(result.status!.status).toBe('paused')
  })
})

describe('prepareResume', () => {
  it('returns resume state with completed phases', async () => {
    const { store } = makeStore()
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan'])

    const state = await prepareResume(store, runId, TEST_MANIFEST)
    expect(state.runId).toBe('run-001')
    expect(state.completedPhases).toHaveLength(1)
    expect(state.completedPhases[0].phase).toBe('Scan')
    expect(state.nextPhaseIndex).toBe(1) // Resume from Verify
  })

  it('returns nextPhaseIndex 0 when no phases completed', async () => {
    const { store } = makeStore()
    const runId = await initPausedRun(store, TEST_MANIFEST, [])

    const state = await prepareResume(store, runId, TEST_MANIFEST)
    expect(state.completedPhases).toHaveLength(0)
    expect(state.nextPhaseIndex).toBe(0)
  })

  it('returns correct nextPhaseIndex when all phases completed', async () => {
    const { store } = makeStore()
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan', 'Verify', 'Report'])

    const state = await prepareResume(store, runId, TEST_MANIFEST)
    expect(state.completedPhases).toHaveLength(3)
    expect(state.nextPhaseIndex).toBe(3)
  })

  it('stops at first non-completed phase', async () => {
    const { store } = makeStore()
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan'])
    // Manually save a "failed" Verify checkpoint
    await store.savePhaseCheckpoint(runId, {
      phase: 'Verify',
      timestamp: new Date().toISOString(),
      status: 'failed',
    })

    const state = await prepareResume(store, runId, TEST_MANIFEST)
    // Only Scan is completed; Verify is failed so we stop there
    expect(state.completedPhases).toHaveLength(1)
    expect(state.nextPhaseIndex).toBe(1)
  })

  it('throws for non-existent run', async () => {
    const { store } = makeStore()
    await expect(prepareResume(store, 'nope', TEST_MANIFEST)).rejects.toThrow(
      'not found',
    )
  })

  it('throws for running status', async () => {
    const { store } = makeStore()
    await store.initRun('run-001', makeMeta(TEST_MANIFEST))
    await expect(prepareResume(store, 'run-001', TEST_MANIFEST)).rejects.toThrow()
  })

  it('throws for manifest hash mismatch', async () => {
    const { store } = makeStore()
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan'])

    const modifiedManifest: WorkflowMeta = {
      ...TEST_MANIFEST,
      description: 'Changed!',
    }
    await expect(prepareResume(store, runId, modifiedManifest)).rejects.toThrow(
      'Manifest hash mismatch',
    )
  })

  it('includes meta in resume state', async () => {
    const { store } = makeStore()
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan'])

    const state = await prepareResume(store, runId, TEST_MANIFEST)
    expect(state.meta.runId).toBe('run-001')
    expect(state.meta.workflowName).toBe('test-scan')
    expect(state.meta.manifestHash).toBe(computeManifestHash(TEST_MANIFEST))
  })
})

describe('forceResume', () => {
  it('transitions paused run back to running', async () => {
    const { store } = makeStore()
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan'])

    const state = await forceResume(store, runId, TEST_MANIFEST)
    expect(state.runId).toBe('run-001')

    const status = await store.loadStatus(runId)
    expect(status!.status).toBe('running')
  })

  it('works even with manifest hash mismatch', async () => {
    const { store } = makeStore()
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan'])

    const modifiedManifest: WorkflowMeta = {
      ...TEST_MANIFEST,
      description: 'Changed!',
    }
    // forceResume should NOT throw even with mismatched hash
    const state = await forceResume(store, runId, modifiedManifest)
    expect(state.runId).toBe('run-001')
  })

  it('throws for non-existent run', async () => {
    const { store } = makeStore()
    await expect(forceResume(store, 'nope', TEST_MANIFEST)).rejects.toThrow(
      'not found',
    )
  })

  it('throws for non-paused status', async () => {
    const { store } = makeStore()
    await store.initRun('run-001', makeMeta(TEST_MANIFEST))
    // Still in "running" state

    await expect(forceResume(store, 'run-001', TEST_MANIFEST)).rejects.toThrow(
      'expected "paused"',
    )
  })

  it('returns completed phases from previous run', async () => {
    const { store } = makeStore()
    const runId = await initPausedRun(store, TEST_MANIFEST, ['Scan', 'Verify'])

    const state = await forceResume(store, runId, TEST_MANIFEST)
    expect(state.completedPhases).toHaveLength(2)
    expect(state.nextPhaseIndex).toBe(2)
  })
})

describe('replayCachedPhases', () => {
  it('returns checkpoints that match manifest phases', () => {
    const checkpoints: PhaseCheckpoint[] = [
      { phase: 'Scan', timestamp: '2026-01-01', status: 'completed' },
      { phase: 'Verify', timestamp: '2026-01-01', status: 'completed' },
    ]
    const result = replayCachedPhases(TEST_MANIFEST, checkpoints)
    expect(result).toHaveLength(2)
    expect(result[0].phase).toBe('Scan')
    expect(result[1].phase).toBe('Verify')
  })

  it('stops at first missing checkpoint', () => {
    const checkpoints: PhaseCheckpoint[] = [
      { phase: 'Scan', timestamp: '2026-01-01', status: 'completed' },
    ]
    const result = replayCachedPhases(TEST_MANIFEST, checkpoints)
    expect(result).toHaveLength(1)
  })

  it('returns empty array for no checkpoints', () => {
    const result = replayCachedPhases(TEST_MANIFEST, [])
    expect(result).toEqual([])
  })

  it('throws on phase name mismatch', () => {
    const checkpoints: PhaseCheckpoint[] = [
      { phase: 'WrongPhase', timestamp: '2026-01-01', status: 'completed' },
    ]
    expect(() => replayCachedPhases(TEST_MANIFEST, checkpoints)).toThrow(
      'Phase mismatch at index 0',
    )
  })

  it('throws on non-completed phase status', () => {
    const checkpoints: PhaseCheckpoint[] = [
      { phase: 'Scan', timestamp: '2026-01-01', status: 'failed' },
    ]
    expect(() => replayCachedPhases(TEST_MANIFEST, checkpoints)).toThrow(
      'has status "failed"',
    )
  })

  it('handles all phases completed', () => {
    const checkpoints: PhaseCheckpoint[] = [
      { phase: 'Scan', timestamp: '2026-01-01', status: 'completed' },
      { phase: 'Verify', timestamp: '2026-01-01', status: 'completed' },
      { phase: 'Report', timestamp: '2026-01-01', status: 'completed' },
    ]
    const result = replayCachedPhases(TEST_MANIFEST, checkpoints)
    expect(result).toHaveLength(3)
  })
})
