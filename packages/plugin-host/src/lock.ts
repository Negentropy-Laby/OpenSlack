import { randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, open, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import type { PluginGateMode } from '@openslack/plugin-api';

import { parseStrictJsonBytes } from './strict-json.js';

export const PLUGIN_LOCK_SCHEMA = 'openslack.plugins_lock.v1' as const;
export const PLUGIN_LOCK_RELATIVE_PATH = '.openslack/plugins.lock' as const;
export const MAX_PLUGIN_LOCK_BYTES = 256 * 1024;
export const MAX_PLUGIN_LOCK_ENTRIES = 512;

export const PLUGIN_LOCK_PROVIDER_KINDS = Object.freeze(['workspace', 'plugin'] as const);
export type PluginLockProviderKind = (typeof PLUGIN_LOCK_PROVIDER_KINDS)[number];

export interface PluginLockEntry {
  readonly id: string;
  readonly version: string;
  readonly providerKind: PluginLockProviderKind;
  readonly sourceRef: string;
  readonly manifestSha256: string;
  readonly requestedGateMode: PluginGateMode;
}

export interface PluginLockV1 {
  readonly schema: typeof PLUGIN_LOCK_SCHEMA;
  readonly plugins: readonly PluginLockEntry[];
}

export const PLUGIN_LOCK_ERROR_CODES = Object.freeze([
  'PLUGIN_LOCK_BYTES_INVALID',
  'PLUGIN_LOCK_TOO_LARGE',
  'PLUGIN_LOCK_NOT_OBJECT',
  'PLUGIN_LOCK_FIELD_REQUIRED',
  'PLUGIN_LOCK_FIELD_UNKNOWN',
  'PLUGIN_LOCK_FIELD_INVALID',
  'PLUGIN_LOCK_SCHEMA_UNSUPPORTED',
  'PLUGIN_LOCK_DUPLICATE_ID',
  'PLUGIN_LOCK_ORDER_INVALID',
  'PLUGIN_LOCK_SOURCE_REF_INVALID',
  'PLUGIN_LOCK_HASH_INVALID',
  'PLUGIN_LOCK_PATH_UNSAFE',
  'PLUGIN_LOCK_FILE_UNSAFE',
] as const);

export type PluginLockErrorCode = (typeof PLUGIN_LOCK_ERROR_CODES)[number];

export class PluginLockError extends Error {
  readonly code: PluginLockErrorCode;
  readonly path: string;

  constructor(code: PluginLockErrorCode, path: string, message: string) {
    super(message);
    this.name = 'PluginLockError';
    this.code = code;
    this.path = path;
  }
}

const ROOT_FIELDS = Object.freeze(['schema', 'plugins'] as const);
const ENTRY_FIELDS = Object.freeze([
  'id',
  'version',
  'providerKind',
  'sourceRef',
  'manifestSha256',
  'requestedGateMode',
] as const);
// These Red host rules are intentionally local. Yellow plugin-api constants and validators are
// authoring feedback and must never be substitutable authorization inputs at this boundary.
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MANIFEST_SEMVER_PATTERN =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MANIFEST_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_SOURCE_SEGMENT_PATTERN = /^[A-Za-z0-9@._+-]+$/;
const RESERVED_IDS = new Set<string>([
  'openslack',
  'built-in',
  'plugin',
  'workspace',
  'external',
  'negentropy',
]);
const PROVIDER_KINDS = new Set<string>(PLUGIN_LOCK_PROVIDER_KINDS);
const GATE_MODES = new Set<string>(['SHADOW', 'ENFORCE']);
const MAX_PLUGIN_ID_LENGTH = 64;
const MAX_PLUGIN_VERSION_LENGTH = 128;

type PlainDataRecord = Record<string, unknown>;

function fail(code: PluginLockErrorCode, path: string, message: string): never {
  throw new PluginLockError(code, path, message);
}

function pointer(parent: string, segment: string | number): string {
  const escaped = String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
  return `${parent}/${escaped}`;
}

function asPlainDataRecord(value: unknown, path: string): PlainDataRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('PLUGIN_LOCK_NOT_OBJECT', path, 'Expected a plain JSON object.');
  }

  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    return fail('PLUGIN_LOCK_NOT_OBJECT', path, 'Could not inspect lock object safely.');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail('PLUGIN_LOCK_NOT_OBJECT', path, 'Expected a plain JSON object.');
  }
  for (const key of keys) {
    if (typeof key !== 'string') {
      fail('PLUGIN_LOCK_FIELD_UNKNOWN', path, 'Symbol-keyed fields are forbidden.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(
        'PLUGIN_LOCK_FIELD_INVALID',
        pointer(path, key),
        'Lock fields must be enumerable own data properties.',
      );
    }
  }
  return value as PlainDataRecord;
}

