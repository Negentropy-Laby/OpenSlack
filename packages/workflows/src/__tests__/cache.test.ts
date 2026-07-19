import { describe, it, expect } from 'vitest';
import {
  computeCacheKey,
  hashString,
  getCacheEntry,
  setCacheEntry,
  invalidateCacheEntry,
  invalidateByManifestHash,
  MemoryCacheStore,
  createCacheStore,
} from '../cache.js';
import type { AgentOptions } from '../types.js';

describe('hashString', () => {
  it('returns a non-empty string', () => {
    const hash = hashString('test');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('returns a 12-char hex string', () => {
    const hash = hashString('test');
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic', () => {
    const h1 = hashString('hello world');
    const h2 = hashString('hello world');
    expect(h1).toBe(h2);
  });

  it('differs for different inputs', () => {
    const h1 = hashString('input-a');
    const h2 = hashString('input-b');
    expect(h1).not.toBe(h2);
  });
});

describe('computeCacheKey', () => {
  it('produces a key with all components', () => {
    const key = computeCacheKey('mh1', 'Scan', 'label1', 'prompt text');
    const parts = key.split(':');
    // manifestHash:phase:label:promptHash:optsHash
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('mh1');
    expect(parts[1]).toBe('Scan');
    expect(parts[2]).toBe('label1');
  });

  it('is deterministic for same inputs', () => {
    const k1 = computeCacheKey('mh', 'Scan', 'l', 'prompt');
    const k2 = computeCacheKey('mh', 'Scan', 'l', 'prompt');
    expect(k1).toBe(k2);
  });

  it('differs for different manifest hashes', () => {
    const k1 = computeCacheKey('hash-a', 'Scan', 'l', 'p');
    const k2 = computeCacheKey('hash-b', 'Scan', 'l', 'p');
    expect(k1).not.toBe(k2);
  });

  it('differs for different phases', () => {
    const k1 = computeCacheKey('mh', 'Scan', 'l', 'p');
    const k2 = computeCacheKey('mh', 'Verify', 'l', 'p');
    expect(k1).not.toBe(k2);
  });

  it('differs for different labels', () => {
    const k1 = computeCacheKey('mh', 'Scan', 'label-a', 'p');
    const k2 = computeCacheKey('mh', 'Scan', 'label-b', 'p');
    expect(k1).not.toBe(k2);
  });

  it('differs for different prompts', () => {
    const k1 = computeCacheKey('mh', 'Scan', 'l', 'prompt-a');
    const k2 = computeCacheKey('mh', 'Scan', 'l', 'prompt-b');
    expect(k1).not.toBe(k2);
  });

  it('uses "no-opts" when options are not provided', () => {
    const key = computeCacheKey('mh', 'Scan', 'l', 'p');
    expect(key).toContain(':no-opts');
  });

  it('includes opts hash when options are provided', () => {
    const opts: AgentOptions = { label: 'test', phase: 'Scan' };
    const key = computeCacheKey('mh', 'Scan', 'l', 'p', opts);
    const parts = key.split(':');
    expect(parts[4]).not.toBe('no-opts');
    expect(parts[4].length).toBeGreaterThan(0);
  });

  it('differs for different options', () => {
    const opts1: AgentOptions = { label: 'test', phase: 'Scan' };
    const opts2: AgentOptions = { label: 'test', phase: 'Verify' };
    const k1 = computeCacheKey('mh', 'Scan', 'l', 'p', opts1);
    const k2 = computeCacheKey('mh', 'Scan', 'l', 'p', opts2);
    expect(k1).not.toBe(k2);
  });
});

describe('MemoryCacheStore', () => {
  it('starts empty', () => {
    const store = new MemoryCacheStore();
    expect(store.size).toBe(0);
  });

  it('stores and retrieves entries', async () => {
    const store = new MemoryCacheStore();
    const entry = { key: 'k1', timestamp: '2026-01-01', result: { x: 1 } };
    await store.set('k1', entry);
    const loaded = await store.get('k1');
    expect(loaded).toEqual(entry);
  });

  it('returns null for missing key', async () => {
    const store = new MemoryCacheStore();
    const loaded = await store.get('missing');
    expect(loaded).toBeNull();
  });

  it('invalidates an existing key', async () => {
    const store = new MemoryCacheStore();
    await store.set('k1', { key: 'k1', timestamp: '', result: null });
    const removed = await store.invalidate('k1');
    expect(removed).toBe(true);
    expect(store.has('k1')).toBe(false);
  });

  it('returns false when invalidating non-existent key', async () => {
    const store = new MemoryCacheStore();
    const removed = await store.invalidate('nope');
    expect(removed).toBe(false);
  });

  it('invalidates by prefix', async () => {
    const store = new MemoryCacheStore();
    await store.set('abc:Scan:l1', { key: 'abc:Scan:l1', timestamp: '', result: 1 });
    await store.set('abc:Verify:l2', { key: 'abc:Verify:l2', timestamp: '', result: 2 });
    await store.set('def:Scan:l3', { key: 'def:Scan:l3', timestamp: '', result: 3 });

    const count = await store.invalidateByPrefix('abc:');
    expect(count).toBe(2);
    expect(store.size).toBe(1);
    expect(store.has('def:Scan:l3')).toBe(true);
  });

  it('returns 0 when no entries match prefix', async () => {
    const store = new MemoryCacheStore();
    await store.set('abc:1', { key: 'abc:1', timestamp: '', result: null });
    const count = await store.invalidateByPrefix('xyz:');
    expect(count).toBe(0);
  });
});

describe('getCacheEntry / setCacheEntry', () => {
  it('returns null on cache miss', async () => {
    const store = new MemoryCacheStore();
    const entry = await getCacheEntry(store, 'missing');
    expect(entry).toBeNull();
  });

  it('stores and retrieves an entry', async () => {
    const store = new MemoryCacheStore();
    await setCacheEntry(store, 'k1', { data: true }, 50);
    const entry = await getCacheEntry(store, 'k1');
    expect(entry).not.toBeNull();
    expect(entry!.result).toEqual({ data: true });
    expect(entry!.tokenUsage).toBe(50);
    expect(entry!.timestamp).toBeDefined();
    expect(entry!.schemaVersion).toBe('1');
  });
});

describe('invalidateCacheEntry', () => {
  it('removes an existing entry', async () => {
    const store = new MemoryCacheStore();
    await setCacheEntry(store, 'k1', 'result');
    const removed = await invalidateCacheEntry(store, 'k1');
    expect(removed).toBe(true);
    expect(await getCacheEntry(store, 'k1')).toBeNull();
  });
});

describe('invalidateByManifestHash', () => {
  it('removes all entries for a manifest hash', async () => {
    const store = new MemoryCacheStore();
    await setCacheEntry(store, 'abc:Scan:l1:h1:o1', 'r1');
    await setCacheEntry(store, 'abc:Verify:l2:h2:o2', 'r2');
    await setCacheEntry(store, 'def:Scan:l3:h3:o3', 'r3');

    const count = await invalidateByManifestHash(store, 'abc');
    expect(count).toBe(2);
    expect(store.size).toBe(1);
  });
});

describe('createCacheStore', () => {
  it('returns a MemoryCacheStore instance', () => {
    const store = createCacheStore();
    expect(store).toBeInstanceOf(MemoryCacheStore);
  });
});
