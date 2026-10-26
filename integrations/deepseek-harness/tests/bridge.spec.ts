import { describe, expect, it, vi } from 'vitest'
import { validatedSessionEvent } from '@deepseek-ai/dsh-sdk-client'
import { expandAssistantStream } from '@deepseek-ai/dsh-llm'
import type { RunResult } from '@deepseek-ai/dsh-sdk-client'
import { OpenSlackPeer, parseFrame } from '../src/bridge.ts'
import type { Frame, TaskSdk } from '../src/bridge.ts'

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
function setup(terminal = 'completed') {
  const sdk: TaskSdk = { run: vi.fn(async () => result(terminal)), wait: vi.fn(async () => {}),
    close: vi.fn(async () => ({ shutdownAcknowledged: true, resourcesStopped: true, pid: 123, code: 0, signal: null, terminationRequested: false })) }
  const createSdk = vi.fn(async () => sdk)
  const frames: Frame[] = []
  const peer = new OpenSlackPeer({ runId: 'RUN-TEST', resultMode: 'text', agentId: 'approved', model: 'fixture-model', root: '/fixture',
    allowedTools: ['Read'], createSdk, validateEvent: validatedSessionEvent, expandStream: expandAssistantStream }, value => frames.push(value))
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
    expect(createSdk).toHaveBeenCalledWith('trusted system', ['Read'], expect.any(Function))
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
    await peer.receive({ ...handshake(), correlationId: 'OTHER' })
    const wire = request()
    wire.correlationId = 'OTHER'
    wire.payload.runId = 'OTHER'
    await expect(peer.receive(wire)).rejects.toMatchObject({ code: 'SCOPE' })
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
})
