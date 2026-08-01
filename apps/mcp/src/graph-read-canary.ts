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
  GraphReadCanaryError,
  GraphReadCanaryRouter,
  canonicalJson,
  type GraphExplainInput,
  type GraphQueryInput,
  type GraphReadCanaryBackend,
  type GraphReadCanaryExplainProjection,
  type GraphReadCanaryOperation,
  type GraphReadCanaryPort,
  type GraphReadCanaryQueryProjection,
  type GraphReadCanaryRoute,
  type GraphReadCanaryRouterOptions,
  type GraphServiceNetworkMode,
} from '@openslack/organization-graph';
import { resolveWorkspaceContext } from '@openslack/workspace';

export interface CreateOpenSlackGraphReadCanaryOptions {
  readonly workspaceRoot: string;
  readonly backend: GraphReadCanaryBackend;
  readonly tenantId: string;
  readonly scenarioInstanceIds: readonly string[];
  readonly routingEpoch: number;
  readonly expiresAt: string;
  readonly origin?: string;
  readonly networkMode?: GraphServiceNetworkMode;
  readonly expectedBuildSha?: string;
  readonly timeoutMs?: number;
  /** Test seam. Production composition uses the global bounded fetch implementation. */
  readonly fetch?: GraphReadCanaryRouterOptions['fetch'];
  /** Test seam. Production composition uses the system clock. */
  readonly now?: () => number;
}

function canonicalWorkspaceRoot(value: string): string {
  if (typeof value !== 'string' || resolve(value) !== value) {
    throw new TypeError('Graph read canary workspace root must be absolute and normalized.');
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
    throw new TypeError('Graph read canary workspace root must be a real canonical directory.');
  }
  return real;
}

function fingerprint(
  operation: GraphReadCanaryOperation,
  input: Readonly<GraphQueryInput | GraphExplainInput>,
): string {
  const path = operation === 'query' ? '/v1/canary/graph:query' : '/v1/canary/graph:explain';
  return `sha256:${createHash('sha256')
    .update(`POST\n${path}\n${canonicalJson(input)}`, 'utf8')
    .digest('hex')}`;
}

function eventType(outcome: 'served' | 'blocked' | 'rolled_back'): CollaborationEventType {
  return `graph.read_canary.${outcome}`;
}

