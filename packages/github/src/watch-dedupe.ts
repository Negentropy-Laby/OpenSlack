import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedIssueEvent } from './issue-normalizer.js';
import type { NormalizedPushEvent } from './push-normalizer.js';

interface DedupeEntry {
  deliveryId: string;
  stableKey: string;
  timestamp: string;
}

export class WatchDedupeStore {
  private readonly filePath: string;
  private cache: Set<string> | null = null;

  constructor(stateDir?: string) {
    const dir = stateDir ?? join(process.cwd(), '.openslack.local', 'daemon');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, 'dedupe.jsonl');
  }

  private load(): Set<string> {
    if (this.cache) return this.cache;
    const keys = new Set<string>();
    try {
      if (existsSync(this.filePath)) {
        const lines = readFileSync(this.filePath, 'utf-8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as DedupeEntry;
            keys.add(entry.deliveryId);
            keys.add(entry.stableKey);
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch {
      // empty store
    }
    this.cache = keys;
    return keys;
  }

  isDuplicate(deliveryId: string): boolean {
    return this.load().has(deliveryId);
  }

  isDuplicateByStableKey(key: string): boolean {
    return this.load().has(key);
  }

  record(deliveryId: string | undefined, stableKey: string): void {
    const keys = this.load();
    if (deliveryId) keys.add(deliveryId);
    keys.add(stableKey);
    const entry: DedupeEntry = {
      deliveryId: deliveryId ?? '',
      stableKey,
      timestamp: new Date().toISOString(),
    };
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf-8');
  }

  buildStableKey(event: NormalizedIssueEvent): string {
    return `github:issue:${event.owner}/${event.repo}#${event.issueNumber}:${event.action}:${event.updatedAt}`;
  }

  buildPushStableKey(event: NormalizedPushEvent): string {
    return `github:push:${event.owner}/${event.repo}:${event.ref}:${event.after}`;
  }

  getStats(): { count: number; lastTimestamp?: string } {
    let count = 0;
    let lastTimestamp: string | undefined;
    try {
      if (existsSync(this.filePath)) {
        const lines = readFileSync(this.filePath, 'utf-8').split('\n').filter(Boolean);
        count = lines.length;
        if (lines.length > 0) {
          try {
            const last = JSON.parse(lines[lines.length - 1]) as DedupeEntry;
            lastTimestamp = last.timestamp;
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // empty
    }
    return { count, lastTimestamp };
  }

  clearCache(): void {
    this.cache = null;
  }
}
