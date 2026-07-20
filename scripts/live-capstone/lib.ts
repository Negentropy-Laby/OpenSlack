import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const LIVE_CAPSTONE_STEPS = Object.freeze([
  'release_artifacts',
  'clean_machine_archive',
  'guided_attach',
  'github_app_readiness',
  'openai_compatible_provider',
  'issue_claim_agent_delivery',
  'repository_webhooks',
  'pr_doctor',
  'independent_human_approval',
  'merge_steward_issue_done',
  'negentropy_preview_schema',
] as const);

export type LiveCapstoneStep = (typeof LIVE_CAPSTONE_STEPS)[number];
export type LiveCapstonePlatform = 'windows-x64' | 'linux-x64';
export type LiveCapstoneStepStatus = 'PASS' | 'FAIL';

export interface LiveCapstoneStepResult {
  readonly status: LiveCapstoneStepStatus;
  readonly recordedAt: string;
  readonly evidenceRefs: readonly string[];
  readonly artifactHashes: readonly string[];
}

export interface LiveCapstoneRun {
  readonly schema: 'openslack.live_capstone_run.v1';
  readonly correlationId: string;
  readonly testedCommit: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expectedPlatforms: readonly ['windows-x64', 'linux-x64'];
  readonly runs: Partial<
    Readonly<
      Record<
        LiveCapstonePlatform,
        {
          readonly os: 'windows' | 'linux';
          readonly arch: 'x64';
          readonly steps: Partial<Readonly<Record<LiveCapstoneStep, LiveCapstoneStepResult>>>;
        }
      >
    >
  >;
}

export interface PlanLiveCapstoneOptions {
  readonly workspaceRoot: string;
  readonly testedCommit: string;
  readonly correlationId?: string;
  readonly credentialReference?: string;
  readonly signedArtifactPath?: string;
  readonly publicKeyPath?: string;
  readonly now?: () => Date;
}

export interface RecordLiveCapstoneOptions {
  readonly workspaceRoot: string;
  readonly correlationId: string;
  readonly testedCommit: string;
  readonly platform: LiveCapstonePlatform;
  readonly step: LiveCapstoneStep;
  readonly status: LiveCapstoneStepStatus;
  readonly evidenceRefs?: readonly string[];
  readonly artifactPaths?: readonly string[];
  readonly now?: () => Date;
}

export interface VerifyLiveCapstoneOptions {
  readonly workspaceRoot: string;
  readonly correlationId: string;
  readonly testedCommit: string;
  readonly now?: () => Date;
  readonly maxAgeDays?: number;
}

export interface LiveCapstoneVerification {
  readonly schema: 'openslack.live_capstone_verification.v1';
  readonly correlationId: string;
  readonly testedCommit: string;
  readonly verifiedAt: string;
  readonly valid: boolean;
  readonly platforms: Readonly<
    Record<LiveCapstonePlatform, { readonly complete: boolean; readonly passed: boolean }>
  >;
  readonly failures: readonly string[];
  readonly runManifestSha256: string;
}

const COMMIT = /^[a-f0-9]{40}$/u;
const CORRELATION = /^CAP-[A-Z0-9][A-Z0-9-]{7,63}$/u;
const EVIDENCE_REF = /^(?:artifact|github|negentropy|npm|openslack|run):[A-Za-z0-9._/#-]{1,240}$/u;
const SENSITIVE_PATTERNS = [
  /\bAuthorization\b/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/iu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE REQUEST)-----/u,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/iu,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|endpoint[_-]?secret)\b\s*[:=]/iu,
] as const;

export function createLiveCapstonePlan(options: PlanLiveCapstoneOptions): LiveCapstoneRun {
  assertCommit(options.testedCommit);
  if (options.credentialReference !== undefined) {
    assertCredentialReference(options.credentialReference);
  }
  if (options.signedArtifactPath !== undefined) {
    assertRegularReferenceFile(options.signedArtifactPath, false);
  }
  if (options.publicKeyPath !== undefined) {
    assertRegularReferenceFile(options.publicKeyPath, true);
  }
  const nowDate = (options.now ?? (() => new Date()))();
  const now = nowDate.toISOString();
  const correlationId = options.correlationId ?? generateCorrelationId(nowDate);
  assertCorrelation(correlationId);
  const run: LiveCapstoneRun = {
    schema: 'openslack.live_capstone_run.v1',
    correlationId,
    testedCommit: options.testedCommit,
    createdAt: now,
    updatedAt: now,
    expectedPlatforms: ['windows-x64', 'linux-x64'],
    runs: {},
  };
  assertNoSensitiveData(run);
  writeRunAtomic(options.workspaceRoot, run, true);
  return run;
}

