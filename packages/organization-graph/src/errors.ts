export const GRAPH_CONTRACT_ERROR_CODES = Object.freeze([
  'GRAPH_SCHEMA_INVALID',
  'GRAPH_BOUND_EXCEEDED',
  'GRAPH_SCOPE_INVALID',
  'GRAPH_REFERENCE_INVALID',
  'GRAPH_PROPERTY_UNSAFE',
  'GRAPH_INTEGRITY_INVALID',
] as const);

export type GraphContractErrorCode = (typeof GRAPH_CONTRACT_ERROR_CODES)[number];

export class GraphContractError extends Error {
  readonly code: GraphContractErrorCode;
  readonly path: string;

  constructor(code: GraphContractErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'GraphContractError';
    this.code = code;
    this.path = path;
  }
}

export const GRAPH_QUERY_ERROR_CODES = Object.freeze([
  'GRAPH_QUERY_INVALID',
  'GRAPH_QUERY_CURSOR_INVALID',
  'GRAPH_QUERY_CURSOR_EXPIRED',
  'GRAPH_QUERY_CURSOR_MISMATCH',
  'GRAPH_QUERY_TARGET_NOT_FOUND',
  'GRAPH_QUERY_PATH_NOT_FOUND',
] as const);

export type GraphQueryErrorCode = (typeof GRAPH_QUERY_ERROR_CODES)[number];

export class GraphQueryError extends Error {
  readonly code: GraphQueryErrorCode;

  constructor(code: GraphQueryErrorCode, message: string) {
    super(message);
    this.name = 'GraphQueryError';
    this.code = code;
  }
}

export const GRAPH_STORE_ERROR_CODES = Object.freeze([
  'GRAPH_STORE_PATH_UNSAFE',
  'GRAPH_STORE_FILE_UNSAFE',
  'GRAPH_STORE_FILE_TOO_LARGE',
  'GRAPH_STORE_DIRECTORY_LIMIT',
  'GRAPH_STORE_RECORD_LIMIT',
  'GRAPH_STORE_CURSOR_CONFLICT',
  'GRAPH_STORE_LOCKED',
  'GRAPH_STORE_NOT_FOUND',
  'GRAPH_STORE_CONTENT_INVALID',
  'GRAPH_STORE_COMMITTED_UNVERIFIED',
] as const);

export type GraphStoreErrorCode = (typeof GRAPH_STORE_ERROR_CODES)[number];

export class GraphStoreError extends Error {
  readonly code: GraphStoreErrorCode;
  readonly path?: string;

  constructor(code: GraphStoreErrorCode, message: string, path?: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'GraphStoreError';
    this.code = code;
    this.path = path;
  }
}
