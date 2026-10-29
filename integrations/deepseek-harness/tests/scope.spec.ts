import { mkdtemp, readFile, rm, writeFile, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as Scope from '../src/index.ts'
import * as Initiator from '../src/initiator.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

class QuietAdapter extends LlmAdapter {
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('This fixture never requests a model')
  }
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: Array<{ name: string; args: object } | string>) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const item = this.script.shift()
    if (item === undefined) throw new Error('Fixture model script exhausted')
    if (typeof item === 'string') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: item }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: item } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } else {
      const id = ToolCallId(`script-${this.requests.length}`)
      const args = JSON.stringify(item.args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: item.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: item.name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
}

async function setup(beforeScope?: (ctx: Context) => void) {
  const root = await mkdtemp(join(tmpdir(), 'openslack-scope-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'fixture.txt'), 'before')
  await writeFile(join(root, 'unapproved.txt'), 'outside')
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ToolFs)
  beforeScope?.(ctx)
  ctx.llm.registerAdapter(['fixture'], new QuietAdapter())
  let current = true
  const live = vi.fn(async (): Promise<{ allowed: boolean; restriction: unknown }> => ({ allowed: current,
    restriction: { mode: 'not_applicable' } }))
  ctx.on('openslack/host-request', (method, _params, _signal) => method === 'openslack/tool-evidence-result' ? Promise.resolve({ recorded: true }) : live())
  const plugin = await ctx.plugin(Scope, {
    taskId: 'TASK-1', runId: 'RUN-TEST', principalId: 'fixture-only', generation: 'g1', root,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), readPaths: ['fixture.txt'], writePaths: ['fixture.txt'],
    systemText: 'fixture system text', callbacks: false,
  })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('openslack-RUN-TEST'), { provider: 'fixture', model: 'fixture' }, { cwd: root })
  let call = 0
  const invoke = (name: string, args: unknown) => executeToolFixture(ctx, {
    callId: ToolCallId(`scope-${++call}`), name, arguments: args, signal: new AbortController().signal, agent,
  })
  return { ctx, root, plugin, agent, invoke, live, revoke: () => { current = false } }
}

