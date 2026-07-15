import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_PLUGIN_LOCK_BYTES,
  MAX_PLUGIN_LOCK_ENTRIES,
  PLUGIN_LOCK_SCHEMA,
  PluginLockError,
  createEmptyPluginLock,
  lockPathForWorkspace,
  parsePluginLockBytes,
  readPluginLock,
  readPluginLockForTest,
  serializePluginLock,
  writePluginLockAtomic,
  writePluginLockAtomicForTest,
  type PluginLockEntry,
  type PluginLockV1,
} from '../lock.js';
import { StrictJsonError } from '../strict-json.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const REPOSITORY_LOCK_PATH = fileURLToPath(
  new URL('../../../../.openslack/plugins.lock', import.meta.url),
);

function entry(overrides: Partial<PluginLockEntry> = {}): PluginLockEntry {
  const id = overrides.id ?? 'alpha';
  const providerKind = overrides.providerKind ?? 'workspace';
  return {
    id,
    version: '1.2.3',
    providerKind,
    sourceRef:
      overrides.sourceRef ??
      (providerKind === 'workspace'
        ? `.openslack/plugins/${id}/plugin.json`
        : `node_modules/${id}/plugin.json`),
    manifestSha256: HASH_A,
    requestedGateMode: 'SHADOW',
    ...overrides,
  };
}

function lockBytes(plugins: readonly unknown[]): Buffer {
  return Buffer.from(
    `${JSON.stringify({ schema: PLUGIN_LOCK_SCHEMA, plugins }, null, 2)}\n`,
    'utf8',
  );
}

function indexedEntries(count: number): readonly PluginLockEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `p${index.toString(36).padStart(4, '0')}`;
    return entry({ id, sourceRef: `.openslack/plugins/${id}/plugin.json` });
  });
}

function maximumLengthSourceRef(id: string): string {
  const prefix = `node_modules/${id}/`;
  const suffix = '/plugin.json';
  return `${prefix}${'x'.repeat(512 - prefix.length - suffix.length)}${suffix}`;
}

function isUnsupportedSymlinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS' || code === 'UNKNOWN';
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error instanceof PluginLockError ? error.code : undefined;
  }
}

const temporaryRoots: string[] = [];

