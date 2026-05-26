import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Intent } from './types.js';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  intent?: Intent;
  timestamp: string;
}

export interface Conversation {
  sessionId: string;
  turns: ConversationTurn[];
  createdAt: string;
  updatedAt: string;
}

const CONVERSATION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TURNS = 50;
const SESSION_ENV = 'OPENSLACK_SESSION_ID';

export function generateSessionId(): string {
  return process.env[SESSION_ENV] || `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getStoreDir(root = process.cwd()): string {
  const dir = join(root, '.openslack.local', 'operator', 'conversations');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getConversationPath(sessionId: string, root = process.cwd()): string {
  return join(getStoreDir(root), `${sessionId}.json`);
}

export function appendTurn(
  sessionId: string,
  turn: ConversationTurn,
  root = process.cwd(),
): Conversation {
  const path = getConversationPath(sessionId, root);
  let conversation: Conversation;
  if (existsSync(path)) {
    conversation = JSON.parse(readFileSync(path, 'utf-8')) as Conversation;
  } else {
    conversation = {
      sessionId,
      turns: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  conversation.turns.push(turn);
  if (conversation.turns.length > MAX_TURNS) {
    conversation.turns = conversation.turns.slice(-MAX_TURNS);
  }
  conversation.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(conversation, null, 2), 'utf-8');
  return conversation;
}

export function loadConversation(sessionId: string, root = process.cwd()): Conversation | null {
  const path = getConversationPath(sessionId, root);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Conversation;
  } catch {
    return null;
  }
}

export function listConversations(root = process.cwd()): Conversation[] {
  const dir = getStoreDir(root);
  const conversations: Conversation[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const conv = loadConversation(name.replace(/\.json$/, ''), root);
        if (conv) conversations.push(conv);
      } catch { /* skip corrupt files */ }
    }
  } catch { /* dir doesn't exist yet */ }
  return conversations.sort((a, b) =>
    new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

export function pruneExpiredConversations(root = process.cwd()): number {
  const now = Date.now();
  let pruned = 0;
  const dir = getStoreDir(root);
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const sessionId = name.replace(/\.json$/, '');
      const conv = loadConversation(sessionId, root);
      if (conv && (now - new Date(conv.updatedAt).getTime()) > CONVERSATION_TTL_MS) {
        const path = getConversationPath(sessionId, root);
        if (existsSync(path)) { unlinkSync(path); pruned++; }
      }
    }
  } catch { /* nothing to prune */ }
  return pruned;
}

export function getRecentTurns(sessionId: string, limit = 10, root = process.cwd()): ConversationTurn[] {
  const conv = loadConversation(sessionId, root);
  if (!conv) return [];
  return conv.turns.slice(-limit);
}