export function recordLiveCapstoneStep(options: RecordLiveCapstoneOptions): LiveCapstoneRun {
  assertCommit(options.testedCommit);
  assertCorrelation(options.correlationId);
  if (!LIVE_CAPSTONE_STEPS.includes(options.step)) throw new Error('Unknown capstone step.');
  if (!['windows-x64', 'linux-x64'].includes(options.platform)) {
    throw new Error('Unsupported capstone platform.');
  }
  if (!['PASS', 'FAIL'].includes(options.status)) throw new Error('Invalid capstone status.');
  const evidenceRefs = Object.freeze([...(options.evidenceRefs ?? [])].map(assertEvidenceRef));
  const artifactHashes = Object.freeze(
    [...(options.artifactPaths ?? [])].map((path) => hashArtifact(path)),
  );
  const path = liveCapstoneRunPath(options.workspaceRoot, options.correlationId);
  return withLock(options.workspaceRoot, options.correlationId, () => {
    const current = readLiveCapstoneRun(path);
    if (current.testedCommit !== options.testedCommit) {
      throw new Error('Capstone tested commit is immutable.');
    }
    const recordedAt = (options.now ?? (() => new Date()))().toISOString();
    const platform = current.runs[options.platform] ?? {
      os: options.platform === 'windows-x64' ? 'windows' : 'linux',
      arch: 'x64' as const,
      steps: {},
    };
    const next: LiveCapstoneRun = {
      ...current,
      updatedAt: recordedAt,
      runs: {
        ...current.runs,
        [options.platform]: {
          ...platform,
          steps: {
            ...platform.steps,
            [options.step]: {
              status: options.status,
              recordedAt,
              evidenceRefs,
              artifactHashes,
            },
          },
        },
      },
    };
    assertNoSensitiveData(next);
    writeRunAtomic(options.workspaceRoot, next, false);
    return next;
  });
}

export function verifyLiveCapstone(options: VerifyLiveCapstoneOptions): LiveCapstoneVerification {
  assertCommit(options.testedCommit);
  assertCorrelation(options.correlationId);
  const run = readLiveCapstoneRun(
    liveCapstoneRunPath(options.workspaceRoot, options.correlationId),
  );
  assertNoSensitiveData(run);
  const failures: string[] = [];
  if (run.testedCommit !== options.testedCommit) failures.push('TESTED_COMMIT_MISMATCH');
  const now = (options.now ?? (() => new Date()))();
  const maxAgeDays = options.maxAgeDays ?? 30;
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 365) {
    throw new Error('Capstone maximum age must be an integer from 1 to 365 days.');
  }
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const platforms = {
    'windows-x64': verifyPlatform('windows-x64'),
    'linux-x64': verifyPlatform('linux-x64'),
  } as const;
  const valid =
    failures.length === 0 &&
    Object.values(platforms).every((platform) => platform.complete && platform.passed);
  const bytes = readFileSync(liveCapstoneRunPath(options.workspaceRoot, options.correlationId));
  return {
    schema: 'openslack.live_capstone_verification.v1',
    correlationId: run.correlationId,
    testedCommit: run.testedCommit,
    verifiedAt: now.toISOString(),
    valid,
    platforms,
    failures,
    runManifestSha256: createHash('sha256').update(bytes).digest('hex'),
  };

  function verifyPlatform(id: LiveCapstonePlatform): {
    readonly complete: boolean;
    readonly passed: boolean;
  } {
    const platform = run.runs[id];
    if (!platform) {
      failures.push(`PLATFORM_MISSING:${id}`);
      return { complete: false, passed: false };
    }
    let complete = true;
    let passed = true;
    for (const step of LIVE_CAPSTONE_STEPS) {
      const result = platform.steps[step];
      if (!result) {
        complete = false;
        passed = false;
        failures.push(`STEP_MISSING:${id}:${step}`);
        continue;
      }
      if (result.status !== 'PASS') {
        passed = false;
        failures.push(`STEP_FAILED:${id}:${step}`);
      }
      const timestamp = Date.parse(result.recordedAt);
      const age = now.getTime() - timestamp;
      if (!Number.isFinite(timestamp) || age < 0 || age > maxAgeMs) {
        passed = false;
        failures.push(`STEP_STALE:${id}:${step}`);
      }
    }
    return { complete, passed };
  }
}

export function liveCapstoneRunPath(workspaceRoot: string, correlationId: string): string {
  assertCorrelation(correlationId);
  const path = join(workspaceRoot, '.openslack.local', 'capstone', correlationId, 'run.json');
  assertContained(workspaceRoot, path);
  return path;
}

export function readLiveCapstoneRun(path: string): LiveCapstoneRun {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) {
    throw new Error('Capstone run manifest must be a bounded regular file.');
  }
  const value = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)),
  ) as unknown;
  return parseLiveCapstoneRun(value);
}

export function assertNoSensitiveData(value: unknown): void {
  const text = JSON.stringify(value);
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(text))
      throw new Error('Capstone manifest contains prohibited secret material.');
  }
}

function writeRunAtomic(workspaceRoot: string, run: LiveCapstoneRun, create: boolean): void {
  const path = liveCapstoneRunPath(workspaceRoot, run.correlationId);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  if (create && existsSync(path)) throw new Error('Capstone correlation already exists.');
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error('Capstone run path must not be a symlink.');
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  const handle = openSync(temporary, 'r+');
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  if (process.platform !== 'win32') {
    const directoryHandle = openSync(directory, 'r');
    try {
      fsyncSync(directoryHandle);
    } finally {
      closeSync(directoryHandle);
    }
  }
}

