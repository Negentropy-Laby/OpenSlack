import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import {
  verifyRequestSignature,
  verifyRequestTimestamp,
  mapActor,
  canExecuteSideEffects,
  buildDefaultActor,
  loadActorMappings,
} from '../authz.js';
import { createHmac } from 'node:crypto';
import type { ChatMessage } from '../types.js';

function makeSignature(secret: string, payload: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

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
  it('accepts valid HMAC signature', () => {
    const payload = '{"text":"hello"}';
    const secret = 'test-secret';
    const sig = makeSignature(secret, payload);
    expect(verifyRequestSignature(payload, sig, secret)).toBe(true);
  });

  it('rejects invalid signature', () => {
    const payload = '{"text":"hello"}';
    expect(verifyRequestSignature(payload, 'sha256=bad', 'secret')).toBe(false);
  });

  it('rejects when secret is missing', () => {
    expect(verifyRequestSignature('test', 'sig', '')).toBe(false);
  });

  it('rejects when signature is missing', () => {
    expect(verifyRequestSignature('test', undefined, 'secret')).toBe(false);
  });

  it('rejects when signature is empty string', () => {
    expect(verifyRequestSignature('test', '', 'secret')).toBe(false);
  });
});

describe('verifyRequestTimestamp', () => {
  it('accepts recent timestamp', () => {
    const now = String(Math.floor(Date.now() / 1000));
    expect(verifyRequestTimestamp(now)).toBe(true);
  });

  it('rejects old timestamp', () => {
    const old = String(Math.floor(Date.now() / 1000) - 400);
    expect(verifyRequestTimestamp(old)).toBe(false);
  });

  it('rejects missing timestamp', () => {
    expect(verifyRequestTimestamp(undefined)).toBe(false);
  });

  it('rejects non-numeric timestamp', () => {
    expect(verifyRequestTimestamp('not-a-number')).toBe(false);
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

  it('matches slack provider mappings for channel messages', () => {
    const msg = makeMsg('u1', 'channel');
    const mapped = mapActor(msg, [
      { providerUserId: 'u1', provider: 'slack', openslackActorId: 'alice', roles: ['write'] },
    ]);
    expect(mapped).toEqual({ id: 'alice', roles: ['write'] });
  });

  it('returns agent id for mapped agent actors', () => {
    const msg = makeMsg('u1', 'webhook');
    const mapped = mapActor(msg, [
      {
        providerUserId: 'u1',
        provider: 'webhook',
        openslackActorId: 'ci-agent',
        roles: ['write'],
        agentId: 'test_agent',
      },
    ]);
    expect(mapped).toEqual({ id: 'ci-agent', roles: ['write'], agentId: 'test_agent' });
  });
});

describe('loadActorMappings', () => {
  it('loads JSON actor mapping files', () => {
    const root = join(
      tmpdir(),
      `openslack-chat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(root, { recursive: true });
    const path = join(root, 'actors.json');
    writeFileSync(
      path,
      JSON.stringify({
        mappings: [
          {
            providerUserId: 'u1',
            provider: 'slack',
            openslackActorId: 'alice',
            roles: ['read', 'write'],
            agentId: 'test_agent',
          },
        ],
      }),
      'utf-8',
    );
    try {
      expect(loadActorMappings(path)).toEqual([
        {
          providerUserId: 'u1',
          provider: 'slack',
          openslackActorId: 'alice',
          roles: ['read', 'write'],
          agentId: 'test_agent',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('canExecuteSideEffects', () => {
  it('allows write role when read-only by default', () => {
    expect(canExecuteSideEffects({ id: 'a', roles: ['write'] }, { readOnlyByDefault: true })).toBe(
      true,
    );
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
