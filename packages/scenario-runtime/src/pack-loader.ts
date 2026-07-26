import { createHash } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  parseStrictGraphJson,
  StrictGraphJsonError,
  type StrictJsonObject,
  type StrictJsonValue,
} from '@openslack/organization-graph';
import {
  assertCanonicalCapabilityId,
  isNonOverridableForbiddenCapability,
  SCENARIO_RISK_LEVELS,
} from './capabilities.js';
import { ScenarioHostCatalog } from './catalog.js';
import {
  parseScenarioManifest,
  parseScenarioPackFiles,
  isCanonicalScenarioSemver,
  SCENARIO_PACK_LIMITS,
  SCENARIO_PACK_LOCK_SCHEMA,
  type ParsedScenarioPackFiles,
  type ScenarioFixture,
  type ScenarioPackLock,
  type ScenarioPackLockEntry,
} from './pack-schema.js';

const PACK_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FILE_PATH_PATTERN =
  /^(?:scenario|ontology|projections|workflows|capabilities|policies|views|notifications)\.yaml$|^fixtures\/[a-z][a-z0-9-]*\.yaml$/;
const LOCK_FILE = 'scenario.lock.json';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);

export type ScenarioPackLoadErrorCode =
  | 'SCENARIO_PACK_SOURCE_INVALID'
  | 'SCENARIO_PACK_SOURCE_OUTSIDE_ROOT'
  | 'SCENARIO_PACK_SOURCE_SYMLINK'
  | 'SCENARIO_PACK_NOT_FOUND'
  | 'SCENARIO_PACK_FILE_UNSAFE'
  | 'SCENARIO_PACK_LIMIT_EXCEEDED'
  | 'SCENARIO_PACK_FILE_CHANGED'
  | 'SCENARIO_PACK_FILE_SET_MISMATCH'
  | 'SCENARIO_PACK_LOCK_INVALID'
  | 'SCENARIO_PACK_INTEGRITY_MISMATCH'
  | 'SCENARIO_PACK_REFERENCE_MISSING'
  | 'SCENARIO_PACK_POLICY_DENIED';

export class ScenarioPackLoadError extends Error {
  readonly code: ScenarioPackLoadErrorCode;
  readonly path?: string;

  constructor(code: ScenarioPackLoadErrorCode, message: string, path?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ScenarioPackLoadError';
    this.code = code;
    this.path = path;
  }
}

export interface ScenarioDefinitionFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface LoadedScenarioFixture extends ScenarioFixture {
  readonly sourcePath: string;
  readonly contentHash: string;
}

export interface LoadedScenarioDefinition extends Omit<ParsedScenarioPackFiles, 'fixtures'> {
  readonly schema: 'openslack.scenario_definition.v1';
  readonly definitionHash: string;
  readonly sourceRef: string;
  readonly files: readonly ScenarioDefinitionFile[];
  readonly fixtures: readonly LoadedScenarioFixture[];
}

export interface LoadScenarioPackOptions {
  readonly scenarioRoot: string;
  readonly scenarioId: string;
  readonly catalog: ScenarioHostCatalog;
  readonly maxFileBytes?: number;
  readonly maxTotalBytes?: number;
  readonly maxDirectoryEntries?: number;
}

const LOADED_DEFINITIONS = new WeakSet<object>();

export function assertLoadedScenarioDefinition(
  value: unknown,
): asserts value is LoadedScenarioDefinition {
  if (typeof value !== 'object' || value === null || !LOADED_DEFINITIONS.has(value)) {
    return fail(
      'SCENARIO_PACK_POLICY_DENIED',
      'A loader-produced immutable Scenario Definition is required.',
    );
  }
}

interface LoadHooks {
  readonly afterBoundedRead?: (path: string) => void | Promise<void>;
}
interface SafeRead {
  readonly bytes: Buffer;
  readonly stat: Stats;
  readonly realPath: string;
  readonly targetPath: string;
}

const NO_HOOKS: LoadHooks = Object.freeze({});