function readDataField(record: PlainDataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function requireExactFields(
  record: PlainDataRecord,
  fields: readonly string[],
  path: string,
): void {
  const allowed = new Set(fields);
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) {
      fail(
        'PLUGIN_LOCK_FIELD_REQUIRED',
        pointer(path, field),
        `Required lock field ${JSON.stringify(field)} is missing.`,
      );
    }
  }
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      fail(
        'PLUGIN_LOCK_FIELD_UNKNOWN',
        typeof key === 'string' ? pointer(path, key) : path,
        `Unknown lock field ${typeof key === 'string' ? JSON.stringify(key) : 'symbol'} is forbidden.`,
      );
    }
  }
}

function asDenseDataArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return fail('PLUGIN_LOCK_FIELD_INVALID', path, 'Expected a JSON array.');
  }

  const allowedKeys = new Set<string>(['length']);
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    allowedKeys.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(
        'PLUGIN_LOCK_FIELD_INVALID',
        pointer(path, index),
        'Lock arrays must be dense enumerable data arrays.',
      );
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      fail('PLUGIN_LOCK_FIELD_UNKNOWN', path, 'Named or symbol array fields are forbidden.');
    }
  }
  return value;
}

function requiredString(record: PlainDataRecord, key: string, path: string): string {
  const value = readDataField(record, key);
  if (typeof value !== 'string') {
    return fail(
      'PLUGIN_LOCK_FIELD_INVALID',
      pointer(path, key),
      `Lock field ${JSON.stringify(key)} must be a string.`,
    );
  }
  return value;
}

function isCanonicalInstalledSourceRef(sourceRef: string): boolean {
  if (
    sourceRef.length < 1 ||
    sourceRef.length > 512 ||
    sourceRef.includes('\\') ||
    sourceRef.includes('\0') ||
    isAbsolute(sourceRef) ||
    /^[A-Za-z]:/.test(sourceRef)
  ) {
    return false;
  }
  const segments = sourceRef.split('/');
  if (segments.at(-1) !== 'plugin.json') return false;
  return segments.every(
    (segment) =>
      segment !== '' &&
      segment !== '.' &&
      segment !== '..' &&
      SAFE_SOURCE_SEGMENT_PATTERN.test(segment),
  );
}

export function isCanonicalLockSourceRef(
  providerKind: PluginLockProviderKind,
  pluginId: string,
  sourceRef: string,
): boolean {
  if (providerKind === 'workspace') {
    return sourceRef === `.openslack/plugins/${pluginId}/plugin.json`;
  }
  return isCanonicalInstalledSourceRef(sourceRef);
}

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

const ENTRY_SORT_FIELDS = Object.freeze([
  'id',
  'version',
  'providerKind',
  'sourceRef',
  'manifestSha256',
  'requestedGateMode',
] as const satisfies readonly (keyof PluginLockEntry)[]);

