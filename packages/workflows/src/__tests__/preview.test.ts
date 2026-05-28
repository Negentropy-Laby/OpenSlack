import { describe, it, expect, vi } from 'vitest'
import { executePreview, PreviewModeError } from '../preview.js'
import { createRuntime } from '../runtime.js'
import type { AgentLauncher } from '../agent-shim.js'
import type { WorkflowMeta, PreviewResult, RunResult, WorkflowRuntime } from '../types.js'

const testManifest: WorkflowMeta = {
  name: 'test-preview-workflow',
  description: 'Test preview workflow',
  phases: [
    { title: 'Scan', detail: 'Scan phase' },
    { title: 'Verify', detail: 'Verify phase' },
  ],
}

describe('executePreview', () => {
  describe('basic execution', () => {
    it('returns preview result for workflow with preview function', async () => {
      const workflow = {
        meta: testManifest,
        preview: vi.fn(async (ctx: WorkflowRuntime, args: Record<string, unknown>) => {
          ctx.phase('Scan')
          ctx.log('Preview scan starting')
          return {
            preview: true as const,
            findings: ['finding-1'],
          }
        }),
      }

      const result = await executePreview(workflow, { manifest: testManifest })
      expect(result.preview).toBe(true)
      expect(result.findings).toEqual(['finding-1'])
      expect(result.runId).toBeDefined()
      expect(result.workflowName).toBe('test-preview-workflow')
    })

    it('returns preview result for workflow with only run function', async () => {
      const workflow = {
        meta: testManifest,
        run: vi.fn(async (ctx: WorkflowRuntime) => {
          ctx.phase('Scan')
          return { status: 'complete', data: 'test' }
        }),
      }

      const result = await executePreview(workflow, { manifest: testManifest })
      expect(result.preview).toBe(true)
      expect(result.status).toBe('complete')
      expect(result.data).toBe('test')
    })

    it('returns default result for workflow with no preview or run', async () => {
      const workflow = { meta: testManifest }

      const result = await executePreview(workflow, { manifest: testManifest })
      expect(result.preview).toBe(true)
      expect(result.mode).toBe('preview')
      expect(result.workflowName).toBe('test-preview-workflow')
      expect(result.phases).toEqual(['Scan', 'Verify'])
    })
  })

  describe('runtime configuration', () => {
    it('creates runtime with preview mode', async () => {
      const workflow = {
        meta: testManifest,
        preview: vi.fn(async (ctx: WorkflowRuntime) => {
          expect(ctx.mode).toBe('preview')
          return { preview: true as const }
        }),
      }

      const result = await executePreview(workflow, { manifest: testManifest })
      expect(result.preview).toBe(true)
    })

    it('uses untrusted trust level', async () => {
      const launcher: AgentLauncher = vi.fn(async () => ({ data: 'ok', tokenUsage: 10 }))
      const workflow = {
        meta: testManifest,
        preview: vi.fn(async (ctx: WorkflowRuntime) => {
          ctx.phase('Scan')
          await ctx.agent('test', { label: 'test', phase: 'Scan' })
          return { preview: true as const }
        }),
      }

      const result = await executePreview(workflow, {
        manifest: testManifest,
        agentLauncher: launcher,
      })
      expect(result.preview).toBe(true)
    })

    it('passes args to the workflow', async () => {
      const workflow = {
        meta: testManifest,
        preview: vi.fn(async (ctx: WorkflowRuntime, args: Record<string, unknown>) => {
          return { preview: true as const, receivedArgs: args }
        }),
      }

      const result = await executePreview(workflow, {
        manifest: testManifest,
        args: { key: 'value', count: 42 },
      })
      expect(result.receivedArgs).toEqual({ key: 'value', count: 42 })
    })

    it('uses default budget when not specified', async () => {
      const workflow = { meta: testManifest }
      const result = await executePreview(workflow, { manifest: testManifest })
      expect(result.budget).toBeDefined()
      const budget = result.budget as { tokensUsed: number; tokensRemaining: number | null; agentCalls: number }
      expect(budget.tokensRemaining).toBe(10000)
    })

    it('uses provided budget', async () => {
      const workflow = { meta: testManifest }
      const result = await executePreview(workflow, {
        manifest: testManifest,
        budget: { tokens: 5000, costUsd: 0.5 },
      })
      const budget = result.budget as { tokensUsed: number; tokensRemaining: number | null; agentCalls: number }
      expect(budget.tokensRemaining).toBe(5000)
    })
  })

  describe('preview agent launcher', () => {
    it('uses placeholder launcher when none provided', async () => {
      const workflow = {
        meta: testManifest,
        preview: vi.fn(async (ctx: WorkflowRuntime) => {
          ctx.phase('Scan')
          const result = await ctx.agent('test prompt', { label: 'scan:test', phase: 'Scan' })
          return { preview: true as const, agentResult: result }
        }),
      }

      const result = await executePreview(workflow, { manifest: testManifest })
      expect(result.agentResult).toBeDefined()
      const agentResult = result.agentResult as { _preview: boolean; label: string; phase: string; promptLength: number; message: string }
      expect(agentResult._preview).toBe(true)
      expect(agentResult.label).toBe('scan:test')
    })

    it('uses provided launcher when specified', async () => {
      const launcher: AgentLauncher = vi.fn(async () => ({ data: { custom: true }, tokenUsage: 5 }))
      const workflow = {
        meta: testManifest,
        preview: vi.fn(async (ctx: WorkflowRuntime) => {
          ctx.phase('Scan')
          const result = await ctx.agent('test', { label: 'test', phase: 'Scan' })
          return { preview: true as const, agentResult: result }
        }),
      }

      const result = await executePreview(workflow, {
        manifest: testManifest,
        agentLauncher: launcher,
      })
      const agentResult = result.agentResult as { custom: boolean }
      expect(agentResult).toEqual({ custom: true })
      expect(launcher).toHaveBeenCalledTimes(1)
    })
  })

  describe('preview mode restrictions', () => {
    it('blocks openslack.task.createIssue in preview', async () => {
      const workflow = {
        meta: testManifest,
        preview: vi.fn(async (ctx: WorkflowRuntime) => {
          ctx.phase('Scan')
          await ctx.openslack.task.createIssue({ title: 'Bug' })
          return { preview: true as const }
        }),
      }

      await expect(
        executePreview(workflow, { manifest: testManifest }),
      ).rejects.toThrow('not allowed in preview mode')
    })

    it('allows openslack.task.createPreview in preview', async () => {
      const workflow = {
        meta: testManifest,
        preview: vi.fn(async (ctx: WorkflowRuntime) => {
          const result = await ctx.openslack.task.createPreview({ title: 'Test' })
          return { preview: true as const, previewResult: result }
        }),
      }

      const result = await executePreview(workflow, { manifest: testManifest })
      expect(result.previewResult).toEqual({ preview: true, data: { title: 'Test' } })
    })

    it('blocks openslack.task.checkout in preview', async () => {
      const workflow = {
        meta: testManifest,
        preview: vi.fn(async (ctx: WorkflowRuntime) => {
          await ctx.openslack.task.checkout(42, 'agent-1')
          return { preview: true as const }
        }),
      }

      await expect(
        executePreview(workflow, { manifest: testManifest }),
      ).rejects.toThrow('not allowed in preview mode')
    })

    it('allows openslack.prms.classify in preview', async () => {
      const workflow = {
        meta: testManifest,
        preview: vi.fn(async (ctx: WorkflowRuntime) => {
          const result = await ctx.openslack.prms.classify(['src/a.ts'])
          return { preview: true as const, classified: result }
        }),
      }

      const result = await executePreview(workflow, { manifest: testManifest })
      const classified = result.classified as { green: string[]; yellow: string[]; red: string[] }
      expect(classified.green).toEqual(['src/a.ts'])
    })

    it('blocks openslack.prms.requestMerge in preview', async () => {
      const workflow = {
        meta: testManifest,
        preview: vi.fn(async (ctx: WorkflowRuntime) => {
          await ctx.openslack.prms.requestMerge(1)
          return { preview: true as const }
        }),
      }

      await expect(
        executePreview(workflow, { manifest: testManifest }),
      ).rejects.toThrow('not allowed in preview mode')
    })
  })

  describe('runId generation', () => {
    it('generates unique run IDs', async () => {
      const workflow = { meta: testManifest }
      const result1 = await executePreview(workflow, { manifest: testManifest })
      const result2 = await executePreview(workflow, { manifest: testManifest })
      expect(result1.runId).not.toBe(result2.runId)
      expect(result1.runId).toMatch(/^preview-/)
      expect(result2.runId).toMatch(/^preview-/)
    })
  })
})

describe('PreviewModeError', () => {
  it('has correct name and properties', () => {
    const err = new PreviewModeError('test-op', 'test detail')
    expect(err.name).toBe('PreviewModeError')
    expect(err.operation).toBe('test-op')
    expect(err.message).toContain('test-op')
    expect(err.message).toContain('test detail')
  })

  it('is an instance of Error', () => {
    const err = new PreviewModeError('op', 'detail')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(PreviewModeError)
  })
})