function fail(
  code: ScenarioPackLoadErrorCode,
  message: string,
  path?: string,
  cause?: unknown,
): never {
  throw new ScenarioPackLoadError(code, message, path, cause);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value);
  return normalize(left) === normalize(right);
}

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableIdentity(left: Stats, right: Stats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function inspectPath(path: string, kind: 'file' | 'directory'): Promise<Stats> {
  let stat: Stats;
  try {
    stat = await lstat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return fail('SCENARIO_PACK_NOT_FOUND', 'Scenario Pack path does not exist.', path, error);
    }
    return fail('SCENARIO_PACK_FILE_UNSAFE', 'Scenario Pack path could not be inspected.', path);
  }
  if (stat.isSymbolicLink()) {
    return fail('SCENARIO_PACK_SOURCE_SYMLINK', 'Scenario Pack symlinks are forbidden.', path);
  }
  if ((kind === 'file' && !stat.isFile()) || (kind === 'directory' && !stat.isDirectory())) {
    return fail('SCENARIO_PACK_FILE_UNSAFE', `Scenario Pack ${kind} is not ordinary.`, path);
  }
  return stat;
}

function boundedOption(value: number | undefined, ceiling: number, name: string): number {
  if (value === undefined) return ceiling;
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    return fail(
      'SCENARIO_PACK_SOURCE_INVALID',
      `${name} may lower but cannot raise its built-in ceiling.`,
    );
  }
  return value;
}

async function prepareRoot(options: LoadScenarioPackOptions): Promise<{
  root: string;
  rootReal: string;
  rootStat: Stats;
  pack: string;
  packReal: string;
  packStat: Stats;
}> {
  if (
    typeof options.scenarioRoot !== 'string' ||
    !isAbsolute(options.scenarioRoot) ||
    resolve(options.scenarioRoot) !== options.scenarioRoot ||
    options.scenarioRoot.includes('\0')
  ) {
    return fail('SCENARIO_PACK_SOURCE_INVALID', 'scenarioRoot must be a normalized absolute path.');
  }
  if (
    typeof options.scenarioId !== 'string' ||
    options.scenarioId.length > 64 ||
    !PACK_ID_PATTERN.test(options.scenarioId)
  ) {
    return fail('SCENARIO_PACK_SOURCE_INVALID', 'Scenario ID is invalid.');
  }
  ScenarioHostCatalog.assertSealed(options.catalog);
  const root = options.scenarioRoot;
  const rootStat = await inspectPath(root, 'directory');
  const rootReal = await realpath(root);
  if (!samePath(root, rootReal)) {
    return fail(
      'SCENARIO_PACK_SOURCE_SYMLINK',
      'Configured scenario root must not traverse a symlink.',
      root,
    );
  }
  const pack = join(root, options.scenarioId);
  const packStat = await inspectPath(pack, 'directory');
  const packReal = await realpath(pack);
  if (!contained(rootReal, packReal) || !samePath(pack, packReal)) {
    return fail(
      'SCENARIO_PACK_SOURCE_OUTSIDE_ROOT',
      'Scenario Pack directory escapes its configured root.',
      pack,
    );
  }
  return { root, rootReal, rootStat, pack, packReal, packStat };
}

async function enumeratePack(
  pack: string,
  maxDirectoryEntries: number,
): Promise<readonly string[]> {
  const result: string[] = [];
  let count = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    count += entries.length;
    if (count > maxDirectoryEntries) {
      return fail(
        'SCENARIO_PACK_LIMIT_EXCEEDED',
        'Scenario Pack directory entry limit exceeded.',
        directory,
      );
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (
        entry.name.length === 0 ||
        entry.name.includes('/') ||
        entry.name.includes('\\') ||
        entry.name.includes(':') ||
        entry.name === '.' ||
        entry.name === '..'
      ) {
        return fail('SCENARIO_PACK_FILE_UNSAFE', 'Scenario Pack entry name is unsafe.', directory);
      }
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        return fail('SCENARIO_PACK_SOURCE_SYMLINK', 'Scenario Pack symlinks are forbidden.', path);
      }
      const logical = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (logical !== 'fixtures' || !stat.isDirectory()) {
          return fail(
            'SCENARIO_PACK_FILE_SET_MISMATCH',
            'Only the declared fixtures directory may be present.',
            path,
          );
        }
        await visit(path, logical);
      } else if (entry.isFile() && stat.isFile()) {
        result.push(logical);
      } else {
        return fail('SCENARIO_PACK_FILE_UNSAFE', 'Scenario Pack entry is not regular.', path);
      }
    }
  };
  await visit(pack, '');
  return Object.freeze(result.sort());
}

