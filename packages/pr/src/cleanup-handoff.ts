import { decodeStrictJSON } from '@openslack/core';
/** Offline preparation only. This module does not import auth, delivery or cleanup execution. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readCleanupBrokerBuildInfo } from './internal/cleanup-handoff-build-info.js';

export type CleanupHandoffErrorCode =
  | 'HANDOFF_INPUT_INVALID'
  | 'HANDOFF_PATH_UNSAFE'
  | 'HANDOFF_SOURCE_DIRTY'
  | 'HANDOFF_SOURCE_CHANGED'
  | 'HANDOFF_CANDIDATE_MISMATCH'
  | 'HANDOFF_BUILD_MISMATCH'
  | 'HANDOFF_EVIDENCE_INVALID'
  | 'HANDOFF_TASK_EVIDENCE_EXPIRED'
  | 'HANDOFF_OUTPUT_EXISTS'
  | 'HANDOFF_IO_FAILED'
  | 'HANDOFF_MANIFEST_INVALID'
  | 'HANDOFF_DIGEST_MISMATCH'
  | 'HANDOFF_FILE_SET_MISMATCH';

export class CleanupHandoffError extends Error {
  constructor(public readonly code: CleanupHandoffErrorCode) {
    super(`${code}: stop; preserve existing evidence and review the handoff inputs.`);
    this.name = 'CleanupHandoffError';
  }
}

export interface CleanupHandoffBuildInput {
  reportPath: string;
  brokerPath: string;
  executorPath: string;
}

export interface CleanupHandoffTargetEvidence {
  installationManifestPath: string;
  taskViewPath: string;
  taskAttestationPath: string;
  appScopePath: string;
  networkPath: string;
  identityPath: string;
  dependencyInventoryPath: string;
}

export interface PrepareCleanupHandoffDraftInput {
  sourceRoot: string;
  candidateHead: string;
  /** Fresh directory outside the checkout and all active installation paths. Parent must exist. */
  outputDirectory: string;
  builds: readonly [CleanupHandoffBuildInput, CleanupHandoffBuildInput];
  runtimeDirectory: string;
  verifierPath: string;
  nodeChecksumPath: string;
  nodeLicensePath: string;
  runtimeLicensePaths: readonly string[];
  /** An explicitly selected, non-secret historical input record. Its approval is never inherited. */
  priorInputPath: string;
  /** Historical source label for an administrator-exported copy; never dereferenced. */
  priorInputSource?: string;
  targetEvidence: CleanupHandoffTargetEvidence;
  now?: Date;
}

export interface PrepareCleanupHandoffDraftResult {
  candidateHead: string;
  packageDirectory: string;
  manifestSHA256: string;
  priorInputSHA256: string;
  adminInputPath: string;
  reviewRecordPath: string;
  approvalStatus: 'DRAFT';
  unmetGates: string[];
}

export interface VerifyCleanupHandoffPackageInput {
  packageDirectory: string;
  /** Obtain both bindings from independent PR/review evidence, not from this package. */
  candidateHead: string;
  manifestSHA256: string;
  now?: Date;
}

export interface VerifyCleanupHandoffPackageResult {
  valid: boolean;
  candidateHead: string;
  manifestSHA256: string;
  fileCount: number;
  errors: CleanupHandoffErrorCode[];
  unmetGates: string[];
  installationAuthorized: false;
  executionAuthorized: false;
}

export const CLEANUP_HANDOFF_SCHEMAS = Object.freeze({
  build: 'openslack.cleanup_handoff_build_report.v1',
  evidence: 'openslack.cleanup_handoff_evidence_index.v1',
});
const LEGACY_SCHEMAS = {
  build: 'openslack.pr418.clean-build-report.v1',
  evidence: 'openslack.pr418.qualification-evidence-index.v1',
} as const;
const QUALIFICATION_NODE = 'v24.18.1';
export interface CleanupHandoffToolchain {
  bun: string;
  go: string;
  node: string;
}
const LEGACY_TOOLCHAIN = Object.freeze({
  bun: '1.4.0',
  go: 'go version go1.26.5 linux/amd64',
  node: QUALIFICATION_NODE,
});

/** Repository Bun/Go pins are byte-bound to the candidate; Node is the reviewed target pin. */
function toolchainFromPins(packageBytes: Buffer, goBytes: Buffer): CleanupHandoffToolchain {
  const manifest = json(packageBytes),
    dependencies = object(manifest.devDependencies);
  const bun = dependencies['bun-types'],
    go = /^go (1\.\d+\.\d+)$/m.exec(goBytes.toString('utf8'))?.[1];
  check(typeof bun === 'string' && /^\d+\.\d+\.\d+$/.test(bun) && go, 'HANDOFF_BUILD_MISMATCH');
  return Object.freeze({ bun, go: `go version go${go} linux/amd64`, node: QUALIFICATION_NODE });
}
export function cleanupHandoffToolchain(sourceRoot: string): CleanupHandoffToolchain {
  return toolchainFromPins(
    safeRead(join(sourceRoot, 'package.json')),
    safeRead(join(sourceRoot, 'services/cleanup-broker/go.mod')),
  );
}
export function assertCleanupHandoffToolchain(
  actual: unknown,
  expected: CleanupHandoffToolchain,
): void {
  const tools = object(actual);
  check(
    tools.bun === expected.bun && tools.go === expected.go && tools.node === expected.node,
    'HANDOFF_BUILD_MISMATCH',
  );
}
function verifiedToolchain(value: unknown): CleanupHandoffToolchain {
  if (value === undefined) return LEGACY_TOOLCHAIN;
  const tools = object(value);
  check(
    typeof tools.bun === 'string' &&
      /^\d+\.\d+\.\d+$/.test(tools.bun) &&
      typeof tools.go === 'string' &&
      /^go version go1\.\d+\.\d+ linux\/amd64$/.test(tools.go) &&
      tools.node === QUALIFICATION_NODE,
    'HANDOFF_BUILD_MISMATCH',
  );
  return { bun: tools.bun, go: tools.go, node: QUALIFICATION_NODE };
}