describe('native task scope through the real tool executor', () => {
  it('revalidates at the file capability and retains stale-write protection', async () => {
    const { root, invoke, live } = await setup()
    expect((await invoke('read', { file_path: 'fixture.txt' })).isError).toBe(false)
    expect((await invoke('write', { file_path: 'fixture.txt', content: 'after' })).isError).toBe(false)
    expect(await readFile(join(root, 'fixture.txt'), 'utf8')).toBe('after')
    expect(live.mock.calls.length).toBeGreaterThanOrEqual(3)
    await writeFile(join(root, 'fixture.txt'), 'external drift')
    expect((await invoke('edit', { file_path: 'fixture.txt', old_string: 'after', new_string: 'bad' })).isError).toBe(true)
    expect(await readFile(join(root, 'fixture.txt'), 'utf8')).toBe('external drift')
  })

  it('blocks writes after live revocation without removing prior approved bytes', async () => {
    const { root, invoke, revoke } = await setup()
    await invoke('read', { file_path: 'fixture.txt' })
    await invoke('write', { file_path: 'fixture.txt', content: 'approved result' })
    revoke()
    expect((await invoke('write', { file_path: 'fixture.txt', content: 'unapproved result' })).isError).toBe(true)
    expect(await readFile(join(root, 'fixture.txt'), 'utf8')).toBe('approved result')
  })

  it.each(['write', 'edit'] as const)('rejects %s when the required lease expires while the existing intent policy awaits', async tool => {
    let now = Date.now()
    const expiry = now + 30_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    onTestFinished(() => clock.mockRestore())
    let capturedIntent: unknown
    const { root, invoke, live } = await setup(ctx => {
      // Scope prepends its guard after this middleware. The next() below still
      // obtains the real observation policy's intent, rather than a replacement.
      const delay = async <T>(next: () => T | Promise<T>): Promise<T> => {
        const intent = await next()
        capturedIntent = intent
        await Promise.resolve()
        now = expiry
        return intent
      }
      if (tool === 'write') ctx.on('fs/write-intent', (_target, _actor, next) => delay(next), true)
      else ctx.on('fs/edit-intent', (_target, _actor, next) => delay(next), true)
    })
    expect((await invoke('read', { file_path: 'fixture.txt' })).isError).toBe(false)
    live.mockImplementation(async () => ({ allowed: true, restriction: { mode: 'required', expiresAt: expiry } }))
    const args = tool === 'write' ? { file_path: 'fixture.txt', content: 'must not write' }
      : { file_path: 'fixture.txt', old_string: 'before', new_string: 'must not edit' }
    const result = await invoke(tool, args)
    expect(capturedIntent).toBeDefined()
    expect(capturedIntent).toMatchObject(tool === 'write' ? { kind: 'replaceIfVersion' } : {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toMatch(/lease expired|eligibility restriction/)
    expect(await readFile(join(root, 'fixture.txt'), 'utf8')).toBe('before')
  })

  it('accepts an explicit current required lease but rejects a missing private host restriction', async () => {
    const { root, invoke, live } = await setup()
    live.mockImplementation(async () => ({ allowed: true, restriction: { mode: 'required', expiresAt: Date.now() + 30_000 } }))
    expect((await invoke('read', { file_path: 'fixture.txt' })).isError).toBe(false)
    expect((await invoke('write', { file_path: 'fixture.txt', content: 'approved' })).isError).toBe(false)
    live.mockImplementation(async () => ({ allowed: true, restriction: undefined }))
    expect((await invoke('write', { file_path: 'fixture.txt', content: 'must not write' })).isError).toBe(true)
    expect(await readFile(join(root, 'fixture.txt'), 'utf8')).toBe('approved')
  })

  it('rejects out-of-scope files, traversal and links before effects', async () => {
    const { root, invoke } = await setup()
    await symlink(join(root, 'unapproved.txt'), join(root, 'alias.txt'))
    for (const path of ['unapproved.txt', '../escape.txt', 'alias.txt']) {
      expect((await invoke('write', { file_path: path, content: 'bad' })).isError).toBe(true)
    }
    expect(await readFile(join(root, 'unapproved.txt'), 'utf8')).toBe('outside')
  })

  it('rechecks links after awaited live file authorization without writing the replacement target', async () => {
    const { root, invoke, live } = await setup()
    await invoke('read', { file_path: 'fixture.txt' })
    live.mockImplementationOnce(async () => ({ allowed: true, restriction: { mode: 'not_applicable' } }))
      .mockImplementationOnce(async () => {
        await unlink(join(root, 'fixture.txt'))
        await symlink(join(root, 'unapproved.txt'), join(root, 'fixture.txt'))
        return { allowed: true, restriction: { mode: 'not_applicable' } }
      })
    expect((await invoke('write', { file_path: 'fixture.txt', content: 'bad' })).isError).toBe(true)
    expect(await readFile(join(root, 'unapproved.txt'), 'utf8')).toBe('outside')
  })

  it('does not expose Shell or permit a foreign scoped tool; disposal removes registrations', async () => {
    const { ctx, agent, invoke, plugin } = await setup()
    const effect = vi.fn(async () => ({}))
    const release = agent.ctx.tools.register({ name: 'foreign', description: '', parameters: {},
      output: { schema: {}, render: () => [] }, execute: effect })
    expect((await invoke('foreign', {})).isError).toBe(true)
    expect(effect).not.toHaveBeenCalled()
    expect(ctx.tools.schemas(agent).map(tool => tool.name).sort()).toEqual(['edit', 'foreign', 'read', 'write'])
    expect((await invoke('bash', { command: 'echo forbidden' })).isError).toBe(true)
    release()
    await plugin.dispose()
    expect(ctx.tools.get('read', agent)).toBe(ctx.tools.get('read'))
  })

  it('rejects a read path replaced during live authorization without returning foreign bytes', async () => {
    const { root, invoke, live, agent } = await setup()
    live.mockImplementationOnce(async () => {
      await unlink(join(root, 'fixture.txt'))
      await symlink(join(root, 'unapproved.txt'), join(root, 'fixture.txt'))
      return { allowed: true, restriction: { mode: 'not_applicable' } }
    })
    const result = await invoke('read', { file_path: 'fixture.txt' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('outside')
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain('outside')
    expect(await readFile(join(root, 'unapproved.txt'), 'utf8')).toBe('outside')
  })
})

describe('bearer-free local MCP projection', () => {
  it('uses original MCP definitions but logs only a planId confirmation input and sanitized output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openslack-vault-scope-'))
    onTestFinished(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'fixture.txt'), 'text')
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(FsPolicy)
    await ctx.plugin(ToolFs)
    const model = new ScriptedAdapter([
      { name: 'mcp__openslack__openslack_preview_workflow', args: { workflowId: 'harness.task.report',
        input: { runId: 'RUN-TEST', reportId: 'r1', summary: 'progress', evidenceRefs: [] } } },
      { name: 'mcp__openslack__openslack_confirm_plan', args: { planId: 'PLAN-TEST' } },
      'fixture complete',
    ])
    ctx.llm.registerAdapter(['fixture'], model)
    let connected = true
    ctx.on('openslack/connection-state', name => name === 'openslack' ? connected : undefined)
    ctx.on('openslack/host-request', async method => method === 'openslack/tool-evidence-result' ? { recorded: true }
      : { allowed: true, restriction: { mode: 'not_applicable' } })
    const bearer = 'TOKEN_SENTINEL_DO_NOT_PERSIST_01234567890123456789'
    const upstream = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'openslack_preview_workflow') return { status: 'needs_confirmation', planId: 'PLAN-TEST',
        confirmationToken: bearer, data: { expiresAt: new Date(Date.now() + 60_000).toISOString() } }
      if (name === 'openslack_confirm_plan') expect(args).toEqual({ planId: 'PLAN-TEST', confirmationToken: bearer })
      return { status: 'completed', data: {} }
    })
    const privateTools = new Map<string, ToolDefinition>()
    ctx.provide('openslackConnection', { get connected() { return connected }, tool: name => privateTools.get(name),
      stop: async () => ({ pid: 1, code: 0, signal: null, terminationRequested: false }) })
    for (const name of ['openslack_get_activity', 'openslack_preview_workflow', 'openslack_confirm_plan', 'openslack_cancel_plan']) {
      privateTools.set(`mcp__openslack__${name}`, createMcpToolDefinition(ctx, {
        name: `mcp__openslack__${name}`, rawName: name, description: name,
        inputSchema: { type: 'object', additionalProperties: true },
        call: async (args) => { const result = await upstream(name, args); return {
          content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result,
        } },
      }))
    }
    await ctx.plugin(Scope, { taskId: 'TASK-1', runId: 'RUN-TEST', principalId: 'fixture-only', generation: 'g1', root,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), readPaths: ['fixture.txt'], writePaths: ['fixture.txt'],
      systemText: '', callbacks: true })
    expect(ctx.tools.get('mcp__openslack__openslack_confirm_plan')).toBeUndefined()
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('openslack-RUN-TEST'), { provider: 'fixture', model: 'fixture' }, { cwd: root })
    let counter = 0
    const invoke = (name: string, args: unknown) => executeToolFixture(ctx, {
      callId: ToolCallId(`mcp-${++counter}`), name: `mcp__openslack__${name}`, arguments: args,
      signal: new AbortController().signal, agent,
    })
    expect(ctx.tools.get('mcp__openslack__openslack_confirm_plan', agent)?.parameters).toMatchObject({ required: ['planId'] })
    expect((await runFixtureTurn(ctx, { task: 'report current progress' })).output).toBe('fixture complete')
    expect(upstream.mock.calls.map(call => call[0])).toEqual(['openslack_preview_workflow', 'openslack_confirm_plan'])
    expect(model.requests).toHaveLength(3)
    expect(JSON.stringify(model.requests)).not.toContain(bearer)
    const events = agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'tool/call')).toHaveLength(2)
    expect(events.filter(event => event.type === 'tool/result')).toHaveLength(2)
    expect(JSON.stringify(events)).not.toContain(bearer)
    const calls = upstream.mock.calls.length
    connected = false
    ctx.emit('openslack/connection-lost', 'openslack')
    expect((await invoke('openslack_preview_workflow', { workflowId: 'harness.task.report', input: { runId: 'RUN-TEST' } })).isError).toBe(true)
    expect(upstream).toHaveBeenCalledTimes(calls)
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain(bearer)
  })
})

