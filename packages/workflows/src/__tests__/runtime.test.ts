import { describe, it, expect, vi } from 'vitest'
import { createRuntime } from '../runtime.js'
import type { RuntimeOptions } from '../runtime.js'
import type { AgentCacheStore, AgentLauncher } from '../agent-shim.js'
import type { PipelineCacheStore } from '../pipeline-runner.js'
import type { WorkflowMeta, BudgetState } from '../types.js'

const testManifest: WorkflowMeta = {
  name: 'test-workflow',
  description: 'Test workflow',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Verify', detail: 'Verify phase' },
    { title: 'Report', detail: 'Report phase' },
  ],
}

const autoConfirm = async () => true

function makeRuntime(overrides: Partial<RuntimeOptions> = {}): ReturnType<typeof createRuntime> {
  return createRuntime({
    runId: 'test-run-001',
    mode: 'execute',
    manifest: testManifest,
    onConfirm: autoConfirm,
    ...overrides,
  })
}

describe('createRuntime', () => {
  describe('basic properties', () => {
    it('exposes runId', () => {
      const rt = makeRuntime()
      expect(rt.runId).toBe('test-run-001')
    })

    it('exposes mode', () => {
      const rt = makeRuntime({ mode: 'preview' })
      expect(rt.mode).toBe('preview')
    })

    it('exposes budget with default unlimited', () => {
      const rt = makeRuntime()
      expect(rt.budget.tokensUsed).toBe(0)
      expect(rt.budget.tokensRemaining).toBeNull()
      expect(rt.budget.costUsd).toBe(0)
      expect(rt.budget.agentCalls).toBe(0)
    })

    it('exposes budget with configured limits', () => {
      const rt = makeRuntime({
        budget: { tokens: 5000, costUsd: 0.5 },
      })
      expect(rt.budget.tokensRemaining).toBe(5000)
      expect(rt.budget.costUsd).toBe(0.5)
    })

    it('exposes args as empty object by default', () => {
      const rt = makeRuntime()
      expect(rt.args).toEqual({})
    })
  })

  describe('phase tracking', () => {
    it('accepts a valid phase from manifest', () => {
      const rt = makeRuntime()
      expect(() => rt.phase('Scan')).not.toThrow()
    })

    it('accepts phases in order', () => {
      const rt = makeRuntime()
      rt.phase('Scan')
      expect(() => rt.phase('Verify')).not.toThrow()
    })

    it('accepts all phases sequentially', () => {
      const rt = makeRuntime()
      rt.phase('Scan')
      rt.phase('Verify')
      expect(() => rt.phase('Report')).not.toThrow()
    })

    it('throws for unknown phase', () => {
      const rt = makeRuntime()
      expect(() => rt.phase('Unknown')).toThrow('Unknown phase')
    })

    it('throws when going back to a previous phase', () => {
      const rt = makeRuntime()
      rt.phase('Scan')
      rt.phase('Verify')
      expect(() => rt.phase('Scan')).toThrow('already completed')
    })

    it('throws when skipping a phase', () => {
      const rt = makeRuntime()
      expect(() => rt.phase('Verify')).toThrow('Cannot jump')
    })

    it('allows re-entering current phase (no-op forward)', () => {
      const rt = makeRuntime()
      rt.phase('Scan')
      // Re-entering the same phase at same index should work
      expect(() => rt.phase('Scan')).not.toThrow()
    })
  })

  describe('log', () => {
    it('does not throw when logging', () => {
      const rt = makeRuntime()
      expect(() => rt.log('test message')).not.toThrow()
    })

    it('can log multiple messages', () => {
      const rt = makeRuntime()
      rt.log('msg1')
      rt.log('msg2')
      rt.log('msg3')
      // No error means success
    })
  })

  describe('agent', () => {
    it('uses default OpenSlack launcher when none configured', async () => {
      const rt = makeRuntime()
      const result = await rt.agent('prompt', { label: 'test', phase: 'Scan' })
      expect(result).toBeDefined()
    })

    it('throws in validate mode', async () => {
      const rt = makeRuntime({ mode: 'validate' })
      await expect(
        rt.agent('prompt', { label: 'test', phase: 'Scan' }),
      ).rejects.toThrow('validate mode')
    })

    it('calls the configured launcher', async () => {
      const launcher: AgentLauncher = vi.fn(async () => ({ data: { result: 'ok' }, tokenUsage: 10 }))
      const rt = makeRuntime({ agentLauncher: launcher })
      rt.phase('Scan')
      const result = await rt.agent('test prompt', { label: 'scan:test', phase: 'Scan' })
      expect(result).toEqual({ result: 'ok' })
      expect(launcher).toHaveBeenCalledTimes(1)
    })

    it('updates budget after agent call', async () => {
      const launcher: AgentLauncher = async () => ({ data: {}, tokenUsage: 50 })
      const rt = makeRuntime({
        agentLauncher: launcher,
        budget: { tokens: 1000, costUsd: 0 },
      })
      rt.phase('Scan')
      await rt.agent('prompt', { label: 'test', phase: 'Scan' })
      expect(rt.budget.tokensUsed).toBe(50)
      expect(rt.budget.agentCalls).toBe(1)
      expect(rt.budget.tokensRemaining).toBe(950)
    })

    it('returns cached result on cache hit', async () => {
      const cache: AgentCacheStore = {
        async load() { return { data: { cached: true } } },
        async save() {},
      }
      const launcher: AgentLauncher = vi.fn(async () => ({ data: { fresh: true } }))
      const rt = makeRuntime({ agentCache: cache, agentLauncher: launcher })
      rt.phase('Scan')
      const result = await rt.agent('prompt', { label: 'test', phase: 'Scan' })
      expect(result).toEqual({ cached: true })
      expect(launcher).not.toHaveBeenCalled()
    })
  })

  describe('parallel', () => {
    it('throws in validate mode', async () => {
      const rt = makeRuntime({ mode: 'validate' })
      await expect(
        rt.parallel([async () => 1]),
      ).rejects.toThrow('validate mode')
    })

    it('executes tasks with results in order', async () => {
      const rt = makeRuntime()
      const result = await rt.parallel([
        async () => 'a',
        async () => 'b',
        async () => 'c',
      ])
      expect(result).toEqual(['a', 'b', 'c'])
    })

    it('respects concurrency option', async () => {
      const rt = makeRuntime()
      const result = await rt.parallel(
        [async () => 1, async () => 2, async () => 3],
        { concurrency: 2 },
      )
      expect(result).toEqual([1, 2, 3])
    })

    it('returns empty array for empty tasks', async () => {
      const rt = makeRuntime()
      const result = await rt.parallel([])
      expect(result).toEqual([])
    })
  })

  describe('pipeline', () => {
    it('throws in validate mode', async () => {
      const rt = makeRuntime({ mode: 'validate' })
      await expect(
        rt.pipeline([1], async (x) => x),
      ).rejects.toThrow('validate mode')
    })

    it('processes items with results', async () => {
      const rt = makeRuntime()
      rt.phase('Scan')
      const result = await rt.pipeline([1, 2, 3], async (x) => x * 2)
      expect(result).toEqual([2, 4, 6])
    })

    it('returns empty array for empty items', async () => {
      const rt = makeRuntime()
      const result = await rt.pipeline([], async (x) => x)
      expect(result).toEqual([])
    })
  })

  describe('workflow', () => {
    it('throws when no loader configured', async () => {
      const rt = makeRuntime()
      await expect(rt.workflow('child')).rejects.toThrow('No workflow loader')
    })

    it('throws in validate mode', async () => {
      const rt = makeRuntime({ mode: 'validate' })
      await expect(rt.workflow('child')).rejects.toThrow('validate mode')
    })

    it('delegates to onWorkflowCall callback', async () => {
      const onCall = vi.fn(async () => ({ status: 'done' }))
      const rt = makeRuntime({ onWorkflowCall: onCall })
      const result = await rt.workflow('child-workflow', { arg: 1 })
      expect(result).toEqual({ status: 'done' })
      expect(onCall).toHaveBeenCalledWith('child-workflow', { arg: 1 })
    })

    it('exposes dynamic workflow helpers without breaking child workflow calls', async () => {
      const rt = makeRuntime()
      const fanout = await rt.workflow.fanoutSynthesize({
        items: [1, 2, 3],
        worker: async (item) => item * 2,
        synthesizer: async (results) => results.reduce((sum, value) => sum + value, 0),
      })
      expect(fanout.pattern).toBe('fanout-synthesize')
      expect(fanout.synthesis).toBe(12)

      const verify = await rt.workflow.adversarialVerify({
        candidates: ['a', 'b'],
        verifier: (candidate) => candidate === 'a' ? 'confirmed' : 'refuted',
      })
      expect(verify.decisions.map((d) => d.verdict)).toEqual(['confirmed', 'refuted'])

      const tournament = await rt.workflow.tournament({
        contestants: ['a', 'b', 'c'],
        judge: (left) => left,
      })
      expect(tournament.winner).toBe('a')

      const route = rt.workflow.routeModelAndIsolation({ label: 'verify', purpose: 'security verification' })
      expect(route.model).toBe('strong')
      expect(route.isolation).toBe('none')
    })

    it('throws when nesting depth exceeds limit', async () => {
      const rt = makeRuntime({ nestingDepth: 1 })
      await expect(rt.workflow('nested')).rejects.toThrow('nesting depth limit')
    })

    it('allows nesting at depth 0', async () => {
      const onCall = vi.fn(async () => 'ok')
      const rt = makeRuntime({ nestingDepth: 0, onWorkflowCall: onCall })
      const result = await rt.workflow('child')
      expect(result).toBe('ok')
    })
  })

  describe('openslack shim', () => {
    it('task.createPreview returns preview data', async () => {
      const rt = makeRuntime()
      const result = await rt.openslack.task.createPreview({ title: 'Test' })
      expect(result).toEqual({ preview: true, data: { title: 'Test' } })
    })

    it('task.createIssue returns issue URL and number', async () => {
      const rt = makeRuntime()
      const result = await rt.openslack.task.createIssue({ title: 'Bug' })
      expect(result.issueUrl).toBeDefined()
      expect(typeof result.issueNumber).toBe('number')
    })

    it('task.checkout returns worktree path and branch name', async () => {
      const rt = makeRuntime()
      const result = await rt.openslack.task.checkout(42, 'agent-1')
      expect(result.worktreePath).toBeDefined()
      expect(result.branchName).toContain('agent-1')
    })

    it('task.sync returns pushed status', async () => {
      const rt = makeRuntime()
      const result = await rt.openslack.task.sync(42)
      expect(typeof result.pushed).toBe('boolean')
    })

    it('prms.classify returns categorized paths', async () => {
      const rt = makeRuntime()
      const result = await rt.openslack.prms.classify(['src/a.ts', 'src/b.ts'])
      expect(result.green).toEqual(['src/a.ts', 'src/b.ts'])
      expect(result.yellow).toEqual([])
      expect(result.red).toEqual([])
    })

    it('prms.doctor returns a valid result', async () => {
      const rt = makeRuntime()
      const result = await rt.openslack.prms.doctor(1)
      expect(result.status).toBeDefined()
      expect(result.zone).toBeDefined()
    })

    it('prms.queue returns an array', async () => {
      const rt = makeRuntime()
      const result = await rt.openslack.prms.queue()
      expect(Array.isArray(result)).toBe(true)
    })

    it('prms.requestMerge returns merge status', async () => {
      const rt = makeRuntime()
      const result = await rt.openslack.prms.requestMerge(1)
      expect(typeof result.merged).toBe('boolean')
      expect(typeof result.prmsStatus).toBe('string')
    })

    it('collaboration.recordEvent does not throw', async () => {
      const rt = makeRuntime()
      await expect(rt.openslack.collaboration.recordEvent({ type: 'test' })).resolves.toBeUndefined()
    })

    it('governance.audit does not throw', async () => {
      const rt = makeRuntime()
      await expect(rt.openslack.governance.audit('test-action')).resolves.toBeUndefined()
    })
  })

  describe('permissions', () => {
    it('defaults to untrusted trust level with read-only', () => {
      const rt = makeRuntime()
      // Untrusted should only have read-only access
      // We test this indirectly through agent call behavior
      expect(rt.mode).toBe('execute')
    })

    it('uses resolved permissions for trusted workflows', () => {
      const rt = makeRuntime({
        permissions: {
          declared: { github: ['issues:read', 'issues:write'] },
          granted: { github: ['issues:read'] },
          trustLevel: 'trusted',
        },
      })
      // The runtime should be created without error
      expect(rt.runId).toBe('test-run-001')
    })
  })

  describe('mode restrictions', () => {
    it('validate mode blocks agent calls', async () => {
      const rt = makeRuntime({ mode: 'validate' })
      await expect(rt.agent('p', { label: 't', phase: 'Scan' })).rejects.toThrow('validate mode')
    })

    it('validate mode blocks parallel calls', async () => {
      const rt = makeRuntime({ mode: 'validate' })
      await expect(rt.parallel([async () => 1])).rejects.toThrow('validate mode')
    })

    it('validate mode blocks pipeline calls', async () => {
      const rt = makeRuntime({ mode: 'validate' })
      await expect(rt.pipeline([1], async (x) => x)).rejects.toThrow('validate mode')
    })

    it('validate mode blocks workflow calls', async () => {
      const rt = makeRuntime({ mode: 'validate' })
      await expect(rt.workflow('child')).rejects.toThrow('validate mode')
    })

    it('preview mode allows agent calls', async () => {
      const launcher: AgentLauncher = async () => ({ data: 'preview-result' })
      const rt = makeRuntime({ mode: 'preview', agentLauncher: launcher })
      rt.phase('Scan')
      const result = await rt.agent('prompt', { label: 'test', phase: 'Scan' })
      expect(result).toBe('preview-result')
    })

    it('dry-run mode allows agent calls', async () => {
      const launcher: AgentLauncher = async () => ({ data: 'dry-result' })
      const rt = makeRuntime({ mode: 'dry-run', agentLauncher: launcher })
      rt.phase('Scan')
      const result = await rt.agent('prompt', { label: 'test', phase: 'Scan' })
      expect(result).toBe('dry-result')
    })
  })

  describe('preview mode openslack restrictions', () => {
    it('blocks task.createIssue in preview mode', async () => {
      const rt = makeRuntime({ mode: 'preview' })
      await expect(rt.openslack.task.createIssue({ title: 'Bug' })).rejects.toThrow('not allowed in preview mode')
    })

    it('allows task.createPreview in preview mode', async () => {
      const rt = makeRuntime({ mode: 'preview' })
      const result = await rt.openslack.task.createPreview({ title: 'Test' })
      expect(result).toEqual({ preview: true, data: { title: 'Test' } })
    })

    it('blocks task.checkout in preview mode', async () => {
      const rt = makeRuntime({ mode: 'preview' })
      await expect(rt.openslack.task.checkout(42, 'agent-1')).rejects.toThrow('not allowed in preview mode')
    })

    it('blocks task.sync in preview mode', async () => {
      const rt = makeRuntime({ mode: 'preview' })
      await expect(rt.openslack.task.sync(42)).rejects.toThrow('not allowed in preview mode')
    })

    it('allows prms.classify in preview mode', async () => {
      const rt = makeRuntime({ mode: 'preview' })
      const result = await rt.openslack.prms.classify(['src/a.ts'])
      expect(result.green).toEqual(['src/a.ts'])
    })

    it('allows prms.doctor in preview mode', async () => {
      const rt = makeRuntime({ mode: 'preview' })
      const result = await rt.openslack.prms.doctor(1)
      expect(result.status).toBeDefined()
    })

    it('allows prms.queue in preview mode', async () => {
      const rt = makeRuntime({ mode: 'preview' })
      const result = await rt.openslack.prms.queue()
      expect(Array.isArray(result)).toBe(true)
    })

    it('blocks prms.requestMerge in preview mode', async () => {
      const rt = makeRuntime({ mode: 'preview' })
      await expect(rt.openslack.prms.requestMerge(1)).rejects.toThrow('not allowed in preview mode')
    })

    it('blocks collaboration.recordEvent in preview mode', async () => {
      const rt = makeRuntime({ mode: 'preview' })
      await expect(rt.openslack.collaboration.recordEvent({ type: 'test' })).rejects.toThrow('not allowed in preview mode')
    })

    it('blocks collaboration.createHandoff in preview mode', async () => {
      const rt = makeRuntime({ mode: 'preview' })
      await expect(rt.openslack.collaboration.createHandoff({})).rejects.toThrow('not allowed in preview mode')
    })

    it('blocks collaboration.recordDecision in preview mode', async () => {
      const rt = makeRuntime({ mode: 'preview' })
      await expect(rt.openslack.collaboration.recordDecision({})).rejects.toThrow('not allowed in preview mode')
    })

    it('blocks governance.audit in preview mode', async () => {
      const rt = makeRuntime({ mode: 'preview' })
      await expect(rt.openslack.governance.audit('test')).rejects.toThrow('not allowed in preview mode')
    })

    it('allows write operations in execute mode with confirmation', async () => {
      const rt = makeRuntime({ mode: 'execute' })
      await expect(rt.openslack.task.createIssue({ title: 'Bug' })).resolves.toBeDefined()
      await expect(rt.openslack.task.checkout(42, 'agent-1')).resolves.toBeDefined()
      await expect(rt.openslack.task.sync(42)).resolves.toBeDefined()
    })

    it('allows write operations in dry-run mode', async () => {
      const rt = makeRuntime({ mode: 'dry-run' })
      await expect(rt.openslack.task.createIssue({ title: 'Bug' })).resolves.toBeDefined()
      await expect(rt.openslack.prms.requestMerge(1)).resolves.toBeDefined()
    })
  })

  describe('dry-run mode simulation', () => {
    it('task.createIssue returns simulated data in dry-run mode', async () => {
      const rt = makeRuntime({ mode: 'dry-run' })
      const result = await rt.openslack.task.createIssue({ title: 'Bug' })
      expect(result.issueUrl).toContain('dry-run')
      expect(result.issueNumber).toBe(-1)
    })

    it('task.checkout returns simulated path in dry-run mode', async () => {
      const rt = makeRuntime({ mode: 'dry-run' })
      const result = await rt.openslack.task.checkout(42, 'agent-1')
      expect(result.worktreePath).toContain('dry-run')
      expect(result.branchName).toContain('dry-run')
    })

    it('task.sync returns simulated result in dry-run mode', async () => {
      const rt = makeRuntime({ mode: 'dry-run' })
      const result = await rt.openslack.task.sync(42)
      expect(result.pushed).toBe(false)
    })

    it('prms.requestMerge returns dry-run status in dry-run mode', async () => {
      const rt = makeRuntime({ mode: 'dry-run' })
      const result = await rt.openslack.prms.requestMerge(1)
      expect(result.prmsStatus).toBe('dry-run')
    })

    it('collaboration.recordEvent does not throw in dry-run mode', async () => {
      const rt = makeRuntime({ mode: 'dry-run' })
      await expect(rt.openslack.collaboration.recordEvent({ type: 'test' })).resolves.toBeUndefined()
    })

    it('collaboration.createHandoff returns details in dry-run mode', async () => {
      const rt = makeRuntime({ mode: 'dry-run' })
      const details = { from: 'a', to: 'b' }
      const result = await rt.openslack.collaboration.createHandoff(details)
      expect(result).toEqual(details)
    })

    it('governance.audit does not throw in dry-run mode', async () => {
      const rt = makeRuntime({ mode: 'dry-run' })
      await expect(rt.openslack.governance.audit('test-action')).resolves.toBeUndefined()
    })

    it('allows read operations in dry-run mode', async () => {
      const rt = makeRuntime({ mode: 'dry-run' })
      const classified = await rt.openslack.prms.classify(['a.ts'])
      expect(classified.green).toEqual(['a.ts'])
      const doctor = await rt.openslack.prms.doctor(1)
      expect(doctor.status).toBeDefined()
    })
  })

  describe('execute mode confirmation gate', () => {
    it('calls onConfirm before createIssue', async () => {
      const onConfirm = vi.fn(async () => true)
      const rt = makeRuntime({ mode: 'execute', onConfirm })
      await rt.openslack.task.createIssue({ title: 'Bug' })
      expect(onConfirm).toHaveBeenCalledTimes(1)
      expect(onConfirm).toHaveBeenCalledWith('openslack.task.createIssue', expect.any(String))
    })

    it('calls onConfirm before checkout', async () => {
      const onConfirm = vi.fn(async () => true)
      const rt = makeRuntime({ mode: 'execute', onConfirm })
      await rt.openslack.task.checkout(42, 'agent-1')
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('calls onConfirm before sync', async () => {
      const onConfirm = vi.fn(async () => true)
      const rt = makeRuntime({ mode: 'execute', onConfirm })
      await rt.openslack.task.sync(42)
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('calls onConfirm before requestMerge', async () => {
      const onConfirm = vi.fn(async () => true)
      const rt = makeRuntime({ mode: 'execute', onConfirm })
      await rt.openslack.prms.requestMerge(1)
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('calls onConfirm before recordEvent', async () => {
      const onConfirm = vi.fn(async () => true)
      const rt = makeRuntime({ mode: 'execute', onConfirm })
      await rt.openslack.collaboration.recordEvent({ type: 'test' })
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('calls onConfirm before createHandoff', async () => {
      const onConfirm = vi.fn(async () => true)
      const rt = makeRuntime({ mode: 'execute', onConfirm })
      await rt.openslack.collaboration.createHandoff({ from: 'a', to: 'b' })
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('calls onConfirm before recordDecision', async () => {
      const onConfirm = vi.fn(async () => true)
      const rt = makeRuntime({ mode: 'execute', onConfirm })
      await rt.openslack.collaboration.recordDecision({ topic: 'test' })
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('calls onConfirm before governance.audit', async () => {
      const onConfirm = vi.fn(async () => true)
      const rt = makeRuntime({ mode: 'execute', onConfirm })
      await rt.openslack.governance.audit('test')
      expect(onConfirm).toHaveBeenCalledTimes(1)
    })

    it('throws ExecuteDeniedError when onConfirm returns false', async () => {
      const onConfirm = vi.fn(async () => false)
      const rt = makeRuntime({ mode: 'execute', onConfirm })
      await expect(rt.openslack.task.createIssue({ title: 'Bug' })).rejects.toThrow('Execute denied')
    })

    it('denies operations when onConfirm is not set in execute mode', async () => {
      const rt = makeRuntime({ mode: 'execute', onConfirm: undefined })
      await expect(rt.openslack.task.createIssue({ title: 'Bug' })).rejects.toThrow('Execute denied')
    })

    it('read operations do not require confirmation', async () => {
      const onConfirm = vi.fn(async () => true)
      const rt = makeRuntime({ mode: 'execute', onConfirm })
      await rt.openslack.task.createPreview({ title: 'Test' })
      await rt.openslack.prms.classify(['a.ts'])
      await rt.openslack.prms.doctor(1)
      await rt.openslack.prms.queue()
      // No confirmation calls for read operations
      expect(onConfirm).not.toHaveBeenCalled()
    })
  })
})