const FILES = [
  'README.md',
  'handoff.md',
  'tools/verify-handoff.mjs',
  'artifacts/cleanup-broker',
  'artifacts/executor.mjs',
  'artifacts/node',
  'artifacts/git',
  'artifacts/sh',
  'artifacts/git-remote-https',
  'evidence/build-report-a.json',
  'evidence/build-report-b.json',
  'evidence/node-LICENSE',
  'evidence/OpenSlack-LICENSE',
  'evidence/node-SHASUMS256.txt',
  'evidence/runtime-licenses.json',
  'evidence/prior-admin-inputs.md',
  'evidence/app-scope.json',
  'evidence/network-inputs.json',
  'evidence/identity-inputs.json',
  'evidence/task-attestation.json',
  'evidence/target-dependency-discovery.json',
  'evidence/qualification-index.json',
  'evidence/source-locks.json',
  'draft/broker.DRAFT.json',
  'draft/install-manifest.DRAFT.json',
  'draft/task-dependencies.DRAFT.json',
  'draft/inputs.DRAFT.json',
  'templates/broker.template.json',
  'templates/install-manifest.template.json',
  'templates/task-dependencies.template.json',
].sort();
const GATES = [
  'NEW_INPUT_REVIEW_REQUIRED',
  'REGISTRY_MAIN_DEPLOYMENT_NOT_VERIFIED',
  'RUNTIME_IDENTITY_NOT_PROVISIONED',
  'ADMINISTRATOR_INSTALLATION_AND_CREDENTIALS_REQUIRED',
  'ACTUAL_NONCE_ACTIVATION_REQUIRED',
  'GOVERNED_PERMIT_REQUIRED',
  'REAL_QUALIFICATION_NOT_RUN',
  'CURRENT_HEAD_HUMAN_APPROVAL_REQUIRED',
];
const HASH = /^[a-f0-9]{64}$/;
const HEAD = /^[a-f0-9]{40}$/;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
type Digest = typeof sha;
function ownByteDigests(): Digest {
  const hashes = new WeakMap<Buffer, string>();
  return (bytes) => {
    if (typeof bytes === 'string') return sha(bytes);
    const existing = hashes.get(bytes);
    if (existing) return existing;
    const hash = sha(bytes);
    hashes.set(bytes, hash);
    return hash;
  };
}
const jsonBytes = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const fail = (code: CleanupHandoffErrorCode): never => {
  throw new CleanupHandoffError(code);
};
function check(value: unknown, code: CleanupHandoffErrorCode): asserts value {
  if (!value) fail(code);
}
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  check(value && typeof value === 'object' && !Array.isArray(value), 'HANDOFF_EVIDENCE_INVALID');
  return value as ObjectValue;
}
function json(raw: Buffer): ObjectValue {
  try {
    return object(decodeStrictJSON(raw, 256 * 1024 * 1024));
  } catch (error) {
    if (error instanceof CleanupHandoffError) throw error;
    return fail('HANDOFF_EVIDENCE_INVALID');
  }
}
function timestamp(value: unknown): number {
  check(
    typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value),
    'HANDOFF_EVIDENCE_INVALID',
  );
  const time = Date.parse(value);
  check(Number.isFinite(time), 'HANDOFF_EVIDENCE_INVALID');
  return time;
}
function nowMs(now?: Date): number {
  const value = (now ?? new Date()).getTime();
  check(Number.isFinite(value), 'HANDOFF_INPUT_INVALID');
  return value;
}
function safePath(path: string): string {
  check(typeof path === 'string' && path.length > 0 && !path.includes('\0'), 'HANDOFF_PATH_UNSAFE');
  const absolute = resolve(path);
  check(
    !absolute.split(/[\\/]/).some((part) => /^(?:credentials|secrets|\.env)(?:\.|$)/i.test(part)) &&
      !/\.(?:pem|key)$/i.test(absolute),
    'HANDOFF_PATH_UNSAFE',
  );
  return absolute;
}
function ancestors(path: string): void {
  // Reject symlinks in every ancestor as well as in the file itself.
  for (let current = path; ; current = dirname(current)) {
    check(!lstatSync(current).isSymbolicLink(), 'HANDOFF_PATH_UNSAFE');
    if (dirname(current) === current) break;
  }
}
function safeRead(path: string): Buffer {
  path = safePath(path);
  ancestors(path);
  const before = lstatSync(path);
  check(
    before.isFile() && before.nlink === 1 && before.size <= 256 * 1024 * 1024,
    'HANDOFF_PATH_UNSAFE',
  );
  const binding = (s: typeof before) =>
    [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeMs, s.ctimeMs].join(':');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    check(binding(fstatSync(fd)) === binding(before), 'HANDOFF_SOURCE_CHANGED');
    const raw = readFileSync(fd);
    check(
      binding(fstatSync(fd)) === binding(before) && binding(lstatSync(path)) === binding(before),
      'HANDOFF_SOURCE_CHANGED',
    );
    ancestors(path);
    return raw;
  } finally {
    closeSync(fd);
  }
}
function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

