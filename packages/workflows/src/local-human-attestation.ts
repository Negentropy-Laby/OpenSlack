import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { types as nodeTypes } from 'node:util';
import {
  createWorkflowEffectDecisionAuthority,
  type HumanWorkflowEffectDecisionBinding,
  type WorkflowEffectApprovalDecision,
  type WorkflowEffectDecisionAuthority,
} from './workflow-effect-approval.js';

export const LOCAL_HUMAN_SUBJECTS_SCHEMA = 'openslack.mcp_human_subjects.v1' as const;
export const LOCAL_HUMAN_ATTESTATION_STATUS_SCHEMA =
  'openslack.local_human_attestation_status.v1' as const;

const MAPPING_FILE = 'human-subjects.json';
const MAX_MAPPING_BYTES = 64 * 1024;
const MAX_SUBJECTS = 64;
const BINDING_TTL_MS = 30_000;
const MIN_BINDING_TTL_MS = 1_000;
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
const SAFE_PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const CAPABILITY = /^workflow\.effect\.decide$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const WINDOWS_SID = /^S-\d(?:-\d+)+$/;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class LocalHumanAttestationError extends Error {
  readonly code:
    | 'LOCAL_HUMAN_ATTESTATION_INPUT_INVALID'
    | 'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE'
    | 'LOCAL_HUMAN_ATTESTATION_SUBJECT_UNAVAILABLE'
    | 'LOCAL_HUMAN_ATTESTATION_MAPPING_UNAVAILABLE'
    | 'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID'
    | 'LOCAL_HUMAN_ATTESTATION_MAPPING_CHANGED'
    | 'LOCAL_HUMAN_ATTESTATION_PRINCIPAL_MISMATCH'
    | 'LOCAL_HUMAN_ATTESTATION_TTY_UNAVAILABLE'
    | 'LOCAL_HUMAN_ATTESTATION_ABORTED'
    | 'LOCAL_HUMAN_ATTESTATION_EXPIRED'
    | 'LOCAL_HUMAN_ATTESTATION_CONFIRMATION_MISMATCH'
    | 'LOCAL_HUMAN_ATTESTATION_WRITE_FAILED';

  constructor(code: LocalHumanAttestationError['code'], message: string) {
    super(message);
    this.name = 'LocalHumanAttestationError';
    this.code = code;
  }
}

export interface LocalHumanAttestationStatus {
  readonly schema: typeof LOCAL_HUMAN_ATTESTATION_STATUS_SCHEMA;
  readonly state: 'ready' | 'unbound';
  readonly version: 1;
  readonly humanPrincipalId?: string;
  readonly ttyAvailable: boolean;
}

export interface BindLocalHumanSubjectOptions {
  readonly workspaceRoot: string;
  readonly humanPrincipalId: string;
  readonly confirmed: true;
}

export interface LocalHumanAttestationRequest {
  readonly runId: string;
  readonly approvalId: string;
  readonly decision: WorkflowEffectApprovalDecision;
  readonly reason: string;
  readonly reasonHash: string;
  readonly requiredCapability: string;
  readonly correlationId: string;
  readonly approvalExpiresAt: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: string;
}

export interface CreateLocalHumanAttestationProviderOptions {
  readonly workspaceRoot: string;
  readonly workspaceId: string;
  readonly humanPrincipalAssertion: string;
}

export interface LocalHumanAttestationProvider {
  readonly authority: WorkflowEffectDecisionAuthority;
  readonly humanPrincipalId: string;
  readonly approvalStoreRoot: string;
  attest(request: LocalHumanAttestationRequest): Promise<HumanWorkflowEffectDecisionBinding>;
}

interface SubjectBinding {
  readonly canonical: string;
}

interface MappingEntry {
  readonly subjectHash: string;
  readonly humanPrincipalId: string;
  readonly boundAt: string;
}

interface MappingDocument {
  readonly schema: typeof LOCAL_HUMAN_SUBJECTS_SCHEMA;
  readonly version: 1;
  readonly updatedAt: string;
  readonly subjects: readonly MappingEntry[];
}

interface MappingRead {
  readonly document: MappingDocument;
  readonly hash: string;
  readonly identity: FileIdentity;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
}

interface DirectoryBinding {
  readonly root: string;
  readonly path: string;
  readonly real: string;
  readonly stat: Stats;
}

export interface LocalHumanAttestationDependencies {
  readonly platform: NodeJS.Platform;
  readonly now: () => string;
  readonly resolveSubject: () => SubjectBinding;
  readonly assertOwnedPath: (path: string, stat: Stats, privateAccess: boolean) => void;
  readonly hardenPath: (path: string, directory: boolean) => void;
  readonly probeTty: () => void;
  readonly promptTty: (prompt: string, signal: AbortSignal, deadlineAt: string) => Promise<string>;
}

