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

export const name = 'openslack-sdk-host'
export const inject = ['agents', 'workingDirectory']
export interface Config {
  generation: string
  runtimeEntries: string
  /** Programmatic test seam, like input/output/exit; never serializable deployment input. */
  resolveRuntime?: (specifier: string) => string
  mcp?: Connection.Config | null
  input?: Readable
  output?: Writable
  exit?: (code: number) => void
}
export const Config: z<Config> = z.object({ generation: z.string().required(), runtimeEntries: z.string().required(), mcp: z.union([z.const(null), Connection.Config]).default(null) })

export async function apply(ctx: Context, config: Config): Promise<void> {
  requireSupportedNode()
  assertRuntimeBindings(config.runtimeEntries, config.resolveRuntime ?? import.meta.resolve)
  if (!config.generation) throw new Error('SDK host requires the fixed connection generation')
  if (config.mcp) await ctx.plugin(Connection, config.mcp)
  const transport = new JsonRpcLineTransport(config.input ?? process.stdin, config.output ?? process.stdout)
  const server = new HarnessSdkJsonRpcServer(ctx, transport, { maxTokensAsSuccess: false })
  const exit = config.exit ?? ((code: number) => { process.exit(code) })
  let closing = false
  let prepared: Promise<{ resources: ProcessExitReceipt[] }> | undefined
  let exitTask: Promise<void> | undefined
  ctx.provide('sdkSessionActivation', { ready: true })
  ctx.on('openslack/is-closing', () => closing)
  ctx.on('openslack/host-request', (method, params, signal) => {
    if (closing || method !== 'openslack/tool-authorize' || signal.aborted) return Promise.reject(new Error('SDK host authorization unavailable'))
    return transport.request(method, structuredClone(params), signal)
  })
  const prepare = () => prepared ??= (async () => {
    closing = true
    ctx.emit('openslack/closing')
    await server.shutdown()
    const resources: ProcessExitReceipt[] = []
    const connection = ctx.get('openslackConnection')
    if (config.mcp && !connection) throw new Error('Required OpenSlack MCP owner is missing')
    if (connection) resources.push(await connection.stop())
    return { resources }
  })()
  const finishExit = () => exitTask ??= (async () => {
    try {
      await prepared
      await transport.flush()
      await ctx.root.fiber.dispose()
      exit(0)
    } catch { exit(1) }
  })()
  transport.onRequest(async (method, params) => {
    if (method === 'openslack/prepare-shutdown') {
      if (params?.generation !== config.generation || Object.keys(params).some(key => key !== 'generation')) {
        throw new Error('Unrelated SDK shutdown request')
      }
      return { generation: config.generation, ...await prepare() }
    }
    if (method === 'shutdown') {
      await prepare()
      const result = await server.handleRequest(method, params)
      setImmediate(() => { void finishExit() })
      return result
    }
    if (closing) throw new Error('SDK host is closing; no execution is permitted')
    if (method === 'initialize') await ctx.get('loader')?.await()
    return server.handleRequest(method, params)
  })
  ctx.effect(() => {
    transport.start()
    return async () => { await prepare(); transport.close() }
  })
}
