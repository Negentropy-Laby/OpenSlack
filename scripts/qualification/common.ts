import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseStrictGraphJson } from '../../packages/organization-graph/src/index.js';

export const SHA256 = /^sha256:[0-9a-f]{64}$/;
export const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;
export const SAFE_QUALIFICATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const MAX_JSON_BYTES = 512 * 1024;
const MAX_TREE_FILES = 512;
const MAX_TREE_BYTES = 4 * 1024 * 1024;
const FORBIDDEN_SENSITIVE_KEY =
  /(?:^|_)(?:access|account|authorization|cookie|credential|oauth|password|secret|sid|token|username)(?:_|$)/i;
const FORBIDDEN_SENSITIVE_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:gh[opsu]|github_pat)_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9._~-]+)/i;

export class QualificationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'QualificationError';
    this.code = code;
  }
}

export interface CandidateRevision {
  readonly commit: string;
  readonly tree: string;
  readonly os: NodeJS.Platform;
  readonly architecture: string;
}

function fail(code: string, message: string): never {
  throw new QualificationError(code, message);
}

export function sha256Bytes(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return Object.fromEntries(
      Object.keys(record)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((key) => [key, canonicalValue(record[key])]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function hashJson(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

export function assertExactRecord(
  value: unknown,
  fields: readonly string[],
  code: string,
  label: string,
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    fail(code, `${label} must be an inert object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== fields.length ||
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        !fields.includes(key) ||
        !descriptors[key]?.enumerable ||
        !Object.hasOwn(descriptors[key]!, 'value'),
    ) ||
    fields.some((field) => !Object.hasOwn(descriptors, field))
  ) {
    fail(code, `${label} has missing or unknown fields.`);
  }
}

export function assertCanonicalTimestamp(value: unknown, code: string, label: string): string {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    return fail(code, `${label} must be a canonical timestamp.`);
  }
  return value;
}

export function assertSensitiveDataAbsent(value: unknown, code: string): void {
  const visit = (candidate: unknown): void => {
    if (typeof candidate === 'string') {
      if (FORBIDDEN_SENSITIVE_VALUE.test(candidate)) {
        fail(code, 'Qualification evidence contains credential-like material.');
      }
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!candidate || typeof candidate !== 'object') return;
    for (const [key, nested] of Object.entries(candidate)) {
      if (FORBIDDEN_SENSITIVE_KEY.test(key)) {
        fail(code, 'Qualification evidence contains a forbidden sensitive field.');
      }
      visit(nested);
    }
  };
  visit(value);
}

function command(root: string, args: readonly string[]): string {
  const executable = process.platform === 'win32' ? 'git.exe' : 'git';
  return execFileSync(executable, [...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  }).trim();
}

export function assertCleanTrackedStatus(status: string): void {
  if (typeof status !== 'string' || status.trim().length > 0) {
    fail(
      'QUALIFICATION_TRACKED_CHECKOUT_DIRTY',
      'Qualification requires a checkout with no tracked changes.',
    );
  }
}

export function candidateRevision(rootValue: string): CandidateRevision {
  const root = realpathSync(resolve(rootValue));
  assertCleanTrackedStatus(command(root, ['status', '--porcelain=v1', '--untracked-files=no']));
  const commit = command(root, ['rev-parse', 'HEAD']);
  const tree = command(root, ['rev-parse', 'HEAD^{tree}']);
  if (!GIT_OBJECT_ID.test(commit) || !GIT_OBJECT_ID.test(tree)) {
    return fail('QUALIFICATION_GIT_REVISION_INVALID', 'The candidate Git revision is invalid.');
  }
  return Object.freeze({
    commit,
    tree,
    os: process.platform,
    architecture: process.arch,
  });
}

function safeRelative(root: string, candidate: string): string {
  const value = relative(root, candidate);
  if (
    value === '' ||
    value === '..' ||
    value.startsWith(`..${sep}`) ||
    isAbsolute(value) ||
    value.split(sep).includes('..')
  ) {
    return fail('QUALIFICATION_PATH_UNSAFE', 'Qualification path escaped its trusted root.');
  }
  return value.split(sep).join('/');
}

export function hashDirectoryTree(rootValue: string): string {
  const root = realpathSync(resolve(rootValue));
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return fail('QUALIFICATION_PATH_UNSAFE', 'Qualification tree root must be a real directory.');
  }
  const records: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;
  const walk = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        fail('QUALIFICATION_PATH_UNSAFE', 'Qualification tree contains a symbolic link.');
      }
      if (entry.isDirectory() && stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !stat.isFile()) {
        fail('QUALIFICATION_PATH_UNSAFE', 'Qualification tree contains a non-regular entry.');
      }
      fileCount += 1;
      totalBytes += stat.size;
      if (fileCount > MAX_TREE_FILES || totalBytes > MAX_TREE_BYTES) {
        fail('QUALIFICATION_BOUND_EXCEEDED', 'Qualification tree exceeded its sealed bounds.');
      }
      const bytes = readFileSync(path);
      if (bytes.length !== stat.size) {
        fail('QUALIFICATION_PATH_CHANGED', 'Qualification tree changed during hashing.');
      }
      records.push(`${safeRelative(root, path)}\0${bytes.length}\0${sha256Bytes(bytes)}\n`);
    }
  };
  walk(root);
  return sha256Bytes(records.join(''));
}

function assertRealDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== resolve(path)) {
    fail('QUALIFICATION_PATH_UNSAFE', 'Qualification output directory is unsafe.');
  }
}

export function ensureQualificationDirectory(
  rootValue: string,
  childSegments: readonly string[],
): string {
  const root = realpathSync(resolve(rootValue));
  let current = root;
  for (const segment of childSegments) {
    if (segment !== '.openslack.local' && !SAFE_QUALIFICATION_ID.test(segment)) {
      fail('QUALIFICATION_PATH_UNSAFE', 'Qualification output segment is invalid.');
    }
    current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    assertRealDirectory(current);
  }
  return current;
}

export function atomicWriteJson(pathValue: string, value: unknown): void {
  const path = resolve(pathValue);
  const directory = dirname(path);
  assertRealDirectory(directory);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  let handle = -1;
  try {
    handle = openSync(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    writeFileSync(handle, bytes);
    fsyncSync(handle);
    closeSync(handle);
    handle = -1;
    renameSync(temporary, path);
  } finally {
    if (handle >= 0) closeSync(handle);
    rmSync(temporary, { force: true });
  }
}

export function readStrictJson(pathValue: string): unknown {
  const path = resolve(pathValue);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) {
    return fail('QUALIFICATION_RECEIPT_UNSAFE', 'Qualification JSON path is unsafe.');
  }
  const bytes = readFileSync(path);
  if (bytes.length !== stat.size) {
    return fail('QUALIFICATION_PATH_CHANGED', 'Qualification JSON changed during reading.');
  }
  return parseStrictGraphJson(bytes, {
    maxDepth: 16,
    maxNodes: 4_096,
    maxStringLength: 16 * 1024,
  });
}
