import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createBoundEventAppender,
  sanitizeEvent,
  validateEvent,
  type CollaborationEvent,
  type CollaborationEventType,
} from '@openslack/collaboration';
import {
  GraphReadAuthorityError,
  GraphReadAuthorityRouter,
  canonicalJson,
  type GraphExplainInput,
  type GraphQueryInput,
  type GraphReadAuthorityPort,
  type GraphReadAuthorityRouterOptions,
  type GraphReadCanaryBackend,
  type GraphReadCanaryOperation,
  type GraphReadCanaryRoute,
  type GraphServiceNetworkMode,
} from '@openslack/organization-graph';
import { resolveWorkspaceContext } from '@openslack/workspace';

export interface CreateOpenSlackGraphReadAuthorityOptions {
  readonly workspaceRoot: string;
  readonly backend: GraphReadCanaryBackend;
  readonly tenantId: string;
  readonly routingEpoch: number;
  readonly expiresAt: string;
  readonly origin?: string;
  readonly networkMode?: GraphServiceNetworkMode;
  readonly expectedBuildSha?: string;
  readonly timeoutMs?: number;
  readonly maxSnapshotAgeMs?: number;
  /** Test seam. */
  readonly fetch?: GraphReadAuthorityRouterOptions['fetch'];
  /** Test seam. */
  readonly now?: () => number;
}

function canonicalWorkspaceRoot(value: string): string {
  if (typeof value !== 'string' || resolve(value) !== value) {
    throw new TypeError('Graph read authority workspace root must be absolute and normalized.');
  }
  const symbolic = lstatSync(value);
  const stat = statSync(value);
  const real = realpathSync.native(value);
  if (
    symbolic.isSymbolicLink() ||
    !symbolic.isDirectory() ||
    !stat.isDirectory() ||
    real !== value
  ) {
    throw new TypeError('Graph read authority workspace root must be a real canonical directory.');
  }
  return real;
}

function safeNow(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    value = Number.NaN;
  }
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new GraphReadAuthorityError(
      'GRAPH_READ_AUTHORITY_AUDIT_FAILED',
      'Graph read authority audit clock returned an invalid timestamp.',
    );
  }
  return value;
}

function fingerprint(
  operation: GraphReadCanaryOperation,
  input: Readonly<GraphQueryInput | GraphExplainInput>,
): string {
  const path = operation === 'query' ? '/v1/authority/graph:query' : '/v1/authority/graph:explain';
  return `sha256:${createHash('sha256')
    .update(`POST\n${path}\n${canonicalJson(input)}`, 'utf8')
    .digest('hex')}`;
}

function eventType(outcome: 'served' | 'blocked' | 'rolled_back'): CollaborationEventType {
  return `graph.read_authority.${outcome}`;
}

function authorityEvent(input: {
  readonly operation: GraphReadCanaryOperation;
  readonly request: Readonly<GraphQueryInput | GraphExplainInput>;
  readonly outcome: 'served' | 'blocked' | 'rolled_back';
  readonly backend: GraphReadCanaryBackend;
  readonly routingEpoch: number;
  readonly completedAt: string;
  readonly latencyMs: number;
  readonly expectedBuildSha?: string;
  readonly code?: string;
  readonly httpStatus?: number;
}): CollaborationEvent {
  return {
    schema: 'openslack.collaboration_event.v1',
    id: `GRAUTHORITY-${randomUUID()}`,
    timestamp: input.completedAt,
    type: eventType(input.outcome),
    actor: { id: 'organization-graph-read-authority', kind: 'system' },
    object: { kind: 'graph', id: input.request.scenarioInstanceId },
    source: { kind: 'openslack', ref: 'organization-graph-read-authority' },
    summary:
      input.outcome === 'served'
        ? `Recorded a bound Go ${input.operation} authority read.`
        : input.outcome === 'rolled_back'
          ? `Recorded an explicit TypeScript ${input.operation} authority rollback.`
          : `Recorded a blocked ${input.backend} ${input.operation} authority read.`,
    owner: { id: 'organization-graph', kind: 'system' },
    severity: input.outcome === 'blocked' ? 'warning' : 'info',
    visibility: 'workspace',
    redacted: true,
    containsSensitiveData: false,
    metadata: {
      operation: input.operation,
      outcome: input.outcome,
      backend: input.backend,
      routingEpoch: input.routingEpoch,
      requestFingerprint: fingerprint(input.operation, input.request),
      latencyMs: input.latencyMs,
      ...(input.expectedBuildSha === undefined ? {} : { expectedBuildSha: input.expectedBuildSha }),
      ...(input.code === undefined ? {} : { code: input.code }),
      ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    },
  };
}

