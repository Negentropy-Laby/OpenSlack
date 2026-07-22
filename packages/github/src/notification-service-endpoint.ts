const LITERAL_LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

export interface NotificationServiceEndpointPolicy {
  allowInsecureLoopback?: boolean;
}

/**
 * Validates and canonicalizes the frozen notification-service origin contract.
 * The thrown error is deliberately value-free so a URL containing credentials
 * can never be reflected into logs by a caller.
 */
export function normalizeNotificationServiceOrigin(
  value: string,
  policy: NotificationServiceEndpointPolicy = {},
): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw invalidEndpoint();
  }

  const insecureLoopbackAllowed =
    endpoint.protocol === 'http:' &&
    policy.allowInsecureLoopback === true &&
    LITERAL_LOOPBACK_HOSTS.has(endpoint.hostname);
  if (
    (endpoint.protocol !== 'https:' && !insecureLoopbackAllowed) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.pathname !== '/' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw invalidEndpoint();
  }
  return endpoint.origin;
}

function invalidEndpoint(): TypeError {
  return new TypeError(
    'Notification service endpoint must be a credential-free HTTPS origin; development HTTP requires an explicit literal-loopback policy.',
  );
}