async function temporaryWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openslack-plugin-lock-'));
  temporaryRoots.push(root);
  await mkdir(join(root, '.openslack'));
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('plugin lock production serializer', () => {
  it('emits the repository empty lock byte-for-byte', async () => {
    const expected = await readFile(REPOSITORY_LOCK_PATH);
    const actual = serializePluginLock(createEmptyPluginLock());

    expect(actual.equals(expected)).toBe(true);
    expect(actual.toString('utf8')).toBe(
      '{\n  "schema": "openslack.plugins_lock.v1",\n  "plugins": []\n}\n',
    );
  });

  it('rebuilds entries in fixed key order and ASCII code-unit tuple order', () => {
    const lock: PluginLockV1 = {
      schema: PLUGIN_LOCK_SCHEMA,
      plugins: [
        entry({ id: 'zeta', sourceRef: '.openslack/plugins/zeta/plugin.json' }),
        entry({
          id: 'alpha',
          providerKind: 'plugin',
          sourceRef: 'node_modules/@scope/alpha/plugin.json',
          manifestSha256: HASH_B,
          requestedGateMode: 'ENFORCE',
        }),
      ],
    };

    const text = serializePluginLock(lock).toString('utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    const parsed = JSON.parse(text) as { plugins: Array<Record<string, unknown>> };
    expect(parsed.plugins.map((plugin) => plugin.id)).toEqual(['alpha', 'zeta']);
    expect(Object.keys(parsed.plugins[0]!)).toEqual([
      'id',
      'version',
      'providerKind',
      'sourceRef',
      'manifestSha256',
      'requestedGateMode',
    ]);
  });

  it('round-trips entries at the shared ID and version ceilings', () => {
    const id = `a${'1'.repeat(63)}`;
    const version = `1.2.3+${'a'.repeat(122)}`;
    expect(id).toHaveLength(64);
    expect(version).toHaveLength(128);
    const lock: PluginLockV1 = {
      schema: PLUGIN_LOCK_SCHEMA,
      plugins: [entry({ id, version, sourceRef: `.openslack/plugins/${id}/plugin.json` })],
    };

    const bytes = serializePluginLock(lock);
    const parsed = parsePluginLockBytes(bytes);

    expect(parsed.plugins[0]).toEqual(lock.plugins[0]);
    expect(serializePluginLock(parsed).equals(bytes)).toBe(true);
  });

  it('rejects IDs and versions above the reader grammar ceilings', () => {
    const longId = `a${'1'.repeat(64)}`;
    const longVersion = `1.2.3+${'a'.repeat(123)}`;
    const idEntry = entry({
      id: longId,
      sourceRef: `.openslack/plugins/${longId}/plugin.json`,
    });
    const versionEntry = entry({ version: longVersion });

    for (const candidate of [idEntry, versionEntry]) {
      const lock = { schema: PLUGIN_LOCK_SCHEMA, plugins: [candidate] } as const;
      expect(errorCode(() => serializePluginLock(lock))).toBe('PLUGIN_LOCK_FIELD_INVALID');
      expect(errorCode(() => parsePluginLockBytes(lockBytes([candidate])))).toBe(
        'PLUGIN_LOCK_FIELD_INVALID',
      );
    }
  });

  it('enforces the same entry-count ceiling while parsing and serializing', () => {
    const plugins = indexedEntries(MAX_PLUGIN_LOCK_ENTRIES + 1);
    const bytes = lockBytes(plugins);
    expect(bytes.length).toBeLessThan(MAX_PLUGIN_LOCK_BYTES);

    expect(errorCode(() => serializePluginLock({ schema: PLUGIN_LOCK_SCHEMA, plugins }))).toBe(
      'PLUGIN_LOCK_FIELD_INVALID',
    );
    expect(errorCode(() => parsePluginLockBytes(bytes))).toBe('PLUGIN_LOCK_FIELD_INVALID');
  });

  it('rejects a canonical lock whose serialized form exceeds the byte ceiling', () => {
    const plugins = indexedEntries(MAX_PLUGIN_LOCK_ENTRIES).map((candidate) =>
      entry({
        ...candidate,
        providerKind: 'plugin',
        sourceRef: maximumLengthSourceRef(candidate.id),
      }),
    );
    expect(lockBytes(plugins).length).toBeGreaterThan(MAX_PLUGIN_LOCK_BYTES);

    expect(errorCode(() => serializePluginLock({ schema: PLUGIN_LOCK_SCHEMA, plugins }))).toBe(
      'PLUGIN_LOCK_TOO_LARGE',
    );
  });

  it.each(['approval', 'actor', 'effectiveCapabilities', 'approvedBy'])(
    'rejects the authority-bearing unknown field %s instead of serializing it',
    (field) => {
      const unsafe = {
        schema: PLUGIN_LOCK_SCHEMA,
        plugins: [{ ...entry(), [field]: field === 'effectiveCapabilities' ? [] : 'human' }],
      };

      expect(() => serializePluginLock(unsafe as unknown as PluginLockV1)).toThrow(PluginLockError);
      expect(errorCode(() => serializePluginLock(unsafe as unknown as PluginLockV1))).toBe(
        'PLUGIN_LOCK_FIELD_UNKNOWN',
      );
    },
  );
});

describe('parsePluginLockBytes', () => {
  it('returns an immutable lock reconstructed from strict JSON data', () => {
    const parsed = parsePluginLockBytes(lockBytes([entry()]));

    expect(parsed).toEqual({ schema: PLUGIN_LOCK_SCHEMA, plugins: [entry()] });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.plugins)).toBe(true);
    expect(Object.isFrozen(parsed.plugins[0])).toBe(true);
  });

  it('rejects duplicate plugin IDs', () => {
    expect(errorCode(() => parsePluginLockBytes(lockBytes([entry(), entry()])))).toBe(
      'PLUGIN_LOCK_DUPLICATE_ID',
    );
  });

  it('rejects non-canonical plugin ordering rather than silently sorting input bytes', () => {
    const zeta = entry({ id: 'zeta', sourceRef: '.openslack/plugins/zeta/plugin.json' });
    const alpha = entry({ id: 'alpha', sourceRef: '.openslack/plugins/alpha/plugin.json' });

    expect(errorCode(() => parsePluginLockBytes(lockBytes([zeta, alpha])))).toBe(
      'PLUGIN_LOCK_ORDER_INVALID',
    );
  });

  it('rejects uppercase, short, and prefixed manifest hashes', () => {
    for (const manifestSha256 of [HASH_A.toUpperCase(), 'a'.repeat(63), `sha256:${HASH_A}`]) {
      expect(errorCode(() => parsePluginLockBytes(lockBytes([entry({ manifestSha256 })])))).toBe(
        'PLUGIN_LOCK_HASH_INVALID',
      );
    }
  });

  it.each([
    '.openslack/plugins/other/plugin.json',
    '.openslack\\plugins\\alpha\\plugin.json',
    '.openslack/plugins/../alpha/plugin.json',
    '/.openslack/plugins/alpha/plugin.json',
  ])('rejects non-canonical workspace sourceRef %s', (sourceRef) => {
    expect(errorCode(() => parsePluginLockBytes(lockBytes([entry({ sourceRef })])))).toBe(
      'PLUGIN_LOCK_SOURCE_REF_INVALID',
    );
  });

  it.each([
    'C:/plugins/alpha/plugin.json',
    '../alpha/plugin.json',
    'node_modules//alpha/plugin.json',
    'node_modules/alpha/manifest.json',
    'node_modules/alpha plugin/plugin.json',
  ])('rejects non-canonical installed sourceRef %s', (sourceRef) => {
    const installed = entry({ providerKind: 'plugin', sourceRef });
    expect(errorCode(() => parsePluginLockBytes(lockBytes([installed])))).toBe(
      'PLUGIN_LOCK_SOURCE_REF_INVALID',
    );
  });

  it('accepts an installed-root logical plugin.json sourceRef', () => {
    const installed = entry({ providerKind: 'plugin', sourceRef: 'plugin.json' });
    expect(parsePluginLockBytes(lockBytes([installed])).plugins[0]?.sourceRef).toBe('plugin.json');
  });

  it.each([
    ['openslack', 'PLUGIN_LOCK_FIELD_INVALID'],
    ['Alpha', 'PLUGIN_LOCK_FIELD_INVALID'],
  ])('rejects invalid or reserved plugin ID %s', (id, code) => {
    const candidate = entry({
      id,
      sourceRef: `.openslack/plugins/${id}/plugin.json`,
    });
    expect(errorCode(() => parsePluginLockBytes(lockBytes([candidate])))).toBe(code);
  });

  it('rejects unknown root and entry fields', () => {
    expect(
      errorCode(() =>
        parsePluginLockBytes(
          Buffer.from(JSON.stringify({ schema: PLUGIN_LOCK_SCHEMA, plugins: [], approval: true })),
        ),
      ),
    ).toBe('PLUGIN_LOCK_FIELD_UNKNOWN');
    expect(errorCode(() => parsePluginLockBytes(lockBytes([{ ...entry(), actor: 'wsman' }])))).toBe(
      'PLUGIN_LOCK_FIELD_UNKNOWN',
    );
  });

  it('delegates duplicate JSON keys, BOM, and invalid UTF-8 to the strict parser', () => {
    const duplicate = Buffer.from(
      '{"schema":"openslack.plugins_lock.v1","schema":"openslack.plugins_lock.v1","plugins":[]}',
    );
    expect(() => parsePluginLockBytes(duplicate)).toThrowError(
      expect.objectContaining({ code: 'STRICT_JSON_DUPLICATE_KEY' }),
    );
    expect(() =>
      parsePluginLockBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), lockBytes([])])),
    ).toThrowError(expect.objectContaining({ code: 'STRICT_JSON_BOM_FORBIDDEN' }));
    expect(() => parsePluginLockBytes(Buffer.from([0xff]))).toThrow(StrictJsonError);
  });

  it('rejects input over the fixed byte ceiling before parsing', () => {
    expect(
      errorCode(() => parsePluginLockBytes(Buffer.alloc(MAX_PLUGIN_LOCK_BYTES + 1, 0x20))),
    ).toBe('PLUGIN_LOCK_TOO_LARGE');
  });
});

