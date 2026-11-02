import { describe, expect, it, vi } from 'vitest';
import type { AgentExecutionAdapter } from '../index.js';
import {
  LocalExecutionAdapter,
  ProviderRegistry,
  ProviderRegistryError,
  RuntimeNotConfiguredError,
  inferProviderId,
} from '../index.js';
import { providerExecutionPolicy } from '../provider-registry.js';

function registration(id: string, adapter: AgentExecutionAdapter = new LocalExecutionAdapter()) {
  return {
    id,
    resolve: vi.fn(() => ({ providerId: id, transport: 'test-fixture' as const, adapter })),
  };
}

describe('ProviderRegistry', () => {
  it('binds lifecycle to trusted capabilities rather than the provider name and defaults unknown processes to preservation', () => {
    const adapter = new LocalExecutionAdapter();
    const capabilities = { requiresHostAcceptance: true, worktreeForFileWrites: true, preserveWorktree: true };
    expect(providerExecutionPolicy({ providerId: 'renamed-peer', transport: 'process', adapter, policy: capabilities })).toEqual(capabilities);
    expect(providerExecutionPolicy({ providerId: 'next-external-peer', transport: 'process', adapter }).preserveWorktree).toBe(true);
    expect(providerExecutionPolicy({ providerId: 'next-external-command', transport: 'external-command', adapter }).preserveWorktree).toBe(true);
    expect(providerExecutionPolicy({ providerId: 'aby', transport: 'process', adapter,
      policy: { requiresHostAcceptance: false, worktreeForFileWrites: true, preserveWorktree: false } }).preserveWorktree).toBe(false);
    const snapshot = providerExecutionPolicy({ providerId: 'renamed-peer', transport: 'process', adapter, policy: capabilities });
    capabilities.preserveWorktree = false;
    expect(snapshot.preserveWorktree).toBe(true);
  });
  it('rejects duplicate provider IDs in one registry', () => {
    const registry = new ProviderRegistry();
    registry.register(registration('fixture'));

    expect(() => registry.register(registration('FIXTURE'))).toThrow(ProviderRegistryError);
    expect(() => registry.register(registration('fixture'))).toThrow(/already registered/);
  });
  it('rejects Object.prototype names rather than treating them as lifecycle capabilities', () => {
    const adapter = new LocalExecutionAdapter();
    expect(() => providerExecutionPolicy({ providerId: 'fixture', transport: 'process', adapter,
      policy: JSON.parse('{"toString":false}') })).toThrow('known Boolean capabilities');
  });

  it('keeps registrations isolated between instances', () => {
    const first = new ProviderRegistry();
    const second = new ProviderRegistry();
    first.register(registration('fixture'));

    expect(first.has('fixture')).toBe(true);
    expect(second.has('fixture')).toBe(false);
    expect(() =>
      second.resolve({ agentId: 'agent', source: 'test', runtimeProvider: 'fixture' }),
    ).toThrow(RuntimeNotConfiguredError);
  });

  it('does not treat a model vendor as an execution provider', () => {
    const registry = new ProviderRegistry();
    registry.register(registration('anthropic'));

    expect(() =>
      registry.resolve({ agentId: 'agent', source: 'test', provider: 'anthropic' }),
    ).toThrow(RuntimeNotConfiguredError);
  });

  it('resolves an explicitly selected runtime provider', () => {
    const registry = new ProviderRegistry();
    const fixture = registration('fixture');
    registry.register(fixture);

    const result = registry.resolve({
      agentId: 'agent',
      source: 'test',
      runtimeProvider: 'fixture',
    });

    expect(result.providerId).toBe('fixture');
    expect(result.adapter).toBeInstanceOf(LocalExecutionAdapter);
    expect(fixture.resolve).toHaveBeenCalledTimes(1);
  });

  it('maps the legacy Aby runtime without using vendor.provider', () => {
    expect(
      inferProviderId({
        agentId: 'architect',
        source: 'registry',
        runtime: 'aby_assistant',
        provider: 'anthropic',
      }),
    ).toBe('aby');
  });

  it('rejects a malformed or mismatched provider resolution', () => {
    const registry = new ProviderRegistry();
    registry.register({
      id: 'fixture',
      resolve: () => ({
        providerId: 'different',
        transport: 'test-fixture',
        adapter: new LocalExecutionAdapter(),
      }),
    });

    expect(() =>
      registry.resolve({ agentId: 'agent', source: 'test', runtimeProvider: 'fixture' }),
    ).toThrow(/invalid execution resolution/);
  });
});
