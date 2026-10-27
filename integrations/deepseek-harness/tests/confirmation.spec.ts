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

  it.each([
    { ...args, extra: true },
    { ...args, input: { ...args.input, runId: 'RUN-OTHER' } },
    { ...args, input: { ...args.input, completed: true } },
  ])('retains existing capabilities after locally rejected preview input %#', async input => {
    const { vault } = setup()
    await vault.preview(tool(preview()), args, exec)
    const raw = tool(preview())
    await expect(vault.preview(raw, input, exec)).rejects.toMatchObject({ code: 'OPENSLACK_CONFIRMATION_UNAVAILABLE' })
    expect(raw.execute).not.toHaveBeenCalled()
    const confirm = tool({ structuredContent: { status: 'completed' } })
    await expect(vault.settle(confirm, { planId: 'PLAN-1' }, exec)).resolves.toBeDefined()
    expect(confirm.execute).toHaveBeenCalledOnce()
  })

  it.each([{ planId: 'PLAN-1', confirmationToken: token }, { planId: 'UNKNOWN' }, { planId: 1 }])(
    'allows correction after a local settle rejection %#', async input => {
      const { vault } = setup()
      await vault.preview(tool(preview()), args, exec)
      const confirm = tool({ structuredContent: { status: 'completed' } })
      await expect(vault.settle(confirm, input, exec)).rejects.toMatchObject({ code: 'OPENSLACK_CONFIRMATION_UNAVAILABLE' })
      expect(confirm.execute).not.toHaveBeenCalled()
      await expect(vault.settle(confirm, { planId: 'PLAN-1' }, exec)).resolves.toBeDefined()
      expect(confirm.execute).toHaveBeenCalledOnce()
    },
  )

  it('expires one entry without invalidating a different pending plan', async () => {
    const { vault } = setup()
    const first = preview(), second = preview()
    first.structuredContent.data.expiresAt = new Date(Date.now() + 1_000).toISOString()
    second.structuredContent.planId = 'PLAN-2'
    await vault.preview(tool(first), args, exec)
    await vault.preview(tool(second), args, exec)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 2_000)
    try {
      const confirm = tool({ structuredContent: { status: 'completed' } })
      await expect(vault.settle(confirm, { planId: 'PLAN-1' }, exec)).rejects.toBeDefined()
      expect(confirm.execute).not.toHaveBeenCalled()
      await expect(vault.settle(confirm, { planId: 'PLAN-2' }, exec)).resolves.toBeDefined()
      expect(confirm.execute).toHaveBeenCalledOnce()
    } finally { clock.mockRestore() }
  })

  it('does not let a duplicate local settlement invalidate the single in-flight confirmation', async () => {
    const { vault } = setup()
    await vault.preview(tool(preview()), args, exec)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const confirm = tool({ structuredContent: { status: 'completed' } })
    vi.mocked(confirm.execute).mockImplementation(async () => {
      await gate
      return { structuredContent: { status: 'completed' } }
    })
    const first = vault.settle(confirm, { planId: 'PLAN-1' }, exec)
    await vi.waitFor(() => expect(confirm.execute).toHaveBeenCalledOnce())
    await expect(vault.settle(confirm, { planId: 'PLAN-1' }, exec)).rejects.toBeDefined()
    release()
    await expect(first).resolves.toBeDefined()
    expect(confirm.execute).toHaveBeenCalledOnce()
  })

  it('rechecks initiator admission after its authority await without invalidating the admitted query', async () => {
    const assertCurrent = vi.fn(async () => {})
    const vault = new ConfirmationVault({ taskId: 'TASK-1', mode: 'initiator', principalId: 'principal', generation: 'g1', assertCurrent })
    const dispatch = { workflowId: 'harness.task.dispatch', input: { taskId: 'TASK-1', requestId: 'request-1' } }
    await vault.preview(tool(preview()), dispatch, exec)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    assertCurrent.mockImplementationOnce(() => gate)
    const next = preview()
    next.structuredContent.planId = 'PLAN-2'
    const raw = tool(next)
    const second = vault.preview(raw, dispatch, exec)
    await vault.settle(tool({ structuredContent: { status: 'completed', data: { outcomes: [{
      data: { taskId: 'TASK-1', runId: 'RUN-FIRST', status: 'pending' },
    }] } } }), { planId: 'PLAN-1' }, exec)
    release()
    await expect(second).rejects.toMatchObject({ code: 'OPENSLACK_CONFIRMATION_UNAVAILABLE' })
    expect(raw.execute).not.toHaveBeenCalled()
    expect(vault.permitsQuery('RUN-FIRST')).toBe(true)
    expect(vault.permitsQuery('RUN-OTHER')).toBe(false)
  })

  it.each([false, true])('pins only the host admission observation for read-only query (canonical=%s)', async canonicalRunPresent => {
    const vault = new ConfirmationVault({ taskId: 'TASK-1', mode: 'initiator', principalId: 'principal', generation: 'g1', assertCurrent: async () => {} })
    const dispatch = { workflowId: 'harness.task.dispatch', input: { taskId: 'TASK-1', requestId: 'duplicate' } }
    await vault.preview(tool(preview()), dispatch, exec)
    const admission = { kind: 'admission', runId: 'RUN-EXISTING', requestHash: 'a'.repeat(64), canonicalRunPresent, disposition: 'in_progress' }
    const confirm = tool({ structuredContent: { status: 'blocked', planId: 'PLAN-1', data: { state: 'blocked', outcomes: [{
      actionId: 'harness.task.dispatch', status: 'blocked', data: { taskId: 'TASK-1', admission },
    }] } } })
    expect(vault.permitsQuery('RUN-EXISTING')).toBe(false)
    const result = await vault.settle(confirm, { planId: 'PLAN-1' }, exec)
    expect(JSON.stringify(result)).not.toContain(token)
    expect(vault.permitsQuery('RUN-EXISTING')).toBe(true)
    expect(vault.permitsQuery('RUN-MODEL-CHOSEN')).toBe(false)
    const next = tool(preview())
    await expect(vault.preview(next, dispatch, exec)).rejects.toBeDefined()
    expect(next.execute).not.toHaveBeenCalled()
    await expect(vault.settle(confirm, { planId: 'PLAN-1' }, exec)).rejects.toBeDefined()
    expect(confirm.execute).toHaveBeenCalledOnce()
    expect(vault.permitsQuery('RUN-EXISTING')).toBe(true)
  })

  it.each(['task', 'plan', 'action', 'state', 'route', 'hash', 'outcome'])(
    'does not promote a mismatched %s admission into a query target', async mismatch => {
      const vault = new ConfirmationVault({ taskId: 'TASK-1', mode: 'initiator', principalId: 'principal', generation: 'g1', assertCurrent: async () => {} })
      await vault.preview(tool(preview()), { workflowId: 'harness.task.dispatch', input: { taskId: 'TASK-1', requestId: 'duplicate' } }, exec)
      const value = { status: 'blocked', planId: 'PLAN-1', data: { state: 'blocked', outcomes: [{
        actionId: 'harness.task.dispatch', status: 'blocked', data: { taskId: 'TASK-1', admission: {
          kind: 'admission', runId: 'RUN-EXISTING', requestHash: 'a'.repeat(64), canonicalRunPresent: false, disposition: 'in_progress',
        } },
      }] } }
      if (mismatch === 'task') value.data.outcomes[0]!.data.taskId = 'TASK-OTHER'
      if (mismatch === 'plan') value.planId = 'PLAN-OTHER'
      if (mismatch === 'action') value.data.outcomes[0]!.actionId = 'harness.task.report'
      if (mismatch === 'state') value.data.state = 'executing'
      if (mismatch === 'route') value.data.outcomes[0]!.data.admission.kind = 'execution'
      if (mismatch === 'hash') value.data.outcomes[0]!.data.admission.requestHash = 'not-a-digest'
      if (mismatch === 'outcome') value.data.outcomes[0]!.status = 'succeeded'
      await expect(vault.settle(tool({ structuredContent: value }), { planId: 'PLAN-1' }, exec)).rejects.toBeDefined()
      expect(vault.permitsQuery('RUN-EXISTING')).toBe(false)
    },
  )

  it('rejects noncloneable input locally and retains the explicit cancel one-use path', async () => {
    const { vault } = setup()
    await vault.preview(tool(preview()), args, exec)
    const cancel = tool({ structuredContent: { status: 'cancelled' } })
    await expect(vault.settle(cancel, { planId: () => 'PLAN-1' }, exec, 'cancel')).rejects.toMatchObject({ code: 'OPENSLACK_CONFIRMATION_UNAVAILABLE' })
    expect(cancel.execute).not.toHaveBeenCalled()
    const result = await vault.settle(cancel, { planId: 'PLAN-1' }, exec, 'cancel')
    expect(JSON.stringify(result)).not.toContain(token)
    expect(cancel.execute).toHaveBeenCalledWith({ planId: 'PLAN-1', confirmationToken: token }, exec)
    await expect(vault.settle(cancel, { planId: 'PLAN-1' }, exec, 'cancel')).rejects.toBeDefined()
    expect(cancel.execute).toHaveBeenCalledOnce()
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
