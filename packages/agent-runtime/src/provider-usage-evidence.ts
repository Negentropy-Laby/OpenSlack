import { createHash } from 'node:crypto';
import { types as utilTypes } from 'node:util';

export const PROVIDER_USAGE_RECEIPT_SCHEMA = 'openslack.provider_usage_receipt.v1' as const;
export const PROVIDER_USAGE_EVIDENCE_MAX_ENTRIES = 32;
export const PROVIDER_USAGE_EVIDENCE_MAX_BYTES = 132 * 1024;

const RECEIPT_DOMAIN = 'openslack.provider-usage-receipt.v1';
const PROVIDER_DOMAIN = 'openslack.provider-usage-provider.v1';
const MODEL_DOMAIN = 'openslack.provider-usage-model.v1';
const RUN_DOMAIN = 'openslack.provider-usage-run.v1';
const REQUEST_DOMAIN = 'openslack.provider-usage-request.v1';
const OUTCOME_DOMAIN = 'openslack.provider-usage-outcome.v1';
const MAX_RECEIPT_BYTES = 4 * 1024;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]{0,18})$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type ProviderUsageStatus = 'reported' | 'unreported';
/** Provider transport/protocol outcome; never an agent turn or business authorization result. */
export type ProviderUsageOutcome = 'provider_response_accepted' | 'provider_attempt_failed';

/**
 * Bounded, content-free evidence for one real provider attempt.
 *
 * Provider/model/run/request/response material is represented only by
 * domain-separated hashes. The receipt never contains an endpoint,
 * credential, prompt, response, transcript, or binary floating-point cost.
 */
export interface ProviderUsageReceipt {
  schema: typeof PROVIDER_USAGE_RECEIPT_SCHEMA;
  providerHash: string;
  modelHash: string;
  runHash: string;
  attempt: string;
  calls: '1';
  /** Whether the provider supplied trusted, internally consistent token counts. */
  status: ProviderUsageStatus;
  inputTokens: string | null;
  outputTokens: string | null;
  totalTokens: string | null;
  /**
   * Transport/protocol outcome only. Budget settlement must use trusted status,
   * totalTokens, and receiptHash; this field never authorizes an agent action.
   */
  outcome: ProviderUsageOutcome;
  requestHash: string;
  outcomeHash: string;
  receiptHash: string;
}

export interface ProviderUsageIdentityHashes {
  providerHash: string;
  modelHash: string;
  /** Hash of the agent-runtime run ID, which is distinct from a Workflow run ID. */
  runHash: string;
}

export interface ProviderTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number;
}

export interface BuildProviderUsageReceiptInput {
  providerId: string;
  modelId: string;
  runId: string;
  attempt: number;
  status: ProviderUsageStatus;
  usage: ProviderTokenUsage | null;
  outcome: ProviderUsageOutcome;
  requestBytes: string;
  outcomeBytes: string;
}

export type ProviderUsageEvidenceInspection =
  | { readonly status: 'absent'; readonly receipts: readonly [] }
  | { readonly status: 'valid'; readonly receipts: readonly ProviderUsageReceipt[] }
  | { readonly status: 'invalid'; readonly receipts: readonly [] };

/**
 * Computes the exact hash-only identity a future reserve must bind before a
 * provider attempt starts. The run ID here is the agent-runtime run ID, not a
 * Workflow run ID.
 */
export function buildProviderUsageIdentityHashes(
  providerId: string,
  modelId: string,
  runId: string,
): ProviderUsageIdentityHashes {
  assertBoundedIdentity(providerId, 'providerId');
  assertBoundedIdentity(modelId, 'modelId');
  assertBoundedIdentity(runId, 'runId');
  return Object.freeze({
    providerHash: hashDomainValue(PROVIDER_DOMAIN, providerId),
    modelHash: hashDomainValue(MODEL_DOMAIN, modelId),
    runHash: hashDomainValue(RUN_DOMAIN, runId),
  });
}

