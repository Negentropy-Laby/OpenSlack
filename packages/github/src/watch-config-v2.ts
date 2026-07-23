/** Closed v2 GitHub Watch configuration loaded only when its schema is explicitly selected. */
import { parseSecretReference } from '@openslack/credentials';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import {
  GITHUB_WATCH_EVENT_KEYS,
  canonicalizeRepositoryName,
  isGitHubWatchEventKey,
  type GitHubWatchEventKey,
} from './repository-event.js';
import {
  isNotificationDeploymentDigest,
  isNotificationHandoffRouteId,
  isNotificationHandoffVendorId,
  type NotificationHandoffIdempotencyKey,
  type NotificationDeliveryBackend,
  type NotificationRouteRecordId,
} from './notification-handoff-contracts.js';
import { normalizeNotificationServiceOrigin } from './notification-service-endpoint.js';

/**
 * Read-only identity for a future v2 queue record. These fields are derived after config parsing
 * and are deliberately absent from the user-authored watch schema and parser result.
 */
export interface GitHubWatchRouteRecordIdentityV2 {
  readonly route_record_id: NotificationRouteRecordId;
  readonly canonical_repository: string;
  readonly persisted_idempotency_key: NotificationHandoffIdempotencyKey;
}

export interface GitHubWatchNotificationServiceV2 {
  endpoint: string;
  credential_ref: string;
  expected_deployment_digest: `sha256:${string}`;
  allow_insecure_loopback?: boolean;
}

export interface GitHubWatchRouteDeliveryV2 {
  backend: NotificationDeliveryBackend;
  routing_epoch: number;
  vendor_id?: string;
}

export interface GitHubWatchRouteV2 {
  id: string;
  sink: 'console' | 'slack' | 'webhook';
  channel?: string;
  name?: string;
  delivery: GitHubWatchRouteDeliveryV2;
}

export interface GitHubWatchRepoV2 {
  owner: string;
  repo: string;
  events: GitHubWatchEventKey[];
  labels?: { include?: string[]; exclude?: string[] };
  routes?: GitHubWatchRouteV2[];
  auto_claim?: { enabled: boolean; agent_ids?: string[] };
}

export interface GitHubWatchConfigV2 {
  schema: 'openslack.github_watch.v2';
  notification_service?: GitHubWatchNotificationServiceV2;
  repositories: GitHubWatchRepoV2[];
}

export interface WatchConfigV2ParseResult {
  valid: boolean;
  config?: GitHubWatchConfigV2;
  errors: string[];
}

const ROOT_KEYS = new Set(['schema', 'notification_service', 'repositories']);
const SERVICE_KEYS = new Set([
  'endpoint',
  'credential_ref',
  'expected_deployment_digest',
  'allow_insecure_loopback',
]);
const REPOSITORY_KEYS = new Set(['owner', 'repo', 'events', 'labels', 'routes', 'auto_claim']);
const LABEL_KEYS = new Set(['include', 'exclude']);
const ROUTE_KEYS = new Set(['id', 'sink', 'channel', 'name', 'delivery']);
const DELIVERY_KEYS = new Set(['backend', 'routing_epoch', 'vendor_id']);
const AUTO_CLAIM_KEYS = new Set(['enabled', 'agent_ids']);
const VALID_SINKS = new Set(['console', 'slack', 'webhook']);
const VALID_BACKENDS = new Set<NotificationDeliveryBackend>([
  'local',
  'direct',
  'notification_service',
]);

