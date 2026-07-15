import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  ManifestValidationFinding,
  PluginManifestV1,
  PluginManifestValidationResult,
} from '@openslack/plugin-api';
import {
  parseStrictJsonBytes,
  StrictJsonError,
  type JsonObject,
  type JsonValue,
  type StrictJsonLimits,
} from './strict-json.js';

export const PLUGIN_MANIFEST_FILE_NAME = 'plugin.json';
export const PLUGIN_MANIFEST_MAX_BYTES = 256 * 1024;
export const PLUGIN_SOURCE_REF_MAX_LENGTH = 512;

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RESERVED_PLUGIN_IDS = new Set([
  'openslack',
  'built-in',
  'plugin',
  'workspace',
  'external',
  'negentropy',
]);
const EXECUTABLE_FIELD_NAMES = new Set([
  'entry',
  'main',
  'exports',
  'bin',
  'executable',
  'implementation',
  'handler',
  'evaluate',
  'evaluator',
  'predicate',
  'callback',
  'command',
  'argv',
  'args',
  'shell',
  'exec',
  'spawn',
  'template',
  'path',
  'file',
  'module',
  'url',
  'activate',
  'deactivate',
  'raw',
  'rawcommand',
  'raw_command',
]);
const SECURITY_FIELD_NAMES = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'tostring',
  'providerkind',
  'source',
  'lifecycle',
  'state',
  'activationevidence',
  'approval',
  'approvals',
  'approved',
  'isapproved',
  'is_approved',
  'is-approved',
  'approvedby',
  'approvedat',
  'actor',
  'identity',
  'agentidentity',
  'risk',
  'risklevel',
  'riskzone',
  'confirmationrequired',
  'effectivecapabilities',
  'hostallowedcapabilities',
  'actorallowedcapabilities',
  'authoritywriterhandle',
  'authoritystate',
  'authority_state',
  'authority-state',
  'proposemutation',
  'permission',
  'permissions',
  'codeowners',
  'bypass',
  'humanapproval',
  'approvaldecision',
  'reviewdecision',
  'mergeable',
]);

export type PluginProviderKind = 'workspace' | 'plugin';

export type PluginManifestSource =
  | {
      readonly providerKind: 'workspace';
      readonly workspaceRoot: string;
      readonly pluginId: string;
    }
  | {
      readonly providerKind: 'plugin';
      readonly installedRoot: string;
      readonly sourceRef: string;
      readonly expectedPluginId: string;
    };

export type PluginManifestValidator = (value: unknown) => PluginManifestValidationResult;

export interface LoadPluginManifestOptions {
  readonly validateManifest: PluginManifestValidator;
  /** A caller may lower, but never raise, the built-in byte ceiling. */
  readonly maxBytes?: number;
  /** A caller may lower, but never raise, the built-in strict-JSON ceilings. */
  readonly strictJsonLimits?: Partial<StrictJsonLimits>;
  /** @internal Deterministic race seam. Production hosts must leave this unset. */
  readonly __testHooks?: {
    readonly afterBoundedRead?: () => void | Promise<void>;
  };
}

export interface LoadedPluginManifest {
  readonly providerKind: PluginProviderKind;
  readonly pluginId: string;
  readonly sourceRef: string;
  readonly gateMode: 'SHADOW' | 'ENFORCE';
  readonly manifest: PluginManifestV1;
  readonly manifestSha256: string;
  readonly sizeBytes: number;
}

export const PLUGIN_MANIFEST_LOAD_ERROR_CODES = Object.freeze([
  'PLUGIN_MANIFEST_SOURCE_INVALID',
  'PLUGIN_MANIFEST_SOURCE_OUTSIDE_ROOT',
  'PLUGIN_MANIFEST_SOURCE_SYMLINK',
  'PLUGIN_MANIFEST_NOT_FOUND',
  'PLUGIN_MANIFEST_NOT_REGULAR_FILE',
  'PLUGIN_MANIFEST_IO_FAILED',
  'PLUGIN_MANIFEST_SIZE_EXCEEDED',
  'PLUGIN_MANIFEST_FILE_CHANGED',
  'PLUGIN_MANIFEST_JSON_INVALID',
  'PLUGIN_MANIFEST_HARD_POLICY_DENIED',
  'PLUGIN_MANIFEST_VALIDATOR_FAILED',
  'PLUGIN_MANIFEST_VALIDATION_FAILED',
  'PLUGIN_MANIFEST_ID_MISMATCH',
] as const);