/** Read only the explicit ordinary JSON recipe; credential paths are rejected before opening. */
export function readCleanupHandoffInputFile(path: string): unknown {
  check(typeof path === 'string' && path.endsWith('.json'), 'HANDOFF_INPUT_INVALID');
  return json(safeRead(path));
}

/** Verify ordinary runtime bytes against the previous reviewed manifest before executing tools. */
export function assertCleanupHandoffRuntime(
  input: Pick<PrepareCleanupHandoffDraftInput, 'runtimeDirectory' | 'targetEvidence'>,
): string {
  const runtime = safePath(input.runtimeDirectory);
  const manifest = json(safeRead(input.targetEvidence.installationManifestPath));
  check(
    manifest.schema === 'openslack.cleanup_installation.v1' && Array.isArray(manifest.files),
    'HANDOFF_EVIDENCE_INVALID',
  );
  const locations = new Map([
    ['node', '/usr/lib/openslack-cleanup/node'],
    ['git', '/usr/lib/openslack-cleanup/git'],
    ['sh', '/usr/lib/openslack-cleanup/sh'],
    ['git-remote-https', '/usr/lib/openslack-cleanup/git-core/git-remote-https'],
  ]);
  for (const [name, path] of locations) {
    const entries = manifest.files.map(object).filter((entry) => entry.path === path);
    check(
      entries.length === 1 && entries[0]!.sha256 === sha(safeRead(join(runtime, name))),
      'HANDOFF_BUILD_MISMATCH',
    );
  }
  // Execute the exact absolute file whose bytes were validated, never a PATH lookup.
  return join(runtime, 'node');
}
function cleanSource(root: string, head: string): void {
  check(git(root, ['rev-parse', 'HEAD']) === head, 'HANDOFF_CANDIDATE_MISMATCH');
  check(
    git(root, ['status', '--porcelain', '--untracked-files=normal']) === '',
    'HANDOFF_SOURCE_DIRTY',
  );
}

/** Shared preflight for build orchestration. It creates nothing and opens no credentials. */
export function assertCleanupHandoffStaging(
  input: Pick<PrepareCleanupHandoffDraftInput, 'sourceRoot' | 'outputDirectory' | 'candidateHead'>,
): { sourceRoot: string; outputDirectory: string } {
  check(
    input && typeof input.candidateHead === 'string' && HEAD.test(input.candidateHead),
    'HANDOFF_INPUT_INVALID',
  );
  const active = (path: string) =>
    [
      '/etc/openslack-cleanup',
      '/usr/lib/openslack-cleanup',
      '/run/openslack-cleanup',
      '/var/lib/openslack-cleanup',
    ].some((target) => path === target || path.startsWith(target + '/'));
  check(
    typeof input.outputDirectory === 'string' &&
      !active(input.outputDirectory.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')),
    'HANDOFF_PATH_UNSAFE',
  );
  const root = safePath(input.sourceRoot),
    output = safePath(input.outputDirectory);
  ancestors(root);
  const within = relative(root, output);
  check(
    within !== '' && (within.startsWith(`..${sep}`) || isAbsolute(within)),
    'HANDOFF_PATH_UNSAFE',
  );
  check(!active(output.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')), 'HANDOFF_PATH_UNSAFE');
  ancestors(dirname(output));
  check(!existsSync(output), 'HANDOFF_OUTPUT_EXISTS');
  cleanSource(root, input.candidateHead);
  return { sourceRoot: root, outputDirectory: output };
}
function storedFields(raw: Buffer): Record<string, string> {
  const fields: Record<string, string> = Object.create(null);
  for (const line of raw.toString('utf8').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const match = /^([a-z][a-z0-9_]*): ([^\r\n]*)$/.exec(line);
    check(match && !Object.hasOwn(fields, match[1]!), 'HANDOFF_EVIDENCE_INVALID');
    fields[match[1]!] = match[2]!;
  }
  check(['APPROVED', 'DRAFT'].includes(fields.approval_status!), 'HANDOFF_EVIDENCE_INVALID');
  return fields;
}
function value(fields: Record<string, string>, key: string): string {
  const text = fields[key];
  check(
    typeof text === 'string' && text.length > 0 && text.length <= 512 && text !== 'REQUIRED',
    'HANDOFF_EVIDENCE_INVALID',
  );
  return text;
}
function positive(fields: Record<string, string>, key: string): number {
  const text = value(fields, key);
  check(
    /^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(Number(text)),
    'HANDOFF_EVIDENCE_INVALID',
  );
  return Number(text);
}
function brokerIdentity(raw: Buffer, head: string, tools: CleanupHandoffToolchain): void {
  try {
    const info = readCleanupBrokerBuildInfo(raw);
    check(
      info.version === tools.go.split(' ')[2] &&
        info.path ===
          'github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/cmd/cleanup-broker',
      'HANDOFF_BUILD_MISMATCH',
    );
    for (const [key, value] of [
      ['vcs.revision', head],
      ['vcs.modified', 'false'],
      ['-trimpath', 'true'],
      ['CGO_ENABLED', '0'],
      ['GOOS', 'linux'],
      ['GOARCH', 'amd64'],
      ['vcs', 'git'],
    ])
      check(info.settings.get(key!) === value, 'HANDOFF_BUILD_MISMATCH');
  } catch {
    fail('HANDOFF_BUILD_MISMATCH');
  }
}
function buildReport(
  raw: Buffer,
  broker: Buffer,
  executor: Buffer,
  head: string,
  lock: string,
  goModule: string,
  expectedTools: CleanupHandoffToolchain,
  sha: Digest,
): ObjectValue {
  const report = json(raw);
  check(
    (report.schema === CLEANUP_HANDOFF_SCHEMAS.build || report.schema === LEGACY_SCHEMAS.build) &&
      report.candidateHead === head &&
      report.checkoutCleanAfterBuild === true &&
      report.independentCloneNoHardlinks === true &&
      typeof report.checkout === 'string' &&
      report.lockfileSHA256 === lock &&
      report.goModuleSHA256 === goModule,
    'HANDOFF_BUILD_MISMATCH',
  );
  assertCleanupHandoffToolchain(report.tools, expectedTools);
  for (const [name, rawBytes] of [
    ['broker', broker],
    ['executor', executor],
  ] as const) {
    const artifact = object(report[name]);
    check(
      artifact.sha256 === sha(rawBytes) && artifact.bytes === rawBytes.length,
      'HANDOFF_BUILD_MISMATCH',
    );
  }
  check(Array.isArray(report.commands) && report.commands.length > 0, 'HANDOFF_BUILD_MISMATCH');
  brokerIdentity(broker, head, expectedTools);
  return report;
}

export function assertCleanupHandoffObjects(path: string): void {
  const objects = safePath(path);
  ancestors(objects);
  check(lstatSync(objects).isDirectory(), 'HANDOFF_BUILD_MISMATCH');
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name),
        stamp = lstatSync(full);
      check(
        !stamp.isSymbolicLink() &&
          (!stamp.isFile() || stamp.nlink === 1) &&
          full !== join(objects, 'info/alternates'),
        'HANDOFF_BUILD_MISMATCH',
      );
      if (stamp.isDirectory()) walk(full);
      else check(stamp.isFile(), 'HANDOFF_BUILD_MISMATCH');
    }
  };
  walk(objects);
}