export function parseGitHubWatchConfigV2(yaml: string): WatchConfigV2ParseResult {
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch (error) {
    return { valid: false, errors: [`YAML parse error: ${(error as Error).message}`] };
  }

  if (!isRecord(parsed)) {
    return { valid: false, errors: ['Parsed YAML is not an object'] };
  }

  const errors: string[] = [];
  rejectUnknownKeys(parsed, ROOT_KEYS, 'config', errors);
  if (parsed.schema !== 'openslack.github_watch.v2') {
    errors.push(`Invalid schema: "${String(parsed.schema)}". Expected "openslack.github_watch.v2"`);
  }

  const notificationService = parseNotificationService(parsed.notification_service, errors);
  if (!Array.isArray(parsed.repositories) || parsed.repositories.length === 0) {
    errors.push('repositories must be a non-empty array');
    return { valid: false, errors };
  }

  const repositories: GitHubWatchRepoV2[] = [];
  const repositoryKeys = new Set<string>();
  let hasNotificationServiceRoute = false;

  for (let index = 0; index < parsed.repositories.length; index += 1) {
    const path = `repositories[${index}]`;
    const value = parsed.repositories[index];
    if (!isRecord(value)) {
      errors.push(`${path}: must be an object`);
      continue;
    }
    rejectUnknownKeys(value, REPOSITORY_KEYS, path, errors);

    const owner = readRequiredTrimmedString(value.owner, `${path}.owner`, errors);
    const repo = readRequiredTrimmedString(value.repo, `${path}.repo`, errors);
    const repository = owner && repo ? canonicalizeRepositoryName(owner, repo) : null;
    if (owner && repo && !repository) {
      errors.push(`${path}: owner/repo must be valid GitHub repository name segments`);
    } else if (repository) {
      if (repositoryKeys.has(repository.canonicalFullName)) {
        errors.push(`${path}: duplicate repository "${repository.fullName}"`);
      }
      repositoryKeys.add(repository.canonicalFullName);
    }

    const events = parseEvents(value.events, path, errors);
    const labels = parseLabels(value.labels, path, errors);
    const routes = parseRoutes(value.routes, path, errors);
    const autoClaim = parseAutoClaim(value.auto_claim, path, errors);
    if (routes.some((route) => route.delivery.backend === 'notification_service')) {
      hasNotificationServiceRoute = true;
    }

    repositories.push({
      owner: repository?.owner ?? owner ?? '',
      repo: repository?.repo ?? repo ?? '',
      events,
      ...(labels ? { labels } : {}),
      ...(routes.length > 0 ? { routes } : {}),
      ...(autoClaim ? { auto_claim: autoClaim } : {}),
    });
  }

  if (hasNotificationServiceRoute && !notificationService) {
    errors.push('notification_service is required when any route uses notification_service');
  }
  if (errors.length > 0) return { valid: false, errors };

  return {
    valid: true,
    config: {
      schema: 'openslack.github_watch.v2',
      ...(notificationService ? { notification_service: notificationService } : {}),
      repositories,
    },
    errors: [],
  };
}

export function loadGitHubWatchConfigV2(path: string): WatchConfigV2ParseResult {
  try {
    return parseGitHubWatchConfigV2(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      valid: false,
      errors: [`Failed to read config: ${(error as Error).message}`],
    };
  }
}

function parseNotificationService(
  value: unknown,
  errors: string[],
): GitHubWatchNotificationServiceV2 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push('notification_service must be an object');
    return undefined;
  }
  rejectUnknownKeys(value, SERVICE_KEYS, 'notification_service', errors);

  const endpoint = readRequiredTrimmedString(
    value.endpoint,
    'notification_service.endpoint',
    errors,
  );
  const credentialReference = readRequiredTrimmedString(
    value.credential_ref,
    'notification_service.credential_ref',
    errors,
  );
  const deploymentDigest = readRequiredTrimmedString(
    value.expected_deployment_digest,
    'notification_service.expected_deployment_digest',
    errors,
  );
  if (
    value.allow_insecure_loopback !== undefined &&
    typeof value.allow_insecure_loopback !== 'boolean'
  ) {
    errors.push('notification_service.allow_insecure_loopback must be a boolean');
  }
  const allowInsecureLoopback = value.allow_insecure_loopback === true;

  let normalizedEndpoint: string | undefined;
  if (endpoint) {
    try {
      normalizedEndpoint = normalizeNotificationServiceOrigin(endpoint, {
        allowInsecureLoopback,
      });
    } catch {
      errors.push(
        'notification_service.endpoint must be an HTTPS origin without userinfo, path, query or fragment; HTTP requires explicit literal-loopback development policy',
      );
    }
  }

  let normalizedCredentialReference: string | undefined;
  if (credentialReference) {
    try {
      normalizedCredentialReference = parseSecretReference(credentialReference).canonical;
    } catch {
      errors.push(
        'notification_service.credential_ref must be a valid env: or keychain: reference',
      );
    }
  }

  if (deploymentDigest && !isNotificationDeploymentDigest(deploymentDigest)) {
    errors.push(
      'notification_service.expected_deployment_digest must be sha256:<64 lowercase hex>',
    );
  }

  if (
    !normalizedEndpoint ||
    !normalizedCredentialReference ||
    !isNotificationDeploymentDigest(deploymentDigest)
  ) {
    return undefined;
  }
  return {
    endpoint: normalizedEndpoint,
    credential_ref: normalizedCredentialReference,
    expected_deployment_digest: deploymentDigest,
    ...(allowInsecureLoopback ? { allow_insecure_loopback: true } : {}),
  };
}

