const RETRYABLE = new Set([
  'WORKFLOW_RUN_RECOVERY_UNKNOWN',
  'WORKFLOW_CONTROL_AUTHORITY_CLIENT_TRANSPORT_FAILED',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_TRANSPORT_FAILED',
  'WORKFLOW_RUNNER_BUDGET_AUTHORITY_TRANSPORT_FAILED',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RESPONSE_UNKNOWN',
  'WORKFLOW_RUNNER_LOCAL_IO_UNAVAILABLE',
]);

const LOCAL_IO = new Set([
  'ENOSPC',
  'EDQUOT',
  'EACCES',
  'EPERM',
  'EROFS',
  'EIO',
  'EMFILE',
  'ENFILE',
  'EBUSY',
  'EINTR',
]);

/** Only OS I/O failures are recoverable here; typed security/integrity errors retain their identity. */
export function workflowAuthorityFailure(error: unknown): unknown {
  if (error && typeof error === 'object' && 'code' in error && LOCAL_IO.has(String(error.code))) {
    return Object.assign(
      new Error('Local workflow storage is temporarily unavailable.', { cause: error }),
      {
        code: 'WORKFLOW_RUNNER_LOCAL_IO_UNAVAILABLE' as const,
      },
    );
  }
  return error;
}

export function isWorkflowAuthorityRetryable(error: unknown): boolean {
  error = workflowAuthorityFailure(error);
  return Boolean(
    error && typeof error === 'object' && 'code' in error && RETRYABLE.has(String(error.code)),
  );
}

export function isWorkflowAuthorityConflict(error: unknown): boolean {
  error = workflowAuthorityFailure(error);
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    !RETRYABLE.has(error.code),
  );
}
