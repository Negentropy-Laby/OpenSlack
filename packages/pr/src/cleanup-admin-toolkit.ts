/** An independent offline toolkit. Handoff profiles and execution authority are unchanged. */
import { decodeStrictJSON, stableFileIdentity } from '@openslack/core';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  assertCleanupDescriptorSupport,
  CleanupDirectoryAnchor,
  CleanupFileBoundaryError,
  readCleanupDescriptor,
} from './internal/cleanup-file-boundary.js';
import {
  CLEANUP_HEAD,
  CLEANUP_SHA256,
  cleanupExactKeys,
  cleanupObject,
  isSensitiveCleanupInput,
} from './internal/cleanup-validation.js';

export const CLEANUP_ADMIN_TOOLKIT_FILES = Object.freeze([
  'target-observation.py',
  'dependency-inventory.py',
  'offline-backup.py',
  'isolation.py',
  'inspect-instance.py',
  '_safety.py',
  'qualification-fixtures.mjs',
  'prepare-evidence.mjs',
  'verify-toolkit.mjs',
  'verify-workspace.mjs',
  'README.md',
]);
export const CLEANUP_ADMIN_TOOLKIT_SCHEMAS = Object.freeze({
  manifest: 'openslack.cleanup_admin_toolkit.v1',
  build: 'openslack.cleanup_admin_toolkit_build_report.v1',
});
export type CleanupAdminToolkitErrorCode =
  | 'ADMIN_TOOLKIT_INPUT_INVALID'
  | 'ADMIN_TOOLKIT_PLATFORM_UNSUPPORTED'
  | 'ADMIN_TOOLKIT_PATH_UNSAFE'
  | 'ADMIN_TOOLKIT_FILE_UNSAFE'
  | 'ADMIN_TOOLKIT_FILE_CHANGED'
  | 'ADMIN_TOOLKIT_UTF8_INVALID'
  | 'ADMIN_TOOLKIT_SOURCE_DIRTY'
  | 'ADMIN_TOOLKIT_CANDIDATE_MISMATCH'
  | 'ADMIN_TOOLKIT_BUILD_INVALID'
  | 'ADMIN_TOOLKIT_BUILD_MISMATCH'
  | 'ADMIN_TOOLKIT_EMPTY_TOOL'
  | 'ADMIN_TOOLKIT_MANIFEST_INVALID'
  | 'ADMIN_TOOLKIT_DIGEST_MISMATCH'
  | 'ADMIN_TOOLKIT_FILE_SET_INVALID'
  | 'ADMIN_TOOLKIT_OUTPUT_EXISTS'
  | 'ADMIN_TOOLKIT_IO_FAILED';
