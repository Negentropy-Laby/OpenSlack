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

export const QUALIFICATION_PROFILES = Object.freeze({
  notification: [
    'notification_px2',
    'notification_runtime_admission',
    'notification_vendor_delivery',
    'notification_reconciliation',
  ],
  plugin: [
    'plugin_manifest_signature',
    'plugin_external_install',
    'plugin_capability_trust',
    'plugin_isolation',
  ],
  workflow: [
    'provider_doctor',
    'provider_smoke',
    'workflow_authenticated_execution',
    'workflow_checkpoint_resume',
    'workflow_effect_budget_fencing_audit',
  ],
  scenario: [
    'scenario_catalog_12_16_17',
    'scenario_locked_pack',
    'scenario_agent_bound_execution',
    'scenario_human_attestation',
    'scenario_unknown_workflow_fail_closed',
  ],
  collaboration: [
    'github_app_readiness',
    'real_issue_claim_worker',
    'bot_pr_current_head',
    'webhook_observation',
    'prms_ready',
    'independent_human_approval',
    'governed_merge_issue_done',
  ],
  negentropy: ['negentropy_signature', 'negentropy_registration', 'negentropy_live_diagnostics'],
  'organization-graph': [
    'organization_graph_live_source',
    'organization_graph_rebuild',
    'organization_graph_query_explain',
    'organization_graph_fail_closed',
  ],
} as const);

export type QualificationProfile = keyof typeof QUALIFICATION_PROFILES;
export type QualificationStep = (typeof QUALIFICATION_PROFILES)[QualificationProfile][number];
export type QualificationStatus = 'PASS' | 'FAIL';

export interface QualificationStepResult {
  readonly status: QualificationStatus;
  readonly recordedAt: string;
  readonly environment: string;
  readonly evidenceRefs: readonly string[];
  readonly artifactHashes: readonly string[];
}

export interface QualificationCapstoneRun {
  readonly schema: 'openslack.qualification_capstone_run.v1';
  readonly correlationId: string;
  readonly testedCommit: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly steps: Partial<Readonly<Record<QualificationStep, QualificationStepResult>>>;
}

const ALL_STEPS = Object.freeze(
  Object.values(QUALIFICATION_PROFILES).flat(),
) as readonly QualificationStep[];
const COMMIT = /^[a-f0-9]{40}$/u;
const CORRELATION = /^QUAL-[A-Z0-9][A-Z0-9-]{7,63}$/u;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._/-]{1,127}$/u;
const EVIDENCE =
  /^(?:artifact|github|negentropy|notification|openslack|run):[A-Za-z0-9._/#-]{1,240}$/u;
const SECRET_PATTERNS = [
  /\bAuthorization\b/iu,
  /\bBearer\s+\S+/iu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE REQUEST)-----/u,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/iu,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\b\s*[:=]/iu,
] as const;

export function createQualificationPlan(options: {
  readonly workspaceRoot: string;
  readonly testedCommit: string;
  readonly correlationId?: string;
  readonly now?: () => Date;
}): QualificationCapstoneRun {
  assertCommit(options.testedCommit);
  const nowDate = (options.now ?? (() => new Date()))();
  const now = nowDate.toISOString();
  const correlationId = options.correlationId ?? generateCorrelationId(nowDate);
  assertCorrelation(correlationId);
  const run: QualificationCapstoneRun = {
    schema: 'openslack.qualification_capstone_run.v1',
    correlationId,
    testedCommit: options.testedCommit,
    createdAt: now,
    updatedAt: now,
    steps: {},
  };
  assertNoSecrets(run);
  writeRunAtomic(options.workspaceRoot, run, true);
  return run;
}

