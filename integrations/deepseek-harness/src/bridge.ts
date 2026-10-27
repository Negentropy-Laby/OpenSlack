/** Bounded Agent Run Bridge parsing and one-task SDK ownership. @module */
import type { HarnessNotification, RunResult, validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import type { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { SdkShutdownReceipt } from './process-observer.ts'
import { isDeepStrictEqual } from 'node:util'
import { assertEligibilityRestriction, readEligibilityRestriction, type HarnessEligibilityRestriction } from './scope-evidence.ts'
import { BridgeWireEncoder, BridgeWireDecoder, validateBridgeWireEnvelope, BRIDGE_CHUNK_EXTENSION,
  BRIDGE_MESSAGE_MAX_BYTES, HARNESS_CALLBACK_TOOLS } from '@openslack/agent-runtime/internal/bridge-wire'

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
  /** A host-supplied start cutoff, never a replacement for per-effect authority. */
  startEligibility: HarnessEligibilityRestriction
  /** Adds the original system text through a logged system-prompt section before boot. */
  createSdk: (systemText: string, allowedTools: readonly string[],
    authorize: (toolName: string, input: unknown, evidence?: ToolEvidenceReservation) => Promise<HarnessEligibilityRestriction>,
    recordResult: (callId: string, value: unknown, indeterminate?: boolean) => Promise<void>) => Promise<TaskSdk>
}

/** Trusted scope wrapper creates this before an effect; it is not a model tool input. */
export interface ToolEvidenceReservation {
  callId: string
  input: unknown
  targetPath: string
  generation: string
  maxResultBytes: number
}
const sdkToolNames: Readonly<Record<string, string>> = Object.freeze({ read: 'Read', write: 'Write', edit: 'Edit',
  ...Object.fromEntries(Object.values(HARNESS_CALLBACK_TOOLS).map(tool => [tool.sdk, tool.bridge])) })

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
  return validateBridgeWireEnvelope(JSON.parse(text)) as Frame
}

/** One handshake and at most one task. Closing cancels only this instance; replay is unsupported. */
export class OpenSlackPeer {
  private handshake: Frame | undefined
  private work: Promise<void> | undefined
  private sdk: TaskSdk | undefined
  private closing = false
  private closeTask: Promise<void> | undefined
  private readonly authorization = new Map<string, { resolve: (restriction: HarnessEligibilityRestriction) => void; reject: (error: Error) => void }>()
  private nextAuthorization = 0
  private readonly wireEncoder = new BridgeWireEncoder()
  private readonly wireDecoder = new BridgeWireDecoder()
  private fatalFailure: PeerFailure | undefined
  private readonly startEligibility: HarnessEligibilityRestriction

  constructor(private readonly deployment: PeerDeployment, private readonly send: (frame: Frame, serialized: string) => void) {
    this.startEligibility = readEligibilityRestriction(deployment.startEligibility)
  }

