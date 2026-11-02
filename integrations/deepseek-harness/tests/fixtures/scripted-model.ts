/** Keyless model for real dsh/Loader subprocess tests; never part of the package payload. */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'openslack-scripted-model-fixture'
export const inject = ['llm']

interface Config { script: string; requests: string; requestGate?: { expiryFile: string; marker: string } }

function find(value: unknown, key: string, depth = 0): unknown {
  if (depth > 16) return undefined
  if (typeof value === 'string') {
    try { return find(JSON.parse(value), key, depth + 1) }
    catch { return undefined }
  }
  if (Array.isArray(value)) {
    for (const item of value.toReversed()) { const found = find(item, key, depth + 1); if (found !== undefined) return found }
  } else if (value && typeof value === 'object') {
    if (key in value) return value[key as keyof typeof value]
    return find(Object.values(value), key, depth + 1)
  }
  return undefined
}

function resolveInput(value: unknown, options: GenerateOptions): unknown {
  if (value === '$planId') {
    const id = find(options.messages, 'planId')
    if (typeof id !== 'string' || id === '$planId') throw new Error('Fixture did not receive a public plan ID')
    return id
  }
  if (value === '$runId') {
    const id = JSON.stringify(options.messages).match(/RUN-[A-F0-9-]{36}/)?.[0]
    if (!id) throw new Error('Fixture did not receive its public task run ID')
    return id
  }
  if (Array.isArray(value)) return value.map(item => resolveInput(item, options))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveInput(item, options)]))
  return value
}

/** Mount only a deterministic fixture route, with no credential or network backend. */
export function apply(ctx: Context, config: Config): void {
  const script = JSON.parse(readFileSync(config.script, 'utf8')) as Array<string | { name: string; args: object; poll?: boolean }>
  let attempt = 0
  let index = 0
  if (config.requestGate) {
    const gate = config.requestGate
    ctx.on('agent/request', async (_request, next) => {
      const expiresAt = Number(readFileSync(gate.expiryFile, 'utf8'))
      const enteredAt = Date.now()
      if (!Number.isSafeInteger(expiresAt) || enteredAt >= expiresAt) throw new Error('Fixture request did not enter before the known lease cutoff')
      writeFileSync(gate.marker, JSON.stringify({ enteredAt, expiresAt }), { flag: 'wx' })
      // A real public framework preparation await, not a replacement SDK or a
      // model call. Both SDK owner and child keep their real process clocks.
      await new Promise(resolve => setTimeout(resolve, expiresAt - Date.now() + 20))
      writeFileSync(gate.marker, JSON.stringify({ enteredAt, expiresAt, finishedAt: Date.now() }))
      return next()
    }, true)
  }
  class Scripted extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      appendFileSync(config.requests, `${JSON.stringify(options)}\n`)
      attempt++
      let item = script[index]
      if (item && typeof item === 'object' && item.poll) {
        const execution = find(options.messages, 'execution')
        if (execution && typeof execution === 'object' && 'status' in execution && execution.status === 'completed') item = script[++index]
        else {
          if (execution && typeof execution === 'object' && 'status' in execution && execution.status === 'failed') throw new Error('Task host rejected keyless execution')
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      } else index++
      if (item === undefined) throw new Error('Keyless model script exhausted')
      if (typeof item === 'string') {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: item }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: item } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } else {
        const id = ToolCallId(`fixture-${attempt}`)
        const args = JSON.stringify(resolveInput(item.args, options))
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: item.name, argumentsDelta: args }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: item.name, arguments: args } }
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
  }
  ctx.llm.registerAdapter(['openslack-fixture'], new Scripted())
}
