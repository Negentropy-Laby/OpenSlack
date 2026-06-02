import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AgentConversationThread,
  AgentConversationMessage,
  NewConversationMessage,
  AgentParticipant,
  ConversationLinkedObject,
  ConversationStatus,
  MemoryPolicy,
} from './conversation-types.js';
import { scanValue } from './redact.js';

const CONVERSATIONS_DIR_NAME = 'conversations';

// M2: Path traversal protection — thread IDs must match the generated format
const THREAD_ID_RE = /^CONV-[A-Z0-9-]+$/;

function validateThreadId(id: string): void {
  if (typeof id !== 'string' || !THREAD_ID_RE.test(id)) {
    throw new Error(`Invalid thread ID: "${id}". Must match CONV-YYYYMMDD-XXXX format.`);
  }
}

function getConversationsBaseDir(rootDir?: string): string {
  return join(rootDir ?? process.cwd(), '.openslack.local', CONVERSATIONS_DIR_NAME);
}

function getThreadDir(threadId: string, rootDir?: string): string {
  return join(getConversationsBaseDir(rootDir), threadId);
}

function getThreadMetaPath(threadId: string, rootDir?: string): string {
  return join(getThreadDir(threadId, rootDir), 'thread.json');
}

function getMessagesPath(threadId: string, rootDir?: string): string {
  return join(getThreadDir(threadId, rootDir), 'messages.jsonl');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function generateThreadId(): string {
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `CONV-${ts}-${rand}`;
}

function generateMessageId(): string {
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  return `MSG-${ts}-${rand}`;
}

export function createThread(options: {
  title: string;
  participants?: AgentParticipant[];
  linkedObjects?: ConversationLinkedObject[];
  memoryPolicy?: MemoryPolicy;
  rootDir?: string;
}): AgentConversationThread {
  const rootDir = options.rootDir;
  const now = new Date().toISOString();
  const thread: AgentConversationThread = {
    id: generateThreadId(),
    schema: 'openslack.agent_conversation_thread.v1',
    title: options.title,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    participants: options.participants || [],
    linkedObjects: options.linkedObjects || [],
    memoryPolicy: options.memoryPolicy || 'local',
  };

  const threadDir = getThreadDir(thread.id, rootDir);
  ensureDir(threadDir);

  // Secret-scanning — scan thread metadata before persisting
  const titleScan = scanValue(options.title, 'title');
  if (titleScan.found) {
    throw new Error(
      `Thread title contains ${titleScan.name} at ${titleScan.path}. Refusing to persist.`,
    );
  }
  if (options.participants) {
    const participantScan = scanValue(options.participants, 'participants');
    if (participantScan.found) {
      throw new Error(
        `Thread participants contain ${participantScan.name} at ${participantScan.path}. Refusing to persist.`,
      );
    }
  }
  if (options.linkedObjects) {
    const linkedScan = scanValue(options.linkedObjects, 'linkedObjects');
    if (linkedScan.found) {
      throw new Error(
        `Thread linked objects contain ${linkedScan.name} at ${linkedScan.path}. Refusing to persist.`,
      );
    }
  }

  writeFileSync(getThreadMetaPath(thread.id, rootDir), JSON.stringify(thread, null, 2), 'utf-8');

  return thread;
}

export function listThreads(options?: {
  status?: ConversationStatus;
  rootDir?: string;
}): AgentConversationThread[] {
  const baseDir = getConversationsBaseDir(options?.rootDir);
  if (!existsSync(baseDir)) return [];

  const threads: AgentConversationThread[] = [];

  const entries = readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const metaPath = join(baseDir, entry.name, 'thread.json');
    if (!existsSync(metaPath)) continue;

    try {
      const raw = readFileSync(metaPath, 'utf-8');
      const parsed = JSON.parse(raw) as AgentConversationThread;
      if (parsed.schema === 'openslack.agent_conversation_thread.v1' && parsed.id) {
        if (!options?.status || parsed.status === options.status) {
          threads.push(parsed);
        }
      }
    } catch {
      // Skip malformed files
    }
  }

  return threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getThread(
  threadId: string,
  rootDir?: string,
): { thread: AgentConversationThread; messages: AgentConversationMessage[] } | null {
  validateThreadId(threadId);
  const metaPath = getThreadMetaPath(threadId, rootDir);
  if (!existsSync(metaPath)) return null;

  let thread: AgentConversationThread;
  try {
    const raw = readFileSync(metaPath, 'utf-8');
    const parsed = JSON.parse(raw) as AgentConversationThread;
    if (parsed.schema !== 'openslack.agent_conversation_thread.v1' || parsed.id !== threadId) {
      return null;
    }
    thread = parsed;
  } catch {
    return null;
  }

  const messagesPath = getMessagesPath(threadId, rootDir);
  const messages: AgentConversationMessage[] = [];

  if (existsSync(messagesPath)) {
    const raw = readFileSync(messagesPath, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.trim() !== '');

    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as AgentConversationMessage);
      } catch {
        // Skip malformed lines
      }
    }
  }

  return { thread, messages };
}