export function buildProviderUsageReceipt(
  input: BuildProviderUsageReceiptInput,
): ProviderUsageReceipt {
  const identity = buildProviderUsageIdentityHashes(input.providerId, input.modelId, input.runId);
  if (!Number.isSafeInteger(input.attempt) || input.attempt <= 0) {
    throw new TypeError('Provider usage attempt must be a positive safe integer.');
  }
  if (input.status === 'reported' && input.usage === null) {
    throw new TypeError('Reported provider usage requires token usage.');
  }
  if (input.status === 'unreported' && input.usage !== null) {
    throw new TypeError('Unreported provider usage must not claim token usage.');
  }

  const unsigned = {
    schema: PROVIDER_USAGE_RECEIPT_SCHEMA,
    ...identity,
    attempt: canonicalNonNegativeInt(input.attempt, 'attempt'),
    calls: '1' as const,
    status: input.status,
    inputTokens:
      input.usage?.inputTokens === undefined
        ? null
        : canonicalNonNegativeInt(input.usage.inputTokens, 'inputTokens'),
    outputTokens:
      input.usage?.outputTokens === undefined
        ? null
        : canonicalNonNegativeInt(input.usage.outputTokens, 'outputTokens'),
    totalTokens:
      input.usage === null ? null : canonicalNonNegativeInt(input.usage.totalTokens, 'totalTokens'),
    outcome: input.outcome,
    requestHash: hashDomainValue(REQUEST_DOMAIN, input.requestBytes),
    outcomeHash: hashDomainValue(OUTCOME_DOMAIN, input.outcomeBytes),
  };
  const receipt: ProviderUsageReceipt = {
    ...unsigned,
    receiptHash: hashDomainValue(RECEIPT_DOMAIN, canonicalJson(unsigned)),
  };
  assertProviderUsageReceipt(receipt);
  return Object.freeze(receipt);
}

export function assertProviderUsageReceipt(value: unknown): asserts value is ProviderUsageReceipt {
  const receipt = readPlainDataObject(value, 'Provider usage receipt');
  const expectedKeys = [
    'attempt',
    'calls',
    'inputTokens',
    'modelHash',
    'outcome',
    'outcomeHash',
    'outputTokens',
    'providerHash',
    'receiptHash',
    'requestHash',
    'runHash',
    'schema',
    'status',
    'totalTokens',
  ];
  if (canonicalJson(Object.keys(receipt).sort(compareCodePoints)) !== canonicalJson(expectedKeys)) {
    throw new TypeError('Provider usage receipt fields are invalid.');
  }
  const typed = receipt as unknown as ProviderUsageReceipt;
  if (receipt.schema !== PROVIDER_USAGE_RECEIPT_SCHEMA || receipt.calls !== '1') {
    throw new TypeError('Provider usage receipt contract is invalid.');
  }
  for (const key of [
    'providerHash',
    'modelHash',
    'runHash',
    'requestHash',
    'outcomeHash',
    'receiptHash',
  ]) {
    if (typeof receipt[key] !== 'string' || !HASH_PATTERN.test(receipt[key])) {
      throw new TypeError(`Provider usage receipt ${key} is invalid.`);
    }
  }
  assertCanonicalDecimal(receipt.attempt, 'attempt', false);
  if (receipt.status !== 'reported' && receipt.status !== 'unreported') {
    throw new TypeError('Provider usage receipt status is invalid.');
  }
  if (
    receipt.outcome !== 'provider_response_accepted' &&
    receipt.outcome !== 'provider_attempt_failed'
  ) {
    throw new TypeError('Provider usage receipt outcome is invalid.');
  }
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) {
    if (receipt[key] !== null) assertCanonicalDecimal(receipt[key], key, true);
  }
  if (receipt.status === 'reported' && receipt.totalTokens === null) {
    throw new TypeError('Reported provider usage must include totalTokens.');
  }
  if (
    receipt.status === 'unreported' &&
    (receipt.inputTokens !== null || receipt.outputTokens !== null || receipt.totalTokens !== null)
  ) {
    throw new TypeError('Unreported provider usage must not claim token counts.');
  }
  if (typed.inputTokens !== null && typed.outputTokens !== null) {
    if (BigInt(typed.inputTokens) + BigInt(typed.outputTokens) !== BigInt(typed.totalTokens!)) {
      throw new TypeError('Provider usage token counts are inconsistent.');
    }
  }
  const { receiptHash: _receiptHash, ...unsigned } = typed;
  const expectedHash = hashDomainValue(RECEIPT_DOMAIN, canonicalJson(unsigned));
  if (receipt.receiptHash !== expectedHash) {
    throw new TypeError('Provider usage receipt hash is invalid.');
  }
  if (Buffer.byteLength(canonicalJson(receipt)) > MAX_RECEIPT_BYTES) {
    throw new TypeError('Provider usage receipt exceeds the byte bound.');
  }
}

export function getProviderUsageEvidence(error: unknown): readonly ProviderUsageReceipt[] {
  const inspection = inspectAttachedProviderUsageEvidence(error);
  return inspection.status === 'valid' ? inspection.receipts : [];
}

export function inspectProviderUsageEvidence(value: unknown): ProviderUsageEvidenceInspection {
  if (value === undefined) return { status: 'absent', receipts: [] };
  try {
    return {
      status: 'valid',
      receipts: Object.freeze(readProviderUsageEvidenceArray(value)),
    };
  } catch {
    return { status: 'invalid', receipts: [] };
  }
}

