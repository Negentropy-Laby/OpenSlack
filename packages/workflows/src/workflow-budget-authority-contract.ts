import { createHash } from 'node:crypto';
import {
  canonicalUtcTimestamp,
  closedDataRecord,
  immutableContractValue,
  ownDataField,
  type ContractDataRecord,
} from './internal/contract-validation.js';
import { canonicalWorkflowEffectJson, parseWorkflowEffectJson } from './workflow-effect-json.js';

export const WORKFLOW_BUDGET_AUTHORITY_CONTRACT_VERSION = 'v1' as const;
export const WORKFLOW_BUDGET_AUTHORITY = 'typescript' as const;
export const WORKFLOW_BUDGET_AUTHORITY_WRITER = '@openslack/workflows' as const;
export const WORKFLOW_BUDGET_AUTHORITY_GO_ROLE = 'validator_only' as const;
export const WORKFLOW_BUDGET_AUTHORITY_GO_CLAIM = 'NO_AUTHORITY' as const;
export const WORKFLOW_BUDGET_AUTHORITY_MAX_INT64 = '9223372036854775807' as const;
export const WORKFLOW_BUDGET_AUTHORITY_MONEY_UNIT = 'nano_usd' as const;
export const WORKFLOW_BUDGET_AUTHORITY_MONEY_SCALE = 9 as const;
export const WORKFLOW_BUDGET_AUTHORITY_ROUNDING = 'half_up_nonnegative' as const;
export const WORKFLOW_BUDGET_AUTHORITY_IDEMPOTENCY_PREFIX =
  'openslack.workflow-budget-authority.v1.' as const;
export const WORKFLOW_BUDGET_AUTHORITY_V2_MANIFEST_SHA256 =
  '2ce5364708165611d0629d293c8ffb9ddd1f6cb7a37b78ded3163e0bdd58c877' as const;
export const WORKFLOW_BUDGET_AUTHORITY_V2_GOLDEN_SHA256 =
  '6cb37581c70a6ec83a66c8e0be5dc66e594aaa97488c6fdae6bbccf00ec5420f' as const;
export const WORKFLOW_BUDGET_RUNNER_V1_MANIFEST_SHA256 =
  '908ff368f35033206b975a0421396f49e588098f040aecef2fdd18cd8b67ece6' as const;
export const WORKFLOW_BUDGET_RUNNER_V1_GOLDEN_SHA256 =
  'b4569ca9e9e3f9b027c1bf3d531760ca9fbf87ecd3f7818204eca367a7fce844' as const;

export const WORKFLOW_BUDGET_ACCOUNT_SCHEMA = 'openslack.workflow_budget_account.v1' as const;
export const WORKFLOW_BUDGET_RESERVE_REQUEST_SCHEMA =
  'openslack.workflow_budget_reserve_request.v1' as const;
export const WORKFLOW_BUDGET_RESERVE_DECISION_SCHEMA =
  'openslack.workflow_budget_reserve_decision.v1' as const;
export const WORKFLOW_BUDGET_RESERVATION_SCHEMA =
  'openslack.workflow_budget_reservation.v1' as const;
export const WORKFLOW_BUDGET_PROVIDER_USAGE_SCHEMA = 'openslack.provider_usage_receipt.v1' as const;
export const WORKFLOW_BUDGET_SETTLEMENT_REQUEST_SCHEMA =
  'openslack.workflow_budget_settlement_request.v1' as const;
export const WORKFLOW_BUDGET_SETTLEMENT_SCHEMA = 'openslack.workflow_budget_settlement.v1' as const;
export const WORKFLOW_BUDGET_LEDGER_ENTRY_SCHEMA =
  'openslack.workflow_budget_ledger_entry.v1' as const;
export const WORKFLOW_BUDGET_RECEIPT_SCHEMA = 'openslack.workflow_budget_receipt.v1' as const;
export const WORKFLOW_BUDGET_PREPARED_REQUEST_SCHEMA =
  'openslack.workflow_budget_prepared_request.v1' as const;
export const WORKFLOW_BUDGET_RECONCILIATION_SCHEMA =
  'openslack.workflow_budget_reconciliation.v1' as const;
export const WORKFLOW_BUDGET_LEGACY_APPROVAL_SCHEMA =
  'openslack.workflow_budget_legacy_approval_observation.v1' as const;
export const WORKFLOW_BUDGET_RESERVE_ROUTE = '/v1/authority/workflow-budgets:reserve' as const;
export const WORKFLOW_BUDGET_SETTLE_ROUTE = '/v1/authority/workflow-budgets:settle' as const;

export const WORKFLOW_BUDGET_AUTHORITY_DIMENSIONS = Object.freeze([
  'tokens',
  'nano_usd',
  'calls',
] as const);
export const WORKFLOW_BUDGET_AUTHORITY_LEDGER_KINDS = Object.freeze([
  'reserve_reserved',
  'reserve_rejected',
  'settlement_settled',
  'settlement_reconciliation_required',
] as const);
export const WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS = Object.freeze([
  'provider_outcome_unknown',
  'usage_receipt_missing',
  'usage_receipt_untrusted',
  'usage_overrun',
] as const);
export const WORKFLOW_BUDGET_AUTHORITY_DATABASE_RECONCILIATION_REASONS = Object.freeze([
  'database_commit_outcome_unknown',
] as const);
export const WORKFLOW_BUDGET_AUTHORITY_ERROR_CODES = Object.freeze([
  'WORKFLOW_BUDGET_AUTHORITY_INVALID',
  'WORKFLOW_BUDGET_AUTHORITY_UNKNOWN_FIELD',
  'WORKFLOW_BUDGET_AUTHORITY_LIMIT_EXCEEDED',
  'WORKFLOW_BUDGET_AUTHORITY_INVALID_DECIMAL',
  'WORKFLOW_BUDGET_AUTHORITY_DECIMAL_OVERFLOW',
  'WORKFLOW_BUDGET_AUTHORITY_HASH_MISMATCH',
  'WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH',
  'WORKFLOW_BUDGET_AUTHORITY_POLICY_DRIFT',
  'WORKFLOW_BUDGET_AUTHORITY_ROUTE_DRIFT',
  'WORKFLOW_BUDGET_AUTHORITY_STALE_REVISION',
  'WORKFLOW_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED',
  'WORKFLOW_BUDGET_AUTHORITY_LEGACY_APPROVAL_NO_AUTHORITY',
] as const);
export type WorkflowBudgetAuthorityErrorCode =
  (typeof WORKFLOW_BUDGET_AUTHORITY_ERROR_CODES)[number];

export const WORKFLOW_BUDGET_AUTHORITY_LIMITS = Object.freeze({
  maxAccountBytes: 64 * 1024,
  maxRecordBytes: 256 * 1024,
  maxJsonDepth: 16,
  maxJsonNodes: 4_096,
  maxIdentifierBytes: 256,
  maxDecimalBytes: 19,
  maxRateDecimalBytes: 64,
  maxRateFractionDigits: 18,
  maxSafeInteger: Number.MAX_SAFE_INTEGER,
} as const);

export class WorkflowBudgetAuthorityContractError extends Error {
  constructor(
    readonly code: WorkflowBudgetAuthorityErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowBudgetAuthorityContractError';
  }
}

export interface WorkflowBudgetQuantities {
  readonly tokens: string;
  readonly nanoUsd: string;
  readonly calls: string;
}

export interface WorkflowBudgetRoute {
  readonly backend: 'ts-local' | 'go';
  readonly authority: 'typescript' | 'workflow-control';
  readonly routingEpoch: number;
  readonly authorityBuildHash: string;
}

interface WorkflowBudgetAuthorityBase {
  readonly contractVersion: typeof WORKFLOW_BUDGET_AUTHORITY_CONTRACT_VERSION;
  readonly authority: typeof WORKFLOW_BUDGET_AUTHORITY;
  readonly writer: typeof WORKFLOW_BUDGET_AUTHORITY_WRITER;
  readonly goRole: typeof WORKFLOW_BUDGET_AUTHORITY_GO_ROLE;
  readonly goAuthorityClaim: typeof WORKFLOW_BUDGET_AUTHORITY_GO_CLAIM;
  readonly goAuthorityEligible: false;
}

export interface WorkflowBudgetAccount extends WorkflowBudgetAuthorityBase {
  readonly schema: typeof WORKFLOW_BUDGET_ACCOUNT_SCHEMA;
  readonly workspaceId: string;
  readonly runId: string;
  readonly accountId: string;
  readonly policyHash: string;
  readonly route: WorkflowBudgetRoute;
  readonly accountRevision: number;
  readonly runRevision: number;
  readonly limit: WorkflowBudgetQuantities;
  readonly reserved: WorkflowBudgetQuantities;
  readonly settled: WorkflowBudgetQuantities;
  readonly updatedAt: string;
}

export interface WorkflowBudgetReserveRequest extends WorkflowBudgetAuthorityBase {
  readonly schema: typeof WORKFLOW_BUDGET_RESERVE_REQUEST_SCHEMA;
  readonly workspaceId: string;
  readonly runId: string;
  readonly accountId: string;
  readonly reservationId: string;
  readonly callId: string;
  /** One reservation/callId maps to exactly one real provider HTTP attempt/turn. */
  readonly providerAttempt: string;
  readonly expectedProviderHash: string;
  readonly expectedModelHash: string;
  readonly expectedProviderRunHash: string;
  readonly correlationId: string;
  readonly policyHash: string;
  readonly route: WorkflowBudgetRoute;
  readonly expectedAccountRevision: number;
  readonly expectedRunRevision: number;
  readonly rateNanoUsdPerToken: string;
  readonly requested: WorkflowBudgetQuantities;
  readonly requestedAt: string;
}

export interface WorkflowBudgetReserveDecision extends WorkflowBudgetAuthorityBase {
  readonly schema: typeof WORKFLOW_BUDGET_RESERVE_DECISION_SCHEMA;
  readonly status: 'reserved' | 'rejected';
  readonly request: WorkflowBudgetReserveRequest;
  readonly requestHash: string;
  readonly beforeAccountHash: string;
  readonly afterAccount: WorkflowBudgetAccount;
  readonly authorization: WorkflowBudgetQuantities;
  readonly insufficientDimensions: readonly (typeof WORKFLOW_BUDGET_AUTHORITY_DIMENSIONS)[number][];
  readonly legacyBudgetApprovalAuthority: false;
  readonly decidedAt: string;
}

export interface WorkflowBudgetReservation extends WorkflowBudgetAuthorityBase {
  readonly schema: typeof WORKFLOW_BUDGET_RESERVATION_SCHEMA;
  readonly workspaceId: string;
  readonly runId: string;
  readonly accountId: string;
  readonly reservationId: string;
  readonly callId: string;
  readonly providerAttempt: string;
  readonly expectedProviderHash: string;
  readonly expectedModelHash: string;
  readonly expectedProviderRunHash: string;
  readonly policyHash: string;
  readonly route: WorkflowBudgetRoute;
  readonly rateNanoUsdPerToken: string;
  readonly reserved: WorkflowBudgetQuantities;
  readonly reserveDecisionHash: string;
  readonly openedAccountRevision: number;
  readonly openedRunRevision: number;
  readonly openedAt: string;
}

export interface WorkflowBudgetProviderUsage {
  readonly schema: typeof WORKFLOW_BUDGET_PROVIDER_USAGE_SCHEMA;
  readonly providerHash: string;
  readonly modelHash: string;
  readonly runHash: string;
  readonly attempt: string;
  readonly calls: '1';
  readonly status: 'reported' | 'unreported';
  readonly inputTokens: string | null;
  readonly outputTokens: string | null;
  readonly totalTokens: string | null;
  readonly outcome: 'provider_response_accepted' | 'provider_attempt_failed';
  readonly requestHash: string;
  readonly outcomeHash: string;
  readonly receiptHash: string;
}

