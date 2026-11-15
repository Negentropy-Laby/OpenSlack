import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { ProviderAttemptPort, ProviderAttemptReservation } from '../provider-attempt-port.js';
import { ProviderTimeoutError, RuntimeMisconfiguredError } from '../types.js';

/** Host-only composition. This hook can restrict an existing Go reservation; it grants none. */
export interface ProviderSendTransportEvidence {
  readonly schema: 'openslack.openai_send_transport.v1';
  readonly endpoint: string;
  readonly method: 'POST';
  readonly redirect: 'error';
  /** Adapter retries only; this makes no claim about gateway/upstream attempts. */
  readonly adapterAutomaticRetries: 0;
}

export interface ProviderSendRequest {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestBytes: string;
  /** Absent for transports without reviewed local evidence; absence proves nothing. */
  readonly transportEvidence?: ProviderSendTransportEvidence;
  readonly signal?: AbortSignal;
}
const hooks = new WeakMap<
  ProviderAttemptPort,
  (reservation: ProviderAttemptReservation, request: ProviderSendRequest) => Promise<void>
>();
const preparationHooks = new WeakMap<
  ProviderAttemptPort,
  (request: ProviderSendRequest) => Promise<void>
>();
export const hasProviderSendAdmission = (port: ProviderAttemptPort): boolean => hooks.has(port);

/** Host-only read-only veto before a durable Go reservation. It grants no send authority. */
export function bindProviderSendPreparation(
  port: ProviderAttemptPort,
  prepare: (request: ProviderSendRequest) => Promise<void>,
): void {
  if (preparationHooks.has(port))
    throw new TypeError('Provider send preparation is already bound.');
  preparationHooks.set(port, prepare);
}

export async function prepareProviderSend(
  port: ProviderAttemptPort,
  request: ProviderSendRequest,
): Promise<void> {
  await preparationHooks.get(port)?.(Object.freeze({ ...request }));
}

/** Local observation only. Neither this scope nor its handle verifies a token contract. */
export interface ProviderSendPreparationScope {
  readonly providerRunId: string;
  readonly providerAttempt: string;
  readonly requestedTokens: string;
  readonly expiresAt: number;
}

/** Opaque identity; copying its shape does not copy the private observation. */
export interface ProviderSendPreparationObservation {
  readonly kind: 'provider_send_preparation_observation';
}

interface PreparationObservation {
  port: ProviderAttemptPort;
  request: ProviderSendRequest;
  body: Record<string, unknown>;
  scope: ProviderSendPreparationScope;
  stage: 'prepared' | 'finalized' | 'consumed';
  reservation?: ProviderAttemptReservation;
  reservationSnapshot?: Readonly<ProviderAttemptReservation>;
  finalRequest?: ProviderSendRequest;
  observationHash?: string;
}

const observations = new WeakMap<ProviderSendPreparationObservation, PreparationObservation>();
const finalizedReservations = new WeakSet<ProviderAttemptReservation>();

function invalidPreparation(): never {
  throw new RuntimeMisconfiguredError('Provider request preparation is invalid or stale.');
}

function tokenInteger(value: string, zeroAllowed = false): number {
  if (
    typeof value !== 'string' ||
    value.length > 16 ||
    !(zeroAllowed ? /^(?:0|[1-9][0-9]*)$/u : /^[1-9][0-9]*$/u).test(value)
  )
    return invalidPreparation();
  const result = Number(value);
  if (!Number.isSafeInteger(result)) return invalidPreparation();
  return result;
}

/** Integer subtraction, not a token count, provider cap mapping or send capability. */
export function providerTokenHeadroom(
  actualAuthorizedTokens: string,
  allocatedTokens: string,
  requestedTokens: string,
): number {
  const actual = tokenInteger(actualAuthorizedTokens);
  const allocated = tokenInteger(allocatedTokens, true);
  if (actual > tokenInteger(requestedTokens) || allocated > actual) return invalidPreparation();
  return actual - allocated;
}