function fail(code: LocalHumanAttestationError['code'], message: string): never {
  throw new LocalHumanAttestationError(code, message);
}

function exactDataFields(value: object, fields: readonly string[]): boolean {
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Reflect.ownKeys(descriptors).length === fields.length &&
    Reflect.ownKeys(descriptors).every(
      (key) =>
        typeof key === 'string' &&
        fields.includes(key) &&
        descriptors[key]?.enumerable === true &&
        Object.hasOwn(descriptors[key]!, 'value'),
    ) &&
    fields.every((field) => Object.hasOwn(descriptors, field))
  );
}

function canonicalTimestamp(
  value: unknown,
  code: LocalHumanAttestationError['code'] = 'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID',
): string {
  if (
    typeof value !== 'string' ||
    !CANONICAL_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    return fail(code, 'Local human attestation contains an invalid timestamp.');
  }
  return value;
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

function fileIdentity(stat: Stats): FileIdentity {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    birthtimeMs: stat.birthtimeMs,
  });
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs
  );
}

function inspectRoot(workspaceRoot: string): DirectoryBinding {
  if (
    typeof workspaceRoot !== 'string' ||
    !isAbsolute(workspaceRoot) ||
    resolve(workspaceRoot) !== workspaceRoot ||
    workspaceRoot.includes('\0')
  ) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE',
      'The local human attestation workspace is unsafe.',
    );
  }
  let stat: Stats;
  let real: string;
  try {
    stat = lstatSync(workspaceRoot);
    real = realpathSync(workspaceRoot);
  } catch {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE',
      'The local human attestation workspace is unavailable.',
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(real, workspaceRoot)) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE',
      'The local human attestation workspace is unsafe.',
    );
  }
  return Object.freeze({ root: workspaceRoot, path: workspaceRoot, real, stat });
}

function inspectDirectory(
  root: DirectoryBinding,
  path: string,
  dependencies: LocalHumanAttestationDependencies,
  privateAccess: boolean,
): DirectoryBinding {
  let stat: Stats;
  let real: string;
  try {
    stat = lstatSync(path);
    real = realpathSync(path);
  } catch {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE',
      'A local human attestation directory is unavailable.',
    );
  }
  if (
    !contained(root.real, path) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    !samePath(real, path)
  ) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE',
      'A local human attestation directory is unsafe.',
    );
  }
  dependencies.assertOwnedPath(path, stat, privateAccess);
  return Object.freeze({ root: root.root, path, real, stat });
}

function ensureDirectory(
  root: DirectoryBinding,
  parent: DirectoryBinding,
  name: string,
  dependencies: LocalHumanAttestationDependencies,
  privateAccess: boolean,
): DirectoryBinding {
  const path = join(parent.real, name);
  if (!contained(root.real, path)) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE',
      'A local human attestation directory escaped the workspace.',
    );
  }
  try {
    const present = lstatSync(path);
    if (present.isSymbolicLink() || !present.isDirectory()) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE',
        'A local human attestation directory is unsafe.',
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE',
        'A local human attestation directory is unavailable.',
      );
    }
    try {
      mkdirSync(path, { mode: privateAccess ? 0o700 : 0o755 });
      if (privateAccess) dependencies.hardenPath(path, true);
    } catch {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_WRITE_FAILED',
        'A local human attestation directory could not be created safely.',
      );
    }
  }
  const current = inspectDirectory(root, path, dependencies, privateAccess);
  const parentAfter = statSync(parent.real);
  if (!sameIdentity(parent.stat, parentAfter)) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_MAPPING_CHANGED',
      'A local human attestation parent changed during preparation.',
    );
  }
  return current;
}

function localStateDirectory(
  root: DirectoryBinding,
  dependencies: LocalHumanAttestationDependencies,
  create: boolean,
): DirectoryBinding | undefined {
  const path = join(root.real, '.openslack.local');
  try {
    return inspectDirectory(root, path, dependencies, false);
  } catch (error) {
    if (
      error instanceof LocalHumanAttestationError &&
      error.code === 'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE' &&
      !lstatPresent(path)
    ) {
      if (!create) return undefined;
      return ensureDirectory(root, root, '.openslack.local', dependencies, false);
    }
    throw error;
  }
}

function lstatPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function mappingDirectory(
  root: DirectoryBinding,
  dependencies: LocalHumanAttestationDependencies,
  create: boolean,
): DirectoryBinding | undefined {
  const local = localStateDirectory(root, dependencies, create);
  if (!local) return undefined;
  const path = join(local.real, 'mcp');
  if (!lstatPresent(path)) {
    if (!create) return undefined;
    return ensureDirectory(root, local, 'mcp', dependencies, true);
  }
  return inspectDirectory(root, path, dependencies, true);
}

