import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  cleanupNotificationTemporary,
  ensureSecureNotificationDirectory,
  fsyncNotificationDirectory,
  isNodeError,
  temporaryNotificationPath,
} from './notification-storage-fs.js';
import type { NotificationFaultScenario } from './notification-fault-proxy.js';

export const NOTIFICATION_FAULT_RUN_SCHEMA = 'openslack.notification_fault_run.v1';

export interface NotificationFaultRunCheck {
  name: string;
  passed: boolean;
  code: string;
  recorded_at: string;
}

export interface NotificationFaultRunManifest {
  schema: typeof NOTIFICATION_FAULT_RUN_SCHEMA;
  run_id: string;
  correlation_id: string;
  fault_case: NotificationFaultScenario | 'process_restart' | 'disk_boundary' | 'dual_restart';
  status: 'PASS' | 'FAIL';
  started_at: string;
  completed_at: string;
  openslack_commit: string;
  openslack_tree: string;
  service_commit: string;
  service_tree: string;
  service_deployment_digest: `sha256:${string}`;
  watch_config_digest: `sha256:${string}`;
  repository: string;
  route_id: string;
  routing_epoch: number;
  vendor_id: string;
  checks: NotificationFaultRunCheck[];
}

export interface NotificationFaultRunWriteResult {
  manifestPath: string;
  checksumPath: string;
  sha256: string;
  created: boolean;
}

export type NotificationFaultRunIdentity = Omit<
  NotificationFaultRunManifest,
  'schema' | 'status' | 'started_at' | 'completed_at' | 'checks'
>;

export interface NotificationFaultHarnessStep {
  name: string;
  execute: (signal?: AbortSignal) => Promise<{ passed: boolean; code: string }>;
}

export interface NotificationFaultHarnessOptions {
  rootPath: string;
  identity: NotificationFaultRunIdentity;
  steps: NotificationFaultHarnessStep[];
  signal?: AbortSignal;
  now?: () => Date;
}

export interface NotificationFaultHarnessResult {
  manifest: NotificationFaultRunManifest;
  evidence: NotificationFaultRunWriteResult;
}

/**
 * Executes explicit, injected fault steps sequentially and seals only closed
 * pass/fail codes. Process restarts, disk boundary actions, and network proxy
 * control stay in the deployment adapter; thrown errors are never persisted.
 */
export async function runNotificationFaultHarness(
  options: NotificationFaultHarnessOptions,
): Promise<NotificationFaultHarnessResult> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  preflightNotificationFaultHarness(options, startedAt);
  const checks: NotificationFaultRunCheck[] = [];
  for (const step of options.steps) {
    if (options.signal?.aborted) {
      checks.push({
        name: step.name,
        passed: false,
        code: 'FAULT_STEP_ABORTED',
        recorded_at: now().toISOString(),
      });
      break;
    }
    try {
      const result = await step.execute(options.signal);
      if (
        typeof result?.passed !== 'boolean' ||
        typeof result.code !== 'string' ||
        !/^[A-Z][A-Z0-9_]{0,127}$/u.test(result.code)
      ) {
        checks.push({
          name: step.name,
          passed: false,
          code: 'FAULT_STEP_RESULT_INVALID',
          recorded_at: now().toISOString(),
        });
        continue;
      }
      checks.push({
        name: step.name,
        passed: result.passed,
        code: result.code,
        recorded_at: now().toISOString(),
      });
    } catch {
      checks.push({
        name: step.name,
        passed: false,
        code: 'FAULT_STEP_FAILED',
        recorded_at: now().toISOString(),
      });
    }
  }
  const manifest: NotificationFaultRunManifest = {
    schema: NOTIFICATION_FAULT_RUN_SCHEMA,
    ...options.identity,
    status:
      checks.length === options.steps.length && checks.every((check) => check.passed)
        ? 'PASS'
        : 'FAIL',
    started_at: startedAt,
    completed_at: now().toISOString(),
    checks,
  };
  return {
    manifest,
    evidence: ensureNotificationFaultRun(options.rootPath, manifest),
  };
}

