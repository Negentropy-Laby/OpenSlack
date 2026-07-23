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
import { assertNoDuplicateJsonKeys } from './notification-service-client.js';

export const NOTIFICATION_IMPORT_QUALIFICATION_SCHEMA =
  'openslack.notification_import_qualification_report.v1';

export const NOTIFICATION_IMPORT_QUALIFICATION_REQUIRED_DRILLS = [
  'openslack_restart',
  'response_loss',
  'accepted_ledger_recovery',
  'blob_queue_pre_post_boundary',
  'service_restart_pending_outbox',
  'vendor_result_commit_ambiguity',
  'http_protocol_matrix',
  'integrity_identity_permissions',
] as const;

export type NotificationImportQualificationDrillKind =
  (typeof NOTIFICATION_IMPORT_QUALIFICATION_REQUIRED_DRILLS)[number];

export interface NotificationImportQualificationRoute {
  canonical_repository: string;
  route_id: string;
  routing_epoch: number;
  vendor_id: string;
  encoder_version: 'openslack.slack_chat_post_message.v1' | 'openslack.webhook_notification.v1';
}

export interface NotificationImportQualificationVendorConfig {
  vendor_id: string;
  config_version: number;
}

export interface NotificationImportQualificationPrincipalScope {
  principal_id: string;
  capabilities: ('submit_notification' | 'read_notifications')[];
  vendor_ids: string[];
}

export interface NotificationImportQualificationObservation {
  route_record_id: string;
  notification_id: string;
  idempotency_key_sha256: `sha256:${string}`;
  canonical_repository: string;
  event_kind: 'issue' | 'push';
  vendor_id: string;
  accepted_at: string;
  delivered_at: string;
  idempotent_replay: false;
  reconciliation: 'consistent';
}

export interface NotificationImportQualificationDrill {
  kind: NotificationImportQualificationDrillKind;
  status: 'PASS' | 'FAIL';
  evidence_sha256: `sha256:${string}`;
}

export interface NotificationImportQualificationInput {
  correlation_id: string;
  started_at: string;
  completed_at: string;
  openslack_commit: string;
  openslack_tree: string;
  service_commit: string;
  service_tree: string;
  service_deployment_digest: `sha256:${string}`;
  watch_config_digest: `sha256:${string}`;
  routes: NotificationImportQualificationRoute[];
  vendor_configs: NotificationImportQualificationVendorConfig[];
  caller_scope: NotificationImportQualificationPrincipalScope;
  auditor_scope: NotificationImportQualificationPrincipalScope;
  observations: NotificationImportQualificationObservation[];
  drills: NotificationImportQualificationDrill[];
  caller_read_ops_denied: boolean;
  auditor_submit_denied: boolean;
  final_pending: number;
  final_dead: number;
  final_unexplained_conflicts: number;
  final_authority_fallbacks: number;
  unexplained_vendor_duplicates: number;
  explained_vendor_duplicates: number;
  response_loss_replay_same_key: boolean;
  response_loss_replay_same_notification_id: boolean;
  response_loss_vendor_duplicates: number;
  explained_duplicates_same_key_and_body_digest: boolean;
  external_timeout_count: number;
  payload_secret_marker_findings: number;
  receipt_reconciliation_sha256: `sha256:${string}`;
  security_review_sha256: `sha256:${string}`;
}

export interface NotificationImportQualificationReport extends NotificationImportQualificationInput {
  schema: typeof NOTIFICATION_IMPORT_QUALIFICATION_SCHEMA;
  status: 'PASS' | 'FAIL';
  distinct_non_replay_accepted: number;
  repositories: string[];
  vendor_ids: string[];
  maximum_convergence_seconds: number;
  failed_requirements: string[];
  does_not_claim: [
    'G5_CANARY_PASS',
    'LIVE_VERIFIED',
    'IB7_CUTOVER',
    'OPENSLACK_0_3_0',
    'PRODUCTION_READY',
  ];
}

export interface NotificationImportQualificationWriteResult {
  reportPath: string;
  checksumPath: string;
  sha256: `sha256:${string}`;
  created: boolean;
}