async function readBoundedFile(
  prepared: Awaited<ReturnType<typeof prepareRoot>>,
  logicalPath: string,
  maxBytes: number,
  hooks: LoadHooks,
): Promise<SafeRead> {
  if (logicalPath !== LOCK_FILE && !FILE_PATH_PATTERN.test(logicalPath)) {
    return fail('SCENARIO_PACK_FILE_UNSAFE', 'Scenario Pack logical file path is unsafe.');
  }
  const target = join(prepared.pack, ...logicalPath.split('/'));
  const segments = logicalPath.split('/');
  let current = prepared.pack;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index]!);
    await inspectPath(current, 'directory');
    const real = await realpath(current);
    if (!contained(prepared.packReal, real) || !samePath(current, real)) {
      return fail(
        'SCENARIO_PACK_SOURCE_OUTSIDE_ROOT',
        'Scenario Pack directory path changed or escaped.',
        current,
      );
    }
  }
  const initial = await inspectPath(target, 'file');
  if (initial.size > maxBytes) {
    return fail('SCENARIO_PACK_LIMIT_EXCEEDED', 'Scenario Pack file exceeds limit.', target);
  }
  const initialReal = await realpath(target);
  if (!contained(prepared.packReal, initialReal) || !samePath(target, initialReal)) {
    return fail(
      'SCENARIO_PACK_SOURCE_OUTSIDE_ROOT',
      'Scenario Pack file escapes its configured root.',
      target,
    );
  }
  const handle = await open(target, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameIdentity(initial, before) || before.size > maxBytes) {
      return fail('SCENARIO_PACK_FILE_CHANGED', 'Scenario Pack file changed before read.', target);
    }
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      return fail('SCENARIO_PACK_LIMIT_EXCEEDED', 'Scenario Pack file exceeds limit.', target);
    }
    const after = await handle.stat();
    if (!stableIdentity(before, after) || after.size !== offset) {
      return fail('SCENARIO_PACK_FILE_CHANGED', 'Scenario Pack file changed during read.', target);
    }
    await hooks.afterBoundedRead?.(target);
    const final = await inspectPath(target, 'file');
    const finalReal = await realpath(target);
    if (
      !stableIdentity(after, final) ||
      final.size !== offset ||
      !samePath(finalReal, initialReal) ||
      !contained(prepared.packReal, finalReal)
    ) {
      return fail('SCENARIO_PACK_FILE_CHANGED', 'Scenario Pack file changed after read.', target);
    }
    return {
      bytes: Buffer.from(bytes.subarray(0, offset)),
      stat: final,
      realPath: finalReal,
      targetPath: target,
    };
  } finally {
    await handle.close();
  }
}

function own(record: StrictJsonObject, key: string): StrictJsonValue | undefined {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function record(value: StrictJsonValue, path: string): StrictJsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail('SCENARIO_PACK_LOCK_INVALID', `Lock ${path} must be an object.`);
  }
  return value;
}

function exact(record: StrictJsonObject, fields: readonly string[], path: string): void {
  const keys = Object.keys(record);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(record, field)) ||
    keys.some((key) => !fields.includes(key))
  ) {
    return fail('SCENARIO_PACK_LOCK_INVALID', `Lock ${path} has missing or unknown fields.`);
  }
}

function lockString(value: StrictJsonValue | undefined, field: string, pattern: RegExp): string {
  if (typeof value !== 'string' || value.length > 512 || !pattern.test(value)) {
    return fail('SCENARIO_PACK_LOCK_INVALID', `Lock ${field} is invalid.`);
  }
  return value;
}