/** Binds global GS3-C routing to one canonical workspace and required audit stream. */
export function createOpenSlackGraphReadAuthority(
  options: CreateOpenSlackGraphReadAuthorityOptions,
): GraphReadAuthorityPort {
  const workspaceRoot = canonicalWorkspaceRoot(options.workspaceRoot);
  const workspace = resolveWorkspaceContext({ workspaceRoot, requireWorkspace: true });
  if (!workspace.config?.workspace_id) {
    throw new TypeError('Graph read authority requires a canonical workspace ID.');
  }
  const now = options.now ?? Date.now;
  const router = new GraphReadAuthorityRouter({
    backend: options.backend,
    tenantId: workspace.config.workspace_id,
    expectedTenantId: options.tenantId,
    routingEpoch: options.routingEpoch,
    expiresAt: options.expiresAt,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.networkMode === undefined ? {} : { networkMode: options.networkMode }),
    ...(options.expectedBuildSha === undefined
      ? {}
      : { expectedBuildSha: options.expectedBuildSha }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxSnapshotAgeMs === undefined
      ? {}
      : { maxSnapshotAgeMs: options.maxSnapshotAgeMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    now,
  });
  const appender = createBoundEventAppender(workspaceRoot);

  const append = (event: CollaborationEvent, required: boolean): void => {
    try {
      if (!validateEvent(event).valid || !sanitizeEvent(event).safe) {
        throw new TypeError('Graph read authority event failed its bounded audit contract.');
      }
      appender.append(event);
    } catch {
      if (required) {
        throw new GraphReadAuthorityError(
          'GRAPH_READ_AUTHORITY_AUDIT_FAILED',
          'The graph authority read could not commit its bounded audit evidence.',
        );
      }
      console.error(
        'OPENSLACK_GRAPH_READ_AUTHORITY_AUDIT_FAILED: bounded Collaboration audit append failed.',
      );
    }
  };

  const record = (
    operation: GraphReadCanaryOperation,
    request: Readonly<GraphQueryInput | GraphExplainInput>,
    outcome: 'served' | 'blocked' | 'rolled_back',
    startedAt: number,
    error?: unknown,
  ): void => {
    const completedAt = safeNow(now);
    append(
      authorityEvent({
        operation,
        request,
        outcome,
        backend: outcome === 'rolled_back' ? 'ts-local' : options.backend,
        routingEpoch: options.routingEpoch,
        completedAt: new Date(completedAt).toISOString(),
        latencyMs: Math.max(0, completedAt - startedAt),
        ...(options.expectedBuildSha === undefined
          ? {}
          : { expectedBuildSha: options.expectedBuildSha }),
        ...(error instanceof GraphReadAuthorityError ? { code: error.code } : {}),
        ...(error instanceof GraphReadAuthorityError && error.httpStatus !== undefined
          ? { httpStatus: error.httpStatus }
          : {}),
      }),
      outcome !== 'blocked',
    );
  };

  const execute = async <T>(
    operation: GraphReadCanaryOperation,
    request: Readonly<GraphQueryInput | GraphExplainInput>,
    call: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = safeNow(now);
    try {
      const result = await call();
      record(operation, request, 'served', startedAt);
      return result;
    } catch (error) {
      record(operation, request, 'blocked', startedAt, error);
      throw error;
    }
  };

  return Object.freeze({
    route(scenarioInstanceId: string): GraphReadCanaryRoute {
      return router.route(scenarioInstanceId);
    },
    query(input: Readonly<GraphQueryInput>) {
      return execute('query', input, () => router.query(input));
    },
    explain(input: Readonly<GraphExplainInput>) {
      return execute('explain', input, () => router.explain(input));
    },
    recordBlockedRead(
      operation: GraphReadCanaryOperation,
      input: Readonly<GraphQueryInput | GraphExplainInput>,
      error: unknown,
    ): void {
      try {
        record(operation, input, 'blocked', safeNow(now), error);
      } catch {
        console.error(
          'OPENSLACK_GRAPH_READ_AUTHORITY_AUDIT_FAILED: bounded Collaboration audit append failed.',
        );
      }
    },
    recordTsLocalRead(
      operation: GraphReadCanaryOperation,
      input: Readonly<GraphQueryInput | GraphExplainInput>,
    ): void {
      const route = router.route(input.scenarioInstanceId);
      if (route.backend !== 'ts-local') {
        throw new GraphReadAuthorityError(
          'GRAPH_READ_AUTHORITY_ROUTE_MISMATCH',
          'TypeScript rollback audit did not match the global authority route.',
        );
      }
      record(operation, input, 'rolled_back', safeNow(now));
    },
  });
}
