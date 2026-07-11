export type DeliveryErrorCode =
  | 'DELIVERY_AUTH_REQUIRED'
  | 'DELIVERY_PERMISSION_DENIED'
  | 'DELIVERY_PUSH_FAILED'
  | 'DELIVERY_PR_FAILED'
  | 'DELIVERY_PR_CONFLICT'
  | 'DELIVERY_TARGET_MISMATCH'
  | 'DELIVERY_HEAD_STALE'
  | 'DELIVERY_TIMEOUT'
  | 'DELIVERY_REMOTE_UNSUPPORTED';

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