export interface WorkflowBudgetSettlementRequest extends WorkflowBudgetAuthorityBase {
  readonly schema: typeof WORKFLOW_BUDGET_SETTLEMENT_REQUEST_SCHEMA;
  readonly workspaceId: string;
  readonly runId: string;
  readonly accountId: string;
  readonly reservationId: string;
  readonly callId: string;
  readonly providerAttempt: string;
  readonly expectedProviderHash: string;
  readonly expectedModelHash: string;
  readonly expectedProviderRunHash: string;
  readonly correlationId: string;
  readonly policyHash: string;
  readonly route: WorkflowBudgetRoute;
  readonly expectedAccountRevision: number;
  readonly expectedRunRevision: number;
  readonly reserveDecisionHash: string;
  readonly usageEvidenceStatus: 'trusted' | 'missing' | 'untrusted';
  readonly usageReceiptHash: string | null;
  readonly providerUsage: WorkflowBudgetProviderUsage | null;
  readonly rateNanoUsdPerToken: string;
  readonly requestedAt: string;
}

export interface WorkflowBudgetSettlement extends WorkflowBudgetAuthorityBase {
  readonly schema: typeof WORKFLOW_BUDGET_SETTLEMENT_SCHEMA;
  readonly status: 'settled' | 'reconciliation_required';
  readonly request: WorkflowBudgetSettlementRequest;
  readonly requestHash: string;
  readonly reservation: WorkflowBudgetReservation;
  readonly reservationHash: string;
  readonly beforeAccountHash: string;
  readonly afterAccount: WorkflowBudgetAccount;
  readonly released: WorkflowBudgetQuantities | null;
  readonly reasonCode:
    | (typeof WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS)[number]
    | null;
  readonly reservationRemainsOpen: boolean;
  readonly runReconciliationLatched: boolean;
  readonly providerRetryAuthorized: false;
  readonly cachePublishAuthorized: boolean;
  readonly legacyBudgetApprovalAuthority: false;
  readonly committedAt: string;
}

export interface WorkflowBudgetLedgerEntry extends WorkflowBudgetAuthorityBase {
  readonly schema: typeof WORKFLOW_BUDGET_LEDGER_ENTRY_SCHEMA;
  readonly kind: (typeof WORKFLOW_BUDGET_AUTHORITY_LEDGER_KINDS)[number];
  readonly entryId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly accountId: string;
  readonly reservationId: string;
  readonly callId: string;
  readonly accountRevision: number;
  readonly runRevision: number;
  readonly previousAccountHash: string;
  readonly accountHash: string;
  readonly decisionHash: string;
  readonly encumbered: WorkflowBudgetQuantities;
  readonly settled: WorkflowBudgetQuantities;
  readonly released: WorkflowBudgetQuantities;
  readonly providerUsageHash: string | null;
  readonly reasonCode:
    | (typeof WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS)[number]
    | null;
  readonly recordedAt: string;
}

export interface WorkflowBudgetReceipt extends WorkflowBudgetAuthorityBase {
  readonly schema: typeof WORKFLOW_BUDGET_RECEIPT_SCHEMA;
  readonly operation: 'reserve' | 'settle';
  /** Replay returns these exact durable bytes; transport metadata identifies a replay. */
  readonly status:
    | 'accepted'
    | 'provider_reconciliation_required'
    | 'database_reconciliation_required';
  readonly workspaceId: string;
  readonly runId: string;
  readonly accountId: string;
  readonly reservationId: string;
  readonly callId: string;
  readonly expectedAccountRevision: number;
  readonly acceptedAccountRevision: number | null;
  readonly expectedRunRevision: number;
  readonly acceptedRunRevision: number | null;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly requestHash: string;
  readonly recordHash: string | null;
  readonly ledgerEntryHash: string | null;
  readonly correlationId: string;
  readonly serviceBuildHash: string;
  readonly committedAt: string | null;
  readonly reconciliationToken: string | null;
}

export interface WorkflowBudgetPreparedRequest {
  readonly schema: typeof WORKFLOW_BUDGET_PREPARED_REQUEST_SCHEMA;
  readonly operation: 'reserve' | 'settle';
  readonly method: 'POST';
  readonly path: typeof WORKFLOW_BUDGET_RESERVE_ROUTE | typeof WORKFLOW_BUDGET_SETTLE_ROUTE;
  readonly callerId: string;
  readonly body: string;
  readonly requestHash: string;
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
}

export interface WorkflowBudgetReconciliation extends WorkflowBudgetAuthorityBase {
  readonly schema: typeof WORKFLOW_BUDGET_RECONCILIATION_SCHEMA;
  readonly evidenceType: 'provider_outcome' | 'database_commit';
  readonly reasonCode:
    | (typeof WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS)[number]
    | (typeof WORKFLOW_BUDGET_AUTHORITY_DATABASE_RECONCILIATION_REASONS)[number];
  readonly workspaceId: string;
  readonly runId: string;
  readonly accountId: string;
  readonly reservationId: string;
  readonly callId: string;
  readonly sourceRequestHash: string;
  readonly usageReceiptHash: string | null;
  readonly accountHash: string;
  readonly reservationHash: string;
  readonly reconciliationToken: string;
  readonly accountCountersChanged: false;
  readonly reservationReleaseAuthorized: false;
  readonly providerRetryAuthorized: false;
  readonly cachePublishAuthorized: false;
  readonly runReconciliationLatched: true;
  readonly observedAt: string;
}

export interface WorkflowBudgetLegacyApprovalObservation extends WorkflowBudgetAuthorityBase {
  readonly schema: typeof WORKFLOW_BUDGET_LEGACY_APPROVAL_SCHEMA;
  readonly workspaceId: string;
  readonly runId: string;
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired';
  readonly revision: number;
  readonly semantics: 'run_gate_only';
  readonly limitAmendmentAuthority: false;
  readonly reservationAuthority: false;
  readonly settlementAuthority: false;
  readonly observedAt: string;
}

const HASH = /^[0-9a-f]{64}$/u;
const PREFIXED_HASH = /^sha256:[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const RATE = /^(?:0|[1-9][0-9]*|(?:0|[1-9][0-9]*)\.([0-9]*[1-9]))$/u;
const IDEMPOTENCY = /^openslack\.workflow-budget-authority\.v1\.[0-9a-f]{64}$/u;
const FINGERPRINT = /^sha256:[0-9a-f]{64}$/u;
const MAX_INT64 = BigInt(WORKFLOW_BUDGET_AUTHORITY_MAX_INT64);
const ZERO = immutableContractValue({ tokens: '0', nanoUsd: '0', calls: '0' });

function fail(code: WorkflowBudgetAuthorityErrorCode, path: string, message: string): never {
  throw new WorkflowBudgetAuthorityContractError(code, path, message);
}

const failures = {
  inert: (path: string) =>
    fail('WORKFLOW_BUDGET_AUTHORITY_INVALID', path, `${path} must be inert.`),
  missing: (path: string, field: string) =>
    fail('WORKFLOW_BUDGET_AUTHORITY_INVALID', `${path}/${field}`, `Missing field ${field}.`),
  unknown: (path: string, key: PropertyKey) =>
    fail('WORKFLOW_BUDGET_AUTHORITY_UNKNOWN_FIELD', `${path}/${String(key)}`, 'Unknown field.'),
  dataField: (path: string, key: PropertyKey) =>
    fail('WORKFLOW_BUDGET_AUTHORITY_INVALID', `${path}/${String(key)}`, 'Data field required.'),
};

function closed(value: unknown, fields: readonly string[], path: string): ContractDataRecord {
  return closedDataRecord(value, fields, path, failures);
}

function own(record: ContractDataRecord, key: string): unknown {
  return ownDataField(record, key);
}

function literal<T>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail('WORKFLOW_BUDGET_AUTHORITY_INVALID', path, `${path} is invalid.`);
  return expected;
}

function text(value: unknown, pattern: RegExp, path: string, maxBytes = 256): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    !pattern.test(value)
  ) {
    fail('WORKFLOW_BUDGET_AUTHORITY_INVALID', path, `${path} is invalid.`);
  }
  return value;
}

function id(value: unknown, path: string): string {
  return text(value, ID, path, WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxIdentifierBytes);
}

function hash(value: unknown, path: string): string {
  return text(value, HASH, path, 64);
}

function prefixedHash(value: unknown, path: string): string {
  return text(value, PREFIXED_HASH, path, 71);
}

function timestamp(value: unknown, path: string): string {
  return canonicalUtcTimestamp(
    value,
    path,
    (candidate, candidatePath) => text(candidate, TIMESTAMP, candidatePath, 24),
    (candidatePath) =>
      fail('WORKFLOW_BUDGET_AUTHORITY_INVALID', candidatePath, 'Timestamp is not canonical.'),
  );
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail('WORKFLOW_BUDGET_AUTHORITY_INVALID', path, `${path} must be a safe integer.`);
  }
  return value as number;
}

function booleanLiteral(value: unknown, expected: boolean, path: string): boolean {
  return literal(value, expected, path);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    fail('WORKFLOW_BUDGET_AUTHORITY_INVALID', path, `${path} is outside the closed vocabulary.`);
  }
  return value as T[number];
}

function authorityBase(record: ContractDataRecord, path: string): WorkflowBudgetAuthorityBase {
  return immutableContractValue({
    contractVersion: literal(
      own(record, 'contractVersion'),
      WORKFLOW_BUDGET_AUTHORITY_CONTRACT_VERSION,
      `${path}/contractVersion`,
    ),
    authority: literal(own(record, 'authority'), WORKFLOW_BUDGET_AUTHORITY, `${path}/authority`),
    writer: literal(own(record, 'writer'), WORKFLOW_BUDGET_AUTHORITY_WRITER, `${path}/writer`),
    goRole: literal(own(record, 'goRole'), WORKFLOW_BUDGET_AUTHORITY_GO_ROLE, `${path}/goRole`),
    goAuthorityClaim: literal(
      own(record, 'goAuthorityClaim'),
      WORKFLOW_BUDGET_AUTHORITY_GO_CLAIM,
      `${path}/goAuthorityClaim`,
    ),
    goAuthorityEligible: booleanLiteral(
      own(record, 'goAuthorityEligible'),
      false,
      `${path}/goAuthorityEligible`,
    ) as false,
  });
}

const BASE_FIELDS = [
  'contractVersion',
  'authority',
  'writer',
  'goRole',
  'goAuthorityClaim',
  'goAuthorityEligible',
] as const;

export function validateWorkflowBudgetAuthorityDecimal(value: unknown, path = '$'): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxDecimalBytes ||
    !DECIMAL.test(value)
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_INVALID_DECIMAL',
      path,
      `${path} must be a canonical non-negative decimal integer.`,
    );
  }
  if (BigInt(value) > MAX_INT64) {
    fail('WORKFLOW_BUDGET_AUTHORITY_DECIMAL_OVERFLOW', path, `${path} exceeds int64.`);
  }
  return value;
}

function quantities(value: unknown, path: string): WorkflowBudgetQuantities {
  const record = closed(value, ['tokens', 'nanoUsd', 'calls'], path);
  return immutableContractValue({
    tokens: validateWorkflowBudgetAuthorityDecimal(own(record, 'tokens'), `${path}/tokens`),
    nanoUsd: validateWorkflowBudgetAuthorityDecimal(own(record, 'nanoUsd'), `${path}/nanoUsd`),
    calls: validateWorkflowBudgetAuthorityDecimal(own(record, 'calls'), `${path}/calls`),
  });
}

function route(value: unknown, path: string): WorkflowBudgetRoute {
  const record = closed(
    value,
    ['backend', 'authority', 'routingEpoch', 'authorityBuildHash'],
    path,
  );
  const backend = enumValue(own(record, 'backend'), ['ts-local', 'go'] as const, `${path}/backend`);
  const authority = enumValue(
    own(record, 'authority'),
    ['typescript', 'workflow-control'] as const,
    `${path}/authority`,
  );
  if ((backend === 'ts-local') !== (authority === 'typescript')) {
    fail('WORKFLOW_BUDGET_AUTHORITY_ROUTE_DRIFT', path, 'Backend and authority are inconsistent.');
  }
  return immutableContractValue({
    backend,
    authority,
    routingEpoch: integer(own(record, 'routingEpoch'), `${path}/routingEpoch`, 1),
    authorityBuildHash: hash(own(record, 'authorityBuildHash'), `${path}/authorityBuildHash`),
  });
}

function amount(value: string): bigint {
  return BigInt(value);
}

