import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WatchCursorStore } from '../watch-cursor.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'openslack-cursor-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('WatchCursorStore', () => {
  it('returns null for unknown repo key', () => {
    const store = new WatchCursorStore(tempDir);
    expect(store.getCursor('unknown/repo')).toBeNull();
  });

  it('stores and retrieves a cursor', () => {
    const store = new WatchCursorStore(tempDir);
    store.updateCursor('owner/repo', { lastSeenAt: '2026-05-25T10:00:00Z', lastIssueNumber: 42 });
    const cursor = store.getCursor('owner/repo');
    expect(cursor).toEqual({ lastSeenAt: '2026-05-25T10:00:00Z', lastIssueNumber: 42 });
  });

  it('overwrites cursor on update', () => {
    const store = new WatchCursorStore(tempDir);
    store.updateCursor('owner/repo', { lastSeenAt: '2026-05-25T10:00:00Z', lastIssueNumber: 42 });
    store.updateCursor('owner/repo', { lastSeenAt: '2026-05-25T11:00:00Z', lastIssueNumber: 50 });
    const cursor = store.getCursor('owner/repo');
    expect(cursor).toEqual({ lastSeenAt: '2026-05-25T11:00:00Z', lastIssueNumber: 50 });
  });

  it('persists across instances', () => {
    const store1 = new WatchCursorStore(tempDir);
    store1.updateCursor('owner/repo', { lastSeenAt: '2026-05-25T10:00:00Z', lastIssueNumber: 42 });

    const store2 = new WatchCursorStore(tempDir);
    const cursor = store2.getCursor('owner/repo');
    expect(cursor).toEqual({ lastSeenAt: '2026-05-25T10:00:00Z', lastIssueNumber: 42 });
  });

  it('handles missing state file gracefully', () => {
    const store = new WatchCursorStore(join(tempDir, 'nonexistent'));
    expect(store.getCursor('any/repo')).toBeNull();
  });

  it('getAllCursors returns all entries', () => {
    const store = new WatchCursorStore(tempDir);
    store.updateCursor('a/b', { lastSeenAt: '2026-05-25T10:00:00Z', lastIssueNumber: 1 });
    store.updateCursor('c/d', { lastSeenAt: '2026-05-25T11:00:00Z', lastIssueNumber: 2 });
    const all = store.getAllCursors();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all['a/b']).toEqual({ lastSeenAt: '2026-05-25T10:00:00Z', lastIssueNumber: 1 });
    expect(all['c/d']).toEqual({ lastSeenAt: '2026-05-25T11:00:00Z', lastIssueNumber: 2 });
  });

  it('resetCursor removes an entry', () => {
    const store = new WatchCursorStore(tempDir);
    store.updateCursor('owner/repo', { lastSeenAt: '2026-05-25T10:00:00Z', lastIssueNumber: 42 });
    store.resetCursor('owner/repo');
    expect(store.getCursor('owner/repo')).toBeNull();
  });
});