export function recordQualificationStep(options: {
  readonly workspaceRoot: string;
  readonly correlationId: string;
  readonly testedCommit: string;
  readonly step: QualificationStep;
  readonly status: QualificationStatus;
  readonly environment: string;
  readonly evidenceRefs?: readonly string[];
  readonly artifactPaths?: readonly string[];
  readonly now?: () => Date;
}): QualificationCapstoneRun {
  assertCommit(options.testedCommit);
  assertCorrelation(options.correlationId);
  if (!ALL_STEPS.includes(options.step)) throw new Error('Unknown qualification step.');
  if (options.status !== 'PASS' && options.status !== 'FAIL')
    throw new Error('Invalid qualification status.');
  if (!ENVIRONMENT.test(options.environment)) throw new Error('Invalid qualification environment.');
  const evidenceRefs = (options.evidenceRefs ?? []).map(assertEvidenceRef);
  const artifactHashes = (options.artifactPaths ?? []).map(hashArtifact);
  return withLock(options.workspaceRoot, options.correlationId, () => {
    const current = readQualificationRun(
      qualificationRunPath(options.workspaceRoot, options.correlationId),
    );
    if (current.testedCommit !== options.testedCommit)
      throw new Error('Qualification tested commit is immutable.');
    const recordedAt = (options.now ?? (() => new Date()))().toISOString();
    const next: QualificationCapstoneRun = {
      ...current,
      updatedAt: recordedAt,
      steps: {
        ...current.steps,
        [options.step]: {
          status: options.status,
          recordedAt,
          environment: options.environment,
          evidenceRefs,
          artifactHashes,
        },
      },
    };
    assertNoSecrets(next);
    writeRunAtomic(options.workspaceRoot, next, false);
    return next;
  });
}

export function verifyQualification(options: {
  readonly workspaceRoot: string;
  readonly correlationId: string;
  readonly testedCommit: string;
  readonly profiles: readonly QualificationProfile[];
  readonly now?: () => Date;
  readonly maxAgeDays?: number;
}) {
  assertCommit(options.testedCommit);
  assertCorrelation(options.correlationId);
  if (options.profiles.length === 0 || new Set(options.profiles).size !== options.profiles.length) {
    throw new Error('At least one unique qualification profile is required.');
  }
  const runPath = qualificationRunPath(options.workspaceRoot, options.correlationId);
  const run = readQualificationRun(runPath);
  assertNoSecrets(run);
  const failures: string[] = [];
  if (run.testedCommit !== options.testedCommit) failures.push('TESTED_COMMIT_MISMATCH');
  const now = (options.now ?? (() => new Date()))();
  const maxAgeDays = options.maxAgeDays ?? 30;
  if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 365)
    throw new Error('Invalid qualification freshness window.');
  const maxAge = maxAgeDays * 24 * 60 * 60 * 1000;
  for (const profile of options.profiles) {
    const required = QUALIFICATION_PROFILES[profile];
    if (!required) throw new Error(`Unknown qualification profile: ${profile}.`);
    for (const step of required) {
      const result = run.steps[step];
      if (!result) {
        failures.push(`STEP_MISSING:${profile}:${step}`);
        continue;
      }
      if (result.status !== 'PASS') failures.push(`STEP_FAILED:${profile}:${step}`);
      const age = now.getTime() - Date.parse(result.recordedAt);
      if (!Number.isFinite(age) || age < 0 || age > maxAge)
        failures.push(`STEP_STALE:${profile}:${step}`);
    }
  }
  return {
    schema: 'openslack.qualification_capstone_verification.v1' as const,
    correlationId: run.correlationId,
    testedCommit: run.testedCommit,
    profiles: [...options.profiles],
    verifiedAt: now.toISOString(),
    valid: failures.length === 0,
    failures,
    runManifestSha256: createHash('sha256').update(readFileSync(runPath)).digest('hex'),
  };
}

export function qualificationRunPath(workspaceRoot: string, correlationId: string): string {
  assertCorrelation(correlationId);
  const path = join(
    workspaceRoot,
    '.openslack.local',
    'qualification-capstone',
    correlationId,
    'run.json',
  );
  assertContained(workspaceRoot, path);
  return path;
}

