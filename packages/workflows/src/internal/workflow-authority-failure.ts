const RETRYABLE = new Set([
  'WORKFLOW_RUN_RECOVERY_UNKNOWN',
  'WORKFLOW_CONTROL_AUTHORITY_CLIENT_TRANSPORT_FAILED',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_CLIENT_TRANSPORT_FAILED',
  'WORKFLOW_RUNNER_BUDGET_AUTHORITY_TRANSPORT_FAILED',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_SOURCE_UNKNOWN',
  'WORKFLOW_RUNNER_AUTHORITY_BINDING_RUNTIME_RESPONSE_UNKNOWN',
]);

export function isWorkflowAuthorityRetryable(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && RETRYABLE.has(String(error.code)),
  );
}

export function isWorkflowAuthorityConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    !RETRYABLE.has(error.code),
  );
}
