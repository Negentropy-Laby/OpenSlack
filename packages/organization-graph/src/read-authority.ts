import {
  GraphReadCanaryError,
  GraphReadCanaryRouter,
  type GraphReadCanaryExplainProjection,
  type GraphReadCanaryPort,
  type GraphReadCanaryQueryProjection,
  type GraphReadCanaryRoute,
  type GraphReadCanaryRouterOptions,
} from './read-canary.js';
import type { GraphExplainInput, GraphQueryInput } from './types.js';

export type GraphReadAuthorityErrorCode =
  | 'GRAPH_READ_AUTHORITY_POLICY_INVALID'
  | 'GRAPH_READ_AUTHORITY_POLICY_EXPIRED'
  | 'GRAPH_READ_AUTHORITY_BACKEND_ROLLBACK'
  | 'GRAPH_READ_AUTHORITY_TIMEOUT'
  | 'GRAPH_READ_AUTHORITY_NETWORK_ERROR'
  | 'GRAPH_READ_AUTHORITY_HTTP_ERROR'
  | 'GRAPH_READ_AUTHORITY_RESPONSE_INVALID'
  | 'GRAPH_READ_AUTHORITY_ROUTE_MISMATCH'
  | 'GRAPH_READ_AUTHORITY_AUDIT_FAILED'
  | 'SOURCE_EVIDENCE_STALE'
  | 'GRAPH_QUERY_CURSOR_INVALID'
  | 'GRAPH_QUERY_CURSOR_EXPIRED'
  | 'GRAPH_QUERY_CURSOR_MISMATCH';

export class GraphReadAuthorityError extends Error {
  constructor(
    readonly code: GraphReadAuthorityErrorCode,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'GraphReadAuthorityError';
  }
}

export type GraphReadAuthorityPort = GraphReadCanaryPort;

export type GraphReadAuthorityRouterOptions = Omit<
  GraphReadCanaryRouterOptions,
  'scenarioInstanceIds' | 'readAuthority'
>;

function mapError(error: unknown): GraphReadAuthorityError {
  if (error instanceof GraphReadAuthorityError) return error;
  if (!(error instanceof GraphReadCanaryError)) {
    return new GraphReadAuthorityError(
      'GRAPH_READ_AUTHORITY_NETWORK_ERROR',
      'The Go graph read authority could not be reached.',
    );
  }
  const mapped = (
    {
      GRAPH_READ_CANARY_POLICY_INVALID: 'GRAPH_READ_AUTHORITY_POLICY_INVALID',
      GRAPH_READ_CANARY_POLICY_EXPIRED: 'GRAPH_READ_AUTHORITY_POLICY_EXPIRED',
      GRAPH_READ_CANARY_NOT_SELECTED: 'GRAPH_READ_AUTHORITY_ROUTE_MISMATCH',
      GRAPH_READ_CANARY_BACKEND_ROLLBACK: 'GRAPH_READ_AUTHORITY_BACKEND_ROLLBACK',
      GRAPH_READ_CANARY_TIMEOUT: 'GRAPH_READ_AUTHORITY_TIMEOUT',
      GRAPH_READ_CANARY_NETWORK_ERROR: 'GRAPH_READ_AUTHORITY_NETWORK_ERROR',
      GRAPH_READ_CANARY_HTTP_ERROR: 'GRAPH_READ_AUTHORITY_HTTP_ERROR',
      GRAPH_READ_CANARY_RESPONSE_INVALID: 'GRAPH_READ_AUTHORITY_RESPONSE_INVALID',
      GRAPH_READ_CANARY_ROUTE_MISMATCH: 'GRAPH_READ_AUTHORITY_ROUTE_MISMATCH',
      GRAPH_READ_CANARY_AUDIT_FAILED: 'GRAPH_READ_AUTHORITY_AUDIT_FAILED',
      SOURCE_EVIDENCE_STALE: 'SOURCE_EVIDENCE_STALE',
      GRAPH_QUERY_CURSOR_INVALID: 'GRAPH_QUERY_CURSOR_INVALID',
      GRAPH_QUERY_CURSOR_EXPIRED: 'GRAPH_QUERY_CURSOR_EXPIRED',
      GRAPH_QUERY_CURSOR_MISMATCH: 'GRAPH_QUERY_CURSOR_MISMATCH',
    } as const
  )[error.code];
  return new GraphReadAuthorityError(mapped, error.message, error.httpStatus);
}

/** Global, process-immutable GS3-C read route; unlike canary it selects every scenario. */
export class GraphReadAuthorityRouter implements GraphReadAuthorityPort {
  private readonly router: GraphReadCanaryRouter;

  constructor(options: GraphReadAuthorityRouterOptions) {
    try {
      this.router = new GraphReadCanaryRouter({
        ...options,
        scenarioInstanceIds: [],
        readAuthority: true,
      });
    } catch (error) {
      throw mapError(error);
    }
  }

  route(scenarioInstanceId: string): GraphReadCanaryRoute {
    try {
      const route = this.router.route(scenarioInstanceId);
      if (!route) {
        throw new GraphReadAuthorityError(
          'GRAPH_READ_AUTHORITY_ROUTE_MISMATCH',
          'The graph read authority did not select the requested scenario.',
        );
      }
      return route;
    } catch (error) {
      throw mapError(error);
    }
  }

  async query(input: Readonly<GraphQueryInput>): Promise<GraphReadCanaryQueryProjection> {
    try {
      return await this.router.query(input);
    } catch (error) {
      throw mapError(error);
    }
  }

  async explain(input: Readonly<GraphExplainInput>): Promise<GraphReadCanaryExplainProjection> {
    try {
      return await this.router.explain(input);
    } catch (error) {
      throw mapError(error);
    }
  }
}
