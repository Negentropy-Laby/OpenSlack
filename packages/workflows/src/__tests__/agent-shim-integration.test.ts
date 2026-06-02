import { describe, it, expect, vi } from 'vitest'
import {
  executeAgentCall,
  computeAgentCacheKey,
} from '../agent-shim.js'
import type { AgentCacheStore, AgentLauncher, AgentEventEmitter } from '../agent-shim.js'
import type { AgentOptions, BudgetState } from '../types.js'

function makeConfig(overrides: Partial<{
  mode: 'validate' | 'preview' | 'dry-run' | 'execute'
  budget: BudgetState
  permissions: Set<string>
  cache: AgentCacheStore
  launcher: AgentLauncher
  runId: string
  cacheKey: string
  eventEmitter: AgentEventEmitter
  resolvedAgent: { agentId: string; source: string; model?: string } | null
}> = {}) {
  const log = vi.fn()
  const budget: BudgetState = overrides.budget ?? {
    tokensUsed: 0,
    tokensRemaining: 1000,
    costUsd: 0,
    agentCalls: 0,
  }
  return {
    config: {
      runId: overrides.runId ?? 'test-run',
      mode: overrides.mode ?? 'execute',
      budget,
      permissions: overrides.permissions ?? new Set(['agent.scan']),
      cache: overrides.cache ?? {
        async load() { return null },
        async save() {},
      },
      launcher: overrides.launcher ?? (async () => ({ data: { ok: true }, tokenUsage: 10 })),
      log,
      cacheKey: overrides.cacheKey ?? 'test-key',
      eventEmitter: overrides.eventEmitter,
      resolvedAgent: overrides.resolvedAgent,
    },
    log,
    budget,
  }
}

describe('executeAgentCall with event emission', () => {
  it('emits started and completed events in execute mode', async () => {
    const events: Array<Parameters<AgentEventEmitter>[0]> = []
    const emitter: AgentEventEmitter = (e) => { events.push(e) }
    const launcher: AgentLauncher = async () => ({ data: { result: 'done' }, tokenUsage: 5 })

    const { config } = makeConfig({
      mode: 'execute',
      launcher,
      eventEmitter: emitter,
      resolvedAgent: { agentId: 'my-agent', source: 'claude-project' },
    })

    const opts: AgentOptions = { label: 'test', phase: 'Scan', agentType: 'my-agent' }
    const result = await executeAgentCall('prompt', opts, config)

    expect(result).toEqual({ result: 'done' })
    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('agent.conversation.started')
    expect(events[0].agentId).toBe('my-agent')
    expect(events[0].label).toBe('test')
    expect(events[0].phase).toBe('Scan')
    expect(events[0].runId).toBe('test-run')
    expect(events[0].resolvedAgentId).toBe('my-agent')
    expect(events[1].type).toBe('agent.conversation.completed')
    expect(events[1].agentId).toBe('my-agent')
  })

  it('emits failed event when launcher throws', async () => {
    const events: Array<Parameters<AgentEventEmitter>[0]> = []
    const emitter: AgentEventEmitter = (e) => { events.push(e) }
    const launcher: AgentLauncher = async () => { throw new Error('Agent crashed') }

    const { config } = makeConfig({
      mode: 'execute',
      launcher,
      eventEmitter: emitter,
    })

    const opts: AgentOptions = { label: 'crash-test', phase: 'Run' }
    await expect(executeAgentCall('prompt', opts, config)).rejects.toThrow('Agent crashed')

    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('agent.conversation.started')
    expect(events[1].type).toBe('agent.conversation.failed')
    expect(events[1].error).toBe('Agent crashed')
  })

  it('does NOT emit events in dry-run mode', async () => {
    const events: Array<Parameters<AgentEventEmitter>[0]> = []
    const emitter: AgentEventEmitter = (e) => { events.push(e) }

    const { config } = makeConfig({
      mode: 'dry-run',
      eventEmitter: emitter,
    })

    const opts: AgentOptions = { label: 'dry', phase: 'Scan' }
    await executeAgentCall('prompt', opts, config)
    expect(events).toHaveLength(0)
  })

  it('does NOT emit events in preview mode', async () => {
    const events: Array<Parameters<AgentEventEmitter>[0]> = []
    const emitter: AgentEventEmitter = (e) => { events.push(e) }

    const { config } = makeConfig({
      mode: 'preview',
      eventEmitter: emitter,
    })

    const opts: AgentOptions = { label: 'preview', phase: 'Scan' }
    await executeAgentCall('prompt', opts, config)
    expect(events).toHaveLength(0)
  })

  it('uses label as agentId when no resolvedAgent or agentType', async () => {
    const events: Array<Parameters<AgentEventEmitter>[0]> = []
    const emitter: AgentEventEmitter = (e) => { events.push(e) }

    const { config } = makeConfig({
      mode: 'execute',
      eventEmitter: emitter,
      // No resolvedAgent
    })

    const opts: AgentOptions = { label: 'fallback-label', phase: 'Scan' }
    await executeAgentCall('prompt', opts, config)
    expect(events[0].agentId).toBe('fallback-label')
  })
})

describe('computeAgentCacheKey with resolvedAgentId', () => {
  it('produces different keys for different resolvedAgentIds', () => {
    const k1 = computeAgentCacheKey('h', 'Scan', 'label', 'prompt', 'agent-a')
    const k2 = computeAgentCacheKey('h', 'Scan', 'label', 'prompt', 'agent-b')
    expect(k1).not.toBe(k2)
  })

  it('produces same key when resolvedAgentId is undefined', () => {
    const k1 = computeAgentCacheKey('h', 'Scan', 'label', 'prompt')
    const k2 = computeAgentCacheKey('h', 'Scan', 'label', 'prompt', undefined)
    expect(k1).toBe(k2)
  })

  it('includes resolvedAgentId in key string', () => {
    const key = computeAgentCacheKey('h', 'Scan', 'label', 'prompt', 'my-agent')
    // The key should contain the agentId between the label and prompt hash
    expect(key).toContain('my-agent')
  })
})
