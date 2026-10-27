import { describe, expect, it, vi } from 'vitest'
import { validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { BridgeWireDecoder, BRIDGE_CHUNK_EXTENSION } from '@openslack/agent-runtime/internal/bridge-wire'
import type { RunResult } from '@deepseek-ai/dsh-sdk-client'
import { OpenSlackPeer, parseFrame } from '../src/bridge.ts'
import type { Frame, TaskSdk } from '../src/bridge.ts'
import type { HarnessEligibilityRestriction } from '../src/scope-evidence.ts'

function frame(kind: string, payload: Record<string, unknown>): Frame {
  return { protocolVersion: '2025-06-03', sessionId: 'bridge-RUN-TEST', correlationId: 'RUN-TEST',
    timestamp: new Date().toISOString(), kind, payload }
}
const handshake = () => frame('handshake_request', { protocolVersion: '2025-06-03' })
const request = () => frame('run_request', {
  runId: 'RUN-TEST', agentId: 'approved', worktreePath: '/fixture', allowedTools: ['Read'], deniedTools: [],
  input: [{ role: 'system', content: 'trusted system' }, { role: 'user', content: 'user task' }],
})
function result(reason = 'completed'): RunResult {
  return { sessionId: 'openslack-RUN-TEST', finalResponse: 'fixture output', notifications: [],
    events: [validatedSessionEvent({ type: 'turn/end', data: { reason: { kind: reason } } })] }
}
function setup(terminal = 'completed', startEligibility: HarnessEligibilityRestriction = { mode: 'not_applicable' }) {
  const sdk: TaskSdk = { run: vi.fn(async () => result(terminal)), wait: vi.fn(async () => {}),
    close: vi.fn(async () => ({ shutdownAcknowledged: true, resourcesStopped: true, pid: 123, code: 0, signal: null, terminationRequested: false })) }
  const createSdk = vi.fn(async () => sdk)
  const frames: Frame[] = []
  const peer = new OpenSlackPeer({ runId: 'RUN-TEST', resultMode: 'text', agentId: 'approved', model: 'fixture-model', root: '/fixture',
    allowedTools: ['Read'], startEligibility, createSdk, validateEvent: validatedSessionEvent, expandStream: expandAssistantStream }, value => frames.push(value))
  return { sdk, createSdk, frames, peer }
}

describe('Bridge to public SDK', () => {
  it.each(['sigterm', 'sigkill', 'unacknowledged', 'nonzero', 'resources-missing', 'bad-pid'] as const)('refuses complete after %s SDK shutdown', async (kind) => {
    const { sdk, frames, peer } = setup()
    vi.mocked(sdk.close).mockResolvedValue({ shutdownAcknowledged: kind !== 'unacknowledged', resourcesStopped: kind !== 'resources-missing', pid: kind === 'bad-pid' ? -1 : 123,
      code: kind === 'nonzero' ? 1 : 0, signal: null, terminationRequested: kind === 'sigterm' || kind === 'sigkill' })
    await peer.receive(handshake())
    await expect(peer.receive(request())).rejects.toMatchObject({ code: 'SHUTDOWN_UNKNOWN' })
    expect(frames.some(frame => frame.kind === 'complete')).toBe(false)
    await expect(peer.close()).rejects.toMatchObject({ code: 'SHUTDOWN_UNKNOWN' })
  })
  it('preserves system/user roles, waits for descendants and SDK close, then sends complete.data', async () => {
    const { sdk, createSdk, frames, peer } = setup()
    await peer.receive(handshake())
    await peer.receive(request())
    expect(createSdk).toHaveBeenCalledWith('trusted system', ['Read'], expect.any(Function), expect.any(Function))
    expect(sdk.run).toHaveBeenCalledWith('user task', 'openslack-RUN-TEST', expect.any(Function))
    expect(sdk.wait).toHaveBeenCalledWith('openslack-RUN-TEST')
    expect(sdk.close).toHaveBeenCalled()
    expect(frames.map(value => value.kind)).toEqual(['handshake_response', 'run_started', 'complete'])
    expect(frames.at(-1)?.payload).toEqual({ data: 'fixture output', sessionId: 'openslack-RUN-TEST', usage: 'unknown' })
    expect(frames.at(-1)?.payload).not.toHaveProperty('result')
    await peer.close()
  })

  it.each(['error', 'blocked', 'max-tokens', 'interrupted', 'forked'])('does not treat idle with %s as completion', async (reason) => {
    const { frames, peer } = setup(reason)
    await peer.receive(handshake())
    await expect(peer.receive(request())).rejects.toMatchObject({ code: 'TERMINAL' })
    expect(frames.some(value => value.kind === 'complete')).toBe(false)
    await expect(peer.close()).rejects.toMatchObject({ code: 'TERMINAL' })
  })

  it('rejects a different task and repeated requests without a second prompt', async () => {
    const { peer, sdk } = setup()
    await peer.receive(handshake())
    await expect(peer.receive({ ...request(), correlationId: 'OTHER' })).rejects.toMatchObject({ code: 'PROTOCOL' })
    await peer.receive(request())
    await expect(peer.receive(request())).rejects.toMatchObject({ code: 'PROTOCOL' })
    expect(sdk.run).toHaveBeenCalledTimes(1)
    await peer.close()
  })

  it.each(['agentId', 'worktreePath', 'model', 'effort', 'maxTurns'])('rejects an unsupported or changed %s before SDK startup', async (key) => {
    const { peer, createSdk } = setup()
    await peer.receive(handshake())
    const wire = request()
    wire.payload[key] = 'unapproved'
    await expect(peer.receive(wire)).rejects.toMatchObject({ code: 'SCOPE' })
    expect(createSdk).not.toHaveBeenCalled()
    await expect(peer.close()).rejects.toMatchObject({ code: 'SCOPE' })
  })

  it('does not silently discard tool-role input or strict budgets', async () => {
    for (const patch of [{ input: [{ role: 'tool', content: 'x' }] }, { metadata: { budget: { tokens: 10 } } }]) {
      const { peer, createSdk } = setup()
      await peer.receive(handshake())
      await expect(peer.receive({ ...request(), payload: { ...request().payload, ...patch } })).rejects.toBeDefined()
      expect(createSdk).not.toHaveBeenCalled()
      await peer.close().catch(() => {})
    }
  })

  it('rejects a self-consistent handshake for another run before SDK creation', async () => {
    const { peer, createSdk } = setup()
    await expect(peer.receive({ ...handshake(), correlationId: 'OTHER' })).rejects.toMatchObject({ code: 'PROTOCOL' })
    expect(createSdk).not.toHaveBeenCalled()
    await peer.close().catch(() => {})
  })

  it('takes a copy before the asynchronous SDK factory yields', async () => {
    const { peer, createSdk, sdk } = setup()
    let ready: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { ready = resolve })
    createSdk.mockImplementationOnce(async () => { await gate; return sdk })
    await peer.receive(handshake())
    const wire = request()
    const work = peer.receive(wire)
    wire.payload.input = [{ role: 'user', content: 'changed' }]
    ready!()
    await work
    expect(sdk.run).toHaveBeenCalledWith('user task', 'openslack-RUN-TEST', expect.any(Function))
    await peer.close()
  })

  it('rechecks the host start cutoff after an awaited SDK factory and still closes the returned owner', async () => {
    let now = Date.now()
    const expiry = now + 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const { peer, createSdk, sdk, frames } = setup('completed', { mode: 'required', expiresAt: expiry })
      createSdk.mockImplementationOnce(async () => { await Promise.resolve(); now = expiry; return sdk })
      await peer.receive(handshake())
      await expect(peer.receive(request())).rejects.toThrow(/lease expired/)
      expect(sdk.run).not.toHaveBeenCalled()
      expect(sdk.close).toHaveBeenCalledOnce()
      expect(frames.some(frame => frame.kind === 'complete')).toBe(false)
      await peer.close().catch(() => {})
    } finally { clock.mockRestore() }
  })

  it('does not send complete if SDK exit cannot be confirmed', async () => {
    const { peer, sdk, frames } = setup()
    vi.mocked(sdk.close).mockRejectedValue(new Error('unconfirmed'))
    await peer.receive(handshake())
    await expect(peer.receive(request())).rejects.toThrow('unconfirmed')
    expect(frames.some(value => value.kind === 'complete')).toBe(false)
    await peer.close().catch(() => {})
  })

  it('does not publish complete when cancellation arrives while clean SDK close is pending', async () => {
    const { peer, sdk, frames } = setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(sdk.close).mockImplementation(async () => {
      await gate
      return { shutdownAcknowledged: true, resourcesStopped: true, pid: 123, code: 0, signal: null, terminationRequested: false }
    })
    await peer.receive(handshake())
    const work = peer.receive(request())
    const rejected = expect(work).rejects.toMatchObject({ code: 'CLOSED' })
    await vi.waitFor(() => { expect(sdk.close).toHaveBeenCalled() })
    const stopped = expect(peer.close()).rejects.toMatchObject({ code: 'CLOSED' })
    release()
    await Promise.all([rejected, stopped])
    expect(frames.some(frame => frame.kind === 'complete')).toBe(false)
  })

  it('bounds and validates parsed frames', () => {
    const original = handshake()
    expect(parseFrame(JSON.stringify(original))).toEqual(original)
    expect(() => parseFrame(JSON.stringify({ ...handshake(), protocolVersion: 'next' }))).toThrow()
    expect(() => parseFrame('a'.repeat(1024 * 1024 + 1))).toThrow('1 MiB')
  })

  it.each([
    ['missing', undefined], ['unknown', { mode: 'unreviewed' }],
    ['expired', { mode: 'required', expiresAt: 1 }],
    ['extra-key', { mode: 'not_applicable', expiresAt: Number.MAX_SAFE_INTEGER }],
  ])('refuses %s eligibility in a private allow ACK before any SDK tool effect', async (_name, restriction) => {
    const effect = vi.fn()
    const frames: Frame[] = []
    const sdk: TaskSdk = { wait: vi.fn(async () => {}), close: vi.fn(async () => ({
      pid: 123, code: 0, signal: null, terminationRequested: false, shutdownAcknowledged: true, resourcesStopped: true,
    })), run: vi.fn() }
    const peer = new OpenSlackPeer({ runId: 'RUN-TEST', resultMode: 'text', agentId: 'approved', model: 'fixture-model', root: '/fixture',
      allowedTools: ['Read'], startEligibility: { mode: 'not_applicable' }, validateEvent: validatedSessionEvent, expandStream: expandAssistantStream,
      async createSdk(_system, _tools, authorize) {
        vi.mocked(sdk.run).mockImplementation(async () => {
          await authorize('Read', { file_path: '/fixture/fixture.txt' }, { callId: 'scope-read-1', input: { file_path: 'fixture.txt' },
            targetPath: '/fixture/fixture.txt', generation: 'g1', maxResultBytes: 1024 })
          effect()
          return result()
        })
        return sdk
      },
    }, sent => {
      frames.push(sent)
      if (sent.kind === 'tool_request' && sent.payload.phase === 'authorize') {
        void peer.receive(frame('tool_response', { authorizationRequestId: sent.payload.authorizationRequestId, allowed: true,
          ...(restriction === undefined ? {} : { restriction }) }))
      }
    })
    await peer.receive(handshake())
    await expect(peer.receive(request())).rejects.toMatchObject({ code: 'SCOPE' })
    expect(effect).not.toHaveBeenCalled()
    expect(frames.some(sent => sent.kind === 'complete' || sent.payload.phase === 'observed')).toBe(false)
    await expect(peer.close()).rejects.toMatchObject({ code: 'SCOPE' })
  })

  it('preserves full original inputs, canonical values and SDK result metadata through negotiated chunks', async () => {
    const original = { file_path: 'fixture.txt', content: '\u0001'.repeat(200_000) }
    const canonical = { path: '/fixture/fixture.txt', before: null, after: 'written' }
    const meta = { diffs: [{ path: '/fixture/fixture.txt', oldText: null, newText: original.content }] }
    const lines: string[] = []
    const host = new BridgeWireDecoder({ sessionId: 'bridge-RUN-TEST', correlationId: 'RUN-TEST' })
    host.setExtensions([BRIDGE_CHUNK_EXTENSION])
    const sdk: TaskSdk = { wait: vi.fn(async () => {}), close: vi.fn(async () => ({
      pid: 123, code: 0, signal: null, terminationRequested: false, shutdownAcknowledged: true, resourcesStopped: true,
    })), run: vi.fn() }
    const peer = new OpenSlackPeer({ runId: 'RUN-TEST', resultMode: 'text', agentId: 'approved', model: 'fixture-model', root: '/fixture',
      allowedTools: ['Write'], startEligibility: { mode: 'not_applicable' }, validateEvent: validatedSessionEvent, expandStream: expandAssistantStream,
      async createSdk(_system, _tools, authorize, recordResult) {
        vi.mocked(sdk.run).mockImplementation(async (_text, sessionId, observe) => {
          const callId = ToolCallId('scope-write-1')
          observe({ method: 'session.event', params: { sessionId, event: validatedSessionEvent({ type: 'tool/call',
            data: { turn: 1, step: 1, callId, name: 'write', arguments: JSON.stringify(original) } }) } })
          await authorize('Write', { file_path: '/fixture/fixture.txt' }, { callId, input: original,
            targetPath: '/fixture/fixture.txt', generation: 'g1', maxResultBytes: 16 * 1024 * 1024 - 1024 })
          await recordResult(callId, canonical)
          observe({ method: 'session.event', params: { sessionId, event: validatedSessionEvent({ type: 'tool/result', data: {
            turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Written' }], isError: false }), meta,
          } }) } })
          return result()
        })
        return sdk
      },
    }, (_sent, serialized) => {
      lines.push(serialized)
      const sent = host.receive(serialized)
      if (sent?.kind === 'tool_request' && sent.payload.phase === 'authorize') {
        void peer.receive({ ...frame('tool_response', {}), payload: {
          authorizationRequestId: sent.payload.authorizationRequestId, allowed: true, restriction: { mode: 'not_applicable' },
        } })
      }
    })
    await peer.receive({ ...handshake(), payload: { protocolVersion: '2025-06-03', extensions: [BRIDGE_CHUNK_EXTENSION] } })
    const run = request()
    run.payload.allowedTools = ['Write']
    await peer.receive(run)
    const decoded = new BridgeWireDecoder({ sessionId: 'bridge-RUN-TEST', correlationId: 'RUN-TEST' })
    decoded.setExtensions([BRIDGE_CHUNK_EXTENSION])
    const events = lines.map(line => decoded.receive(line)).filter(Boolean)
    const call = events.find(event => event?.kind === 'tool_request' && event.payload.phase === 'observed')
    const output = events.find(event => event?.kind === 'tool_response')?.payload.output as Record<string, unknown>
    expect(call?.payload.input).toEqual(original)
    expect(original.file_path).toBe('fixture.txt')
    expect(output.value).toEqual(canonical)
    expect(output.meta).toEqual(meta)
    expect(lines.every(line => Buffer.byteLength(line) <= 1024 * 1024)).toBe(true)
    expect(events.filter(event => event?.kind === 'complete')).toHaveLength(1)
    await peer.close()
  })
})
