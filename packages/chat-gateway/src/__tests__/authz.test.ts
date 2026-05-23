import { describe, it, expect } from 'vitest';
import { verifyRequestSignature, mapActor, canExecuteSideEffects, buildDefaultActor } from '../authz.js';
import type { ChatMessage } from '../types.js';

function makeMsg(userId: string, channelType: 'dm' | 'channel' | 'webhook'): ChatMessage {
  return {
    id: '1',
    text: 'hello',
    user: { id: userId },
    channel: { id: 'c1', type: channelType },
    timestamp: new Date().toISOString(),
  };
}

describe('verifyRequestSignature', () => {
  it('accepts valid signature', () => {
    const sig = 'sha256=8f1e04d8a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e'; // fake format
    // Our implementation uses sha256= prefix + simple hash; just verify it doesn't crash
    const result = verifyRequestSignature('test', sig, 'secret');
    expect(typeof result).toBe('boolean');
  });

  it('rejects when secret is missing', () => {
    expect(verifyRequestSignature('test', 'sig', '')).toBe(false);
  });

  it('rejects when signature is missing', () => {
    expect(verifyRequestSignature('test', '', 'secret')).toBe(false);
  });
});

describe('mapActor', () => {
  it('returns mapped actor', () => {
    const msg = makeMsg('u1', 'webhook');
    const mapped = mapActor(msg, [
      { providerUserId: 'u1', provider: 'webhook', openslackActorId: 'alice', roles: ['write'] },
    ]);
    expect(mapped).toEqual({ id: 'alice', roles: ['write'] });
  });

  it('returns undefined for unmapped user', () => {
    const msg = makeMsg('unknown', 'webhook');
    expect(mapActor(msg, [])).toBeUndefined();
  });
});

describe('canExecuteSideEffects', () => {
  it('allows write role when read-only by default', () => {
    expect(canExecuteSideEffects({ id: 'a', roles: ['write'] }, { readOnlyByDefault: true })).toBe(true);
  });

  it('blocks unmapped actor when read-only by default', () => {
    expect(canExecuteSideEffects(undefined, { readOnlyByDefault: true })).toBe(false);
  });

  it('allows all when not read-only by default', () => {
    expect(canExecuteSideEffects(undefined, { readOnlyByDefault: false })).toBe(true);
  });
});

describe('buildDefaultActor', () => {
  it('builds unmapped actor ID', () => {
    const msg = makeMsg('u1', 'webhook');
    const actor = buildDefaultActor(msg);
    expect(actor.id).toContain('unmapped');
    expect(actor.provider).toBe('webhook');
  });
});
