import { types as nodeTypes } from 'node:util';
import type {
  ProviderAttemptPort,
  ProviderAttemptReservation,
  ProviderAttemptReserveInput,
} from '../provider-attempt-port.js';
import type { ProviderUsageReceipt } from '../provider-usage-evidence.js';

/** Opaque capability minted by the launcher host and consumed only by adapters. */
export interface ProviderAttemptBoundary {
  readonly kind: 'provider_attempt_boundary';
}

const PORTS = new WeakMap<object, ProviderAttemptPort>();

export function createProviderAttemptBoundary(port: ProviderAttemptPort): ProviderAttemptBoundary {
  if (
    !port ||
    typeof port !== 'object' ||
    nodeTypes.isProxy(port) ||
    typeof port.reserve !== 'function' ||
    typeof port.settle !== 'function' ||
    nodeTypes.isProxy(port.reserve) ||
    nodeTypes.isProxy(port.settle)
  ) {
    throw new TypeError('Provider attempt port is invalid.');
  }
  const boundary = Object.freeze({ kind: 'provider_attempt_boundary' as const });
  PORTS.set(boundary, port);
  return boundary;
}

function port(boundary: ProviderAttemptBoundary): ProviderAttemptPort {
  if (!boundary || typeof boundary !== 'object' || nodeTypes.isProxy(boundary)) {
    throw new TypeError('Provider attempt boundary is invalid.');
  }
  const value = PORTS.get(boundary);
  if (!value) throw new TypeError('Provider attempt boundary is not host-minted.');
  return value;
}

export function reserveProviderAttempt(
  boundary: ProviderAttemptBoundary,
  input: ProviderAttemptReserveInput,
): Promise<ProviderAttemptReservation> {
  return port(boundary).reserve(input);
}

export function settleProviderAttempt(
  boundary: ProviderAttemptBoundary,
  reservation: ProviderAttemptReservation,
  usage: ProviderUsageReceipt,
): Promise<void> {
  return port(boundary).settle(reservation, usage);
}