export function readQualificationRun(path: string): QualificationCapstoneRun {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 2 * 1024 * 1024) {
    throw new Error('Qualification manifest must be a bounded regular file.');
  }
  return parseRun(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path))));
}

function parseRun(value: unknown): QualificationCapstoneRun {
  const run = exactRecord(value, [
    'schema',
    'correlationId',
    'testedCommit',
    'createdAt',
    'updatedAt',
    'steps',
  ]);
  if (
    run.schema !== 'openslack.qualification_capstone_run.v1' ||
    typeof run.correlationId !== 'string' ||
    !CORRELATION.test(run.correlationId) ||
    typeof run.testedCommit !== 'string' ||
    !COMMIT.test(run.testedCommit) ||
    !validTimestamp(run.createdAt) ||
    !validTimestamp(run.updatedAt)
  )
    throw new Error('Qualification manifest identity is invalid.');
  const steps = exactRecord(run.steps, ALL_STEPS);
  for (const [step, raw] of Object.entries(steps)) {
    const result = exactRecord(raw, [
      'status',
      'recordedAt',
      'environment',
      'evidenceRefs',
      'artifactHashes',
    ]);
    if (
      !ALL_STEPS.includes(step as QualificationStep) ||
      (result.status !== 'PASS' && result.status !== 'FAIL') ||
      !validTimestamp(result.recordedAt) ||
      typeof result.environment !== 'string' ||
      !ENVIRONMENT.test(result.environment) ||
      !Array.isArray(result.evidenceRefs) ||
      !result.evidenceRefs.every(
        (entry) => typeof entry === 'string' && assertEvidenceRef(entry) === entry,
      ) ||
      !Array.isArray(result.artifactHashes) ||
      !result.artifactHashes.every(
        (entry) => typeof entry === 'string' && /^[a-f0-9]{64}$/u.test(entry),
      )
    )
      throw new Error(`Qualification step result is invalid: ${step}.`);
  }
  return run as unknown as QualificationCapstoneRun;
}

function writeRunAtomic(
  workspaceRoot: string,
  run: QualificationCapstoneRun,
  create: boolean,
): void {
  const path = qualificationRunPath(workspaceRoot, run.correlationId);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  if (create && existsSync(path)) throw new Error('Qualification correlation already exists.');
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw new Error('Qualification run path must not be a symlink.');
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
}

function withLock<T>(workspaceRoot: string, correlationId: string, operation: () => T): T {
  const path = join(dirname(qualificationRunPath(workspaceRoot, correlationId)), 'record.lock');
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
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > 64 * 1024 * 1024 ||
    /\.(?:pem|key|p12|pfx)$/iu.test(path)
  ) {
    throw new Error('Qualification artifact must be a bounded non-credential regular file.');
  }
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

function assertEvidenceRef(value: string): string {
  if (!EVIDENCE.test(value) || SECRET_PATTERNS.some((pattern) => pattern.test(value)))
    throw new Error('Qualification evidence reference is invalid.');
  return value;
}

function assertNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text)))
    throw new Error('Qualification manifest contains prohibited secret material.');
}

function exactRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Qualification manifest field must be an object.');
  const record = value as Record<string, unknown>;
  for (const field of Object.keys(record))
    if (!allowed.includes(field))
      throw new Error(`Unexpected qualification manifest field: ${field}.`);
  return record;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function assertCommit(value: string): void {
  if (!COMMIT.test(value)) throw new Error('Tested commit must be a full lowercase SHA-1.');
}
function assertCorrelation(value: string): void {
  if (!CORRELATION.test(value)) throw new Error('Invalid qualification correlation ID.');
}
function generateCorrelationId(now: Date): string {
  return `QUAL-${now.toISOString().slice(0, 10).replace(/-/gu, '')}-${randomBytes(4).toString('hex').toUpperCase()}`;
}
function assertContained(root: string, path: string): void {
  const relation = relative(resolve(root), resolve(path));
  if (relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..')) return;
  throw new Error('Qualification state path escapes the workspace.');
}