function parseLock(bytes: Buffer): ScenarioPackLock {
  let value: StrictJsonValue;
  try {
    value = parseStrictGraphJson(bytes, { maxDepth: 8, maxNodes: 256, maxStringLength: 512 });
  } catch (error) {
    return fail(
      'SCENARIO_PACK_LOCK_INVALID',
      error instanceof StrictGraphJsonError
        ? `Scenario Pack lock JSON is invalid (${error.code}).`
        : 'Scenario Pack lock JSON is invalid.',
      LOCK_FILE,
    );
  }
  const root = record(value, '/');
  exact(root, ['schema', 'scenarioId', 'scenarioVersion', 'files'], '/');
  if (own(root, 'schema') !== SCENARIO_PACK_LOCK_SCHEMA) {
    return fail('SCENARIO_PACK_LOCK_INVALID', 'Scenario Pack lock schema is unsupported.');
  }
  const scenarioId = lockString(own(root, 'scenarioId'), 'scenarioId', PACK_ID_PATTERN);
  const scenarioVersion = lockString(
    own(root, 'scenarioVersion'),
    'scenarioVersion',
    /^[\x21-\x7e]+$/,
  );
  if (!isCanonicalScenarioSemver(scenarioVersion)) {
    return fail('SCENARIO_PACK_LOCK_INVALID', 'Scenario Pack lock version is invalid.');
  }
  const filesValue = own(root, 'files');
  if (!Array.isArray(filesValue) || filesValue.length > SCENARIO_PACK_LIMITS.maxFiles) {
    return fail('SCENARIO_PACK_LOCK_INVALID', 'Scenario Pack lock files are invalid.');
  }
  const files: ScenarioPackLockEntry[] = filesValue.map((item, index) => {
    const itemRecord = record(item, `/files/${index}`);
    exact(itemRecord, ['path', 'bytes', 'sha256'], `/files/${index}`);
    const path = lockString(own(itemRecord, 'path'), `files/${index}/path`, FILE_PATH_PATTERN);
    const byteLength = own(itemRecord, 'bytes');
    if (
      typeof byteLength !== 'number' ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > SCENARIO_PACK_LIMITS.maxFileBytes
    ) {
      return fail('SCENARIO_PACK_LOCK_INVALID', 'Scenario Pack lock byte length is invalid.');
    }
    const sha256 = lockString(own(itemRecord, 'sha256'), `files/${index}/sha256`, SHA256_PATTERN);
    return Object.freeze({ path, bytes: byteLength, sha256 });
  });
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some(
      (file, index) =>
        file.path !== [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'))[index]?.path,
    )
  ) {
    return fail(
      'SCENARIO_PACK_LOCK_INVALID',
      'Scenario Pack lock entries must be unique and sorted.',
    );
  }
  return Object.freeze({
    schema: SCENARIO_PACK_LOCK_SCHEMA,
    scenarioId,
    scenarioVersion,
    files: Object.freeze(files),
  });
}

function calculateDefinitionHash(files: readonly ScenarioDefinitionFile[]): string {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path, 'utf8');
    hash.update('\0');
    hash.update(String(file.bytes), 'ascii');
    hash.update('\0');
    hash.update(file.sha256, 'ascii');
    hash.update('\n');
  }
  return hash.digest('hex');
}

function riskRank(value: (typeof SCENARIO_RISK_LEVELS)[number]): number {
  return SCENARIO_RISK_LEVELS.indexOf(value);
}