function approvalStoreDirectory(
  root: DirectoryBinding,
  dependencies: LocalHumanAttestationDependencies,
): string {
  const local = localStateDirectory(root, dependencies, true)!;
  const workflows = lstatPresent(join(local.real, 'workflows'))
    ? inspectDirectory(root, join(local.real, 'workflows'), dependencies, true)
    : ensureDirectory(root, local, 'workflows', dependencies, true);
  const approvals = lstatPresent(join(workflows.real, 'effect-approvals'))
    ? inspectDirectory(root, join(workflows.real, 'effect-approvals'), dependencies, true)
    : ensureDirectory(root, workflows, 'effect-approvals', dependencies, true);
  return approvals.real;
}

function subjectHash(subject: SubjectBinding): string {
  return `sha256:${createHash('sha256')
    .update('openslack.local_human_subject.v1\0', 'utf8')
    .update(subject.canonical, 'utf8')
    .digest('hex')}`;
}

function mappingBytes(document: MappingDocument): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        schema: document.schema,
        version: document.version,
        updatedAt: document.updatedAt,
        subjects: document.subjects.map((entry) => ({
          subjectHash: entry.subjectHash,
          humanPrincipalId: entry.humanPrincipalId,
          boundAt: entry.boundAt,
        })),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function mappingDocument(value: unknown, sourceBytes: Buffer): MappingDocument {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID',
      'The local human attestation mapping is invalid.',
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== 4 ||
    !['schema', 'version', 'updatedAt', 'subjects'].every((key) => Object.hasOwn(record, key)) ||
    record.schema !== LOCAL_HUMAN_SUBJECTS_SCHEMA ||
    record.version !== 1 ||
    !Array.isArray(record.subjects) ||
    record.subjects.length > MAX_SUBJECTS
  ) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID',
      'The local human attestation mapping is invalid.',
    );
  }
  const updatedAt = canonicalTimestamp(record.updatedAt);
  const seen = new Set<string>();
  const subjects = record.subjects.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      nodeTypes.isProxy(entry) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(entry) as never)
    ) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID',
        'A local human attestation subject mapping is invalid.',
      );
    }
    const candidate = entry as Record<string, unknown>;
    if (
      Reflect.ownKeys(candidate).length !== 3 ||
      !['subjectHash', 'humanPrincipalId', 'boundAt'].every((key) =>
        Object.hasOwn(candidate, key),
      ) ||
      typeof candidate.subjectHash !== 'string' ||
      !HASH.test(candidate.subjectHash) ||
      typeof candidate.humanPrincipalId !== 'string' ||
      !SAFE_PRINCIPAL.test(candidate.humanPrincipalId) ||
      seen.has(candidate.subjectHash)
    ) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID',
        'A local human attestation subject mapping is invalid.',
      );
    }
    seen.add(candidate.subjectHash);
    const boundAt = canonicalTimestamp(candidate.boundAt);
    if (Date.parse(boundAt) > Date.parse(updatedAt)) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID',
        'A local human attestation mapping has invalid audit time.',
      );
    }
    return Object.freeze({
      subjectHash: candidate.subjectHash,
      humanPrincipalId: candidate.humanPrincipalId,
      boundAt,
    });
  });
  const sorted = Object.freeze(
    [...subjects].sort((a, b) => a.subjectHash.localeCompare(b.subjectHash)),
  );
  const result: MappingDocument = Object.freeze({
    schema: LOCAL_HUMAN_SUBJECTS_SCHEMA,
    version: 1,
    updatedAt,
    subjects: sorted,
  });
  if (!sourceBytes.equals(mappingBytes(result))) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID',
      'The local human attestation mapping is not canonical.',
    );
  }
  return result;
}

function readMapping(
  directory: DirectoryBinding,
  dependencies: LocalHumanAttestationDependencies,
): MappingRead {
  const path = join(directory.real, MAPPING_FILE);
  let before: Stats;
  let real: string;
  let handle: number | undefined;
  try {
    before = lstatSync(path);
    real = realpathSync(path);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      !samePath(real, path) ||
      before.size > MAX_MAPPING_BYTES
    ) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID',
        'The local human attestation mapping file is unsafe.',
      );
    }
    dependencies.assertOwnedPath(path, before, true);
    handle = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
    const opened = fstatSync(handle);
    if (!sameIdentity(before, opened) || opened.size > MAX_MAPPING_BYTES) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_MAPPING_CHANGED',
        'The local human attestation mapping changed while opening.',
      );
    }
    const bytes = readFileSync(handle);
    const after = fstatSync(handle);
    if (!stableIdentity(opened, after) || bytes.length !== after.size) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_MAPPING_CHANGED',
        'The local human attestation mapping changed while reading.',
      );
    }
    const final = lstatSync(path);
    if (!stableIdentity(before, final) || !samePath(realpathSync(path), path)) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_MAPPING_CHANGED',
        'The local human attestation mapping changed after reading.',
      );
    }
    let decoded: string;
    try {
      decoded = decoder.decode(bytes);
    } catch {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID',
        'The local human attestation mapping is not valid UTF-8.',
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID',
        'The local human attestation mapping is not valid JSON.',
      );
    }
    const document = mappingDocument(parsed, bytes);
    return Object.freeze({
      document,
      hash: createHash('sha256').update(bytes).digest('hex'),
      identity: fileIdentity(final),
    });
  } catch (error) {
    if (error instanceof LocalHumanAttestationError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_MAPPING_UNAVAILABLE',
        'The local human attestation mapping is unavailable.',
      );
    }
    return fail(
      'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID',
      'The local human attestation mapping could not be read safely.',
    );
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const handle = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