function quantityMap(
  value: WorkflowBudgetQuantities,
): Record<'tokens' | 'nano_usd' | 'calls', bigint> {
  return {
    tokens: amount(value.tokens),
    nano_usd: amount(value.nanoUsd),
    calls: amount(value.calls),
  };
}

function fromAmounts(tokens: bigint, nanoUsd: bigint, calls: bigint): WorkflowBudgetQuantities {
  for (const entry of [tokens, nanoUsd, calls]) {
    if (entry < 0n || entry > MAX_INT64) {
      fail('WORKFLOW_BUDGET_AUTHORITY_DECIMAL_OVERFLOW', '$', 'Quantity fold exceeds int64.');
    }
  }
  return immutableContractValue({
    tokens: tokens.toString(),
    nanoUsd: nanoUsd.toString(),
    calls: calls.toString(),
  });
}

function quantitiesEqual(left: WorkflowBudgetQuantities, right: WorkflowBudgetQuantities): boolean {
  return (
    left.tokens === right.tokens && left.nanoUsd === right.nanoUsd && left.calls === right.calls
  );
}

function hashCanonicalValue(domain: string, canonical: string): string {
  return createHash('sha256')
    .update(`openslack.workflow-budget-authority.${domain}.v1\0`, 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
}

function hashValue(domain: string, value: unknown): string {
  return hashCanonicalValue(domain, canonicalWorkflowEffectJson(value));
}

export function hashWorkflowBudgetAuthorityValue(domain: string, value: unknown): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(domain)) {
    fail('WORKFLOW_BUDGET_AUTHORITY_INVALID', '$/domain', 'Hash domain is invalid.');
  }
  return hashValue(domain, value);
}

export function canonicalWorkflowBudgetAuthorityJson(value: unknown): string {
  return canonicalWorkflowEffectJson(value);
}

function assertExact(
  value: unknown,
  maxBytes = WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxRecordBytes,
): void {
  if (Buffer.byteLength(canonicalWorkflowBudgetAuthorityJson(value), 'utf8') + 1 > maxBytes) {
    fail('WORKFLOW_BUDGET_AUTHORITY_LIMIT_EXCEEDED', '$', 'Record exceeds byte limit.');
  }
}

function assertBaseIdentity(
  left: Pick<WorkflowBudgetAccount, 'workspaceId' | 'runId' | 'accountId' | 'policyHash' | 'route'>,
  right: Pick<
    WorkflowBudgetAccount,
    'workspaceId' | 'runId' | 'accountId' | 'policyHash' | 'route'
  >,
): void {
  if (
    left.workspaceId !== right.workspaceId ||
    left.runId !== right.runId ||
    left.accountId !== right.accountId
  ) {
    fail('WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH', '$', 'Budget identity drifted.');
  }
  if (left.policyHash !== right.policyHash) {
    fail('WORKFLOW_BUDGET_AUTHORITY_POLICY_DRIFT', '$/policyHash', 'Budget policy drifted.');
  }
  if (
    canonicalWorkflowBudgetAuthorityJson(left.route) !==
    canonicalWorkflowBudgetAuthorityJson(right.route)
  ) {
    fail('WORKFLOW_BUDGET_AUTHORITY_ROUTE_DRIFT', '$/route', 'Budget route drifted.');
  }
}

function nextAccount(
  before: WorkflowBudgetAccount,
  reserved: WorkflowBudgetQuantities,
  settled: WorkflowBudgetQuantities,
  committedAt: string,
): WorkflowBudgetAccount {
  return validateWorkflowBudgetAccount({
    ...before,
    accountRevision: before.accountRevision + 1,
    runRevision: before.runRevision + 1,
    reserved,
    settled,
    updatedAt: committedAt,
  });
}

export function validateWorkflowBudgetAccount(value: unknown): WorkflowBudgetAccount {
  const fields = [
    'schema',
    ...BASE_FIELDS,
    'workspaceId',
    'runId',
    'accountId',
    'policyHash',
    'route',
    'accountRevision',
    'runRevision',
    'limit',
    'reserved',
    'settled',
    'updatedAt',
  ] as const;
  const root = closed(value, fields, '$');
  const limit = quantities(own(root, 'limit'), '$/limit');
  const reserved = quantities(own(root, 'reserved'), '$/reserved');
  const settled = quantities(own(root, 'settled'), '$/settled');
  for (const dimension of WORKFLOW_BUDGET_AUTHORITY_DIMENSIONS) {
    const key = dimension === 'nano_usd' ? 'nanoUsd' : dimension;
    if (
      amount(settled[key]) > amount(reserved[key]) ||
      amount(reserved[key]) > amount(limit[key])
    ) {
      fail(
        'WORKFLOW_BUDGET_AUTHORITY_INVALID',
        `$/reserved/${key}`,
        'Account must satisfy settled <= reserved <= limit.',
      );
    }
  }
  const result = immutableContractValue({
    schema: literal(own(root, 'schema'), WORKFLOW_BUDGET_ACCOUNT_SCHEMA, '$/schema'),
    ...authorityBase(root, '$'),
    workspaceId: id(own(root, 'workspaceId'), '$/workspaceId'),
    runId: id(own(root, 'runId'), '$/runId'),
    accountId: id(own(root, 'accountId'), '$/accountId'),
    policyHash: hash(own(root, 'policyHash'), '$/policyHash'),
    route: route(own(root, 'route'), '$/route'),
    accountRevision: integer(own(root, 'accountRevision'), '$/accountRevision'),
    runRevision: integer(own(root, 'runRevision'), '$/runRevision'),
    limit,
    reserved,
    settled,
    updatedAt: timestamp(own(root, 'updatedAt'), '$/updatedAt'),
  } satisfies WorkflowBudgetAccount);
  assertExact(result, WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxAccountBytes);
  return result;
}

export function validateWorkflowBudgetReserveRequest(value: unknown): WorkflowBudgetReserveRequest {
  const root = closed(
    value,
    [
      'schema',
      ...BASE_FIELDS,
      'workspaceId',
      'runId',
      'accountId',
      'reservationId',
      'callId',
      'providerAttempt',
      'expectedProviderHash',
      'expectedModelHash',
      'expectedProviderRunHash',
      'correlationId',
      'policyHash',
      'route',
      'expectedAccountRevision',
      'expectedRunRevision',
      'rateNanoUsdPerToken',
      'requested',
      'requestedAt',
    ],
    '$',
  );
  const requested = quantities(own(root, 'requested'), '$/requested');
  if (requested.calls !== '1') {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_INVALID',
      '$/requested/calls',
      'Each reserve requests one call.',
    );
  }
  const rateNanoUsdPerToken = (() => {
    const candidate = own(root, 'rateNanoUsdPerToken');
    decimalParts(candidate, '$/rateNanoUsdPerToken');
    return candidate as string;
  })();
  if (
    requested.nanoUsd !==
    workflowBudgetAuthorityChargeNanoUsd(requested.tokens, rateNanoUsdPerToken)
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_POLICY_DRIFT',
      '$/requested/nanoUsd',
      'Requested nanoUsd must equal the exact token-rate fold.',
    );
  }
  const result = immutableContractValue({
    schema: literal(own(root, 'schema'), WORKFLOW_BUDGET_RESERVE_REQUEST_SCHEMA, '$/schema'),
    ...authorityBase(root, '$'),
    workspaceId: id(own(root, 'workspaceId'), '$/workspaceId'),
    runId: id(own(root, 'runId'), '$/runId'),
    accountId: id(own(root, 'accountId'), '$/accountId'),
    reservationId: id(own(root, 'reservationId'), '$/reservationId'),
    callId: id(own(root, 'callId'), '$/callId'),
    providerAttempt: (() => {
      const attempt = validateWorkflowBudgetAuthorityDecimal(
        own(root, 'providerAttempt'),
        '$/providerAttempt',
      );
      if (attempt === '0') {
        fail(
          'WORKFLOW_BUDGET_AUTHORITY_INVALID',
          '$/providerAttempt',
          'Provider attempt must be positive.',
        );
      }
      return attempt;
    })(),
    expectedProviderHash: prefixedHash(own(root, 'expectedProviderHash'), '$/expectedProviderHash'),
    expectedModelHash: prefixedHash(own(root, 'expectedModelHash'), '$/expectedModelHash'),
    expectedProviderRunHash: prefixedHash(
      own(root, 'expectedProviderRunHash'),
      '$/expectedProviderRunHash',
    ),
    correlationId: id(own(root, 'correlationId'), '$/correlationId'),
    policyHash: hash(own(root, 'policyHash'), '$/policyHash'),
    route: route(own(root, 'route'), '$/route'),
    expectedAccountRevision: integer(
      own(root, 'expectedAccountRevision'),
      '$/expectedAccountRevision',
    ),
    expectedRunRevision: integer(own(root, 'expectedRunRevision'), '$/expectedRunRevision'),
    rateNanoUsdPerToken,
    requested,
    requestedAt: timestamp(own(root, 'requestedAt'), '$/requestedAt'),
  } satisfies WorkflowBudgetReserveRequest);
  assertExact(result);
  return result;
}

function insufficientDimensions(
  before: WorkflowBudgetAccount,
  requested: WorkflowBudgetQuantities,
): (typeof WORKFLOW_BUDGET_AUTHORITY_DIMENSIONS)[number][] {
  const current = quantityMap(before.reserved);
  const limit = quantityMap(before.limit);
  const wanted = quantityMap(requested);
  return WORKFLOW_BUDGET_AUTHORITY_DIMENSIONS.filter(
    (dimension) => current[dimension] + wanted[dimension] > limit[dimension],
  );
}

function reservationFromDecision(
  decision: WorkflowBudgetReserveDecision,
): WorkflowBudgetReservation | null {
  if (decision.status !== 'reserved') return null;
  return validateWorkflowBudgetReservation({
    schema: WORKFLOW_BUDGET_RESERVATION_SCHEMA,
    ...authorityEnvelope(),
    workspaceId: decision.request.workspaceId,
    runId: decision.request.runId,
    accountId: decision.request.accountId,
    reservationId: decision.request.reservationId,
    callId: decision.request.callId,
    providerAttempt: decision.request.providerAttempt,
    expectedProviderHash: decision.request.expectedProviderHash,
    expectedModelHash: decision.request.expectedModelHash,
    expectedProviderRunHash: decision.request.expectedProviderRunHash,
    policyHash: decision.request.policyHash,
    route: decision.request.route,
    rateNanoUsdPerToken: decision.request.rateNanoUsdPerToken,
    reserved: decision.request.requested,
    reserveDecisionHash: hashWorkflowBudgetAuthorityValue('reserve-decision', decision),
    openedAccountRevision: decision.afterAccount.accountRevision,
    openedRunRevision: decision.afterAccount.runRevision,
    openedAt: decision.decidedAt,
  });
}

function authorityEnvelope(): WorkflowBudgetAuthorityBase {
  return {
    contractVersion: WORKFLOW_BUDGET_AUTHORITY_CONTRACT_VERSION,
    authority: WORKFLOW_BUDGET_AUTHORITY,
    writer: WORKFLOW_BUDGET_AUTHORITY_WRITER,
    goRole: WORKFLOW_BUDGET_AUTHORITY_GO_ROLE,
    goAuthorityClaim: WORKFLOW_BUDGET_AUTHORITY_GO_CLAIM,
    goAuthorityEligible: false,
  };
}

export interface WorkflowBudgetReserveEvaluation {
  readonly decision: WorkflowBudgetReserveDecision;
  readonly reservation: WorkflowBudgetReservation | null;
  readonly ledgerEntry: WorkflowBudgetLedgerEntry;
}