export function comparePluginLockEntries(left: PluginLockEntry, right: PluginLockEntry): number {
  for (const field of ENTRY_SORT_FIELDS) {
    const comparison = compareCodeUnits(left[field], right[field]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function validateEntry(value: unknown, index: number): PluginLockEntry {
  const path = pointer('/plugins', index);
  const record = asPlainDataRecord(value, path);
  requireExactFields(record, ENTRY_FIELDS, path);

  const id = requiredString(record, 'id', path);
  if (id.length > MAX_PLUGIN_ID_LENGTH || !PLUGIN_ID_PATTERN.test(id) || RESERVED_IDS.has(id)) {
    fail(
      'PLUGIN_LOCK_FIELD_INVALID',
      pointer(path, 'id'),
      'Plugin lock ID is invalid or reserved.',
    );
  }

  const version = requiredString(record, 'version', path);
  if (version.length > MAX_PLUGIN_VERSION_LENGTH || !MANIFEST_SEMVER_PATTERN.test(version)) {
    fail(
      'PLUGIN_LOCK_FIELD_INVALID',
      pointer(path, 'version'),
      'Plugin lock version must be a canonical semantic version.',
    );
  }

  const providerKind = requiredString(record, 'providerKind', path);
  if (!PROVIDER_KINDS.has(providerKind)) {
    fail(
      'PLUGIN_LOCK_FIELD_INVALID',
      pointer(path, 'providerKind'),
      'Plugin lock providerKind must be workspace or plugin.',
    );
  }

  const sourceRef = requiredString(record, 'sourceRef', path);
  if (!isCanonicalLockSourceRef(providerKind as PluginLockProviderKind, id, sourceRef)) {
    fail(
      'PLUGIN_LOCK_SOURCE_REF_INVALID',
      pointer(path, 'sourceRef'),
      'Plugin lock sourceRef is not the canonical logical manifest reference.',
    );
  }

  const manifestSha256 = requiredString(record, 'manifestSha256', path);
  if (!MANIFEST_SHA256_PATTERN.test(manifestSha256)) {
    fail(
      'PLUGIN_LOCK_HASH_INVALID',
      pointer(path, 'manifestSha256'),
      'Plugin lock manifestSha256 must be exactly 64 lowercase hexadecimal characters.',
    );
  }

  const requestedGateMode = requiredString(record, 'requestedGateMode', path);
  if (!GATE_MODES.has(requestedGateMode)) {
    fail(
      'PLUGIN_LOCK_FIELD_INVALID',
      pointer(path, 'requestedGateMode'),
      'Plugin lock requestedGateMode must be SHADOW or ENFORCE.',
    );
  }

  return Object.freeze({
    id,
    version,
    providerKind: providerKind as PluginLockProviderKind,
    sourceRef,
    manifestSha256,
    requestedGateMode: requestedGateMode as PluginGateMode,
  });
}

function validatePluginLock(value: unknown, requireCanonicalOrder: boolean): PluginLockV1 {
  const root = asPlainDataRecord(value, '');
  requireExactFields(root, ROOT_FIELDS, '');

  const schema = requiredString(root, 'schema', '');
  if (schema !== PLUGIN_LOCK_SCHEMA) {
    fail(
      'PLUGIN_LOCK_SCHEMA_UNSUPPORTED',
      '/schema',
      `Unsupported plugin lock schema ${JSON.stringify(schema)}.`,
    );
  }

  const rawEntries = asDenseDataArray(readDataField(root, 'plugins'), '/plugins');
  if (rawEntries.length > MAX_PLUGIN_LOCK_ENTRIES) {
    fail(
      'PLUGIN_LOCK_FIELD_INVALID',
      '/plugins',
      `Plugin lock cannot contain more than ${MAX_PLUGIN_LOCK_ENTRIES} entries.`,
    );
  }
  const entries = rawEntries.map((entry, index) => validateEntry(entry, index));
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      fail(
        'PLUGIN_LOCK_DUPLICATE_ID',
        '/plugins',
        `Plugin lock contains duplicate ID ${JSON.stringify(entry.id)}.`,
      );
    }
    seenIds.add(entry.id);
  }
  if (requireCanonicalOrder) {
    for (let index = 1; index < entries.length; index += 1) {
      if (comparePluginLockEntries(entries[index - 1]!, entries[index]!) >= 0) {
        fail(
          'PLUGIN_LOCK_ORDER_INVALID',
          '/plugins',
          'Plugin lock entries must use ascending ASCII code-unit tuple order.',
        );
      }
    }
  } else {
    entries.sort(comparePluginLockEntries);
  }

  return Object.freeze({
    schema: PLUGIN_LOCK_SCHEMA,
    plugins: Object.freeze(entries),
  });
}

export function createEmptyPluginLock(): PluginLockV1 {
  return Object.freeze({
    schema: PLUGIN_LOCK_SCHEMA,
    plugins: Object.freeze([]),
  });
}

export function parsePluginLockBytes(bytes: Buffer): PluginLockV1 {
  if (!Buffer.isBuffer(bytes)) {
    return fail('PLUGIN_LOCK_BYTES_INVALID', '', 'Plugin lock input must be a Buffer.');
  }
  if (bytes.length > MAX_PLUGIN_LOCK_BYTES) {
    return fail(
      'PLUGIN_LOCK_TOO_LARGE',
      '',
      `Plugin lock exceeds the ${MAX_PLUGIN_LOCK_BYTES}-byte limit.`,
    );
  }
  return validatePluginLock(
    parseStrictJsonBytes(bytes, { maxDepth: 16, maxNodes: 10_000, maxStringLength: 512 }),
    true,
  );
}

export function serializePluginLock(lock: PluginLockV1): Buffer {
  const validated = validatePluginLock(lock, false);
  const canonical = {
    schema: PLUGIN_LOCK_SCHEMA,
    plugins: validated.plugins.map((entry) => ({
      id: entry.id,
      version: entry.version,
      providerKind: entry.providerKind,
      sourceRef: entry.sourceRef,
      manifestSha256: entry.manifestSha256,
      requestedGateMode: entry.requestedGateMode,
    })),
  };
  const bytes = Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
  if (bytes.length > MAX_PLUGIN_LOCK_BYTES) {
    return fail(
      'PLUGIN_LOCK_TOO_LARGE',
      '',
      `Plugin lock exceeds the ${MAX_PLUGIN_LOCK_BYTES}-byte limit.`,
    );
  }
  // Keep serializer and reader ceilings inseparable: every successful serialization must be
  // accepted by the production parser using the exact emitted bytes.
  parsePluginLockBytes(bytes);
  return bytes;
}

function validateWorkspaceRoot(workspaceRoot: string): string {
  if (
    typeof workspaceRoot !== 'string' ||
    workspaceRoot.length === 0 ||
    workspaceRoot.includes('\0') ||
    !isAbsolute(workspaceRoot) ||
    normalize(workspaceRoot) !== workspaceRoot ||
    resolve(workspaceRoot) !== workspaceRoot
  ) {
    return fail(
      'PLUGIN_LOCK_PATH_UNSAFE',
      '',
      'workspaceRoot must be a non-empty, normalized absolute path without NUL bytes.',
    );
  }
  return workspaceRoot;
}

export function lockPathForWorkspace(workspaceRoot: string): string {
  return join(validateWorkspaceRoot(workspaceRoot), '.openslack', 'plugins.lock');
}

function samePath(left: string, right: string): boolean {
  if (process.platform !== 'win32') return left === right;
  const asciiFold = (value: string): string =>
    value.replace(/[A-Z]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) + ('a'.charCodeAt(0) - 'A'.charCodeAt(0))),
    );
  return asciiFold(left) === asciiFold(right);
}

function isContainedPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
  );
}

async function safeLockDirectory(workspaceRoot: string): Promise<{
  readonly root: string;
  readonly directory: string;
  readonly realDirectory: string;
}> {
  const root = validateWorkspaceRoot(workspaceRoot);
  const directory = join(root, '.openslack');
  let rootStat;
  let directoryStat;
  try {
    rootStat = await lstat(root);
    directoryStat = await lstat(directory);
  } catch {
    return fail(
      'PLUGIN_LOCK_PATH_UNSAFE',
      directory,
      'The fixed .openslack lock directory must already exist.',
    );
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return fail(
      'PLUGIN_LOCK_PATH_UNSAFE',
      root,
      'workspaceRoot must be a real directory, not a symlink or junction.',
    );
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return fail(
      'PLUGIN_LOCK_PATH_UNSAFE',
      directory,
      'The fixed .openslack lock directory must be a real directory, not a symlink.',
    );
  }

  const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(directory)]);
  if (!samePath(root, realRoot)) {
    return fail(
      'PLUGIN_LOCK_PATH_UNSAFE',
      root,
      'workspaceRoot resolves through a redirect or reparse point.',
    );
  }
  if (!isContainedPath(realRoot, realDirectory)) {
    return fail(
      'PLUGIN_LOCK_PATH_UNSAFE',
      directory,
      'The fixed .openslack lock directory escapes workspaceRoot.',
    );
  }
  const expectedDirectory = join(realRoot, '.openslack');
  if (!samePath(expectedDirectory, realDirectory)) {
    return fail(
      'PLUGIN_LOCK_PATH_UNSAFE',
      directory,
      'The fixed .openslack lock directory resolves through an unsafe redirect.',
    );
  }
  return { root, directory, realDirectory };
}