function writeMapping(
  directory: DirectoryBinding,
  dependencies: LocalHumanAttestationDependencies,
  document: MappingDocument,
  expectedHash?: string,
): MappingRead {
  const target = join(directory.real, MAPPING_FILE);
  const temporary = join(directory.real, `.${MAPPING_FILE}.${process.pid}.${randomUUID()}.tmp`);
  const bytes = mappingBytes(document);
  let handle: number | undefined;
  try {
    if (expectedHash === undefined) {
      if (lstatPresent(target)) {
        return fail(
          'LOCAL_HUMAN_ATTESTATION_MAPPING_CHANGED',
          'The local human attestation mapping appeared during binding.',
        );
      }
    } else if (readMapping(directory, dependencies).hash !== expectedHash) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_MAPPING_CHANGED',
        'The local human attestation mapping changed before binding.',
      );
    }
    handle = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    dependencies.hardenPath(temporary, false);
    writeFileSync(handle, bytes);
    fsyncSync(handle);
    closeSync(handle);
    handle = undefined;
    const before = statSync(directory.real);
    renameSync(temporary, target);
    dependencies.hardenPath(target, false);
    syncDirectory(directory.real);
    const after = statSync(directory.real);
    if (!sameIdentity(before, after)) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_MAPPING_CHANGED',
        'The local human attestation directory changed during binding.',
      );
    }
    const root = inspectRoot(directory.root);
    const loaded = readMapping(
      inspectDirectory(root, directory.real, dependencies, true),
      dependencies,
    );
    if (!mappingBytes(loaded.document).equals(bytes)) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_WRITE_FAILED',
        'The local human attestation mapping write could not be verified.',
      );
    }
    return loaded;
  } catch (error) {
    if (error instanceof LocalHumanAttestationError) throw error;
    return fail(
      'LOCAL_HUMAN_ATTESTATION_WRITE_FAILED',
      'The local human attestation mapping could not be written safely.',
    );
  } finally {
    if (handle !== undefined) closeSync(handle);
    rmSync(temporary, { force: true });
  }
}

function currentSubject(dependencies: LocalHumanAttestationDependencies): {
  readonly hash: string;
} {
  let subject: SubjectBinding;
  try {
    subject = dependencies.resolveSubject();
  } catch {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_SUBJECT_UNAVAILABLE',
      'The current local OS subject could not be resolved.',
    );
  }
  if (
    !subject ||
    typeof subject !== 'object' ||
    typeof subject.canonical !== 'string' ||
    subject.canonical.length < 3 ||
    subject.canonical.length > 1_024 ||
    subject.canonical.includes('\0')
  ) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_SUBJECT_UNAVAILABLE',
      'The current local OS subject is invalid.',
    );
  }
  return Object.freeze({ hash: subjectHash(subject) });
}

function mappingForSubject(document: MappingDocument, hash: string): MappingEntry | undefined {
  return document.subjects.find((entry) => entry.subjectHash === hash);
}

function now(dependencies: LocalHumanAttestationDependencies): string {
  const value = dependencies.now();
  if (
    typeof value !== 'string' ||
    !CANONICAL_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_INPUT_INVALID',
      'The local human attestation clock is invalid.',
    );
  }
  return value;
}