describe('separate initiation scope', () => {
  it('lets two initiators query one host route after slow publication without redispatching', async () => {
    let release!: () => void
    const publication = new Promise<void>(resolve => { release = resolve })
    onTestFinished(() => release())
    let dispatches = 0
    let visible = false
    const route = { kind: 'admission', runId: 'RUN-SHARED', requestHash: 'a'.repeat(64), canonicalRunPresent: false, disposition: 'in_progress' }
    const upstream = vi.fn(async (caller: string, name: string, args: Record<string, unknown>) => {
      if (name === 'openslack_preview_workflow') return { status: 'needs_confirmation', planId: `PLAN-${caller}`,
        confirmationToken: `INITIATOR_BEARER_${caller}_012345678901234567890123456789`, data: { expiresAt: new Date(Date.now() + 60_000).toISOString() } }
      if (name === 'openslack_confirm_plan') {
        expect(args.planId).toBe(`PLAN-${caller}`)
        if (!dispatches) {
          dispatches++
          await publication
          visible = true
          return { status: 'completed', data: { outcomes: [{ data: { taskId: 'TASK-1', runId: route.runId, status: 'pending' } }] } }
        }
        await new Promise(resolve => setTimeout(resolve, 1_100))
        return { status: 'blocked', planId: `PLAN-${caller}`, data: { state: 'blocked', outcomes: [{
          actionId: 'harness.task.dispatch', status: 'blocked', data: { taskId: 'TASK-1', admission: route },
        }] } }
      }
      expect(args).toEqual({ objectKind: 'workflow', objectId: route.runId })
      return { status: 'completed', data: visible ? { execution: { taskId: 'TASK-1', runId: route.runId, status: 'completed', acceptance: 'verified' } } : {} }
    })
    const caller = async (id: string) => {
      const ctx = new Context()
      onTestFinished(() => ctx.fiber.dispose())
      await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
      ctx.llm.registerAdapter(['fixture'], new QuietAdapter())
      ctx.on('openslack/connection-state', server => server === 'openslack' ? true : undefined)
      const privateTools = new Map<string, ToolDefinition>()
      ctx.provide('openslackConnection', { connected: true, tool: name => privateTools.get(name),
        stop: async () => ({ pid: 1, code: 0, signal: null, terminationRequested: false }) })
      for (const name of ['openslack_get_activity', 'openslack_preview_workflow', 'openslack_confirm_plan', 'openslack_cancel_plan']) {
        privateTools.set(`mcp__openslack__${name}`, createMcpToolDefinition(ctx, {
          name: `mcp__openslack__${name}`, rawName: name, description: name, inputSchema: { type: 'object' },
          call: async args => { const data = await upstream(id, name, args); return {
            content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data,
          } },
        }))
      }
      await ctx.plugin(Initiator, { taskId: 'TASK-1', principalId: 'fixture-only', generation: 'g1', sessionId: id,
        expiresAt: new Date(Date.now() + 60_000).toISOString() })
      const harness = await mountAgentLoopTestHarness(ctx)
      const agent = await harness.create(SessionId(id), { provider: 'fixture', model: 'fixture' })
      let call = 0
      return { agent, invoke: (name: string, args: object) => executeToolFixture(ctx, {
        callId: ToolCallId(`${id}-${++call}`), name: `mcp__openslack__openslack_${name}`, arguments: args,
        signal: new AbortController().signal, agent,
      }) }
    }
    const first = await caller('first'), second = await caller('second')
    for (const instance of [first, second]) {
      expect((await instance.invoke('preview_workflow', { workflowId: 'harness.task.dispatch', input: { taskId: 'TASK-1', requestId: 'different-requests' } })).isError).toBe(false)
    }
    const admitted = first.invoke('confirm_plan', { planId: 'PLAN-first' })
    await vi.waitFor(() => expect(dispatches).toBe(1))
    const observed = await second.invoke('confirm_plan', { planId: 'PLAN-second' })
    expect(JSON.stringify(observed)).toContain('in_progress')
    expect((await second.invoke('get_activity', { objectKind: 'workflow', objectId: route.runId })).isError).toBe(false)
    const before = upstream.mock.calls.length
    expect((await second.invoke('preview_workflow', { workflowId: 'harness.task.dispatch', input: { taskId: 'TASK-1', requestId: 'must-not-retry' } })).isError).toBe(true)
    expect(upstream).toHaveBeenCalledTimes(before)
    release()
    expect((await admitted).isError).toBe(false)
    for (const instance of [first, second]) {
      const query = await instance.invoke('get_activity', { objectKind: 'workflow', objectId: route.runId })
      expect(query.isError).toBe(false)
      expect(JSON.stringify(query)).toContain('verified')
      expect((await instance.invoke('get_activity', { objectKind: 'workflow', objectId: 'RUN-FORGED' })).isError).toBe(true)
      expect(JSON.stringify(instance.agent.session.snapshotEvents())).not.toContain('INITIATOR_BEARER_')
    }
    expect(dispatches).toBe(1)
  })

  it('hides the bearer, rejects recursive/foreign intents, and queries only the admitted run', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    ctx.llm.registerAdapter(['fixture'], new QuietAdapter())
    ctx.on('openslack/connection-state', server => server === 'openslack' ? true : undefined)
    const bearer = 'INITIATOR_BEARER_DO_NOT_PERSIST_01234567890123456789'
    const upstream = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'openslack_preview_workflow') return { status: 'needs_confirmation', planId: 'PLAN-INITIATOR',
        confirmationToken: bearer, data: { expiresAt: new Date(Date.now() + 60_000).toISOString() } }
      if (name === 'openslack_confirm_plan') {
        expect(args).toEqual({ planId: 'PLAN-INITIATOR', confirmationToken: bearer })
        return { status: 'completed', data: { outcomes: [{ data: { taskId: 'TASK-1', runId: 'RUN-ADMITTED', status: 'pending' } }] } }
      }
      return { status: 'completed', data: { execution: { runId: 'RUN-ADMITTED', status: 'pending', acceptance: 'pending' } } }
    })
    const privateTools = new Map<string, ToolDefinition>()
    ctx.provide('openslackConnection', { connected: true, tool: name => privateTools.get(name),
      stop: async () => ({ pid: 1, code: 0, signal: null, terminationRequested: false }) })
    for (const name of ['openslack_get_activity', 'openslack_preview_workflow', 'openslack_confirm_plan', 'openslack_cancel_plan']) {
      privateTools.set(`mcp__openslack__${name}`, createMcpToolDefinition(ctx, {
        name: `mcp__openslack__${name}`, rawName: name, description: name, inputSchema: { type: 'object' },
        call: async (args) => { const data = await upstream(name, args); return {
          content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data,
        } },
      }))
    }
    await ctx.plugin(Initiator, { taskId: 'TASK-1', principalId: 'fixture-only', generation: 'g1', sessionId: 'caller',
      expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(SessionId('caller'), { provider: 'fixture', model: 'fixture' })
    let call = 0
    const invoke = (name: string, args: unknown) => executeToolFixture(ctx, {
      callId: ToolCallId(`initiator-${++call}`), name: `mcp__openslack__openslack_${name}`, arguments: args,
      signal: new AbortController().signal, agent,
    })
    expect((await invoke('get_activity', { objectKind: 'workflow', objectId: 'RUN-ADMITTED' })).isError).toBe(true)
    expect(upstream).not.toHaveBeenCalled()
    const preview = await invoke('preview_workflow', { workflowId: 'harness.task.dispatch', input: { taskId: 'TASK-1', requestId: 'first' } })
    expect(preview.isError).toBe(false)
    expect(JSON.stringify(preview)).not.toContain(bearer)
    expect((await invoke('confirm_plan', { planId: 'PLAN-INITIATOR' })).isError).toBe(false)
    expect((await invoke('get_activity', { objectKind: 'workflow', objectId: 'RUN-ADMITTED' })).isError).toBe(false)
    expect((await invoke('get_activity', { objectKind: 'workflow', objectId: 'RUN-OTHER' })).isError).toBe(true)
    expect((await invoke('preview_workflow', { workflowId: 'harness.task.report', input: {} })).isError).toBe(true)
    expect(JSON.stringify(agent.session.snapshotEvents())).not.toContain(bearer)
    expect(ctx.tools.schemas(agent).map(tool => tool.name)).not.toContain('write')
  })
})
