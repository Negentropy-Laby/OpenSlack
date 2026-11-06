import type { ProviderAttemptPort, ProviderAttemptReservation } from '../provider-attempt-port.js';

/** Host-only composition. This hook can restrict an existing Go reservation; it grants none. */
export interface ProviderSendRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestBytes: string;
  readonly signal?: AbortSignal;
}
const hooks = new WeakMap<
  ProviderAttemptPort,
  (reservation: ProviderAttemptReservation, request: ProviderSendRequest) => Promise<void>
>();
export const hasProviderSendAdmission = (port: ProviderAttemptPort): boolean => hooks.has(port);

export function bindProviderSendAdmission(
  port: ProviderAttemptPort,
  beforeSend: (
    reservation: ProviderAttemptReservation,
    request: ProviderSendRequest,
  ) => Promise<void>,
): void {
  if (hooks.has(port)) throw new TypeError('Provider send admission is already bound.');
  hooks.set(port, beforeSend);
}

export async function admitProviderSend(
  port: ProviderAttemptPort,
  reservation: ProviderAttemptReservation,
  request: ProviderSendRequest,
): Promise<void> {
  await hooks.get(port)?.(reservation, Object.freeze({ ...request }));
}

export { providerUsageRequestHash } from '../provider-usage-evidence.js';
