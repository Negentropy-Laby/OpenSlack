import { describe, it, expect, vi } from 'vitest'
import {
  SchemaValidationError,
  executeAgentCall,
  computeAgentCacheKey,
  validateAgainstSchema,
} from '../agent-shim.js'
import type { AgentCacheStore, AgentLauncher } from '../agent-shim.js'
import type { AgentOptions, BudgetState } from '../types.js'

function makeConfig(overrides: Partial<{
  mode: 'validate' | 'preview' | 'dry-run' | 'execute'
  budget: BudgetState
  permissions: Set<string>
  cache: AgentCacheStore
  launcher: AgentLauncher
  runId: string
  cacheKey: string
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
    },
    log,
    budget,
  }
}

describe('SchemaValidationError', () => {
  it('has correct name', () => {
    const err = new SchemaValidationError('test', ['bad'])
    expect(err.name).toBe('SchemaValidationError')
  })

  it('includes label and violations in message', () => {
    const err = new SchemaValidationError('my-label', ['type mismatch', 'missing field'])
    expect(err.message).toContain('my-label')
    expect(err.message).toContain('type mismatch')
    expect(err.message).toContain('missing field')
  })

  it('exposes label and violations properties', () => {
    const err = new SchemaValidationError('lbl', ['v1'])
    expect(err.label).toBe('lbl')
    expect(err.violations).toEqual(['v1'])
  })
})

describe('computeAgentCacheKey', () => {
  it('produces a non-empty string', () => {
    const key = computeAgentCacheKey('hash1', 'Scan', 'label1', 'prompt')
    expect(key.length).toBeGreaterThan(0)
  })

  it('is deterministic for same inputs', () => {
    const k1 = computeAgentCacheKey('h', 'Scan', 'l', 'prompt')
    const k2 = computeAgentCacheKey('h', 'Scan', 'l', 'prompt')
    expect(k1).toBe(k2)
  })

  it('differs for different prompts', () => {
    const k1 = computeAgentCacheKey('h', 'Scan', 'l', 'prompt-a')
    const k2 = computeAgentCacheKey('h', 'Scan', 'l', 'prompt-b')
    expect(k1).not.toBe(k2)
  })

  it('differs for different phases', () => {
    const k1 = computeAgentCacheKey('h', 'Scan', 'l', 'p')
    const k2 = computeAgentCacheKey('h', 'Verify', 'l', 'p')
    expect(k1).not.toBe(k2)
  })

  it('differs for different labels', () => {
    const k1 = computeAgentCacheKey('h', 'Scan', 'a', 'p')
    const k2 = computeAgentCacheKey('h', 'Scan', 'b', 'p')
    expect(k1).not.toBe(k2)
  })

  it('includes manifest hash in key', () => {
    const key = computeAgentCacheKey('manifest-hash', 'Scan', 'l', 'p')
    expect(key.startsWith('manifest-hash:')).toBe(true)
  })
})

describe('validateAgainstSchema', () => {
  it('returns empty violations for valid data', () => {
    const violations = validateAgainstSchema(
      { name: 'test' },
      { type: 'object', properties: { name: { type: 'string' } } },
    )
    expect(violations).toEqual([])
  })

  it('returns violation for type mismatch', () => {
    const violations = validateAgainstSchema(
      'not-an-object',
      { type: 'object' },
    )
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0]).toContain('expected type')
  })

  it('returns violation for missing required property', () => {
    const violations = validateAgainstSchema(
      {},
      { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    )
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0]).toContain('required')
  })

  it('returns violation for enum mismatch', () => {
    const violations = validateAgainstSchema(
      'invalid',
      { enum: ['valid', 'also-valid'] },
    )
    expect(violations.length).toBeGreaterThan(0)
  })

  it('validates array items', () => {
    const violations = validateAgainstSchema(
      [1, 'bad'],
      { type: 'array', items: { type: 'number' } },
    )
    expect(violations.length).toBeGreaterThan(0)
  })

  it('validates nested properties', () => {
    const violations = validateAgainstSchema(
      { outer: { inner: 42 } },
      { type: 'object', properties: { outer: { type: 'object', properties: { inner: { type: 'string' } } } } },
    )
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0]).toContain('outer.inner')
  })
})

