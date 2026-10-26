/** Task-local native tools and bearer-free OpenSlack callbacks. @module */
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ConfirmationVault } from './confirmation-vault.ts'
import type {} from './capabilities.ts'

/** Loader identity. */
export const name = 'openslack-peer'
/** Required native services. */
export const inject = ['tools', 'fs', 'systemPrompt', 'agents']

/** Host-created task scope. These fields are deployment input, never MCP input. */
export interface Config {
  /** Existing approved OpenSlack task, fixed before the Agent starts. */
  taskId: string
  /** Canonical execution run owned by that task. */
  runId: string
  /** Approved runtime principal, distinct from the task execution run. */
  principalId: string
  /** Host-owned input and connection generation; changes invalidate confirmation capabilities. */
  generation: string
  /** Absolute native isolated worktree root; links and external file targets are rejected. */
  root: string
  /** Absolute ISO task deadline, shared by every tool operation. */
  expiresAt: string
  /** Exact nonsecret relative file paths readable by this task. */
  readPaths: string[]
  /** Exact nonsecret relative file paths writable by this task. */
  writePaths: string[]
  /** Host-authored current-task context included in the recorded system prompt. */
  systemText: string
  /** False rejects all MCP access, including callbacks, before the initial request. */
  callbacks: boolean
}

/** No permission defaults: the host must provide the complete intersection. */
export const Config: z<Config> = z.object({
  taskId: z.string().required(), runId: z.string().required(), principalId: z.string().required(),
  generation: z.string().required(), root: z.string().required(), expiresAt: z.string().required(),
  readPaths: z.array(z.string()).required(), writePaths: z.array(z.string()).required(),
  systemText: z.string().required(), callbacks: z.boolean().required(),
})

