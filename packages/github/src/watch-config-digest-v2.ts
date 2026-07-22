import { createHash } from 'node:crypto';
import { parseSecretReference } from '@openslack/credentials';
import {
  isNotificationDeploymentDigest,
  isNotificationHandoffRouteId,
  isNotificationHandoffVendorId,
} from './notification-handoff-contracts.js';
import { normalizeNotificationServiceOrigin } from './notification-service-endpoint.js';
import { canonicalizeRepositoryName, isGitHubWatchEventKey } from './repository-event.js';
import type {
  GitHubWatchConfigV2,
  GitHubWatchRepoV2,
  GitHubWatchRouteV2,
} from './watch-config-v2.js';

const MAX_JCS_DEPTH = 64;
const MAX_JCS_KEYS = 20_000;

export interface NormalizedGitHubWatchConfigV2 {
  schema: 'openslack.github_watch.v2';
  notification_service?: {
    endpoint_origin: string;
    credential_ref: string;
    expected_deployment_digest: `sha256:${string}`;
    allow_insecure_loopback: boolean;
  };
  repositories: Array<{
    repository: string;
    events: string[];
    labels?: { include?: string[]; exclude?: string[] };
    routes?: Array<{
      id: string;
      sink: GitHubWatchRouteV2['sink'];
      target: { channel?: string; name?: string };
      delivery: {
        backend: GitHubWatchRouteV2['delivery']['backend'];
        routing_epoch: number;
        vendor_id?: string;
      };
    }>;
    auto_claim?: { enabled: boolean; agent_ids?: string[] };
  }>;
}

export function computeGitHubWatchConfigDigestV2(config: GitHubWatchConfigV2): `sha256:${string}` {
  const normalized = normalizeGitHubWatchConfigV2(config);
  return `sha256:${createHash('sha256').update(canonicalizeJcs(normalized), 'utf8').digest('hex')}`;
}

/**
 * Rebuilds the secret-free semantic config before JCS. YAML comments and object/array ordering
 * are not inputs; set-like arrays use frozen UTF-16 code-unit ordering.
 */
export function normalizeGitHubWatchConfigV2(
  config: GitHubWatchConfigV2,
): NormalizedGitHubWatchConfigV2 {
  if (config.schema !== 'openslack.github_watch.v2' || !Array.isArray(config.repositories)) {
    throw invalidConfig();
  }

  const repositories = config.repositories.map(normalizeRepository);
  repositories.sort((left, right) => utf16Compare(left.repository, right.repository));
  if (repositories.length === 0 || hasDuplicate(repositories.map((item) => item.repository))) {
    throw invalidConfig();
  }

  const hasServiceRoute = repositories.some((repository) =>
    repository.routes?.some((route) => route.delivery.backend === 'notification_service'),
  );
  let notificationService: NormalizedGitHubWatchConfigV2['notification_service'];
  if (config.notification_service) {
    const expectedDigest = config.notification_service.expected_deployment_digest;
    if (!isNotificationDeploymentDigest(expectedDigest)) throw invalidConfig();
    let endpointOrigin: string;
    let credentialReference: string;
    try {
      endpointOrigin = normalizeNotificationServiceOrigin(config.notification_service.endpoint, {
        allowInsecureLoopback: config.notification_service.allow_insecure_loopback,
      });
      credentialReference = parseSecretReference(
        config.notification_service.credential_ref,
      ).canonical;
    } catch {
      throw invalidConfig();
    }
    notificationService = {
      endpoint_origin: endpointOrigin,
      credential_ref: credentialReference,
      expected_deployment_digest: expectedDigest,
      allow_insecure_loopback: config.notification_service.allow_insecure_loopback === true,
    };
  }
  if (hasServiceRoute && !notificationService) throw invalidConfig();

  return {
    schema: 'openslack.github_watch.v2',
    ...(notificationService ? { notification_service: notificationService } : {}),
    repositories,
  };
}

/** RFC 8785 JSON Canonicalization Scheme serialization for already parsed JSON data. */
export function canonicalizeJcs(value: unknown): string {
  let keyCount = 0;
  return encode(value, 0);

  function encode(item: unknown, depth: number): string {
    if (depth > MAX_JCS_DEPTH) throw new TypeError('JCS input exceeds the depth limit.');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') {
      assertUnicodeScalarString(item);
      return JSON.stringify(item);
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TypeError('JCS rejects non-finite numbers.');
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      const ownKeys = Object.keys(item);
      if (ownKeys.length !== item.length || ownKeys.some((key, index) => key !== String(index))) {
        throw new TypeError('JCS rejects sparse or extended arrays.');
      }
      return `[${item.map((entry) => encode(entry, depth + 1)).join(',')}]`;
    }
    if (item === null || typeof item !== 'object') {
      throw new TypeError(`JCS rejects ${typeof item}.`);
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('JCS rejects non-JSON objects.');
    }
    if (Object.getOwnPropertySymbols(item).length > 0) {
      throw new TypeError('JCS rejects symbol properties.');
    }
    const record = item as Record<string, unknown>;
    const names = Object.keys(record).sort(utf16Compare);
    if (Object.getOwnPropertyNames(record).length !== names.length) {
      throw new TypeError('JCS rejects non-enumerable properties.');
    }
    keyCount += names.length;
    if (keyCount > MAX_JCS_KEYS) throw new TypeError('JCS input exceeds the key limit.');
    return `{${names
      .map((name) => {
        assertUnicodeScalarString(name);
        const descriptor = Object.getOwnPropertyDescriptor(record, name);
        if (!descriptor || !('value' in descriptor)) {
          throw new TypeError('JCS rejects accessor properties.');
        }
        return `${JSON.stringify(name)}:${encode(descriptor.value, depth + 1)}`;
      })
      .join(',')}}`;
  }
}