function requestSnapshot(request: ProviderSendRequest): ProviderSendRequest {
  return Object.freeze({
    providerId: request.providerId,
    modelId: request.modelId,
    requestBytes: request.requestBytes,
    ...(request.transportEvidence
      ? { transportEvidence: Object.freeze({ ...request.transportEvidence }) }
      : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });
}

function requestBody(request: ProviderSendRequest): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(request.requestBytes);
  } catch {
    return invalidPreparation();
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(value) !== request.requestBytes
  )
    return invalidPreparation();
  const body = value as Record<string, unknown>;
  if (
    body.model !== request.modelId ||
    !Number.isSafeInteger(body.max_tokens) ||
    (body.max_tokens as number) < 1
  )
    return invalidPreparation();
  return body;
}

function sameScope(a: ProviderSendPreparationScope, b: ProviderSendPreparationScope): boolean {
  return (
    a.providerRunId === b.providerRunId &&
    a.providerAttempt === b.providerAttempt &&
    a.requestedTokens === b.requestedTokens &&
    a.expiresAt === b.expiresAt
  );
}

function sameRoute(a: ProviderSendRequest, b: ProviderSendRequest): boolean {
  const x = a.transportEvidence;
  const y = b.transportEvidence;
  return (
    a.providerId === b.providerId &&
    a.modelId === b.modelId &&
    a.signal === b.signal &&
    x?.schema === y?.schema &&
    x?.endpoint === y?.endpoint &&
    x?.method === y?.method &&
    x?.redirect === y?.redirect &&
    x?.adapterAutomaticRetries === y?.adapterAutomaticRetries
  );
}

/** Data snapshot only; retains no authority and never invokes reservation accessors. */
export function snapshotProviderAttemptReservation(
  reservation: ProviderAttemptReservation,
): Readonly<ProviderAttemptReservation> {
  if (!reservation || typeof reservation !== 'object' || nodeTypes.isProxy(reservation))
    return invalidPreparation();
  const descriptors = Object.getOwnPropertyDescriptors(reservation);
  const names = ['reservationId', 'callId', 'authorizedTokens'] as const;
  if (
    Reflect.ownKeys(descriptors).length !== names.length ||
    names.some(
      (name) =>
        !descriptors[name] ||
        !('value' in descriptors[name]!) ||
        typeof descriptors[name]!.value !== 'string',
    )
  )
    return invalidPreparation();
  return Object.freeze({
    reservationId: descriptors.reservationId!.value as string,
    callId: descriptors.callId!.value as string,
    authorizedTokens: descriptors.authorizedTokens!.value as string,
  });
}

export async function observeProviderSendPreparation(
  port: ProviderAttemptPort,
  request: ProviderSendRequest,
  scope: ProviderSendPreparationScope,
): Promise<ProviderSendPreparationObservation> {
  const snapshot = requestSnapshot(request);
  const capturedScope = Object.freeze({
    providerRunId: scope.providerRunId,
    providerAttempt: scope.providerAttempt,
    requestedTokens: scope.requestedTokens,
    expiresAt: scope.expiresAt,
  });
  if (
    typeof capturedScope.providerRunId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(capturedScope.providerRunId) ||
    !Number.isSafeInteger(capturedScope.expiresAt) ||
    capturedScope.expiresAt <= 0
  )
    return invalidPreparation();
  tokenInteger(capturedScope.providerAttempt);
  tokenInteger(capturedScope.requestedTokens);
  // The original host veto still runs first. An unknown production contract
  // cannot mint this observation or reach a Go reservation through this path.
  await prepareProviderSend(port, snapshot);
  const body = requestBody(snapshot);
  const observation = Object.freeze({ kind: 'provider_send_preparation_observation' as const });
  observations.set(observation, {
    port,
    request: snapshot,
    body,
    scope: capturedScope,
    stage: 'prepared',
  });
  return observation;
}