function preflightNotificationFaultHarness(
  options: NotificationFaultHarnessOptions,
  startedAt: string,
): void {
  if (
    !Array.isArray(options.steps) ||
    options.steps.length < 1 ||
    options.steps.length > 100 ||
    options.steps.some(
      (step) =>
        !isRecord(step) ||
        !hasExactKeys(step, ['name', 'execute']) ||
        !isBounded(step.name, 64) ||
        typeof step.execute !== 'function',
    ) ||
    new Set(options.steps.map((step) => step.name)).size !== options.steps.length
  ) {
    throw new TypeError('Fault harness requires one through 100 uniquely named valid steps.');
  }

  validateAndOrderManifest({
    schema: NOTIFICATION_FAULT_RUN_SCHEMA,
    ...options.identity,
    status: 'FAIL',
    started_at: startedAt,
    completed_at: startedAt,
    checks: [
      {
        name: 'preflight',
        passed: false,
        code: 'FAULT_PREFLIGHT_PENDING',
        recorded_at: startedAt,
      },
    ],
  });

  const root = ensureSecureNotificationDirectory(options.rootPath);
  const manifestPath = join(root, `${options.identity.run_id}.json`);
  const checksumPath = join(root, `${options.identity.run_id}.sha256`);
  if (existsSync(manifestPath) || existsSync(checksumPath)) {
    throw new Error('FAULT_RUN_ALREADY_SEALED');
  }
}

export function ensureNotificationFaultRun(
  rootPath: string,
  manifest: NotificationFaultRunManifest,
): NotificationFaultRunWriteResult {
  const root = ensureSecureNotificationDirectory(rootPath);
  const canonical = validateAndOrderManifest(manifest);
  const bytes = Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifestPath = join(root, `${canonical.run_id}.json`);
  const checksumPath = join(root, `${canonical.run_id}.sha256`);
  const manifestCreated = publishCreateOnly(root, manifestPath, bytes);
  const checksumCreated = publishCreateOnly(
    root,
    checksumPath,
    Buffer.from(`${sha256}  ${canonical.run_id}.json\n`, 'utf8'),
  );
  return {
    manifestPath,
    checksumPath,
    sha256,
    created: manifestCreated || checksumCreated,
  };
}

function validateAndOrderManifest(
  value: NotificationFaultRunManifest,
): NotificationFaultRunManifest {
  const keys = [
    'schema',
    'run_id',
    'correlation_id',
    'fault_case',
    'status',
    'started_at',
    'completed_at',
    'openslack_commit',
    'openslack_tree',
    'service_commit',
    'service_tree',
    'service_deployment_digest',
    'watch_config_digest',
    'repository',
    'route_id',
    'routing_epoch',
    'vendor_id',
    'checks',
  ] as const;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    value.schema !== NOTIFICATION_FAULT_RUN_SCHEMA ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value.run_id) ||
    !isBounded(value.correlation_id, 128) ||
    !FAULT_CASES.has(value.fault_case) ||
    (value.status !== 'PASS' && value.status !== 'FAIL') ||
    !isTimestamp(value.started_at) ||
    !isTimestamp(value.completed_at) ||
    Date.parse(value.completed_at) < Date.parse(value.started_at) ||
    !isGitObjectId(value.openslack_commit) ||
    !isGitObjectId(value.openslack_tree) ||
    !isGitObjectId(value.service_commit) ||
    !isGitObjectId(value.service_tree) ||
    !isDigest(value.service_deployment_digest) ||
    !isDigest(value.watch_config_digest) ||
    !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/[a-z0-9._-]{1,100}$/u.test(value.repository) ||
    !/^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value.route_id) ||
    !Number.isSafeInteger(value.routing_epoch) ||
    value.routing_epoch <= 0 ||
    !/^[a-z0-9-]{1,64}$/u.test(value.vendor_id) ||
    !Array.isArray(value.checks) ||
    value.checks.length < 1 ||
    value.checks.length > 100
  ) {
    throw new TypeError('Notification fault run manifest is invalid.');
  }
  const checks = value.checks.map((check) => {
    if (
      !isRecord(check) ||
      !hasExactKeys(check, ['name', 'passed', 'code', 'recorded_at']) ||
      !isBounded(check.name, 64) ||
      typeof check.passed !== 'boolean' ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(check.code) ||
      !isTimestamp(check.recorded_at)
    ) {
      throw new TypeError('Notification fault run check is invalid.');
    }
    return {
      name: check.name,
      passed: check.passed,
      code: check.code,
      recorded_at: check.recorded_at,
    };
  });
  if ((value.status === 'PASS') !== checks.every((check) => check.passed)) {
    throw new TypeError('Notification fault run status does not match its checks.');
  }
  return {
    schema: NOTIFICATION_FAULT_RUN_SCHEMA,
    run_id: value.run_id,
    correlation_id: value.correlation_id,
    fault_case: value.fault_case,
    status: value.status,
    started_at: value.started_at,
    completed_at: value.completed_at,
    openslack_commit: value.openslack_commit,
    openslack_tree: value.openslack_tree,
    service_commit: value.service_commit,
    service_tree: value.service_tree,
    service_deployment_digest: value.service_deployment_digest,
    watch_config_digest: value.watch_config_digest,
    repository: value.repository,
    route_id: value.route_id,
    routing_epoch: value.routing_epoch,
    vendor_id: value.vendor_id,
    checks,
  };
}