describe('fixed workspace lock I/O', () => {
  it('writes atomically and reads only workspaceRoot/.openslack/plugins.lock', async () => {
    const root = await temporaryWorkspace();
    const first: PluginLockV1 = {
      schema: PLUGIN_LOCK_SCHEMA,
      plugins: [entry()],
    };
    await writePluginLockAtomic(root, first);

    expect(lockPathForWorkspace(root)).toBe(join(root, '.openslack', 'plugins.lock'));
    expect((await readFile(lockPathForWorkspace(root))).equals(serializePluginLock(first))).toBe(
      true,
    );
    expect(await readPluginLock(root)).toEqual(parsePluginLockBytes(serializePluginLock(first)));

    const replacement: PluginLockV1 = {
      schema: PLUGIN_LOCK_SCHEMA,
      plugins: [
        entry({
          id: 'bravo',
          sourceRef: '.openslack/plugins/bravo/plugin.json',
          manifestSha256: HASH_B,
        }),
      ],
    };
    await writePluginLockAtomic(root, replacement);
    expect(await readPluginLock(root)).toEqual(
      parsePluginLockBytes(serializePluginLock(replacement)),
    );
    expect(await readdir(join(root, '.openslack'))).toEqual(['plugins.lock']);
  });

  it('does not create or repair a missing .openslack directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openslack-plugin-lock-missing-'));
    temporaryRoots.push(root);

    await expect(writePluginLockAtomic(root, createEmptyPluginLock())).rejects.toMatchObject({
      code: 'PLUGIN_LOCK_PATH_UNSAFE',
    });
    await expect(readPluginLock(root)).rejects.toMatchObject({
      code: 'PLUGIN_LOCK_PATH_UNSAFE',
    });
  });

  it('rejects relative or non-normalized workspace roots', () => {
    expect(() => lockPathForWorkspace('.')).toThrowError(
      expect.objectContaining({ code: 'PLUGIN_LOCK_PATH_UNSAFE' }),
    );
    const repositoryRoot = dirname(dirname(REPOSITORY_LOCK_PATH));
    expect(() => lockPathForWorkspace(`${repositoryRoot}${sep}.${sep}`)).toThrowError(
      expect.objectContaining({ code: 'PLUGIN_LOCK_PATH_UNSAFE' }),
    );
  });

  it('rejects a redirected .openslack directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openslack-plugin-lock-link-'));
    const external = await mkdtemp(join(tmpdir(), 'openslack-plugin-lock-external-'));
    temporaryRoots.push(root, external);
    const statePath = join(root, '.openslack');
    await symlink(external, statePath, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(writePluginLockAtomic(root, createEmptyPluginLock())).rejects.toMatchObject({
      code: 'PLUGIN_LOCK_PATH_UNSAFE',
    });
  });

  it('rejects a workspaceRoot that is itself a symlink or junction', async () => {
    const actualRoot = await temporaryWorkspace();
    const linkParent = await mkdtemp(join(tmpdir(), 'openslack-plugin-lock-root-link-'));
    temporaryRoots.push(linkParent);
    const linkedRoot = join(linkParent, 'workspace');
    await symlink(actualRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(readPluginLock(linkedRoot)).rejects.toMatchObject({
      code: 'PLUGIN_LOCK_PATH_UNSAFE',
    });
  });

  it('rejects a leaf plugins.lock symlink instead of following it', async (context) => {
    const root = await temporaryWorkspace();
    const externalRoot = await mkdtemp(join(tmpdir(), 'openslack-plugin-lock-leaf-link-'));
    temporaryRoots.push(externalRoot);
    const externalLock = join(externalRoot, 'plugins.lock');
    await writeFile(externalLock, serializePluginLock(createEmptyPluginLock()));
    try {
      await symlink(externalLock, lockPathForWorkspace(root), 'file');
    } catch (error) {
      if (isUnsupportedSymlinkError(error)) {
        context.skip(`File symlinks are not supported on ${process.platform}: ${String(error)}`);
      }
      throw error;
    }

    await expect(readPluginLock(root)).rejects.toMatchObject({
      code: 'PLUGIN_LOCK_FILE_UNSAFE',
    });
    await expect(writePluginLockAtomic(root, createEmptyPluginLock())).rejects.toMatchObject({
      code: 'PLUGIN_LOCK_FILE_UNSAFE',
    });
  });

  it('fails closed when the fixed read path is replaced after the bounded read', async () => {
    const root = await temporaryWorkspace();
    const original: PluginLockV1 = { schema: PLUGIN_LOCK_SCHEMA, plugins: [entry()] };
    const replacement: PluginLockV1 = {
      schema: PLUGIN_LOCK_SCHEMA,
      plugins: [
        entry({
          id: 'bravo',
          sourceRef: '.openslack/plugins/bravo/plugin.json',
          manifestSha256: HASH_B,
        }),
      ],
    };
    await writePluginLockAtomic(root, original);

    await expect(
      readPluginLockForTest(root, {
        afterBoundedRead: async (targetPath) => {
          await rename(targetPath, `${targetPath}.displaced`);
          await writeFile(targetPath, serializePluginLock(replacement));
        },
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_LOCK_FILE_UNSAFE' });
  });

  it('fails closed when post-rename readback bytes differ at the fixed target', async () => {
    const root = await temporaryWorkspace();
    const intended: PluginLockV1 = { schema: PLUGIN_LOCK_SCHEMA, plugins: [entry()] };
    const replacement: PluginLockV1 = {
      schema: PLUGIN_LOCK_SCHEMA,
      plugins: [
        entry({
          id: 'bravo',
          sourceRef: '.openslack/plugins/bravo/plugin.json',
          manifestSha256: HASH_B,
        }),
      ],
    };

    await expect(
      writePluginLockAtomicForTest(root, intended, {
        afterAtomicRename: async (targetPath) => {
          await writeFile(targetPath, serializePluginLock(replacement));
        },
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_LOCK_FILE_UNSAFE' });
  });

  it('fails closed when post-rename target identity changes even with exact bytes', async () => {
    const root = await temporaryWorkspace();
    const intended: PluginLockV1 = { schema: PLUGIN_LOCK_SCHEMA, plugins: [entry()] };
    const bytes = serializePluginLock(intended);

    await expect(
      writePluginLockAtomicForTest(root, intended, {
        afterAtomicRename: async (targetPath) => {
          await rename(targetPath, `${targetPath}.displaced`);
          await writeFile(targetPath, bytes);
        },
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_LOCK_FILE_UNSAFE' });
  });

  it('rejects an oversized lock file through the bounded reader', async () => {
    const root = await temporaryWorkspace();
    await writeFile(lockPathForWorkspace(root), Buffer.alloc(MAX_PLUGIN_LOCK_BYTES + 1, 0x20));

    await expect(readPluginLock(root)).rejects.toMatchObject({
      code: 'PLUGIN_LOCK_TOO_LARGE',
    });
  });
});