export class CleanupAdminToolkitError extends Error {
  constructor(public readonly code: CleanupAdminToolkitErrorCode) {
    super(
      `${code}: stop; preserve existing files. Integrity is not installation or execution authority.`,
    );
    this.name = 'CleanupAdminToolkitError';
  }
}
export interface CleanupAdminToolkitFileRecord {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface CleanupAdminToolkitBuildReport {
  readonly schema: typeof CLEANUP_ADMIN_TOOLKIT_SCHEMAS.build;
  readonly candidateHead: string;
  readonly checkout: string;
  readonly checkoutCleanAfterBuild: true;
  readonly independentCloneNoHardlinks: true;
  readonly tools: {
    readonly bun: string;
    readonly node: string;
    readonly go: string;
    readonly git: string;
  };
  readonly lockfileSHA256: string;
  readonly commands: readonly string[];
  readonly artifacts: readonly CleanupAdminToolkitFileRecord[];
}
export interface CleanupAdminToolkitManifest {
  readonly schema: typeof CLEANUP_ADMIN_TOOLKIT_SCHEMAS.manifest;
  readonly candidateHead: string;
  readonly files: readonly CleanupAdminToolkitFileRecord[];
}
export interface CleanupAdminToolkitBuildInput {
  readonly reportPath: string;
  readonly toolDirectory: string;
}
export interface PrepareCleanupAdminToolkitInput {
  readonly sourceRoot: string;
  readonly candidateHead: string;
  readonly outputDirectory: string;
  readonly builds: readonly [CleanupAdminToolkitBuildInput, CleanupAdminToolkitBuildInput];
}
export interface PrepareCleanupAdminToolkitResult {
  readonly candidateHead: string;
  readonly packageDirectory: string;
  /** SHA256SUMS digest obtained outside the package, not manifest.json's self-assertion. */
  readonly manifestSHA256: string;
  readonly fileCount: number;
  readonly installationAuthorized: false;
  readonly executionAuthorized: false;
}
export interface VerifyCleanupAdminToolkitInput {
  readonly packageDirectory: string;
  readonly candidateHead: string;
  /** Independently reviewed SHA256SUMS digest. */
  readonly manifestSHA256: string;
}
export interface VerifyCleanupAdminToolkitResult {
  readonly valid: boolean;
  readonly candidateHead: string;
  readonly manifestSHA256: string;
  readonly fileCount: number;
  readonly errors: readonly CleanupAdminToolkitErrorCode[];
  readonly installationAuthorized: false;
  readonly executionAuthorized: false;
}

const REPORTS = ['evidence/build-a.json', 'evidence/build-b.json'] as const;
const CONTENT = [...CLEANUP_ADMIN_TOOLKIT_FILES, ...REPORTS].sort();
const CHECKSUM_FILES = [...CONTENT, 'manifest.json'].sort();
const ALL_FILES = [...CHECKSUM_FILES, 'SHA256SUMS'].sort();
const TOOL_BOUND = 16 * 1024 * 1024,
  JSON_BOUND = 256 * 1024;
const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const digest = (raw: Buffer): string => createHash('sha256').update(raw).digest('hex');
const fail = (code: CleanupAdminToolkitErrorCode): never => {
  throw new CleanupAdminToolkitError(code);
};
function insist(value: unknown, code: CleanupAdminToolkitErrorCode): asserts value {
  if (!value) fail(code);
}
function exact(
  value: unknown,
  fields: readonly string[],
  code: CleanupAdminToolkitErrorCode,
): Record<string, unknown> {
  insist(cleanupObject(value) && cleanupExactKeys(value, fields), code);
  return value;
}
function utf8(raw: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    return fail('ADMIN_TOOLKIT_UTF8_INVALID');
  }
}
function json(raw: Buffer, code: CleanupAdminToolkitErrorCode): unknown {
  insist(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= JSON_BOUND, code);
  utf8(raw);
  try {
    return decodeStrictJSON(raw, JSON_BOUND);
  } catch {
    return fail(code);
  }
}
function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isAbsolute(value) &&
    !/[\\\u0000-\u001f\u007f]/.test(value) &&
    !value.split('/').includes('..') &&
    !/^\/proc\/(?:self|\d+)\/fd(?:\/|$)/.test(value) &&
    !isSensitiveCleanupInput(value)
  );
}
function records(
  value: unknown,
  names: readonly string[],
  code: CleanupAdminToolkitErrorCode,
): readonly CleanupAdminToolkitFileRecord[] {
  insist(Array.isArray(value) && value.length === names.length, code);
  const seen = new Set<string>();
  return Object.freeze(
    value.map((entry) => {
      const file = exact(entry, ['path', 'sha256', 'bytes'], code);
      insist(
        typeof file.path === 'string' &&
          names.includes(file.path) &&
          !seen.has(file.path) &&
          typeof file.sha256 === 'string' &&
          CLEANUP_SHA256.test(file.sha256) &&
          typeof file.bytes === 'number' &&
          Number.isSafeInteger(file.bytes) &&
          file.bytes > 0 &&
          file.bytes <= TOOL_BOUND,
        code,
      );
      seen.add(file.path);
      return Object.freeze({ path: file.path, sha256: file.sha256, bytes: file.bytes });
    }),
  );
}
/** Pure validation; these parsers do not inspect a host or confer authorization. */
export function parseCleanupAdminToolkitBuildReport(
  raw: Buffer,
  candidateHead: string,
): CleanupAdminToolkitBuildReport {
  const code = 'ADMIN_TOOLKIT_BUILD_INVALID';
  const report = exact(
    json(raw, code),
    [
      'schema',
      'candidateHead',
      'checkout',
      'checkoutCleanAfterBuild',
      'independentCloneNoHardlinks',
      'tools',
      'lockfileSHA256',
      'commands',
      'artifacts',
    ],
    code,
  );
  const tools = exact(report.tools, ['bun', 'node', 'go', 'git'], code);
  insist(
    CLEANUP_HEAD.test(candidateHead) &&
      report.schema === CLEANUP_ADMIN_TOOLKIT_SCHEMAS.build &&
      report.candidateHead === candidateHead &&
      validPath(report.checkout) &&
      report.checkoutCleanAfterBuild === true &&
      report.independentCloneNoHardlinks === true &&
      typeof report.lockfileSHA256 === 'string' &&
      CLEANUP_SHA256.test(report.lockfileSHA256) &&
      typeof tools.bun === 'string' &&
      /^\d+\.\d+\.\d+$/.test(tools.bun) &&
      tools.node === 'v24.18.1' &&
      typeof tools.go === 'string' &&
      /^go version go1\.\d+\.\d+ linux\/amd64$/.test(tools.go) &&
      typeof tools.git === 'string' &&
      /^git version \d+\.\d+\.\d+(?:[. -][A-Za-z0-9_.-]+)?$/.test(tools.git) &&
      Array.isArray(report.commands) &&
      report.commands.length > 0 &&
      report.commands.length <= 64 &&
      report.commands.every(
        (command) =>
          typeof command === 'string' &&
          command.length > 0 &&
          command.length <= 4096 &&
          !/[\u0000-\u001f\u007f]/.test(command),
      ),
    code,
  );
  return Object.freeze({
    schema: CLEANUP_ADMIN_TOOLKIT_SCHEMAS.build,
    candidateHead,
    checkout: report.checkout,
    checkoutCleanAfterBuild: true,
    independentCloneNoHardlinks: true,
    tools: Object.freeze({ bun: tools.bun, node: tools.node, go: tools.go, git: tools.git }),
    lockfileSHA256: report.lockfileSHA256,
    commands: Object.freeze([...report.commands] as string[]),
    artifacts: records(report.artifacts, CLEANUP_ADMIN_TOOLKIT_FILES, code),
  });
}
export function parseCleanupAdminToolkitManifest(
  raw: Buffer,
  candidateHead: string,
): CleanupAdminToolkitManifest {
  const code = 'ADMIN_TOOLKIT_MANIFEST_INVALID';
  const manifest = exact(json(raw, code), ['schema', 'candidateHead', 'files'], code);
  insist(
    CLEANUP_HEAD.test(candidateHead) &&
      manifest.schema === CLEANUP_ADMIN_TOOLKIT_SCHEMAS.manifest &&
      manifest.candidateHead === candidateHead,
    code,
  );
  return Object.freeze({
    schema: CLEANUP_ADMIN_TOOLKIT_SCHEMAS.manifest,
    candidateHead,
    files: records(manifest.files, CONTENT, code),
  });
}
function safePath(value: unknown): string {
  insist(validPath(value), 'ADMIN_TOOLKIT_PATH_UNSAFE');
  return resolve(value);
}
function platform(): void {
  try {
    assertCleanupDescriptorSupport();
  } catch {
    fail('ADMIN_TOOLKIT_PLATFORM_UNSUPPORTED');
  }
}
function classify(error: unknown): CleanupAdminToolkitError {
  if (error instanceof CleanupAdminToolkitError) return error;
  if (error instanceof CleanupFileBoundaryError)
    return new CleanupAdminToolkitError(
      error.code === 'FILE_CHANGED' ? 'ADMIN_TOOLKIT_FILE_CHANGED' : 'ADMIN_TOOLKIT_FILE_UNSAFE',
    );
  return new CleanupAdminToolkitError('ADMIN_TOOLKIT_IO_FAILED');
}
class Capture {
  readonly anchor: CleanupDirectoryAnchor;
  readonly fd: number;
  readonly identity: string;
  readonly data: Buffer;
  readonly sha256: string;
  constructor(
    readonly path: string,
    bound: number,
  ) {
    this.anchor = CleanupDirectoryAnchor.open(dirname(path));
    let fd: number | undefined;
    try {
      this.anchor.verify();
      const leaf = this.anchor.path(basename(path)),
        before = lstatSync(leaf);
      insist(
        before.isFile() && !before.isSymbolicLink() && before.nlink === 1,
        'ADMIN_TOOLKIT_FILE_UNSAFE',
      );
      fd = openSync(leaf, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      this.fd = fd;
      this.identity = stableFileIdentity(fstatSync(fd));
      insist(this.identity === stableFileIdentity(before), 'ADMIN_TOOLKIT_FILE_CHANGED');
      this.data = readCleanupDescriptor(fd, bound, 'artifact');
      this.sha256 = digest(this.data);
      this.verify();
    } catch (error) {
      try {
        if (fd !== undefined) closeSync(fd);
      } catch {
        /* Preserve the read failure. */
      }
      try {
        this.anchor.close();
      } catch {
        /* Preserve the read failure. */
      }
      throw error;
    }
  }
  verify(): void {
    this.anchor.verify();
    insist(
      stableFileIdentity(fstatSync(this.fd)) === this.identity &&
        stableFileIdentity(lstatSync(this.anchor.path(basename(this.path)))) === this.identity,
      'ADMIN_TOOLKIT_FILE_CHANGED',
    );
  }
  close(): void {
    try {
      closeSync(this.fd);
    } finally {
      this.anchor.close();
    }
  }
}
function closeCaptured(files: readonly Capture[]): CleanupAdminToolkitError | undefined {
  let error: CleanupAdminToolkitError | undefined;
  for (const file of [...files].reverse()) {
    try {
      file.close();
    } catch (cause) {
      error ??= classify(cause);
    }
  }
  return error;
}
function checkPair(reports: readonly CleanupAdminToolkitBuildReport[]): void {
  insist(
    reports.length === 2 &&
      reports[0]!.checkout !== reports[1]!.checkout &&
      reports[0]!.lockfileSHA256 === reports[1]!.lockfileSHA256 &&
      Object.keys(reports[0]!.tools).every(
        (name) =>
          reports[0]!.tools[name as keyof CleanupAdminToolkitBuildReport['tools']] ===
          reports[1]!.tools[name as keyof CleanupAdminToolkitBuildReport['tools']],
      ),
    'ADMIN_TOOLKIT_BUILD_INVALID',
  );
}
function directoryEntries(path: string): string[] {
  const anchor = CleanupDirectoryAnchor.open(path);
  try {
    const entries = readdirSync(dirname(anchor.path('sentinel')));
    anchor.verify();
    return entries;
  } finally {
    anchor.close();
  }
}
function toolSet(path: string): void {
  insist(
    directoryEntries(path).sort().join('\n') === [...CLEANUP_ADMIN_TOOLKIT_FILES].sort().join('\n'),
    'ADMIN_TOOLKIT_FILE_SET_INVALID',
  );
}
function packageSet(path: string): void {
  const found: string[] = [];
  for (const name of directoryEntries(path)) {
    if (name === 'evidence') {
      for (const item of directoryEntries(join(path, name))) found.push(`evidence/${item}`);
    } else found.push(name);
  }
  insist(found.sort().join('\n') === ALL_FILES.join('\n'), 'ADMIN_TOOLKIT_FILE_SET_INVALID');
}
function git(root: string, args: string[]): string {
  try {
    return execFileSync(
      'git',
      [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        '-C',
        root,
        ...args,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          LANG: 'C',
          LC_ALL: 'C',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
        },
      },
    ).trim();
  } catch {
    return fail('ADMIN_TOOLKIT_BUILD_INVALID');
  }
}
function clean(root: string, head: string): void {
  insist(git(root, ['rev-parse', 'HEAD']) === head, 'ADMIN_TOOLKIT_CANDIDATE_MISMATCH');
  insist(
    git(root, ['status', '--porcelain', '--untracked-files=normal']) === '',
    'ADMIN_TOOLKIT_SOURCE_DIRTY',
  );
}
function objectStore(root: string): Set<string> {
  const gitPath = safePath(join(root, '.git'));
  insist(git(root, ['rev-parse', '--absolute-git-dir']) === gitPath, 'ADMIN_TOOLKIT_BUILD_INVALID');
  const identities = new Set<string>();
  const walk = (directory: string): void => {
    const anchor = CleanupDirectoryAnchor.open(directory);
    try {
      for (const name of readdirSync(dirname(anchor.path('sentinel')))) {
        const path = join(directory, name),
          info = lstatSync(anchor.path(name));
        insist(!info.isSymbolicLink() && name !== 'alternates', 'ADMIN_TOOLKIT_BUILD_INVALID');
        if (info.isDirectory()) walk(path);
        else {
          insist(info.isFile() && info.nlink === 1, 'ADMIN_TOOLKIT_BUILD_INVALID');
          identities.add(`${info.dev}:${info.ino}`);
        }
      }
      anchor.verify();
    } finally {
      anchor.close();
    }
  };
  walk(join(gitPath, 'objects'));
  return identities;
}
function match(record: CleanupAdminToolkitFileRecord, data: Buffer, hash: string): void {
  insist(data.length > 0, 'ADMIN_TOOLKIT_EMPTY_TOOL');
  insist(record.bytes === data.length && record.sha256 === hash, 'ADMIN_TOOLKIT_DIGEST_MISMATCH');
}
function checksumRecords(raw: Buffer): Map<string, string> {
  const text = utf8(raw);
  insist(raw.length > 0 && text.endsWith('\n'), 'ADMIN_TOOLKIT_MANIFEST_INVALID');
  const result = new Map<string, string>();
  for (const line of text.slice(0, -1).split('\n')) {
    const fields = /^([a-f0-9]{64})  \.\/(.+)$/.exec(line);
    insist(
      fields && CHECKSUM_FILES.includes(fields[2]!) && !result.has(fields[2]!),
      'ADMIN_TOOLKIT_MANIFEST_INVALID',
    );
    result.set(fields[2]!, fields[1]!);
  }
  insist(result.size === CHECKSUM_FILES.length, 'ADMIN_TOOLKIT_FILE_SET_INVALID');
  return result;
}

