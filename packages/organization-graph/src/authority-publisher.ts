import {
  GRAPH_SHADOW_POLICY,
  GraphShadowHttpPublisher,
  type GraphShadowHttpPublisherOptions,
  type GraphShadowObservationOutcome,
} from './shadow.js';
import type {
  GraphSnapshotPublication,
  GraphSnapshotPublisherPort,
  PublishGraphSnapshotOptions,
} from './store.js';
import type { GraphSnapshot } from './types.js';

type GraphAuthorityFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const GRAPH_AUTHORITY_PUBLISH_POLICY = Object.freeze({
  maxRoutingEpoch: Number.MAX_SAFE_INTEGER,
  maxTenantCharacters: 512,
} as const);

export type GraphAuthorityPublishErrorCode =
  | 'GRAPH_AUTHORITY_POLICY_INVALID'
  | 'GRAPH_AUTHORITY_RECONCILIATION_REQUIRED'
  | 'GRAPH_AUTHORITY_CONFLICT'
  | 'GRAPH_AUTHORITY_HTTP_ERROR'
  | 'GRAPH_AUTHORITY_TRANSPORT_ERROR'
  | 'GRAPH_AUTHORITY_RECEIPT_INVALID';

export class GraphAuthorityPublishError extends Error {
  constructor(
    readonly code: GraphAuthorityPublishErrorCode,
    message: string,
    readonly reconciliationToken?: string,
  ) {
    super(message);
    this.name = 'GraphAuthorityPublishError';
  }
}

export interface GraphAuthorityHttpPublisherOptions {
  readonly origin: string;
  readonly networkMode?: 'loopback' | 'internal';
  readonly tenantId: string;
  readonly expectedTenantId: string;
  readonly routingEpoch: number;
  readonly expectedBuildSha: string;
  readonly timeoutMs?: number;
  readonly maxReceiptBytes?: number;
  readonly fetch?: GraphAuthorityFetch;
  readonly now?: () => number;
}

const BUILD_SHA = /^[0-9a-f]{64}$/u;

function policyIdentifier(value: string, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > GRAPH_AUTHORITY_PUBLISH_POLICY.maxTenantCharacters ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    throw new GraphAuthorityPublishError(
      'GRAPH_AUTHORITY_POLICY_INVALID',
      `${name} must be a canonical bounded identifier.`,
    );
  }
  return value;
}

function authorityPath(value: string): string {
  if (value === '/v1/graph/snapshots:ingest') {
    return '/v1/authority/graph/snapshots:ingest';
  }
  if (value === '/v1/graph/deltas:ingest') {
    return '/v1/authority/graph/deltas:ingest';
  }
  throw new GraphAuthorityPublishError(
    'GRAPH_AUTHORITY_POLICY_INVALID',
    'Graph authority publisher received an unregistered ingest route.',
  );
}

function mapOutcome(outcome: GraphShadowObservationOutcome): GraphAuthorityPublishErrorCode {
  if (outcome === 'reconciliation_required') {
    return 'GRAPH_AUTHORITY_RECONCILIATION_REQUIRED';
  }
  if (outcome === 'conflict') return 'GRAPH_AUTHORITY_CONFLICT';
  if (outcome === 'http_error') return 'GRAPH_AUTHORITY_HTTP_ERROR';
  if (outcome === 'transport_error') return 'GRAPH_AUTHORITY_TRANSPORT_ERROR';
  return 'GRAPH_AUTHORITY_RECEIPT_INVALID';
}

/**
 * Turns the already-qualified ingest transport into a fail-closed authority
 * handoff. The TypeScript caller reports success only after a bound durable Go
 * receipt proves accepted or duplicate completion.
 */
export class GraphAuthorityHttpPublisher implements GraphSnapshotPublisherPort {
  private readonly publisher: GraphShadowHttpPublisher;
  private readonly routingEpoch: number;

  constructor(options: GraphAuthorityHttpPublisherOptions) {
    const tenantId = policyIdentifier(options.tenantId, 'tenantId');
    const expectedTenantId = policyIdentifier(options.expectedTenantId, 'expectedTenantId');
    if (tenantId !== expectedTenantId) {
      throw new GraphAuthorityPublishError(
        'GRAPH_AUTHORITY_POLICY_INVALID',
        'Graph authority tenant binding does not match the canonical workspace.',
      );
    }
    if (
      !Number.isSafeInteger(options.routingEpoch) ||
      options.routingEpoch < 1 ||
      options.routingEpoch > GRAPH_AUTHORITY_PUBLISH_POLICY.maxRoutingEpoch
    ) {
      throw new GraphAuthorityPublishError(
        'GRAPH_AUTHORITY_POLICY_INVALID',
        'Graph authority routing epoch must be a positive safe integer.',
      );
    }
    if (!BUILD_SHA.test(options.expectedBuildSha)) {
      throw new GraphAuthorityPublishError(
        'GRAPH_AUTHORITY_POLICY_INVALID',
        'Graph authority build SHA must be 64 lowercase hexadecimal characters.',
      );
    }
    this.routingEpoch = options.routingEpoch;
    const transport = options.fetch ?? fetch;
    const boundFetch: GraphAuthorityFetch = (input, init) => {
      const endpoint = new URL(String(input));
      endpoint.pathname = authorityPath(endpoint.pathname);
      const headers = new Headers(init?.headers);
      headers.set('X-OpenSlack-Graph-Routing-Epoch', String(options.routingEpoch));
      headers.set('X-OpenSlack-Graph-Expected-Build-SHA', options.expectedBuildSha);
      headers.set('X-OpenSlack-Graph-Tenant-ID', tenantId);
      return transport(endpoint, { ...init, headers });
    };
    const publisherOptions: GraphShadowHttpPublisherOptions = {
      origin: options.origin,
      networkMode: options.networkMode ?? 'loopback',
      timeoutMs: options.timeoutMs ?? GRAPH_SHADOW_POLICY.defaultTimeoutMs,
      maxReceiptBytes: options.maxReceiptBytes ?? GRAPH_SHADOW_POLICY.defaultReceiptBytes,
      fetch: boundFetch,
      ...(options.now === undefined ? {} : { now: options.now }),
    };
    this.publisher = new GraphShadowHttpPublisher(publisherOptions);
  }

  async publishSnapshot(
    snapshot: GraphSnapshot,
    options: PublishGraphSnapshotOptions,
  ): Promise<GraphSnapshotPublication> {
    const observation = await this.publisher.publish({
      expectedCursor: options.expectedCursor,
      snapshot,
      ...(options.delta === undefined ? {} : { delta: options.delta }),
    });
    const receipt = observation.receipt;
    if (
      (observation.outcome !== 'accepted' && observation.outcome !== 'duplicate') ||
      receipt === undefined ||
      (receipt.status !== 'accepted' && receipt.status !== 'duplicate')
    ) {
      throw new GraphAuthorityPublishError(
        mapOutcome(observation.outcome),
        observation.outcome === 'reconciliation_required'
          ? 'Graph authority completion is ambiguous and requires reconciliation.'
          : 'Graph authority did not return a verified durable acceptance receipt.',
        receipt?.reconciliationToken,
      );
    }
    return Object.freeze({
      scenarioInstanceId: receipt.scenarioInstanceId,
      previousCursor: options.expectedCursor,
      cursor: receipt.cursor,
      snapshotIntegrityHash: receipt.snapshotIntegrityHash,
      authorityBackend: 'go',
      routingEpoch: this.routingEpoch,
      receiptStatus: receipt.status,
      revision: receipt.revision,
    });
  }
}
