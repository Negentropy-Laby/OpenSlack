/** Public SDK server composition for an external OpenSlack plugin; Harness itself remains unmodified. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Readable, Writable } from 'node:stream'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { HarnessSdkJsonRpcServer } from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import * as Connection from './connection.ts'
import { requireSupportedNode } from './process-observer.ts'
import type { ProcessExitReceipt } from './process-observer.ts'
import type {} from './capabilities.ts'
import { assertRuntimeBindings } from './runtime-bindings.ts'
import { shutdownDeadline, withinShutdown } from './shutdown.ts'
import { assertEligibilityRestriction, readEligibilityRestriction } from './scope-evidence.ts'
import type {} from '@deepseek-ai/dsh-llm'

export const name = 'openslack-sdk-host'
export const inject = ['agents', 'workingDirectory']
export interface Config {
  generation: string
  runtimeEntries: string
  startEligibility: string
  /** Programmatic test seam, like input/output/exit; never serializable deployment input. */
  resolveRuntime?: (specifier: string) => string
  mcp?: Connection.Config | null
  input?: Readable
  output?: Writable
  exit?: (code: number) => void
}
export const Config: z<Config> = z.object({ generation: z.string().required(), runtimeEntries: z.string().required(),
  startEligibility: z.string().required(), mcp: z.union([z.const(null), Connection.Config]).default(null) })

export async function apply(ctx: Context, config: Config): Promise<void> {
  requireSupportedNode()
  const startEligibility = readEligibilityRestriction(JSON.parse(config.startEligibility))
  assertRuntimeBindings(config.runtimeEntries, config.resolveRuntime ?? import.meta.resolve)
  if (!config.generation) throw new Error('SDK host requires the fixed connection generation')
  if (config.mcp) await ctx.plugin(Connection, config.mcp)
  const transport = new JsonRpcLineTransport(config.input ?? process.stdin, config.output ?? process.stdout)
  const server = new HarnessSdkJsonRpcServer(ctx, transport, { maxTokensAsSuccess: false })
  const exit = config.exit ?? ((code: number) => { process.exit(code) })
  let closing = false
  // Prepared calls reach this public waterfall after Agent preparation awaits.
  // Append without replacing/mutating the frozen request; check again when the
  // lazy stream is actually iterated, not only when its header is constructed.
  ctx.on('llm/stream', (_options, next) => {
    const current = () => {
      if (closing) throw new Error('SDK host is closing; no execution is permitted')
      assertEligibilityRestriction(startEligibility)
    }
    current()
    return (async function* () { current(); yield* next() })()
  })
  let prepared: Promise<{ resources: ProcessExitReceipt[] }> | undefined
  let exitTask: Promise<void> | undefined
  let closeDeadline: number | undefined
  ctx.provide('sdkSessionActivation', { ready: true })
  ctx.on('openslack/is-closing', () => closing)
  ctx.on('openslack/host-request', (method, params, signal) => {
    if (closing || !['openslack/tool-authorize', 'openslack/tool-evidence-result'].includes(method) || signal.aborted) return Promise.reject(new Error('SDK host authorization unavailable'))
    return transport.request(method, structuredClone(params), signal)
  })
  const prepare = (deadlineAt?: number) => prepared ??= (async () => {
    closeDeadline = shutdownDeadline(deadlineAt)
    closing = true
    ctx.emit('openslack/closing')
    await withinShutdown(closeDeadline, () => server.shutdown())
    const resources: ProcessExitReceipt[] = []
    const connection = ctx.get('openslackConnection')
    if (config.mcp && !connection) throw new Error('Required OpenSlack MCP owner is missing')
    if (connection) resources.push(await withinShutdown(closeDeadline, () => connection.stop(closeDeadline)))
    return { resources }
  })()
  const finishExit = () => exitTask ??= (async () => {
    try {
      await prepared
      await withinShutdown(closeDeadline!, () => transport.flush())
      await withinShutdown(closeDeadline!, () => ctx.root.fiber.dispose())
      exit(0)
    } catch { exit(1) }
  })()
  transport.onRequest(async (method, params) => {
    if (method === 'openslack/prepare-shutdown') {
      if (params?.generation !== config.generation || Object.keys(params).some(key => !['generation', 'deadlineAt'].includes(key)) ||
        (params.deadlineAt !== undefined && typeof params.deadlineAt !== 'number')) {
        throw new Error('Unrelated SDK shutdown request')
      }
      return { generation: config.generation, ...await prepare(params.deadlineAt as number | undefined) }
    }
    if (method === 'shutdown') {
      await prepare()
      const result = await server.handleRequest(method, params)
      setImmediate(() => { void finishExit() })
      return result
    }
    if (closing) throw new Error('SDK host is closing; no execution is permitted')
    // Waiting on accepted work is observational. Every new standard SDK action
    // is constrained again after client-side create-session/initialize awaits.
    if (method !== 'session/wait') assertEligibilityRestriction(startEligibility)
    if (method === 'initialize') await ctx.get('loader')?.await()
    if (method !== 'session/wait') assertEligibilityRestriction(startEligibility)
    return server.handleRequest(method, params)
  })
  ctx.effect(() => {
    transport.start()
    return async () => { await prepare(); transport.close() }
  })
}