const REPOSITORY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/[a-z0-9._-]{1,100}$/u;
const ROUTE_PATTERN = /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const VENDOR_PATTERN = /^[a-z0-9-]{1,64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_CONVERGENCE_SECONDS = 10 * 60;
const MINIMUM_OBSERVATIONS = 8;

export function createNotificationImportQualificationReport(
  input: NotificationImportQualificationInput,
): NotificationImportQualificationReport {
  const normalized = validateAndOrderInput(input);
  const failedRequirements: string[] = [];
  const repositories = uniqueSorted(
    normalized.observations.map((observation) => observation.canonical_repository),
  );
  const vendorIds = uniqueSorted(
    normalized.observations.map((observation) => observation.vendor_id),
  );
  const distinctKeys = new Set(
    normalized.observations.map((observation) => observation.idempotency_key_sha256),
  );
  const maximumConvergenceSeconds = Math.max(
    0,
    ...normalized.observations.map(
      (observation) =>
        (Date.parse(observation.delivered_at) - Date.parse(observation.accepted_at)) / 1_000,
    ),
  );
  const runDurationSeconds =
    (Date.parse(normalized.completed_at) - Date.parse(normalized.started_at)) / 1_000;

  requireCondition(
    normalized.observations.length >= MINIMUM_OBSERVATIONS &&
      distinctKeys.size >= MINIMUM_OBSERVATIONS,
    'ACCEPTED_COUNT_INSUFFICIENT',
    failedRequirements,
  );
  requireCondition(repositories.length === 2, 'REPOSITORY_COVERAGE_INVALID', failedRequirements);
  requireCondition(vendorIds.length === 2, 'VENDOR_COVERAGE_INVALID', failedRequirements);
  requireCondition(
    coversEventMatrix(normalized.observations, repositories, vendorIds),
    'EVENT_MATRIX_INCOMPLETE',
    failedRequirements,
  );
  requireCondition(
    maximumConvergenceSeconds <= MAX_CONVERGENCE_SECONDS,
    'DELIVERY_CONVERGENCE_EXCEEDED',
    failedRequirements,
  );
  requireCondition(runDurationSeconds <= 60 * 60, 'RUN_DURATION_EXCEEDED', failedRequirements);
  requireCondition(
    coversFrozenRoutes(normalized.routes, repositories, vendorIds),
    'FROZEN_ROUTE_COVERAGE_INVALID',
    failedRequirements,
  );
  requireCondition(
    coversVendorConfigs(normalized.vendor_configs, vendorIds),
    'VENDOR_CONFIG_COVERAGE_INVALID',
    failedRequirements,
  );
  requireCondition(
    hasExactPrincipalScope(normalized.caller_scope, 'submit_notification', vendorIds),
    'CALLER_SCOPE_INVALID',
    failedRequirements,
  );
  requireCondition(
    hasExactPrincipalScope(normalized.auditor_scope, 'read_notifications', vendorIds),
    'AUDITOR_SCOPE_INVALID',
    failedRequirements,
  );
  requireCondition(
    normalized.caller_read_ops_denied && normalized.auditor_submit_denied,
    'PRINCIPAL_NEGATIVE_TEST_FAILED',
    failedRequirements,
  );
  requireCondition(
    coversRequiredDrills(normalized.drills),
    'FAULT_DRILL_COVERAGE_INVALID',
    failedRequirements,
  );
  requireCondition(normalized.final_pending === 0, 'PENDING_NOT_DRAINED', failedRequirements);
  requireCondition(normalized.final_dead === 0, 'DELIVERY_DEAD_PRESENT', failedRequirements);
  requireCondition(
    normalized.final_unexplained_conflicts === 0,
    'UNEXPLAINED_CONFLICT_PRESENT',
    failedRequirements,
  );
  requireCondition(
    normalized.final_authority_fallbacks === 0,
    'AUTHORITY_FALLBACK_PRESENT',
    failedRequirements,
  );
  requireCondition(
    normalized.unexplained_vendor_duplicates === 0,
    'UNEXPLAINED_VENDOR_DUPLICATE_PRESENT',
    failedRequirements,
  );
  requireCondition(
    normalized.response_loss_replay_same_key &&
      normalized.response_loss_replay_same_notification_id &&
      normalized.response_loss_vendor_duplicates === 0,
    'RESPONSE_LOSS_REPLAY_INVALID',
    failedRequirements,
  );
  requireCondition(
    normalized.explained_vendor_duplicates === 0 ||
      normalized.explained_duplicates_same_key_and_body_digest,
    'EXPLAINED_DUPLICATE_IDENTITY_INVALID',
    failedRequirements,
  );
  requireCondition(
    normalized.external_timeout_count === 0,
    'EXTERNAL_STEP_TIMED_OUT',
    failedRequirements,
  );
  requireCondition(
    normalized.payload_secret_marker_findings === 0,
    'PAYLOAD_OR_SECRET_MARKER_FOUND',
    failedRequirements,
  );

  return {
    schema: NOTIFICATION_IMPORT_QUALIFICATION_SCHEMA,
    status: failedRequirements.length === 0 ? 'PASS' : 'FAIL',
    ...normalized,
    distinct_non_replay_accepted: distinctKeys.size,
    repositories,
    vendor_ids: vendorIds,
    maximum_convergence_seconds: maximumConvergenceSeconds,
    failed_requirements: failedRequirements,
    does_not_claim: [
      'G5_CANARY_PASS',
      'LIVE_VERIFIED',
      'IB7_CUTOVER',
      'OPENSLACK_0_3_0',
      'PRODUCTION_READY',
    ],
  };
}

export function ensureNotificationImportQualificationReport(
  rootPath: string,
  report: NotificationImportQualificationReport,
): NotificationImportQualificationWriteResult {
  const root = ensureSecureNotificationDirectory(rootPath);
  const canonical = validateAndOrderReport(report);
  const bytes = Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const reportPath = join(root, 'qualification-report.json');
  const checksumPath = join(root, 'qualification-report.sha256');
  const reportCreated = publishCreateOnly(root, reportPath, bytes);
  const checksumCreated = publishCreateOnly(
    root,
    checksumPath,
    Buffer.from(`${digest}  qualification-report.json\n`, 'utf8'),
  );
  return {
    reportPath,
    checksumPath,
    sha256: `sha256:${digest}`,
    created: reportCreated || checksumCreated,
  };
}

export function readNotificationImportQualificationReport(
  rootPath: string,
): NotificationImportQualificationReport | null {
  const root = ensureSecureNotificationDirectory(rootPath);
  const reportPath = join(root, 'qualification-report.json');
  if (!existsSync(reportPath)) return null;
  const status = lstatSync(reportPath, { bigint: true });
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.size <= 0 ||
    status.size > BigInt(1024 * 1024) ||
    (process.platform !== 'win32' && (Number(status.mode) & 0o777) !== 0o600)
  ) {
    throw new Error('QUALIFICATION_REPORT_FILE_UNSAFE');
  }
  const descriptor = openSync(reportPath, 'r');
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== status.dev ||
      before.ino !== status.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs
    ) {
      throw new Error('QUALIFICATION_REPORT_READ_RACE');
    }
    let parsed: unknown;
    try {
      const text = bytes.toString('utf8');
      assertNoDuplicateJsonKeys(text);
      parsed = JSON.parse(text);
    } catch {
      throw new Error('QUALIFICATION_REPORT_INVALID');
    }
    const report = validateAndOrderReport(parsed);
    const canonicalBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (!bytes.equals(canonicalBytes)) throw new Error('QUALIFICATION_REPORT_INVALID');
    const digest = createHash('sha256').update(bytes).digest('hex');
    verifyPublished(
      join(root, 'qualification-report.sha256'),
      Buffer.from(`${digest}  qualification-report.json\n`, 'utf8'),
    );
    return report;
  } finally {
    closeSync(descriptor);
  }
}

