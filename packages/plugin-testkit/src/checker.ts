import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';

import {
  isPluginDiagnosticCode,
  isPluginManifestAuthorityFieldName,
  isPluginManifestExecutableFieldName,
  validatePluginManifest,
  type PluginDiagnosticCode,
  type PluginDiagnosticFinding,
  type PluginManifestV1,
} from '@openslack/plugin-api';

import { PLUGIN_CHECK_IDS, type PluginCheckId } from './checks.js';
import {
  createPluginCheckResults,
  PLUGIN_CHECK_REPORT_SCHEMA,
  type PluginCheckReport,
} from './report.js';
import { parseStrictJsonBytes, StrictJsonError, type StrictJsonValue } from './strict-json.js';

const MANIFEST_FILE_NAME = 'plugin.json';
const MANIFEST_MAX_BYTES = 256 * 1024;
const LOCK_MAX_BYTES = 256 * 1024;
const LOCK_MAX_ENTRIES = 512;
const LOCK_SCHEMA = 'openslack.plugins_lock.v1';
const FULL_SEMVER =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PLUGIN_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH = /^[0-9a-f]{64}$/;
const AUTHORITY_OR_MUTATION_TARGET_TERMS = new Set([
  'approve',
  'approved',
  'approval',
  'approvals',
  'approver',
  'approvers',
  'merge',
  'merged',
  'merges',
  'merging',
  'mergeable',
  'create',
  'created',
  'creates',
  'creating',
  'creator',
  'creators',
  'delete',
  'deleted',
  'deletes',
  'deleting',
  'deleter',
  'deleters',
  'update',
  'updated',
  'updates',
  'updating',
  'updater',
  'updaters',
  'write',
  'writes',
  'wrote',
  'written',
  'writing',
  'writer',
  'writers',
  'comment',
  'commented',
  'commenting',
  'comments',
  'commenter',
  'commenters',
  'close',
  'closed',
  'closes',
  'closing',
  'reopen',
  'reopened',
  'reopening',
  'reopens',
  'claim',
  'claimed',
  'claiming',
  'claims',
  'claimer',
  'claimers',
  'assign',
  'assigned',
  'assigning',
  'assigns',
  'assigner',
  'assigners',
  'execute',
  'executed',
  'executes',
  'executing',
  'executor',
  'executors',
  'dispatch',
  'dispatched',
  'dispatches',
  'dispatching',
  'dispatcher',
  'dispatchers',
  'publish',
  'published',
  'publishes',
  'publishing',
  'publisher',
  'publishers',
  'push',
  'pushed',
  'pushes',
  'pushing',
  'pusher',
  'pushers',
  'commit',
  'commits',
  'committed',
  'committing',
  'committer',
  'committers',
  'apply',
  'applied',
  'applies',
  'applying',
  'deliver',
  'delivered',
  'deliveries',
  'delivering',
  'delivery',
  'delivers',
  'mutate',
  'mutated',
  'mutates',
  'mutating',
  'mutation',
  'mutations',
  'mutator',
  'mutators',
]);

function isAuthorityOrMutationTarget(id: string): boolean {
  return id
    .split(/[._-]/)
    .some((term) => AUTHORITY_OR_MUTATION_TARGET_TERMS.has(term.toLowerCase()));
}

export interface CheckPluginOptions {
  readonly workspaceRoot: string;
  readonly workingDirectory?: string;
  readonly openslackVersion: string;
  readonly verifyIntegrity?: boolean;
}

export interface CheckPluginTestHooks {
  readonly afterManifestRead?: (manifestPath: string) => void | Promise<void>;
}

