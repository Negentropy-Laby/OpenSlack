import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  buildProviderUsageIdentityHashes,
  buildProviderUsageReceipt,
} from '../../../agent-runtime/src/provider-usage-evidence.js';
import {
  WORKFLOW_BUDGET_ACCOUNT_SCHEMA,
  WORKFLOW_BUDGET_AUTHORITY_DIMENSIONS,
  WORKFLOW_BUDGET_AUTHORITY_GO_CLAIM,
  WORKFLOW_BUDGET_AUTHORITY_GO_ROLE,
  WORKFLOW_BUDGET_AUTHORITY_IDEMPOTENCY_PREFIX,
  WORKFLOW_BUDGET_AUTHORITY_MAX_INT64,
  WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS,
  WORKFLOW_BUDGET_AUTHORITY_ROUNDING,
  WORKFLOW_BUDGET_AUTHORITY_V2_GOLDEN_SHA256,
  WORKFLOW_BUDGET_AUTHORITY_V2_MANIFEST_SHA256,
  WORKFLOW_BUDGET_LEDGER_ENTRY_SCHEMA,
  WORKFLOW_BUDGET_LEGACY_APPROVAL_SCHEMA,
  WORKFLOW_BUDGET_PREPARED_REQUEST_SCHEMA,
  WORKFLOW_BUDGET_PROVIDER_USAGE_SCHEMA,
  WORKFLOW_BUDGET_RECEIPT_SCHEMA,
  WORKFLOW_BUDGET_RECONCILIATION_SCHEMA,
  WORKFLOW_BUDGET_RESERVATION_SCHEMA,
  WORKFLOW_BUDGET_RESERVE_DECISION_SCHEMA,
  WORKFLOW_BUDGET_RESERVE_REQUEST_SCHEMA,
  WORKFLOW_BUDGET_RUNNER_V1_GOLDEN_SHA256,
  WORKFLOW_BUDGET_RUNNER_V1_MANIFEST_SHA256,
  WORKFLOW_BUDGET_SETTLEMENT_REQUEST_SCHEMA,
  WORKFLOW_BUDGET_SETTLEMENT_SCHEMA,
  canonicalWorkflowBudgetAuthorityJson,
  evaluateWorkflowBudgetReserve,
  evaluateWorkflowBudgetSettlement,
  prepareWorkflowBudgetAuthorityRequest,
  validateWorkflowBudgetAccount,
  validateWorkflowBudgetAuthorityDecimal,
  validateWorkflowBudgetLedgerEntry,
  validateWorkflowBudgetLegacyApprovalObservation,
  validateWorkflowBudgetPreparedRequest,
  validateWorkflowBudgetProviderUsage,
  validateWorkflowBudgetReceipt,
  validateWorkflowBudgetReceiptForRequest,
  validateWorkflowBudgetReceiptForResult,
  validateWorkflowBudgetReconciliation,
  validateWorkflowBudgetReservationForDecision,
  validateWorkflowBudgetReservation,
  validateWorkflowBudgetReserveDecision,
  validateWorkflowBudgetReserveRequest,
  validateWorkflowBudgetSettlement,
  validateWorkflowBudgetSettlementRequest,
  workflowBudgetAuthorityChargeNanoUsd,
  workflowBudgetAuthorityUsdToNanoUsd,
} from '../workflow-budget-authority-contract.js';

const root = resolve('.');
const bundleRoot = resolve(root, 'packages/workflows/contracts/workflow-budget-authority/v1');
const sha = (path: string) =>
  createHash('sha256')
    .update(readFileSync(resolve(root, path)))
    .digest('hex');

interface ExactVector {
  readonly value: unknown;
  readonly canonicalBytes: string;
  readonly byteLength: number;
  readonly sha256: string;
}

const loadJson = (path: string) =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const loadGolden = () =>
  loadJson(resolve(bundleRoot, 'golden-vectors.json')) as unknown as {
    vectors: {
      records: Record<string, ExactVector>;
      folds: Record<string, unknown>;
      negative: Array<{
        id: string;
        operation: string;
        input: unknown;
        schemaArtifact: string;
        expectedSchemaValid: boolean;
        expectedError: { code: string; path: string };
      }>;
    };
  };