  /** Native startup keeps connection-local chunk state and decodes before dispatching any action. */
  receiveLine(text: string): Promise<void> {
    const decoded = this.wireDecoder.receive(text)
    return decoded ? this.receive(decoded as Frame) : Promise.resolve()
  }

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
      if (frame.payload.allowed === true) {
        try { pending.resolve(readEligibilityRestriction(frame.payload.restriction)) }
        catch { pending.reject(new PeerFailure('SCOPE', 'Live host eligibility restriction is unavailable or expired')) }
      }
      else pending.reject(new PeerFailure('SCOPE', 'Live host authorization denied this action'))
      return Promise.resolve()
    }
    if (frame.kind === 'handshake_request' && !this.handshake) {
      validateBridgeWireEnvelope(frame)
      if (frame.payload.protocolVersion !== version || frame.correlationId !== this.deployment.runId) return Promise.reject(new PeerFailure('PROTOCOL', 'Unsupported or unrelated Bridge handshake'))
      const requested = frame.payload.extensions ?? []
      if (!Array.isArray(requested) || requested.some(item => item !== BRIDGE_CHUNK_EXTENSION) || requested.length > 1) {
        return Promise.reject(new PeerFailure('PROTOCOL', 'Unsupported Bridge extensions'))
      }
      this.handshake = structuredClone(frame)
      this.wireDecoder.bind({ sessionId: frame.sessionId, correlationId: frame.correlationId })
      this.wireEncoder.setExtensions(requested)
      this.wireDecoder.setExtensions(requested)
      this.emit(frame, 'handshake_response', { accepted: true, ...(requested.length ? { extensions: requested } : {}) })
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
      let protocolFailure: unknown
      try { this.wireDecoder.finish() } catch (error) { protocolFailure = error }
      let shutdownFailure: unknown
      try { await this.sdk?.close() } catch (error) { shutdownFailure = error }
      try { await this.work } catch (error) { throw error }
      if (protocolFailure) throw protocolFailure
      if (shutdownFailure) throw shutdownFailure
    })()
    return this.closeTask
  }

  private emit(source: Frame, kind: string, payload: Record<string, unknown>): void {
    const frame = { ...source, timestamp: new Date().toISOString(), kind, payload }
    for (const serialized of this.wireEncoder.encode(frame)) this.send(frame, serialized)
  }

  private async execute(frame: Frame): Promise<void> {
    assertEligibilityRestriction(this.startEligibility)
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
    const calls = new Map<string, { toolName: string; input: unknown; seen: boolean; reserved: boolean; emitted: boolean; value?: unknown; hasValue: boolean }>()
    const emitCall = (callId: string) => {
      const call = calls.get(callId)!
      if (!call.seen || !call.reserved || call.emitted) return
      this.emit(frame, 'tool_request', { phase: 'observed', callId, toolName: call.toolName, input: call.input })
      call.emitted = true
    }
    const sdk = await this.deployment.createSdk(system, allowedTools, async (toolName, input, evidence) => {
      if (this.closing || this.fatalFailure || !this.deployment.allowedTools.includes(toolName) || !allowedTools.includes(toolName)) {
        throw new PeerFailure('SCOPE', 'Tool is outside the admitted request')
      }
      const id = String(++this.nextAuthorization)
      if (!evidence || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(evidence.callId) || !evidence.generation ||
        typeof evidence.targetPath !== 'string' || !Number.isSafeInteger(evidence.maxResultBytes) || evidence.maxResultBytes <= 0 ||
        evidence.maxResultBytes > BRIDGE_MESSAGE_MAX_BYTES) throw new PeerFailure('SCOPE', 'Tool evidence reservation is missing or unsupported')
      let call = calls.get(evidence.callId)
      if (call && (call.toolName !== toolName || !isDeepStrictEqual(call.input, evidence.input))) throw new PeerFailure('PROTOCOL', 'Tool input differs from SDK observation')
      if (!call) {
        call = { toolName, input: structuredClone(evidence.input), seen: false, reserved: false, emitted: false, hasValue: false }
        calls.set(evidence.callId, call)
      }
      const restriction = await new Promise<HarnessEligibilityRestriction>((resolve, reject) => {
        this.authorization.set(id, { resolve, reject })
        try { this.emit(frame, 'tool_request', { phase: 'authorize', authorizationRequestId: id, toolName, input, evidence }) }
        catch (error) { this.authorization.delete(id); reject(error instanceof Error ? error : new PeerFailure('PROTOCOL', 'Authorization frame failed')) }
      })
      this.assertOpen()
      call.reserved = true
      emitCall(evidence.callId)
      return restriction
    }, async (callId, value, indeterminate) => {
      const call = calls.get(callId)
      if (this.closing || !call?.reserved || call.hasValue) throw new PeerFailure('PROTOCOL', 'Unbound or repeated canonical tool result')
      if (indeterminate) {
        this.fatalFailure ??= new PeerFailure('TERMINAL', 'A native effect or its result is indeterminate; preserve without completion')
        throw this.fatalFailure
      }
      call.value = structuredClone(value)
      call.hasValue = true
    })
    this.sdk = sdk
    if (this.closing) { await sdk.close(); throw new PeerFailure('CLOSED', 'Peer closed before prompt') }
    const sessionId = `openslack-${frame.correlationId}`
    this.emit(frame, 'run_started', { runId: request.runId, sessionId })
    try {
      assertEligibilityRestriction(this.startEligibility)
      const user = users[0]
      if (!user) throw new PeerFailure('PROTOCOL', 'Missing user message')
      const result = await sdk.run(user.content, sessionId, (notification) => {
        if (notification.method !== 'session.event' || notification.params.sessionId !== sessionId) return
        try {
        const event = this.deployment.validateEvent(notification.params.event)
        if (event.type === 'tool/call') {
          const toolName = sdkToolNames[event.data.name]
          const existing = calls.get(event.data.callId)
          if (!toolName || existing?.seen || Buffer.byteLength(event.data.arguments) > BRIDGE_MESSAGE_MAX_BYTES) throw new PeerFailure('PROTOCOL', 'Unapproved, excessive or duplicate SDK tool event')
          const input: unknown = JSON.parse(event.data.arguments)
          if (existing) {
            if (existing.toolName !== toolName || !isDeepStrictEqual(input, existing.input)) throw new PeerFailure('PROTOCOL', 'Observed SDK input differs from its reservation')
            existing.seen = true
          } else calls.set(event.data.callId, { toolName, input, seen: true, reserved: false, emitted: false, hasValue: false })
          emitCall(event.data.callId)
        } else if (event.type === 'tool/result') {
          const id = event.data.message.toolCallId
          const call = calls.get(id)
          if (!call?.seen || !call.reserved || !call.emitted || (!call.hasValue && !event.data.message.isError)) throw new PeerFailure('PROTOCOL', 'Unmatched SDK tool result or missing canonical value')
          calls.delete(id)
          this.emit(frame, 'tool_response', { phase: 'observed', callId: id, toolName: call.toolName,
            output: { ...event.data, ...(call.hasValue ? { value: call.value } : {}) } })
        }
        } catch {
          this.fatalFailure ??= new PeerFailure('PROTOCOL', 'SDK tool evidence could not be reconciled; preserve without completion')
          // The SDK owner retains this same idempotent shutdown Promise; close()
          // awaits it even when its notification dispatcher catches observers.
          void sdk.close().catch(() => {})
          throw this.fatalFailure
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
    if (this.fatalFailure) throw this.fatalFailure
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