function validateRegisteredReferences(
  parsed: ParsedScenarioPackFiles,
  catalog: ScenarioHostCatalog,
): void {
  if (parsed.policies.constraints.allowExternalTargets) {
    return fail(
      'SCENARIO_PACK_POLICY_DENIED',
      'Scenario Pack v1 cannot broaden the host target scope.',
    );
  }
  const ontologyTypes = new Set(parsed.ontology.types.map((item) => item.id));
  const ontologyRelationships = new Set(parsed.ontology.relationships.map((item) => item.id));
  const registeredNodeTypes = new Set<string>();
  const registeredEdgeTypes = new Set<string>();
  for (const projection of parsed.projections.projectors) {
    const registered = catalog.projector(projection.id);
    if (!registered || registered.adapterId !== projection.adapterId) {
      return fail(
        'SCENARIO_PACK_REFERENCE_MISSING',
        `Projector ${projection.id} is not present in the sealed host catalog.`,
      );
    }
    if (catalog.adapter(projection.adapterId)?.kind !== 'projection') {
      return fail('SCENARIO_PACK_REFERENCE_MISSING', 'Projection adapter reference is invalid.');
    }
    for (const nodeType of registered.nodeTypes) registeredNodeTypes.add(nodeType);
    for (const edgeType of registered.edgeTypes) registeredEdgeTypes.add(edgeType);
  }
  if (
    ontologyTypes.size !== registeredNodeTypes.size ||
    [...registeredNodeTypes].some((type) => !ontologyTypes.has(type)) ||
    ontologyRelationships.size !== registeredEdgeTypes.size ||
    [...registeredEdgeTypes].some((type) => !ontologyRelationships.has(type))
  ) {
    return fail(
      'SCENARIO_PACK_REFERENCE_MISSING',
      'Scenario ontology must exactly match the sealed projector vocabulary.',
    );
  }
  const requested = new Set(parsed.capabilities.requested);
  for (const capabilityId of parsed.capabilities.requested) {
    assertCanonicalCapabilityId(capabilityId);
    if (isNonOverridableForbiddenCapability(capabilityId) || !catalog.capability(capabilityId)) {
      return fail(
        'SCENARIO_PACK_REFERENCE_MISSING',
        `Capability ${capabilityId} is forbidden or not registered.`,
      );
    }
    const capability = catalog.capability(capabilityId)!;
    if (
      riskRank(capability.risk) > riskRank(parsed.policies.constraints.maxRisk) ||
      !catalog.adapter(capability.adapterId)
    ) {
      return fail(
        'SCENARIO_PACK_POLICY_DENIED',
        `Capability ${capabilityId} exceeds the pack's narrowing policy.`,
      );
    }
  }
  if (parsed.workflows.workflows.length > parsed.policies.constraints.maxWorkflowRuns) {
    return fail('SCENARIO_PACK_POLICY_DENIED', 'Workflow count exceeds the pack policy.');
  }
  for (const workflow of parsed.workflows.workflows) {
    const registered = catalog.workflow(workflow.id);
    if (!registered || registered.adapterId !== workflow.adapterId) {
      return fail(
        'SCENARIO_PACK_REFERENCE_MISSING',
        `Workflow ${workflow.id} is not present in the sealed host catalog.`,
      );
    }
    if (catalog.adapter(workflow.adapterId)?.kind !== 'workflow') {
      return fail('SCENARIO_PACK_REFERENCE_MISSING', 'Workflow adapter reference is invalid.');
    }
    for (const capabilityId of workflow.capabilityIds) {
      if (!requested.has(capabilityId) || !registered.capabilityIds.includes(capabilityId)) {
        return fail(
          'SCENARIO_PACK_REFERENCE_MISSING',
          `Workflow ${workflow.id} requests an unbound capability.`,
        );
      }
    }
  }
  for (const view of parsed.views.views) {
    if (view.nodeTypes.some((type) => !ontologyTypes.has(type))) {
      return fail('SCENARIO_PACK_REFERENCE_MISSING', `View ${view.id} has an unknown node type.`);
    }
    if (view.deepLinkTemplateId !== undefined) {
      const template = catalog.deepLinkTemplate(view.deepLinkTemplateId);
      if (
        !template ||
        view.deepLinkArguments?.some(
          (argument) => !template.allowedArgumentNames.includes(argument),
        )
      ) {
        return fail(
          'SCENARIO_PACK_REFERENCE_MISSING',
          `View ${view.id} deep-link reference is not registered.`,
        );
      }
    }
  }
  for (const mapping of parsed.notifications.mappings) {
    if (!catalog.notificationIntent(mapping.intentType)) {
      return fail(
        'SCENARIO_PACK_REFERENCE_MISSING',
        `Notification intent ${mapping.intentType} is not registered.`,
      );
    }
  }
  for (const fixture of parsed.fixtures) {
    if (fixture.records.some((item) => !ontologyTypes.has(item.type))) {
      return fail('SCENARIO_PACK_REFERENCE_MISSING', `Fixture ${fixture.id} has an unknown type.`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(deepFreeze);
  else if (typeof value === 'object' && value !== null) Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

async function loadInternal(
  options: LoadScenarioPackOptions,
  hooks: LoadHooks,
): Promise<LoadedScenarioDefinition> {
  const prepared = await prepareRoot(options);
  const maxFileBytes = boundedOption(
    options.maxFileBytes,
    SCENARIO_PACK_LIMITS.maxFileBytes,
    'maxFileBytes',
  );
  const maxTotalBytes = boundedOption(
    options.maxTotalBytes,
    SCENARIO_PACK_LIMITS.maxTotalBytes,
    'maxTotalBytes',
  );
  const maxDirectoryEntries = boundedOption(
    options.maxDirectoryEntries,
    SCENARIO_PACK_LIMITS.maxDirectoryEntries,
    'maxDirectoryEntries',
  );
  const actualFiles = await enumeratePack(prepared.pack, maxDirectoryEntries);
  if (!actualFiles.includes('scenario.yaml') || !actualFiles.includes(LOCK_FILE)) {
    return fail('SCENARIO_PACK_FILE_SET_MISMATCH', 'Required Scenario Pack files are missing.');
  }
  if (actualFiles.length > SCENARIO_PACK_LIMITS.maxFiles + 1) {
    return fail('SCENARIO_PACK_LIMIT_EXCEEDED', 'Scenario Pack file count exceeds limit.');
  }

  const bytes = new Map<string, Buffer>();
  const initialReads = new Map<string, SafeRead>();
  let total = 0;
  for (const logicalPath of actualFiles) {
    const read = await readBoundedFile(prepared, logicalPath, maxFileBytes, hooks);
    const value = read.bytes;
    total += value.length;
    if (total > maxTotalBytes) {
      return fail('SCENARIO_PACK_LIMIT_EXCEEDED', 'Scenario Pack total bytes exceed limit.');
    }
    bytes.set(logicalPath, value);
    initialReads.set(logicalPath, read);
  }
  const manifest = parseScenarioManifest(bytes.get('scenario.yaml')!);
  if (manifest.id !== options.scenarioId) {
    return fail('SCENARIO_PACK_SOURCE_INVALID', 'Scenario Pack ID does not match its directory.');
  }
  const expectedFiles = [...manifest.files, LOCK_FILE].sort();
  if (
    expectedFiles.length !== actualFiles.length ||
    expectedFiles.some((path, index) => path !== actualFiles[index])
  ) {
    return fail(
      'SCENARIO_PACK_FILE_SET_MISMATCH',
      'Scenario Pack contains undeclared, duplicate, or missing files.',
    );
  }
  const lock = parseLock(bytes.get(LOCK_FILE)!);
  if (
    lock.scenarioId !== manifest.id ||
    lock.scenarioVersion !== manifest.version ||
    lock.files.length !== manifest.files.length ||
    lock.files.some((entry, index) => entry.path !== manifest.files[index])
  ) {
    return fail('SCENARIO_PACK_LOCK_INVALID', 'Scenario Pack lock identity or file set drifted.');
  }
  const fileRecords = lock.files.map((entry) => {
    const value = bytes.get(entry.path)!;
    const sha256 = createHash('sha256').update(value).digest('hex');
    if (value.length !== entry.bytes || sha256 !== entry.sha256) {
      return fail(
        'SCENARIO_PACK_INTEGRITY_MISMATCH',
        'Scenario Pack exact-byte integrity verification failed.',
        entry.path,
      );
    }
    return Object.freeze({ path: entry.path, bytes: entry.bytes, sha256 });
  });
  const parsed = parseScenarioPackFiles(bytes, manifest);
  validateRegisteredReferences(parsed, options.catalog);

  const fixturePaths = manifest.files.filter((path) => path.startsWith('fixtures/'));
  const fixtures = parsed.fixtures.map((fixture, index) =>
    Object.freeze({
      ...fixture,
      sourcePath: fixturePaths[index]!,
      contentHash: fileRecords.find((record) => record.path === fixturePaths[index])!.sha256,
    }),
  );

  const finalRoot = await inspectPath(prepared.root, 'directory');
  const finalPack = await inspectPath(prepared.pack, 'directory');
  const finalRootReal = await realpath(prepared.root);
  const finalPackReal = await realpath(prepared.pack);
  if (
    !sameIdentity(prepared.rootStat, finalRoot) ||
    !sameIdentity(prepared.packStat, finalPack) ||
    !samePath(prepared.rootReal, finalRootReal) ||
    !samePath(prepared.packReal, finalPackReal)
  ) {
    return fail(
      'SCENARIO_PACK_FILE_CHANGED',
      'Scenario Pack directory identity changed while loading.',
    );
  }
  const finalFiles = await enumeratePack(prepared.pack, maxDirectoryEntries);
  if (
    finalFiles.length !== actualFiles.length ||
    finalFiles.some((path, index) => path !== actualFiles[index])
  ) {
    return fail(
      'SCENARIO_PACK_FILE_CHANGED',
      'Scenario Pack file set changed while loading.',
      prepared.pack,
    );
  }
  const finalReads: SafeRead[] = [];
  for (const logicalPath of actualFiles) {
    const read = await readBoundedFile(prepared, logicalPath, maxFileBytes, NO_HOOKS);
    const initialRead = initialReads.get(logicalPath)!;
    if (
      !read.bytes.equals(bytes.get(logicalPath)!) ||
      !sameIdentity(initialRead.stat, read.stat) ||
      !samePath(initialRead.realPath, read.realPath)
    ) {
      return fail(
        'SCENARIO_PACK_FILE_CHANGED',
        'Scenario Pack bytes changed after initial validation.',
        logicalPath,
      );
    }
    finalReads.push(read);
  }
  for (const read of finalReads) {
    const stat = await inspectPath(read.targetPath, 'file');
    const resolvedPath = await realpath(read.targetPath);
    if (!stableIdentity(read.stat, stat) || !samePath(read.realPath, resolvedPath)) {
      return fail(
        'SCENARIO_PACK_FILE_CHANGED',
        'Scenario Pack file identity changed before publication.',
        read.targetPath,
      );
    }
  }
  const publishedRoot = await inspectPath(prepared.root, 'directory');
  const publishedPack = await inspectPath(prepared.pack, 'directory');
  const publishedFiles = await enumeratePack(prepared.pack, maxDirectoryEntries);
  if (
    !sameIdentity(prepared.rootStat, publishedRoot) ||
    !sameIdentity(prepared.packStat, publishedPack) ||
    publishedFiles.length !== actualFiles.length ||
    publishedFiles.some((path, index) => path !== actualFiles[index])
  ) {
    return fail(
      'SCENARIO_PACK_FILE_CHANGED',
      'Scenario Pack changed before immutable publication.',
      prepared.pack,
    );
  }
  const definition: LoadedScenarioDefinition = deepFreeze({
    schema: 'openslack.scenario_definition.v1' as const,
    definitionHash: calculateDefinitionHash(fileRecords),
    sourceRef: `scenarios/${manifest.id}`,
    files: fileRecords,
    ...parsed,
    fixtures,
  });
  LOADED_DEFINITIONS.add(definition);
  return definition;
}

export async function loadScenarioPack(
  options: LoadScenarioPackOptions,
): Promise<LoadedScenarioDefinition> {
  return loadInternal(options, NO_HOOKS);
}

/** @internal deterministic security race seam; intentionally not exported from package root. */
export async function loadScenarioPackForTest(
  options: LoadScenarioPackOptions,
  hooks: LoadHooks,
): Promise<LoadedScenarioDefinition> {
  return loadInternal(options, hooks);
}
