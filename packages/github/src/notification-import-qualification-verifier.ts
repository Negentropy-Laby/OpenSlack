import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type {
  NotificationImportQualificationReport,
  NotificationImportQualificationRoute,
} from './notification-import-qualification.js';
import { computeGitHubWatchConfigDigestV2 } from './watch-config-digest-v2.js';
import { parseGitHubWatchConfigV2 } from './watch-config-v2.js';

export function verifyNotificationQualificationFaultEvidence(
  path: string,
  expected: `sha256:${string}`,
): void {
  const bytes = readSafeFile(path, 4 * 1024 * 1024);
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (actual !== expected) throw new Error('QUALIFICATION_EVIDENCE_DIGEST_MISMATCH');

  const checksumPath = path.replace(/\.json$/u, '.sha256');
  if (checksumPath === path) throw new Error('QUALIFICATION_FAULT_PATH_INVALID');
  const checksum = readSafeFile(checksumPath, 4 * 1024);
  const expectedChecksum = Buffer.from(
    `${expected.slice('sha256:'.length)}  ${basename(path)}\n`,
    'utf8',
  );
  if (!checksum.equals(expectedChecksum)) {
    throw new Error('QUALIFICATION_FAULT_CHECKSUM_MISMATCH');
  }
}

export function verifyNotificationQualificationFrozenRun(
  report: NotificationImportQualificationReport,
): void {
  const configPath = requiredAbsolute(
    requiredEnvironment('OPENSLACK_NOTIFICATION_QUALIFICATION_CONFIG_PATH'),
  );
  const parsed = parseGitHubWatchConfigV2(readSafeFile(configPath, 1024 * 1024).toString('utf8'));
  if (!parsed.valid || !parsed.config) {
    throw new Error('QUALIFICATION_CONFIG_INVALID');
  }
  const config = parsed.config;
  const service = config.notification_service;
  if (!service) throw new Error('QUALIFICATION_CONFIG_INVALID');
  const checkoutCommit = requiredEnvironment('GITHUB_SHA').toLowerCase();
  const workspace = requiredAbsolute(requiredEnvironment('GITHUB_WORKSPACE'));
  const checkoutHead = git(workspace, ['rev-parse', '--verify', 'HEAD']);
  const checkoutTree = git(workspace, ['rev-parse', '--verify', `${checkoutCommit}^{tree}`]);
  const trackedStatus = git(workspace, ['status', '--porcelain=v1', '--untracked-files=no']);
  const serviceCommit = requiredGitObjectEnvironment('OPENSLACK_NOTIFICATION_SERVICE_COMMIT');
  const serviceTree = requiredGitObjectEnvironment('OPENSLACK_NOTIFICATION_SERVICE_TREE');
  const deploymentDigest = requiredEnvironment('OPENSLACK_NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST');
  const serviceOrigin = requiredEnvironment('OPENSLACK_NOTIFICATION_SERVICE_ORIGIN');
  if (
    report.openslack_commit !== checkoutCommit ||
    checkoutHead !== checkoutCommit ||
    report.openslack_tree !== checkoutTree ||
    trackedStatus !== '' ||
    report.service_commit !== serviceCommit ||
    report.service_tree !== serviceTree ||
    report.service_deployment_digest !== deploymentDigest ||
    service.expected_deployment_digest !== deploymentDigest ||
    service.endpoint !== serviceOrigin ||
    report.watch_config_digest !== computeGitHubWatchConfigDigestV2(config)
  ) {
    throw new Error('QUALIFICATION_FROZEN_IDENTITY_MISMATCH');
  }

  const repositories = [
    requiredEnvironment('OPENSLACK_NOTIFICATION_CANARY_REPO_A').toLowerCase(),
    requiredEnvironment('OPENSLACK_NOTIFICATION_CANARY_REPO_B').toLowerCase(),
  ].sort((left, right) => left.localeCompare(right));
  const vendorIds = [
    requiredEnvironment('OPENSLACK_NOTIFICATION_CANARY_VENDOR_SLACK'),
    requiredEnvironment('OPENSLACK_NOTIFICATION_CANARY_VENDOR_WEBHOOK'),
  ].sort((left, right) => left.localeCompare(right));
  if (
    JSON.stringify(report.repositories) !== JSON.stringify(repositories) ||
    JSON.stringify(report.vendor_ids) !== JSON.stringify(vendorIds)
  ) {
    throw new Error('QUALIFICATION_COVERAGE_IDENTITY_MISMATCH');
  }

  const epochText = requiredEnvironment('OPENSLACK_NOTIFICATION_CANARY_ROUTING_EPOCH');
  const epoch = Number(epochText);
  if (!/^[1-9][0-9]*$/u.test(epochText) || !Number.isSafeInteger(epoch)) {
    throw new Error('QUALIFICATION_ROUTING_EPOCH_INVALID');
  }
  const expectedByVendor = new Map<
    string,
    { routeId: string; encoder: NotificationImportQualificationRoute['encoder_version'] }
  >([
    [
      requiredEnvironment('OPENSLACK_NOTIFICATION_CANARY_VENDOR_SLACK'),
      {
        routeId: requiredEnvironment('OPENSLACK_NOTIFICATION_CANARY_ROUTE_SLACK'),
        encoder: 'openslack.slack_chat_post_message.v1',
      },
    ],
    [
      requiredEnvironment('OPENSLACK_NOTIFICATION_CANARY_VENDOR_WEBHOOK'),
      {
        routeId: requiredEnvironment('OPENSLACK_NOTIFICATION_CANARY_ROUTE_WEBHOOK'),
        encoder: 'openslack.webhook_notification.v1',
      },
    ],
  ]);
  const routes: NotificationImportQualificationRoute[] = [];
  for (const repository of config.repositories) {
    const canonicalRepository = `${repository.owner}/${repository.repo}`.toLowerCase();
    for (const route of repository.routes ?? []) {
      if (route.delivery.backend !== 'notification_service') continue;
      if ((route.sink !== 'slack' && route.sink !== 'webhook') || !route.delivery.vendor_id) {
        throw new Error('QUALIFICATION_CONFIG_ROUTE_INVALID');
      }
      routes.push({
        canonical_repository: canonicalRepository,
        route_id: route.id,
        routing_epoch: route.delivery.routing_epoch,
        vendor_id: route.delivery.vendor_id,
        encoder_version:
          route.sink === 'slack'
            ? 'openslack.slack_chat_post_message.v1'
            : 'openslack.webhook_notification.v1',
      });
    }
  }
  routes.sort(compareRoute);
  for (const route of routes) {
    const expected = expectedByVendor.get(route.vendor_id);
    if (
      !expected ||
      route.route_id !== expected.routeId ||
      route.routing_epoch !== epoch ||
      route.encoder_version !== expected.encoder
    ) {
      throw new Error('QUALIFICATION_CONFIG_ROUTE_MISMATCH');
    }
  }
  if (JSON.stringify(report.routes) !== JSON.stringify(routes)) {
    throw new Error('QUALIFICATION_FROZEN_ROUTES_MISMATCH');
  }
}