export function evaluateWorkflowBudgetReserve(
  accountValue: unknown,
  requestValue: unknown,
  committedAtValue: unknown,
): WorkflowBudgetReserveEvaluation {
  const account = validateWorkflowBudgetAccount(accountValue);
  const request = validateWorkflowBudgetReserveRequest(requestValue);
  const committedAt = timestamp(committedAtValue, '$/committedAt');
  assertBaseIdentity(account, request);
  if (
    request.expectedAccountRevision !== account.accountRevision ||
    request.expectedRunRevision !== account.runRevision
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_STALE_REVISION',
      '$/expectedAccountRevision',
      'Reserve revision is stale.',
    );
  }
  const insufficient = insufficientDimensions(account, request.requested);
  const current = quantityMap(account.reserved);
  const wanted = quantityMap(request.requested);
  const nextReserved =
    insufficient.length === 0
      ? fromAmounts(
          current.tokens + wanted.tokens,
          current.nano_usd + wanted.nano_usd,
          current.calls + wanted.calls,
        )
      : account.reserved;
  const afterAccount = nextAccount(account, nextReserved, account.settled, committedAt);
  const decision = validateWorkflowBudgetReserveDecision({
    schema: WORKFLOW_BUDGET_RESERVE_DECISION_SCHEMA,
    ...authorityEnvelope(),
    status: insufficient.length === 0 ? 'reserved' : 'rejected',
    request,
    requestHash: hashWorkflowBudgetAuthorityValue('reserve-request', request),
    beforeAccountHash: hashWorkflowBudgetAuthorityValue('account', account),
    afterAccount,
    authorization: insufficient.length === 0 ? request.requested : ZERO,
    insufficientDimensions: insufficient,
    legacyBudgetApprovalAuthority: false,
    decidedAt: committedAt,
  });
  const reservation = reservationFromDecision(decision);
  const ledgerEntry = createLedgerEntry(
    decision.status === 'reserved' ? 'reserve_reserved' : 'reserve_rejected',
    account,
    afterAccount,
    request.reservationId,
    request.callId,
    decision,
    decision.status === 'reserved' ? request.requested : ZERO,
    ZERO,
    ZERO,
    null,
    null,
    committedAt,
  );
  return immutableContractValue({ decision, reservation, ledgerEntry });
}

interface ValidatedWorkflowBudgetReserveDecision {
  readonly decision: WorkflowBudgetReserveDecision;
  readonly canonicalRequest: string;
}

function validateWorkflowBudgetReserveDecisionWithRequest(
  value: unknown,
): ValidatedWorkflowBudgetReserveDecision {
  const root = closed(
    value,
    [
      'schema',
      ...BASE_FIELDS,
      'status',
      'request',
      'requestHash',
      'beforeAccountHash',
      'afterAccount',
      'authorization',
      'insufficientDimensions',
      'legacyBudgetApprovalAuthority',
      'decidedAt',
    ],
    '$',
  );
  const status = enumValue(own(root, 'status'), ['reserved', 'rejected'] as const, '$/status');
  const request = validateWorkflowBudgetReserveRequest(own(root, 'request'));
  const afterAccount = validateWorkflowBudgetAccount(own(root, 'afterAccount'));
  assertBaseIdentity(afterAccount, request);
  if (
    afterAccount.accountRevision !== request.expectedAccountRevision + 1 ||
    afterAccount.runRevision !== request.expectedRunRevision + 1
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_STALE_REVISION',
      '$/afterAccount',
      'Reserve did not advance revisions once.',
    );
  }
  const requestHash = hash(own(root, 'requestHash'), '$/requestHash');
  const canonicalRequest = canonicalWorkflowBudgetAuthorityJson(request);
  if (requestHash !== hashCanonicalValue('reserve-request', canonicalRequest)) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_HASH_MISMATCH',
      '$/requestHash',
      'Reserve request hash drifted.',
    );
  }
  const authorization = quantities(own(root, 'authorization'), '$/authorization');
  const dimensions = own(root, 'insufficientDimensions');
  if (
    !Array.isArray(dimensions) ||
    new Set(dimensions).size !== dimensions.length ||
    dimensions.some((entry) => !WORKFLOW_BUDGET_AUTHORITY_DIMENSIONS.includes(entry as never)) ||
    canonicalWorkflowEffectJson(dimensions) !==
      canonicalWorkflowEffectJson(
        WORKFLOW_BUDGET_AUTHORITY_DIMENSIONS.filter((dimension) => dimensions.includes(dimension)),
      )
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_INVALID',
      '$/insufficientDimensions',
      'Insufficient dimensions are invalid.',
    );
  }
  if (
    (status === 'reserved' &&
      (!quantitiesEqual(authorization, request.requested) || dimensions.length !== 0)) ||
    (status === 'rejected' && (!quantitiesEqual(authorization, ZERO) || dimensions.length === 0))
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_INVALID',
      '$/authorization',
      'Reserve authorization does not match status.',
    );
  }
  const decidedAt = timestamp(own(root, 'decidedAt'), '$/decidedAt');
  if (decidedAt !== afterAccount.updatedAt || decidedAt < request.requestedAt) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH',
      '$/decidedAt',
      'Reserve decision time is inconsistent.',
    );
  }
  const result = immutableContractValue({
    schema: literal(own(root, 'schema'), WORKFLOW_BUDGET_RESERVE_DECISION_SCHEMA, '$/schema'),
    ...authorityBase(root, '$'),
    status,
    request,
    requestHash,
    beforeAccountHash: hash(own(root, 'beforeAccountHash'), '$/beforeAccountHash'),
    afterAccount,
    authorization,
    insufficientDimensions: Object.freeze([
      ...(dimensions as string[]),
    ]) as WorkflowBudgetReserveDecision['insufficientDimensions'],
    legacyBudgetApprovalAuthority: booleanLiteral(
      own(root, 'legacyBudgetApprovalAuthority'),
      false,
      '$/legacyBudgetApprovalAuthority',
    ) as false,
    decidedAt,
  } satisfies WorkflowBudgetReserveDecision);
  assertExact(result);
  return { decision: result, canonicalRequest };
}

export function validateWorkflowBudgetReserveDecision(
  value: unknown,
): WorkflowBudgetReserveDecision {
  return validateWorkflowBudgetReserveDecisionWithRequest(value).decision;
}

export function validateWorkflowBudgetReservation(value: unknown): WorkflowBudgetReservation {
  const root = closed(
    value,
    [
      'schema',
      ...BASE_FIELDS,
      'workspaceId',
      'runId',
      'accountId',
      'reservationId',
      'callId',
      'providerAttempt',
      'expectedProviderHash',
      'expectedModelHash',
      'expectedProviderRunHash',
      'policyHash',
      'route',
      'rateNanoUsdPerToken',
      'reserved',
      'reserveDecisionHash',
      'openedAccountRevision',
      'openedRunRevision',
      'openedAt',
    ],
    '$',
  );
  const reserved = quantities(own(root, 'reserved'), '$/reserved');
  if (reserved.calls !== '1') {
    fail('WORKFLOW_BUDGET_AUTHORITY_INVALID', '$/reserved/calls', 'A reservation owns one call.');
  }
  const rateNanoUsdPerToken = (() => {
    const candidate = own(root, 'rateNanoUsdPerToken');
    decimalParts(candidate, '$/rateNanoUsdPerToken');
    return candidate as string;
  })();
  if (
    reserved.nanoUsd !== workflowBudgetAuthorityChargeNanoUsd(reserved.tokens, rateNanoUsdPerToken)
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_POLICY_DRIFT',
      '$/reserved/nanoUsd',
      'Reservation rate binding drifted.',
    );
  }
  const result = immutableContractValue({
    schema: literal(own(root, 'schema'), WORKFLOW_BUDGET_RESERVATION_SCHEMA, '$/schema'),
    ...authorityBase(root, '$'),
    workspaceId: id(own(root, 'workspaceId'), '$/workspaceId'),
    runId: id(own(root, 'runId'), '$/runId'),
    accountId: id(own(root, 'accountId'), '$/accountId'),
    reservationId: id(own(root, 'reservationId'), '$/reservationId'),
    callId: id(own(root, 'callId'), '$/callId'),
    providerAttempt: (() => {
      const attempt = validateWorkflowBudgetAuthorityDecimal(
        own(root, 'providerAttempt'),
        '$/providerAttempt',
      );
      if (attempt === '0') {
        fail(
          'WORKFLOW_BUDGET_AUTHORITY_INVALID',
          '$/providerAttempt',
          'Provider attempt must be positive.',
        );
      }
      return attempt;
    })(),
    expectedProviderHash: prefixedHash(own(root, 'expectedProviderHash'), '$/expectedProviderHash'),
    expectedModelHash: prefixedHash(own(root, 'expectedModelHash'), '$/expectedModelHash'),
    expectedProviderRunHash: prefixedHash(
      own(root, 'expectedProviderRunHash'),
      '$/expectedProviderRunHash',
    ),
    policyHash: hash(own(root, 'policyHash'), '$/policyHash'),
    route: route(own(root, 'route'), '$/route'),
    rateNanoUsdPerToken,
    reserved,
    reserveDecisionHash: hash(own(root, 'reserveDecisionHash'), '$/reserveDecisionHash'),
    openedAccountRevision: integer(
      own(root, 'openedAccountRevision'),
      '$/openedAccountRevision',
      1,
    ),
    openedRunRevision: integer(own(root, 'openedRunRevision'), '$/openedRunRevision', 1),
    openedAt: timestamp(own(root, 'openedAt'), '$/openedAt'),
  } satisfies WorkflowBudgetReservation);
  assertExact(result);
  return result;
}

export function validateWorkflowBudgetReservationForDecision(
  reservationValue: unknown,
  decisionValue: unknown,
): WorkflowBudgetReservation {
  const reservation = validateWorkflowBudgetReservation(reservationValue);
  const decision = validateWorkflowBudgetReserveDecision(decisionValue);
  if (
    decision.status !== 'reserved' ||
    reservation.workspaceId !== decision.request.workspaceId ||
    reservation.runId !== decision.request.runId ||
    reservation.accountId !== decision.request.accountId ||
    reservation.reservationId !== decision.request.reservationId ||
    reservation.callId !== decision.request.callId ||
    reservation.providerAttempt !== decision.request.providerAttempt ||
    reservation.expectedProviderHash !== decision.request.expectedProviderHash ||
    reservation.expectedModelHash !== decision.request.expectedModelHash ||
    reservation.expectedProviderRunHash !== decision.request.expectedProviderRunHash ||
    reservation.policyHash !== decision.request.policyHash ||
    canonicalWorkflowBudgetAuthorityJson(reservation.route) !==
      canonicalWorkflowBudgetAuthorityJson(decision.request.route) ||
    reservation.rateNanoUsdPerToken !== decision.request.rateNanoUsdPerToken ||
    !quantitiesEqual(reservation.reserved, decision.authorization) ||
    reservation.reserveDecisionHash !==
      hashWorkflowBudgetAuthorityValue('reserve-decision', decision) ||
    reservation.openedAccountRevision !== decision.afterAccount.accountRevision ||
    reservation.openedRunRevision !== decision.afterAccount.runRevision ||
    reservation.openedAt !== decision.decidedAt
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH',
      '$/reservation',
      'Reservation does not bind its reserve decision.',
    );
  }
  return reservation;
}

