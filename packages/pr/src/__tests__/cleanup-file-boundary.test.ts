import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testTemporaryDirectory } from '../../../../scripts/testing/process-fixture.mjs';
import { readCleanupBoundedFile } from '../internal/cleanup-file-boundary.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = testTemporaryDirectory('cleanup-read-boundary-');
  roots.push(root);
  const path = join(root, 'record.json');
  writeFileSync(path, '{}', { mode: 0o600 });
  return { root, path };
}
describe('bounded descriptor input contract', () => {
  it('reads an ordinary file on Linux and refuses other platforms', () => {
    const { path } = fixture();
    if (process.platform === 'linux')
      expect(readCleanupBoundedFile(path, 32).toString()).toBe('{}');
    else
      expect(() => readCleanupBoundedFile(path, 32)).toThrowError(
        expect.objectContaining({ code: 'UNSUPPORTED_PLATFORM' }),
      );
  });
  it.each(['hardlink', 'writable', 'fifo', 'oversize', 'parent-link'])(
    'refuses %s without accepting unsafe bytes',
    (kind) => {
      const { root, path } = fixture();
      if (process.platform !== 'linux') {
        expect(() => readCleanupBoundedFile(path, 32)).toThrowError(
          expect.objectContaining({ code: 'UNSUPPORTED_PLATFORM' }),
        );
        return;
      }
      let input = path;
      if (kind === 'hardlink') linkSync(path, join(root, 'second.json'));
      if (kind === 'writable') chmodSync(path, 0o666);
      if (kind === 'fifo') {
        rmSync(path);
        execFileSync('mkfifo', [path]);
      }
      if (kind === 'oversize') writeFileSync(path, Buffer.alloc(33));
      if (kind === 'parent-link') {
        const external = join(root, 'external');
        mkdirSync(external);
        writeFileSync(join(external, 'record.json'), '{}');
        symlinkSync(external, join(root, 'alias'));
        input = join(root, 'alias', 'record.json');
      }
      expect(() => readCleanupBoundedFile(input, 32)).toThrowError(
        expect.objectContaining({
          code:
            kind === 'parent-link'
              ? 'SYMLINK_REJECTED'
              : kind === 'oversize'
                ? 'TOO_LARGE'
                : 'UNSAFE_FILE',
        }),
      );
    },
  );
  it.each(['win32', 'darwin'])('refuses %s before filesystem access', (platform) => {
    const { path } = fixture(),
      bytes = readFileSync(path);
    vi.stubGlobal('process', { ...process, platform });
    expect(() => readCleanupBoundedFile(path, 32)).toThrowError(
      expect.objectContaining({ code: 'UNSUPPORTED_PLATFORM' }),
    );
    vi.unstubAllGlobals();
    expect(readFileSync(path)).toEqual(bytes);
  });
});