export function inspectAttachedProviderUsageEvidence(
  error: unknown,
): ProviderUsageEvidenceInspection {
  if (!error || typeof error !== 'object') {
    return { status: 'absent', receipts: [] };
  }
  if (utilTypes.isProxy(error)) return { status: 'invalid', receipts: [] };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'usageEvidence');
    if (!descriptor) return { status: 'absent', receipts: [] };
    if (!('value' in descriptor)) return { status: 'invalid', receipts: [] };
    return inspectProviderUsageEvidence(descriptor.value);
  } catch {
    return { status: 'invalid', receipts: [] };
  }
}

export function assertProviderUsageEvidence(
  value: unknown,
): asserts value is readonly ProviderUsageReceipt[] {
  readProviderUsageEvidenceArray(value);
}

export function attachProviderUsageEvidence(
  error: unknown,
  receipts: readonly ProviderUsageReceipt[],
): void {
  tryAttachProviderUsageEvidence(error, receipts);
}

export function tryAttachProviderUsageEvidence(
  error: unknown,
  receipts: readonly ProviderUsageReceipt[],
): boolean {
  if (!error || typeof error !== 'object' || utilTypes.isProxy(error)) return false;
  try {
    const validated = readProviderUsageEvidenceArray(receipts);
    if (validated.length === 0) return true;
    Object.defineProperty(error, 'usageEvidence', {
      value: Object.freeze(validated),
      enumerable: false,
      configurable: true,
    });
    return true;
  } catch {
    return false;
  }
}

function readProviderUsageEvidenceArray(value: unknown): ProviderUsageReceipt[] {
  const entries = readPlainDataArray(value, 'Provider usage evidence');
  if (entries.length > PROVIDER_USAGE_EVIDENCE_MAX_ENTRIES) {
    throw new TypeError(
      `Provider usage evidence supports at most ${PROVIDER_USAGE_EVIDENCE_MAX_ENTRIES} attempts.`,
    );
  }
  let totalBytes = 2;
  const receipts = entries.map((entry, index) => {
    assertProviderUsageReceipt(entry);
    const receipt = entry as ProviderUsageReceipt;
    if (receipt.attempt !== String(index + 1)) {
      throw new TypeError('Provider usage evidence attempts are not ordered and contiguous.');
    }
    totalBytes += Buffer.byteLength(canonicalJson(receipt)) + (index === 0 ? 0 : 1);
    return receipt;
  });
  if (totalBytes > PROVIDER_USAGE_EVIDENCE_MAX_BYTES) {
    throw new TypeError('Provider usage evidence exceeds the total byte bound.');
  }
  return receipts;
}

function assertBoundedIdentity(value: string, name: string): void {
  if (!value || Buffer.byteLength(value) > 512) {
    throw new TypeError(`Provider usage ${name} is invalid.`);
  }
}

function canonicalNonNegativeInt(value: number, name: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Provider usage ${name} must be a non-negative safe integer.`);
  }
  return String(value);
}

function assertCanonicalDecimal(value: unknown, name: string, allowZero: boolean): void {
  if (typeof value !== 'string' || !DECIMAL_PATTERN.test(value)) {
    throw new TypeError(`Provider usage receipt ${name} is not canonical.`);
  }
  const parsed = BigInt(value);
  if (parsed > MAX_INT64 || (!allowZero && parsed === 0n)) {
    throw new TypeError(`Provider usage receipt ${name} is out of range.`);
  }
}

function hashDomainValue(domain: string, value: string): string {
  return `sha256:${createHash('sha256').update(domain).update('\0').update(value).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${readPlainDataArray(value, 'Canonical JSON array')
      .map((entry) => canonicalJson(entry))
      .join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(readPlainDataObject(value, 'Canonical JSON object'))
      .sort(([left], [right]) => compareCodePoints(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new TypeError('Provider usage receipt contains a non-JSON value.');
}

function readPlainDataObject(value: unknown, name: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new TypeError(`${name} must be a non-proxied plain object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new TypeError(`${name} must not contain symbol keys.`);
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${name} must contain only enumerable data properties.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function readPlainDataArray(value: unknown, name: string): unknown[] {
  if (
    !Array.isArray(value) ||
    utilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${name} must be a non-proxied plain array.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const lengthDescriptor = descriptors.length;
  if (
    !lengthDescriptor ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number'
  ) {
    throw new TypeError(`${name} length is invalid.`);
  }
  const length = lengthDescriptor.value;
  const expectedKeys = new Set([
    'length',
    ...Array.from({ length }, (_entry, index) => String(index)),
  ]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !expectedKeys.has(key)) {
      throw new TypeError(`${name} contains unsupported properties.`);
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${name} must contain only dense data elements.`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