function observationRecord(
  observation: ProviderSendPreparationObservation,
): PreparationObservation {
  if (!observation || typeof observation !== 'object' || nodeTypes.isProxy(observation))
    return invalidPreparation();
  const value = observations.get(observation);
  if (!value) return invalidPreparation();
  return value;
}

/** Binds final bytes and actual grant; this content hash is explicitly unverified. */
export function finalizeProviderSendObservation(
  port: ProviderAttemptPort,
  observation: ProviderSendPreparationObservation,
  reservation: ProviderAttemptReservation,
  request: ProviderSendRequest,
  scope: ProviderSendPreparationScope,
): Readonly<{ schema: 'openslack.provider_observation.v1'; observationHash: string }> {
  const record = observationRecord(observation);
  if (record.stage !== 'prepared') return invalidPreparation();
  // A failed finalization is not reusable with a different reservation or body.
  record.stage = 'consumed';
  const finalRequest = requestSnapshot(request);
  const reservationSnapshot = snapshotProviderAttemptReservation(reservation);
  if (
    record.port !== port ||
    !sameScope(record.scope, scope) ||
    !sameRoute(record.request, finalRequest) ||
    finalizedReservations.has(reservation)
  )
    return invalidPreparation();
  if (Date.now() >= record.scope.expiresAt) throw new ProviderTimeoutError();
  const finalBody = requestBody(finalRequest);
  if (
    (finalBody.max_tokens as number) > (record.body.max_tokens as number) ||
    JSON.stringify({ ...record.body, max_tokens: finalBody.max_tokens }) !==
      finalRequest.requestBytes ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(reservationSnapshot.reservationId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(reservationSnapshot.callId)
  )
    return invalidPreparation();
  // This subtracts the encoded output allocation from the actual grant solely
  // to reject impossible local framing. It does not count complete input or
  // assert what max_tokens covers at a gateway. Positive admission is separate.
  providerTokenHeadroom(
    reservationSnapshot.authorizedTokens,
    String(finalBody.max_tokens),
    record.scope.requestedTokens,
  );
  const observationHash = createHash('sha256')
    .update(
      JSON.stringify({
        domain: 'openslack.provider_observation.v1',
        providerContract: 'unverified',
        scope: record.scope,
        providerId: finalRequest.providerId,
        modelId: finalRequest.modelId,
        transport: finalRequest.transportEvidence,
        preparedBytes: record.request.requestBytes,
        finalBytes: finalRequest.requestBytes,
        reservation: reservationSnapshot,
      }),
    )
    .digest('hex');
  Object.assign(record, {
    stage: 'finalized',
    reservation,
    reservationSnapshot,
    finalRequest,
    observationHash,
  });
  finalizedReservations.add(reservation);
  return Object.freeze({ schema: 'openslack.provider_observation.v1' as const, observationHash });
}

/** Recheck retained mutable reservation data after the independent host await. */
export function consumeProviderSendObservation(
  port: ProviderAttemptPort,
  observation: ProviderSendPreparationObservation,
  reservation: ProviderAttemptReservation,
  request: ProviderSendRequest,
  scope: ProviderSendPreparationScope,
): void {
  const record = observationRecord(observation);
  if (record.stage !== 'finalized') return invalidPreparation();
  record.stage = 'consumed';
  const reservationSnapshot = snapshotProviderAttemptReservation(reservation);
  if (
    record.port !== port ||
    record.reservation !== reservation ||
    !sameScope(record.scope, scope) ||
    !sameRoute(record.finalRequest!, request) ||
    record.finalRequest!.requestBytes !== request.requestBytes ||
    record.reservationSnapshot!.reservationId !== reservationSnapshot.reservationId ||
    record.reservationSnapshot!.callId !== reservationSnapshot.callId ||
    record.reservationSnapshot!.authorizedTokens !== reservationSnapshot.authorizedTokens
  )
    return invalidPreparation();
}

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