function withLock<T>(workspaceRoot: string, correlationId: string, operation: () => T): T {
  const path = join(dirname(liveCapstoneRunPath(workspaceRoot, correlationId)), 'record.lock');
  let handle: number | undefined;
  try {
    handle = openSync(path, 'wx', 0o600);
    return operation();
  } finally {
    if (handle !== undefined) {
      closeSync(handle);
      rmSync(path, { force: true });
    }
  }
}

function hashArtifact(path: string): string {
  assertRegularReferenceFile(path, false);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertRegularReferenceFile(path: string, allowPublicKey: boolean): void {
  const info = lstatSync(resolve(path));
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Capstone input must be a regular file.');
  if (!allowPublicKey && /\.(?:pem|key|p12|pfx)$/iu.test(path)) {
    throw new Error('Capstone artifact input must not be credential material.');
  }
}

function assertCredentialReference(value: string): void {
  if (
    !/^(?:credential|keychain):[A-Za-z0-9._/-]{1,200}$/u.test(value) ||
    SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))
  ) {
    throw new Error('Capstone credential input must be an opaque credential reference.');
  }
}

function assertEvidenceRef(value: string): string {
  if (!EVIDENCE_REF.test(value) || SENSITIVE_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error('Capstone evidence must be a bounded redacted reference.');
  }
  return value;
}

function parseLiveCapstoneRun(value: unknown): LiveCapstoneRun {
  const run = exactRecord(value, [
    'schema',
    'correlationId',
    'testedCommit',
    'createdAt',
    'updatedAt',
    'expectedPlatforms',
    'runs',
  ]);
  if (
    run.schema !== 'openslack.live_capstone_run.v1' ||
    typeof run.correlationId !== 'string' ||
    !CORRELATION.test(run.correlationId) ||
    typeof run.testedCommit !== 'string' ||
    !COMMIT.test(run.testedCommit) ||
    !validTimestamp(run.createdAt) ||
    !validTimestamp(run.updatedAt) ||
    !Array.isArray(run.expectedPlatforms) ||
    run.expectedPlatforms.length !== 2 ||
    run.expectedPlatforms[0] !== 'windows-x64' ||
    run.expectedPlatforms[1] !== 'linux-x64'
  ) {
    throw new Error('Capstone run manifest identity is invalid.');
  }
  const runs = exactRecord(run.runs, ['windows-x64', 'linux-x64']);
  for (const platformId of ['windows-x64', 'linux-x64'] as const) {
    const valueForPlatform = runs[platformId];
    if (valueForPlatform === undefined) continue;
    const platform = exactRecord(valueForPlatform, ['os', 'arch', 'steps']);
    if (
      platform.os !== (platformId === 'windows-x64' ? 'windows' : 'linux') ||
      platform.arch !== 'x64'
    ) {
      throw new Error(`Capstone platform identity is invalid: ${platformId}.`);
    }
    const steps = exactRecord(platform.steps, LIVE_CAPSTONE_STEPS);
    for (const step of LIVE_CAPSTONE_STEPS) {
      const valueForStep = steps[step];
      if (valueForStep === undefined) continue;
      const result = exactRecord(valueForStep, [
        'status',
        'recordedAt',
        'evidenceRefs',
        'artifactHashes',
      ]);
      if (
        (result.status !== 'PASS' && result.status !== 'FAIL') ||
        !validTimestamp(result.recordedAt) ||
        !Array.isArray(result.evidenceRefs) ||
        !result.evidenceRefs.every(
          (entry) => typeof entry === 'string' && assertEvidenceRef(entry) === entry,
        ) ||
        !Array.isArray(result.artifactHashes) ||
        !result.artifactHashes.every(
          (entry) => typeof entry === 'string' && /^[a-f0-9]{64}$/u.test(entry),
        )
      ) {
        throw new Error(`Capstone step result is invalid: ${platformId}:${step}.`);
      }
    }
  }
  return run as unknown as LiveCapstoneRun;
}

function exactRecord(value: unknown, allowedFields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Capstone manifest field must be an object.');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(allowedFields);
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) throw new Error(`Unexpected capstone manifest field: ${field}.`);
  }
  return record;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function assertCommit(value: string): void {
  if (!COMMIT.test(value)) throw new Error('Tested commit must be a full lowercase SHA-1.');
}

function assertCorrelation(value: string): void {
  if (!CORRELATION.test(value)) throw new Error('Invalid capstone correlation ID.');
}

function generateCorrelationId(now: Date): string {
  const date = now.toISOString().slice(0, 10).replace(/-/gu, '');
  return `CAP-${date}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

function assertContained(root: string, path: string): void {
  const relation = relative(resolve(root), resolve(path));
  if (relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..')) return;
  throw new Error('Capstone state path escapes the workspace.');
}
