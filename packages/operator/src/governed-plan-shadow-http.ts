import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import {
  GOVERNANCE_SHADOW_POLICY,
  GOVERNANCE_SHADOW_RECEIPT_SCHEMA,
  createGovernanceShadowPublisherPort,
  prepareGovernanceShadowRequest,
  type GovernanceShadowEnvelope,
  type GovernanceShadowPublisherPort,
  type GovernanceShadowReceipt,
} from './governed-plan-shadow.js';
import { canonicalGovernedJson } from './governed-plan.js';

type GovernanceShadowFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface GovernanceShadowHttpPublisherOptions {
  readonly origin: string;
  readonly networkMode?: 'loopback' | 'internal';
  readonly timeoutMs?: number;
  readonly maxReceiptBytes?: number;
  readonly orderingRetryDelayMs?: number;
  readonly fetch?: GovernanceShadowFetch;
}

export class GovernanceShadowHttpError extends Error {
  constructor(
    readonly code:
      | 'GOVERNANCE_SHADOW_POLICY_INVALID'
      | 'GOVERNANCE_SHADOW_TIMEOUT'
      | 'GOVERNANCE_SHADOW_NETWORK_ERROR'
      | 'GOVERNANCE_SHADOW_HTTP_ERROR'
      | 'GOVERNANCE_SHADOW_RECEIPT_INVALID'
      | 'GOVERNANCE_SHADOW_CONFLICT',
    message: string,
  ) {
    super(message);
    this.name = 'GovernanceShadowHttpError';
  }
}

function positiveInteger(value: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new GovernanceShadowHttpError(
      'GOVERNANCE_SHADOW_POLICY_INVALID',
      `${name} must be a positive integer no greater than ${maximum}.`,
    );
  }
  return value;
}

function ipv4Parts(address: string): readonly number[] {
  return address.split('.').map(Number);
}

function isLoopback(address: string, version: number): boolean {
  if (version === 4) return ipv4Parts(address)[0] === 127;
  return address.toLowerCase() === '::1';
}

function isInternal(address: string, version: number): boolean {
  if (isLoopback(address, version)) return true;
  if (version === 4) {
    const [first, second] = ipv4Parts(address);
    return (
      first === 10 ||
      (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254)
    );
  }
  const normalized = address.toLowerCase();
  const first = Number.parseInt(normalized.split(':')[0] ?? '', 16);
  return (
    (Number.isFinite(first) && (first & 0xfe00) === 0xfc00) ||
    (Number.isFinite(first) && (first & 0xffc0) === 0xfe80)
  );
}

