/** Bearer-free task initiation for a dedicated Harness caller Session. Worker recursion rules remain separate. @module */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-mcp-client'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ConfirmationVault } from './confirmation-vault.ts'
import type {} from './capabilities.ts'

export const name = 'openslack-initiator'
export const inject = ['tools', 'agents']

/** The trusted caller binds a single approved task, principal, connection generation and Session. */
export interface Config {
  /** The one approved task this caller may dispatch. */
  taskId: string
  /** Approved OpenSlack runtime principal. */
  principalId: string
  /** Trusted connection generation; never a model-selected authorization value. */
  generation: string
  /** Dedicated caller Session; other Sessions and subagents are rejected. */
  sessionId: string
  /** Absolute ISO expiration for the initiation scope. */
  expiresAt: string
}
export const Config: z<Config> = z.object({ taskId: z.string().required(), principalId: z.string().required(),
  generation: z.string().required(), sessionId: z.string().required(), expiresAt: z.string().required() })

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Mount before the caller Agent starts. Only this task may be dispatched; queries require its returned run. */
export function apply(ctx: Context, config: Config): void {
  const scope = structuredClone(config)
  const expiresAt = Date.parse(scope.expiresAt)
  if (!scope.taskId || !scope.principalId || !scope.generation || !scope.sessionId || !Number.isFinite(expiresAt)) {
    throw new Error('Incomplete OpenSlack initiator scope')
  }
  let closing = false
  const current = (): void => {
    if (closing || ctx.bail('openslack/is-closing') || Date.now() >= expiresAt || ctx.bail('openslack/connection-state', 'openslack') !== true) {
      throw new Error('OpenSlack initiator unavailable; query or reconcile without redispatch')
    }
  }
  const agents = new Set<Agent>()
  const disposers = new Set<() => void | Promise<void>>()
  ctx.effect(() => async () => {
    closing = true
    for (const agent of agents) agent.cancel({ kind: 'hook', reason: 'OpenSlack initiator scope unloaded' })
    await Promise.all([...agents].map(agent => agent.whenIdle()))
    for (const dispose of disposers) await dispose()
    disposers.clear()
    agents.clear()
  })
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.id !== scope.sessionId) throw new Error('OpenSlack initiator cannot create another Session or subagent')
    current()
    const raw = new Map<string, ToolDefinition>()
    const allowed = new Map<string, ToolDefinition>()
    const vault = new ConfirmationVault({ taskId: scope.taskId, principalId: scope.principalId,
      generation: scope.generation, mode: 'initiator', assertCurrent: () => {
        current()
        for (const [name, definition] of raw) if (ctx.get('openslackConnection')?.tool(name) !== definition) throw new Error('OpenSlack connection generation changed')
        return Promise.resolve()
      } })
    const dispose = agent.ctx.effect(() => {
      const releases: Array<() => void> = []
      releases.push(ctx.on('openslack/connection-lost', (server) => {
        if (server !== 'openslack') return
        vault.dispose()
        agent.cancel({ kind: 'hook', reason: 'OpenSlack MCP disconnected; preserve and reconcile without replay' })
      }))
      for (const operation of ['get_activity', 'preview_workflow', 'confirm_plan', 'cancel_plan'] as const) {
        const name = `mcp__openslack__openslack_${operation}`
        const definition = ctx.get('openslackConnection')?.tool(name)
        if (!definition) throw new Error('Required native OpenSlack MCP tool is missing')
        raw.set(name, definition)
        const projected: ToolDefinition = { name, description: definition.description,
          parameters: ['confirm_plan', 'cancel_plan'].includes(operation)
            ? { type: 'object', properties: { planId: { type: 'string' } }, required: ['planId'], additionalProperties: false } : definition.parameters,
          output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          async execute(args, exec) {
            const input = structuredClone(args)
            current()
            if (exec.agent !== agent) throw new Error('OpenSlack initiator actor mismatch')
            if (operation === 'preview_workflow') return vault.preview(definition, input, exec)
            if (operation === 'confirm_plan' || operation === 'cancel_plan') {
              return vault.settle(definition, input, exec, operation === 'confirm_plan' ? 'confirm' : 'cancel')
            }
            if (!object(input) || input.objectKind !== 'workflow' || !vault.permitsQuery(input.objectId) ||
              Object.keys(input).some(key => !['objectKind', 'objectId', 'limit'].includes(key))) throw new Error('Query only the admitted OpenSlack task run')
            const result = await definition.execute(input, exec)
            current()
            return result
          },
        }
        allowed.set(name, projected)
        releases.push(agent.ctx.tools.register(projected))
      }
      releases.push(agent.ctx.tools.restrict({ allow: [] }))
      releases.push(agent.ctx.tools.guard((exec) => {
        current()
        const definition = allowed.get(exec.name)
        return exec.agent !== agent || !definition || ctx.tools.get(exec.name, agent) !== definition
          ? 'Tool is outside the approved OpenSlack initiation scope' : undefined
      }))
      return () => { vault.dispose(); for (const release of releases.reverse()) release() }
    })
    agents.add(agent)
    disposers.add(dispose)
  })
}
