import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, linkSync, renameSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readOwnedFile, withOwnedFileDescriptor } from '../owned-file.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), 'owned-file-')); roots.push(root); const path = join(root, 'value'); writeFileSync(path, 'bound'); return { root, path }; }

describe('shared owned descriptor mechanics', () => {
  it('reads exact bounded bytes and keeps artifact hardlinks an explicit caller choice', () => {
    const { root, path } = fixture();
    expect(readOwnedFile(path, 5).toString()).toBe('bound');
    expect(() => readOwnedFile(path, 4)).toThrow();
    linkSync(path, join(root, 'alias'));
    expect(() => readOwnedFile(path, 5)).toThrow();
    expect(readOwnedFile(path, 5, { artifactLinks: true }).toString()).toBe('bound');
  });
  it('rejects a same-content replacement during consumption and closes the descriptor', () => {
    const { root, path } = fixture(), replacement = join(root, 'replacement');
    writeFileSync(replacement, 'bound');
    let descriptor: number | undefined;
    expect(() => withOwnedFileDescriptor(path, 5, {}, fd => {
      descriptor = fd; renameSync(path, join(root, 'retained')); renameSync(replacement, path); return 'not authority';
    })).toThrow('identity changed');
    expect(() => readSync(descriptor!, Buffer.alloc(1), 0, 1, 0)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });
  it('closes the descriptor when the consumer throws while preserving the consumer error', () => {
    const { path } = fixture(), error = new Error('fixture consumer failure'); let descriptor: number | undefined;
    expect(() => withOwnedFileDescriptor(path, 5, {}, fd => { descriptor = fd; throw error; })).toThrow(error);
    expect(() => readSync(descriptor!, Buffer.alloc(1), 0, 1, 0)).toThrow(expect.objectContaining({ code: 'EBADF' }));
  });
});
