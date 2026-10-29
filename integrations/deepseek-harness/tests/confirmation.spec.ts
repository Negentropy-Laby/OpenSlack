import { describe, expect, it, vi } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ConfirmationVault } from '../src/confirmation-vault.ts'
import { projectCallbackTool } from '../src/callback-tools.ts'
import { Ajv2020 } from 'ajv/dist/2020.js'

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
  const vault = new ConfirmationVault({ mode: 'worker', taskId: 'TASK-1', runId: 'RUN-TEST', principalId: 'principal', generation: 'g1', assertCurrent })
  return { vault, assertCurrent }
}

describe('per-agent confirmation vault', () => {
  it.each(['worker', 'initiator'] as const)('advertises only the trusted %s preview and rejects upstream-only optional fields', async mode => {
    const vault = mode === 'worker' ? setup().vault : new ConfirmationVault({ mode, taskId: 'TASK-1',
      principalId: 'principal', generation: 'g1', assertCurrent: async () => {} })
    const input = mode === 'worker' ? args : { workflowId: 'harness.task.dispatch', input: { taskId: 'TASK-1', requestId: 'request' } }
    const raw = { ...tool(preview()), parameters: { type: 'object' as const,
      properties: { workflowId: { type: 'string' as const }, input: { type: 'object' as const }, repository: { type: 'string' as const } },
      required: ['workflowId', 'input'], additionalProperties: false } }
    const original = JSON.stringify(raw.parameters)
    const projected = projectCallbackTool({ operation: 'preview', definition: raw, vault,
      current: async () => {}, permitsQuery: runId => vault.permitsQuery(runId) })
    const validate = new Ajv2020({ strict: true }).compile(projected.parameters)
    expect(validate(input), JSON.stringify(validate.errors)).toBe(true)
    expect(validate({ ...input, repository: 'openslack/openslack' })).toBe(false)
    expect(validate({ ...input, input: { ...input.input, completed: true } })).toBe(false)
    expect(validate(mode === 'worker' ? { ...input, workflowId: 'harness.task.dispatch' }
      : { ...input, input: { taskId: 'TASK-OTHER', requestId: 'request' } })).toBe(false)
    await expect(projected.execute({ ...input, repository: 'openslack/openslack' }, exec)).rejects.toBeDefined()
    expect(raw.execute).not.toHaveBeenCalled()
    const result = await projected.execute(input, exec)
    expect(raw.execute).toHaveBeenCalledOnce()
    expect(raw.execute).toHaveBeenCalledWith(input, exec)
    expect(JSON.stringify(result)).not.toContain(token)
    expect(JSON.stringify(raw.parameters)).toBe(original)
    expect(JSON.stringify(projected.parameters)).not.toContain('confirmationToken')
  })

  it.each(['worker', 'initiator'] as const)('advertises the bounded %s query without converting schema data into run authority', async mode => {
    const vault = mode === 'worker' ? setup().vault : new ConfirmationVault({ mode, taskId: 'TASK-1',
      principalId: 'principal', generation: 'g1', assertCurrent: async () => {} })
    const raw = { ...tool({ structuredContent: { status: 'completed' }, content: [] }), parameters: { type: 'object' as const,
      properties: { objectKind: { type: 'string' as const }, objectId: { type: 'string' as const },
        sinceHours: { type: 'integer' as const }, limit: { type: 'integer' as const } } } }
    const projected = projectCallbackTool({ operation: 'query', definition: raw, vault,
      current: async () => {}, permitsQuery: runId => vault.permitsQuery(runId) })
    const validate = new Ajv2020({ strict: true }).compile(projected.parameters)
    const input = { objectKind: 'workflow', objectId: mode === 'worker' ? 'RUN-TEST' : 'RUN-OWN', limit: 100 }
    expect(validate(input), JSON.stringify(validate.errors)).toBe(true)
    for (const invalid of [{ ...input, sinceHours: 24 }, { objectKind: 'workflow' }, { ...input, objectKind: 'plan' },
      { ...input, limit: 101 }, { ...input, limit: 0 }, { ...input, limit: 1.5 }]) expect(validate(invalid)).toBe(false)
    await expect(projected.execute({ ...input, sinceHours: 24 }, exec)).rejects.toThrow('Query only this bound')
    expect(raw.execute).not.toHaveBeenCalled()
    if (mode === 'initiator') {
      await expect(projected.execute(input, exec)).rejects.toThrow('Query only this bound')
      expect(raw.execute).not.toHaveBeenCalled()
      await vault.preview(tool(preview()), { workflowId: 'harness.task.dispatch', input: { taskId: 'TASK-1', requestId: 'request' } }, exec)
      await vault.settle(tool({ structuredContent: { status: 'completed', data: { outcomes: [{
        data: { taskId: 'TASK-1', runId: 'RUN-OWN', status: 'pending' },
      }] } } }), { planId: 'PLAN-1' }, exec)
    }
    await projected.execute(input, exec)
    expect(raw.execute).toHaveBeenCalledOnce()
    await expect(projected.execute({ ...input, objectId: 'RUN-OTHER' }, exec)).rejects.toThrow('Query only this bound')
    expect(raw.execute).toHaveBeenCalledOnce()
  })

  it.each(['valid', 'task', 'plan', 'action', 'state', 'outcome', 'blocker', 'settlement', 'reconciliation', 'kind'])(
    'learns only the exact durable-succeeded settlement-unconfirmed query route: %s', async variant => {
      const vault = new ConfirmationVault({ mode: 'initiator', taskId: 'TASK-1', principalId: 'principal', generation: 'g1', assertCurrent: async () => {} })
      const dispatch = { workflowId: 'harness.task.dispatch', input: { taskId: 'TASK-1', requestId: 'request' } }
      await vault.preview(tool(preview()), dispatch, exec)
      const result = { status: 'blocked', planId: 'PLAN-1', governance: { blocker: 'GOVERNED_MUTATION_SETTLEMENT_UNCONFIRMED' }, data: {
        kind: 'workflow.start', state: 'succeeded', settlement: 'unconfirmed', requiresReconciliation: true,
        outcomes: [{ actionId: 'harness.task.dispatch', status: 'succeeded', data: { taskId: 'TASK-1', runId: 'RUN-DURABLE', status: 'failed' } }],
      } }
      if (variant === 'task') result.data.outcomes[0]!.data.taskId = 'TASK-OTHER'
      if (variant === 'plan') result.planId = 'PLAN-OTHER'
      if (variant === 'action') result.data.outcomes[0]!.actionId = 'harness.task.report'
      if (variant === 'state') result.data.state = 'executing'
      if (variant === 'outcome') result.data.outcomes[0]!.status = 'blocked'
      if (variant === 'blocker') result.governance.blocker = 'OTHER_BLOCKER'
      if (variant === 'settlement') result.data.settlement = 'different'
      if (variant === 'reconciliation') result.data.requiresReconciliation = false
      if (variant === 'kind') result.data.kind = 'scenario.instantiate'
      const confirm = tool({ structuredContent: result, content: [] })
      if (variant === 'valid') {
        await expect(vault.settle(confirm, { planId: 'PLAN-1' }, exec)).resolves.toBeDefined()
        expect(vault.permitsQuery('RUN-DURABLE')).toBe(true)
        expect(vault.permitsQuery('RUN-OTHER')).toBe(false)
        await expect(vault.preview(tool(preview()), dispatch, exec)).rejects.toBeDefined()
        await expect(vault.settle(confirm, { planId: 'PLAN-1' }, exec)).rejects.toBeDefined()
        expect(confirm.execute).toHaveBeenCalledOnce()
      } else {
        await expect(vault.settle(confirm, { planId: 'PLAN-1' }, exec)).rejects.toBeDefined()
        expect(vault.permitsQuery('RUN-DURABLE')).toBe(false)
      }
    })
  it.each([
    { taskId: 'TASK-1', principalId: 'principal', generation: 'g1', assertCurrent: async () => {} },
    { mode: 'worker', taskId: 'TASK-1', principalId: 'principal', generation: 'g1', assertCurrent: async () => {} },
    { mode: 'initiator', runId: 'RUN-TEST', taskId: 'TASK-1', principalId: 'principal', generation: 'g1', assertCurrent: async () => {} },
  ])('rejects an absent/confused trusted role before exposing any confirmation capability %#', scope => {
    expect(() => new ConfirmationVault(scope as never)).toThrow('Confirmation is unavailable');
  })

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