describe('executeAgentCall', () => {
  it('throws in validate mode', async () => {
    const { config } = makeConfig({ mode: 'validate' })
    const opts: AgentOptions = { label: 'test', phase: 'Scan' }
    await expect(executeAgentCall('prompt', opts, config)).rejects.toThrow('validate mode')
  })

  it('throws when budget is exhausted', async () => {
    const { config } = makeConfig({
      budget: { tokensUsed: 1000, tokensRemaining: 0, costUsd: 0, agentCalls: 0 },
    })
    const opts: AgentOptions = { label: 'test', phase: 'Scan' }
    await expect(executeAgentCall('prompt', opts, config)).rejects.toThrow('Budget exhausted')
  })

  it('throws when budget remaining is null and tokensUsed exceeds limit', async () => {
    const { config } = makeConfig({
      budget: { tokensUsed: 0, tokensRemaining: null, costUsd: 0, agentCalls: 0 },
    })
    const opts: AgentOptions = { label: 'test', phase: 'Scan' }
    // Unlimited budget should not throw
    const result = await executeAgentCall('prompt', opts, config)
    expect(result).toEqual({ ok: true })
  })

  it('returns cached result when available', async () => {
    const cache: AgentCacheStore = {
      async load() { return { data: { cached: true }, tokenUsage: 5 } },
      async save() {},
    }
    const launcher = vi.fn()
    const { config } = makeConfig({ cache, launcher: launcher as AgentLauncher })
    const opts: AgentOptions = { label: 'test', phase: 'Scan' }
    const result = await executeAgentCall('prompt', opts, config)
    expect(result).toEqual({ cached: true })
    expect(launcher).not.toHaveBeenCalled()
  })

  it('runs provider preflight before returning a cached result', async () => {
    const cache: AgentCacheStore = {
      load: vi.fn(async () => ({ data: { cached: true } })),
      async save() {},
    };
    const launcher = vi.fn(async () => ({ data: { fresh: true } })) as unknown as AgentLauncher;
    launcher.preflight = vi.fn(async () => {
      throw Object.assign(new Error('runtime not configured'), {
        code: 'RUNTIME_NOT_CONFIGURED',
      });
    });
    const { config } = makeConfig({ cache, launcher });

    await expect(
      executeAgentCall('prompt', { label: 'test', phase: 'Scan' }, config),
    ).rejects.toMatchObject({ code: 'RUNTIME_NOT_CONFIGURED' });
    expect(cache.load).not.toHaveBeenCalled();
    expect(launcher).not.toHaveBeenCalled();
  });

  it('emits a failed lifecycle event when provider preflight rejects', async () => {
    const eventEmitter = vi.fn();
    const launcher = vi.fn(async () => ({ data: { fresh: true } })) as unknown as AgentLauncher;
    launcher.preflight = vi.fn(async () => {
      throw Object.assign(new Error('raw provider detail'), {
        code: 'RUNTIME_NOT_CONFIGURED',
      });
    });
    const { config } = makeConfig({ launcher });

    await expect(
      executeAgentCall(
        'prompt',
        { label: 'test', phase: 'Scan' },
        {
          ...config,
          eventEmitter,
          resolvedAgent: { agentId: 'test', source: 'registry' },
        },
      ),
    ).rejects.toMatchObject({ code: 'RUNTIME_NOT_CONFIGURED' });

    expect(eventEmitter).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent.conversation.failed',
        agentId: 'test',
        agentRunId: expect.stringMatching(/^RUN-/),
        error: expect.stringContaining('not configured'),
      }),
    );
    expect(eventEmitter).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent.conversation.started',
      }),
    );
  });

  it('calls launcher and returns result on cache miss', async () => {
    const launcher: AgentLauncher = async () => ({ data: { fresh: true }, tokenUsage: 10 })
    const cache: AgentCacheStore = {
      async load() { return null },
      save: vi.fn(),
    }
    const { config } = makeConfig({ cache, launcher })
    const opts: AgentOptions = { label: 'test', phase: 'Scan' }
    const result = await executeAgentCall('prompt', opts, config)
    expect(result).toEqual({ fresh: true })
  })

  it('updates budget after successful call', async () => {
    const { config, budget } = makeConfig()
    const opts: AgentOptions = { label: 'test', phase: 'Scan' }
    await executeAgentCall('prompt', opts, config)
    expect(budget.tokensUsed).toBe(10)
    expect(budget.agentCalls).toBe(1)
  })

  it('throws SchemaValidationError on schema mismatch', async () => {
    const { config } = makeConfig()
    const opts: AgentOptions = {
      label: 'test',
      phase: 'Scan',
      schema: { type: 'object', properties: { ok: { type: 'string' } } },
    }
    await expect(executeAgentCall('prompt', opts, config)).rejects.toThrow(SchemaValidationError)
  })

  it('passes schema validation for matching data', async () => {
    const launcher: AgentLauncher = async () => ({ data: { name: 'hello' }, tokenUsage: 5 })
    const { config } = makeConfig({ launcher })
    const opts: AgentOptions = {
      label: 'test',
      phase: 'Scan',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
    }
    const result = await executeAgentCall('prompt', opts, config)
    expect(result).toEqual({ name: 'hello' })
  })

  it('saves result to cache after successful call', async () => {
    const save = vi.fn()
    const cache: AgentCacheStore = { async load() { return null }, save }
    const launcher: AgentLauncher = async () => ({ data: { x: 1 }, tokenUsage: 5 })
    const { config } = makeConfig({ cache, launcher, cacheKey: 'my-cache-key' })
    const opts: AgentOptions = { label: 'test', phase: 'Scan' }
    await executeAgentCall('prompt', opts, config)
    expect(save).toHaveBeenCalledWith('test-run', 'my-cache-key', expect.objectContaining({ data: { x: 1 } }))
  })

  it('logs message on schema validation failure', async () => {
    const { config, log } = makeConfig()
    const opts: AgentOptions = {
      label: 'scan:test',
      phase: 'Scan',
      schema: { type: 'object', properties: { ok: { type: 'string' } } },
    }
    try {
      await executeAgentCall('prompt', opts, config)
    } catch {
      // expected
    }
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Schema validation failed'))
  })
})
