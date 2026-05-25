import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WatchDedupeStore } from '../watch-dedupe.js';
import type { NormalizedIssueEvent } from '../issue-normalizer.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'openslack-dedupe-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const baseEvent: NormalizedIssueEvent = {
  action: 'opened',
  owner: 'Negentropy-Laby',
  repo: 'OpenSlack',
  issueNumber: 42,
  title: 'Test',
  url: '',
  labels: [],
  body: '',
  senderLogin: 'bot',
  deliveryId: 'delivery-001',
  updatedAt: '2026-05-25T10:00:00Z',
};

describe('WatchDedupeStore', () => {
  it('does not flag new delivery as duplicate', () => {
    const store = new WatchDedupeStore(tempDir);
    expect(store.isDuplicate('delivery-001')).toBe(false);
  });

  it('flags recorded delivery as duplicate', () => {
    const store = new WatchDedupeStore(tempDir);
    store.record('delivery-001', 'stable-key-1');
    expect(store.isDuplicate('delivery-001')).toBe(true);
  });

  it('flags recorded stable key as duplicate', () => {
    const store = new WatchDedupeStore(tempDir);
    store.record('delivery-001', 'stable-key-1');
    expect(store.isDuplicateByStableKey('stable-key-1')).toBe(true);
  });

  it('does not flag unknown stable key as duplicate', () => {
    const store = new WatchDedupeStore(tempDir);
    store.record('delivery-001', 'stable-key-1');
    expect(store.isDuplicateByStableKey('stable-key-2')).toBe(false);
  });

  it('persists across instances', () => {
    const store1 = new WatchDedupeStore(tempDir);
    store1.record('delivery-001', 'stable-key-1');

    const store2 = new WatchDedupeStore(tempDir);
    expect(store2.isDuplicate('delivery-001')).toBe(true);
  });

  it('builds stable key from event', () => {
    const store = new WatchDedupeStore(tempDir);
    const key = store.buildStableKey(baseEvent);
    expect(key).toBe('github:issue:Negentropy-Laby/OpenSlack#42:opened:2026-05-25T10:00:00Z');
  });

  it('reports stats', () => {
    const store = new WatchDedupeStore(tempDir);
    store.record('d1', 'k1');
    store.record('d2', 'k2');
    const stats = store.getStats();
    expect(stats.count).toBe(2);
    expect(stats.lastTimestamp).toBeDefined();
  });
});