export function readCleanupAdminToolkitPreparationInput(
  path: string,
): PrepareCleanupAdminToolkitInput {
  platform();
  const file = new Capture(safePath(path), JSON_BOUND);
  try {
    return json(file.data, 'ADMIN_TOOLKIT_INPUT_INVALID') as PrepareCleanupAdminToolkitInput;
  } finally {
    file.close();
  }
}

export function prepareCleanupAdminToolkit(
  input: PrepareCleanupAdminToolkitInput,
): PrepareCleanupAdminToolkitResult {
  const captured: Capture[] = [];
  const capture = (path: string, bound = TOOL_BOUND): Capture => {
    const file = new Capture(safePath(path), bound);
    captured.push(file);
    return file;
  };
  let result: PrepareCleanupAdminToolkitResult | undefined,
    failure: CleanupAdminToolkitError | undefined;
  try {
    exact(
      input,
      ['sourceRoot', 'candidateHead', 'outputDirectory', 'builds'],
      'ADMIN_TOOLKIT_INPUT_INVALID',
    );
    insist(
      typeof input.candidateHead === 'string' &&
        CLEANUP_HEAD.test(input.candidateHead) &&
        Array.isArray(input.builds) &&
        input.builds.length === 2,
      'ADMIN_TOOLKIT_INPUT_INVALID',
    );
    platform();
    const root = safePath(input.sourceRoot),
      output = safePath(input.outputDirectory);
    const outside = relative(root, output);
    insist(
      outside.startsWith('../') &&
        ![
          '/etc/openslack-cleanup',
          '/usr/lib/openslack-cleanup',
          '/run/openslack-cleanup',
          '/var/lib/openslack-cleanup',
        ].some((active) => output === active || output.startsWith(active + '/')),
      'ADMIN_TOOLKIT_PATH_UNSAFE',
    );
    clean(root, input.candidateHead);
    const pins = json(
      capture(join(root, 'package.json'), JSON_BOUND).data,
      'ADMIN_TOOLKIT_BUILD_INVALID',
    );
    insist(
      cleanupObject(pins) && cleanupObject(pins.devDependencies),
      'ADMIN_TOOLKIT_BUILD_INVALID',
    );
    const bun = pins.devDependencies['bun-types'],
      goRaw = utf8(capture(join(root, 'services/cleanup-broker/go.mod'), JSON_BOUND).data);
    const go = /^go (1\.\d+\.\d+)$/m.exec(goRaw)?.[1],
      lock = capture(join(root, 'bun.lock')).sha256;
    insist(
      typeof bun === 'string' && /^\d+\.\d+\.\d+$/.test(bun) && go,
      'ADMIN_TOOLKIT_BUILD_INVALID',
    );
    const files = new Map<string, Buffer>(),
      reports: CleanupAdminToolkitBuildReport[] = [],
      toolBytes: Buffer[][] = [];
    const checkouts = [root],
      toolDirectories: string[] = [];
    for (const [index, build] of input.builds.entries()) {
      exact(build, ['reportPath', 'toolDirectory'], 'ADMIN_TOOLKIT_INPUT_INVALID');
      const reportPath = safePath(build.reportPath),
        tools = safePath(build.toolDirectory);
      insist(
        basename(reportPath) === 'admin-toolkit-build-report.json' &&
          tools === join(dirname(reportPath), 'admin-toolkit'),
        'ADMIN_TOOLKIT_BUILD_INVALID',
      );
      const reportCapture = capture(build.reportPath, JSON_BOUND);
      const report = parseCleanupAdminToolkitBuildReport(reportCapture.data, input.candidateHead);
      const checkout = safePath(report.checkout);
      insist(
        !checkouts.includes(checkout) && !toolDirectories.includes(tools),
        'ADMIN_TOOLKIT_BUILD_INVALID',
      );
      checkouts.push(checkout);
      toolDirectories.push(tools);
      clean(checkout, input.candidateHead);
      insist(
        capture(join(checkout, 'bun.lock')).sha256 === lock &&
          report.lockfileSHA256 === lock &&
          report.tools.bun === bun &&
          report.tools.go === `go version go${go} linux/amd64`,
        'ADMIN_TOOLKIT_BUILD_INVALID',
      );
      toolSet(tools);
      const values = CLEANUP_ADMIN_TOOLKIT_FILES.map((name) => {
        const file = capture(join(tools, name));
        utf8(file.data);
        match(report.artifacts.find((entry) => entry.path === name)!, file.data, file.sha256);
        if (index === 0) files.set(name, file.data);
        return file.data;
      });
      toolBytes.push(values);
      reports.push(report);
      files.set(REPORTS[index]!, reportCapture.data);
    }
    checkPair(reports);
    insist(
      toolBytes[0]!.every((data, index) => data.equals(toolBytes[1]![index]!)),
      'ADMIN_TOOLKIT_BUILD_MISMATCH',
    );
    insist(
      checkouts.every((checkout) => relative(checkout, output).startsWith('../')) &&
        toolDirectories.every((tools) => relative(tools, output).startsWith('../')),
      'ADMIN_TOOLKIT_PATH_UNSAFE',
    );
    const manifest = {
      schema: CLEANUP_ADMIN_TOOLKIT_SCHEMAS.manifest,
      candidateHead: input.candidateHead,
      files: [...files]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, raw]) => ({ path, sha256: digest(raw), bytes: raw.length })),
    };
    const manifestBytes = bytes(manifest);
    parseCleanupAdminToolkitManifest(manifestBytes, input.candidateHead);
    files.set('manifest.json', manifestBytes);
    const sums = Buffer.from(
      CHECKSUM_FILES.map((name) => `${digest(files.get(name)!)}  ./${name}\n`).join(''),
    );
    files.set('SHA256SUMS', sums);
    const recheck = (): void => {
      captured.forEach((file) => file.verify());
      checkouts.forEach((checkout) => clean(checkout, input.candidateHead));
      input.builds.forEach((build) => toolSet(build.toolDirectory));
    };
    const recheckObjects = (): void => {
      const stores = checkouts.map(objectStore);
      for (let i = 0; i < stores.length; i++)
        for (let j = i + 1; j < stores.length; j++)
          insist(
            ![...stores[i]!].some((identity) => stores[j]!.has(identity)),
            'ADMIN_TOOLKIT_BUILD_INVALID',
          );
    };
    recheckObjects();
    recheck();
    const parent = CleanupDirectoryAnchor.open(dirname(output));
    let destination: CleanupDirectoryAnchor | undefined;
    try {
      const outputPath = parent.path(basename(output));
      try {
        lstatSync(outputPath);
        fail('ADMIN_TOOLKIT_OUTPUT_EXISTS');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      parent.verify();
      mkdirSync(outputPath, { mode: 0o700 });
      parent.sync();
      const created = lstatSync(outputPath);
      destination = CleanupDirectoryAnchor.open(output);
      const directoryIdentity = `${created.dev}:${created.ino}`;
      const verifyDestination = (): void => {
        parent.verify();
        destination!.verify();
        const item = lstatSync(outputPath),
          opened = statSync(dirname(destination!.path('sentinel')));
        insist(
          item.isDirectory() &&
            item.uid === process.getuid!() &&
            (item.mode & 0o077) === 0 &&
            `${item.dev}:${item.ino}` === directoryIdentity &&
            `${opened.dev}:${opened.ino}` === directoryIdentity,
          'ADMIN_TOOLKIT_FILE_CHANGED',
        );
      };
      verifyDestination();
      const evidencePath = destination.path('evidence');
      mkdirSync(evidencePath, { mode: 0o700 });
      destination.sync();
      const evidence = CleanupDirectoryAnchor.open(join(output, 'evidence'));
      try {
        for (const [path, data] of files) {
          verifyDestination();
          recheck();
          const anchor = path.startsWith('evidence/') ? evidence : destination;
          anchor.verify();
          const internal = anchor.path(basename(path));
          const fd = openSync(
            internal,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o644,
          );
          try {
            let written = 0;
            while (written < data.length) {
              const count = writeSync(fd, data, written, data.length - written);
              insist(count > 0, 'ADMIN_TOOLKIT_IO_FAILED');
              written += count;
            }
            fsyncSync(fd);
            const opened = fstatSync(fd),
              entry = lstatSync(internal);
            insist(
              opened.isFile() &&
                opened.nlink === 1 &&
                stableFileIdentity(opened) === stableFileIdentity(entry),
              'ADMIN_TOOLKIT_FILE_CHANGED',
            );
            anchor.sync();
          } finally {
            closeSync(fd);
          }
        }
      } finally {
        evidence.close();
      }
      recheck();
      recheckObjects();
      verifyDestination();
      destination.sync();
      parent.sync();
      // Inspect the bytes actually published, not merely the input buffers or
      // write() return counts. This is a separate post-publication race check.
      const published = verifyCleanupAdminToolkit({
        packageDirectory: output,
        candidateHead: input.candidateHead,
        manifestSHA256: digest(sums),
      });
      insist(published.valid, published.errors[0] ?? 'ADMIN_TOOLKIT_MANIFEST_INVALID');
      recheck();
      verifyDestination();
    } finally {
      if (destination) destination.close();
      parent.close();
    }
    result = Object.freeze({
      candidateHead: input.candidateHead,
      packageDirectory: output,
      manifestSHA256: digest(sums),
      fileCount: ALL_FILES.length,
      installationAuthorized: false,
      executionAuthorized: false,
    });
  } catch (error) {
    failure = classify(error);
  }
  const closeFailure = closeCaptured(captured);
  if (failure || closeFailure) throw failure ?? closeFailure;
  return result!;
}