function validateAndOrderInput(
  value: NotificationImportQualificationInput,
): NotificationImportQualificationInput {
  const keys = [
    'correlation_id',
    'started_at',
    'completed_at',
    'openslack_commit',
    'openslack_tree',
    'service_commit',
    'service_tree',
    'service_deployment_digest',
    'watch_config_digest',
    'routes',
    'vendor_configs',
    'caller_scope',
    'auditor_scope',
    'observations',
    'drills',
    'caller_read_ops_denied',
    'auditor_submit_denied',
    'final_pending',
    'final_dead',
    'final_unexplained_conflicts',
    'final_authority_fallbacks',
    'unexplained_vendor_duplicates',
    'explained_vendor_duplicates',
    'response_loss_replay_same_key',
    'response_loss_replay_same_notification_id',
    'response_loss_vendor_duplicates',
    'explained_duplicates_same_key_and_body_digest',
    'external_timeout_count',
    'payload_secret_marker_findings',
    'receipt_reconciliation_sha256',
    'security_review_sha256',
  ] as const;
  if (
    !isRecord(value) ||
    !hasExactKeys(value, keys) ||
    !isBounded(value.correlation_id, 128) ||
    !isTimestamp(value.started_at) ||
    !isTimestamp(value.completed_at) ||
    Date.parse(value.completed_at) < Date.parse(value.started_at) ||
    !isGitObjectId(value.openslack_commit) ||
    !isGitObjectId(value.openslack_tree) ||
    !isGitObjectId(value.service_commit) ||
    !isGitObjectId(value.service_tree) ||
    !isDigest(value.service_deployment_digest) ||
    !isDigest(value.watch_config_digest) ||
    !Array.isArray(value.routes) ||
    !Array.isArray(value.vendor_configs) ||
    !Array.isArray(value.observations) ||
    !Array.isArray(value.drills) ||
    typeof value.caller_read_ops_denied !== 'boolean' ||
    typeof value.auditor_submit_denied !== 'boolean' ||
    !isCount(value.final_pending) ||
    !isCount(value.final_dead) ||
    !isCount(value.final_unexplained_conflicts) ||
    !isCount(value.final_authority_fallbacks) ||
    !isCount(value.unexplained_vendor_duplicates) ||
    !isCount(value.explained_vendor_duplicates) ||
    typeof value.response_loss_replay_same_key !== 'boolean' ||
    typeof value.response_loss_replay_same_notification_id !== 'boolean' ||
    !isCount(value.response_loss_vendor_duplicates) ||
    typeof value.explained_duplicates_same_key_and_body_digest !== 'boolean' ||
    !isCount(value.external_timeout_count) ||
    !isCount(value.payload_secret_marker_findings) ||
    !isDigest(value.receipt_reconciliation_sha256) ||
    !isDigest(value.security_review_sha256)
  ) {
    throw new TypeError('Notification import qualification input is invalid.');
  }
  const routes = value.routes.map(validateRoute).sort(compareRoute);
  const vendorConfigs = value.vendor_configs
    .map(validateVendorConfig)
    .sort((left, right) => left.vendor_id.localeCompare(right.vendor_id));
  const observations = value.observations.map(validateObservation).sort(compareObservation);
  const drills = value.drills
    .map(validateDrill)
    .sort((left, right) => left.kind.localeCompare(right.kind));
  const callerScope = validatePrincipal(value.caller_scope);
  const auditorScope = validatePrincipal(value.auditor_scope);
  if (
    new Set(routes.map((route) => `${route.canonical_repository}\0${route.route_id}`)).size !==
      routes.length ||
    new Set(vendorConfigs.map((config) => config.vendor_id)).size !== vendorConfigs.length ||
    new Set(observations.map((observation) => observation.route_record_id)).size !==
      observations.length ||
    new Set(observations.map((observation) => observation.idempotency_key_sha256)).size !==
      observations.length ||
    new Set(drills.map((drill) => drill.kind)).size !== drills.length
  ) {
    throw new TypeError('Notification import qualification input contains duplicate identities.');
  }
  return {
    correlation_id: value.correlation_id,
    started_at: value.started_at,
    completed_at: value.completed_at,
    openslack_commit: value.openslack_commit,
    openslack_tree: value.openslack_tree,
    service_commit: value.service_commit,
    service_tree: value.service_tree,
    service_deployment_digest: value.service_deployment_digest,
    watch_config_digest: value.watch_config_digest,
    routes,
    vendor_configs: vendorConfigs,
    caller_scope: callerScope,
    auditor_scope: auditorScope,
    observations,
    drills,
    caller_read_ops_denied: value.caller_read_ops_denied,
    auditor_submit_denied: value.auditor_submit_denied,
    final_pending: value.final_pending,
    final_dead: value.final_dead,
    final_unexplained_conflicts: value.final_unexplained_conflicts,
    final_authority_fallbacks: value.final_authority_fallbacks,
    unexplained_vendor_duplicates: value.unexplained_vendor_duplicates,
    explained_vendor_duplicates: value.explained_vendor_duplicates,
    response_loss_replay_same_key: value.response_loss_replay_same_key,
    response_loss_replay_same_notification_id: value.response_loss_replay_same_notification_id,
    response_loss_vendor_duplicates: value.response_loss_vendor_duplicates,
    explained_duplicates_same_key_and_body_digest:
      value.explained_duplicates_same_key_and_body_digest,
    external_timeout_count: value.external_timeout_count,
    payload_secret_marker_findings: value.payload_secret_marker_findings,
    receipt_reconciliation_sha256: value.receipt_reconciliation_sha256,
    security_review_sha256: value.security_review_sha256,
  };
}