export function validateWorkflowBudgetProviderUsage(value: unknown): WorkflowBudgetProviderUsage {
  const root = closed(
    value,
    [
      'schema',
      'providerHash',
      'modelHash',
      'runHash',
      'attempt',
      'calls',
      'status',
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'outcome',
      'requestHash',
      'outcomeHash',
      'receiptHash',
    ],
    '$',
  );
  const status = enumValue(own(root, 'status'), ['reported', 'unreported'] as const, '$/status');
  const token = (field: 'inputTokens' | 'outputTokens' | 'totalTokens') =>
    own(root, field) === null
      ? null
      : validateWorkflowBudgetAuthorityDecimal(own(root, field), `$/${field}`);
  const inputTokens = token('inputTokens');
  const outputTokens = token('outputTokens');
  const totalTokens = token('totalTokens');
  if (
    (status === 'reported' && totalTokens === null) ||
    (status === 'unreported' &&
      (inputTokens !== null || outputTokens !== null || totalTokens !== null)) ||
    (inputTokens !== null &&
      outputTokens !== null &&
      BigInt(inputTokens) + BigInt(outputTokens) !== BigInt(totalTokens!))
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_INVALID',
      '$/status',
      'Provider usage evidence is inconsistent.',
    );
  }
  const unsigned = immutableContractValue({
    schema: literal(own(root, 'schema'), WORKFLOW_BUDGET_PROVIDER_USAGE_SCHEMA, '$/schema'),
    providerHash: prefixedHash(own(root, 'providerHash'), '$/providerHash'),
    modelHash: prefixedHash(own(root, 'modelHash'), '$/modelHash'),
    runHash: prefixedHash(own(root, 'runHash'), '$/runHash'),
    attempt: (() => {
      const attempt = validateWorkflowBudgetAuthorityDecimal(own(root, 'attempt'), '$/attempt');
      if (attempt === '0') {
        fail(
          'WORKFLOW_BUDGET_AUTHORITY_INVALID',
          '$/attempt',
          'Provider attempt must be positive.',
        );
      }
      return attempt;
    })(),
    calls: literal(own(root, 'calls'), '1' as const, '$/calls'),
    status,
    inputTokens,
    outputTokens,
    totalTokens,
    outcome: enumValue(
      own(root, 'outcome'),
      ['provider_response_accepted', 'provider_attempt_failed'] as const,
      '$/outcome',
    ),
    requestHash: prefixedHash(own(root, 'requestHash'), '$/requestHash'),
    outcomeHash: prefixedHash(own(root, 'outcomeHash'), '$/outcomeHash'),
  });
  const receiptHash = prefixedHash(own(root, 'receiptHash'), '$/receiptHash');
  const expectedReceiptHash = `sha256:${createHash('sha256')
    .update('openslack.provider-usage-receipt.v1\0', 'utf8')
    .update(canonicalWorkflowBudgetAuthorityJson(unsigned), 'utf8')
    .digest('hex')}`;
  if (receiptHash !== expectedReceiptHash) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_HASH_MISMATCH',
      '$/receiptHash',
      'Provider usage receipt hash drifted.',
    );
  }
  const result = immutableContractValue({
    ...unsigned,
    receiptHash,
  } satisfies WorkflowBudgetProviderUsage);
  assertExact(result);
  return result;
}

export function validateWorkflowBudgetSettlementRequest(
  value: unknown,
): WorkflowBudgetSettlementRequest {
  const root = closed(
    value,
    [
      'schema',
      ...BASE_FIELDS,
      'workspaceId',
      'runId',
      'accountId',
      'reservationId',
      'callId',
      'providerAttempt',
      'expectedProviderHash',
      'expectedModelHash',
      'expectedProviderRunHash',
      'correlationId',
      'policyHash',
      'route',
      'expectedAccountRevision',
      'expectedRunRevision',
      'reserveDecisionHash',
      'usageEvidenceStatus',
      'usageReceiptHash',
      'providerUsage',
      'rateNanoUsdPerToken',
      'requestedAt',
    ],
    '$',
  );
  const usageEvidenceStatus = enumValue(
    own(root, 'usageEvidenceStatus'),
    ['trusted', 'missing', 'untrusted'] as const,
    '$/usageEvidenceStatus',
  );
  const providerUsage =
    own(root, 'providerUsage') === null
      ? null
      : validateWorkflowBudgetProviderUsage(own(root, 'providerUsage'));
  const usageReceiptHash =
    own(root, 'usageReceiptHash') === null
      ? null
      : prefixedHash(own(root, 'usageReceiptHash'), '$/usageReceiptHash');
  const reservationId = id(own(root, 'reservationId'), '$/reservationId');
  const callId = id(own(root, 'callId'), '$/callId');
  const providerAttempt = (() => {
    const attempt = validateWorkflowBudgetAuthorityDecimal(
      own(root, 'providerAttempt'),
      '$/providerAttempt',
    );
    if (attempt === '0') {
      fail(
        'WORKFLOW_BUDGET_AUTHORITY_INVALID',
        '$/providerAttempt',
        'Provider attempt must be positive.',
      );
    }
    return attempt;
  })();
  const expectedProviderHash = prefixedHash(
    own(root, 'expectedProviderHash'),
    '$/expectedProviderHash',
  );
  const expectedModelHash = prefixedHash(own(root, 'expectedModelHash'), '$/expectedModelHash');
  const expectedProviderRunHash = prefixedHash(
    own(root, 'expectedProviderRunHash'),
    '$/expectedProviderRunHash',
  );
  if (
    (usageEvidenceStatus === 'trusted' &&
      (providerUsage === null ||
        usageReceiptHash !== providerUsage.receiptHash ||
        providerAttempt !== providerUsage.attempt ||
        expectedProviderHash !== providerUsage.providerHash ||
        expectedModelHash !== providerUsage.modelHash ||
        expectedProviderRunHash !== providerUsage.runHash)) ||
    (usageEvidenceStatus === 'missing' && (providerUsage !== null || usageReceiptHash !== null)) ||
    (usageEvidenceStatus === 'untrusted' && (providerUsage !== null || usageReceiptHash === null))
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_INVALID',
      '$/usageEvidenceStatus',
      'Usage evidence status and receipt binding are inconsistent.',
    );
  }
  const result = immutableContractValue({
    schema: literal(own(root, 'schema'), WORKFLOW_BUDGET_SETTLEMENT_REQUEST_SCHEMA, '$/schema'),
    ...authorityBase(root, '$'),
    workspaceId: id(own(root, 'workspaceId'), '$/workspaceId'),
    runId: id(own(root, 'runId'), '$/runId'),
    accountId: id(own(root, 'accountId'), '$/accountId'),
    reservationId,
    callId,
    providerAttempt,
    expectedProviderHash,
    expectedModelHash,
    expectedProviderRunHash,
    correlationId: id(own(root, 'correlationId'), '$/correlationId'),
    policyHash: hash(own(root, 'policyHash'), '$/policyHash'),
    route: route(own(root, 'route'), '$/route'),
    expectedAccountRevision: integer(
      own(root, 'expectedAccountRevision'),
      '$/expectedAccountRevision',
    ),
    expectedRunRevision: integer(own(root, 'expectedRunRevision'), '$/expectedRunRevision'),
    reserveDecisionHash: hash(own(root, 'reserveDecisionHash'), '$/reserveDecisionHash'),
    usageEvidenceStatus,
    usageReceiptHash,
    providerUsage,
    rateNanoUsdPerToken: (() => {
      const candidate = own(root, 'rateNanoUsdPerToken');
      decimalParts(candidate, '$/rateNanoUsdPerToken');
      return candidate as string;
    })(),
    requestedAt: timestamp(own(root, 'requestedAt'), '$/requestedAt'),
  } satisfies WorkflowBudgetSettlementRequest);
  assertExact(result);
  return result;
}

export interface WorkflowBudgetSettlementEvaluation {
  readonly settlement: WorkflowBudgetSettlement;
  readonly ledgerEntry: WorkflowBudgetLedgerEntry;
  readonly reconciliation: WorkflowBudgetReconciliation | null;
}

function deriveSettlementDisposition(
  reservation: WorkflowBudgetReservation,
  request: WorkflowBudgetSettlementRequest,
): {
  actual: Record<'tokens' | 'nano_usd' | 'calls', bigint> | null;
  reasonCode: WorkflowBudgetSettlement['reasonCode'];
  isSettled: boolean;
  released: WorkflowBudgetQuantities | null;
  cachePublishAuthorized: boolean;
} {
  if (
    request.workspaceId !== reservation.workspaceId ||
    request.runId !== reservation.runId ||
    request.accountId !== reservation.accountId ||
    request.reservationId !== reservation.reservationId ||
    request.callId !== reservation.callId ||
    request.providerAttempt !== reservation.providerAttempt ||
    request.expectedProviderHash !== reservation.expectedProviderHash ||
    request.expectedModelHash !== reservation.expectedModelHash ||
    request.expectedProviderRunHash !== reservation.expectedProviderRunHash ||
    request.policyHash !== reservation.policyHash ||
    canonicalWorkflowBudgetAuthorityJson(request.route) !==
      canonicalWorkflowBudgetAuthorityJson(reservation.route) ||
    request.rateNanoUsdPerToken !== reservation.rateNanoUsdPerToken ||
    request.reserveDecisionHash !== reservation.reserveDecisionHash
  ) {
    fail('WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH', '$/reservation', 'Reservation drifted.');
  }
  if (request.requestedAt < reservation.openedAt) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH',
      '$/requestedAt',
      'Settlement request predates its durable reservation.',
    );
  }
  const usage = request.providerUsage;
  const actual =
    request.usageEvidenceStatus === 'trusted' && usage?.status === 'reported'
      ? quantityMap({
          tokens: usage.totalTokens!,
          nanoUsd: workflowBudgetAuthorityChargeNanoUsd(
            usage.totalTokens!,
            request.rateNanoUsdPerToken,
          ),
          calls: usage.calls,
        })
      : null;
  const reservationAmount = quantityMap(reservation.reserved);
  const overrun =
    actual !== null &&
    (actual.tokens > reservationAmount.tokens ||
      actual.nano_usd > reservationAmount.nano_usd ||
      actual.calls > reservationAmount.calls);
  const reasonCode =
    request.usageEvidenceStatus === 'missing'
      ? 'usage_receipt_missing'
      : request.usageEvidenceStatus === 'untrusted'
        ? 'usage_receipt_untrusted'
        : usage?.status === 'unreported'
          ? 'provider_outcome_unknown'
          : overrun
            ? 'usage_overrun'
            : null;
  const isSettled = reasonCode === null;
  const released = isSettled
    ? fromAmounts(
        reservationAmount.tokens - actual!.tokens,
        reservationAmount.nano_usd - actual!.nano_usd,
        reservationAmount.calls - actual!.calls,
      )
    : null;
  return {
    actual,
    reasonCode,
    isSettled,
    released,
    cachePublishAuthorized: isSettled && usage?.outcome === 'provider_response_accepted',
  };
}

export function evaluateWorkflowBudgetSettlement(
  accountValue: unknown,
  reservationValue: unknown,
  requestValue: unknown,
  committedAtValue: unknown,
): WorkflowBudgetSettlementEvaluation {
  const account = validateWorkflowBudgetAccount(accountValue);
  const reservation = validateWorkflowBudgetReservation(reservationValue);
  const request = validateWorkflowBudgetSettlementRequest(requestValue);
  const committedAt = timestamp(committedAtValue, '$/committedAt');
  assertBaseIdentity(account, request);
  assertBaseIdentity(account, reservation);
  const disposition = deriveSettlementDisposition(reservation, request);
  if (
    request.expectedAccountRevision < reservation.openedAccountRevision ||
    request.expectedRunRevision < reservation.openedRunRevision
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_STALE_REVISION',
      '$/expectedAccountRevision',
      'Settlement predates the reservation.',
    );
  }
  if (
    request.expectedAccountRevision !== account.accountRevision ||
    request.expectedRunRevision !== account.runRevision
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_STALE_REVISION',
      '$/expectedAccountRevision',
      'Settlement revision is stale.',
    );
  }
  const beforeReserved = quantityMap(account.reserved);
  const reservationAmount = quantityMap(reservation.reserved);
  if (
    beforeReserved.tokens < reservationAmount.tokens ||
    beforeReserved.nano_usd < reservationAmount.nano_usd ||
    beforeReserved.calls < reservationAmount.calls
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH',
      '$/reservation/reserved',
      'Reservation is not encumbered.',
    );
  }
  const { actual, reasonCode, isSettled, released, cachePublishAuthorized } = disposition;
  const nextReserved = isSettled
    ? fromAmounts(
        beforeReserved.tokens - reservationAmount.tokens + actual!.tokens,
        beforeReserved.nano_usd - reservationAmount.nano_usd + actual!.nano_usd,
        beforeReserved.calls - reservationAmount.calls + actual!.calls,
      )
    : account.reserved;
  const beforeSettled = quantityMap(account.settled);
  const nextSettled = isSettled
    ? fromAmounts(
        beforeSettled.tokens + actual!.tokens,
        beforeSettled.nano_usd + actual!.nano_usd,
        beforeSettled.calls + actual!.calls,
      )
    : account.settled;
  const afterAccount = nextAccount(account, nextReserved, nextSettled, committedAt);
  const settlement = validateWorkflowBudgetSettlement({
    schema: WORKFLOW_BUDGET_SETTLEMENT_SCHEMA,
    ...authorityEnvelope(),
    status: isSettled ? 'settled' : 'reconciliation_required',
    request,
    requestHash: hashWorkflowBudgetAuthorityValue('settlement-request', request),
    reservation,
    reservationHash: hashWorkflowBudgetAuthorityValue('reservation', reservation),
    beforeAccountHash: hashWorkflowBudgetAuthorityValue('account', account),
    afterAccount,
    released,
    reasonCode,
    reservationRemainsOpen: !isSettled,
    runReconciliationLatched: !isSettled,
    providerRetryAuthorized: false,
    cachePublishAuthorized,
    legacyBudgetApprovalAuthority: false,
    committedAt,
  });
  const ledgerEntry = createLedgerEntry(
    isSettled ? 'settlement_settled' : 'settlement_reconciliation_required',
    account,
    afterAccount,
    reservation.reservationId,
    reservation.callId,
    settlement,
    ZERO,
    isSettled ? fromAmounts(actual!.tokens, actual!.nano_usd, actual!.calls) : ZERO,
    released ?? ZERO,
    request.usageReceiptHash,
    reasonCode,
    committedAt,
  );
  const reconciliation = isSettled
    ? null
    : validateWorkflowBudgetReconciliation({
        schema: WORKFLOW_BUDGET_RECONCILIATION_SCHEMA,
        ...authorityEnvelope(),
        evidenceType: 'provider_outcome',
        reasonCode,
        workspaceId: account.workspaceId,
        runId: account.runId,
        accountId: account.accountId,
        reservationId: reservation.reservationId,
        callId: reservation.callId,
        sourceRequestHash: settlement.requestHash,
        usageReceiptHash: request.usageReceiptHash,
        accountHash: hashWorkflowBudgetAuthorityValue('account', afterAccount),
        reservationHash: settlement.reservationHash,
        reconciliationToken: `WFBUDGETRECON-${hashWorkflowBudgetAuthorityValue(
          'provider-reconciliation-token',
          {
            reasonCode,
            requestHash: settlement.requestHash,
            usageReceiptHash: request.usageReceiptHash,
          },
        )}`,
        accountCountersChanged: false,
        reservationReleaseAuthorized: false,
        providerRetryAuthorized: false,
        cachePublishAuthorized: false,
        runReconciliationLatched: true,
        observedAt: committedAt,
      });
  return immutableContractValue({ settlement, ledgerEntry, reconciliation });
}