export function verifyCleanupAdminToolkit(
  input: VerifyCleanupAdminToolkitInput,
): VerifyCleanupAdminToolkitResult {
  const captured: Capture[] = [];
  let fileCount = 0,
    failure: CleanupAdminToolkitError | undefined;
  try {
    exact(
      input,
      ['packageDirectory', 'candidateHead', 'manifestSHA256'],
      'ADMIN_TOOLKIT_INPUT_INVALID',
    );
    insist(
      typeof input.candidateHead === 'string' &&
        CLEANUP_HEAD.test(input.candidateHead) &&
        typeof input.manifestSHA256 === 'string' &&
        CLEANUP_SHA256.test(input.manifestSHA256),
      'ADMIN_TOOLKIT_INPUT_INVALID',
    );
    platform();
    const root = safePath(input.packageDirectory);
    packageSet(root);
    const capture = (name: string, bound = TOOL_BOUND): Capture => {
      const file = new Capture(join(root, name), bound);
      captured.push(file);
      return file;
    };
    const sums = capture('SHA256SUMS', JSON_BOUND);
    insist(sums.sha256 === input.manifestSHA256, 'ADMIN_TOOLKIT_DIGEST_MISMATCH');
    const checksums = checksumRecords(sums.data),
      contents = new Map<string, Capture>();
    for (const name of CHECKSUM_FILES) {
      const file = capture(name, name.endsWith('.json') ? JSON_BOUND : TOOL_BOUND);
      utf8(file.data);
      insist(file.sha256 === checksums.get(name), 'ADMIN_TOOLKIT_DIGEST_MISMATCH');
      contents.set(name, file);
    }
    const manifest = parseCleanupAdminToolkitManifest(
      contents.get('manifest.json')!.data,
      input.candidateHead,
    );
    for (const entry of manifest.files) {
      const file = contents.get(entry.path)!;
      match(entry, file.data, file.sha256);
    }
    const reports: CleanupAdminToolkitBuildReport[] = [];
    for (const name of REPORTS) {
      const report = parseCleanupAdminToolkitBuildReport(
        contents.get(name)!.data,
        input.candidateHead,
      );
      reports.push(report);
      for (const entry of report.artifacts) {
        const file = contents.get(entry.path)!;
        match(entry, file.data, file.sha256);
      }
    }
    checkPair(reports);
    captured.forEach((file) => file.verify());
    packageSet(root);
    fileCount = ALL_FILES.length;
  } catch (error) {
    failure = classify(error);
  }
  const closeFailure = closeCaptured(captured);
  const errors = failure ? [failure.code] : [];
  if (closeFailure && !errors.includes(closeFailure.code)) errors.push(closeFailure.code);
  return Object.freeze({
    valid: errors.length === 0,
    candidateHead: typeof input?.candidateHead === 'string' ? input.candidateHead : '',
    manifestSHA256: typeof input?.manifestSHA256 === 'string' ? input.manifestSHA256 : '',
    fileCount,
    errors: Object.freeze(errors),
    installationAuthorized: false,
    executionAuthorized: false,
  });
}
