import { createHash } from 'node:crypto';

interface ProcessedEntry {
  messageId: string;
  hash: string;
  timestamp: string;
}

const processed = new Map<string, ProcessedEntry>();
const MAX_ENTRIES = 10000;

function hashMessage(text: string, userId: string, channelId: string): string {
  return createHash('sha256').update(`${userId}:${channelId}:${text}`).digest('hex');
}

export function isDuplicate(
  messageId: string,
  text: string,
  userId: string,
  channelId: string,
): boolean {
  // Check by message ID
  if (processed.has(messageId)) return true;

  // Check by content hash
  const hash = hashMessage(text, userId, channelId);
  for (const entry of processed.values()) {
    if (entry.hash === hash) return true;
  }

  return false;
}

export function markProcessed(
  messageId: string,
  text: string,
  userId: string,
  channelId: string,
): void {
  const hash = hashMessage(text, userId, channelId);
  processed.set(messageId, {
    messageId,
    hash,
    timestamp: new Date().toISOString(),
  });

  // Prune old entries if exceeding max
  if (processed.size > MAX_ENTRIES) {
    const oldest = processed.keys().next().value;
    if (oldest) processed.delete(oldest);
  }
}

export function getProcessedCount(): number {
  return processed.size;
}

export function clearStore(): void {
  processed.clear();
}