export function validateWorkflowBudgetSettlement(value: unknown): WorkflowBudgetSettlement {
  const root = closed(
    value,
    [
      'schema',
      ...BASE_FIELDS,
      'status',
      'request',
      'requestHash',
      'reservation',
      'reservationHash',
      'beforeAccountHash',
      'afterAccount',
      'released',
      'reasonCode',
      'reservationRemainsOpen',
      'runReconciliationLatched',
      'providerRetryAuthorized',
      'cachePublishAuthorized',
      'legacyBudgetApprovalAuthority',
      'committedAt',
    ],
    '$',
  );
  const status = enumValue(
    own(root, 'status'),
    ['settled', 'reconciliation_required'] as const,
    '$/status',
  );
  const request = validateWorkflowBudgetSettlementRequest(own(root, 'request'));
  const reservation = validateWorkflowBudgetReservation(own(root, 'reservation'));
  const disposition = deriveSettlementDisposition(reservation, request);
  const afterAccount = validateWorkflowBudgetAccount(own(root, 'afterAccount'));
  assertBaseIdentity(afterAccount, request);
  assertBaseIdentity(afterAccount, reservation);
  if (
    afterAccount.accountRevision !== request.expectedAccountRevision + 1 ||
    afterAccount.runRevision !== request.expectedRunRevision + 1
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_STALE_REVISION',
      '$/afterAccount',
      'Settlement did not advance revisions once.',
    );
  }
  const requestHash = hash(own(root, 'requestHash'), '$/requestHash');
  const reservationHash = hash(own(root, 'reservationHash'), '$/reservationHash');
  if (
    requestHash !== hashWorkflowBudgetAuthorityValue('settlement-request', request) ||
    reservationHash !== hashWorkflowBudgetAuthorityValue('reservation', reservation)
  ) {
    fail('WORKFLOW_BUDGET_AUTHORITY_HASH_MISMATCH', '$', 'Settlement hash binding drifted.');
  }
  const released =
    own(root, 'released') === null ? null : quantities(own(root, 'released'), '$/released');
  const reasonCode =
    own(root, 'reasonCode') === null
      ? null
      : enumValue(
          own(root, 'reasonCode'),
          WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS,
          '$/reasonCode',
        );
  const reservationRemainsOpen = own(root, 'reservationRemainsOpen');
  const runReconciliationLatched = own(root, 'runReconciliationLatched');
  const cachePublishAuthorized = own(root, 'cachePublishAuthorized');
  const expectedCachePublishAuthorization = disposition.cachePublishAuthorized;
  const committedAt = timestamp(own(root, 'committedAt'), '$/committedAt');
  if (
    committedAt !== afterAccount.updatedAt ||
    committedAt < request.requestedAt ||
    committedAt < reservation.openedAt
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH',
      '$/committedAt',
      'Settlement time is inconsistent.',
    );
  }
  if (
    status !== (disposition.isSettled ? 'settled' : 'reconciliation_required') ||
    reasonCode !== disposition.reasonCode ||
    (released === null) !== (disposition.released === null) ||
    (released !== null && !quantitiesEqual(released, disposition.released!)) ||
    (status === 'settled' &&
      (released === null ||
        reservationRemainsOpen !== false ||
        runReconciliationLatched !== false ||
        cachePublishAuthorized !== expectedCachePublishAuthorization)) ||
    (status === 'reconciliation_required' &&
      (released !== null ||
        reasonCode === null ||
        reservationRemainsOpen !== true ||
        runReconciliationLatched !== true ||
        cachePublishAuthorized !== false))
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED',
      '$/status',
      'Settlement status fields are inconsistent.',
    );
  }
  const result = immutableContractValue({
    schema: literal(own(root, 'schema'), WORKFLOW_BUDGET_SETTLEMENT_SCHEMA, '$/schema'),
    ...authorityBase(root, '$'),
    status,
    request,
    requestHash,
    reservation,
    reservationHash,
    beforeAccountHash: hash(own(root, 'beforeAccountHash'), '$/beforeAccountHash'),
    afterAccount,
    released,
    reasonCode,
    reservationRemainsOpen: booleanLiteral(
      reservationRemainsOpen,
      status !== 'settled',
      '$/reservationRemainsOpen',
    ),
    runReconciliationLatched: booleanLiteral(
      runReconciliationLatched,
      status !== 'settled',
      '$/runReconciliationLatched',
    ),
    providerRetryAuthorized: booleanLiteral(
      own(root, 'providerRetryAuthorized'),
      false,
      '$/providerRetryAuthorized',
    ) as false,
    cachePublishAuthorized: booleanLiteral(
      cachePublishAuthorized,
      expectedCachePublishAuthorization,
      '$/cachePublishAuthorized',
    ),
    legacyBudgetApprovalAuthority: booleanLiteral(
      own(root, 'legacyBudgetApprovalAuthority'),
      false,
      '$/legacyBudgetApprovalAuthority',
    ) as false,
    committedAt,
  } satisfies WorkflowBudgetSettlement);
  assertExact(result);
  return result;
}

function createLedgerEntry(
  kind: WorkflowBudgetLedgerEntry['kind'],
  before: WorkflowBudgetAccount,
  after: WorkflowBudgetAccount,
  reservationId: string,
  callId: string,
  decision: WorkflowBudgetReserveDecision | WorkflowBudgetSettlement,
  encumbered: WorkflowBudgetQuantities,
  settled: WorkflowBudgetQuantities,
  released: WorkflowBudgetQuantities,
  providerUsageHash: string | null,
  reasonCode: WorkflowBudgetLedgerEntry['reasonCode'],
  recordedAt: string,
): WorkflowBudgetLedgerEntry {
  const decisionHash = hashWorkflowBudgetAuthorityValue(
    decision.schema === WORKFLOW_BUDGET_RESERVE_DECISION_SCHEMA ? 'reserve-decision' : 'settlement',
    decision,
  );
  return validateWorkflowBudgetLedgerEntry({
    schema: WORKFLOW_BUDGET_LEDGER_ENTRY_SCHEMA,
    ...authorityEnvelope(),
    kind,
    entryId: `WFBUDGETLEDGER-${hashWorkflowBudgetAuthorityValue('ledger-entry-id', {
      accountId: after.accountId,
      accountRevision: after.accountRevision,
      decisionHash,
      kind,
      reservationId,
    })}`,
    workspaceId: after.workspaceId,
    runId: after.runId,
    accountId: after.accountId,
    reservationId,
    callId,
    accountRevision: after.accountRevision,
    runRevision: after.runRevision,
    previousAccountHash: hashWorkflowBudgetAuthorityValue('account', before),
    accountHash: hashWorkflowBudgetAuthorityValue('account', after),
    decisionHash,
    encumbered,
    settled,
    released,
    providerUsageHash,
    reasonCode,
    recordedAt,
  });
}

function requestPath(operation: 'reserve' | 'settle') {
  return operation === 'reserve' ? WORKFLOW_BUDGET_RESERVE_ROUTE : WORKFLOW_BUDGET_SETTLE_ROUTE;
}

function requestFingerprint(
  operation: 'reserve' | 'settle',
  callerId: string,
  workspaceId: string,
  requestHash: string,
): string {
  return `sha256:${hashWorkflowBudgetAuthorityValue('request-fingerprint', {
    callerId,
    method: 'POST',
    operation,
    path: requestPath(operation),
    requestHash,
    workspaceId,
  })}`;
}

export function prepareWorkflowBudgetAuthorityRequest(
  operation: 'reserve',
  request: WorkflowBudgetReserveRequest,
  callerId: string,
): WorkflowBudgetPreparedRequest;
export function prepareWorkflowBudgetAuthorityRequest(
  operation: 'settle',
  request: WorkflowBudgetSettlementRequest,
  callerId: string,
): WorkflowBudgetPreparedRequest;
export function prepareWorkflowBudgetAuthorityRequest(
  operation: 'reserve' | 'settle',
  requestValue: WorkflowBudgetReserveRequest | WorkflowBudgetSettlementRequest,
  callerIdValue: string,
): WorkflowBudgetPreparedRequest {
  const request =
    operation === 'reserve'
      ? validateWorkflowBudgetReserveRequest(requestValue)
      : validateWorkflowBudgetSettlementRequest(requestValue);
  const callerId = id(callerIdValue, '$/callerId');
  const body = `${canonicalWorkflowBudgetAuthorityJson(request)}\n`;
  const requestHash = createHash('sha256').update(body, 'utf8').digest('hex');
  return validateWorkflowBudgetPreparedRequest({
    schema: WORKFLOW_BUDGET_PREPARED_REQUEST_SCHEMA,
    operation,
    method: 'POST',
    path: requestPath(operation),
    callerId,
    body,
    requestHash,
    idempotencyKey: `${WORKFLOW_BUDGET_AUTHORITY_IDEMPOTENCY_PREFIX}${requestHash}`,
    requestFingerprint: requestFingerprint(operation, callerId, request.workspaceId, requestHash),
  });
}

interface ValidatedWorkflowBudgetPreparedRequest {
  readonly prepared: WorkflowBudgetPreparedRequest;
  readonly request: WorkflowBudgetReserveRequest | WorkflowBudgetSettlementRequest;
  readonly canonicalRequest: string;
}