function parseEvents(value: unknown, path: string, errors: string[]): GitHubWatchEventKey[] {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path}.events must be a non-empty array`);
    return [];
  }
  const events: GitHubWatchEventKey[] = [];
  const seen = new Set<string>();
  for (const event of value) {
    if (!isGitHubWatchEventKey(event)) {
      errors.push(
        `${path}.events: invalid event "${String(event)}". Must be one of: ${GITHUB_WATCH_EVENT_KEYS.join(', ')}`,
      );
      continue;
    }
    if (seen.has(event)) {
      errors.push(`${path}.events: duplicate event "${event}"`);
      continue;
    }
    seen.add(event);
    events.push(event);
  }
  return events;
}

function parseLabels(
  value: unknown,
  path: string,
  errors: string[],
): GitHubWatchRepoV2['labels'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push(`${path}.labels must be an object`);
    return undefined;
  }
  rejectUnknownKeys(value, LABEL_KEYS, `${path}.labels`, errors);
  const include = readOptionalStringArray(value.include, `${path}.labels.include`, errors);
  const exclude = readOptionalStringArray(value.exclude, `${path}.labels.exclude`, errors);
  return {
    ...(include ? { include } : {}),
    ...(exclude ? { exclude } : {}),
  };
}

function parseRoutes(value: unknown, path: string, errors: string[]): GitHubWatchRouteV2[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path}.routes must be an array`);
    return [];
  }

  const routes: GitHubWatchRouteV2[] = [];
  const routeIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const routePath = `${path}.routes[${index}]`;
    const routeValue = value[index];
    if (!isRecord(routeValue)) {
      errors.push(`${routePath} must be an object`);
      continue;
    }
    rejectUnknownKeys(routeValue, ROUTE_KEYS, routePath, errors);

    const id = readRequiredTrimmedString(routeValue.id, `${routePath}.id`, errors);
    if (id && !isNotificationHandoffRouteId(id)) {
      errors.push(`${routePath}.id must match the notification handoff v2 route ID contract`);
    } else if (id) {
      if (routeIds.has(id)) errors.push(`${routePath}.id duplicates route ID "${id}"`);
      routeIds.add(id);
    }

    const sink = typeof routeValue.sink === 'string' ? routeValue.sink : '';
    if (!VALID_SINKS.has(sink)) {
      errors.push(`${routePath}.sink must be console, slack or webhook`);
    }
    const channel = readOptionalTrimmedString(routeValue.channel, `${routePath}.channel`, errors);
    const name = readOptionalTrimmedString(routeValue.name, `${routePath}.name`, errors);
    const delivery = parseDelivery(routeValue.delivery, routePath, errors);

    if (sink === 'console') {
      if (channel !== undefined) errors.push(`${routePath}.channel is not valid for console`);
      if (delivery && delivery.backend !== 'local') {
        errors.push(`${routePath}: console routes must use backend local`);
      }
    }
    if (sink === 'slack' && channel === undefined) {
      errors.push(`${routePath}.channel is required for slack`);
    }
    if (sink === 'webhook' && channel !== undefined) {
      errors.push(`${routePath}.channel is not valid for webhook`);
    }
    if ((sink === 'slack' || sink === 'webhook') && delivery?.backend === 'local') {
      errors.push(`${routePath}: external routes cannot use backend local`);
    }
    if (sink === 'console' && delivery?.vendor_id !== undefined) {
      errors.push(`${routePath}: console routes cannot define vendor_id`);
    }

    if (id && isNotificationHandoffRouteId(id) && VALID_SINKS.has(sink) && delivery) {
      routes.push({
        id,
        sink: sink as GitHubWatchRouteV2['sink'],
        ...(channel ? { channel } : {}),
        ...(name ? { name } : {}),
        delivery,
      });
    }
  }
  return routes;
}

