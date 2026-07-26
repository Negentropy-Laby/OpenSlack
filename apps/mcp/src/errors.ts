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
  ) {
    super(safeMessage);
    this.name = 'OpenSlackMcpToolError';
  }
}

export function safeToolError(error: unknown): OpenSlackMcpToolError {
  if (error instanceof OpenSlackMcpToolError) return error;
  return new OpenSlackMcpToolError(
    'READ_PROJECTION_FAILED',
    'The requested OpenSlack projection could not be read safely.',
  );
}