function validateWorkflowBudgetPreparedRequestWithRecord(
  value: unknown,
): ValidatedWorkflowBudgetPreparedRequest {
  const root = closed(
    value,
    [
      'schema',
      'operation',
      'method',
      'path',
      'callerId',
      'body',
      'requestHash',
      'idempotencyKey',
      'requestFingerprint',
    ],
    '$',
  );
  const operation = enumValue(
    own(root, 'operation'),
    ['reserve', 'settle'] as const,
    '$/operation',
  );
  const path = literal(own(root, 'path'), requestPath(operation), '$/path');
  const callerId = id(own(root, 'callerId'), '$/callerId');
  const body = own(root, 'body');
  if (
    typeof body !== 'string' ||
    Buffer.byteLength(body, 'utf8') > WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxRecordBytes ||
    !body.endsWith('\n') ||
    body.endsWith('\n\n')
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_INVALID',
      '$/body',
      'Prepared request body framing is invalid.',
    );
  }
  const parsed = parseWorkflowBudgetAuthorityBytes(Buffer.from(body, 'utf8'));
  const request =
    operation === 'reserve'
      ? validateWorkflowBudgetReserveRequest(parsed)
      : validateWorkflowBudgetSettlementRequest(parsed);
  const canonicalRequest = canonicalWorkflowBudgetAuthorityJson(request);
  if (`${canonicalRequest}\n` !== body) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_HASH_MISMATCH',
      '$/body',
      'Prepared request body is not canonical.',
    );
  }
  const requestHashValue = hash(own(root, 'requestHash'), '$/requestHash');
  if (createHash('sha256').update(body, 'utf8').digest('hex') !== requestHashValue) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_HASH_MISMATCH',
      '$/requestHash',
      'Prepared request hash drifted.',
    );
  }
  const idempotencyKey = text(own(root, 'idempotencyKey'), IDEMPOTENCY, '$/idempotencyKey', 128);
  if (idempotencyKey !== `${WORKFLOW_BUDGET_AUTHORITY_IDEMPOTENCY_PREFIX}${requestHashValue}`) {
    fail('WORKFLOW_BUDGET_AUTHORITY_HASH_MISMATCH', '$/idempotencyKey', 'Idempotency key drifted.');
  }
  const fingerprint = text(
    own(root, 'requestFingerprint'),
    FINGERPRINT,
    '$/requestFingerprint',
    71,
  );
  if (
    fingerprint !== requestFingerprint(operation, callerId, request.workspaceId, requestHashValue)
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_HASH_MISMATCH',
      '$/requestFingerprint',
      'Request fingerprint drifted.',
    );
  }
  const prepared = immutableContractValue({
    schema: literal(own(root, 'schema'), WORKFLOW_BUDGET_PREPARED_REQUEST_SCHEMA, '$/schema'),
    operation,
    method: literal(own(root, 'method'), 'POST' as const, '$/method'),
    path,
    callerId,
    body,
    requestHash: requestHashValue,
    idempotencyKey,
    requestFingerprint: fingerprint,
  } satisfies WorkflowBudgetPreparedRequest);
  return { prepared, request, canonicalRequest };
}

export function validateWorkflowBudgetPreparedRequest(
  value: unknown,
): WorkflowBudgetPreparedRequest {
  return validateWorkflowBudgetPreparedRequestWithRecord(value).prepared;
}

function validateWorkflowBudgetReceiptForPreparedRequest(
  receipt: WorkflowBudgetReceipt,
  validatedPrepared: ValidatedWorkflowBudgetPreparedRequest,
): WorkflowBudgetReceipt {
  const { prepared, request } = validatedPrepared;
  if (
    receipt.operation !== prepared.operation ||
    receipt.workspaceId !== request.workspaceId ||
    receipt.runId !== request.runId ||
    receipt.accountId !== request.accountId ||
    receipt.reservationId !== request.reservationId ||
    receipt.callId !== request.callId ||
    receipt.expectedAccountRevision !== request.expectedAccountRevision ||
    receipt.expectedRunRevision !== request.expectedRunRevision ||
    receipt.correlationId !== request.correlationId ||
    receipt.requestHash !== prepared.requestHash ||
    receipt.idempotencyKey !== prepared.idempotencyKey ||
    receipt.requestFingerprint !== prepared.requestFingerprint ||
    receipt.serviceBuildHash !== request.route.authorityBuildHash
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH',
      '$',
      'Receipt does not bind the prepared request.',
    );
  }
  return receipt;
}

export function validateWorkflowBudgetReceiptForRequest(
  receiptValue: unknown,
  preparedValue: unknown,
): WorkflowBudgetReceipt {
  return validateWorkflowBudgetReceiptForPreparedRequest(
    validateWorkflowBudgetReceipt(receiptValue),
    validateWorkflowBudgetPreparedRequestWithRecord(preparedValue),
  );
}

export function validateWorkflowBudgetLedgerEntry(value: unknown): WorkflowBudgetLedgerEntry {
  const root = closed(
    value,
    [
      'schema',
      ...BASE_FIELDS,
      'kind',
      'entryId',
      'workspaceId',
      'runId',
      'accountId',
      'reservationId',
      'callId',
      'accountRevision',
      'runRevision',
      'previousAccountHash',
      'accountHash',
      'decisionHash',
      'encumbered',
      'settled',
      'released',
      'providerUsageHash',
      'reasonCode',
      'recordedAt',
    ],
    '$',
  );
  const kind = enumValue(own(root, 'kind'), WORKFLOW_BUDGET_AUTHORITY_LEDGER_KINDS, '$/kind');
  const encumbered = quantities(own(root, 'encumbered'), '$/encumbered');
  const settled = quantities(own(root, 'settled'), '$/settled');
  const released = quantities(own(root, 'released'), '$/released');
  const providerUsageHash =
    own(root, 'providerUsageHash') === null
      ? null
      : prefixedHash(own(root, 'providerUsageHash'), '$/providerUsageHash');
  const reasonCode =
    own(root, 'reasonCode') === null
      ? null
      : enumValue(
          own(root, 'reasonCode'),
          WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS,
          '$/reasonCode',
        );
  if (
    (kind === 'reserve_reserved' &&
      (!quantitiesEqual(settled, ZERO) ||
        !quantitiesEqual(released, ZERO) ||
        providerUsageHash !== null ||
        reasonCode !== null)) ||
    (kind === 'reserve_rejected' &&
      (!quantitiesEqual(encumbered, ZERO) ||
        !quantitiesEqual(settled, ZERO) ||
        !quantitiesEqual(released, ZERO) ||
        providerUsageHash !== null ||
        reasonCode !== null)) ||
    (kind === 'settlement_settled' &&
      (!quantitiesEqual(encumbered, ZERO) || providerUsageHash === null || reasonCode !== null)) ||
    (kind === 'settlement_reconciliation_required' &&
      (!quantitiesEqual(encumbered, ZERO) ||
        !quantitiesEqual(settled, ZERO) ||
        !quantitiesEqual(released, ZERO) ||
        reasonCode === null ||
        (reasonCode === 'usage_receipt_missing'
          ? providerUsageHash !== null
          : providerUsageHash === null)))
  ) {
    fail('WORKFLOW_BUDGET_AUTHORITY_INVALID', '$/kind', 'Ledger quantities do not match kind.');
  }
  const result = immutableContractValue({
    schema: literal(own(root, 'schema'), WORKFLOW_BUDGET_LEDGER_ENTRY_SCHEMA, '$/schema'),
    ...authorityBase(root, '$'),
    kind,
    entryId: id(own(root, 'entryId'), '$/entryId'),
    workspaceId: id(own(root, 'workspaceId'), '$/workspaceId'),
    runId: id(own(root, 'runId'), '$/runId'),
    accountId: id(own(root, 'accountId'), '$/accountId'),
    reservationId: id(own(root, 'reservationId'), '$/reservationId'),
    callId: id(own(root, 'callId'), '$/callId'),
    accountRevision: integer(own(root, 'accountRevision'), '$/accountRevision', 1),
    runRevision: integer(own(root, 'runRevision'), '$/runRevision', 1),
    previousAccountHash: hash(own(root, 'previousAccountHash'), '$/previousAccountHash'),
    accountHash: hash(own(root, 'accountHash'), '$/accountHash'),
    decisionHash: hash(own(root, 'decisionHash'), '$/decisionHash'),
    encumbered,
    settled,
    released,
    providerUsageHash,
    reasonCode,
    recordedAt: timestamp(own(root, 'recordedAt'), '$/recordedAt'),
  } satisfies WorkflowBudgetLedgerEntry);
  assertExact(result);
  return result;
}

export function validateWorkflowBudgetReceipt(value: unknown): WorkflowBudgetReceipt {
  const root = closed(
    value,
    [
      'schema',
      ...BASE_FIELDS,
      'operation',
      'status',
      'workspaceId',
      'runId',
      'accountId',
      'reservationId',
      'callId',
      'expectedAccountRevision',
      'acceptedAccountRevision',
      'expectedRunRevision',
      'acceptedRunRevision',
      'idempotencyKey',
      'requestFingerprint',
      'requestHash',
      'recordHash',
      'ledgerEntryHash',
      'correlationId',
      'serviceBuildHash',
      'committedAt',
      'reconciliationToken',
    ],
    '$',
  );
  const status = enumValue(
    own(root, 'status'),
    ['accepted', 'provider_reconciliation_required', 'database_reconciliation_required'] as const,
    '$/status',
  );
  const acceptedAccountRevision =
    own(root, 'acceptedAccountRevision') === null
      ? null
      : integer(own(root, 'acceptedAccountRevision'), '$/acceptedAccountRevision', 1);
  const acceptedRunRevision =
    own(root, 'acceptedRunRevision') === null
      ? null
      : integer(own(root, 'acceptedRunRevision'), '$/acceptedRunRevision', 1);
  const recordHash =
    own(root, 'recordHash') === null ? null : hash(own(root, 'recordHash'), '$/recordHash');
  const ledgerEntryHash =
    own(root, 'ledgerEntryHash') === null
      ? null
      : hash(own(root, 'ledgerEntryHash'), '$/ledgerEntryHash');
  const committedAt =
    own(root, 'committedAt') === null ? null : timestamp(own(root, 'committedAt'), '$/committedAt');
  const reconciliationToken =
    own(root, 'reconciliationToken') === null
      ? null
      : id(own(root, 'reconciliationToken'), '$/reconciliationToken');
  const accepted = status !== 'database_reconciliation_required';
  const reconciliationRequired = status !== 'accepted';
  if (
    (accepted &&
      (acceptedAccountRevision === null ||
        acceptedRunRevision === null ||
        recordHash === null ||
        ledgerEntryHash === null ||
        committedAt === null ||
        (reconciliationRequired ? reconciliationToken === null : reconciliationToken !== null))) ||
    (!accepted &&
      (acceptedAccountRevision !== null ||
        acceptedRunRevision !== null ||
        recordHash !== null ||
        ledgerEntryHash !== null ||
        committedAt !== null ||
        reconciliationToken === null))
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED',
      '$/status',
      'Receipt status fields are inconsistent.',
    );
  }
  if (
    accepted &&
    (acceptedAccountRevision !==
      integer(own(root, 'expectedAccountRevision'), '$/expectedAccountRevision') + 1 ||
      acceptedRunRevision !==
        integer(own(root, 'expectedRunRevision'), '$/expectedRunRevision') + 1)
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_STALE_REVISION',
      '$/acceptedAccountRevision',
      'Receipt revision is invalid.',
    );
  }
  const result = immutableContractValue({
    schema: literal(own(root, 'schema'), WORKFLOW_BUDGET_RECEIPT_SCHEMA, '$/schema'),
    ...authorityBase(root, '$'),
    operation: enumValue(own(root, 'operation'), ['reserve', 'settle'] as const, '$/operation'),
    status,
    workspaceId: id(own(root, 'workspaceId'), '$/workspaceId'),
    runId: id(own(root, 'runId'), '$/runId'),
    accountId: id(own(root, 'accountId'), '$/accountId'),
    reservationId: id(own(root, 'reservationId'), '$/reservationId'),
    callId: id(own(root, 'callId'), '$/callId'),
    expectedAccountRevision: integer(
      own(root, 'expectedAccountRevision'),
      '$/expectedAccountRevision',
    ),
    acceptedAccountRevision,
    expectedRunRevision: integer(own(root, 'expectedRunRevision'), '$/expectedRunRevision'),
    acceptedRunRevision,
    idempotencyKey: text(own(root, 'idempotencyKey'), IDEMPOTENCY, '$/idempotencyKey', 128),
    requestFingerprint: text(
      own(root, 'requestFingerprint'),
      FINGERPRINT,
      '$/requestFingerprint',
      71,
    ),
    requestHash: hash(own(root, 'requestHash'), '$/requestHash'),
    recordHash,
    ledgerEntryHash,
    correlationId: id(own(root, 'correlationId'), '$/correlationId'),
    serviceBuildHash: hash(own(root, 'serviceBuildHash'), '$/serviceBuildHash'),
    committedAt,
    reconciliationToken,
  } satisfies WorkflowBudgetReceipt);
  assertExact(result);
  return result;
}