function inspectBuildCheckout(path: string, head: string, lock: string, goModule: string): string {
  path = safePath(path);
  check(existsSync(path), 'HANDOFF_BUILD_MISMATCH');
  ancestors(path);
  const cloneGit = join(path, '.git'),
    cloneObjects = join(cloneGit, 'objects');
  // Validate roots before Git follows them or the walk inspects only their children.
  ancestors(cloneGit);
  ancestors(cloneObjects);
  check(
    lstatSync(cloneGit).isDirectory() && lstatSync(cloneObjects).isDirectory(),
    'HANDOFF_BUILD_MISMATCH',
  );
  cleanSource(path, head);
  check(
    sha(safeRead(join(path, 'bun.lock'))) === lock &&
      sha(safeRead(join(path, 'services/cleanup-broker/go.mod'))) === goModule,
    'HANDOFF_BUILD_MISMATCH',
  );
  const gitDirectory = git(path, ['rev-parse', '--absolute-git-dir']);
  // Native realpath expands Windows 8.3 aliases, as Git does. Ancestor/link
  // checks above remain mandatory before comparing these directory identities.
  const identity = realpathSync.native(gitDirectory);
  check(identity === realpathSync.native(cloneGit), 'HANDOFF_BUILD_MISMATCH');
  const objects = join(gitDirectory, 'objects');
  assertCleanupHandoffObjects(objects);
  return identity;
}
function taskView(raw: Buffer, fields: Record<string, string>): ObjectValue {
  const task = json(raw);
  check(
    task.schema === 'openslack.cleanup_task_view.v1' &&
      task.workspaceId === fields.workspace_id &&
      task.repository ===
        `${fields.qualification_repository_owner}/${fields.qualification_repository_name}` &&
      task.repositoryId === fields.qualification_repository_numeric_id &&
      Array.isArray(task.tasks) &&
      timestamp(task.notBefore) < timestamp(task.expiresAt),
    'HANDOFF_EVIDENCE_INVALID',
  );
  return task;
}