function validateAndOrderReport(value: unknown): NotificationImportQualificationReport {
  if (!isRecord(value)) throw new TypeError('Notification import qualification report is invalid.');
  const reportKeys = [
    'schema',
    'status',
    'correlation_id',
    'started_at',
    'completed_at',
    'openslack_commit',
    'openslack_tree',
    'service_commit',
    'service_tree',
    'service_deployment_digest',
    'watch_config_digest',
    'routes',
    'vendor_configs',
    'caller_scope',
    'auditor_scope',
    'observations',
    'drills',
    'caller_read_ops_denied',
    'auditor_submit_denied',
    'final_pending',
    'final_dead',
    'final_unexplained_conflicts',
    'final_authority_fallbacks',
    'unexplained_vendor_duplicates',
    'explained_vendor_duplicates',
    'response_loss_replay_same_key',
    'response_loss_replay_same_notification_id',
    'response_loss_vendor_duplicates',
    'explained_duplicates_same_key_and_body_digest',
    'external_timeout_count',
    'payload_secret_marker_findings',
    'receipt_reconciliation_sha256',
    'security_review_sha256',
    'distinct_non_replay_accepted',
    'repositories',
    'vendor_ids',
    'maximum_convergence_seconds',
    'failed_requirements',
    'does_not_claim',
  ] as const;
  if (
    !hasExactKeys(value, reportKeys) ||
    value.schema !== NOTIFICATION_IMPORT_QUALIFICATION_SCHEMA ||
    (value.status !== 'PASS' && value.status !== 'FAIL')
  ) {
    throw new TypeError('Notification import qualification report is invalid.');
  }
  const input = validateAndOrderInput({
    correlation_id: value.correlation_id,
    started_at: value.started_at,
    completed_at: value.completed_at,
    openslack_commit: value.openslack_commit,
    openslack_tree: value.openslack_tree,
    service_commit: value.service_commit,
    service_tree: value.service_tree,
    service_deployment_digest: value.service_deployment_digest,
    watch_config_digest: value.watch_config_digest,
    routes: value.routes,
    vendor_configs: value.vendor_configs,
    caller_scope: value.caller_scope,
    auditor_scope: value.auditor_scope,
    observations: value.observations,
    drills: value.drills,
    caller_read_ops_denied: value.caller_read_ops_denied,
    auditor_submit_denied: value.auditor_submit_denied,
    final_pending: value.final_pending,
    final_dead: value.final_dead,
    final_unexplained_conflicts: value.final_unexplained_conflicts,
    final_authority_fallbacks: value.final_authority_fallbacks,
    unexplained_vendor_duplicates: value.unexplained_vendor_duplicates,
    explained_vendor_duplicates: value.explained_vendor_duplicates,
    response_loss_replay_same_key: value.response_loss_replay_same_key,
    response_loss_replay_same_notification_id: value.response_loss_replay_same_notification_id,
    response_loss_vendor_duplicates: value.response_loss_vendor_duplicates,
    explained_duplicates_same_key_and_body_digest:
      value.explained_duplicates_same_key_and_body_digest,
    external_timeout_count: value.external_timeout_count,
    payload_secret_marker_findings: value.payload_secret_marker_findings,
    receipt_reconciliation_sha256: value.receipt_reconciliation_sha256,
    security_review_sha256: value.security_review_sha256,
  } as NotificationImportQualificationInput);
  const expected = createNotificationImportQualificationReport(input);
  if (JSON.stringify(expected) !== JSON.stringify(value)) {
    throw new TypeError('Notification import qualification report is inconsistent.');
  }
  return expected;
}