function statusWithDependencies(
  workspaceRoot: string,
  dependencies: LocalHumanAttestationDependencies,
): LocalHumanAttestationStatus {
  const root = inspectRoot(workspaceRoot);
  const subject = currentSubject(dependencies);
  const directory = mappingDirectory(root, dependencies, false);
  let ttyAvailable = true;
  try {
    dependencies.probeTty();
  } catch {
    ttyAvailable = false;
  }
  if (!directory || !lstatPresent(join(directory.real, MAPPING_FILE))) {
    return Object.freeze({
      schema: LOCAL_HUMAN_ATTESTATION_STATUS_SCHEMA,
      state: 'unbound',
      version: 1,
      ttyAvailable,
    });
  }
  const entry = mappingForSubject(readMapping(directory, dependencies).document, subject.hash);
  if (!entry) {
    return Object.freeze({
      schema: LOCAL_HUMAN_ATTESTATION_STATUS_SCHEMA,
      state: 'unbound',
      version: 1,
      ttyAvailable,
    });
  }
  return Object.freeze({
    schema: LOCAL_HUMAN_ATTESTATION_STATUS_SCHEMA,
    state: 'ready',
    version: 1,
    humanPrincipalId: entry.humanPrincipalId,
    ttyAvailable,
  });
}

export function getLocalHumanAttestationStatus(workspaceRoot: string): LocalHumanAttestationStatus {
  return statusWithDependencies(workspaceRoot, productionDependencies());
}

export function getLocalHumanAttestationStatusForTest(
  workspaceRoot: string,
  dependencies: LocalHumanAttestationDependencies,
): LocalHumanAttestationStatus {
  return statusWithDependencies(workspaceRoot, dependencies);
}

function bindWithDependencies(
  options: BindLocalHumanSubjectOptions,
  dependencies: LocalHumanAttestationDependencies,
): LocalHumanAttestationStatus {
  if (
    !options ||
    typeof options !== 'object' ||
    nodeTypes.isProxy(options) ||
    !exactDataFields(options, ['workspaceRoot', 'humanPrincipalId', 'confirmed']) ||
    options.confirmed !== true ||
    typeof options.humanPrincipalId !== 'string' ||
    !SAFE_PRINCIPAL.test(options.humanPrincipalId)
  ) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_INPUT_INVALID',
      'Local human subject binding requires one confirmed human principal.',
    );
  }
  const root = inspectRoot(options.workspaceRoot);
  const subject = currentSubject(dependencies);
  const directory = mappingDirectory(root, dependencies, true)!;
  let current: MappingRead | undefined;
  if (lstatPresent(join(directory.real, MAPPING_FILE))) {
    current = readMapping(directory, dependencies);
  }
  const timestamp = now(dependencies);
  const subjects = [
    ...(current?.document.subjects.filter((entry) => entry.subjectHash !== subject.hash) ?? []),
    Object.freeze({
      subjectHash: subject.hash,
      humanPrincipalId: options.humanPrincipalId,
      boundAt: timestamp,
    }),
  ].sort((left, right) => left.subjectHash.localeCompare(right.subjectHash));
  const document: MappingDocument = Object.freeze({
    schema: LOCAL_HUMAN_SUBJECTS_SCHEMA,
    version: 1,
    updatedAt: timestamp,
    subjects: Object.freeze(subjects),
  });
  if (document.subjects.length > MAX_SUBJECTS) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_MAPPING_INVALID',
      'The local human attestation mapping subject limit was exceeded.',
    );
  }
  writeMapping(directory, dependencies, document, current?.hash);
  return statusWithDependencies(options.workspaceRoot, dependencies);
}

export function bindLocalHumanSubject(
  options: BindLocalHumanSubjectOptions,
): LocalHumanAttestationStatus {
  return bindWithDependencies(options, productionDependencies());
}

export function bindLocalHumanSubjectForTest(
  options: BindLocalHumanSubjectOptions,
  dependencies: LocalHumanAttestationDependencies,
): LocalHumanAttestationStatus {
  return bindWithDependencies(options, dependencies);
}

function request(value: LocalHumanAttestationRequest): LocalHumanAttestationRequest {
  if (
    !value ||
    typeof value !== 'object' ||
    nodeTypes.isProxy(value) ||
    !exactDataFields(value, [
      'runId',
      'approvalId',
      'decision',
      'reason',
      'reasonHash',
      'requiredCapability',
      'correlationId',
      'approvalExpiresAt',
      'signal',
      'deadlineAt',
    ]) ||
    typeof value.runId !== 'string' ||
    !SAFE_ID.test(value.runId) ||
    typeof value.approvalId !== 'string' ||
    !SAFE_ID.test(value.approvalId) ||
    (value.decision !== 'approved' && value.decision !== 'rejected') ||
    typeof value.reason !== 'string' ||
    value.reason.length < 1 ||
    Buffer.byteLength(value.reason, 'utf8') > 4_096 ||
    typeof value.reasonHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.reasonHash) ||
    createHash('sha256').update(value.reason, 'utf8').digest('hex') !== value.reasonHash ||
    typeof value.requiredCapability !== 'string' ||
    !CAPABILITY.test(value.requiredCapability) ||
    typeof value.correlationId !== 'string' ||
    !SAFE_ID.test(value.correlationId) ||
    !(value.signal instanceof AbortSignal)
  ) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_INPUT_INVALID',
      'The local human attestation request is invalid.',
    );
  }
  canonicalTimestamp(value.approvalExpiresAt, 'LOCAL_HUMAN_ATTESTATION_INPUT_INVALID');
  canonicalTimestamp(value.deadlineAt, 'LOCAL_HUMAN_ATTESTATION_INPUT_INVALID');
  return Object.freeze({ ...value });
}