const callbackNames = {
  query: 'mcp__openslack__openslack_get_activity',
  preview: 'mcp__openslack__openslack_preview_workflow',
  confirm: 'mcp__openslack__openslack_confirm_plan',
  cancel: 'mcp__openslack__openslack_cancel_plan',
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Install per-agent restrictions before queued work; unload removes both agent and plugin effects. */
export function apply(ctx: Context, config: Config): void {
  const scope = structuredClone(config)
  const sameNativePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!scope.taskId || !scope.runId || !scope.principalId || !scope.generation ||
    !isAbsolute(scope.root) || lstatSync(scope.root).isSymbolicLink() || !sameNativePath(realpathSync(scope.root), resolve(scope.root)) ||
    !Number.isFinite(Date.parse(scope.expiresAt))) throw new Error('OpenSlack task scope is invalid')
  const expiresAt = Date.parse(scope.expiresAt)
  let closing = false
  const root = resolve(scope.root)
  const paths = [...scope.readPaths, ...scope.writePaths]
  if (paths.some(path => !path || isAbsolute(path) || path.includes('\\') ||
    path.split('/').some(part => !part || part === '.' || part === '..' ||
      part.startsWith('.git') || part.startsWith('.openslack') || part === '.dsh' ||
      /^(?:\.env(?:\..*)?|secrets|credentials)$/i.test(part)) || /\.(pem|key)$/i.test(path))) {
    throw new Error('OpenSlack file grants must name exact nonsecret relative files')
  }
  const checkCurrent = (): void => {
    if (closing || ctx.bail('openslack/is-closing')) throw new Error('OpenSlack task scope is closing')
    if (Date.now() >= expiresAt) throw new Error('OpenSlack task delegation expired; query the run')
    if (scope.callbacks && ctx.bail('openslack/connection-state', 'openslack') !== true) {
      throw new Error('OpenSlack MCP disconnected; preserve this run without replay')
    }
  }
  if (Date.now() >= expiresAt) throw new Error('OpenSlack task delegation expired')
  const sessionId = `openslack-${scope.runId}`
  const checkActor = (actor: object | undefined): void => {
    checkCurrent()
    if (!object(actor) || !object(actor.agent) || !object(actor.agent.session) ||
      actor.agent.session.id !== sessionId) throw new Error('OpenSlack task actor mismatch')
  }
  const checkPath = (absolute: string, write: boolean): void => {
    const local = relative(root, absolute).split(sep).join('/')
    const grants = write ? scope.writePaths : scope.readPaths
    if (!grants.includes(local)) throw new Error('File is outside the OpenSlack task grant')
    let path = root
    for (const part of local.split('/')) {
      path = resolve(path, part)
      try {
        const stat = lstatSync(path)
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) throw new Error('OpenSlack task files cannot traverse links')
      } catch (error) {
        if (!object(error) || error.code !== 'ENOENT') throw error
      }
    }
  }
  const authorize = async (toolName: string, input: unknown, actor: object | undefined): Promise<void> => {
    checkActor(actor)
    if (!object(actor) || !(actor.signal instanceof AbortSignal)) throw new Error('Missing task cancellation')
    const outcome = await ctx.bail('openslack/host-request', 'openslack/tool-authorize', {
      taskId: scope.taskId, runId: scope.runId, principalId: scope.principalId, toolName, input,
    }, actor.signal)
    checkActor(actor)
    if (!object(outcome) || outcome.allowed !== true) throw new Error('Live OpenSlack authorization is unavailable')
  }
  const targetCheck = async (target: FsTarget, actor: object | undefined): Promise<void> => {
    checkActor(actor)
    checkPath(ctx.fs.processPath(target), true)
    const toolName = object(actor) && actor.name === 'edit' ? 'Edit' : 'Write'
    await authorize(toolName, { file_path: ctx.fs.processPath(target) }, actor)
    checkPath(ctx.fs.processPath(target), true)
  }
  // Prepend the denial and delegate the actual stale-write intent to existing policy.
  ctx.on('fs/write-intent', async (target, actor, next) => { await targetCheck(target, actor); return next() }, true)
  ctx.on('fs/edit-intent', async (target, actor, next) => { await targetCheck(target, actor); return next() }, true)

  const disposers = new Set<() => void | Promise<void>>()
  const agents = new Set<Agent>()
  ctx.effect(() => async () => {
    closing = true
    for (const agent of agents) agent.cancel({ kind: 'hook', reason: 'OpenSlack task scope unloaded' })
    await Promise.all([...agents].map(agent => agent.whenIdle()))
    for (const dispose of disposers) await dispose()
    disposers.clear()
    agents.clear()
  })
  ctx.on('agent/created', ({ agent }) => {
    checkCurrent()
    if (agent.session.id !== sessionId) throw new Error('OpenSlack worker cannot create another Session or subagent')
    const allowed = new Map<string, ToolDefinition>()
    const raw = new Map<string, ToolDefinition>()
    const lookup = (toolName: string): ToolDefinition => {
      const definition = toolName.startsWith('mcp__openslack__')
        ? ctx.get('openslackConnection')?.tool(toolName) : ctx.tools.get(toolName)
      if (!definition) throw new Error(`Required OpenSlack tool is missing: ${toolName}`)
      raw.set(toolName, definition)
      return definition
    }
    const assertCurrent = (): Promise<void> => {
      checkCurrent()
      for (const [key, definition] of raw) {
        if ((key.startsWith('mcp__openslack__') ? ctx.get('openslackConnection')?.tool(key) : ctx.tools.get(key)) !== definition) throw new Error('OpenSlack MCP connection generation changed')
      }
      return Promise.resolve()
    }
    const vault = new ConfirmationVault({ taskId: scope.taskId, runId: scope.runId,
      principalId: scope.principalId, generation: scope.generation, assertCurrent })
    const dispose = agent.ctx.effect(() => {
      const releases: Array<() => void> = []
      releases.push(ctx.on('openslack/connection-lost', (server) => {
        if (server !== 'openslack') return
        vault.dispose()
        agent.cancel({ kind: 'hook', reason: 'OpenSlack MCP disconnected; preserve and reconcile without replay' })
      }))
      const mount = (definition: ToolDefinition): void => {
        allowed.set(definition.name, definition)
        releases.push(agent.ctx.tools.register(definition))
      }
      for (const toolName of ['read', ...(scope.writePaths.length ? ['write', 'edit'] : [])]) {
        const definition = lookup(toolName)
        mount({
          name: definition.name, description: definition.description, parameters: definition.parameters, output: definition.output,
          async execute(args: unknown, exec: ToolRunContext) {
            const input = structuredClone(args)
            checkActor(exec)
            if (!object(input) || typeof input.file_path !== 'string') throw new Error('Provide an allowed file_path')
            checkPath(resolve(root, input.file_path), toolName !== 'read')
            const target = await ctx.fs.resolve(input.file_path, { cwd: root, signal: exec.signal })
            checkActor(exec)
            checkPath(ctx.fs.processPath(target), toolName !== 'read')
            await authorize(toolName === 'read' ? 'Read' : toolName === 'write' ? 'Write' : 'Edit',
              { file_path: ctx.fs.processPath(target) }, exec)
            // Authorization is an await boundary: neither the requested path nor
            // its previously resolved target may have become a link meanwhile.
            checkPath(resolve(root, input.file_path), toolName !== 'read')
            checkPath(ctx.fs.processPath(target), toolName !== 'read')
            const result = await definition.execute(input, exec)
            checkActor(exec)
            checkPath(resolve(root, input.file_path), toolName !== 'read')
            if (toolName === 'read') {
              if (!object(result) || typeof result.path !== 'string') throw new Error('Native read omitted its resolved path')
              checkPath(result.path, false)
            }
            return result
          },
        })
      }
      if (scope.callbacks) {
        for (const operation of ['query', 'preview', 'confirm', 'cancel'] as const) {
          const definition = lookup(callbackNames[operation])
          mount({
            name: definition.name, description: definition.description,
            parameters: operation === 'confirm' || operation === 'cancel'
              ? { type: 'object', properties: { planId: { type: 'string' } }, required: ['planId'], additionalProperties: false }
              : definition.parameters,
            output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
            async execute(args: unknown, exec: ToolRunContext) {
              const input = structuredClone(args)
              checkActor(exec)
              await assertCurrent()
              if (operation === 'preview') return vault.preview(definition, input, exec)
              if (operation === 'confirm' || operation === 'cancel') return vault.settle(definition, input, exec, operation)
              if (!object(input) || input.objectKind !== 'workflow' || input.objectId !== scope.runId ||
                Object.keys(input).some(key => !['objectKind', 'objectId', 'limit'].includes(key))) {
                throw new Error('Only this OpenSlack run can be queried')
              }
              const result = await definition.execute(input, exec)
              await assertCurrent()
              return result
            },
          })
        }
      }
      releases.push(agent.ctx.tools.restrict({ allow: [] }))
      releases.push(agent.ctx.tools.guard((exec) => {
        checkCurrent()
        const definition = allowed.get(exec.name)
        return exec.agent !== agent || !definition || ctx.tools.get(exec.name, agent) !== definition
          ? 'Tool is outside this OpenSlack task' : undefined
      }))
      if (scope.systemText) releases.push(agent.ctx.systemPrompt.section({
        name: 'openslack-task', order: 5, text: scope.systemText, interpolate: false,
      }))
      return () => { vault.dispose(); for (const release of releases.reverse()) release() }
    })
    disposers.add(dispose)
    agents.add(agent)
  })
}