export function prepareCleanupHandoffDraft(
  input: PrepareCleanupHandoffDraftInput,
): PrepareCleanupHandoffDraftResult {
  const sha = ownByteDigests();
  try {
    check(
      input &&
        HEAD.test(input.candidateHead) &&
        Array.isArray(input.builds) &&
        input.builds.length === 2,
      'HANDOFF_INPUT_INVALID',
    );
    const { sourceRoot: root, outputDirectory: output } = assertCleanupHandoffStaging(input);
    const files = new Map<string, Buffer>();
    const add = (name: string, bytes: Buffer) => {
      check(!files.has(name), 'HANDOFF_INPUT_INVALID');
      files.set(name, bytes);
    };
    const source = (path: string) => {
      const raw = safeRead(join(root, path));
      const committed = execFileSync(
        'git',
        ['-C', root, 'show', `${input.candidateHead}:${path}`],
        { maxBuffer: 8 * 1024 * 1024 },
      );
      check(raw.equals(committed), 'HANDOFF_SOURCE_CHANGED');
      return raw;
    };
    const lock = sha(source('bun.lock'));
    const goModuleBytes = source('services/cleanup-broker/go.mod');
    const goModule = sha(goModuleBytes);
    const expectedTools = toolchainFromPins(source('package.json'), goModuleBytes);
    const priorRaw = safeRead(input.priorInputPath);
    const priorSource = input.priorInputSource ?? resolve(input.priorInputPath);
    check(
      typeof priorSource === 'string' &&
        priorSource.length <= 1024 &&
        !/[\r\n\0]/.test(priorSource),
      'HANDOFF_INPUT_INVALID',
    );
    const fields = storedFields(priorRaw);
    const selected: Record<string, string> = {
      ...fields,
      candidate_head: input.candidateHead,
      approval_status: 'DRAFT',
      approved_by: 'REQUIRED',
      approved_at_utc: 'REQUIRED',
    };
    delete selected.package_manifest_sha256;
    for (const key of [
      'agent_id',
      'broker_id',
      'workspace_id',
      'principal_id',
      'runtime_uid_claim',
      'run_id',
      'issuer_trust_domain',
      'target_distro',
      'allowed_git_remote_name',
      'qualification_repository_owner',
      'qualification_repository_name',
    ])
      value(fields, key);
    check(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(fields.agent_id!), 'HANDOFF_EVIDENCE_INVALID');
    check(
      fields.qualification_repository_default_branch === 'main' &&
        fields.automatic_branch_deletion === 'false',
      'HANDOFF_EVIDENCE_INVALID',
    );
    const brokerUid = positive(fields, 'broker_uid'),
      brokerGid = positive(fields, 'broker_gid');
    const agentUid = positive(fields, 'agent_uid'),
      agentGid = positive(fields, 'agent_gid');
    check(brokerUid !== agentUid && brokerGid !== agentGid, 'HANDOFF_EVIDENCE_INVALID');
    positive(fields, 'qualification_repository_numeric_id');
    const registry = source(`.openslack/agents/registry/${fields.agent_id}.yaml`);
    const entry = object(parseYaml(registry.toString('utf8')));
    const identity = object(entry.identity);
    const permissions = object(entry.permissions),
      actions = object(permissions.actions);
    check(
      entry.agent_id === fields.agent_id &&
        identity.uid === fields.runtime_uid_claim &&
        identity.principal_id === fields.principal_id &&
        permissions.max_risk_zone === 'yellow' &&
        actions['pr.cleanup_branch_scoped.v1'] === 'allow' &&
        actions['pr.cleanup_branch'] === 'deny',
      'HANDOFF_EVIDENCE_INVALID',
    );
    const brokers: Buffer[] = [],
      executors: Buffer[] = [],
      checkouts: string[] = [];
    input.builds.forEach((build, index) => {
      const broker = safeRead(build.brokerPath),
        executor = safeRead(build.executorPath),
        report = safeRead(build.reportPath);
      const parsed = buildReport(
        report,
        broker,
        executor,
        input.candidateHead,
        lock,
        goModule,
        expectedTools,
        sha,
      );
      checkouts.push(parsed.checkout as string);
      brokers.push(broker);
      executors.push(executor);
      add(`evidence/build-report-${index === 0 ? 'a' : 'b'}.json`, report);
    });
    check(
      checkouts[0] !== checkouts[1] &&
        brokers[0]!.equals(brokers[1]!) &&
        executors[0]!.equals(executors[1]!),
      'HANDOFF_BUILD_MISMATCH',
    );
    const gitDirectories = checkouts.map((path) =>
      inspectBuildCheckout(path, input.candidateHead, lock, goModule),
    );
    check(
      new Set([
        realpathSync.native(git(root, ['rev-parse', '--absolute-git-dir'])),
        ...gitDirectories,
      ]).size === 3,
      'HANDOFF_BUILD_MISMATCH',
    );
    add('artifacts/cleanup-broker', brokers[0]!);
    add('artifacts/executor.mjs', executors[0]!);
    for (const name of ['node', 'git', 'sh', 'git-remote-https'])
      add(`artifacts/${name}`, safeRead(join(input.runtimeDirectory, name)));
    add('tools/verify-handoff.mjs', safeRead(input.verifierPath));
    add('evidence/node-LICENSE', safeRead(input.nodeLicensePath));
    add('evidence/node-SHASUMS256.txt', safeRead(input.nodeChecksumPath));
    check(
      Array.isArray(input.runtimeLicensePaths) && input.runtimeLicensePaths.length > 0,
      'HANDOFF_INPUT_INVALID',
    );
    add(
      'evidence/runtime-licenses.json',
      jsonBytes(
        input.runtimeLicensePaths.map((path) => {
          const raw = safeRead(path);
          return { source: resolve(path), sha256: sha(raw), text: raw.toString('utf8') };
        }),
      ),
    );
    add('evidence/prior-admin-inputs.md', priorRaw);
    for (const [name, path] of [
      ['app-scope', input.targetEvidence.appScopePath],
      ['network-inputs', input.targetEvidence.networkPath],
      ['identity-inputs', input.targetEvidence.identityPath],
      ['task-attestation', input.targetEvidence.taskAttestationPath],
      ['target-dependency-discovery', input.targetEvidence.dependencyInventoryPath],
    ]) {
      const raw = safeRead(path!);
      json(raw);
      add(`evidence/${name}.json`, raw);
    }
    const taskRaw = safeRead(input.targetEvidence.taskViewPath),
      task = taskView(taskRaw, fields);
    const now = nowMs(input.now);
    check(
      timestamp(task.notBefore) <= now && now < timestamp(task.expiresAt),
      'HANDOFF_TASK_EVIDENCE_EXPIRED',
    );
    check(
      json(files.get('evidence/task-attestation.json')!).task_view_sha256 === sha(taskRaw),
      'HANDOFF_EVIDENCE_INVALID',
    );
    add('draft/task-dependencies.DRAFT.json', taskRaw);
    const manifest = json(safeRead(input.targetEvidence.installationManifestPath));
    check(
      manifest.schema === 'openslack.cleanup_installation.v1' && Array.isArray(manifest.files),
      'HANDOFF_EVIDENCE_INVALID',
    );
    const network = object(manifest.network);
    const proxy = value(fields, 'approved_https_proxy'),
      noProxy = value(fields, 'approved_no_proxy');
    check(
      network.httpsProxy === (proxy === '""' ? '' : proxy) &&
        network.noProxy === (noProxy === '""' ? '' : noProxy),
      'HANDOFF_EVIDENCE_INVALID',
    );
    const installed = new Map([
      ['/usr/lib/openslack-cleanup/node', 'artifacts/node'],
      ['/usr/lib/openslack-cleanup/executor.mjs', 'artifacts/executor.mjs'],
      ['/usr/lib/openslack-cleanup/git', 'artifacts/git'],
      ['/usr/lib/openslack-cleanup/sh', 'artifacts/sh'],
      ['/usr/lib/openslack-cleanup/git-core/git-remote-https', 'artifacts/git-remote-https'],
      ['/usr/lib/openslack-cleanup/cleanup-broker', 'artifacts/cleanup-broker'],
    ]);
    const seen = new Set<string>();
    for (const item of manifest.files) {
      const file = object(item);
      check(
        typeof file.path === 'string' &&
          file.path.startsWith('/usr/lib/') &&
          !file.path.includes('..') &&
          HASH.test(String(file.sha256)) &&
          !seen.has(file.path),
        'HANDOFF_EVIDENCE_INVALID',
      );
      seen.add(file.path);
      const artifact = installed.get(file.path);
      if (artifact) file.sha256 = sha(files.get(artifact)!);
    }
    for (const required of [...installed.keys()].filter(
      (name) => !name.endsWith('/cleanup-broker'),
    ))
      check(seen.has(required), 'HANDOFF_EVIDENCE_INVALID');
    add('draft/install-manifest.DRAFT.json', jsonBytes(manifest));
    const brokerConfig = {
      schema: 'openslack.cleanup_broker_config.v2',
      brokerId: fields.broker_id,
      workspaceId: fields.workspace_id,
      uid: brokerUid,
      gid: brokerGid,
      peerBindings: [
        {
          uid: agentUid,
          agentId: fields.agent_id,
          subject: {
            principalId: fields.principal_id,
            runtimeUid: fields.runtime_uid_claim,
            runId: fields.run_id,
          },
        },
      ],
      allowedRemotes: [fields.allowed_git_remote_name],
      artifacts: {
        nodeSHA256: sha(files.get('artifacts/node')!),
        executorSHA256: sha(executors[0]!),
        gitSHA256: sha(files.get('artifacts/git')!),
        installManifestSHA256: sha(files.get('draft/install-manifest.DRAFT.json')!),
      },
      credentialRefs: {
        governance: '/etc/openslack-cleanup/credentials/governance',
        githubAppPrivateKey: '/etc/openslack-cleanup/credentials/github-app-private-key',
      },
      githubApp: {
        appId: positive(fields, 'deletion_app_id'),
        installationId: positive(fields, 'deletion_app_installation_id'),
        owner: fields.qualification_repository_owner,
        repo: fields.qualification_repository_name,
      },
    };
    add('draft/broker.DRAFT.json', jsonBytes(brokerConfig));
    add(
      'draft/inputs.DRAFT.json',
      jsonBytes({
        schema: 'openslack.cleanup_handoff_draft.v1',
        candidateHead: input.candidateHead,
        approvalStatus: 'DRAFT',
        priorInput: {
          source: priorSource,
          sha256: sha(priorRaw),
          approvalNotInherited: true,
        },
        selected,
        installationAuthorized: false,
        executionAuthorized: false,
      }),
    );
    add(
      'evidence/source-locks.json',
      jsonBytes({
        candidateHead: input.candidateHead,
        lockfileSHA256: lock,
        goModuleSHA256: goModule,
        toolchain: expectedTools,
        registrySHA256: sha(registry),
      }),
    );
    add(
      'evidence/qualification-index.json',
      jsonBytes({
        schema: CLEANUP_HANDOFF_SCHEMAS.evidence,
        candidateHead: input.candidateHead,
        recordedAt: new Date(now).toISOString(),
        target: fields.target_distro,
        credentialContentsIncluded: false,
        qualification: 'NOT_RUN',
        approvalStatus: 'DRAFT',
        unmetGates: GATES,
        verified: { independentCleanBuildsMatch: true, brokerEmbeddedVcsIdentity: true },
        note: 'Build and byte integrity evidence only. Prior target/administrator evidence is historical; refresh before installation. No current-head CI or live qualification is inferred.',
      }),
    );
    for (const name of ['broker', 'install-manifest', 'task-dependencies'])
      add(
        `templates/${name}.template.json`,
        source(`services/cleanup-broker/handoff/${name}.template.json`),
      );
    add('README.md', source('services/cleanup-broker/README.md'));
    add('handoff.md', source('services/cleanup-broker/handoff.md'));
    add('evidence/OpenSlack-LICENSE', source('LICENSE'));
    check(
      JSON.stringify([...files.keys()].sort()) === JSON.stringify(FILES),
      'HANDOFF_FILE_SET_MISMATCH',
    );
    // Recheck before any output: a change while inputs were being read cannot publish a draft.
    cleanSource(root, input.candidateHead);
    const sums = Buffer.from(FILES.map((name) => `${sha(files.get(name)!)}  ./${name}\n`).join(''));
    const manifestSHA256 = sha(sums),
      packageDirectory = join(output, 'package');
    // Exclusive creation, never overwrite an old candidate. On I/O failure preserve partial
    // output for inspection rather than recursively deleting an unrecognized directory.
    mkdirSync(output, { mode: 0o755 });
    mkdirSync(packageDirectory, { mode: 0o755 });
    for (const [name, bytes] of files) {
      const path = join(packageDirectory, name);
      mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
      writeFileSync(path, bytes, {
        flag: 'wx',
        mode: name.startsWith('artifacts/') && name !== 'artifacts/executor.mjs' ? 0o755 : 0o644,
      });
    }
    writeFileSync(join(packageDirectory, 'SHA256SUMS'), sums, { flag: 'wx', mode: 0o644 });
    const adminInputPath = join(output, 'admin-inputs.DRAFT.md'),
      reviewRecordPath = join(output, 'review-record.DRAFT.json');
    const draft = {
      ...fields,
      approval_status: 'DRAFT',
      approved_by: 'REQUIRED',
      approved_at_utc: 'REQUIRED',
      candidate_head: input.candidateHead,
      package_manifest_sha256: manifestSHA256,
      prior_input_source: priorSource,
      prior_input_sha256: sha(priorRaw),
      installed_configuration: 'false',
      runtime_identity_provisioning_status: 'NOT_PROVISIONED',
      activation: 'NOT_ISSUED',
      permit: 'NOT_ISSUED',
      qualification: 'NOT_RUN',
    };
    writeFileSync(
      adminInputPath,
      '# New candidate input record. Historical approval is not inherited.\n' +
        Object.entries(draft)
          .map(([key, text]) => `${key}: ${text}\n`)
          .join(''),
      { flag: 'wx', mode: 0o600 },
    );
    writeFileSync(
      reviewRecordPath,
      jsonBytes({
        schema: 'openslack.cleanup_handoff_review.v1',
        candidateHead: input.candidateHead,
        manifestSHA256,
        approvalStatus: 'DRAFT',
        priorInputSHA256: sha(priorRaw),
        adminInputSHA256: sha(safeRead(adminInputPath)),
        unmetGates: GATES,
        installationAuthorized: false,
        executionAuthorized: false,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    const verified = verifyCleanupHandoffPackage({
      packageDirectory,
      candidateHead: input.candidateHead,
      manifestSHA256,
      now: input.now,
    });
    check(verified.valid, verified.errors[0] ?? 'HANDOFF_EVIDENCE_INVALID');
    return {
      candidateHead: input.candidateHead,
      packageDirectory,
      manifestSHA256,
      priorInputSHA256: sha(priorRaw),
      adminInputPath,
      reviewRecordPath,
      approvalStatus: 'DRAFT',
      unmetGates: verified.unmetGates,
    };
  } catch (error) {
    if (error instanceof CleanupHandoffError) throw error;
    if (objectErrorCode(error) === 'EEXIST') fail('HANDOFF_OUTPUT_EXISTS');
    return fail('HANDOFF_IO_FAILED');
  }
}

function objectErrorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

function verifyDraftRelations(bytes: Map<string, Buffer>, sha: Digest): ObjectValue {
  const fields = storedFields(bytes.get('evidence/prior-admin-inputs.md')!);
  const broker = json(bytes.get('draft/broker.DRAFT.json')!);
  const artifacts = object(broker.artifacts);
  const manifestRaw = bytes.get('draft/install-manifest.DRAFT.json')!;
  for (const [field, file] of [
    ['nodeSHA256', 'node'],
    ['executorSHA256', 'executor.mjs'],
    ['gitSHA256', 'git'],
  ] as const)
    check(artifacts[field] === sha(bytes.get(`artifacts/${file}`)!), 'HANDOFF_EVIDENCE_INVALID');
  check(
    artifacts.installManifestSHA256 === sha(manifestRaw) &&
      broker.schema === 'openslack.cleanup_broker_config.v2' &&
      broker.brokerId === fields.broker_id &&
      broker.workspaceId === fields.workspace_id &&
      broker.uid === positive(fields, 'broker_uid') &&
      broker.gid === positive(fields, 'broker_gid'),
    'HANDOFF_EVIDENCE_INVALID',
  );
  check(
    JSON.stringify(broker.peerBindings) ===
      JSON.stringify([
        {
          uid: positive(fields, 'agent_uid'),
          agentId: fields.agent_id,
          subject: {
            principalId: fields.principal_id,
            runtimeUid: fields.runtime_uid_claim,
            runId: fields.run_id,
          },
        },
      ]),
    'HANDOFF_EVIDENCE_INVALID',
  );
  const app = object(broker.githubApp);
  check(
    app.appId === positive(fields, 'deletion_app_id') &&
      app.installationId === positive(fields, 'deletion_app_installation_id') &&
      app.owner === fields.qualification_repository_owner &&
      app.repo === fields.qualification_repository_name,
    'HANDOFF_EVIDENCE_INVALID',
  );
  const manifest = json(manifestRaw),
    seen = new Set<string>();
  check(
    manifest.schema === 'openslack.cleanup_installation.v1' && Array.isArray(manifest.files),
    'HANDOFF_EVIDENCE_INVALID',
  );
  const required = new Map([
    ['/usr/lib/openslack-cleanup/node', 'node'],
    ['/usr/lib/openslack-cleanup/executor.mjs', 'executor.mjs'],
    ['/usr/lib/openslack-cleanup/git', 'git'],
    ['/usr/lib/openslack-cleanup/sh', 'sh'],
    ['/usr/lib/openslack-cleanup/git-core/git-remote-https', 'git-remote-https'],
  ]);
  for (const value of manifest.files) {
    const file = object(value);
    check(
      typeof file.path === 'string' &&
        file.path.startsWith('/usr/lib/') &&
        !file.path.includes('..') &&
        !seen.has(file.path) &&
        HASH.test(String(file.sha256)),
      'HANDOFF_EVIDENCE_INVALID',
    );
    seen.add(file.path);
    const artifact = required.get(file.path);
    if (artifact)
      check(file.sha256 === sha(bytes.get(`artifacts/${artifact}`)!), 'HANDOFF_EVIDENCE_INVALID');
  }
  for (const path of required.keys()) check(seen.has(path), 'HANDOFF_EVIDENCE_INVALID');
  const taskRaw = bytes.get('draft/task-dependencies.DRAFT.json')!;
  check(
    json(bytes.get('evidence/task-attestation.json')!).task_view_sha256 === sha(taskRaw),
    'HANDOFF_EVIDENCE_INVALID',
  );
  return taskView(taskRaw, fields);
}

export function verifyCleanupHandoffPackage(
  input: VerifyCleanupHandoffPackageInput,
): VerifyCleanupHandoffPackageResult {
  const sha = ownByteDigests();
  const result: VerifyCleanupHandoffPackageResult = {
    valid: false,
    candidateHead: input?.candidateHead ?? '',
    manifestSHA256: input?.manifestSHA256 ?? '',
    fileCount: 0,
    errors: [],
    unmetGates: [...GATES],
    installationAuthorized: false,
    executionAuthorized: false,
  };
  try {
    check(
      input && HEAD.test(input.candidateHead) && HASH.test(input.manifestSHA256),
      'HANDOFF_INPUT_INVALID',
    );
    const root = safePath(input.packageDirectory);
    ancestors(root);
    const sums = safeRead(join(root, 'SHA256SUMS'));
    check(sha(sums) === input.manifestSHA256, 'HANDOFF_DIGEST_MISMATCH');
    const entries = new Map<string, string>();
    for (const line of sums.toString('utf8').split('\n')) {
      if (line === '') continue;
      const match = /^([a-f0-9]{64})  \.\/([A-Za-z0-9._/-]+)$/.exec(line);
      check(
        match && FILES.includes(match[2]!) && !entries.has(match[2]!),
        'HANDOFF_MANIFEST_INVALID',
      );
      entries.set(match[2]!, match[1]!);
    }
    check(
      JSON.stringify([...entries.keys()].sort()) === JSON.stringify(FILES),
      'HANDOFF_FILE_SET_MISMATCH',
    );
    const observed: string[] = [],
      bytes = new Map<string, Buffer>();
    const directories = new Set(FILES.map((path) => dirname(path)).filter((path) => path !== '.'));
    const walk = (directory: string, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const name = prefix + entry.name,
          full = join(directory, entry.name);
        check(!entry.isSymbolicLink(), 'HANDOFF_PATH_UNSAFE');
        if (entry.isDirectory()) {
          check(directories.has(name), 'HANDOFF_FILE_SET_MISMATCH');
          walk(full, name + '/');
        } else {
          check(entry.isFile(), 'HANDOFF_PATH_UNSAFE');
          observed.push(name);
        }
      }
    };
    walk(root);
    check(
      JSON.stringify(observed.sort()) === JSON.stringify([...FILES, 'SHA256SUMS'].sort()),
      'HANDOFF_FILE_SET_MISMATCH',
    );
    for (const [name, hash] of entries) {
      const raw = safeRead(join(root, name));
      check(sha(raw) === hash, 'HANDOFF_DIGEST_MISMATCH');
      bytes.set(name, raw);
    }
    const locks = json(bytes.get('evidence/source-locks.json')!);
    check(
      locks.candidateHead === input.candidateHead &&
        HASH.test(String(locks.lockfileSHA256)) &&
        HASH.test(String(locks.goModuleSHA256)),
      'HANDOFF_CANDIDATE_MISMATCH',
    );
    for (const id of ['a', 'b'])
      buildReport(
        bytes.get(`evidence/build-report-${id}.json`)!,
        bytes.get('artifacts/cleanup-broker')!,
        bytes.get('artifacts/executor.mjs')!,
        input.candidateHead,
        String(locks.lockfileSHA256),
        String(locks.goModuleSHA256),
        verifiedToolchain(locks.toolchain),
        sha,
      );
    const index = json(bytes.get('evidence/qualification-index.json')!),
      draft = json(bytes.get('draft/inputs.DRAFT.json')!);
    check(
      index.candidateHead === input.candidateHead && draft.candidateHead === input.candidateHead,
      'HANDOFF_CANDIDATE_MISMATCH',
    );
    check(
      (index.schema === CLEANUP_HANDOFF_SCHEMAS.evidence ||
        index.schema === LEGACY_SCHEMAS.evidence) &&
        index.approvalStatus === 'DRAFT' &&
        index.qualification === 'NOT_RUN' &&
        draft.approvalStatus === 'DRAFT' &&
        object(draft.selected).candidate_head === input.candidateHead &&
        !Object.hasOwn(object(draft.selected), 'package_manifest_sha256') &&
        draft.installationAuthorized === false &&
        draft.executionAuthorized === false &&
        object(draft.priorInput).approvalNotInherited === true &&
        object(draft.priorInput).sha256 === sha(bytes.get('evidence/prior-admin-inputs.md')!),
      'HANDOFF_EVIDENCE_INVALID',
    );
    const task = verifyDraftRelations(bytes, sha);
    const now = nowMs(input.now);
    if (now < timestamp(task.notBefore) || now >= timestamp(task.expiresAt))
      result.unmetGates.push('TASK_EVIDENCE_EXPIRED');
    result.fileCount = FILES.length;
    result.valid = true;
  } catch (error) {
    result.errors.push(error instanceof CleanupHandoffError ? error.code : 'HANDOFF_IO_FAILED');
  }
  return result;
}