export type PluginManifestLoadErrorCode = (typeof PLUGIN_MANIFEST_LOAD_ERROR_CODES)[number];

export interface PluginManifestLoadFinding {
  readonly severity: 'error';
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export class PluginManifestLoadError extends Error {
  readonly code: PluginManifestLoadErrorCode;
  readonly findings: readonly PluginManifestLoadFinding[];

  constructor(
    code: PluginManifestLoadErrorCode,
    message: string,
    findings: readonly PluginManifestLoadFinding[] = [],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PluginManifestLoadError';
    this.code = code;
    this.findings = Object.freeze(findings.map((finding) => Object.freeze({ ...finding })));
  }
}

interface ResolvedManifestSource {
  readonly providerKind: PluginProviderKind;
  readonly inspectionRoot: string;
  readonly trustRoot: string;
  readonly candidatePath: string;
  readonly sourceRef: string;
  readonly expectedPluginId: string;
}

function fail(
  code: PluginManifestLoadErrorCode,
  message: string,
  findings: readonly PluginManifestLoadFinding[] = [],
  cause?: unknown,
): never {
  throw new PluginManifestLoadError(code, message, findings, cause);
}

function isSafePluginId(value: string): boolean {
  return PLUGIN_ID_PATTERN.test(value) && !RESERVED_PLUGIN_IDS.has(value);
}

function assertAbsoluteRoot(root: unknown, field: string): asserts root is string {
  if (
    typeof root !== 'string' ||
    !path.isAbsolute(root) ||
    path.normalize(root) !== root ||
    root.includes('\0')
  ) {
    fail(
      'PLUGIN_MANIFEST_SOURCE_INVALID',
      `${field} must be a normalized absolute path without NUL bytes.`,
    );
  }
}

export function isCanonicalPluginSourceRef(sourceRef: string): boolean {
  if (
    sourceRef.length < 1 ||
    sourceRef.length > PLUGIN_SOURCE_REF_MAX_LENGTH ||
    sourceRef.includes('\\') ||
    sourceRef.includes('\0') ||
    sourceRef.includes(':') ||
    path.posix.isAbsolute(sourceRef)
  ) {
    return false;
  }
  const segments = sourceRef.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        !/^[A-Za-z0-9@._+-]+$/.test(segment),
    )
  ) {
    return false;
  }
  return segments.at(-1) === PLUGIN_MANIFEST_FILE_NAME;
}

