import { createHash } from 'node:crypto'
import type { AgentOptions } from './types.js'

/**
 * Cache entry stored on disk for agent results.
 */
export interface CacheEntry {
  key: string
  timestamp: string
  result: unknown
  tokenUsage?: number
  schemaVersion?: string
}

/**
 * Abstraction for cache storage operations.
 * Production uses RunStore-backed file paths; tests use in-memory maps.
 */
export interface CacheStore {
  /** Load a cached entry. Returns null on miss. */
  get(key: string): Promise<CacheEntry | null>
  /** Save a cache entry. */
  set(key: string, entry: CacheEntry): Promise<void>
  /** Remove a specific cache entry. Returns true if it existed. */
  invalidate(key: string): Promise<boolean>
  /** Invalidate all entries matching a prefix. Returns count of removed entries. */
  invalidateByPrefix(prefix: string): Promise<number>
}

/**
 * In-memory CacheStore implementation for testing.
 */
export class MemoryCacheStore implements CacheStore {
  private readonly store = new Map<string, CacheEntry>()

  async get(key: string): Promise<CacheEntry | null> {
    return this.store.get(key) ?? null
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    this.store.set(key, entry)
  }

  async invalidate(key: string): Promise<boolean> {
    return this.store.delete(key)
  }

  async invalidateByPrefix(prefix: string): Promise<number> {
    let count = 0
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key)
        count++
      }
    }
    return count
  }

  /** Get current cache size (test helper). */
  get size(): number {
    return this.store.size
  }

  /** Check if a key exists (test helper). */
  has(key: string): boolean {
    return this.store.has(key)
  }
}

/**
 * Hash a string using a fast non-cryptographic approach for cache key components.
 * Returns a hex string (first 12 chars of SHA-256).
 */
export function hashString(input: string): string {
  return createHash('sha256')
    .update(input)
    .digest('hex')
    .slice(0, 12)
}

/**
 * Compute a deterministic cache key for an agent call.
 *
 * Key format: `manifestHash:phase:label:promptHash:optsHash`
 *
 * This replaces the simpler computeAgentCacheKey from agent-shim.ts
 * with a more robust version that includes serialized options.
 */
export function computeCacheKey(
  manifestHash: string,
  phase: string,
  label: string,
  prompt: string,
  opts?: AgentOptions,
): string {
  const promptHash = hashString(prompt)
  const optsHash = opts ? hashString(JSON.stringify(opts)) : 'no-opts'
  return `${manifestHash}:${phase}:${label}:${promptHash}:${optsHash}`
}

/**
 * Get a cache entry. Delegates to the provided store.
 */
export async function getCacheEntry(
  store: CacheStore,
  key: string,
): Promise<CacheEntry | null> {
  return store.get(key)
}

/**
 * Save a result as a cache entry.
 */
export async function setCacheEntry(
  store: CacheStore,
  key: string,
  result: unknown,
  tokenUsage?: number,
): Promise<void> {
  const entry: CacheEntry = {
    key,
    timestamp: new Date().toISOString(),
    result,
    tokenUsage,
    schemaVersion: '1',
  }
  await store.set(key, entry)
}

/**
 * Invalidate a specific cache entry.
 */
export async function invalidateCacheEntry(
  store: CacheStore,
  key: string,
): Promise<boolean> {
  return store.invalidate(key)
}

/**
 * Invalidate all cache entries for a given manifest hash.
 * Useful when a workflow source file changes.
 */
export async function invalidateByManifestHash(
  store: CacheStore,
  manifestHash: string,
): Promise<number> {
  return store.invalidateByPrefix(`${manifestHash}:`)
}

/**
 * Create a new CacheStore instance (in-memory by default).
 */
export function createCacheStore(): MemoryCacheStore {
  return new MemoryCacheStore()
}
