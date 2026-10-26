import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ConfirmationVault } from '../src/confirmation-vault.ts'

const token = 'SENTINEL_CONFIRMATION_BEARER_12345678901234567890'
const exec = {} as ToolRunContext
const args = { workflowId: 'harness.task.report', input: { runId: 'RUN-TEST', reportId: 'r1', summary: 'progress', evidenceRefs: [] } }
function tool(value: unknown) {
  return { name: 'fixture', description: '', parameters: {}, output: { schema: {}, render: () => [] },
    execute: vi.fn(async () => value) } satisfies ToolDefinition
}
function preview() {
  return { content: [{ type: 'text', text: token }], structuredContent: {
    status: 'needs_confirmation', planId: 'PLAN-1', confirmationToken: token,
    data: { expiresAt: new Date(Date.now() + 60_000).toISOString(), note: token },
  } }
}
function setup() {
  const assertCurrent = vi.fn(async () => {})
  const vault = new ConfirmationVault({ taskId: 'TASK-1', runId: 'RUN-TEST', principalId: 'principal', generation: 'g1', assertCurrent })
  return { vault, assertCurrent }
}

describe('per-agent confirmation vault', () => {
  it('removes bearer from canonical and text projections; confirm receives only planId from the caller', async () => {
    const { vault } = setup()
    const safe = await vault.preview(tool(preview()), args, exec)
    expect(JSON.stringify(safe)).not.toContain(token)
    expect(JSON.stringify(safe)).not.toContain('confirmationToken')
    const confirm = tool({ structuredContent: { status: 'completed', echo: token }, content: [] })
    const result = await vault.settle(confirm, { planId: 'PLAN-1' }, exec)
    expect(confirm.execute).toHaveBeenCalledWith({ planId: 'PLAN-1', confirmationToken: token }, exec)
    expect(JSON.stringify(result)).not.toContain(token)
    await expect(vault.settle(confirm, { planId: 'PLAN-1' }, exec)).rejects.toMatchObject({ code: 'OPENSLACK_CONFIRMATION_UNAVAILABLE' })
  })

  it('does not admit recursive dispatch or another run', async () => {
    for (const input of [{ ...args, workflowId: 'harness.task.dispatch' }, { ...args, input: { runId: 'OTHER' } }]) {
      const { vault } = setup()
      const raw = tool(preview())
      await expect(vault.preview(raw, input, exec)).rejects.toBeDefined()
      expect(raw.execute).not.toHaveBeenCalled()
    }
  })

  it('does not accept a model-provided token', async () => {
    const { vault } = setup()
    await vault.preview(tool(preview()), args, exec)
    const confirm = tool({})
    await expect(vault.settle(confirm, { planId: 'PLAN-1', confirmationToken: token }, exec)).rejects.toBeDefined()
    expect(confirm.execute).not.toHaveBeenCalled()
  })

  it('invalidates after disconnect, uncertain outcome, or disposal; upstream exceptions remain private', async () => {
    const { vault, assertCurrent } = setup()
    await vault.preview(tool(preview()), args, exec)
    const confirm = tool({})
    vi.mocked(confirm.execute).mockRejectedValue(new Error(token))
    await expect(vault.settle(confirm, { planId: 'PLAN-1' }, exec)).rejects.not.toThrow(token)
    await expect(vault.preview(tool(preview()), args, exec)).rejects.toBeDefined()
    const second = setup()
    await second.vault.preview(tool(preview()), args, exec)
    second.assertCurrent.mockRejectedValue(new Error('connection changed'))
    await expect(second.vault.settle(confirm, { planId: 'PLAN-1' }, exec)).rejects.toBeDefined()
    expect(assertCurrent).toHaveBeenCalled()
  })

  it('fails closed on expired, malformed, and non-preview responses', async () => {
    for (const value of [{}, { structuredContent: {} }, { structuredContent: { ...preview().structuredContent,
      data: { expiresAt: new Date(0).toISOString() } } }]) {
      const { vault } = setup()
      await expect(vault.preview(tool(value), args, exec)).rejects.toBeDefined()
    }
  })
})