function compareRoute(
  left: NotificationImportQualificationRoute,
  right: NotificationImportQualificationRoute,
): number {
  return (
    left.canonical_repository.localeCompare(right.canonical_repository) ||
    left.vendor_id.localeCompare(right.vendor_id) ||
    left.route_id.localeCompare(right.route_id)
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || value !== value.trim()) throw new Error('QUALIFICATION_ENVIRONMENT_INVALID');
  return value;
}

function requiredGitObjectEnvironment(name: string): string {
  const value = requiredEnvironment(name).toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    throw new Error('QUALIFICATION_ENVIRONMENT_INVALID');
  }
  return value;
}

function requiredAbsolute(value: string): string {
  if (!isAbsolute(value)) throw new Error('QUALIFICATION_PATH_INVALID');
  return resolve(value);
}

function git(workspace: string, args: string[]): string {
  try {
    const output = execFileSync('git', ['-C', workspace, ...args], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (args[0] === 'rev-parse' && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(output)) {
      throw new Error('QUALIFICATION_GIT_OUTPUT_INVALID');
    }
    return output;
  } catch {
    throw new Error('QUALIFICATION_CHECKOUT_INVALID');
  }
}

function readSafeFile(path: string, maximumBytes: number): Buffer {
  const status = lstatSync(path, { bigint: true });
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    status.size < 1n ||
    status.size > BigInt(maximumBytes) ||
    (process.platform !== 'win32' && (Number(status.mode) & 0o777) !== 0o600)
  ) {
    throw new Error('QUALIFICATION_EVIDENCE_FILE_UNSAFE');
  }
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    let pathAfter;
    try {
      pathAfter = lstatSync(path, { bigint: true });
    } catch {
      throw new Error('QUALIFICATION_EVIDENCE_READ_RACE');
    }
    if (
      !before.isFile() ||
      before.dev !== status.dev ||
      before.ino !== status.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino ||
      pathAfter.size !== after.size ||
      pathAfter.mtimeNs !== after.mtimeNs ||
      pathAfter.ctimeNs !== after.ctimeNs ||
      (process.platform !== 'win32' && (Number(pathAfter.mode) & 0o777) !== 0o600) ||
      BigInt(bytes.length) !== after.size
    ) {
      throw new Error('QUALIFICATION_EVIDENCE_READ_RACE');
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}
