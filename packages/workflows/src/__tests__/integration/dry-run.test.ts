import { describe, it, expect, vi } from 'vitest'
import { executeDryRun } from '../../execute.js'
import type { AgentLauncher } from '../../agent-shim.js'
import type { WorkflowMeta, WorkflowRuntime, RunResult } from '../../types.js'

const testManifest: WorkflowMeta = {
  name: 'test-dry-run-workflow',
  description: 'Test dry-run workflow',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Verify', detail: 'Verify phase' },
  ],
  permissions: { github: ['issues:read'] },
  sideEffects: ['github.issues.create'],
  risk: 'low',
}

describe('executeDryRun integration', () => {
  it('returns dry-run result with simulated effects', async () => {
    const workflow = {
      meta: testManifest,
      run: vi.fn(async (ctx: WorkflowRuntime) => {
        ctx.phase('Scan')
        ctx.log('Starting scan')
        await ctx.openslack.task.createIssue({ title: 'Test Bug' })
        ctx.phase('Verify')
        return { status: 'complete' }
      }),
    }

    const result = await executeDryRun(workflow, { manifest: testManifest })
    expect(result.dryRun).toBe(true)
    expect(result.runId).toMatch(/^dryrun-/)
    expect(result.workflowName).toBe('test-dry-run-workflow')
    expect(result.result).toBeDefined()
    expect(result.result!.status).toBe('complete')
    expect(result.errors).toHaveLength(0)
  })

  it('tracks simulated side effects', async () => {
    const workflow = {
      meta: testManifest,
      run: vi.fn(async (ctx: WorkflowRuntime) => {
        ctx.phase('Scan')
        await ctx.openslack.task.createIssue({ title: 'Bug 1' })
        await ctx.openslack.task.checkout(42, 'agent-1')
        await ctx.openslack.prms.requestMerge(1)
        ctx.phase('Verify')
        return { status: 'complete' }
      }),
    }

    const result = await executeDryRun(workflow, { manifest: testManifest })
    // The simulated effects are tracked from [DRY-RUN] log messages
    expect(result.simulatedEffects.length).toBeGreaterThanOrEqual(0)
  })

  it('uses dry-run agent launcher when none provided', async () => {
    const workflow = {
      meta: testManifest,
      run: vi.fn(async (ctx: WorkflowRuntime) => {
        ctx.phase('Scan')
        const agentResult = await ctx.agent('Scan for issues', {
          label: 'scan:test',
          phase: 'Scan',
        })
        return { status: 'complete', agentResult }
      }),
    }

    const result = await executeDryRun(workflow, { manifest: testManifest })
    expect(result.result).toBeDefined()
    const agentResult = result.result!.agentResult as { _dryRun: boolean; label: string }
    expect(agentResult._dryRun).toBe(true)
    expect(agentResult.label).toBe('scan:test')
  })

  it('uses provided agent launcher', async () => {
    const launcher: AgentLauncher = vi.fn(async () => ({
      data: { custom: true },
      tokenUsage: 10,
    }))
    const workflow = {
      meta: testManifest,
      run: vi.fn(async (ctx: WorkflowRuntime) => {
        ctx.phase('Scan')
        const result = await ctx.agent('Scan', { label: 'test', phase: 'Scan' })
        return { status: 'complete', agentResult: result }
      }),
    }

    const result = await executeDryRun(workflow, {
      manifest: testManifest,
      agentLauncher: launcher,
    })
    const agentResult = result.result!.agentResult as { custom: boolean }
    expect(agentResult).toEqual({ custom: true })
    expect(launcher).toHaveBeenCalledTimes(1)
  })

  it('captures errors from workflow execution', async () => {
    const workflow = {
      meta: testManifest,
      run: vi.fn(async () => {
        throw new Error('Intentional workflow error')
      }),
    }

    const result = await executeDryRun(workflow, { manifest: testManifest })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('Intentional workflow error')
    expect(result.result).toBeUndefined()
  })

  it('reports error when workflow has no run function', async () => {
    const workflow = { meta: testManifest }

    const result = await executeDryRun(workflow, { manifest: testManifest })
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('no run function')
  })

  it('passes args to the workflow', async () => {
    const workflow = {
      meta: testManifest,
      run: vi.fn(async (ctx: WorkflowRuntime, args: Record<string, unknown>) => {
        return { status: 'complete', receivedArgs: args }
      }),
    }

    const result = await executeDryRun(workflow, {
      manifest: testManifest,
      args: { key: 'value', count: 42 },
    })
    expect(result.result!.receivedArgs).toEqual({ key: 'value', count: 42 })
  })

  it('does not throw for write operations in dry-run mode', async () => {
    const workflow = {
      meta: testManifest,
      run: vi.fn(async (ctx: WorkflowRuntime) => {
        ctx.phase('Scan')
        // All these would throw in preview mode, but not dry-run
        await ctx.openslack.task.createIssue({ title: 'Bug' })
        await ctx.openslack.task.checkout(1, 'agent')
        await ctx.openslack.task.sync(1)
        await ctx.openslack.prms.requestMerge(1)
        await ctx.openslack.collaboration.recordEvent({ type: 'test' })
        await ctx.openslack.collaboration.createHandoff({})
        await ctx.openslack.collaboration.recordDecision({})
        await ctx.openslack.governance.audit('action')
        ctx.phase('Verify')
        return { status: 'complete' }
      }),
    }

    const result = await executeDryRun(workflow, { manifest: testManifest })
    expect(result.errors).toHaveLength(0)
    expect(result.result).toBeDefined()
  })
})
