import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generateSessionId,
  appendTurn,
  loadConversation,
  listConversations,
  pruneExpiredConversations,
  getRecentTurns,
} from '../conversation-store.js';
import type { ConversationTurn } from '../conversation-store.js';

const TMP_ROOT = join(process.cwd(), '.test-conversation-store');

function makeTurn(role: 'user' | 'assistant', content: string, timestamp?: string): ConversationTurn {
  return { role, content, timestamp: timestamp ?? new Date().toISOString() };
}

beforeEach(() => {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true });
});

describe('generateSessionId', () => {
  it('uses env variable when set', () => {
    process.env.OPENSLACK_SESSION_ID = 'test-sess-123';
    const id = generateSessionId();
    expect(id).toBe('test-sess-123');
    delete process.env.OPENSLACK_SESSION_ID;
  });

  it('generates unique ids', () => {
    const a = generateSessionId();
    const b = generateSessionId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^sess-/);
  });
});

describe('appendTurn', () => {
  it('creates conversation on first turn', () => {
    const sid = generateSessionId();
    const conv = appendTurn(sid, makeTurn('user', 'hello'), TMP_ROOT);
    expect(conv.sessionId).toBe(sid);
    expect(conv.turns).toHaveLength(1);
    expect(conv.turns[0].content).toBe('hello');
  });

  it('appends to existing conversation', () => {
    const sid = generateSessionId();
    appendTurn(sid, makeTurn('user', 'hello'), TMP_ROOT);
    const conv = appendTurn(sid, makeTurn('assistant', 'hi there'), TMP_ROOT);
    expect(conv.turns).toHaveLength(2);
    expect(conv.turns[1].role).toBe('assistant');
  });

  it('prunes to max 50 turns', () => {
    const sid = generateSessionId();
    let conv;
    for (let i = 0; i < 55; i++) {
      conv = appendTurn(sid, makeTurn('user', `msg ${i}`), TMP_ROOT);
    }
    expect(conv!.turns).toHaveLength(50);
    expect(conv!.turns[0].content).toBe('msg 5');
  });
});

describe('loadConversation', () => {
  it('returns null for non-existent session', () => {
    const conv = loadConversation('nonexistent', TMP_ROOT);
    expect(conv).toBeNull();
  });

  it('loads persisted conversation', () => {
    const sid = generateSessionId();
    appendTurn(sid, makeTurn('user', 'test'), TMP_ROOT);
    const loaded = loadConversation(sid, TMP_ROOT);
    expect(loaded).not.toBeNull();
    expect(loaded!.turns).toHaveLength(1);
  });
});

describe('listConversations', () => {
  it('returns empty when no conversations', () => {
    const list = listConversations(TMP_ROOT);
    expect(list).toEqual([]);
  });

  it('lists conversations sorted by updatedAt desc', () => {
    const sid1 = generateSessionId();
    const sid2 = generateSessionId();
    appendTurn(sid1, makeTurn('user', 'first'), TMP_ROOT);
    // Force sid1 to be older so sort is deterministic even under fast clocks
    const conv1Path = join(TMP_ROOT, '.openslack.local', 'operator', 'conversations', `${sid1}.json`);
    const conv1 = JSON.parse(readFileSync(conv1Path, 'utf-8'));
    conv1.updatedAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(conv1Path, JSON.stringify(conv1, null, 2), 'utf-8');
    appendTurn(sid2, makeTurn('user', 'second'), TMP_ROOT);
    const list = listConversations(TMP_ROOT);
    expect(list).toHaveLength(2);
    expect(list[0].sessionId).toBe(sid2);
  });
});

describe('getRecentTurns', () => {
  it('returns empty for non-existent session', () => {
    const turns = getRecentTurns('nonexistent', 5, TMP_ROOT);
    expect(turns).toEqual([]);
  });

  it('returns last N turns', () => {
    const sid = generateSessionId();
    for (let i = 0; i < 10; i++) {
      appendTurn(sid, makeTurn('user', `msg ${i}`), TMP_ROOT);
    }
    const recent = getRecentTurns(sid, 3, TMP_ROOT);
    expect(recent).toHaveLength(3);
    expect(recent[0].content).toBe('msg 7');
    expect(recent[2].content).toBe('msg 9');
  });
});

describe('pruneExpiredConversations', () => {
  it('removes conversations older than 24h', () => {
    const sid = generateSessionId();
    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const turn: ConversationTurn = { role: 'user', content: 'old', timestamp: oldTimestamp };

    // Manually create with old updatedAt
    const conv = appendTurn(sid, turn, TMP_ROOT);
    const convPath = join(TMP_ROOT, '.openslack.local', 'operator', 'conversations', `${sid}.json`);
    const stale = { ...conv, updatedAt: oldTimestamp };
    writeFileSync(convPath, JSON.stringify(stale, null, 2), 'utf-8');

    const pruned = pruneExpiredConversations(TMP_ROOT);
    expect(pruned).toBe(1);
    expect(loadConversation(sid, TMP_ROOT)).toBeNull();
  });
});