async function lstatIfPresent(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertSafeExistingLockFile(path: string, realDirectory: string): Promise<Stats> {
  const pathStat = await lstatIfPresent(path);
  if (!pathStat) {
    return fail('PLUGIN_LOCK_FILE_UNSAFE', path, 'Plugin lock file does not exist.');
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    return fail(
      'PLUGIN_LOCK_FILE_UNSAFE',
      path,
      'Plugin lock must be a regular file, not a symlink.',
    );
  }
  const resolvedPath = await realpath(path);
  if (!samePath(resolvedPath, join(realDirectory, 'plugins.lock'))) {
    return fail('PLUGIN_LOCK_FILE_UNSAFE', path, 'Plugin lock resolves outside its fixed path.');
  }
  return pathStat;
}

function statIdentityMatches(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableFileStatMatches(before: Stats, after: Stats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

/**
 * Fault-injection seam for security invariant tests only. Production entry points never accept
 * this configuration.
 *
 * @internal
 */
export interface PluginLockIoTestHooks {
  readonly afterBoundedRead?: (targetPath: string) => void | Promise<void>;
  readonly afterAtomicRename?: (targetPath: string) => void | Promise<void>;
}

const NO_PLUGIN_LOCK_IO_TEST_HOOKS: PluginLockIoTestHooks = Object.freeze({});

interface SafePluginLockRead {
  readonly bytes: Buffer;
  readonly identity: Stats;
}

async function readPluginLockBytes(
  workspaceRoot: string,
  testHooks: PluginLockIoTestHooks,
): Promise<SafePluginLockRead> {
  const { root, realDirectory } = await safeLockDirectory(workspaceRoot);
  const path = lockPathForWorkspace(root);
  const pathStat = await assertSafeExistingLockFile(path, realDirectory);
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !statIdentityMatches(pathStat, before)) {
      return fail(
        'PLUGIN_LOCK_FILE_UNSAFE',
        path,
        'Plugin lock changed identity before it could be read.',
      );
    }
    if (before.size > MAX_PLUGIN_LOCK_BYTES) {
      return fail(
        'PLUGIN_LOCK_TOO_LARGE',
        path,
        `Plugin lock exceeds the ${MAX_PLUGIN_LOCK_BYTES}-byte limit.`,
      );
    }

    const bounded = Buffer.allocUnsafe(MAX_PLUGIN_LOCK_BYTES + 1);
    let length = 0;
    while (length < bounded.length) {
      const result = await handle.read(bounded, length, bounded.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAX_PLUGIN_LOCK_BYTES) {
      return fail(
        'PLUGIN_LOCK_TOO_LARGE',
        path,
        `Plugin lock exceeds the ${MAX_PLUGIN_LOCK_BYTES}-byte limit.`,
      );
    }

    const after = await handle.stat();
    if (!stableFileStatMatches(before, after) || after.size !== length) {
      return fail('PLUGIN_LOCK_FILE_UNSAFE', path, 'Plugin lock changed while it was being read.');
    }
    await testHooks.afterBoundedRead?.(path);
    const afterPathStat = await assertSafeExistingLockFile(path, realDirectory);
    if (!statIdentityMatches(afterPathStat, after)) {
      return fail(
        'PLUGIN_LOCK_FILE_UNSAFE',
        path,
        'Plugin lock path changed while it was being read.',
      );
    }
    const repeatedDirectory = await safeLockDirectory(root);
    if (!samePath(repeatedDirectory.realDirectory, realDirectory)) {
      return fail(
        'PLUGIN_LOCK_PATH_UNSAFE',
        path,
        'Plugin lock directory changed while it was being read.',
      );
    }
    return {
      bytes: Buffer.from(bounded.subarray(0, length)),
      identity: after,
    };
  } finally {
    await handle.close();
  }
}

export async function readPluginLock(workspaceRoot: string): Promise<PluginLockV1> {
  const result = await readPluginLockBytes(workspaceRoot, NO_PLUGIN_LOCK_IO_TEST_HOOKS);
  return parsePluginLockBytes(result.bytes);
}

/**
 * Reads through the production implementation with a deterministic fault-injection seam.
 *
 * @internal
 */
export async function readPluginLockForTest(
  workspaceRoot: string,
  testHooks: PluginLockIoTestHooks,
): Promise<PluginLockV1> {
  const result = await readPluginLockBytes(workspaceRoot, testHooks);
  return parsePluginLockBytes(result.bytes);
}

async function assertOptionalSafeTarget(path: string, realDirectory: string): Promise<void> {
  const pathStat = await lstatIfPresent(path);
  if (!pathStat) return;
  await assertSafeExistingLockFile(path, realDirectory);
}

async function writeAll(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (result.bytesWritten < 1) {
      throw new Error('Could not make progress while writing the plugin lock.');
    }
    offset += result.bytesWritten;
  }
}

async function writePluginLockAtomicInternal(
  workspaceRoot: string,
  lock: PluginLockV1,
  testHooks: PluginLockIoTestHooks,
): Promise<void> {
  const bytes = serializePluginLock(lock);
  const { root, directory, realDirectory } = await safeLockDirectory(workspaceRoot);
  const path = lockPathForWorkspace(root);
  await assertOptionalSafeTarget(path, realDirectory);

  const temporaryPath = join(directory, `.plugins.lock.${process.pid}.${randomUUID()}.tmp`);
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600,
    );
    await writeAll(handle, bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const repeatedDirectory = await safeLockDirectory(root);
    if (!samePath(repeatedDirectory.realDirectory, realDirectory)) {
      return fail(
        'PLUGIN_LOCK_PATH_UNSAFE',
        directory,
        'Plugin lock directory changed before the atomic replacement.',
      );
    }
    const temporaryRealPath = await realpath(temporaryPath);
    if (!samePath(dirname(temporaryRealPath), realDirectory)) {
      return fail(
        'PLUGIN_LOCK_PATH_UNSAFE',
        temporaryPath,
        'Temporary plugin lock escaped the fixed lock directory.',
      );
    }
    await assertOptionalSafeTarget(path, realDirectory);
    await rename(temporaryPath, path);
    const installedIdentity = await assertSafeExistingLockFile(path, realDirectory);
    await testHooks.afterAtomicRename?.(path);
    const readback = await readPluginLockBytes(root, NO_PLUGIN_LOCK_IO_TEST_HOOKS);
    if (!statIdentityMatches(installedIdentity, readback.identity)) {
      return fail(
        'PLUGIN_LOCK_FILE_UNSAFE',
        path,
        'Plugin lock changed identity before post-write verification completed.',
      );
    }
    if (!readback.bytes.equals(bytes)) {
      return fail(
        'PLUGIN_LOCK_FILE_UNSAFE',
        path,
        'Plugin lock bytes did not match the exact atomic write payload.',
      );
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export async function writePluginLockAtomic(
  workspaceRoot: string,
  lock: PluginLockV1,
): Promise<void> {
  await writePluginLockAtomicInternal(workspaceRoot, lock, NO_PLUGIN_LOCK_IO_TEST_HOOKS);
}

/**
 * Writes through the production implementation with a deterministic fault-injection seam.
 *
 * @internal
 */
export async function writePluginLockAtomicForTest(
  workspaceRoot: string,
  lock: PluginLockV1,
  testHooks: PluginLockIoTestHooks,
): Promise<void> {
  await writePluginLockAtomicInternal(workspaceRoot, lock, testHooks);
}