function validateRecord(value: unknown): unknown {
  const schema = (value as { schema?: string })?.schema;
  switch (schema) {
    case WORKFLOW_BUDGET_ACCOUNT_SCHEMA:
      return validateWorkflowBudgetAccount(value);
    case WORKFLOW_BUDGET_RESERVE_REQUEST_SCHEMA:
      return validateWorkflowBudgetReserveRequest(value);
    case WORKFLOW_BUDGET_RESERVE_DECISION_SCHEMA:
      return validateWorkflowBudgetReserveDecision(value);
    case WORKFLOW_BUDGET_RESERVATION_SCHEMA:
      return validateWorkflowBudgetReservation(value);
    case WORKFLOW_BUDGET_PROVIDER_USAGE_SCHEMA:
      return validateWorkflowBudgetProviderUsage(value);
    case WORKFLOW_BUDGET_SETTLEMENT_REQUEST_SCHEMA:
      return validateWorkflowBudgetSettlementRequest(value);
    case WORKFLOW_BUDGET_SETTLEMENT_SCHEMA:
      return validateWorkflowBudgetSettlement(value);
    case WORKFLOW_BUDGET_LEDGER_ENTRY_SCHEMA:
      return validateWorkflowBudgetLedgerEntry(value);
    case WORKFLOW_BUDGET_RECEIPT_SCHEMA:
      return validateWorkflowBudgetReceipt(value);
    case WORKFLOW_BUDGET_RECONCILIATION_SCHEMA:
      return validateWorkflowBudgetReconciliation(value);
    case WORKFLOW_BUDGET_LEGACY_APPROVAL_SCHEMA:
      return validateWorkflowBudgetLegacyApprovalObservation(value);
    case WORKFLOW_BUDGET_PREPARED_REQUEST_SCHEMA:
      return validateWorkflowBudgetPreparedRequest(value);
    default:
      throw new Error(`Unknown budget vector schema: ${String(schema)}`);
  }
}

function executeNegative(operation: string, input: unknown): unknown {
  const pair = input as Record<string, unknown>;
  switch (operation) {
    case 'validate_account':
      return validateWorkflowBudgetAccount(input);
    case 'validate_reserve_request':
      return validateWorkflowBudgetReserveRequest(input);
    case 'validate_provider_usage':
      return validateWorkflowBudgetProviderUsage(input);
    case 'validate_settlement_request':
      return validateWorkflowBudgetSettlementRequest(input);
    case 'validate_settlement':
      return validateWorkflowBudgetSettlement(input);
    case 'validate_receipt':
      return validateWorkflowBudgetReceipt(input);
    case 'validate_reconciliation':
      return validateWorkflowBudgetReconciliation(input);
    case 'validate_legacy_approval':
      return validateWorkflowBudgetLegacyApprovalObservation(input);
    case 'validate_prepared_request':
      return validateWorkflowBudgetPreparedRequest(input);
    case 'validate_receipt_for_prepared_request':
      return validateWorkflowBudgetReceiptForRequest(pair.receipt, pair.preparedRequest);
    case 'validate_reservation_for_decision':
      return validateWorkflowBudgetReservationForDecision(pair.reservation, pair.decision);
    case 'validate_reserve_decision':
      return validateWorkflowBudgetReserveDecision(input);
    case 'evaluate_settlement':
      return evaluateWorkflowBudgetSettlement(
        pair.account,
        pair.reservation,
        pair.request,
        pair.committedAt,
      );
    default:
      throw new Error(`Unknown negative operation: ${operation}`);
  }
}

function negativeSchemaSubject(operation: string, input: unknown): unknown {
  const pair = input as Record<string, unknown>;
  if (operation === 'validate_receipt_for_prepared_request') return pair.receipt;
  if (operation === 'validate_reservation_for_decision') return pair.reservation;
  if (operation === 'evaluate_settlement') return pair.request;
  return input;
}

function schemaValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  const manifest = loadJson(resolve(bundleRoot, 'manifest.json'));
  for (const path of (manifest.bundleFiles as string[]).filter((entry) =>
    entry.startsWith('schemas/'),
  )) {
    ajv.addSchema(loadJson(resolve(bundleRoot, path)));
  }
  return ajv;
}