interface ValidatedWorkflowBudgetReceiptResult {
  readonly receipt: WorkflowBudgetReceipt;
  readonly record: WorkflowBudgetReserveDecision | WorkflowBudgetSettlement;
  readonly ledger: WorkflowBudgetLedgerEntry;
}

export function validateWorkflowBudgetReceiptResult(
  receiptValue: unknown,
  preparedValue: unknown,
  recordValue: unknown,
  ledgerValue: unknown,
  reconciliationValue: unknown | null,
): ValidatedWorkflowBudgetReceiptResult {
  const receipt = validateWorkflowBudgetReceipt(receiptValue);
  const validatedPrepared = validateWorkflowBudgetPreparedRequestWithRecord(preparedValue);
  validateWorkflowBudgetReceiptForPreparedRequest(receipt, validatedPrepared);
  const ledger = validateWorkflowBudgetLedgerEntry(ledgerValue);
  const reserve =
    receipt.operation === 'reserve'
      ? validateWorkflowBudgetReserveDecisionWithRequest(recordValue)
      : null;
  const record = reserve?.decision ?? validateWorkflowBudgetSettlement(recordValue);
  const canonicalRecordRequest =
    reserve?.canonicalRequest ?? canonicalWorkflowBudgetAuthorityJson(record.request);
  if (canonicalRecordRequest !== validatedPrepared.canonicalRequest) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH',
      '$/request',
      'Durable budget result does not bind the prepared request.',
    );
  }
  const recordDomain = receipt.operation === 'reserve' ? 'reserve-decision' : 'settlement';
  const recordHash = hashWorkflowBudgetAuthorityValue(recordDomain, record);
  const ledgerHash = hashWorkflowBudgetAuthorityValue('ledger-entry', ledger);
  const expectedLedgerKind =
    record.schema === WORKFLOW_BUDGET_RESERVE_DECISION_SCHEMA
      ? record.status === 'reserved'
        ? 'reserve_reserved'
        : 'reserve_rejected'
      : record.status === 'settled'
        ? 'settlement_settled'
        : 'settlement_reconciliation_required';
  if (
    receipt.status === 'database_reconciliation_required' ||
    receipt.recordHash !== recordHash ||
    receipt.ledgerEntryHash !== ledgerHash ||
    receipt.acceptedAccountRevision !== record.afterAccount.accountRevision ||
    receipt.acceptedRunRevision !== record.afterAccount.runRevision ||
    receipt.committedAt !== record.afterAccount.updatedAt ||
    ledger.kind !== expectedLedgerKind ||
    ledger.decisionHash !== recordHash ||
    ledger.accountHash !== hashWorkflowBudgetAuthorityValue('account', record.afterAccount) ||
    ledger.accountRevision !== record.afterAccount.accountRevision ||
    ledger.runRevision !== record.afterAccount.runRevision
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH',
      '$',
      'Receipt does not bind the durable budget result.',
    );
  }
  if (
    record.schema === WORKFLOW_BUDGET_SETTLEMENT_SCHEMA &&
    record.status === 'reconciliation_required'
  ) {
    const reconciliation = validateWorkflowBudgetReconciliation(reconciliationValue);
    if (
      receipt.status !== 'provider_reconciliation_required' ||
      reconciliation.evidenceType !== 'provider_outcome' ||
      receipt.reconciliationToken !== reconciliation.reconciliationToken ||
      reconciliation.reasonCode !== record.reasonCode ||
      reconciliation.sourceRequestHash !== record.requestHash ||
      reconciliation.usageReceiptHash !== record.request.usageReceiptHash ||
      reconciliation.accountHash !==
        hashWorkflowBudgetAuthorityValue('account', record.afterAccount) ||
      reconciliation.reservationHash !== record.reservationHash ||
      reconciliation.observedAt !== record.committedAt
    ) {
      fail(
        'WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH',
        '$/reconciliationToken',
        'Provider reconciliation receipt binding drifted.',
      );
    }
  } else if (receipt.status !== 'accepted' || reconciliationValue !== null) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH',
      '$/status',
      'Accepted result receipt status drifted.',
    );
  }
  return { receipt, record, ledger };
}

export function validateWorkflowBudgetReceiptForResult(
  receiptValue: unknown,
  preparedValue: unknown,
  recordValue: unknown,
  ledgerValue: unknown,
  reconciliationValue: unknown | null,
): WorkflowBudgetReceipt {
  return validateWorkflowBudgetReceiptResult(
    receiptValue,
    preparedValue,
    recordValue,
    ledgerValue,
    reconciliationValue,
  ).receipt;
}

export function validateWorkflowBudgetReconciliation(value: unknown): WorkflowBudgetReconciliation {
  const root = closed(
    value,
    [
      'schema',
      ...BASE_FIELDS,
      'evidenceType',
      'reasonCode',
      'workspaceId',
      'runId',
      'accountId',
      'reservationId',
      'callId',
      'sourceRequestHash',
      'usageReceiptHash',
      'accountHash',
      'reservationHash',
      'reconciliationToken',
      'accountCountersChanged',
      'reservationReleaseAuthorized',
      'providerRetryAuthorized',
      'cachePublishAuthorized',
      'runReconciliationLatched',
      'observedAt',
    ],
    '$',
  );
  const evidenceType = enumValue(
    own(root, 'evidenceType'),
    ['provider_outcome', 'database_commit'] as const,
    '$/evidenceType',
  );
  const reasonCode =
    evidenceType === 'provider_outcome'
      ? enumValue(
          own(root, 'reasonCode'),
          WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS,
          '$/reasonCode',
        )
      : enumValue(
          own(root, 'reasonCode'),
          WORKFLOW_BUDGET_AUTHORITY_DATABASE_RECONCILIATION_REASONS,
          '$/reasonCode',
        );
  const usageReceiptHash =
    own(root, 'usageReceiptHash') === null
      ? null
      : prefixedHash(own(root, 'usageReceiptHash'), '$/usageReceiptHash');
  if (
    (evidenceType === 'database_commit' && usageReceiptHash !== null) ||
    (evidenceType === 'provider_outcome' &&
      (reasonCode === 'usage_receipt_missing'
        ? usageReceiptHash !== null
        : usageReceiptHash === null))
  ) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_RECONCILIATION_REQUIRED',
      '$/usageReceiptHash',
      'Reconciliation domains are mixed.',
    );
  }
  const result = immutableContractValue({
    schema: literal(own(root, 'schema'), WORKFLOW_BUDGET_RECONCILIATION_SCHEMA, '$/schema'),
    ...authorityBase(root, '$'),
    evidenceType,
    reasonCode,
    workspaceId: id(own(root, 'workspaceId'), '$/workspaceId'),
    runId: id(own(root, 'runId'), '$/runId'),
    accountId: id(own(root, 'accountId'), '$/accountId'),
    reservationId: id(own(root, 'reservationId'), '$/reservationId'),
    callId: id(own(root, 'callId'), '$/callId'),
    sourceRequestHash: hash(own(root, 'sourceRequestHash'), '$/sourceRequestHash'),
    usageReceiptHash,
    accountHash: hash(own(root, 'accountHash'), '$/accountHash'),
    reservationHash: hash(own(root, 'reservationHash'), '$/reservationHash'),
    reconciliationToken: id(own(root, 'reconciliationToken'), '$/reconciliationToken'),
    accountCountersChanged: booleanLiteral(
      own(root, 'accountCountersChanged'),
      false,
      '$/accountCountersChanged',
    ) as false,
    reservationReleaseAuthorized: booleanLiteral(
      own(root, 'reservationReleaseAuthorized'),
      false,
      '$/reservationReleaseAuthorized',
    ) as false,
    providerRetryAuthorized: booleanLiteral(
      own(root, 'providerRetryAuthorized'),
      false,
      '$/providerRetryAuthorized',
    ) as false,
    cachePublishAuthorized: booleanLiteral(
      own(root, 'cachePublishAuthorized'),
      false,
      '$/cachePublishAuthorized',
    ) as false,
    runReconciliationLatched: booleanLiteral(
      own(root, 'runReconciliationLatched'),
      true,
      '$/runReconciliationLatched',
    ) as true,
    observedAt: timestamp(own(root, 'observedAt'), '$/observedAt'),
  } satisfies WorkflowBudgetReconciliation);
  assertExact(result);
  return result;
}

export function validateWorkflowBudgetLegacyApprovalObservation(
  value: unknown,
): WorkflowBudgetLegacyApprovalObservation {
  const root = closed(
    value,
    [
      'schema',
      ...BASE_FIELDS,
      'workspaceId',
      'runId',
      'status',
      'revision',
      'semantics',
      'limitAmendmentAuthority',
      'reservationAuthority',
      'settlementAuthority',
      'observedAt',
    ],
    '$',
  );
  const result = immutableContractValue({
    schema: literal(own(root, 'schema'), WORKFLOW_BUDGET_LEGACY_APPROVAL_SCHEMA, '$/schema'),
    ...authorityBase(root, '$'),
    workspaceId: id(own(root, 'workspaceId'), '$/workspaceId'),
    runId: id(own(root, 'runId'), '$/runId'),
    status: enumValue(
      own(root, 'status'),
      ['pending', 'approved', 'rejected', 'expired'] as const,
      '$/status',
    ),
    revision: integer(own(root, 'revision'), '$/revision'),
    semantics: literal(own(root, 'semantics'), 'run_gate_only', '$/semantics'),
    limitAmendmentAuthority: booleanLiteral(
      own(root, 'limitAmendmentAuthority'),
      false,
      '$/limitAmendmentAuthority',
    ) as false,
    reservationAuthority: booleanLiteral(
      own(root, 'reservationAuthority'),
      false,
      '$/reservationAuthority',
    ) as false,
    settlementAuthority: booleanLiteral(
      own(root, 'settlementAuthority'),
      false,
      '$/settlementAuthority',
    ) as false,
    observedAt: timestamp(own(root, 'observedAt'), '$/observedAt'),
  } satisfies WorkflowBudgetLegacyApprovalObservation);
  assertExact(result);
  return result;
}

function decimalParts(value: unknown, path: string): { whole: bigint; fraction: string } {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxRateDecimalBytes ||
    !RATE.test(value)
  ) {
    fail('WORKFLOW_BUDGET_AUTHORITY_INVALID_DECIMAL', path, `${path} must be a canonical decimal.`);
  }
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxRateFractionDigits) {
    fail('WORKFLOW_BUDGET_AUTHORITY_LIMIT_EXCEEDED', path, `${path} has too many fraction digits.`);
  }
  return { whole: BigInt(whole!), fraction };
}

function halfUp(numerator: bigint, denominator: bigint, path: string): string {
  const result = (numerator * 2n + denominator) / (denominator * 2n);
  if (result > MAX_INT64) {
    fail('WORKFLOW_BUDGET_AUTHORITY_DECIMAL_OVERFLOW', path, `${path} exceeds int64.`);
  }
  return result.toString();
}

export function workflowBudgetAuthorityUsdToNanoUsd(value: unknown): string {
  const { whole, fraction } = decimalParts(value, '$');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = whole * denominator + BigInt(fraction || '0');
  return halfUp(numerator * 1_000_000_000n, denominator, '$');
}

export function workflowBudgetAuthorityChargeNanoUsd(
  tokenQuantity: unknown,
  rateNanoUsdPerToken: unknown,
): string {
  const tokens = BigInt(validateWorkflowBudgetAuthorityDecimal(tokenQuantity, '$/tokens'));
  const { whole, fraction } = decimalParts(rateNanoUsdPerToken, '$/rateNanoUsdPerToken');
  const denominator = 10n ** BigInt(fraction.length);
  const rateNumerator = whole * denominator + BigInt(fraction || '0');
  return halfUp(tokens * rateNumerator, denominator, '$/nanoUsd');
}

export function parseWorkflowBudgetAuthorityBytes(bytes: Buffer): unknown {
  if (bytes.length > WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxRecordBytes) {
    fail(
      'WORKFLOW_BUDGET_AUTHORITY_LIMIT_EXCEEDED',
      '$',
      'Budget authority bytes exceed the limit.',
    );
  }
  return parseWorkflowEffectJson(bytes, {
    maxDepth: WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxJsonDepth,
    maxNodes: WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxJsonNodes,
    maxStringLength: WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxIdentifierBytes,
  });
}