function normalizeRepository(
  repository: GitHubWatchRepoV2,
): NormalizedGitHubWatchConfigV2['repositories'][number] {
  const identity = canonicalizeRepositoryName(repository.owner, repository.repo);
  if (!identity) throw invalidConfig();
  const events = sortedUniqueStrings(repository.events, (event) => isGitHubWatchEventKey(event));
  if (events.length === 0) throw invalidConfig();

  const include = sortedOptionalStrings(repository.labels?.include);
  const exclude = sortedOptionalStrings(repository.labels?.exclude);
  const labels =
    include || exclude
      ? { ...(include ? { include } : {}), ...(exclude ? { exclude } : {}) }
      : undefined;

  const routes = repository.routes?.map(normalizeRoute);
  routes?.sort((left, right) => utf16Compare(left.id, right.id));
  if (routes && hasDuplicate(routes.map((route) => route.id))) throw invalidConfig();

  if (repository.auto_claim && typeof repository.auto_claim.enabled !== 'boolean') {
    throw invalidConfig();
  }
  const agentIds = sortedOptionalStrings(repository.auto_claim?.agent_ids);
  return {
    repository: identity.canonicalFullName,
    events,
    ...(labels ? { labels } : {}),
    ...(routes && routes.length > 0 ? { routes } : {}),
    ...(repository.auto_claim
      ? {
          auto_claim: {
            enabled: repository.auto_claim.enabled,
            ...(agentIds ? { agent_ids: agentIds } : {}),
          },
        }
      : {}),
  };
}

function normalizeRoute(
  route: GitHubWatchRouteV2,
): NonNullable<NormalizedGitHubWatchConfigV2['repositories'][number]['routes']>[number] {
  if (
    !isNotificationHandoffRouteId(route.id) ||
    !['console', 'slack', 'webhook'].includes(route.sink) ||
    !['local', 'direct', 'notification_service'].includes(route.delivery.backend) ||
    !Number.isSafeInteger(route.delivery.routing_epoch) ||
    route.delivery.routing_epoch <= 0
  ) {
    throw invalidConfig();
  }
  const channel = optionalTrimmedString(route.channel);
  const name = optionalTrimmedString(route.name);
  if (
    (route.sink === 'slack' && !channel) ||
    (route.sink !== 'slack' && channel !== undefined) ||
    (route.sink === 'console' && route.delivery.backend !== 'local') ||
    (route.sink !== 'console' && route.delivery.backend === 'local')
  ) {
    throw invalidConfig();
  }
  const vendorId = route.delivery.vendor_id;
  if (
    (route.delivery.backend === 'notification_service' &&
      !isNotificationHandoffVendorId(vendorId)) ||
    (route.delivery.backend !== 'notification_service' && vendorId !== undefined)
  ) {
    throw invalidConfig();
  }
  return {
    id: route.id,
    sink: route.sink,
    target: { ...(channel ? { channel } : {}), ...(name ? { name } : {}) },
    delivery: {
      backend: route.delivery.backend,
      routing_epoch: route.delivery.routing_epoch,
      ...(vendorId ? { vendor_id: vendorId } : {}),
    },
  };
}

function sortedUniqueStrings(
  values: readonly string[],
  predicate: (value: string) => boolean = () => true,
): string[] {
  if (!Array.isArray(values)) throw invalidConfig();
  const result = values.map((value) => {
    if (typeof value !== 'string' || value !== value.trim() || !value || !predicate(value)) {
      throw invalidConfig();
    }
    assertUnicodeScalarString(value);
    return value;
  });
  if (hasDuplicate(result)) throw invalidConfig();
  return result.sort(utf16Compare);
}

function sortedOptionalStrings(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined || values.length === 0) return undefined;
  return sortedUniqueStrings(values);
}

function optionalTrimmedString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value !== value.trim()) throw invalidConfig();
  assertUnicodeScalarString(value);
  return value;
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function utf16Compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('JCS rejects lone surrogate code points.');
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('JCS rejects lone surrogate code points.');
    }
  }
}

function invalidConfig(): TypeError {
  return new TypeError('Watch config v2 is not valid for semantic digest normalization.');
}
