import type { ProviderUsageReceipt } from './provider-usage-evidence.js';

/** Content-free host transport. It carries bounded IDs, never provider payloads or authority. */
export interface ProviderAttemptReserveInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerRunId: string;
  readonly providerAttempt: string;
  readonly requestedTokens: string;
}

export interface ProviderAttemptReservation {
  readonly reservationId: string;
  readonly callId: string;
  readonly authorizedTokens: string;
}

export interface ProviderAttemptPort {
  reserve(input: ProviderAttemptReserveInput): Promise<ProviderAttemptReservation>;
  settle(reservation: ProviderAttemptReservation, usage: ProviderUsageReceipt): Promise<void>;
}