describe('Workflow budget authority GS9-E1 contract', () => {
  it('freezes the nonauthorizing E1 boundary and three int64 dimensions', () => {
    expect(WORKFLOW_BUDGET_AUTHORITY_DIMENSIONS).toEqual(['tokens', 'nano_usd', 'calls']);
    expect(WORKFLOW_BUDGET_AUTHORITY_MAX_INT64).toBe('9223372036854775807');
    expect(WORKFLOW_BUDGET_AUTHORITY_ROUNDING).toBe('half_up_nonnegative');
    expect(WORKFLOW_BUDGET_AUTHORITY_GO_ROLE).toBe('validator_only');
    expect(WORKFLOW_BUDGET_AUTHORITY_GO_CLAIM).toBe('NO_AUTHORITY');
    expect(WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS).toEqual([
      'provider_outcome_unknown',
      'usage_receipt_missing',
      'usage_receipt_untrusted',
      'usage_overrun',
    ]);
  });

  it('pins the GS9-A authority and runner-v1 exact bytes', () => {
    expect(sha('packages/workflows/contracts/workflow-control-authority/v2/manifest.json')).toBe(
      WORKFLOW_BUDGET_AUTHORITY_V2_MANIFEST_SHA256,
    );
    expect(
      sha('packages/workflows/contracts/workflow-control-authority/v2/golden-vectors.json'),
    ).toBe(WORKFLOW_BUDGET_AUTHORITY_V2_GOLDEN_SHA256);
    expect(sha('packages/workflows/contracts/workflow-runner/v1/manifest.json')).toBe(
      WORKFLOW_BUDGET_RUNNER_V1_MANIFEST_SHA256,
    );
    expect(sha('packages/workflows/contracts/workflow-runner/v1/golden-vectors.json')).toBe(
      WORKFLOW_BUDGET_RUNNER_V1_GOLDEN_SHA256,
    );
  });

  it('keeps the contract pure and out of DB, HTTP, routing, and agent-runtime composition', () => {
    const source = readFileSync(
      resolve(root, 'packages/workflows/src/workflow-budget-authority-contract.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"]node:(?:fs|http|https|net|process)/u);
    expect(source).not.toMatch(/@openslack\/agent-runtime/u);
    expect(source).not.toMatch(/\b(?:pgx|postgres|migration|listenAndServe|fetch\s*\()/u);
  });

  it('validates every generated record through runtime and closed JSON Schemas', () => {
    const ajv = schemaValidator();

    const golden = loadGolden();
    for (const [name, vector] of Object.entries(golden.vectors.records)) {
      const validated = validateRecord(vector.value);
      expect(canonicalWorkflowBudgetAuthorityJson(validated), name).toBe(vector.canonicalBytes);
      expect(Buffer.byteLength(vector.canonicalBytes), name).toBe(vector.byteLength);
      expect(createHash('sha256').update(vector.canonicalBytes).digest('hex'), name).toBe(
        vector.sha256,
      );
      const schema = (vector.value as { schema: string }).schema;
      const schemaId =
        schema === WORKFLOW_BUDGET_PROVIDER_USAGE_SCHEMA
          ? 'https://openslack.dev/contracts/workflow-budget-authority/v1/schemas/provider-usage-receipt.v1.schema.json'
          : `https://openslack.dev/contracts/workflow-budget-authority/v1/schemas/${schema
              .replace(/^openslack\./u, '')
              .replaceAll('_', '-')}.schema.json`;
      const validator = ajv.getSchema(schemaId);
      expect(validator, name).toBeDefined();
      expect(validator!(vector.value), `${name}: ${ajv.errorsText(validator!.errors)}`).toBe(true);
    }
  });

  it('folds reserve, durable reject, settle, and provider reconciliation exactly', () => {
    const records = loadGolden().vectors.records;
    const account = records.account!.value;
    const reserveRequest = records.reserveRequest!.value;
    const reserved = evaluateWorkflowBudgetReserve(
      account,
      reserveRequest,
      '2026-08-14T00:00:02.000Z',
    );
    expect(reserved.decision.status).toBe('reserved');
    expect(reserved.decision.afterAccount.reserved).toEqual({
      tokens: '600',
      nanoUsd: '6000',
      calls: '1',
    });

    const reservation = records.reservation!.value;
    const preparedSettlement = validateWorkflowBudgetPreparedRequest(
      records.preparedSettlement!.value,
    );
    const settlementRequest = validateWorkflowBudgetSettlementRequest(
      JSON.parse(preparedSettlement.body),
    );
    const settled = evaluateWorkflowBudgetSettlement(
      reserved.decision.afterAccount,
      reservation,
      settlementRequest,
      '2026-08-14T00:00:06.000Z',
    );
    expect(settled.settlement.status).toBe('settled');
    expect(settled.settlement.afterAccount.reserved).toEqual({
      tokens: '400',
      nanoUsd: '4000',
      calls: '1',
    });
    expect(settled.settlement.afterAccount.settled).toEqual({
      tokens: '400',
      nanoUsd: '4000',
      calls: '1',
    });

    const unknown = validateWorkflowBudgetSettlement(records.providerUnknown!.value);
    expect(unknown.reservationRemainsOpen).toBe(true);
    expect(unknown.providerRetryAuthorized).toBe(false);
    expect(unknown.cachePublishAuthorized).toBe(false);
    expect(unknown.afterAccount.reserved).toEqual(unknown.reservation.reserved);
  });

  it('uses exact BigInt half-up arithmetic and rejects noncanonical quantities', () => {
    expect(workflowBudgetAuthorityUsdToNanoUsd('0.0000000004')).toBe('0');
    expect(workflowBudgetAuthorityUsdToNanoUsd('0.0000000005')).toBe('1');
    expect(workflowBudgetAuthorityChargeNanoUsd('3', '0.5')).toBe('2');
    expect(workflowBudgetAuthorityChargeNanoUsd('400', '10')).toBe('4000');
    expect(() => validateWorkflowBudgetAuthorityDecimal('01')).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_BUDGET_AUTHORITY_INVALID_DECIMAL' }),
    );
    expect(() => validateWorkflowBudgetAuthorityDecimal('9223372036854775808')).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_BUDGET_AUTHORITY_DECIMAL_OVERFLOW' }),
    );
  });

  it('binds one reserve to one provider turn, canonical request, idempotency key, and receipt', () => {
    const records = loadGolden().vectors.records;
    const request = validateWorkflowBudgetReserveRequest(records.reserveRequest!.value);
    expect(request.requested.calls).toBe('1');
    expect(request.requested.nanoUsd).toBe(
      workflowBudgetAuthorityChargeNanoUsd(request.requested.tokens, request.rateNanoUsdPerToken),
    );
    expect(request.expectedProviderRunHash).not.toBe(
      `sha256:${createHash('sha256').update('openslack.provider-usage-run.v1\0run-1').digest('hex')}`,
    );
    const prepared = prepareWorkflowBudgetAuthorityRequest(
      'reserve',
      request,
      'qualification-caller',
    );
    expect(prepared.body.endsWith('\n')).toBe(true);
    expect(prepared.idempotencyKey).toBe(
      `${WORKFLOW_BUDGET_AUTHORITY_IDEMPOTENCY_PREFIX}${prepared.requestHash}`,
    );
    const receipt = validateWorkflowBudgetReceiptForRequest(
      records.reserveReceipt!.value,
      prepared,
    );
    expect(receipt.callId).toBe(request.callId);
    expect(() =>
      validateWorkflowBudgetReceiptForRequest(
        { ...receipt, requestFingerprint: `sha256:${'0'.repeat(64)}` },
        prepared,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_BUDGET_AUTHORITY_IDENTITY_MISMATCH' }),
    );
  });

  it('keeps failed calls with trusted usage settleable while legacy approval remains inert', () => {
    const records = loadGolden().vectors.records;
    const failed = validateWorkflowBudgetSettlement(
      records.failedProviderSettledBeforeRethrow!.value,
    );
    expect(failed.status).toBe('settled');
    expect(failed.request.providerUsage?.outcome).toBe('provider_attempt_failed');
    expect(failed.cachePublishAuthorized).toBe(false);
    const legacy = validateWorkflowBudgetLegacyApprovalObservation(
      records.legacyApprovedNoAuthority!.value,
    );
    expect(legacy.status).toBe('approved');
    expect(legacy.limitAmendmentAuthority).toBe(false);
    expect(legacy.reservationAuthority).toBe(false);
    expect(legacy.settlementAuthority).toBe(false);
  });

  it('returns exact accepted receipt bytes for replay without a duplicate body status', () => {
    const records = loadGolden().vectors.records;
    expect(records.reserveExactReplay).toEqual(records.reserveReceipt);
    expect((records.reserveExactReplay!.value as { status: string }).status).toBe('accepted');
    expect(records.rejectedReserveExactReplay).toEqual(records.rejectedReserveReceipt);
    expect((records.rejectedReserveExactReplay!.value as { status: string }).status).toBe(
      'accepted',
    );
    expect((records.reserveRejected!.value as { status: string }).status).toBe('rejected');
    expect(records.settlementExactReplay).toEqual(records.settlementReceipt);
    expect(records.failedProviderSettlementExactReplay).toEqual(
      records.failedProviderSettlementReceipt,
    );
    for (const prefix of ['providerUnknown', 'missingUsage', 'untrustedUsage', 'usageOverrun']) {
      expect(records[`${prefix}ExactReplay`], prefix).toEqual(records[`${prefix}Receipt`]);
      expect((records[`${prefix}Receipt`]!.value as { status: string }).status, prefix).toBe(
        'provider_reconciliation_required',
      );
    }
    expect((records.databaseReconciliationReceipt!.value as { status: string }).status).toBe(
      'database_reconciliation_required',
    );
  });

  it('binds every durable fold to ledger, reconciliation, exact receipt, and replay', () => {
    const folds = loadGolden().vectors.folds as Record<string, Record<string, unknown>>;
    for (const [name, fold] of Object.entries(folds)) {
      expect(fold.exactReplay, name).toEqual(fold.receipt);
      const operation = 'decision' in fold ? 'reserve' : 'settle';
      const prepared =
        operation === 'reserve'
          ? prepareWorkflowBudgetAuthorityRequest(
              'reserve',
              validateWorkflowBudgetReserveRequest(fold.request),
              'qualification-caller',
            )
          : prepareWorkflowBudgetAuthorityRequest(
              'settle',
              validateWorkflowBudgetSettlementRequest(fold.request),
              'qualification-caller',
            );
      expect(
        validateWorkflowBudgetReceiptForResult(
          fold.receipt,
          prepared,
          fold.decision ?? fold.settlement,
          fold.ledgerEntry,
          fold.reconciliation,
        ),
        name,
      ).toEqual(fold.receipt);
    }
  });

  it('accepts actual agent-runtime provider receipts for a distinct agent run identity', () => {
    const records = loadGolden().vectors.records;
    const reserveRequest = validateWorkflowBudgetReserveRequest(records.reserveRequest!.value);
    const expectedIdentity = buildProviderUsageIdentityHashes(
      'provider-1',
      'model-1',
      'agent-run-1',
    );
    expect({
      providerHash: reserveRequest.expectedProviderHash,
      modelHash: reserveRequest.expectedModelHash,
      runHash: reserveRequest.expectedProviderRunHash,
    }).toEqual(expectedIdentity);
    expect(reserveRequest.runId).not.toBe('agent-run-1');

    const reported = buildProviderUsageReceipt({
      providerId: 'provider-1',
      modelId: 'model-1',
      runId: 'agent-run-1',
      attempt: 1,
      status: 'reported',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      outcome: 'provider_response_accepted',
      requestBytes: 'request',
      outcomeBytes: 'outcome',
    });
    expect(validateWorkflowBudgetProviderUsage(reported)).toEqual(reported);
    const baseSettlement = validateWorkflowBudgetSettlement(records.settlementSettled!.value);
    const settlementRequest = validateWorkflowBudgetSettlementRequest({
      ...baseSettlement.request,
      usageReceiptHash: reported.receiptHash,
      providerUsage: reported,
    });
    const reservedDecision = validateWorkflowBudgetReserveDecision(records.reserveReserved!.value);
    const settled = evaluateWorkflowBudgetSettlement(
      reservedDecision.afterAccount,
      baseSettlement.reservation,
      settlementRequest,
      '2026-08-14T00:00:30.000Z',
    );
    expect(settled.settlement.status).toBe('settled');
    expect(settled.settlement.request.expectedProviderRunHash).toBe(reported.runHash);
    expect(() =>
      validateWorkflowBudgetSettlementRequest({
        ...settlementRequest,
        expectedModelHash: `sha256:${'0'.repeat(64)}`,
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_BUDGET_AUTHORITY_INVALID' }));
    const unreported = buildProviderUsageReceipt({
      providerId: 'provider-1',
      modelId: 'model-1',
      runId: 'agent-run-1',
      attempt: 2,
      status: 'unreported',
      usage: null,
      outcome: 'provider_attempt_failed',
      requestBytes: 'request-2',
      outcomeBytes: 'outcome-2',
    });
    expect(validateWorkflowBudgetProviderUsage(unreported)).toEqual(unreported);
    const totalOnly = buildProviderUsageReceipt({
      providerId: 'provider-1',
      modelId: 'model-1',
      runId: 'agent-run-1',
      attempt: 3,
      status: 'reported',
      usage: { totalTokens: 0 },
      outcome: 'provider_response_accepted',
      requestBytes: 'request-3',
      outcomeBytes: 'outcome-3',
    });
    const maximumExact = buildProviderUsageReceipt({
      providerId: 'provider-1',
      modelId: 'model-1',
      runId: 'agent-run-1',
      attempt: Number.MAX_SAFE_INTEGER,
      status: 'reported',
      usage: { totalTokens: Number.MAX_SAFE_INTEGER },
      outcome: 'provider_attempt_failed',
      requestBytes: 'request-maximum',
      outcomeBytes: 'outcome-maximum',
    });
    for (const receipt of [reported, unreported, totalOnly, maximumExact]) {
      expect(validateWorkflowBudgetProviderUsage(receipt)).toEqual(receipt);
    }
    expect(() =>
      validateWorkflowBudgetProviderUsage({ ...reported, outcome: 'provider_attempt_failed' }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_BUDGET_AUTHORITY_HASH_MISMATCH' }));
  });

  it('replays every frozen negative through runtime and records schema parity', () => {
    const negatives = loadGolden().vectors.negative;
    expect(negatives.map((entry) => entry.id)).toEqual([
      'decimal-leading-zero',
      'decimal-overflow',
      'account-settled-exceeds-reserved',
      'reserve-calls-must-equal-one',
      'reserve-rate-cost-drift',
      'rate-trailing-zero',
      'route-drift',
      'provider-receipt-hash-drift',
      'provider-attempt-drift',
      'provider-identity-drift',
      'missing-evidence-cannot-keep-hash',
      'exponent-rate-forbidden',
      'settlement-rate-drift',
      'settlement-reservation-drift',
      'settlement-reason-drift',
      'legacy-approval-cannot-reserve',
      'provider-and-database-reconciliation-are-disjoint',
      'database-unknown-cannot-claim-accepted-revision',
      'ambiguous-reconciliation-receipt-status',
      'prepared-request-fingerprint-drift',
      'receipt-build-drift',
      'reservation-decision-drift',
      'reserve-decision-time-drift',
      'settlement-request-before-reservation',
      'settlement-time-drift',
      'settlement-predates-reservation-revision',
      'settlement-overflow-precedes-stale-revision',
      'settlement-overflow-precedes-after-account-drift',
    ]);
    const ajv = schemaValidator();
    for (const entry of negatives) {
      let caught: unknown;
      try {
        executeNegative(entry.operation, entry.input);
      } catch (error) {
        caught = error;
      }
      expect(caught, entry.id).toMatchObject(entry.expectedError);
      const schema = loadJson(resolve(bundleRoot, entry.schemaArtifact));
      const valid = ajv.getSchema(schema.$id as string)!(
        negativeSchemaSubject(entry.operation, entry.input),
      );
      expect(valid, entry.id).toBe(entry.expectedSchemaValid);
    }
  });
});