function validateRoute(value: unknown): NotificationImportQualificationRoute {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'canonical_repository',
      'route_id',
      'routing_epoch',
      'vendor_id',
      'encoder_version',
    ]) ||
    !REPOSITORY_PATTERN.test(String(value.canonical_repository)) ||
    String(value.canonical_repository) !== String(value.canonical_repository).toLowerCase() ||
    !ROUTE_PATTERN.test(String(value.route_id)) ||
    !Number.isSafeInteger(value.routing_epoch) ||
    Number(value.routing_epoch) <= 0 ||
    !VENDOR_PATTERN.test(String(value.vendor_id)) ||
    (value.encoder_version !== 'openslack.slack_chat_post_message.v1' &&
      value.encoder_version !== 'openslack.webhook_notification.v1')
  ) {
    throw new TypeError('Notification import qualification route is invalid.');
  }
  return {
    canonical_repository: String(value.canonical_repository),
    route_id: String(value.route_id),
    routing_epoch: Number(value.routing_epoch),
    vendor_id: String(value.vendor_id),
    encoder_version: value.encoder_version,
  };
}

function validateVendorConfig(value: unknown): NotificationImportQualificationVendorConfig {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['vendor_id', 'config_version']) ||
    !VENDOR_PATTERN.test(String(value.vendor_id)) ||
    !Number.isSafeInteger(value.config_version) ||
    Number(value.config_version) <= 0
  ) {
    throw new TypeError('Notification import qualification vendor config is invalid.');
  }
  return { vendor_id: String(value.vendor_id), config_version: Number(value.config_version) };
}

