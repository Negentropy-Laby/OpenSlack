import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readBinding } from '../src/startup.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'openslack-stable-binding-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'binding.json');
  writeFileSync(path, JSON.stringify({ resultMode: 'text', runId: 'RUN-TEST' }));
  return { root, path };
}

describe('portable stable worker binding bytes', () => {
  it('reads a bounded regular descriptor without relying on O_NOFOLLOW availability', () => {
    const { path } = fixture();
    expect(readBinding(path)).toMatchObject({ resultMode: 'text', runId: 'RUN-TEST' });
  });
  it('rejects directory junctions/symlinks before opening their target', () => {
    const { root, path } = fixture();
    const alias = join(root, 'linked-directory');
    symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => readBinding(join(alias, 'binding.json'))).toThrow('directory link');
    expect(readBinding(path)).toMatchObject({ runId: 'RUN-TEST' });
  });
  it('rejects a multiply-linked descriptor even when JSON bytes are valid', () => {
    const { root, path } = fixture();
    linkSync(path, join(root, 'other-binding.json'));
    expect(() => readBinding(path)).toThrow('Invalid task binding');
  });
  it.each(['oversized', 'invalid-utf8', 'directory'] as const)('rejects %s without returning a binding', mode => {
    const { root } = fixture();
    const path = join(root, mode);
    if (mode === 'directory') mkdirSync(path);
    else writeFileSync(path, mode === 'oversized' ? Buffer.alloc(128 * 1024 + 1, 65) : Buffer.from([0xff]));
    expect(() => readBinding(path)).toThrow();
  });
});
