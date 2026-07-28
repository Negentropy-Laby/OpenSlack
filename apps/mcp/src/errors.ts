import { GovernedPlanServiceError, GovernedPlanStoreError } from '@openslack/operator';

export class OpenSlackMcpProtocolError extends Error {
  constructor(
    readonly code: -32601 | -32602 | -32603,
    message: string,
  ) {
    super(message);
    this.name = 'OpenSlackMcpProtocolError';
  }
}

export class OpenSlackMcpToolError extends Error {
  constructor(
    readonly safeCode: string,
    readonly safeMessage: string,
    readonly safeStatus: 'failed' | 'blocked' = 'failed',
  ) {
    super(safeMessage);
    this.name = 'OpenSlackMcpToolError';
  }
}

export function safeToolError(error: unknown): OpenSlackMcpToolError {
  if (error instanceof OpenSlackMcpToolError) return error;
  if (error instanceof GovernedPlanServiceError) {
    return new OpenSlackMcpToolError(
      error.code,
      'The governed plan request was rejected by its durable state contract.',
      'blocked',
    );
  }
  if (
    error instanceof GovernedPlanStoreError &&
    [
      'GOVERNED_PLAN_STORE_BUSY',
      'GOVERNED_PLAN_STORE_CAS_MISMATCH',
      'GOVERNED_PLAN_STORE_TRANSITION_INVALID',
    ].includes(error.code)
  ) {
    return new OpenSlackMcpToolError(
      'GOVERNED_PLAN_EXECUTION_ACTIVE',
      'Another governed confirmation already owns or changed the durable plan claim.',
      'blocked',
    );
  }
  return new OpenSlackMcpToolError(
    'READ_PROJECTION_FAILED',
    'The requested OpenSlack projection could not be read safely.',
  );
}