interface LoadedBytes {
  readonly candidatePath: string;
  readonly trustRoot: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

interface LockEntry {
  readonly id: string;
  readonly version: string;
  readonly providerKind: 'workspace' | 'plugin';
  readonly sourceRef: string;
  readonly manifestSha256: string;
  readonly requestedGateMode: 'SHADOW' | 'ENFORCE';
}

class DiagnosticFailure extends Error {
  constructor(
    readonly checkId: PluginCheckId,
    readonly finding: PluginDiagnosticFinding,
  ) {
    super(finding.code);
  }
}

function diagnostic(
  code: PluginDiagnosticCode,
  pathValue: string,
  message: string,
): PluginDiagnosticFinding {
  return Object.freeze({ severity: 'error', code, path: pathValue, message });
}

function fail(
  checkId: PluginCheckId,
  code: PluginDiagnosticCode,
  pathValue: string,
  message: string,
): never {
  throw new DiagnosticFailure(checkId, diagnostic(code, pathValue, message));
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return typeof descriptor?.value === 'string' ? descriptor.value : undefined;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function inspectedLstat(filePath: string, missingCheck: PluginCheckId): Promise<Stats> {
  try {
    return await lstat(filePath);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      fail(missingCheck, 'PLUGIN_MANIFEST_NOT_FOUND', '', 'Plugin manifest source was not found.');
    }
    if (code === 'ELOOP') {
      fail('G3', 'PLUGIN_MANIFEST_SOURCE_SYMLINK', '', 'Plugin manifest source contains a link.');
    }
    fail('G3', 'PLUGIN_MANIFEST_IO_FAILED', '', 'Plugin manifest source could not be inspected.');
  }
}

async function assertSafePath(trustRoot: string, candidate: string): Promise<Stats> {
  if (!isContained(trustRoot, candidate)) {
    fail('G2', 'PLUGIN_MANIFEST_SOURCE_OUTSIDE_ROOT', '', 'Manifest escapes its trust root.');
  }
  const relative = path.relative(trustRoot, candidate);
  let current = trustRoot;
  const components = [trustRoot];
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    components.push(current);
  }
  let candidateStat: Stats | undefined;
  for (const component of components) {
    const stat = await inspectedLstat(component, component === candidate ? 'G1' : 'G3');
    if (stat.isSymbolicLink()) {
      fail(
        'G3',
        'PLUGIN_MANIFEST_SOURCE_SYMLINK',
        '',
        'Manifest path contains a link or junction.',
      );
    }
    if (component !== candidate && !stat.isDirectory()) {
      fail('G3', 'PLUGIN_MANIFEST_NOT_REGULAR_FILE', '', 'Manifest ancestor is not a directory.');
    }
    if (component === candidate) candidateStat = stat;
  }
  if (!candidateStat?.isFile()) {
    fail('G3', 'PLUGIN_MANIFEST_NOT_REGULAR_FILE', '', 'Manifest is not a regular file.');
  }
  return candidateStat;
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function resolveAndReadManifest(
  inputPath: string,
  options: CheckPluginOptions,
  hooks: CheckPluginTestHooks,
): Promise<LoadedBytes> {
  if (inputPath.length === 0 || inputPath.includes('\0')) {
    fail('G1', 'PLUGIN_MANIFEST_SOURCE_INVALID', '', 'Manifest path is empty or contains NUL.');
  }
  if (inputPath.split(/[\\/]/).includes('..')) {
    fail('G2', 'PLUGIN_MANIFEST_SOURCE_OUTSIDE_ROOT', '', 'Manifest path contains traversal.');
  }
  const selected = path.resolve(options.workingDirectory ?? options.workspaceRoot, inputPath);
  const selectedStat = await inspectedLstat(selected, 'G1');
  if (selectedStat.isSymbolicLink()) {
    fail('G3', 'PLUGIN_MANIFEST_SOURCE_SYMLINK', '', 'Manifest source is a link or junction.');
  }

  let candidatePath: string;
  let trustRoot: string;
  if (selectedStat.isDirectory()) {
    trustRoot = selected;
    candidatePath = path.join(selected, MANIFEST_FILE_NAME);
  } else if (selectedStat.isFile() && path.basename(selected) === MANIFEST_FILE_NAME) {
    trustRoot = path.dirname(selected);
    candidatePath = selected;
  } else {
    fail(
      'G1',
      'PLUGIN_MANIFEST_SOURCE_INVALID',
      '',
      'Path must select plugin.json or its directory.',
    );
  }

  if (options.verifyIntegrity) {
    const pluginRoot = path.join(path.resolve(options.workspaceRoot), '.openslack', 'plugins');
    if (!isContained(pluginRoot, candidatePath)) {
      fail(
        'G2',
        'PLUGIN_MANIFEST_SOURCE_OUTSIDE_ROOT',
        '',
        'Integrity verification accepts only workspace plugin manifests.',
      );
    }
    trustRoot = path.resolve(options.workspaceRoot);
  }

  const before = await assertSafePath(trustRoot, candidatePath);
  let realTrustRoot: string;
  let realCandidate: string;
  try {
    [realTrustRoot, realCandidate] = await Promise.all([
      realpath(trustRoot),
      realpath(candidatePath),
    ]);
  } catch {
    fail('G3', 'PLUGIN_MANIFEST_IO_FAILED', '', 'Manifest real path could not be resolved.');
  }
  if (!isContained(realTrustRoot, realCandidate)) {
    fail(
      'G2',
      'PLUGIN_MANIFEST_SOURCE_OUTSIDE_ROOT',
      '',
      'Manifest real path escapes its trust root.',
    );
  }
  if (before.size > MANIFEST_MAX_BYTES) {
    fail('G4', 'PLUGIN_MANIFEST_SIZE_EXCEEDED', '', 'Manifest exceeds 256 KiB.');
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(candidatePath);
  } catch {
    fail('G4', 'PLUGIN_MANIFEST_IO_FAILED', '', 'Manifest bytes could not be read.');
  }
  if (bytes.length > MANIFEST_MAX_BYTES) {
    fail('G4', 'PLUGIN_MANIFEST_SIZE_EXCEEDED', '', 'Manifest exceeds 256 KiB.');
  }
  await hooks.afterManifestRead?.(candidatePath);
  const after = await assertSafePath(trustRoot, candidatePath);
  if (!sameIdentity(before, after) || after.size !== bytes.length) {
    fail('G4', 'PLUGIN_MANIFEST_FILE_CHANGED', '', 'Manifest changed while being read.');
  }
  return {
    candidatePath,
    trustRoot,
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function checkIdForManifestFinding(code: PluginDiagnosticCode, findingPath: string): PluginCheckId {
  if (code === 'PLUGIN_MANIFEST_EXECUTABLE_FIELD_FORBIDDEN') return 'G8';
  if (code === 'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN') return 'G15';
  if (findingPath === '/id') return 'G9';
  if (findingPath === '/version') return 'G10';
  if (findingPath.startsWith('/requires')) return 'G11';
  if (findingPath.startsWith('/gate')) return 'G12';
  if (findingPath.startsWith('/capabilities')) return 'G13';
  if (findingPath.includes('/inputMapping') || findingPath.includes('/inputs')) return 'G16';
  if (findingPath.startsWith('/contributes')) return 'G14';
  return 'G7';
}

function pointer(parent: string, key: string | number): string {
  return `${parent}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function inspectHardDeniedFields(
  value: StrictJsonValue,
  add: (checkId: PluginCheckId, finding: PluginDiagnosticFinding) => void,
  at = '',
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectHardDeniedFields(item, add, pointer(at, index)));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const key of Object.keys(value)) {
    if (isPluginManifestExecutableFieldName(key)) {
      add(
        'G8',
        diagnostic(
          'PLUGIN_MANIFEST_EXECUTABLE_FIELD_FORBIDDEN',
          pointer(at, key),
          'Executable manifest fields are forbidden.',
        ),
      );
    } else if (isPluginManifestAuthorityFieldName(key)) {
      add(
        'G15',
        diagnostic(
          'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN',
          pointer(at, key),
          'Authority-bearing manifest fields are forbidden.',
        ),
      );
    }
    inspectHardDeniedFields(value[key]!, add, pointer(at, key));
  }
}

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

function parseVersion(value: string): Version | undefined {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersion(left: Version, right: Version): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function satisfiesComparator(version: Version, comparator: string): boolean {
  const match = /^(\^|~|>=|<=|>|<|=)?(\d+)\.(\d+)\.(\d+)$/.exec(comparator);
  if (!match) return false;
  const operator = match[1] ?? '=';
  const target = { major: Number(match[2]), minor: Number(match[3]), patch: Number(match[4]) };
  const comparison = compareVersion(version, target);
  if (operator === '=') return comparison === 0;
  if (operator === '>') return comparison > 0;
  if (operator === '>=') return comparison >= 0;
  if (operator === '<') return comparison < 0;
  if (operator === '<=') return comparison <= 0;
  if (comparison < 0) return false;
  const upper =
    operator === '~'
      ? { major: target.major, minor: target.minor + 1, patch: 0 }
      : target.major > 0
        ? { major: target.major + 1, minor: 0, patch: 0 }
        : target.minor > 0
          ? { major: 0, minor: target.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: target.patch + 1 };
  return compareVersion(version, upper) < 0;
}

function compatible(hostVersion: string, range: string): boolean {
  const version = parseVersion(hostVersion);
  return (
    version !== undefined &&
    range.split(' ').every((part) => part.length > 0 && satisfiesComparator(version, part))
  );
}

function exactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === expected.length && sortedExpected.every((field, index) => keys[index] === field)
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function lockFailure(code: PluginDiagnosticCode, pathValue: string, message: string): never {
  fail('G17', code, pathValue, message);
}

function parseLock(value: unknown): readonly LockEntry[] {
  const root = asRecord(value);
  if (!root) lockFailure('PLUGIN_LOCK_NOT_OBJECT', '', 'Plugin lock root must be an object.');
  if (!exactFields(root, ['schema', 'plugins'])) {
    const code =
      !Object.hasOwn(root, 'schema') || !Object.hasOwn(root, 'plugins')
        ? 'PLUGIN_LOCK_FIELD_REQUIRED'
        : 'PLUGIN_LOCK_FIELD_UNKNOWN';
    lockFailure(code, '', 'Plugin lock must contain only schema and plugins.');
  }
  if (root.schema !== LOCK_SCHEMA) {
    lockFailure('PLUGIN_LOCK_SCHEMA_UNSUPPORTED', '/schema', 'Plugin lock schema is unsupported.');
  }
  if (!Array.isArray(root.plugins) || root.plugins.length > LOCK_MAX_ENTRIES) {
    lockFailure('PLUGIN_LOCK_FIELD_INVALID', '/plugins', 'Plugin lock entries are invalid.');
  }
  const entries: LockEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < root.plugins.length; index += 1) {
    const item = asRecord(root.plugins[index]);
    const at = `/plugins/${index}`;
    if (!item) lockFailure('PLUGIN_LOCK_NOT_OBJECT', at, 'Plugin lock entry must be an object.');
    const fields = [
      'id',
      'version',
      'providerKind',
      'sourceRef',
      'manifestSha256',
      'requestedGateMode',
    ];
    if (!exactFields(item, fields)) {
      const missing = fields.some((field) => !Object.hasOwn(item, field));
      lockFailure(
        missing ? 'PLUGIN_LOCK_FIELD_REQUIRED' : 'PLUGIN_LOCK_FIELD_UNKNOWN',
        at,
        'Plugin lock entry fields are not exact.',
      );
    }
    const { id, version, providerKind, sourceRef, manifestSha256, requestedGateMode } = item;
    if (
      typeof id !== 'string' ||
      id.length > 64 ||
      !PLUGIN_ID.test(id) ||
      ['openslack', 'built-in', 'plugin', 'workspace', 'external', 'negentropy'].includes(id) ||
      typeof version !== 'string' ||
      version.length > 128 ||
      !FULL_SEMVER.test(version) ||
      (providerKind !== 'workspace' && providerKind !== 'plugin') ||
      typeof sourceRef !== 'string' ||
      typeof manifestSha256 !== 'string' ||
      (requestedGateMode !== 'SHADOW' && requestedGateMode !== 'ENFORCE')
    ) {
      lockFailure('PLUGIN_LOCK_FIELD_INVALID', at, 'Plugin lock entry values are invalid.');
    }
    const canonicalSource =
      providerKind === 'workspace'
        ? sourceRef === `.openslack/plugins/${id}/plugin.json`
        : sourceRef.length > 0 &&
          sourceRef.length <= 512 &&
          !sourceRef.includes('\\') &&
          !sourceRef
            .split('/')
            .some(
              (segment) =>
                segment === '' ||
                segment === '.' ||
                segment === '..' ||
                !/^[A-Za-z0-9@._+-]+$/.test(segment),
            ) &&
          sourceRef.endsWith('/plugin.json');
    if (!canonicalSource) {
      lockFailure('PLUGIN_LOCK_SOURCE_REF_INVALID', `${at}/sourceRef`, 'Lock sourceRef is unsafe.');
    }
    if (!HASH.test(manifestSha256)) {
      lockFailure('PLUGIN_LOCK_HASH_INVALID', `${at}/manifestSha256`, 'Lock hash is invalid.');
    }
    if (seen.has(id))
      lockFailure('PLUGIN_LOCK_DUPLICATE_ID', '/plugins', 'Lock IDs must be unique.');
    seen.add(id);
    entries.push({ id, version, providerKind, sourceRef, manifestSha256, requestedGateMode });
  }
  for (let index = 1; index < entries.length; index += 1) {
    const previous = entries[index - 1]!;
    const current = entries[index]!;
    const previousTuple = [
      previous.id,
      previous.version,
      previous.providerKind,
      previous.sourceRef,
      previous.manifestSha256,
      previous.requestedGateMode,
    ];
    const currentTuple = [
      current.id,
      current.version,
      current.providerKind,
      current.sourceRef,
      current.manifestSha256,
      current.requestedGateMode,
    ];
    let comparison = 0;
    for (let field = 0; field < previousTuple.length && comparison === 0; field += 1) {
      comparison =
        previousTuple[field]! < currentTuple[field]!
          ? -1
          : previousTuple[field]! > currentTuple[field]!
            ? 1
            : 0;
    }
    if (comparison >= 0) {
      lockFailure('PLUGIN_LOCK_ORDER_INVALID', '/plugins', 'Lock entries are not canonical.');
    }
  }
  return entries;
}

async function verifyLockIntegrity(
  loaded: LoadedBytes,
  manifest: PluginManifestV1,
  workspaceRoot: string,
): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const lockPath = path.join(root, '.openslack', 'plugins.lock');
  let lockStat: Stats;
  try {
    lockStat = await assertSafePath(root, lockPath);
    const [realRoot, realLock] = await Promise.all([realpath(root), realpath(lockPath)]);
    if (!isContained(realRoot, realLock)) {
      lockFailure('PLUGIN_LOCK_PATH_UNSAFE', '', 'Plugin lock escapes its workspace root.');
    }
  } catch (error) {
    if (error instanceof DiagnosticFailure) {
      const pathFailure =
        error.finding.code === 'PLUGIN_MANIFEST_SOURCE_OUTSIDE_ROOT' ||
        error.finding.code === 'PLUGIN_MANIFEST_SOURCE_SYMLINK';
      lockFailure(
        pathFailure ? 'PLUGIN_LOCK_PATH_UNSAFE' : 'PLUGIN_LOCK_FILE_UNSAFE',
        '',
        'Plugin lock path is unsafe.',
      );
    }
    throw error;
  }
  if (lockStat.size > LOCK_MAX_BYTES) {
    lockFailure('PLUGIN_LOCK_TOO_LARGE', '', 'Plugin lock is too large.');
  }
  let lockBytes: Buffer;
  try {
    lockBytes = await readFile(lockPath);
  } catch {
    lockFailure('PLUGIN_LOCK_FILE_UNSAFE', '', 'Plugin lock could not be read.');
  }
  if (lockBytes.length > LOCK_MAX_BYTES)
    lockFailure('PLUGIN_LOCK_TOO_LARGE', '', 'Plugin lock is too large.');
  let lockAfter: Stats;
  try {
    lockAfter = await assertSafePath(root, lockPath);
  } catch {
    lockFailure('PLUGIN_LOCK_FILE_UNSAFE', '', 'Plugin lock changed while being read.');
  }
  if (!sameIdentity(lockStat, lockAfter) || lockAfter.size !== lockBytes.length) {
    lockFailure('PLUGIN_LOCK_FILE_UNSAFE', '', 'Plugin lock changed while being read.');
  }
  let parsed: StrictJsonValue;
  try {
    parsed = parseStrictJsonBytes(lockBytes);
  } catch (error) {
    if (error instanceof StrictJsonError && isPluginDiagnosticCode(error.code)) {
      lockFailure(error.code, '', 'Plugin lock is not strict JSON.');
    }
    lockFailure('PLUGIN_LOCK_BYTES_INVALID', '', 'Plugin lock bytes are invalid.');
  }
  const entries = parseLock(parsed);
  const entry = entries.find((candidate) => candidate.id === manifest.id);
  if (!entry)
    lockFailure('PLUGIN_HOST_LOCK_ENTRY_MISSING', '/plugins', 'Plugin lock entry is missing.');
  const expectedSource = `.openslack/plugins/${manifest.id}/plugin.json`;
  const actualSource = path.relative(root, loaded.candidatePath).split(path.sep).join('/');
  if (
    entry.id !== manifest.id ||
    entry.version !== manifest.version ||
    path.basename(path.dirname(loaded.candidatePath)) !== manifest.id
  ) {
    lockFailure('PLUGIN_HOST_LOCK_IDENTITY_MISMATCH', '/plugins', 'Lock identity does not match.');
  }
  if (
    entry.providerKind !== 'workspace' ||
    entry.sourceRef !== expectedSource ||
    actualSource !== expectedSource
  ) {
    lockFailure('PLUGIN_HOST_LOCK_SOURCE_MISMATCH', '/plugins', 'Lock source does not match.');
  }
  if (entry.manifestSha256 !== loaded.sha256) {
    lockFailure(
      'PLUGIN_HOST_LOCK_HASH_MISMATCH',
      '/plugins',
      'Lock hash does not match exact bytes.',
    );
  }
  if (entry.requestedGateMode !== manifest.gate.mode) {
    lockFailure('PLUGIN_HOST_LOCK_GATE_MISMATCH', '/plugins', 'Lock gate does not match.');
  }
}

function sortFindings(
  findingsByCheck: ReadonlyMap<PluginCheckId, readonly PluginDiagnosticFinding[]>,
): readonly PluginDiagnosticFinding[] {
  const output: PluginDiagnosticFinding[] = [];
  for (const checkId of PLUGIN_CHECK_IDS) {
    output.push(...(findingsByCheck.get(checkId) ?? []));
  }
  return Object.freeze(output);
}

export async function checkPlugin(
  inputPath: string,
  options: CheckPluginOptions,
): Promise<PluginCheckReport> {
  return checkPluginInternal(inputPath, options, {});
}

export async function checkPluginWithTestHooks(
  inputPath: string,
  options: CheckPluginOptions,
  hooks: CheckPluginTestHooks,
): Promise<PluginCheckReport> {
  return checkPluginInternal(inputPath, options, hooks);
}

async function checkPluginInternal(
  inputPath: string,
  options: CheckPluginOptions,
  hooks: CheckPluginTestHooks,
): Promise<PluginCheckReport> {
  const findingsByCheck = new Map<PluginCheckId, PluginDiagnosticFinding[]>();
  const skipped = new Set<PluginCheckId>();
  const add = (checkId: PluginCheckId, finding: PluginDiagnosticFinding): void => {
    const current = findingsByCheck.get(checkId) ?? [];
    if (!current.some((item) => item.code === finding.code && item.path === finding.path)) {
      current.push(finding);
      findingsByCheck.set(checkId, current);
    }
  };
  const skipAfter = (checkId: PluginCheckId): void => {
    const index = PLUGIN_CHECK_IDS.indexOf(checkId);
    PLUGIN_CHECK_IDS.slice(index + 1).forEach((id) => skipped.add(id));
  };

  let loaded: LoadedBytes;
  try {
    loaded = await resolveAndReadManifest(inputPath, options, hooks);
  } catch (error) {
    if (error instanceof DiagnosticFailure) {
      add(error.checkId, error.finding);
      skipAfter(error.checkId);
      const findings = sortFindings(findingsByCheck);
      return Object.freeze({
        schema: PLUGIN_CHECK_REPORT_SCHEMA,
        readiness: 'BLOCKED',
        integrityVerified: false,
        checks: createPluginCheckResults(findingsByCheck, skipped),
        findings,
        authorizationNotice: 'HOST_REAUTHORIZATION_REQUIRED',
      });
    }
    throw error;
  }

  let parsed: StrictJsonValue;
  try {
    parsed = parseStrictJsonBytes(loaded.bytes);
  } catch (error) {
    if (!(error instanceof StrictJsonError) || !isPluginDiagnosticCode(error.code)) throw error;
    const checkId: PluginCheckId =
      error.code === 'STRICT_JSON_UTF8_INVALID' || error.code === 'STRICT_JSON_BOM_FORBIDDEN'
        ? 'G5'
        : 'G6';
    add(checkId, diagnostic(error.code, '', 'Manifest bytes are not accepted strict JSON.'));
    add(checkId, diagnostic('PLUGIN_MANIFEST_JSON_INVALID', '', 'Manifest JSON is invalid.'));
    skipAfter(checkId);
    const findings = sortFindings(findingsByCheck);
    return Object.freeze({
      schema: PLUGIN_CHECK_REPORT_SCHEMA,
      readiness: 'BLOCKED',
      manifestSha256: loaded.sha256,
      integrityVerified: false,
      checks: createPluginCheckResults(findingsByCheck, skipped),
      findings,
      authorizationNotice: 'HOST_REAUTHORIZATION_REQUIRED',
    });
  }

  inspectHardDeniedFields(parsed, add);
  const validation = validatePluginManifest(parsed);
  if (!validation.valid) {
    for (const finding of validation.findings) {
      if (!isPluginDiagnosticCode(finding.code)) continue;
      add(
        checkIdForManifestFinding(finding.code, finding.path),
        diagnostic(finding.code, finding.path, finding.message),
      );
    }
  }

  const manifest: PluginManifestV1 | undefined = validation.valid ? validation.manifest : undefined;
  if (manifest) {
    if (!FULL_SEMVER.test(manifest.version)) {
      add(
        'G10',
        diagnostic('PLUGIN_MANIFEST_VERSION_INVALID', '/version', 'Version is not canonical.'),
      );
    }
    if (!compatible(options.openslackVersion, manifest.requires.openslack)) {
      add(
        'G11',
        diagnostic(
          'PLUGIN_HOST_VERSION_INCOMPATIBLE',
          '/requires/openslack',
          'OpenSlack version does not satisfy the requested range.',
        ),
      );
    }
    const contributionIds = new Set<string>();
    for (let index = 0; index < manifest.contributes.length; index += 1) {
      const contribution = manifest.contributes[index]!;
      const contributionPath = `/contributes/${index}`;
      const registryId = `${contribution.kind}:${contribution.id}`;
      if (contributionIds.has(registryId)) {
        add(
          'G14',
          diagnostic(
            contribution.kind === 'action_alias'
              ? 'PLUGIN_REGISTRY_ACTION_COLLISION'
              : 'PLUGIN_REGISTRY_WORKFLOW_COLLISION',
            `${contributionPath}/id`,
            'Contribution identity collides within the plugin.',
          ),
        );
      }
      contributionIds.add(registryId);
      if (isAuthorityOrMutationTarget(contribution.target.id)) {
        add(
          'G15',
          diagnostic(
            'PLUGIN_ALIAS_TARGET_FORBIDDEN',
            `${contributionPath}/target/id`,
            'Declarative plugins cannot alias authority-bearing or mutating host targets.',
          ),
        );
      }
    }
    if (options.verifyIntegrity) {
      try {
        await verifyLockIntegrity(loaded, manifest, options.workspaceRoot);
      } catch (error) {
        if (error instanceof DiagnosticFailure) add(error.checkId, error.finding);
        else throw error;
      }
    } else {
      skipped.add('G17');
    }
  } else {
    skipped.add('G17');
  }

  const findings = sortFindings(findingsByCheck);
  const report: PluginCheckReport = {
    schema: PLUGIN_CHECK_REPORT_SCHEMA,
    readiness: findings.length === 0 ? 'READY_TO_REGISTER' : 'BLOCKED',
    manifestSha256: loaded.sha256,
    ...(manifest
      ? {
          plugin: {
            id: manifest.id,
            version: manifest.version,
            requestedGateMode: manifest.gate.mode,
          },
        }
      : {}),
    integrityVerified:
      manifest !== undefined &&
      options.verifyIntegrity === true &&
      !skipped.has('G17') &&
      findingsByCheck.get('G17') === undefined,
    checks: createPluginCheckResults(findingsByCheck, skipped),
    findings,
    authorizationNotice: 'HOST_REAUTHORIZATION_REQUIRED',
  };
  return Object.freeze(report);
}