function publishCreateOnly(root: string, path: string, bytes: Buffer): boolean {
  if (existsSync(path)) {
    verifyPublished(path, bytes);
    return false;
  }
  const temporary = temporaryNotificationPath(root, randomUUID(), () => randomUUID());
  let descriptor: number | null = null;
  let created = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    try {
      linkSync(temporary, path);
      created = true;
      fsyncNotificationDirectory(root);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
    verifyPublished(path, bytes);
    return created;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    cleanupNotificationTemporary(temporary);
    fsyncNotificationDirectory(root);
  }
}

function verifyPublished(path: string, expected: Buffer): void {
  const pathStatus = lstatSync(path, { bigint: true });
  if (
    !pathStatus.isFile() ||
    pathStatus.isSymbolicLink() ||
    (process.platform !== 'win32' && (Number(pathStatus.mode) & 0o777) !== 0o600)
  ) {
    throw new Error('FAULT_RUN_FILE_UNSAFE');
  }
  if (pathStatus.size !== BigInt(expected.length)) throw new Error('FAULT_RUN_CONFLICT');
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.dev !== pathStatus.dev || before.ino !== pathStatus.ino) {
      throw new Error('FAULT_RUN_CONFLICT');
    }
    const actual = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    let afterPath;
    try {
      afterPath = lstatSync(path, { bigint: true });
    } catch {
      throw new Error('FAULT_RUN_CONFLICT');
    }
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      afterPath.dev !== before.dev ||
      afterPath.ino !== before.ino ||
      afterPath.size !== before.size ||
      afterPath.mtimeNs !== before.mtimeNs ||
      afterPath.ctimeNs !== before.ctimeNs ||
      (process.platform !== 'win32' && (Number(afterPath.mode) & 0o777) !== 0o600) ||
      !actual.equals(expected)
    ) {
      throw new Error('FAULT_RUN_CONFLICT');
    }
  } finally {
    closeSync(descriptor);
  }
}

const FAULT_CASES = new Set<string>([
  'passthrough',
  'response_loss_after_upstream',
  'malformed_202',
  'extra_field_202',
  'conflicting_notification_id_202',
  'unexpected_success_200',
  'redirect_302',
  'rejected_400',
  'rejected_401',
  'rejected_403',
  'rejected_404',
  'rejected_413',
  'conflict_409',
  'retryable_429',
  'retryable_500',
  'retryable_503',
  'deployment_digest_drift_202',
  'process_restart',
  'disk_boundary',
  'dual_restart',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isBounded(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}