function parseDelivery(
  value: unknown,
  routePath: string,
  errors: string[],
): GitHubWatchRouteDeliveryV2 | undefined {
  if (!isRecord(value)) {
    errors.push(`${routePath}.delivery must be an object`);
    return undefined;
  }
  rejectUnknownKeys(value, DELIVERY_KEYS, `${routePath}.delivery`, errors);

  const backend = typeof value.backend === 'string' ? value.backend : '';
  if (!VALID_BACKENDS.has(backend as NotificationDeliveryBackend)) {
    errors.push(`${routePath}.delivery.backend must be local, direct or notification_service`);
  }
  const routingEpoch = value.routing_epoch;
  if (!Number.isSafeInteger(routingEpoch) || (routingEpoch as number) <= 0) {
    errors.push(`${routePath}.delivery.routing_epoch must be a positive safe integer`);
  }
  const vendorId = readOptionalTrimmedString(
    value.vendor_id,
    `${routePath}.delivery.vendor_id`,
    errors,
  );

  if (backend === 'notification_service') {
    if (!vendorId) {
      errors.push(`${routePath}.delivery.vendor_id is required for notification_service`);
    } else if (!isNotificationHandoffVendorId(vendorId)) {
      errors.push(`${routePath}.delivery.vendor_id must match ^[a-z0-9-]{1,64}$`);
    }
  } else if (vendorId !== undefined) {
    errors.push(`${routePath}.delivery.vendor_id is only valid for notification_service`);
  }

  if (
    !VALID_BACKENDS.has(backend as NotificationDeliveryBackend) ||
    !Number.isSafeInteger(routingEpoch) ||
    (routingEpoch as number) <= 0 ||
    (backend === 'notification_service' && !isNotificationHandoffVendorId(vendorId))
  ) {
    return undefined;
  }
  return {
    backend: backend as NotificationDeliveryBackend,
    routing_epoch: routingEpoch as number,
    ...(vendorId ? { vendor_id: vendorId } : {}),
  };
}

function parseAutoClaim(
  value: unknown,
  path: string,
  errors: string[],
): GitHubWatchRepoV2['auto_claim'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push(`${path}.auto_claim must be an object`);
    return undefined;
  }
  rejectUnknownKeys(value, AUTO_CLAIM_KEYS, `${path}.auto_claim`, errors);
  if (typeof value.enabled !== 'boolean') {
    errors.push(`${path}.auto_claim.enabled must be a boolean`);
  }
  const agentIds = readOptionalStringArray(value.agent_ids, `${path}.auto_claim.agent_ids`, errors);
  if (typeof value.enabled !== 'boolean') return undefined;
  return {
    enabled: value.enabled,
    ...(agentIds ? { agent_ids: agentIds } : {}),
  };
}

function readRequiredTrimmedString(
  value: unknown,
  path: string,
  errors: string[],
): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(`${path} must be a non-empty string`);
    return undefined;
  }
  if (value !== value.trim()) {
    errors.push(`${path} must not contain leading or trailing whitespace`);
    return undefined;
  }
  return value;
}

function readOptionalTrimmedString(
  value: unknown,
  path: string,
  errors: string[],
): string | undefined {
  if (value === undefined) return undefined;
  return readRequiredTrimmedString(value, path, errors);
}

function readOptionalStringArray(
  value: unknown,
  path: string,
  errors: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array of strings`);
    return undefined;
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim() || entry !== entry.trim()) {
      errors.push(`${path} must contain only non-empty trimmed strings`);
      continue;
    }
    if (seen.has(entry)) {
      errors.push(`${path} must not contain duplicate values`);
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}: unknown property "${key}"`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