function normalizeOrigin(value: string, networkMode: 'loopback' | 'internal'): string {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    throw new GovernanceShadowHttpError(
      'GOVERNANCE_SHADOW_POLICY_INVALID',
      'Governance shadow origin must be an absolute HTTP URL.',
    );
  }
  const address =
    origin.hostname.startsWith('[') && origin.hostname.endsWith(']')
      ? origin.hostname.slice(1, -1)
      : origin.hostname;
  const version = isIP(address);
  if (
    origin.protocol !== 'http:' ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.search !== '' ||
    origin.hash !== '' ||
    (origin.pathname !== '/' && origin.pathname !== '') ||
    version === 0 ||
    (networkMode === 'loopback' ? !isLoopback(address, version) : !isInternal(address, version))
  ) {
    throw new GovernanceShadowHttpError(
      'GOVERNANCE_SHADOW_POLICY_INVALID',
      'Governance shadow origin must be an allowed IP-literal HTTP origin.',
    );
  }
  return origin.origin;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseReceipt(
  bytes: Uint8Array,
  envelope: GovernanceShadowEnvelope,
  idempotencyKey: string,
  requestFingerprint: string,
): GovernanceShadowReceipt | null {
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    `${canonicalGovernedJson(parsed as never)}\n` !== text
  ) {
    return null;
  }
  const object = parsed as Readonly<Record<string, unknown>>;
  const required = [
    'schema',
    'operation',
    'status',
    'parity',
    'idempotencyKey',
    'requestFingerprint',
    'workspaceId',
    'planId',
    'sourceSequence',
    'observationKind',
    'observationDigest',
  ];
  const optional = ['mismatchCode', 'committedAt', 'reconciliationToken'];
  const keys = Object.keys(object);
  if (
    !required.every((key) => Object.hasOwn(object, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key)) ||
    object.schema !== GOVERNANCE_SHADOW_RECEIPT_SCHEMA ||
    object.operation !== 'observation_ingest' ||
    !['accepted', 'duplicate', 'reconciliation_required'].includes(String(object.status)) ||
    !['matched', 'mismatched', 'unknown'].includes(String(object.parity)) ||
    object.idempotencyKey !== idempotencyKey ||
    object.requestFingerprint !== requestFingerprint ||
    object.workspaceId !== envelope.source.workspaceId ||
    object.planId !== envelope.source.planId ||
    object.sourceSequence !== envelope.source.sourceSequence ||
    object.observationKind !== envelope.observation.kind ||
    object.observationDigest !== createDigest(prepareGovernanceShadowRequest(envelope).body) ||
    (object.mismatchCode !== undefined &&
      (typeof object.mismatchCode !== 'string' ||
        object.mismatchCode.length < 1 ||
        !/^[a-z0-9][a-z0-9._:-]{0,255}$/u.test(object.mismatchCode)))
  ) {
    return null;
  }
  const reconciles = object.status === 'reconciliation_required';
  const mismatched = object.parity === 'mismatched';
  if (
    reconciles
      ? object.parity !== 'unknown' ||
        object.mismatchCode !== undefined ||
        typeof object.reconciliationToken !== 'string' ||
        object.committedAt !== undefined
      : (object.parity !== 'matched' && !mismatched) ||
        (mismatched ? object.mismatchCode === undefined : object.mismatchCode !== undefined) ||
        typeof object.committedAt !== 'string' ||
        object.reconciliationToken !== undefined
  ) {
    return null;
  }
  if (
    typeof object.committedAt === 'string' &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(object.committedAt) ||
      !Number.isFinite(Date.parse(object.committedAt)))
  ) {
    return null;
  }
  return Object.freeze({
    schema: GOVERNANCE_SHADOW_RECEIPT_SCHEMA,
    operation: 'observation_ingest',
    status: object.status as GovernanceShadowReceipt['status'],
    parity: object.parity as GovernanceShadowReceipt['parity'],
    idempotencyKey,
    requestFingerprint,
    workspaceId: envelope.source.workspaceId,
    planId: envelope.source.planId,
    sourceSequence: envelope.source.sourceSequence,
    observationKind: envelope.observation.kind,
    observationDigest: object.observationDigest as string,
    ...(object.mismatchCode === undefined ? {} : { mismatchCode: object.mismatchCode as string }),
    ...(object.committedAt === undefined ? {} : { committedAt: object.committedAt as string }),
    ...(object.reconciliationToken === undefined
      ? {}
      : { reconciliationToken: object.reconciliationToken as string }),
  });
}

function createDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A rejected body is already unusable.
  }
}

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get('Content-Length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > maximum) {
    await cancelBody(response);
    throw new GovernanceShadowHttpError(
      'GOVERNANCE_SHADOW_RECEIPT_INVALID',
      'Governance shadow receipt exceeds the declared byte limit.',
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new GovernanceShadowHttpError(
          'GOVERNANCE_SHADOW_RECEIPT_INVALID',
          'Governance shadow receipt exceeds the byte limit.',
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function createGovernanceShadowHttpPublisher(
  options: GovernanceShadowHttpPublisherOptions,
): GovernanceShadowPublisherPort {
  const networkMode = options.networkMode ?? 'loopback';
  if (networkMode !== 'loopback' && networkMode !== 'internal') {
    throw new GovernanceShadowHttpError(
      'GOVERNANCE_SHADOW_POLICY_INVALID',
      'Governance shadow network mode is invalid.',
    );
  }
  const origin = normalizeOrigin(options.origin, networkMode);
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? GOVERNANCE_SHADOW_POLICY.defaultTimeoutMs,
    GOVERNANCE_SHADOW_POLICY.maxTimeoutMs,
    'timeoutMs',
  );
  const maxReceiptBytes = positiveInteger(
    options.maxReceiptBytes ?? GOVERNANCE_SHADOW_POLICY.maxReceiptBytes,
    GOVERNANCE_SHADOW_POLICY.maxReceiptBytes,
    'maxReceiptBytes',
  );
  const orderingRetryDelayMs = positiveInteger(
    options.orderingRetryDelayMs ?? GOVERNANCE_SHADOW_POLICY.defaultOrderingRetryDelayMs,
    GOVERNANCE_SHADOW_POLICY.maxOrderingRetryDelayMs,
    'orderingRetryDelayMs',
  );
  const transport = options.fetch ?? fetch;
  return createGovernanceShadowPublisherPort(async (envelope) => {
    const request = prepareGovernanceShadowRequest(envelope);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for (
        let attempt = 1;
        attempt <= GOVERNANCE_SHADOW_POLICY.orderingRetryAttempts;
        attempt += 1
      ) {
        let response: Response;
        try {
          response = await transport(`${origin}/v1/shadow/governance/observations`, {
            method: 'POST',
            redirect: 'manual',
            headers: {
              Accept: 'application/json',
              'Content-Type': 'application/json',
              'Idempotency-Key': request.idempotencyKey,
            },
            body: request.body,
            signal: controller.signal,
          });
        } catch {
          throw new GovernanceShadowHttpError(
            controller.signal.aborted
              ? 'GOVERNANCE_SHADOW_TIMEOUT'
              : 'GOVERNANCE_SHADOW_NETWORK_ERROR',
            controller.signal.aborted
              ? 'Governance shadow request exceeded its total deadline.'
              : 'Governance shadow request failed.',
          );
        }
        if (
          (response.status === 404 || response.status === 409) &&
          attempt < GOVERNANCE_SHADOW_POLICY.orderingRetryAttempts
        ) {
          await cancelBody(response);
          await wait(orderingRetryDelayMs, controller.signal);
          if (controller.signal.aborted) {
            throw new GovernanceShadowHttpError(
              'GOVERNANCE_SHADOW_TIMEOUT',
              'Governance shadow request exceeded its total deadline.',
            );
          }
          continue;
        }
        if (response.status === 404 || response.status === 409) {
          await cancelBody(response);
          throw new GovernanceShadowHttpError(
            'GOVERNANCE_SHADOW_CONFLICT',
            'Governance shadow predecessor or sequence is unavailable.',
          );
        }
        if (response.status >= 300 && response.status < 400) {
          await cancelBody(response);
          throw new GovernanceShadowHttpError(
            'GOVERNANCE_SHADOW_HTTP_ERROR',
            'Governance shadow redirects are forbidden.',
          );
        }
        if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
          await cancelBody(response);
          throw new GovernanceShadowHttpError(
            'GOVERNANCE_SHADOW_HTTP_ERROR',
            'Governance shadow returned an unexpected HTTP status.',
          );
        }
        const contentType = response.headers.get('Content-Type');
        if (
          contentType === null ||
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType.trim())
        ) {
          await cancelBody(response);
          throw new GovernanceShadowHttpError(
            'GOVERNANCE_SHADOW_RECEIPT_INVALID',
            'Governance shadow receipt content type is invalid.',
          );
        }
        const receipt = parseReceipt(
          await readBoundedBody(response, maxReceiptBytes),
          envelope,
          request.idempotencyKey,
          request.requestFingerprint,
        );
        if (
          receipt === null ||
          (receipt.status === 'accepted'
            ? response.status !== 201
            : receipt.status === 'duplicate'
              ? response.status !== 200
              : response.status !== 202)
        ) {
          throw new GovernanceShadowHttpError(
            'GOVERNANCE_SHADOW_RECEIPT_INVALID',
            'Governance shadow receipt does not bind the request.',
          );
        }
        if (receipt.status === 'reconciliation_required') {
          throw new GovernanceShadowHttpError(
            'GOVERNANCE_SHADOW_CONFLICT',
            'Governance shadow completion is ambiguous and requires reconciliation.',
          );
        }
        return receipt;
      }
      throw new GovernanceShadowHttpError(
        'GOVERNANCE_SHADOW_CONFLICT',
        'Governance shadow ordering retry limit was exhausted.',
      );
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });
}
