export type DeliveryErrorCode =
  | 'DELIVERY_AUTH_REQUIRED'
  | 'DELIVERY_BASE_FORBIDDEN'
  | 'DELIVERY_PERMISSION_DENIED'
  | 'DELIVERY_PUSH_FAILED'
  | 'DELIVERY_PR_FAILED'
  | 'DELIVERY_PR_CONFLICT'
  | 'DELIVERY_TARGET_MISMATCH'
  | 'DELIVERY_HEAD_STALE'
  | 'DELIVERY_TIMEOUT'
  | 'DELIVERY_REMOTE_UNSUPPORTED'
  | 'DELIVERY_REPOSITORY_NOT_INSTALLED'
  | 'DELIVERY_REPOSITORY_SCOPE_INCOMPLETE'
  | 'DELIVERY_PROBE_CLEANUP_FAILED';

export class DeliveryError extends Error {
  constructor(
    readonly code: DeliveryErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DeliveryError';
  }
}

export class DeliveryProbeCleanupError extends DeliveryError {
  readonly remediation: string;

  constructor(
    readonly probeRef: string,
    owner: string,
    repo: string,
    options?: ErrorOptions,
  ) {
    const remediation = `openslack delivery cleanup-ref --branch ${probeRef} --repo ${owner}/${repo} --apply`;
    super(
      'DELIVERY_PROBE_CLEANUP_FAILED',
      `Temporary delivery probe ref could not be removed. Run: ${remediation}`,
      true,
      options,
    );
    this.name = 'DeliveryProbeCleanupError';
    this.remediation = remediation;
  }
}
