import type * as FileSystem from 'node:fs/promises';
import type { BigIntStats, Stats } from 'node:fs';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  createEmptyPluginLock,
  serializePluginLock,
  writePluginLockAtomicForTest,
} from '../lock.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  const identities = new Map<string, bigint>();
  function highIdentity<T extends Stats | BigIntStats>(value: T, exact: BigIntStats): T {
    const key = `${exact.dev}:${exact.ino}`;
    const identity = identities.get(key) ?? (1n << 60n) + BigInt(identities.size);
    identities.set(key, identity);
    Object.defineProperty(value, 'ino', {
      value: typeof value.ino === 'bigint' ? identity : Number(identity),
    });
    return value;
  }
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) =>
      highIdentity(await actual.lstat(...args), await actual.lstat(args[0], { bigint: true })),
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'stat') {
            return async (...options: Parameters<typeof handle.stat>) =>
              highIdentity(await target.stat(...options), await target.stat({ bigint: true }));
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
});

it('rejects a same-byte replacement whose distinct large inode aliases as a Number', async () => {
  expect(Number(1n << 60n)).toBe(Number((1n << 60n) + 1n));
  const root = await mkdtemp(join(tmpdir(), 'plugin-lock-large-identity-'));
  try {
    await mkdir(join(root, '.openslack'));
    const lock = createEmptyPluginLock();
    await expect(
      writePluginLockAtomicForTest(root, lock, {
        afterAtomicRename: async (target) => {
          await rename(target, `${target}.displaced`);
          await writeFile(target, serializePluginLock(lock));
        },
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_LOCK_FILE_UNSAFE' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
