/** Bounded Agent Run Bridge parsing and one-task SDK ownership. @module */
import type { HarnessNotification, RunResult, validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import type { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { SdkShutdownReceipt } from './process-observer.ts'
import { resolve } from 'node:path'

const version = '2025-06-03'

/** Failure codes do not include upstream text that could contain bearer credentials. */
export class PeerFailure extends Error {
  constructor(readonly code: 'PROTOCOL' | 'SCOPE' | 'TERMINAL' | 'CLOSED' | 'TIMEOUT' | 'SHUTDOWN_UNKNOWN', message: string) {
    super(message)
    this.name = 'PeerFailure'
  }
}

/** Validated wire message; input stays immutable across awaits. */
export interface Frame {
  protocolVersion: typeof version
  sessionId: string
  correlationId: string
  timestamp: string
  kind: string
  payload: Record<string, unknown>
}

/** A single owned SDK instance; production implements this through the public SDK. */
export interface TaskSdk {
  run: (text: string, sessionId: string, observe: (event: HarnessNotification) => void) => Promise<RunResult>
  wait: (sessionId: string) => Promise<void>
  close: () => Promise<Readonly<SdkShutdownReceipt>>
}

/** The deployment, not a wire request, decides identity, route, and workspace. */
export interface PeerDeployment {
  validateEvent: typeof validatedSessionEvent
  expandStream: typeof expandAssistantStream
  runId: string
  resultMode: 'text' | 'json'
  agentId: string
  model: string
  root: string
  /** Exact allowlist after the host's task/principal/policy intersection. */
  allowedTools: readonly string[]
  /** Adds the original system text through a logged system-prompt section before boot. */
  createSdk: (systemText: string, allowedTools: readonly string[],
    authorize: (toolName: string, input: unknown) => Promise<void>) => Promise<TaskSdk>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parse one bounded wire frame, rejecting invalid protocol identities before execution.
 * @param text - one complete UTF-8 JSON line, excluding its newline.
 * @returns a validated Bridge envelope; this does not authorize its requested action.
 */
export function parseFrame(text: string): Frame {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new PeerFailure('PROTOCOL', 'Bridge frame exceeds 1 MiB')
  const value: unknown = JSON.parse(text)
  if (!record(value) || value.protocolVersion !== version ||
    typeof value.sessionId !== 'string' || !value.sessionId ||
    typeof value.correlationId !== 'string' || !value.correlationId ||
    typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp)) ||
    typeof value.kind !== 'string' || !record(value.payload)) {
    throw new PeerFailure('PROTOCOL', 'Invalid Agent Run Bridge frame')
  }
  return { protocolVersion: version, sessionId: value.sessionId, correlationId: value.correlationId,
    timestamp: value.timestamp, kind: value.kind, payload: value.payload }
}

/** One handshake and at most one task. Closing cancels only this instance; replay is unsupported. */
export class OpenSlackPeer {
  private handshake: Frame | undefined
  private work: Promise<void> | undefined
  private sdk: TaskSdk | undefined
  private closing = false
  private closeTask: Promise<void> | undefined
  private readonly authorization = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  private nextAuthorization = 0

  constructor(private readonly deployment: PeerDeployment, private readonly send: (frame: Frame) => void) {}

  /**
   * Admit a handshake or one execution. Duplicate and cross-run frames reject without a new prompt.
   * @param frame - parsed envelope whose identities must match this owned run.
   */
  receive(frame: Frame): Promise<void> {
    if (this.closing) return Promise.reject(new PeerFailure('CLOSED', 'Peer is closing; query the existing run'))
    if (frame.kind === 'tool_response' && this.handshake &&
      frame.sessionId === this.handshake.sessionId && frame.correlationId === this.handshake.correlationId) {
      const id = frame.payload.authorizationRequestId
      const pending = typeof id === 'string' ? this.authorization.get(id) : undefined
      if (!pending || typeof id !== 'string') return Promise.reject(new PeerFailure('PROTOCOL', 'Unrelated authorization response'))
      this.authorization.delete(id)
      if (frame.payload.allowed === true) pending.resolve()
      else pending.reject(new PeerFailure('SCOPE', 'Live host authorization denied this action'))
      return Promise.resolve()
    }
    if (frame.kind === 'handshake_request' && !this.handshake) {
      if (frame.payload.protocolVersion !== version) return Promise.reject(new PeerFailure('PROTOCOL', 'Unsupported Bridge version'))
      this.handshake = structuredClone(frame)
      this.emit(frame, 'handshake_response', { accepted: true })
      return Promise.resolve()
    }
    if (!this.handshake || frame.sessionId !== this.handshake.sessionId ||
      frame.correlationId !== this.handshake.correlationId || frame.kind !== 'run_request' || this.work) {
      return Promise.reject(new PeerFailure('PROTOCOL', 'Duplicate or unrelated Bridge request'))
    }
    const input = structuredClone(frame)
    // Assign ownership before an async factory or prompt can yield.
    this.work = this.execute(input)
    return this.work
  }

  /** Close the SDK, await task settlement, and propagate unconfirmed shutdown rather than success. */
  close(): Promise<void> {
    this.closing = true
    for (const pending of this.authorization.values()) pending.reject(new PeerFailure('CLOSED', 'Authorization transport closed'))
    this.authorization.clear()
    this.closeTask ??= (async () => {
      await this.sdk?.close()
      await this.work
    })()
    return this.closeTask
  }

  private emit(source: Frame, kind: string, payload: Record<string, unknown>): void {
    const frame = { ...source, timestamp: new Date().toISOString(), kind, payload }
    if (Buffer.byteLength(JSON.stringify(frame)) > 1024 * 1024) throw new PeerFailure('PROTOCOL', 'Bridge output exceeds 1 MiB')
    this.send(frame)
  }

  private async execute(frame: Frame): Promise<void> {
    const request = frame.payload
    const denied = request.deniedTools
    if (request.runId !== frame.correlationId || request.runId !== this.deployment.runId || request.agentId !== this.deployment.agentId ||
      request.worktreePath !== this.deployment.root ||
      (request.model !== undefined && request.model !== this.deployment.model) ||
      request.effort !== undefined || request.maxTurns !== undefined ||
      !Array.isArray(request.allowedTools) ||
      request.allowedTools.some(name => typeof name !== 'string' || !this.deployment.allowedTools.includes(name)) ||
      !Array.isArray(denied) || request.allowedTools.some(name => denied.includes(name))) {
      throw new PeerFailure('SCOPE', 'Request does not match the approved deployment or requires unsupported limits')
    }
    if (!Array.isArray(request.input) || request.input.length === 0 ||
      request.input.some(item => !record(item) || !['system', 'user'].includes(String(item.role)) || typeof item.content !== 'string')) {
      throw new PeerFailure('PROTOCOL', 'Only text system and user messages are supported')
    }
    const messages = request.input as Array<{ role: string; content: string }>
    const users = messages.filter(item => item.role === 'user')
    if (users.length !== 1) throw new PeerFailure('PROTOCOL', 'Exactly one user message is required')
    if (record(request.metadata) && request.metadata.budget !== undefined) {
      throw new PeerFailure('SCOPE', 'A strict total token or cost budget is not supported by this SDK peer')
    }
    const system = messages.filter(item => item.role === 'system').map(item => item.content).join('\n\n')
    const allowedTools = request.allowedTools as string[]
    const sdk = await this.deployment.createSdk(system, allowedTools, async (toolName, input) => {
      if (this.closing || !this.deployment.allowedTools.includes(toolName) || !allowedTools.includes(toolName)) {
        throw new PeerFailure('SCOPE', 'Tool is outside the admitted request')
      }
      const id = String(++this.nextAuthorization)
      await new Promise<void>((resolve, reject) => {
        this.authorization.set(id, { resolve, reject })
        try { this.emit(frame, 'tool_request', { phase: 'authorize', authorizationRequestId: id, toolName, input }) }
        catch (error) { this.authorization.delete(id); reject(error instanceof Error ? error : new PeerFailure('PROTOCOL', 'Authorization frame failed')) }
      })
    })
    this.sdk = sdk
    if (this.closing) { await sdk.close(); throw new PeerFailure('CLOSED', 'Peer closed before prompt') }
    const sessionId = `openslack-${frame.correlationId}`
    this.emit(frame, 'run_started', { runId: request.runId, sessionId })
    try {
      const calls = new Map<string, string>()
      const user = users[0]
      if (!user) throw new PeerFailure('PROTOCOL', 'Missing user message')
      const result = await sdk.run(user.content, sessionId, (notification) => {
        if (notification.method !== 'session.event' || notification.params.sessionId !== sessionId) return
        const event = this.deployment.validateEvent(notification.params.event)
        if (event.type === 'tool/call') {
          const names: Record<string, string> = {
            read: 'Read', write: 'Write', edit: 'Edit',
            mcp__openslack__openslack_get_activity: 'mcp.openslack.openslack_get_activity',
            mcp__openslack__openslack_preview_workflow: 'mcp.openslack.openslack_preview_workflow',
            mcp__openslack__openslack_confirm_plan: 'mcp.openslack.openslack_confirm_plan',
            mcp__openslack__openslack_cancel_plan: 'mcp.openslack.openslack_cancel_plan',
          }
          const toolName = names[event.data.name]
          if (!toolName || calls.has(event.data.callId)) throw new PeerFailure('PROTOCOL', 'Unapproved or duplicate SDK tool event')
          const input: unknown = JSON.parse(event.data.arguments)
          if (record(input) && typeof input.file_path === 'string') input.file_path = resolve(this.deployment.root, input.file_path)
          calls.set(event.data.callId, toolName)
          this.emit(frame, 'tool_request', { phase: 'observed', callId: event.data.callId, toolName, input })
        } else if (event.type === 'tool/result') {
          const id = event.data.message.toolCallId
          const toolName = calls.get(id)
          if (!toolName) throw new PeerFailure('PROTOCOL', 'Unmatched SDK tool result')
          calls.delete(id)
          this.emit(frame, 'tool_response', { phase: 'observed', callId: id, toolName,
            output: { isError: event.data.message.isError === true, content: event.data.message.content } })
        }
      })
      await sdk.wait(sessionId)
      this.assertOpen()
      const endings = result.events.filter(event => event.type === 'turn/end')
      if (endings.length !== 1 || endings[0]?.data.reason.kind !== 'completed' || result.finalResponse.length === 0) {
        throw new PeerFailure('TERMINAL', 'SDK did not record a completed turn with output')
      }
      if (calls.size) throw new PeerFailure('PROTOCOL', 'SDK ended with unmatched tool calls')
      const shutdown = await sdk.close()
      this.assertOpen()
      if (!shutdown.shutdownAcknowledged || !shutdown.resourcesStopped || shutdown.code !== 0 || shutdown.signal !== null ||
        shutdown.terminationRequested || shutdown.pid <= 0) {
        throw new PeerFailure('SHUTDOWN_UNKNOWN', 'SDK did not confirm clean owned shutdown; preserve and reconcile')
      }
      const tokenUsage = observedUsage(result, this.deployment.expandStream)
      const data: unknown = this.deployment.resultMode === 'json' ? JSON.parse(result.finalResponse) : result.finalResponse
      this.emit(frame, 'complete', { data, sessionId, usage: tokenUsage === undefined ? 'unknown' : 'observed',
        ...(tokenUsage === undefined ? {} : { tokenUsage }) })
    } finally {
      await sdk.close()
    }
  }
  private assertOpen(): void {
    if (this.closing) throw new PeerFailure('CLOSED', 'Execution interrupted; preserve and reconcile the run')
  }
}

/** Unknown or incomplete attempt usage stays unknown; output caps never supply usage. */
function observedUsage(result: RunResult, expandStream: typeof expandAssistantStream): number | undefined {
  let total = 0
  let attempts = 0
  for (const event of result.events) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    attempts++
    const usage = event.type === 'assistant/message' ? event.data.usage
      : expandStream(event.data.stream).findLast(member => member.chunk.type === 'usage')?.chunk
    const value = usage && 'type' in usage ? usage.type === 'usage' ? usage.usage : undefined : usage
    if (!value || !Number.isSafeInteger(value.inputTokens) || !Number.isSafeInteger(value.outputTokens) ||
      value.inputTokens < 0 || value.outputTokens < 0) return undefined
    total += value.inputTokens + value.outputTokens
    if (!Number.isSafeInteger(total)) return undefined
  }
  return attempts ? total : undefined
}