function validatePrincipal(value: unknown): NotificationImportQualificationPrincipalScope {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['principal_id', 'capabilities', 'vendor_ids']) ||
    !SAFE_ID_PATTERN.test(String(value.principal_id)) ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length !== 1 ||
    (value.capabilities[0] !== 'submit_notification' &&
      value.capabilities[0] !== 'read_notifications') ||
    !Array.isArray(value.vendor_ids) ||
    value.vendor_ids.length !== 2 ||
    value.vendor_ids.some((vendor) => !VENDOR_PATTERN.test(String(vendor))) ||
    new Set(value.vendor_ids).size !== value.vendor_ids.length
  ) {
    throw new TypeError('Notification import qualification principal scope is invalid.');
  }
  return {
    principal_id: String(value.principal_id),
    capabilities: [value.capabilities[0]],
    vendor_ids: uniqueSorted(value.vendor_ids.map(String)),
  };
}

function validateObservation(value: unknown): NotificationImportQualificationObservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'route_record_id',
      'notification_id',
      'idempotency_key_sha256',
      'canonical_repository',
      'event_kind',
      'vendor_id',
      'accepted_at',
      'delivered_at',
      'idempotent_replay',
      'reconciliation',
    ]) ||
    !/^[0-9a-f]{64}$/u.test(String(value.route_record_id)) ||
    !SAFE_ID_PATTERN.test(String(value.notification_id)) ||
    !isDigest(value.idempotency_key_sha256) ||
    !REPOSITORY_PATTERN.test(String(value.canonical_repository)) ||
    String(value.canonical_repository) !== String(value.canonical_repository).toLowerCase() ||
    (value.event_kind !== 'issue' && value.event_kind !== 'push') ||
    !VENDOR_PATTERN.test(String(value.vendor_id)) ||
    !isTimestamp(value.accepted_at) ||
    !isTimestamp(value.delivered_at) ||
    Date.parse(String(value.delivered_at)) < Date.parse(String(value.accepted_at)) ||
    value.idempotent_replay !== false ||
    value.reconciliation !== 'consistent'
  ) {
    throw new TypeError('Notification import qualification observation is invalid.');
  }
  return {
    route_record_id: String(value.route_record_id),
    notification_id: String(value.notification_id),
    idempotency_key_sha256: value.idempotency_key_sha256,
    canonical_repository: String(value.canonical_repository),
    event_kind: value.event_kind,
    vendor_id: String(value.vendor_id),
    accepted_at: String(value.accepted_at),
    delivered_at: String(value.delivered_at),
    idempotent_replay: false,
    reconciliation: 'consistent',
  };
}