function promptReason(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .trim();
}

function providerWithDependencies(
  options: CreateLocalHumanAttestationProviderOptions,
  dependencies: LocalHumanAttestationDependencies,
): LocalHumanAttestationProvider {
  if (
    !options ||
    typeof options !== 'object' ||
    nodeTypes.isProxy(options) ||
    !exactDataFields(options, ['workspaceRoot', 'workspaceId', 'humanPrincipalAssertion']) ||
    typeof options.workspaceId !== 'string' ||
    !SAFE_ID.test(options.workspaceId) ||
    typeof options.humanPrincipalAssertion !== 'string' ||
    !SAFE_PRINCIPAL.test(options.humanPrincipalAssertion)
  ) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_INPUT_INVALID',
      'The local human attestation provider options are invalid.',
    );
  }
  const root = inspectRoot(options.workspaceRoot);
  const directory = mappingDirectory(root, dependencies, false);
  if (!directory) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_MAPPING_UNAVAILABLE',
      'The local human attestation mapping is unavailable.',
    );
  }
  const initialSubject = currentSubject(dependencies);
  const initialMapping = readMapping(directory, dependencies);
  const initialEntry = mappingForSubject(initialMapping.document, initialSubject.hash);
  if (!initialEntry || initialEntry.humanPrincipalId !== options.humanPrincipalAssertion) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_PRINCIPAL_MISMATCH',
      'The current local OS subject does not match the asserted human principal.',
    );
  }
  try {
    dependencies.probeTty();
  } catch {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_TTY_UNAVAILABLE',
      'A controlling TTY is required for local human attestation.',
    );
  }
  const afterProbe = readMapping(directory, dependencies);
  if (
    afterProbe.hash !== initialMapping.hash ||
    !sameFileIdentity(afterProbe.identity, initialMapping.identity)
  ) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_MAPPING_CHANGED',
      'The local human attestation mapping changed during startup.',
    );
  }
  const authority = createWorkflowEffectDecisionAuthority({
    workspaceId: options.workspaceId,
    humanPrincipalIds: [initialEntry.humanPrincipalId],
    capabilities: ['workflow.effect.decide'],
    maxBindingTtlMs: 60_000,
  });
  const approvalStoreRoot = approvalStoreDirectory(root, dependencies);

  const assertCurrentBinding = (): void => {
    const current = currentSubject(dependencies);
    if (current.hash !== initialSubject.hash) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_PRINCIPAL_MISMATCH',
        'The current local OS subject changed.',
      );
    }
    const mapping = readMapping(directory, dependencies);
    const entry = mappingForSubject(mapping.document, current.hash);
    if (
      mapping.hash !== initialMapping.hash ||
      !sameFileIdentity(mapping.identity, initialMapping.identity) ||
      !entry ||
      entry.humanPrincipalId !== initialEntry.humanPrincipalId
    ) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_MAPPING_CHANGED',
        'The process-bound local human attestation mapping changed.',
      );
    }
  };

  return Object.freeze({
    authority,
    humanPrincipalId: initialEntry.humanPrincipalId,
    approvalStoreRoot,
    async attest(value: LocalHumanAttestationRequest) {
      const input = request(value);
      const before = now(dependencies);
      if (
        input.signal.aborted ||
        Date.parse(input.deadlineAt) - Date.parse(before) < MIN_BINDING_TTL_MS ||
        Date.parse(input.approvalExpiresAt) - Date.parse(before) < MIN_BINDING_TTL_MS
      ) {
        return fail(
          input.signal.aborted
            ? 'LOCAL_HUMAN_ATTESTATION_ABORTED'
            : 'LOCAL_HUMAN_ATTESTATION_EXPIRED',
          'The local human attestation request is no longer active.',
        );
      }
      assertCurrentBinding();
      const expected = input.decision === 'approved' ? 'APPROVE' : 'REJECT';
      const prompt = [
        '',
        'OpenSlack local workflow-effect decision',
        `Run: ${input.runId}`,
        `Approval: ${input.approvalId}`,
        `Workspace: ${options.workspaceId}`,
        `Human principal: ${initialEntry.humanPrincipalId}`,
        `Correlation: ${input.correlationId}`,
        `Capability: ${input.requiredCapability}`,
        `Decision: ${input.decision}`,
        `Reason: ${promptReason(input.reason)}`,
        `Reason SHA-256: ${input.reasonHash}`,
        `Approval expires: ${input.approvalExpiresAt}`,
        `Type ${expected} to attest this exact decision: `,
      ].join('\n');
      let answer: string;
      try {
        answer = await dependencies.promptTty(prompt, input.signal, input.deadlineAt);
      } catch (error) {
        if (input.signal.aborted) {
          return fail(
            'LOCAL_HUMAN_ATTESTATION_ABORTED',
            'The local human attestation request was aborted.',
          );
        }
        if (Date.now() >= Date.parse(input.deadlineAt)) {
          return fail(
            'LOCAL_HUMAN_ATTESTATION_EXPIRED',
            'The local human attestation deadline expired.',
          );
        }
        if (error instanceof LocalHumanAttestationError) throw error;
        return fail(
          'LOCAL_HUMAN_ATTESTATION_TTY_UNAVAILABLE',
          'The controlling TTY could not complete local human attestation.',
        );
      }
      if (answer !== expected) {
        return fail(
          'LOCAL_HUMAN_ATTESTATION_CONFIRMATION_MISMATCH',
          'The local human did not attest the requested decision.',
        );
      }
      const decidedAt = now(dependencies);
      if (
        input.signal.aborted ||
        Date.parse(input.deadlineAt) - Date.parse(decidedAt) < MIN_BINDING_TTL_MS ||
        Date.parse(input.approvalExpiresAt) - Date.parse(decidedAt) < MIN_BINDING_TTL_MS
      ) {
        return fail(
          input.signal.aborted
            ? 'LOCAL_HUMAN_ATTESTATION_ABORTED'
            : 'LOCAL_HUMAN_ATTESTATION_EXPIRED',
          'The local human attestation expired before binding.',
        );
      }
      assertCurrentBinding();
      const expiresAt = new Date(
        Math.min(
          Date.parse(decidedAt) + BINDING_TTL_MS,
          Date.parse(input.deadlineAt),
          Date.parse(input.approvalExpiresAt),
        ),
      ).toISOString();
      return authority.issueHumanDecisionBinding({
        principalId: initialEntry.humanPrincipalId,
        capability: input.requiredCapability,
        runId: input.runId,
        approvalId: input.approvalId,
        correlationId: input.correlationId,
        approvalExpiresAt: input.approvalExpiresAt,
        decision: input.decision,
        reasonHash: input.reasonHash,
        expiresAt,
      });
    },
  });
}