export function appendMessage(
  threadId: string,
  message: NewConversationMessage,
  rootDir?: string,
): AgentConversationMessage {
  validateThreadId(threadId);
  const metaPath = getThreadMetaPath(threadId, rootDir);
  if (!existsSync(metaPath)) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  // M1: Secret-scanning — reject messages containing secrets before persisting
  const scan = scanValue(message, 'message');
  if (scan.found) {
    throw new Error(`Message contains ${scan.name} at ${scan.path}. Refusing to persist.`);
  }

  const now = new Date().toISOString();
  const fullMessage = {
    ...message,
    id: generateMessageId(),
    timestamp: now,
  } as AgentConversationMessage;

  // M3: memoryPolicy controls persistence — 'none' means messages are not written to disk
  // Read thread metadata once for memoryPolicy + update updatedAt and status atomically
  try {
    updateThreadMeta(metaPath, (existing) => {
      const threadMemoryPolicy = existing.memoryPolicy || 'local';
      if (threadMemoryPolicy !== 'none') {
        const messagesPath = getMessagesPath(threadId, rootDir);
        appendFileSync(messagesPath, JSON.stringify(fullMessage) + '\n', 'utf-8');
      }
      existing.updatedAt = now;
      if (existing.status === 'open') {
        existing.status = 'active';
      }
      return existing;
    });
  } catch (err) {
    throw new Error(`Failed to read thread metadata for ${threadId}: ${(err as Error).message}`);
  }

  return fullMessage;
}

export function archiveThread(threadId: string, rootDir?: string): boolean {
  validateThreadId(threadId);
  const metaPath = getThreadMetaPath(threadId, rootDir);
  if (!existsSync(metaPath)) return false;

  try {
    const result = updateThreadMeta(metaPath, (thread) => {
      if (thread.status === 'archived') return null; // signal: no write needed
      thread.status = 'archived';
      thread.updatedAt = new Date().toISOString();
      return thread;
    });
    return result !== null;
  } catch {
    return false;
  }
}

/**
 * Link an agent run to a conversation thread by adding it to the thread's
 * linked objects.
 */
export function linkRunToThread(threadId: string, runId: string, rootDir?: string): boolean {
  validateThreadId(threadId);
  const metaPath = getThreadMetaPath(threadId, rootDir);
  if (!existsSync(metaPath)) return false;

  try {
    const result = updateThreadMeta(metaPath, (thread) => {
      const alreadyLinked = thread.linkedObjects.some(
        (o) => o.kind === 'workflow_run' && o.id === runId,
      );
      if (alreadyLinked) return null;

      thread.linkedObjects.push({ kind: 'workflow_run', id: runId });
      thread.updatedAt = new Date().toISOString();
      return thread;
    });
    return result !== null;
  } catch {
    return false;
  }
}

// M3: Policy-aware TTL — different retention based on memoryPolicy
function getMaxAgeForPolicy(policy: MemoryPolicy, defaultMs: number): number {
  switch (policy) {
    case 'project':
      return defaultMs * 7; // 7 days for project-scoped threads
    case 'none':
      return Math.floor(defaultMs / 2); // 12h for ephemeral threads
    case 'local':
      return defaultMs; // 24h default for local threads
    default:
      return defaultMs;
  }
}

/**
 * Atomic read-modify-write for thread metadata with retry on conflict.
 * The modifier callback receives the parsed thread and must return the modified
 * thread to write, or null to signal "no write needed".
 * Returns the final written thread, or null if the modifier returned null.
 */
function updateThreadMeta(
  metaPath: string,
  modifier: (thread: AgentConversationThread) => AgentConversationThread | null,
  maxRetries: number = 3,
): AgentConversationThread | null {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const raw = readFileSync(metaPath, 'utf-8');
    const existing = JSON.parse(raw) as AgentConversationThread;

    const modified = modifier(existing);
    if (modified === null) return null;

    writeFileSync(metaPath, JSON.stringify(modified, null, 2), 'utf-8');
    return modified;
  }
  throw new Error(`Failed to update thread metadata after ${maxRetries} retries: ${metaPath}`);
}

export function pruneExpiredThreads(maxAgeMs?: number, rootDir?: string): number {
  const defaultMaxAge = maxAgeMs ?? 24 * 60 * 60 * 1000; // default 24h
  const baseDir = getConversationsBaseDir(rootDir);
  if (!existsSync(baseDir)) return 0;

  const now = Date.now();
  let removed = 0;

  const entries = readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const metaPath = join(baseDir, entry.name, 'thread.json');
    if (!existsSync(metaPath)) continue;

    try {
      const raw = readFileSync(metaPath, 'utf-8');
      const thread = JSON.parse(raw) as AgentConversationThread;

      const threadTime = new Date(thread.updatedAt).getTime();
      const maxAge = getMaxAgeForPolicy(thread.memoryPolicy || 'local', defaultMaxAge);
      if (now - threadTime > maxAge) {
        const threadDir = join(baseDir, entry.name);
        rmSync(threadDir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // Skip malformed entries
    }
  }

  return removed;
}

export function getConversationsDirForTesting(rootDir?: string): string {
  return getConversationsBaseDir(rootDir);
}
