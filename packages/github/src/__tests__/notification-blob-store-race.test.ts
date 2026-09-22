import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotificationBlobStore } from '../notification-blob-store.js';

const hooks = vi.hoisted(() => ({
  root: '',
  before: undefined as (() => void) | undefined,
  after: undefined as (() => void) | undefined,
  failurePath: '',
  failureCode: '',
  entryKind: '',
  statusKind: '',
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      const targeted = String(args[0]) === hooks.root;
      if (targeted) hooks.before?.();
      const entries = fs.readdirSync(...args);
      if (targeted && hooks.entryKind) {
        for (const entry of entries) {
          if (entry.name.toString() === '.blob-store.lock.reclaim') {
            entry.isSymbolicLink = () => hooks.entryKind === 'link';
            entry.isFile = () => false;
          }
        }
      }
      if (targeted) hooks.after?.();
      return entries;
    },
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      if (String(args[0]) === hooks.failurePath) {
        throw Object.assign(new Error('controlled inspection failure'), {
          code: hooks.failureCode,
        });
      }
      const status = fs.lstatSync(...args);
      if (status && String(args[0]) === join(hooks.root, '.blob-store.lock.reclaim')) {
        if (hooks.statusKind === 'link') status.isSymbolicLink = () => true;
        if (hooks.statusKind === 'directory') status.isFile = () => false;
        if (hooks.statusKind === 'permissions') status.mode = 0o100644;
      }
      return status;
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  hooks.root = '';
  hooks.before = hooks.after = undefined;
  hooks.failurePath = hooks.failureCode = '';
  hooks.entryKind = hooks.statusKind = '';
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openslack-blob-scan-race-'));
  roots.push(root);
  const store = new NotificationBlobStore({ rootPath: root, maxBytes: 1024 });
  const bytes = Buffer.from('intact');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
  const blob = store.put({ bytes, digest, size: bytes.length });
  hooks.root = root;
  const reclaim = join(root, '.blob-store.lock.reclaim');
  // Created during the root scan, after the ordinary storage lock was acquired.
  hooks.before = () => writeFileSync(reclaim, 'temporary gate', { mode: 0o600 });
  return { root, reclaim, store, blob, bytes };
}

describe('NotificationBlobStore scan inspection races', () => {
  it.each(['link', 'directory'])('rejects an observed %s even if it disappears', (kind) => {
    const { store, reclaim } = fixture();
    hooks.entryKind = kind;
    hooks.after = () => unlinkSync(reclaim);
    expect(() => store.usage()).toThrowError(expect.objectContaining({ code: 'BLOB_PATH_UNSAFE' }));
  });

  it.each(['link', 'directory'])('rejects a reclaim replacement with a %s', (kind) => {
    const { store } = fixture();
    hooks.after = () => {
      hooks.statusKind = kind;
    };
    expect(() => store.usage()).toThrowError(expect.objectContaining({ code: 'BLOB_PATH_UNSAFE' }));
  });

  it('retains the platform-specific reclaim mode policy', () => {
    const { store, bytes } = fixture();
    hooks.after = () => {
      hooks.statusKind = 'permissions';
    };
    if (process.platform === 'win32') expect(store.usage().usedBytes).toBe(bytes.length);
    else
      expect(() => store.usage()).toThrowError(
        expect.objectContaining({ code: 'BLOB_PATH_UNSAFE' }),
      );
  });

  it('tolerates a reclaim gate removed after enumeration without losing blob usage', () => {
    const { store, reclaim, bytes } = fixture();
    hooks.after = () => unlinkSync(reclaim);
    expect(store.usage().usedBytes).toBe(bytes.length);
  });

  it('excludes a present regular reclaim gate from blob usage', () => {
    const { store, bytes } = fixture();
    expect(store.usage().usedBytes).toBe(bytes.length);
  });

  it.each(['EACCES', 'EIO'])('does not swallow reclaim inspection %s', (code) => {
    const { store, reclaim } = fixture();
    hooks.after = () => {
      hooks.failurePath = reclaim;
      hooks.failureCode = code;
    };
    expect(() => store.usage()).toThrowError(expect.objectContaining({ code }));
  });

  it.each(['lock', 'blob'])('does not swallow missing %s evidence', (target) => {
    const { root, store, blob } = fixture();
    hooks.after = () => {
      hooks.failurePath = target === 'lock' ? join(root, '.blob-store.lock') : blob.path;
      hooks.failureCode = 'ENOENT';
    };
    expect(() => store.usage()).toThrowError(expect.objectContaining({ code: 'ENOENT' }));
  });
});
