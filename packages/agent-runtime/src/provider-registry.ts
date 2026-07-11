import type { AgentExecutionAdapter } from './adapter.js';
import type { ResolvedAgentConfig } from './types.js';
import { RuntimeNotConfiguredError } from './types.js';

export type ProviderTransport = 'in-process' | 'external-command' | 'process' | 'test-fixture';

export interface ProviderResolution {
  providerId: string;
  transport: ProviderTransport;
  adapter: AgentExecutionAdapter;
}

export interface ProviderRegistration {
  id: string;
  resolve(config: ResolvedAgentConfig): ProviderResolution;
}

export class ProviderRegistryError extends Error {
  readonly code: 'DUPLICATE_PROVIDER' | 'INVALID_PROVIDER_ID' | 'INVALID_PROVIDER_RESOLUTION';

  constructor(code: ProviderRegistryError['code'], message: string) {
    super(message);
    this.name = 'ProviderRegistryError';
    this.code = code;
  }
}

/**
 * Instance-scoped provider registry. Launchers own their registry so tests and
 * independent runtime hosts cannot leak provider registrations into each other.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderRegistration>();

  register(registration: ProviderRegistration): void {
    const id = normalizeProviderId(registration.id);
    if (!id) {
      throw new ProviderRegistryError(
        'INVALID_PROVIDER_ID',
        'Provider ID must be a non-empty string.',
      );
    }
    if (this.providers.has(id)) {
      throw new ProviderRegistryError(
        'DUPLICATE_PROVIDER',
        `Provider "${id}" is already registered in this runtime.`,
      );
    }
    this.providers.set(id, { ...registration, id });
  }

  has(providerId: string): boolean {
    return this.providers.has(normalizeProviderId(providerId));
  }

  list(): string[] {
    return [...this.providers.keys()].sort();
  }

  resolve(config: ResolvedAgentConfig): ProviderResolution {
    const providerId = inferProviderId(config);
    if (!providerId) {
      throw new RuntimeNotConfiguredError(
        `Agent "${config.agentId}" has no runtime provider configured. Run openslack agent-runtime setup before retrying.`,
      );
    }

    const registration = this.providers.get(providerId);
    if (!registration) {
      throw new RuntimeNotConfiguredError(
        `Agent runtime provider "${providerId}" is not registered. Run openslack agent-runtime setup before retrying.`,
      );
    }

    const resolution = registration.resolve(config);
    validateResolution(providerId, resolution);
    return resolution;
  }
}

const PROVIDER_TRANSPORTS = new Set<ProviderTransport>([
  'in-process',
  'external-command',
  'process',
  'test-fixture',
]);

function validateResolution(providerId: string, resolution: ProviderResolution): void {
  if (
    !resolution ||
    normalizeProviderId(resolution.providerId) !== providerId ||
    !PROVIDER_TRANSPORTS.has(resolution.transport) ||
    !resolution.adapter ||
    typeof resolution.adapter.execute !== 'function'
  ) {
    throw new ProviderRegistryError(
      'INVALID_PROVIDER_RESOLUTION',
      `Provider "${providerId}" returned an invalid execution resolution.`,
    );
  }
}

export function inferProviderId(config: ResolvedAgentConfig): string | undefined {
  const runtimeProvider = normalizeProviderId(config.runtimeProvider);
  if (runtimeProvider) return runtimeProvider;

  const runtime = normalizeProviderId(config.runtime);
  if (runtime === 'aby' || runtime === 'aby_assistant') return 'aby';
  // Compatibility with legacy registry entries that used provider=aby.
  if (normalizeProviderId(config.provider) === 'aby') return 'aby';
  return undefined;
}

function normalizeProviderId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