function validateDrill(value: unknown): NotificationImportQualificationDrill {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'status', 'evidence_sha256']) ||
    !NOTIFICATION_IMPORT_QUALIFICATION_REQUIRED_DRILLS.includes(
      value.kind as NotificationImportQualificationDrillKind,
    ) ||
    (value.status !== 'PASS' && value.status !== 'FAIL') ||
    !isDigest(value.evidence_sha256)
  ) {
    throw new TypeError('Notification import qualification drill is invalid.');
  }
  return {
    kind: value.kind as NotificationImportQualificationDrillKind,
    status: value.status,
    evidence_sha256: value.evidence_sha256,
  };
}

function coversEventMatrix(
  observations: NotificationImportQualificationObservation[],
  repositories: string[],
  vendorIds: string[],
): boolean {
  if (repositories.length !== 2 || vendorIds.length !== 2) return false;
  const observed = new Set(
    observations.map(
      (observation) =>
        `${observation.canonical_repository}\0${observation.event_kind}\0${observation.vendor_id}`,
    ),
  );
  return repositories.every((repository) =>
    vendorIds.every((vendorId) =>
      (['issue', 'push'] as const).every((kind) =>
        observed.has(`${repository}\0${kind}\0${vendorId}`),
      ),
    ),
  );
}

function coversFrozenRoutes(
  routes: NotificationImportQualificationRoute[],
  repositories: string[],
  vendorIds: string[],
): boolean {
  if (routes.length !== repositories.length * vendorIds.length) return false;
  const identities = new Set(
    routes.map((route) => `${route.canonical_repository}\0${route.vendor_id}`),
  );
  return repositories.every((repository) =>
    vendorIds.every((vendorId) => identities.has(`${repository}\0${vendorId}`)),
  );
}

function coversVendorConfigs(
  configs: NotificationImportQualificationVendorConfig[],
  vendorIds: string[],
): boolean {
  return (
    configs.length === vendorIds.length &&
    vendorIds.every((vendorId) => configs.some((config) => config.vendor_id === vendorId))
  );
}

function coversRequiredDrills(drills: NotificationImportQualificationDrill[]): boolean {
  return (
    drills.length === NOTIFICATION_IMPORT_QUALIFICATION_REQUIRED_DRILLS.length &&
    NOTIFICATION_IMPORT_QUALIFICATION_REQUIRED_DRILLS.every((kind) =>
      drills.some((drill) => drill.kind === kind && drill.status === 'PASS'),
    )
  );
}

function hasExactPrincipalScope(
  scope: NotificationImportQualificationPrincipalScope,
  capability: 'submit_notification' | 'read_notifications',
  vendorIds: string[],
): boolean {
  return (
    scope.capabilities.length === 1 &&
    scope.capabilities[0] === capability &&
    JSON.stringify(scope.vendor_ids) === JSON.stringify(vendorIds)
  );
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

function compareObservation(
  left: NotificationImportQualificationObservation,
  right: NotificationImportQualificationObservation,
): number {
  return (
    left.canonical_repository.localeCompare(right.canonical_repository) ||
    left.event_kind.localeCompare(right.event_kind) ||
    left.vendor_id.localeCompare(right.vendor_id) ||
    left.route_record_id.localeCompare(right.route_record_id)
  );
}

function requireCondition(condition: boolean, code: string, failures: string[]): void {
  if (!condition) failures.push(code);
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
  const status = lstatSync(path, { bigint: true });
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    (process.platform !== 'win32' && (Number(status.mode) & 0o777) !== 0o600)
  ) {
    throw new Error('QUALIFICATION_REPORT_FILE_UNSAFE');
  }
  if (status.size !== BigInt(expected.length)) throw new Error('QUALIFICATION_REPORT_CONFLICT');
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const actual = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== status.dev ||
      before.ino !== status.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      !actual.equals(expected)
    ) {
      throw new Error('QUALIFICATION_REPORT_CONFLICT');
    }
  } finally {
    closeSync(descriptor);
  }
}

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

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