function resolveManifestSource(source: PluginManifestSource): ResolvedManifestSource {
  if (source.providerKind === 'workspace') {
    assertAbsoluteRoot(source.workspaceRoot, 'workspaceRoot');
    if (typeof source.pluginId !== 'string' || !isSafePluginId(source.pluginId)) {
      fail('PLUGIN_MANIFEST_SOURCE_INVALID', 'Workspace plugin id is invalid or reserved.');
    }
    const trustRoot = path.join(source.workspaceRoot, '.openslack', 'plugins');
    return {
      providerKind: source.providerKind,
      inspectionRoot: source.workspaceRoot,
      trustRoot,
      candidatePath: path.join(trustRoot, source.pluginId, PLUGIN_MANIFEST_FILE_NAME),
      sourceRef: `.openslack/plugins/${source.pluginId}/${PLUGIN_MANIFEST_FILE_NAME}`,
      expectedPluginId: source.pluginId,
    };
  }

  if (source.providerKind !== 'plugin') {
    fail('PLUGIN_MANIFEST_SOURCE_INVALID', 'Plugin provider kind is unsupported.');
  }
  assertAbsoluteRoot(source.installedRoot, 'installedRoot');
  if (typeof source.expectedPluginId !== 'string' || !isSafePluginId(source.expectedPluginId)) {
    fail('PLUGIN_MANIFEST_SOURCE_INVALID', 'Installed plugin id is invalid or reserved.');
  }
  if (typeof source.sourceRef !== 'string' || !isCanonicalPluginSourceRef(source.sourceRef)) {
    fail('PLUGIN_MANIFEST_SOURCE_INVALID', 'Installed plugin sourceRef is not canonical.');
  }
  return {
    providerKind: source.providerKind,
    inspectionRoot: source.installedRoot,
    trustRoot: source.installedRoot,
    candidatePath: path.join(source.installedRoot, PLUGIN_MANIFEST_FILE_NAME),
    sourceRef: source.sourceRef,
    expectedPluginId: source.expectedPluginId,
  };
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function checkedLstat(filePath: string): Promise<BigIntStats> {
  try {
    return await lstat(filePath, { bigint: true });
  } catch (error) {
    const code = getErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      fail('PLUGIN_MANIFEST_NOT_FOUND', 'Plugin manifest path does not exist.', [], error);
    }
    if (code === 'ELOOP') {
      fail(
        'PLUGIN_MANIFEST_SOURCE_SYMLINK',
        'Plugin manifest path contains a symbolic link.',
        [],
        error,
      );
    }
    fail('PLUGIN_MANIFEST_IO_FAILED', 'Plugin manifest path could not be inspected.', [], error);
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

async function assertNoLinksInPath(root: string, candidate: string): Promise<BigIntStats> {
  if (!isContainedPath(root, candidate)) {
    fail('PLUGIN_MANIFEST_SOURCE_OUTSIDE_ROOT', 'Plugin manifest path escapes its trust root.');
  }
  const relative = path.relative(root, candidate);
  const components = [root];
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    components.push(current);
  }

  let candidateStat: BigIntStats | undefined;
  for (const component of components) {
    const stat = await checkedLstat(component);
    if (stat.isSymbolicLink()) {
      fail(
        'PLUGIN_MANIFEST_SOURCE_SYMLINK',
        'Plugin manifest path contains a symbolic link or junction.',
      );
    }
    if (component !== candidate && !stat.isDirectory()) {
      fail('PLUGIN_MANIFEST_NOT_REGULAR_FILE', 'Plugin manifest ancestor is not a directory.');
    }
    if (component === candidate) candidateStat = stat;
  }
  if (!candidateStat?.isFile()) {
    fail('PLUGIN_MANIFEST_NOT_REGULAR_FILE', 'Plugin manifest is not a regular file.');
  }
  return candidateStat;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFileObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function resolveMaxBytes(requested: number | undefined): number {
  if (requested === undefined) return PLUGIN_MANIFEST_MAX_BYTES;
  if (!Number.isSafeInteger(requested) || requested < 1) return 1;
  return Math.min(requested, PLUGIN_MANIFEST_MAX_BYTES);
}

async function readBoundedFile(
  candidatePath: string,
  initialPathStat: BigIntStats,
  maxBytes: number,
): Promise<{ readonly bytes: Buffer; readonly descriptorStat: BigIntStats }> {
  const flags =
    fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
  let handle;
  try {
    try {
      handle = await open(candidatePath, flags);
    } catch (error) {
      if (getErrorCode(error) === 'ELOOP') {
        fail(
          'PLUGIN_MANIFEST_SOURCE_SYMLINK',
          'Plugin manifest became a symbolic link.',
          [],
          error,
        );
      }
      fail('PLUGIN_MANIFEST_IO_FAILED', 'Plugin manifest could not be opened.', [], error);
    }

    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      fail('PLUGIN_MANIFEST_NOT_REGULAR_FILE', 'Opened plugin manifest is not a regular file.');
    }
    if (!sameFileObject(initialPathStat, before)) {
      fail('PLUGIN_MANIFEST_FILE_CHANGED', 'Plugin manifest changed while it was being opened.');
    }
    if (before.size > BigInt(maxBytes)) {
      fail('PLUGIN_MANIFEST_SIZE_EXCEEDED', 'Plugin manifest exceeds the byte limit.');
    }

    const allocation = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < allocation.length) {
      const { bytesRead } = await handle.read(allocation, total, allocation.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) {
      fail('PLUGIN_MANIFEST_SIZE_EXCEEDED', 'Plugin manifest exceeds the byte limit.');
    }

    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after) || after.size !== BigInt(total)) {
      fail('PLUGIN_MANIFEST_FILE_CHANGED', 'Plugin manifest changed while it was being read.');
    }
    return { bytes: allocation.subarray(0, total), descriptorStat: after };
  } catch (error) {
    if (error instanceof PluginManifestLoadError) throw error;
    fail('PLUGIN_MANIFEST_IO_FAILED', 'Plugin manifest could not be read safely.', [], error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
  fail('PLUGIN_MANIFEST_IO_FAILED', 'Plugin manifest read ended unexpectedly.');
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownDataValue(object: JsonObject, key: string): JsonValue | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function pointer(parent: string, key: string | number): string {
  return `${parent}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function findHardDeniedField(value: JsonValue, at = ''): PluginManifestLoadFinding | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const finding = findHardDeniedField(value[index]!, pointer(at, index));
      if (finding) return finding;
    }
    return undefined;
  }
  if (!isJsonObject(value)) return undefined;
  for (const key of Object.keys(value)) {
    const normalizedKey = key.toLowerCase();
    if (EXECUTABLE_FIELD_NAMES.has(normalizedKey) || SECURITY_FIELD_NAMES.has(normalizedKey)) {
      return {
        severity: 'error',
        code: EXECUTABLE_FIELD_NAMES.has(normalizedKey)
          ? 'PLUGIN_MANIFEST_EXECUTABLE_FIELD_FORBIDDEN'
          : 'PLUGIN_MANIFEST_SECURITY_FIELD_FORBIDDEN',
        path: pointer(at, key),
        message: 'Manifest contains a field forbidden by the plugin host hard policy.',
      };
    }
    const finding = findHardDeniedField(ownDataValue(value, key)!, pointer(at, key));
    if (finding) return finding;
  }
  return undefined;
}

function enforceHardManifestContract(
  value: JsonValue,
  expectedPluginId: string,
): { readonly manifest: PluginManifestV1; readonly gateMode: 'SHADOW' | 'ENFORCE' } {
  const denied = findHardDeniedField(value);
  if (denied) {
    fail('PLUGIN_MANIFEST_HARD_POLICY_DENIED', denied.message, [denied]);
  }
  if (!isJsonObject(value)) {
    fail('PLUGIN_MANIFEST_HARD_POLICY_DENIED', 'Plugin manifest root must be an object.');
  }
  if (ownDataValue(value, 'schema') !== 'openslack.plugin.v1') {
    fail('PLUGIN_MANIFEST_HARD_POLICY_DENIED', 'Plugin manifest schema is unsupported.');
  }
  const id = ownDataValue(value, 'id');
  if (id !== expectedPluginId) {
    fail('PLUGIN_MANIFEST_ID_MISMATCH', 'Plugin manifest id does not match its trusted source.');
  }
  const gate = ownDataValue(value, 'gate');
  const gateMode = isJsonObject(gate) ? ownDataValue(gate, 'mode') : undefined;
  if (gateMode !== 'SHADOW' && gateMode !== 'ENFORCE') {
    fail('PLUGIN_MANIFEST_HARD_POLICY_DENIED', 'Plugin manifest gate mode is invalid.');
  }
  return { manifest: value as unknown as PluginManifestV1, gateMode };
}

function sanitizeValidationFindings(
  findings: readonly ManifestValidationFinding[],
): readonly PluginManifestLoadFinding[] {
  const sanitized: PluginManifestLoadFinding[] = [];
  for (const finding of findings.slice(0, 100)) {
    try {
      const descriptors = Object.getOwnPropertyDescriptors(finding);
      const code = descriptors.code?.value;
      const pathValue = descriptors.path?.value;
      const message = descriptors.message?.value;
      if (
        typeof code !== 'string' ||
        typeof pathValue !== 'string' ||
        typeof message !== 'string'
      ) {
        continue;
      }
      sanitized.push({ severity: 'error', code, path: pathValue, message });
    } catch {
      // A hostile validator result is treated as invalid without inspecting accessors/proxies.
    }
  }
  return Object.freeze(sanitized);
}

function validateWithPort(value: PluginManifestV1, validator: PluginManifestValidator): void {
  let result: PluginManifestValidationResult;
  try {
    result = validator(value);
  } catch (error) {
    fail('PLUGIN_MANIFEST_VALIDATOR_FAILED', 'Plugin manifest validator threw.', [], error);
  }
  try {
    const validDescriptor = Object.getOwnPropertyDescriptor(result, 'valid');
    if (!validDescriptor || !Object.hasOwn(validDescriptor, 'value')) {
      fail(
        'PLUGIN_MANIFEST_VALIDATOR_FAILED',
        'Plugin manifest validator returned an invalid result.',
      );
    }
    if (validDescriptor.value !== true) {
      const findingsDescriptor = Object.getOwnPropertyDescriptor(result, 'findings');
      const findings = Array.isArray(findingsDescriptor?.value)
        ? sanitizeValidationFindings(findingsDescriptor.value as ManifestValidationFinding[])
        : [];
      fail('PLUGIN_MANIFEST_VALIDATION_FAILED', 'Plugin manifest validation failed.', findings);
    }
  } catch (error) {
    if (error instanceof PluginManifestLoadError) throw error;
    fail(
      'PLUGIN_MANIFEST_VALIDATOR_FAILED',
      'Plugin manifest validator result was unsafe.',
      [],
      error,
    );
  }
}

function deepFreezeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeJson(item);
  } else if (isJsonObject(value)) {
    for (const key of Object.keys(value)) deepFreezeJson(ownDataValue(value, key)!);
  }
  return Object.freeze(value);
}

export async function loadPluginManifest(
  source: PluginManifestSource,
  options: LoadPluginManifestOptions,
): Promise<LoadedPluginManifest> {
  const resolved = resolveManifestSource(source);
  const maxBytes = resolveMaxBytes(options.maxBytes);
  const initialPathStat = await assertNoLinksInPath(
    resolved.inspectionRoot,
    resolved.candidatePath,
  );

  let initialRootRealPath: string;
  let initialCandidateRealPath: string;
  try {
    [initialRootRealPath, initialCandidateRealPath] = await Promise.all([
      realpath(resolved.trustRoot),
      realpath(resolved.candidatePath),
    ]);
  } catch (error) {
    fail(
      'PLUGIN_MANIFEST_IO_FAILED',
      'Plugin manifest real path could not be resolved.',
      [],
      error,
    );
  }
  if (!isContainedPath(initialRootRealPath, initialCandidateRealPath)) {
    fail(
      'PLUGIN_MANIFEST_SOURCE_OUTSIDE_ROOT',
      'Plugin manifest real path escapes its trust root.',
    );
  }

  const { bytes, descriptorStat } = await readBoundedFile(
    resolved.candidatePath,
    initialPathStat,
    maxBytes,
  );
  await options.__testHooks?.afterBoundedRead?.();

  const finalPathStat = await assertNoLinksInPath(resolved.inspectionRoot, resolved.candidatePath);
  let finalRootRealPath: string;
  let finalCandidateRealPath: string;
  try {
    [finalRootRealPath, finalCandidateRealPath] = await Promise.all([
      realpath(resolved.trustRoot),
      realpath(resolved.candidatePath),
    ]);
  } catch (error) {
    fail(
      'PLUGIN_MANIFEST_FILE_CHANGED',
      'Plugin manifest path changed after it was read.',
      [],
      error,
    );
  }
  if (
    initialRootRealPath !== finalRootRealPath ||
    initialCandidateRealPath !== finalCandidateRealPath ||
    !sameIdentity(initialPathStat, finalPathStat) ||
    !sameIdentity(descriptorStat, finalPathStat) ||
    !isContainedPath(finalRootRealPath, finalCandidateRealPath)
  ) {
    fail('PLUGIN_MANIFEST_FILE_CHANGED', 'Plugin manifest identity changed while it was loaded.');
  }

  let parsed: JsonValue;
  try {
    parsed = parseStrictJsonBytes(bytes, options.strictJsonLimits);
  } catch (error) {
    if (error instanceof StrictJsonError) {
      fail(
        'PLUGIN_MANIFEST_JSON_INVALID',
        `Plugin manifest JSON is invalid (${error.code} at offset ${error.offset}).`,
        [
          {
            severity: 'error',
            code: error.code,
            path: '',
            message: error.message,
          },
        ],
        error,
      );
    }
    fail('PLUGIN_MANIFEST_JSON_INVALID', 'Plugin manifest JSON could not be parsed.', [], error);
  }

  const { manifest, gateMode } = enforceHardManifestContract(parsed, resolved.expectedPluginId);
  deepFreezeJson(parsed);
  validateWithPort(manifest, options.validateManifest);

  return Object.freeze({
    providerKind: resolved.providerKind,
    pluginId: resolved.expectedPluginId,
    sourceRef: resolved.sourceRef,
    gateMode,
    manifest,
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  });
}