export function createLocalHumanAttestationProvider(
  options: CreateLocalHumanAttestationProviderOptions,
): LocalHumanAttestationProvider {
  return providerWithDependencies(options, productionDependencies());
}

export function createLocalHumanAttestationProviderForTest(
  options: CreateLocalHumanAttestationProviderOptions,
  dependencies: LocalHumanAttestationDependencies,
): LocalHumanAttestationProvider {
  return providerWithDependencies(options, dependencies);
}

function resolveProductionSubject(): SubjectBinding {
  if (process.platform === 'win32') {
    const output = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    }).trim();
    const match = /^"(?:""|[^"])*","(S-\d(?:-\d+)+)"$/i.exec(output);
    if (!match || !WINDOWS_SID.test(match[1]!)) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_SUBJECT_UNAVAILABLE',
        'The current Windows SID could not be resolved.',
      );
    }
    return Object.freeze({ canonical: `windows-sid:${match[1]!.toUpperCase()}` });
  }
  if (typeof process.getuid !== 'function') {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_SUBJECT_UNAVAILABLE',
      'The current POSIX uid could not be resolved.',
    );
  }
  const uid = process.getuid();
  const info = userInfo();
  if (!Number.isSafeInteger(uid) || uid < 0 || info.uid !== uid || !info.username) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_SUBJECT_UNAVAILABLE',
      'The current POSIX subject is inconsistent.',
    );
  }
  return Object.freeze({ canonical: `posix:${uid}:${info.uid}:${info.username}` });
}

function windowsCurrentSid(): string {
  const subject = resolveProductionSubject().canonical;
  const sid = subject.slice('windows-sid:'.length);
  if (!WINDOWS_SID.test(sid)) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_SUBJECT_UNAVAILABLE',
      'The current Windows SID could not be resolved.',
    );
  }
  return sid;
}

