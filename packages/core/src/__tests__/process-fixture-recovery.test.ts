import { describe, expect, it } from 'vitest';
import { testWindowsDriveAlias } from '../../../../scripts/testing/process-fixture.mjs';

function ports(fail: 'root' | 'alias' | 'replacement' | 'none') {
  const root = 'C:\\fixture', original = { dev: 1n, ino: 2n, isDirectory: () => true };
  let allocated = false, mapping: string | undefined, released = 0;
  const api = {
    platform: 'win32' as const, systemRoot: 'C:\\Windows', canonical: () => root,
    stat: (path: string) => {
      if (allocated && path === root && fail === 'root') throw Object.assign(new Error('fixture root EACCES'), { code: 'EACCES' });
      if (path.startsWith('Z:') && fail !== 'none') {
        if (fail === 'replacement') mapping = 'C:\\another-owner';
        throw Object.assign(new Error('fixture alias EBUSY'), { code: 'EBUSY' });
      }
      return original;
    },
    spawn: (_command: string, args: string[]) => {
      if (!args.length) return { status: 0, stdout: mapping ? `Z:\\: => ${mapping}\r\n` : '' };
      if (args[1] === '/D') { released++; mapping = undefined; return { status: 0, stdout: '' }; }
      allocated = true; mapping = root; return { status: 0, stdout: '' };
    },
  };
  return { root, api, released: () => released };
}

describe('test fixture drive ownership on every failure path', () => {
  it.each(['root', 'alias'] as const)('retires its own mapping after a post-allocation %s failure', kind => {
    const setup = ports(kind);
    expect(() => testWindowsDriveAlias(setup.root, setup.api)).toThrow(/fixture/);
    expect(setup.released()).toBe(1);
  });
  it('preserves a replacement mapping and reports cleanup uncertainty', () => {
    const setup = ports('replacement');
    expect(() => testWindowsDriveAlias(setup.root, setup.api)).toThrow('TEST_DRIVE_ALIAS_CLEANUP_UNCONFIRMED');
    expect(setup.released()).toBe(0);
  });
  it('retires a successful allocation at most once', () => {
    const setup = ports('none'), alias = testWindowsDriveAlias(setup.root, setup.api);
    alias.dispose(); alias.dispose();
    expect(setup.released()).toBe(1);
  });
});