function canaryEvent(input: {
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
  const type = eventType(input.outcome);
  return {
    schema: 'openslack.collaboration_event.v1',
    id: `GRCANARY-${randomUUID()}`,
    timestamp: input.completedAt,
    type,
    actor: { id: 'organization-graph-read-canary', kind: 'system' },
    object: { kind: 'graph', id: input.request.scenarioInstanceId },
    source: { kind: 'openslack', ref: 'organization-graph-read-canary' },
    summary:
      input.outcome === 'served'
        ? `Recorded a bound Go ${input.operation} canary read.`
        : input.outcome === 'rolled_back'
          ? `Recorded an explicit TypeScript ${input.operation} rollback read.`
          : `Recorded a blocked ${input.backend} ${input.operation} canary read.`,
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

function safeNow(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    value = Number.NaN;
  }
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new GraphReadCanaryError(
      'GRAPH_READ_CANARY_AUDIT_FAILED',
      'Graph read canary audit clock returned an invalid timestamp.',
    );
  }
  return value;
}

/**
 * Binds the generic canary router to the canonical workspace and its durable,
 * redacted Collaboration audit stream.
 */
export function createOpenSlackGraphReadCanary(
  options: CreateOpenSlackGraphReadCanaryOptions,
): GraphReadCanaryPort {
  const workspaceRoot = canonicalWorkspaceRoot(options.workspaceRoot);
  const workspace = resolveWorkspaceContext({ workspaceRoot, requireWorkspace: true });
  if (!workspace.config?.workspace_id) {
    throw new TypeError('Graph read canary requires a canonical workspace ID.');
  }
  const now = options.now ?? Date.now;
  const router = new GraphReadCanaryRouter({
    backend: options.backend,
    tenantId: workspace.config.workspace_id,
    expectedTenantId: options.tenantId,
    scenarioInstanceIds: options.scenarioInstanceIds,
    routingEpoch: options.routingEpoch,
    expiresAt: options.expiresAt,
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.networkMode === undefined ? {} : { networkMode: options.networkMode }),
    ...(options.expectedBuildSha === undefined
      ? {}
      : { expectedBuildSha: options.expectedBuildSha }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    now,
  });
  // Validate the policy and transport before opening the durable audit target.
  const appender = createBoundEventAppender(workspaceRoot);

  const append = (event: CollaborationEvent, required: boolean): void => {
    try {
      if (!validateEvent(event).valid || !sanitizeEvent(event).safe) {
        throw new TypeError('Graph read canary event failed its bounded audit contract.');
      }
      appender.append(event);
    } catch {
      if (required) {
        throw new GraphReadCanaryError(
          'GRAPH_READ_CANARY_AUDIT_FAILED',
          'The selected graph read could not commit its bounded audit evidence.',
        );
      }
      console.error(
        'OPENSLACK_GRAPH_READ_CANARY_AUDIT_FAILED: bounded Collaboration audit append failed.',
      );
    }
  };

  const read = async <T extends GraphReadCanaryQueryProjection | GraphReadCanaryExplainProjection>(
    operation: GraphReadCanaryOperation,
    input: Readonly<GraphQueryInput | GraphExplainInput>,
    execute: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = safeNow(now);
    let result: T;
    try {
      result = await execute();
    } catch (error) {
      const completedAt = safeNow(now);
      append(
        canaryEvent({
          operation,
          request: input,
          outcome: 'blocked',
          backend: options.backend,
          routingEpoch: options.routingEpoch,
          completedAt: new Date(completedAt).toISOString(),
          latencyMs: Math.max(0, completedAt - startedAt),
          ...(options.expectedBuildSha === undefined
            ? {}
            : { expectedBuildSha: options.expectedBuildSha }),
          ...(error instanceof GraphReadCanaryError ? { code: error.code } : {}),
          ...(error instanceof GraphReadCanaryError && error.httpStatus !== undefined
            ? { httpStatus: error.httpStatus }
            : {}),
        }),
        false,
      );
      throw error;
    }
    const completedAt = safeNow(now);
    append(
      canaryEvent({
        operation,
        request: input,
        outcome: 'served',
        backend: 'go',
        routingEpoch: options.routingEpoch,
        completedAt: new Date(completedAt).toISOString(),
        latencyMs: Math.max(0, completedAt - startedAt),
        ...(options.expectedBuildSha === undefined
          ? {}
          : { expectedBuildSha: options.expectedBuildSha }),
      }),
      true,
    );
    return result;
  };

  return Object.freeze({
    route(scenarioInstanceId: string): GraphReadCanaryRoute | undefined {
      return router.route(scenarioInstanceId);
    },
    query(input: Readonly<GraphQueryInput>): Promise<GraphReadCanaryQueryProjection> {
      return read('query', input, () => router.query(input));
    },
    explain(input: Readonly<GraphExplainInput>): Promise<GraphReadCanaryExplainProjection> {
      return read('explain', input, () => router.explain(input));
    },
    recordBlockedRead(
      operation: GraphReadCanaryOperation,
      input: Readonly<GraphQueryInput | GraphExplainInput>,
      error: unknown,
    ): void {
      try {
        const timestamp = safeNow(now);
        append(
          canaryEvent({
            operation,
            request: input,
            outcome: 'blocked',
            backend: options.backend,
            routingEpoch: options.routingEpoch,
            completedAt: new Date(timestamp).toISOString(),
            latencyMs: 0,
            ...(options.expectedBuildSha === undefined
              ? {}
              : { expectedBuildSha: options.expectedBuildSha }),
            ...(error instanceof GraphReadCanaryError ? { code: error.code } : {}),
            ...(error instanceof GraphReadCanaryError && error.httpStatus !== undefined
              ? { httpStatus: error.httpStatus }
              : {}),
          }),
          false,
        );
      } catch {
        console.error(
          'OPENSLACK_GRAPH_READ_CANARY_AUDIT_FAILED: bounded Collaboration audit append failed.',
        );
      }
    },
    recordTsLocalRead(
      operation: GraphReadCanaryOperation,
      input: Readonly<GraphQueryInput | GraphExplainInput>,
    ): void {
      const route = router.route(input.scenarioInstanceId);
      if (route?.backend !== 'ts-local') {
        throw new GraphReadCanaryError(
          'GRAPH_READ_CANARY_ROUTE_MISMATCH',
          'TypeScript rollback audit did not match the selected canary route.',
        );
      }
      const timestamp = safeNow(now);
      append(
        canaryEvent({
          operation,
          request: input,
          outcome: 'rolled_back',
          backend: 'ts-local',
          routingEpoch: route.routingEpoch,
          completedAt: new Date(timestamp).toISOString(),
          latencyMs: 0,
        }),
        true,
      );
    },
  });
}