function windowsAcl(path: string): {
  readonly owner: string;
  readonly protected: boolean;
  readonly rules: readonly { readonly sid: string; readonly type: string }[];
} {
  const script = [
    '$acl = Get-Acl -LiteralPath $env:OPENSLACK_ATTESTATION_PATH',
    '$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
    '$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString() } })',
    '[pscustomobject]@{ owner = $owner; protected = $acl.AreAccessRulesProtected; rules = $rules } | ConvertTo-Json -Compress -Depth 4',
  ].join('; ');
  const output = execFileSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      env: { ...process.env, OPENSLACK_ATTESTATION_PATH: path },
    },
  );
  const parsed = JSON.parse(output) as {
    owner?: unknown;
    protected?: unknown;
    rules?: unknown;
  };
  if (
    typeof parsed.owner !== 'string' ||
    typeof parsed.protected !== 'boolean' ||
    !Array.isArray(parsed.rules)
  ) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE',
      'Windows ACL ownership could not be proven.',
    );
  }
  const rules = parsed.rules.map((rule) => {
    if (
      !rule ||
      typeof rule !== 'object' ||
      typeof (rule as { sid?: unknown }).sid !== 'string' ||
      typeof (rule as { type?: unknown }).type !== 'string'
    ) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE',
        'Windows ACL ownership could not be proven.',
      );
    }
    return Object.freeze({
      sid: (rule as { sid: string }).sid.toUpperCase(),
      type: (rule as { type: string }).type,
    });
  });
  return Object.freeze({
    owner: parsed.owner.toUpperCase(),
    protected: parsed.protected,
    rules: Object.freeze(rules),
  });
}

function hardenProductionPath(path: string, directory: boolean): void {
  if (process.platform !== 'win32') {
    chmodSync(path, directory ? 0o700 : 0o600);
    return;
  }
  const sid = windowsCurrentSid();
  const grant = directory ? `(OI)(CI)F` : 'F';
  execFileSync(
    'icacls.exe',
    [path, '/inheritance:r', '/grant:r', `*${sid}:${grant}`, `*S-1-5-18:${grant}`],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 },
  );
}

function assertProductionOwnership(path: string, stat: Stats, privateAccess: boolean): void {
  if (process.platform !== 'win32') {
    if (typeof process.getuid !== 'function' || stat.uid !== process.getuid()) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE',
        'POSIX ownership could not be proven.',
      );
    }
    if (privateAccess && (stat.mode & 0o077) !== 0) {
      return fail(
        'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE',
        'Local human attestation state is not owner-only.',
      );
    }
    return;
  }
  const sid = windowsCurrentSid().toUpperCase();
  const acl = windowsAcl(path);
  const allowed = new Set([sid, 'S-1-5-18']);
  if (
    acl.owner !== sid ||
    (privateAccess &&
      (!acl.protected ||
        acl.rules.some((rule) => rule.type === 'Allow' && !allowed.has(rule.sid)) ||
        !acl.rules.some((rule) => rule.type === 'Allow' && rule.sid === sid)))
  ) {
    return fail(
      'LOCAL_HUMAN_ATTESTATION_WORKSPACE_UNSAFE',
      'Windows SID and ACL ownership could not be proven.',
    );
  }
}

function ttyDevice(): string {
  return process.platform === 'win32' ? 'CON' : '/dev/tty';
}

function probeProductionTty(): void {
  const handle = openSync(ttyDevice(), fsConstants.O_RDWR | NO_FOLLOW);
  closeSync(handle);
}

async function promptProductionTty(
  prompt: string,
  signal: AbortSignal,
  deadlineAt: string,
): Promise<string> {
  const remaining = Date.parse(deadlineAt) - Date.now();
  if (signal.aborted || remaining <= 0) {
    return fail(
      signal.aborted ? 'LOCAL_HUMAN_ATTESTATION_ABORTED' : 'LOCAL_HUMAN_ATTESTATION_EXPIRED',
      'The local human attestation request is no longer active.',
    );
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, remaining);
  const handle = openSync(ttyDevice(), fsConstants.O_RDWR | NO_FOLLOW);
  let input: ReturnType<typeof createReadStream> | undefined;
  let output: ReturnType<typeof createWriteStream> | undefined;
  let readline: ReturnType<typeof createInterface> | undefined;
  try {
    input = createReadStream('', { fd: handle, autoClose: false });
    output = createWriteStream('', { fd: handle, autoClose: false });
    readline = createInterface({ input, output, terminal: true });
    return await readline.question(prompt, { signal: controller.signal });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return fail(
        signal.aborted ? 'LOCAL_HUMAN_ATTESTATION_ABORTED' : 'LOCAL_HUMAN_ATTESTATION_EXPIRED',
        'The local human attestation request did not complete before its deadline.',
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    readline?.close();
    input?.destroy();
    output?.destroy();
    closeSync(handle);
  }
}

function productionDependencies(): LocalHumanAttestationDependencies {
  return Object.freeze({
    platform: process.platform,
    now: () => new Date().toISOString(),
    resolveSubject: resolveProductionSubject,
    assertOwnedPath: assertProductionOwnership,
    hardenPath: hardenProductionPath,
    probeTty: probeProductionTty,
    promptTty: promptProductionTty,
  });
}
