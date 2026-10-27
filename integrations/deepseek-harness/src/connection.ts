/** A task-owned native MCP connection using public MCP and Harness tool adapters. No reconnect, global write registration or gateway. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { createMcpToolDefinition } from '@deepseek-ai/dsh-mcp-client'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { OpenSlackConnection } from './capabilities.ts'
import { isCleanExit, OwnedProcessObservation, requireSupportedNode } from './process-observer.ts'
import type { ProcessExitReceipt } from './process-observer.ts'
import { isAbsolute } from 'node:path'
import { statSync } from 'node:fs'
import { adoptShutdownDeadline, shutdownRemaining, withinShutdown } from './shutdown.ts'

export const name = 'openslack-native-connection'
export const inject = ['tools']
export interface Config {
  workspaceRoot: string
  cliModule: string
  mode: 'read-only' | 'task'
  principalRef?: string
  workerBinding?: string
  timeoutMs: number
}
export const Config: z<Config> = z.object({
  workspaceRoot: z.string().required(), cliModule: z.string().required(),
  mode: z.union(['read-only', 'task']).required(), principalRef: z.string(), workerBinding: z.string(),
  timeoutMs: z.number().min(1).required(),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  requireSupportedNode()
  if (ctx.get('openslackConnection') || !isAbsolute(config.workspaceRoot) || !isAbsolute(config.cliModule) ||
    !statSync(config.workspaceRoot).isDirectory() || !statSync(config.cliModule).isFile() ||
    !config.cliModule.endsWith('.js') || !Number.isSafeInteger(config.timeoutMs) ||
    (config.mode === 'task' && !config.principalRef) ||
    (config.workerBinding !== undefined && (!isAbsolute(config.workerBinding) || config.mode !== 'task'))) {
    throw new Error('OpenSlack connection requires one fixed native deployment')
  }
  const args = [config.cliModule, 'mcp', 'serve', '--stdio', '--profile', config.mode === 'task' ? 'agent-bound' : 'read-only',
    ...(config.mode === 'task' ? ['--principal-ref', config.principalRef!] : []),
    ...(config.mode === 'task' && !config.workerBinding ? ['--harness-task-host'] : []),
    ...(config.workerBinding ? ['--harness-worker-binding', config.workerBinding] : [])]
  const observed = new OwnedProcessObservation(process.execPath, args)
  const client = new Client({ name: 'openslack-external-harness', version: '0.2.0' })
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: config.workspaceRoot,
    env: { PATH: process.env.PATH ?? '', ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, stderr: 'pipe' })
  let ready = false
  let closing = false
  let lost = false
  let stopped: Promise<ProcessExitReceipt> | undefined
  const tools = new Map<string, ToolDefinition>()
  const invalidate = () => {
    if (!closing) lost = true
    ready = false
    ctx.emit('openslack/connection-lost', 'openslack')
  }
  client.onclose = invalidate
  client.onerror = invalidate
  const assertCurrent = () => {
    observed.assertCaptured(transport.pid)
    if (!ready || closing || lost) throw new Error('OpenSlack connection unavailable; preserve without replay')
  }
  const owner: OpenSlackConnection = {
    get connected() {
      try { assertCurrent(); return true } catch { return false }
    },
    tool: toolName => tools.get(toolName),
    stop(deadlineAt) {
      stopped ??= (async () => {
        const deadline = adoptShutdownDeadline(deadlineAt)
        closing = true
        invalidate()
        try {
          await withinShutdown(deadline, () => client.close())
          const receipt = await observed.waitForClose(shutdownRemaining(deadline))
          if (lost || !isCleanExit(receipt)) throw new Error('OpenSlack MCP did not confirm a clean owned stop')
          return receipt
        } finally {
          observed.dispose()
        }
      })()
      return stopped
    },
  }
  ctx.provide('openslackConnection', owner)
  ctx.on('openslack/connection-state', server => server === 'openslack' ? owner.connected : undefined)
  ctx.effect(() => async () => { await owner.stop() })
  try {
    // Never retain upstream stderr: JSON-RPC errors can contain bearer material.
    // The public stream exists before connect; drain it during initialize too.
    transport.stderr?.on('data', () => {})
    const startupDeadline = performance.now() + config.timeoutMs
    await withinShutdown(startupDeadline, () => client.connect(transport, { timeout: config.timeoutMs }))
    observed.assertCaptured(transport.pid)
    if (lost) throw new Error('OpenSlack MCP disconnected during startup')
    const listed = await client.listTools()
    const expected = config.mode === 'read-only' ? 12 : 16
    if (listed.tools.length !== expected || new Set(listed.tools.map(tool => tool.name)).size !== expected) {
      throw new Error('Unexpected OpenSlack tool catalog')
    }
    for (const tool of listed.tools) {
      if (!/^openslack_[a-z_]+$/.test(tool.name) || `mcp__openslack__${tool.name}`.length > 64) throw new Error('Unexpected OpenSlack tool identity')
      const publicName = `mcp__openslack__${tool.name}`
      const definition = createMcpToolDefinition(ctx, {
        name: publicName, rawName: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        async call(args, execution) {
          assertCurrent()
          const result = await client.callTool({ name: tool.name, arguments: structuredClone(args) },
            { signal: execution.signal, timeout: config.timeoutMs })
          assertCurrent()
          return result
        },
      })
      tools.set(publicName, definition)
      if (config.mode === 'read-only') {
        if (/(?:preview|confirm|cancel)/.test(tool.name)) throw new Error('Read-only connection advertised a mutation')
        ctx.effect(() => ctx.tools.register(definition))
      }
    }
    ready = true
  } catch {
    lost = true
    await owner.stop().catch(() => {})
    throw new Error('OpenSlack MCP initialization failed; no task may start')
  }
}
