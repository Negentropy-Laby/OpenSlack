import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  WORKFLOW_BUDGET_ACCOUNT_SCHEMA,
  WORKFLOW_BUDGET_AUTHORITY,
  WORKFLOW_BUDGET_AUTHORITY_CONTRACT_VERSION,
  WORKFLOW_BUDGET_AUTHORITY_DATABASE_RECONCILIATION_REASONS,
  WORKFLOW_BUDGET_AUTHORITY_DIMENSIONS,
  WORKFLOW_BUDGET_AUTHORITY_ERROR_CODES,
  WORKFLOW_BUDGET_AUTHORITY_GO_CLAIM,
  WORKFLOW_BUDGET_AUTHORITY_GO_ROLE,
  WORKFLOW_BUDGET_AUTHORITY_IDEMPOTENCY_PREFIX,
  WORKFLOW_BUDGET_AUTHORITY_LEDGER_KINDS,
  WORKFLOW_BUDGET_AUTHORITY_LIMITS,
  WORKFLOW_BUDGET_AUTHORITY_MAX_INT64,
  WORKFLOW_BUDGET_AUTHORITY_MONEY_SCALE,
  WORKFLOW_BUDGET_AUTHORITY_MONEY_UNIT,
  WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS,
  WORKFLOW_BUDGET_AUTHORITY_ROUNDING,
  WORKFLOW_BUDGET_AUTHORITY_V2_GOLDEN_SHA256,
  WORKFLOW_BUDGET_AUTHORITY_V2_MANIFEST_SHA256,
  WORKFLOW_BUDGET_AUTHORITY_WRITER,
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
  WorkflowBudgetAuthorityContractError,
  canonicalWorkflowBudgetAuthorityJson,
  evaluateWorkflowBudgetReserve,
  evaluateWorkflowBudgetSettlement,
  hashWorkflowBudgetAuthorityValue,
  prepareWorkflowBudgetAuthorityRequest,
  validateWorkflowBudgetAccount,
  validateWorkflowBudgetLegacyApprovalObservation,
  validateWorkflowBudgetProviderUsage,
  validateWorkflowBudgetPreparedRequest,
  validateWorkflowBudgetReceipt,
  validateWorkflowBudgetReceiptForRequest,
  validateWorkflowBudgetReceiptForResult,
  validateWorkflowBudgetReconciliation,
  validateWorkflowBudgetReservationForDecision,
  validateWorkflowBudgetReserveDecision,
  validateWorkflowBudgetReserveRequest,
  validateWorkflowBudgetSettlement,
  validateWorkflowBudgetSettlementRequest,
  workflowBudgetAuthorityChargeNanoUsd,
  workflowBudgetAuthorityUsdToNanoUsd,
  type WorkflowBudgetAccount,
  type WorkflowBudgetLedgerEntry,
  type WorkflowBudgetProviderUsage,
  type WorkflowBudgetPreparedRequest,
  type WorkflowBudgetReceipt,
  type WorkflowBudgetReserveDecision,
  type WorkflowBudgetReserveRequest,
  type WorkflowBudgetSettlement,
  type WorkflowBudgetSettlementRequest,
} from '../../packages/workflows/src/workflow-budget-authority-contract.js';

type Json = Record<string, unknown>;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const outputRoot = process.env.OPENSLACK_WORKFLOW_BUDGET_AUTHORITY_CONTRACTS_OUTPUT_ROOT
  ? resolve(process.env.OPENSLACK_WORKFLOW_BUDGET_AUTHORITY_CONTRACTS_OUTPUT_ROOT)
  : root;
const contractRoot = resolve(
  outputRoot,
  'packages/workflows/contracts/workflow-budget-authority/v1',
);
const serviceMirrorRoot = resolve(
  outputRoot,
  'services/workflow-control/budgetcontract/generated/v1',
);
const paths = [
  'schemas/workflow-budget-account.v1.schema.json',
  'schemas/workflow-budget-reserve-request.v1.schema.json',
  'schemas/workflow-budget-reserve-decision.v1.schema.json',
  'schemas/workflow-budget-reservation.v1.schema.json',
  'schemas/provider-usage-receipt.v1.schema.json',
  'schemas/workflow-budget-settlement-request.v1.schema.json',
  'schemas/workflow-budget-settlement.v1.schema.json',
  'schemas/workflow-budget-ledger-entry.v1.schema.json',
  'schemas/workflow-budget-receipt.v1.schema.json',
  'schemas/workflow-budget-reconciliation.v1.schema.json',
  'schemas/workflow-budget-legacy-approval-observation.v1.schema.json',
  'schemas/workflow-budget-prepared-request.v1.schema.json',
  'golden-vectors.json',
  'manifest.json',
] as const;

const HASH = '^[0-9a-f]{64}$';
const PREFIXED_HASH = '^sha256:[0-9a-f]{64}$';
const ID = '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$';
const TIME = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
const DECIMAL = '^(?:0|[1-9][0-9]{0,18})$';
const RATE = '^(?:0|[1-9][0-9]*|(?:0|[1-9][0-9]*)\\.[0-9]{0,17}[1-9])$';
const IDEMPOTENCY = '^openslack\\.workflow-budget-authority\\.v1\\.[0-9a-f]{64}$';

const strict = (properties: Json, required: readonly string[] = Object.keys(properties)): Json => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const hash = { type: 'string', pattern: HASH };
const prefixedHash = { type: 'string', pattern: PREFIXED_HASH };
const id = { type: 'string', pattern: ID, maxLength: 256 };
const timestamp = { type: 'string', pattern: TIME, format: 'date-time' };
const decimal = {
  type: 'string',
  pattern: DECIMAL,
  maxLength: WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxDecimalBytes,
  $comment: `Runtime validation additionally enforces <= ${WORKFLOW_BUDGET_AUTHORITY_MAX_INT64}.`,
};
const positiveDecimal = { ...decimal, pattern: '^[1-9][0-9]{0,18}$' };
const rate = {
  type: 'string',
  pattern: RATE,
  maxLength: WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxRateDecimalBytes,
};
const revision = {
  type: 'integer',
  minimum: 0,
  maximum: WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxSafeInteger,
};
const positiveRevision = { ...revision, minimum: 1 };
const nullableHash = { oneOf: [hash, { type: 'null' }] };
const nullablePrefixedHash = { oneOf: [prefixedHash, { type: 'null' }] };
const nullableTimestamp = { oneOf: [timestamp, { type: 'null' }] };
const nullableId = { oneOf: [id, { type: 'null' }] };

const base = {
  contractVersion: { const: WORKFLOW_BUDGET_AUTHORITY_CONTRACT_VERSION },
  authority: { const: WORKFLOW_BUDGET_AUTHORITY },
  writer: { const: WORKFLOW_BUDGET_AUTHORITY_WRITER },
  goRole: { const: WORKFLOW_BUDGET_AUTHORITY_GO_ROLE },
  goAuthorityClaim: { const: WORKFLOW_BUDGET_AUTHORITY_GO_CLAIM },
  goAuthorityEligible: { const: false },
};
const quantities = strict({ tokens: decimal, nanoUsd: decimal, calls: decimal });
const oneCallQuantities = strict({ tokens: decimal, nanoUsd: decimal, calls: { const: '1' } });
const route = {
  oneOf: [
    strict({
      backend: { const: 'ts-local' },
      authority: { const: 'typescript' },
      routingEpoch: positiveRevision,
      authorityBuildHash: hash,
    }),
    strict({
      backend: { const: 'go' },
      authority: { const: 'workflow-control' },
      routingEpoch: positiveRevision,
      authorityBuildHash: hash,
    }),
  ],
};

const ids = (name: string) =>
  `https://openslack.dev/contracts/workflow-budget-authority/v1/schemas/${name}.schema.json`;
const accountRef = { $ref: ids('workflow-budget-account.v1') };
const reserveRequestRef = { $ref: ids('workflow-budget-reserve-request.v1') };
const reservationRef = { $ref: ids('workflow-budget-reservation.v1') };
const providerUsageRef = { $ref: ids('provider-usage-receipt.v1') };
const settlementRequestRef = { $ref: ids('workflow-budget-settlement-request.v1') };

const accountSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ids('workflow-budget-account.v1'),
  title: 'OpenSlack GS9-E1 cumulative budget account',
  ...strict({
    schema: { const: WORKFLOW_BUDGET_ACCOUNT_SCHEMA },
    ...base,
    workspaceId: id,
    runId: id,
    accountId: id,
    policyHash: hash,
    route,
    accountRevision: revision,
    runRevision: revision,
    limit: quantities,
    reserved: quantities,
    settled: quantities,
    updatedAt: timestamp,
  }),
};

const reserveRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ids('workflow-budget-reserve-request.v1'),
  title: 'OpenSlack GS9-E1 budget reserve request',
  ...strict({
    schema: { const: WORKFLOW_BUDGET_RESERVE_REQUEST_SCHEMA },
    ...base,
    workspaceId: id,
    runId: id,
    accountId: id,
    reservationId: id,
    callId: id,
    providerAttempt: positiveDecimal,
    expectedProviderHash: prefixedHash,
    expectedModelHash: prefixedHash,
    expectedProviderRunHash: prefixedHash,
    correlationId: id,
    policyHash: hash,
    route,
    expectedAccountRevision: revision,
    expectedRunRevision: revision,
    rateNanoUsdPerToken: rate,
    requested: oneCallQuantities,
    requestedAt: timestamp,
  }),
};

const reserveDecisionSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ids('workflow-budget-reserve-decision.v1'),
  title: 'OpenSlack GS9-E1 durable reserve decision',
  oneOf: [
    strict({
      schema: { const: WORKFLOW_BUDGET_RESERVE_DECISION_SCHEMA },
      ...base,
      status: { const: 'reserved' },
      request: reserveRequestRef,
      requestHash: hash,
      beforeAccountHash: hash,
      afterAccount: accountRef,
      authorization: oneCallQuantities,
      insufficientDimensions: { type: 'array', maxItems: 0 },
      legacyBudgetApprovalAuthority: { const: false },
      decidedAt: timestamp,
    }),
    strict({
      schema: { const: WORKFLOW_BUDGET_RESERVE_DECISION_SCHEMA },
      ...base,
      status: { const: 'rejected' },
      request: reserveRequestRef,
      requestHash: hash,
      beforeAccountHash: hash,
      afterAccount: accountRef,
      authorization: strict({
        tokens: { const: '0' },
        nanoUsd: { const: '0' },
        calls: { const: '0' },
      }),
      insufficientDimensions: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
        items: { enum: WORKFLOW_BUDGET_AUTHORITY_DIMENSIONS },
      },
      legacyBudgetApprovalAuthority: { const: false },
      decidedAt: timestamp,
    }),
  ],
};

const reservationSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ids('workflow-budget-reservation.v1'),
  title: 'OpenSlack GS9-E1 open provider-turn reservation',
  ...strict({
    schema: { const: WORKFLOW_BUDGET_RESERVATION_SCHEMA },
    ...base,
    workspaceId: id,
    runId: id,
    accountId: id,
    reservationId: id,
    callId: id,
    providerAttempt: positiveDecimal,
    expectedProviderHash: prefixedHash,
    expectedModelHash: prefixedHash,
    expectedProviderRunHash: prefixedHash,
    policyHash: hash,
    route,
    rateNanoUsdPerToken: rate,
    reserved: oneCallQuantities,
    reserveDecisionHash: hash,
    openedAccountRevision: positiveRevision,
    openedRunRevision: positiveRevision,
    openedAt: timestamp,
  }),
};

const providerUsageSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ids('provider-usage-receipt.v1'),
  title: 'OpenSlack bounded provider usage receipt v1',
  oneOf: [
    strict({
      schema: { const: WORKFLOW_BUDGET_PROVIDER_USAGE_SCHEMA },
      providerHash: prefixedHash,
      modelHash: prefixedHash,
      runHash: prefixedHash,
      attempt: positiveDecimal,
      calls: { const: '1' },
      status: { const: 'reported' },
      inputTokens: { oneOf: [decimal, { type: 'null' }] },
      outputTokens: { oneOf: [decimal, { type: 'null' }] },
      totalTokens: decimal,
      outcome: { enum: ['provider_response_accepted', 'provider_attempt_failed'] },
      requestHash: prefixedHash,
      outcomeHash: prefixedHash,
      receiptHash: prefixedHash,
    }),
    strict({
      schema: { const: WORKFLOW_BUDGET_PROVIDER_USAGE_SCHEMA },
      providerHash: prefixedHash,
      modelHash: prefixedHash,
      runHash: prefixedHash,
      attempt: positiveDecimal,
      calls: { const: '1' },
      status: { const: 'unreported' },
      inputTokens: { type: 'null' },
      outputTokens: { type: 'null' },
      totalTokens: { type: 'null' },
      outcome: { enum: ['provider_response_accepted', 'provider_attempt_failed'] },
      requestHash: prefixedHash,
      outcomeHash: prefixedHash,
      receiptHash: prefixedHash,
    }),
  ],
};

const settlementRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ids('workflow-budget-settlement-request.v1'),
  title: 'OpenSlack GS9-E1 budget settlement request',
  oneOf: [
    strict({
      schema: { const: WORKFLOW_BUDGET_SETTLEMENT_REQUEST_SCHEMA },
      ...base,
      workspaceId: id,
      runId: id,
      accountId: id,
      reservationId: id,
      callId: id,
      providerAttempt: positiveDecimal,
      expectedProviderHash: prefixedHash,
      expectedModelHash: prefixedHash,
      expectedProviderRunHash: prefixedHash,
      correlationId: id,
      policyHash: hash,
      route,
      expectedAccountRevision: revision,
      expectedRunRevision: revision,
      reserveDecisionHash: hash,
      usageEvidenceStatus: { const: 'trusted' },
      usageReceiptHash: prefixedHash,
      providerUsage: providerUsageRef,
      rateNanoUsdPerToken: rate,
      requestedAt: timestamp,
    }),
    ...(['missing', 'untrusted'] as const).map((status) =>
      strict({
        schema: { const: WORKFLOW_BUDGET_SETTLEMENT_REQUEST_SCHEMA },
        ...base,
        workspaceId: id,
        runId: id,
        accountId: id,
        reservationId: id,
        callId: id,
        providerAttempt: positiveDecimal,
        expectedProviderHash: prefixedHash,
        expectedModelHash: prefixedHash,
        expectedProviderRunHash: prefixedHash,
        correlationId: id,
        policyHash: hash,
        route,
        expectedAccountRevision: revision,
        expectedRunRevision: revision,
        reserveDecisionHash: hash,
        usageEvidenceStatus: { const: status },
        usageReceiptHash: status === 'missing' ? { type: 'null' } : prefixedHash,
        providerUsage: { type: 'null' },
        rateNanoUsdPerToken: rate,
        requestedAt: timestamp,
      }),
    ),
  ],
};

const settlementCommon = {
  schema: { const: WORKFLOW_BUDGET_SETTLEMENT_SCHEMA },
  ...base,
  request: settlementRequestRef,
  requestHash: hash,
  reservation: reservationRef,
  reservationHash: hash,
  beforeAccountHash: hash,
  afterAccount: accountRef,
  providerRetryAuthorized: { const: false },
  legacyBudgetApprovalAuthority: { const: false },
  committedAt: timestamp,
};
const settlementRequestForOutcome = (
  outcome: 'provider_response_accepted' | 'provider_attempt_failed',
) => ({
  allOf: [
    settlementRequestRef,
    {
      type: 'object',
      properties: {
        usageEvidenceStatus: { const: 'trusted' },
        providerUsage: {
          type: 'object',
          properties: { outcome: { const: outcome } },
          required: ['outcome'],
        },
      },
      required: ['usageEvidenceStatus', 'providerUsage'],
    },
  ],
});
const settlementSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ids('workflow-budget-settlement.v1'),
  title: 'OpenSlack GS9-E1 budget settlement result',
  oneOf: [
    strict({
      ...settlementCommon,
      request: settlementRequestForOutcome('provider_response_accepted'),
      status: { const: 'settled' },
      released: quantities,
      reasonCode: { type: 'null' },
      reservationRemainsOpen: { const: false },
      runReconciliationLatched: { const: false },
      cachePublishAuthorized: { const: true },
    }),
    strict({
      ...settlementCommon,
      request: settlementRequestForOutcome('provider_attempt_failed'),
      status: { const: 'settled' },
      released: quantities,
      reasonCode: { type: 'null' },
      reservationRemainsOpen: { const: false },
      runReconciliationLatched: { const: false },
      cachePublishAuthorized: { const: false },
    }),
    strict({
      ...settlementCommon,
      status: { const: 'reconciliation_required' },
      released: { type: 'null' },
      reasonCode: { enum: WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS },
      reservationRemainsOpen: { const: true },
      runReconciliationLatched: { const: true },
      cachePublishAuthorized: { const: false },
    }),
  ],
};

const ledgerSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ids('workflow-budget-ledger-entry.v1'),
  title: 'OpenSlack GS9-E1 append-only budget ledger entry',
  ...strict({
    schema: { const: WORKFLOW_BUDGET_LEDGER_ENTRY_SCHEMA },
    ...base,
    kind: { enum: WORKFLOW_BUDGET_AUTHORITY_LEDGER_KINDS },
    entryId: id,
    workspaceId: id,
    runId: id,
    accountId: id,
    reservationId: id,
    callId: id,
    accountRevision: positiveRevision,
    runRevision: positiveRevision,
    previousAccountHash: hash,
    accountHash: hash,
    decisionHash: hash,
    encumbered: quantities,
    settled: quantities,
    released: quantities,
    providerUsageHash: nullablePrefixedHash,
    reasonCode: {
      oneOf: [
        { enum: WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS },
        { type: 'null' },
      ],
    },
    recordedAt: timestamp,
  }),
};

const receiptCommon = {
  schema: { const: WORKFLOW_BUDGET_RECEIPT_SCHEMA },
  ...base,
  operation: { enum: ['reserve', 'settle'] },
  workspaceId: id,
  runId: id,
  accountId: id,
  reservationId: id,
  callId: id,
  expectedAccountRevision: revision,
  expectedRunRevision: revision,
  idempotencyKey: { type: 'string', pattern: IDEMPOTENCY },
  requestFingerprint: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
  requestHash: hash,
  correlationId: id,
  serviceBuildHash: hash,
};
const receiptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ids('workflow-budget-receipt.v1'),
  title: 'OpenSlack GS9-E1 exact budget receipt',
  oneOf: [
    strict({
      ...receiptCommon,
      status: { const: 'accepted' },
      acceptedAccountRevision: positiveRevision,
      acceptedRunRevision: positiveRevision,
      recordHash: hash,
      ledgerEntryHash: hash,
      committedAt: timestamp,
      reconciliationToken: { type: 'null' },
    }),
    strict({
      ...receiptCommon,
      status: { const: 'provider_reconciliation_required' },
      acceptedAccountRevision: positiveRevision,
      acceptedRunRevision: positiveRevision,
      recordHash: hash,
      ledgerEntryHash: hash,
      committedAt: timestamp,
      reconciliationToken: id,
    }),
    strict({
      ...receiptCommon,
      status: { const: 'database_reconciliation_required' },
      acceptedAccountRevision: { type: 'null' },
      acceptedRunRevision: { type: 'null' },
      recordHash: { type: 'null' },
      ledgerEntryHash: { type: 'null' },
      committedAt: { type: 'null' },
      reconciliationToken: id,
    }),
  ],
};

const reconciliationCommon = {
  schema: { const: WORKFLOW_BUDGET_RECONCILIATION_SCHEMA },
  ...base,
  workspaceId: id,
  runId: id,
  accountId: id,
  reservationId: id,
  callId: id,
  sourceRequestHash: hash,
  accountHash: hash,
  reservationHash: hash,
  reconciliationToken: id,
  accountCountersChanged: { const: false },
  reservationReleaseAuthorized: { const: false },
  providerRetryAuthorized: { const: false },
  cachePublishAuthorized: { const: false },
  runReconciliationLatched: { const: true },
  observedAt: timestamp,
};
const reconciliationSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ids('workflow-budget-reconciliation.v1'),
  title: 'OpenSlack GS9-E1 provider-or-database reconciliation evidence',
  oneOf: [
    ...WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS.map((reasonCode) =>
      strict({
        ...reconciliationCommon,
        evidenceType: { const: 'provider_outcome' },
        reasonCode: { const: reasonCode },
        usageReceiptHash: reasonCode === 'usage_receipt_missing' ? { type: 'null' } : prefixedHash,
      }),
    ),
    strict({
      ...reconciliationCommon,
      evidenceType: { const: 'database_commit' },
      reasonCode: { const: 'database_commit_outcome_unknown' },
      usageReceiptHash: { type: 'null' },
    }),
  ],
};

const legacyApprovalSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ids('workflow-budget-legacy-approval-observation.v1'),
  title: 'OpenSlack legacy budget pause observation without durable authority',
  ...strict({
    schema: { const: WORKFLOW_BUDGET_LEGACY_APPROVAL_SCHEMA },
    ...base,
    workspaceId: id,
    runId: id,
    status: { enum: ['pending', 'approved', 'rejected', 'expired'] },
    revision,
    semantics: { const: 'run_gate_only' },
    limitAmendmentAuthority: { const: false },
    reservationAuthority: { const: false },
    settlementAuthority: { const: false },
    observedAt: timestamp,
  }),
};

const preparedRequestSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: ids('workflow-budget-prepared-request.v1'),
  title: 'OpenSlack GS9-E1 canonical prepared budget request',
  oneOf: (['reserve', 'settle'] as const).map((operation) =>
    strict({
      schema: { const: WORKFLOW_BUDGET_PREPARED_REQUEST_SCHEMA },
      operation: { const: operation },
      method: { const: 'POST' },
      path: {
        const:
          operation === 'reserve'
            ? '/v1/authority/workflow-budgets:reserve'
            : '/v1/authority/workflow-budgets:settle',
      },
      callerId: id,
      body: {
        type: 'string',
        pattern: '\\n$',
        maxLength: WORKFLOW_BUDGET_AUTHORITY_LIMITS.maxRecordBytes,
      },
      requestHash: hash,
      idempotencyKey: { type: 'string', pattern: IDEMPOTENCY },
      requestFingerprint: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    }),
  ),
};

const authorityEnvelope = () => ({
  contractVersion: WORKFLOW_BUDGET_AUTHORITY_CONTRACT_VERSION,
  authority: WORKFLOW_BUDGET_AUTHORITY,
  writer: WORKFLOW_BUDGET_AUTHORITY_WRITER,
  goRole: WORKFLOW_BUDGET_AUTHORITY_GO_ROLE,
  goAuthorityClaim: WORKFLOW_BUDGET_AUTHORITY_GO_CLAIM,
  goAuthorityEligible: false,
});

const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const providerHash = (domain: string, value: string) =>
  `sha256:${createHash('sha256').update(domain).update('\0').update(value).digest('hex')}`;
function buildProviderUsage(
  runId: string,
  attempt: string,
  status: 'reported' | 'unreported',
  usage: { input: string; output: string; total: string } | null,
  outcome: 'provider_response_accepted' | 'provider_attempt_failed',
  suffix: string,
): WorkflowBudgetProviderUsage {
  const unsigned = {
    schema: WORKFLOW_BUDGET_PROVIDER_USAGE_SCHEMA,
    providerHash: providerHash('openslack.provider-usage-provider.v1', 'provider-1'),
    modelHash: providerHash('openslack.provider-usage-model.v1', 'model-1'),
    runHash: providerHash('openslack.provider-usage-run.v1', runId),
    attempt,
    calls: '1' as const,
    status,
    inputTokens: usage?.input ?? null,
    outputTokens: usage?.output ?? null,
    totalTokens: usage?.total ?? null,
    outcome,
    requestHash: providerHash('openslack.provider-usage-request.v1', `request-${suffix}`),
    outcomeHash: providerHash('openslack.provider-usage-outcome.v1', `outcome-${suffix}`),
  };
  return validateWorkflowBudgetProviderUsage({
    ...unsigned,
    receiptHash: providerHash(
      'openslack.provider-usage-receipt.v1',
      canonicalWorkflowBudgetAuthorityJson(unsigned),
    ),
  });
}

const exact = (value: unknown) => {
  const canonicalBytes = canonicalWorkflowBudgetAuthorityJson(value);
  return {
    value,
    canonicalBytes,
    byteLength: Buffer.byteLength(canonicalBytes),
    sha256: sha(canonicalBytes),
  };
};

function acceptedReceipt(
  operation: 'reserve' | 'settle',
  request: WorkflowBudgetReserveRequest | WorkflowBudgetSettlementRequest,
  record: WorkflowBudgetReserveDecision | WorkflowBudgetSettlement,
  ledger: WorkflowBudgetLedgerEntry,
): WorkflowBudgetReceipt {
  const prepared: WorkflowBudgetPreparedRequest =
    operation === 'reserve'
      ? prepareWorkflowBudgetAuthorityRequest(
          'reserve',
          request as WorkflowBudgetReserveRequest,
          'qualification-caller',
        )
      : prepareWorkflowBudgetAuthorityRequest(
          'settle',
          request as WorkflowBudgetSettlementRequest,
          'qualification-caller',
        );
  const recordHash = hashWorkflowBudgetAuthorityValue(
    operation === 'reserve' ? 'reserve-decision' : 'settlement',
    record,
  );
  const receipt = validateWorkflowBudgetReceipt({
    schema: WORKFLOW_BUDGET_RECEIPT_SCHEMA,
    ...authorityEnvelope(),
    operation,
    status: 'accepted',
    workspaceId: request.workspaceId,
    runId: request.runId,
    accountId: request.accountId,
    reservationId: request.reservationId,
    callId: request.callId,
    expectedAccountRevision: request.expectedAccountRevision,
    acceptedAccountRevision: request.expectedAccountRevision + 1,
    expectedRunRevision: request.expectedRunRevision,
    acceptedRunRevision: request.expectedRunRevision + 1,
    idempotencyKey: prepared.idempotencyKey,
    requestFingerprint: prepared.requestFingerprint,
    requestHash: prepared.requestHash,
    recordHash,
    ledgerEntryHash: hashWorkflowBudgetAuthorityValue('ledger-entry', ledger),
    correlationId: request.correlationId,
    serviceBuildHash: request.route.authorityBuildHash,
    committedAt: record.afterAccount.updatedAt,
    reconciliationToken: null,
  });
  return validateWorkflowBudgetReceiptForResult(receipt, prepared, record, ledger, null);
}

function providerReconciliationReceipt(
  request: WorkflowBudgetSettlementRequest,
  settlement: WorkflowBudgetSettlement,
  ledger: WorkflowBudgetLedgerEntry,
  reconciliation: NonNullable<
    ReturnType<typeof evaluateWorkflowBudgetSettlement>['reconciliation']
  >,
): WorkflowBudgetReceipt {
  const prepared = prepareWorkflowBudgetAuthorityRequest('settle', request, 'qualification-caller');
  const receipt = validateWorkflowBudgetReceipt({
    schema: WORKFLOW_BUDGET_RECEIPT_SCHEMA,
    ...authorityEnvelope(),
    operation: 'settle',
    status: 'provider_reconciliation_required',
    workspaceId: request.workspaceId,
    runId: request.runId,
    accountId: request.accountId,
    reservationId: request.reservationId,
    callId: request.callId,
    expectedAccountRevision: request.expectedAccountRevision,
    acceptedAccountRevision: settlement.afterAccount.accountRevision,
    expectedRunRevision: request.expectedRunRevision,
    acceptedRunRevision: settlement.afterAccount.runRevision,
    idempotencyKey: prepared.idempotencyKey,
    requestFingerprint: prepared.requestFingerprint,
    requestHash: prepared.requestHash,
    recordHash: hashWorkflowBudgetAuthorityValue('settlement', settlement),
    ledgerEntryHash: hashWorkflowBudgetAuthorityValue('ledger-entry', ledger),
    correlationId: request.correlationId,
    serviceBuildHash: request.route.authorityBuildHash,
    committedAt: settlement.committedAt,
    reconciliationToken: reconciliation.reconciliationToken,
  });
  return validateWorkflowBudgetReceiptForResult(
    receipt,
    prepared,
    settlement,
    ledger,
    reconciliation,
  );
}

function errorOf(action: () => unknown) {
  try {
    action();
  } catch (error) {
    if (error instanceof WorkflowBudgetAuthorityContractError) {
      return { code: error.code, path: error.path };
    }
    throw error;
  }
  throw new Error('Expected budget contract error.');
}

const NEGATIVE_OPERATIONS = [
  'validate_account',
  'validate_reserve_request',
  'validate_provider_usage',
  'validate_settlement_request',
  'validate_settlement',
  'validate_receipt',
  'validate_reconciliation',
  'validate_legacy_approval',
  'validate_prepared_request',
  'validate_receipt_for_prepared_request',
  'validate_reservation_for_decision',
  'validate_reserve_decision',
  'evaluate_settlement',
] as const;
type NegativeOperation = (typeof NEGATIVE_OPERATIONS)[number];

function executeNegative(operation: NegativeOperation, input: unknown): unknown {
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
  }
}

function negative(
  id: string,
  operation: NegativeOperation,
  input: unknown,
  schemaArtifact: (typeof paths)[number],
  expectedSchemaValid: boolean,
) {
  return {
    id,
    operation,
    input,
    schemaArtifact,
    expectedSchemaValid,
    expectedError: errorOf(() => executeNegative(operation, input)),
  };
}

function buildVectors() {
  const expectedProviderHash = providerHash('openslack.provider-usage-provider.v1', 'provider-1');
  const expectedModelHash = providerHash('openslack.provider-usage-model.v1', 'model-1');
  const expectedProviderRunHash = providerHash('openslack.provider-usage-run.v1', 'agent-run-1');
  const routeValue = {
    backend: 'ts-local',
    authority: 'typescript',
    routingEpoch: 1,
    authorityBuildHash: '8'.repeat(64),
  } as const;
  const account = validateWorkflowBudgetAccount({
    schema: WORKFLOW_BUDGET_ACCOUNT_SCHEMA,
    ...authorityEnvelope(),
    workspaceId: 'workspace-1',
    runId: 'run-1',
    accountId: 'budget-account-1',
    policyHash: '7'.repeat(64),
    route: routeValue,
    accountRevision: 0,
    runRevision: 4,
    limit: { tokens: '1000', nanoUsd: '10000', calls: '3' },
    reserved: { tokens: '0', nanoUsd: '0', calls: '0' },
    settled: { tokens: '0', nanoUsd: '0', calls: '0' },
    updatedAt: '2026-08-14T00:00:00.000Z',
  });
  const reserveRequest = validateWorkflowBudgetReserveRequest({
    schema: WORKFLOW_BUDGET_RESERVE_REQUEST_SCHEMA,
    ...authorityEnvelope(),
    workspaceId: account.workspaceId,
    runId: account.runId,
    accountId: account.accountId,
    reservationId: 'reservation-1',
    callId: 'call-1',
    providerAttempt: '1',
    expectedProviderHash,
    expectedModelHash,
    expectedProviderRunHash,
    correlationId: 'correlation-1',
    policyHash: account.policyHash,
    route: account.route,
    expectedAccountRevision: account.accountRevision,
    expectedRunRevision: account.runRevision,
    rateNanoUsdPerToken: '10',
    requested: { tokens: '600', nanoUsd: '6000', calls: '1' },
    requestedAt: '2026-08-14T00:00:01.000Z',
  });
  const reserved = evaluateWorkflowBudgetReserve(
    account,
    reserveRequest,
    '2026-08-14T00:00:02.000Z',
  );
  if (!reserved.reservation) throw new Error('Expected reserved vector.');
  const rejectedRequest = validateWorkflowBudgetReserveRequest({
    ...reserveRequest,
    reservationId: 'reservation-2',
    callId: 'call-2',
    providerAttempt: '2',
    expectedAccountRevision: reserved.decision.afterAccount.accountRevision,
    expectedRunRevision: reserved.decision.afterAccount.runRevision,
    requested: { tokens: '500', nanoUsd: '5000', calls: '1' },
    requestedAt: '2026-08-14T00:00:03.000Z',
  });
  const rejected = evaluateWorkflowBudgetReserve(
    reserved.decision.afterAccount,
    rejectedRequest,
    '2026-08-14T00:00:04.000Z',
  );
  const usage = buildProviderUsage(
    'agent-run-1',
    '1',
    'reported',
    {
      input: '250',
      output: '150',
      total: '400',
    },
    'provider_response_accepted',
    'success',
  );
  const settlementRequest = validateWorkflowBudgetSettlementRequest({
    schema: WORKFLOW_BUDGET_SETTLEMENT_REQUEST_SCHEMA,
    ...authorityEnvelope(),
    workspaceId: account.workspaceId,
    runId: account.runId,
    accountId: account.accountId,
    reservationId: reserved.reservation.reservationId,
    callId: reserved.reservation.callId,
    providerAttempt: reserved.reservation.providerAttempt,
    expectedProviderHash: reserved.reservation.expectedProviderHash,
    expectedModelHash: reserved.reservation.expectedModelHash,
    expectedProviderRunHash: reserved.reservation.expectedProviderRunHash,
    correlationId: 'correlation-2',
    policyHash: account.policyHash,
    route: account.route,
    expectedAccountRevision: reserved.decision.afterAccount.accountRevision,
    expectedRunRevision: reserved.decision.afterAccount.runRevision,
    reserveDecisionHash: reserved.reservation.reserveDecisionHash,
    usageEvidenceStatus: 'trusted',
    usageReceiptHash: usage.receiptHash,
    providerUsage: usage,
    rateNanoUsdPerToken: '10',
    requestedAt: '2026-08-14T00:00:05.000Z',
  });
  const preparedReserve = prepareWorkflowBudgetAuthorityRequest(
    'reserve',
    reserveRequest,
    'qualification-caller',
  );
  const preparedSettlement = prepareWorkflowBudgetAuthorityRequest(
    'settle',
    settlementRequest,
    'qualification-caller',
  );
  const settled = evaluateWorkflowBudgetSettlement(
    reserved.decision.afterAccount,
    reserved.reservation,
    settlementRequest,
    '2026-08-14T00:00:06.000Z',
  );
  const failedUsage = buildProviderUsage(
    'agent-run-1',
    '1',
    'reported',
    {
      input: '100',
      output: '50',
      total: '150',
    },
    'provider_attempt_failed',
    'failed-with-usage',
  );
  const failedWithUsage = evaluateWorkflowBudgetSettlement(
    reserved.decision.afterAccount,
    reserved.reservation,
    validateWorkflowBudgetSettlementRequest({
      ...settlementRequest,
      usageReceiptHash: failedUsage.receiptHash,
      providerUsage: failedUsage,
    }),
    '2026-08-14T00:00:07.000Z',
  );
  const unreportedUsage = buildProviderUsage(
    'agent-run-1',
    '1',
    'unreported',
    null,
    'provider_attempt_failed',
    'unknown',
  );
  const providerUnknown = evaluateWorkflowBudgetSettlement(
    reserved.decision.afterAccount,
    reserved.reservation,
    validateWorkflowBudgetSettlementRequest({
      ...settlementRequest,
      usageReceiptHash: unreportedUsage.receiptHash,
      providerUsage: unreportedUsage,
    }),
    '2026-08-14T00:00:08.000Z',
  );
  const overrunUsage = buildProviderUsage(
    'agent-run-1',
    '1',
    'reported',
    {
      input: '500',
      output: '200',
      total: '700',
    },
    'provider_response_accepted',
    'overrun',
  );
  const usageOverrun = evaluateWorkflowBudgetSettlement(
    reserved.decision.afterAccount,
    reserved.reservation,
    validateWorkflowBudgetSettlementRequest({
      ...settlementRequest,
      usageReceiptHash: overrunUsage.receiptHash,
      providerUsage: overrunUsage,
    }),
    '2026-08-14T00:00:09.000Z',
  );
  const missingUsage = evaluateWorkflowBudgetSettlement(
    reserved.decision.afterAccount,
    reserved.reservation,
    validateWorkflowBudgetSettlementRequest({
      ...settlementRequest,
      usageEvidenceStatus: 'missing',
      usageReceiptHash: null,
      providerUsage: null,
    }),
    '2026-08-14T00:00:10.000Z',
  );
  const untrustedUsage = evaluateWorkflowBudgetSettlement(
    reserved.decision.afterAccount,
    reserved.reservation,
    validateWorkflowBudgetSettlementRequest({
      ...settlementRequest,
      usageEvidenceStatus: 'untrusted',
      usageReceiptHash: `sha256:${'4'.repeat(64)}`,
      providerUsage: null,
    }),
    '2026-08-14T00:00:10.500Z',
  );
  const legacyApproved = validateWorkflowBudgetLegacyApprovalObservation({
    schema: WORKFLOW_BUDGET_LEGACY_APPROVAL_SCHEMA,
    ...authorityEnvelope(),
    workspaceId: account.workspaceId,
    runId: account.runId,
    status: 'approved',
    revision: 1,
    semantics: 'run_gate_only',
    limitAmendmentAuthority: false,
    reservationAuthority: false,
    settlementAuthority: false,
    observedAt: '2026-08-14T00:00:11.000Z',
  });
  const reserveReceipt = acceptedReceipt(
    'reserve',
    reserveRequest,
    reserved.decision,
    reserved.ledgerEntry,
  );
  const reserveExactReplay = reserveReceipt;
  const rejectedReserveReceipt = acceptedReceipt(
    'reserve',
    rejectedRequest,
    rejected.decision,
    rejected.ledgerEntry,
  );
  const rejectedReserveExactReplay = rejectedReserveReceipt;
  const settlementReceipt = acceptedReceipt(
    'settle',
    settlementRequest,
    settled.settlement,
    settled.ledgerEntry,
  );
  const settlementExactReplay = settlementReceipt;
  const failedProviderSettlementReceipt = acceptedReceipt(
    'settle',
    failedWithUsage.settlement.request,
    failedWithUsage.settlement,
    failedWithUsage.ledgerEntry,
  );
  const failedProviderSettlementExactReplay = failedProviderSettlementReceipt;
  if (
    providerUnknown.reconciliation === null ||
    missingUsage.reconciliation === null ||
    untrustedUsage.reconciliation === null ||
    usageOverrun.reconciliation === null
  ) {
    throw new Error('Expected provider reconciliation vectors.');
  }
  const providerUnknownReceipt = providerReconciliationReceipt(
    providerUnknown.settlement.request,
    providerUnknown.settlement,
    providerUnknown.ledgerEntry,
    providerUnknown.reconciliation,
  );
  const missingUsageReceipt = providerReconciliationReceipt(
    missingUsage.settlement.request,
    missingUsage.settlement,
    missingUsage.ledgerEntry,
    missingUsage.reconciliation,
  );
  const untrustedUsageReceipt = providerReconciliationReceipt(
    untrustedUsage.settlement.request,
    untrustedUsage.settlement,
    untrustedUsage.ledgerEntry,
    untrustedUsage.reconciliation,
  );
  const usageOverrunReceipt = providerReconciliationReceipt(
    usageOverrun.settlement.request,
    usageOverrun.settlement,
    usageOverrun.ledgerEntry,
    usageOverrun.reconciliation,
  );
  const providerUnknownExactReplay = providerUnknownReceipt;
  const missingUsageExactReplay = missingUsageReceipt;
  const untrustedUsageExactReplay = untrustedUsageReceipt;
  const usageOverrunExactReplay = usageOverrunReceipt;
  const dbReconciliationReceipt = validateWorkflowBudgetReceipt({
    ...settlementReceipt,
    status: 'database_reconciliation_required',
    acceptedAccountRevision: null,
    acceptedRunRevision: null,
    recordHash: null,
    ledgerEntryHash: null,
    committedAt: null,
    reconciliationToken: 'database-reconciliation-1',
  });
  const dbReconciliation = validateWorkflowBudgetReconciliation({
    schema: WORKFLOW_BUDGET_RECONCILIATION_SCHEMA,
    ...authorityEnvelope(),
    evidenceType: 'database_commit',
    reasonCode: 'database_commit_outcome_unknown',
    workspaceId: account.workspaceId,
    runId: account.runId,
    accountId: account.accountId,
    reservationId: reserved.reservation.reservationId,
    callId: reserved.reservation.callId,
    sourceRequestHash: settlementReceipt.requestHash,
    usageReceiptHash: null,
    accountHash: hashWorkflowBudgetAuthorityValue('account', reserved.decision.afterAccount),
    reservationHash: hashWorkflowBudgetAuthorityValue('reservation', reserved.reservation),
    reconciliationToken: 'database-reconciliation-1',
    accountCountersChanged: false,
    reservationReleaseAuthorized: false,
    providerRetryAuthorized: false,
    cachePublishAuthorized: false,
    runReconciliationLatched: true,
    observedAt: '2026-08-14T00:00:12.000Z',
  });

  const invalidAccount = structuredClone(account) as unknown as Json;
  (invalidAccount.settled as Json).tokens = '1';
  const invalidCalls = structuredClone(reserveRequest) as unknown as Json;
  (invalidCalls.requested as Json).calls = '2';
  const invalidReceiptHash = structuredClone(usage) as unknown as Json;
  invalidReceiptHash.receiptHash = `sha256:${'0'.repeat(64)}`;
  const invalidAttempt = structuredClone(settlementRequest) as unknown as Json;
  invalidAttempt.providerAttempt = '2';
  const invalidMissing = structuredClone(settlementRequest) as unknown as Json;
  invalidMissing.usageEvidenceStatus = 'missing';
  invalidMissing.providerUsage = null;
  const legacyAuthority = structuredClone(legacyApproved) as unknown as Json;
  legacyAuthority.reservationAuthority = true;
  const mixedReconciliation = structuredClone(dbReconciliation) as unknown as Json;
  mixedReconciliation.evidenceType = 'provider_outcome';
  const falseDbReceipt = structuredClone(dbReconciliationReceipt) as unknown as Json;
  falseDbReceipt.acceptedAccountRevision = 2;
  const ambiguousReconciliationReceipt = structuredClone(
    dbReconciliationReceipt,
  ) as unknown as Json;
  ambiguousReconciliationReceipt.status = 'reconciliation_required';
  const fingerprintDrift = structuredClone(preparedReserve) as unknown as Json;
  fingerprintDrift.requestFingerprint = `sha256:${'0'.repeat(64)}`;
  const leadingZero = structuredClone(reserveRequest) as unknown as Json;
  (leadingZero.requested as Json).tokens = '01';
  const overflow = structuredClone(reserveRequest) as unknown as Json;
  (overflow.requested as Json).tokens = '9223372036854775808';
  const exponentRate = structuredClone(settlementRequest) as unknown as Json;
  exponentRate.rateNanoUsdPerToken = '1e3';
  const trailingZeroRate = structuredClone(reserveRequest) as unknown as Json;
  trailingZeroRate.rateNanoUsdPerToken = '10.0';
  const reserveRateCostDrift = structuredClone(reserveRequest) as unknown as Json;
  (reserveRateCostDrift.requested as Json).nanoUsd = '5999';
  const routeDrift = structuredClone(reserveRequest) as unknown as Json;
  (routeDrift.route as Json).authority = 'workflow-control';
  const providerIdentityDrift = structuredClone(settlementRequest) as unknown as Json;
  providerIdentityDrift.expectedModelHash = `sha256:${'0'.repeat(64)}`;
  const settlementRateDrift = structuredClone(settled.settlement) as unknown as Json;
  (settlementRateDrift.request as Json).rateNanoUsdPerToken = '11';
  const settlementReservationDrift = structuredClone(settled.settlement) as unknown as Json;
  (settlementReservationDrift.request as Json).reservationId = 'reservation-other';
  const settlementReasonDrift = structuredClone(providerUnknown.settlement) as unknown as Json;
  settlementReasonDrift.reasonCode = 'usage_overrun';
  const receiptBuildDrift = structuredClone(reserveReceipt) as unknown as Json;
  receiptBuildDrift.serviceBuildHash = '9'.repeat(64);
  const reservationDecisionDrift = structuredClone(reserved.reservation) as unknown as Json;
  reservationDecisionDrift.expectedModelHash = `sha256:${'0'.repeat(64)}`;
  const decisionTimeDrift = structuredClone(reserved.decision) as unknown as Json;
  decisionTimeDrift.decidedAt = '2026-08-14T00:00:02.001Z';
  const settlementTimeDrift = structuredClone(settled.settlement) as unknown as Json;
  settlementTimeDrift.committedAt = '2026-08-14T00:00:06.001Z';
  const settlementRequestBeforeReservation = structuredClone(settled.settlement) as unknown as Json;
  (settlementRequestBeforeReservation.request as Json).requestedAt = '2026-08-14T00:00:01.000Z';
  const staleSettlementRequest = validateWorkflowBudgetSettlementRequest({
    ...settlementRequest,
    expectedAccountRevision: account.accountRevision,
    expectedRunRevision: account.runRevision,
  });
  const overflowUsage = buildProviderUsage(
    'agent-run-1',
    '1',
    'reported',
    {
      input: WORKFLOW_BUDGET_AUTHORITY_MAX_INT64,
      output: '0',
      total: WORKFLOW_BUDGET_AUTHORITY_MAX_INT64,
    },
    'provider_response_accepted',
    'settlement-overflow',
  );
  const overflowSettlementRequest = validateWorkflowBudgetSettlementRequest({
    ...staleSettlementRequest,
    providerUsage: overflowUsage,
    usageReceiptHash: overflowUsage.receiptHash,
  });
  const staleSettlementEvaluation = {
    account,
    reservation: reserved.reservation,
    request: staleSettlementRequest,
    committedAt: '2026-08-14T00:00:06.000Z',
  };
  const overflowStaleSettlementEvaluation = {
    ...staleSettlementEvaluation,
    request: overflowSettlementRequest,
  };
  const overflowAfterAccountDrift = structuredClone(settled.settlement) as unknown as Json;
  overflowAfterAccountDrift.request = overflowSettlementRequest;

  return {
    arithmetic: {
      decimal: [
        { input: '0', expected: '0' },
        {
          input: WORKFLOW_BUDGET_AUTHORITY_MAX_INT64,
          expected: WORKFLOW_BUDGET_AUTHORITY_MAX_INT64,
        },
      ],
      usdToNanoUsd: [
        { input: '0.0000000004', expected: workflowBudgetAuthorityUsdToNanoUsd('0.0000000004') },
        { input: '0.0000000005', expected: workflowBudgetAuthorityUsdToNanoUsd('0.0000000005') },
        { input: '1.2345678915', expected: workflowBudgetAuthorityUsdToNanoUsd('1.2345678915') },
      ],
      chargeNanoUsd: [
        {
          tokens: '3',
          rateNanoUsdPerToken: '0.5',
          expected: workflowBudgetAuthorityChargeNanoUsd('3', '0.5'),
        },
        {
          tokens: '400',
          rateNanoUsdPerToken: '10',
          expected: workflowBudgetAuthorityChargeNanoUsd('400', '10'),
        },
      ],
    },
    records: {
      account: exact(account),
      reserveRequest: exact(reserveRequest),
      reserveReserved: exact(reserved.decision),
      reserveRejected: exact(rejected.decision),
      reservation: exact(reserved.reservation),
      providerUsageReported: exact(usage),
      providerUsageUnreported: exact(unreportedUsage),
      preparedReserve: exact(preparedReserve),
      preparedSettlement: exact(preparedSettlement),
      settlementSettled: exact(settled.settlement),
      failedProviderSettledBeforeRethrow: exact(failedWithUsage.settlement),
      providerUnknown: exact(providerUnknown.settlement),
      usageOverrun: exact(usageOverrun.settlement),
      usageMissing: exact(missingUsage.settlement),
      usageUntrusted: exact(untrustedUsage.settlement),
      reserveLedger: exact(reserved.ledgerEntry),
      rejectedLedger: exact(rejected.ledgerEntry),
      settlementLedger: exact(settled.ledgerEntry),
      failedProviderSettlementLedger: exact(failedWithUsage.ledgerEntry),
      reconciliationLedger: exact(providerUnknown.ledgerEntry),
      missingReconciliationLedger: exact(missingUsage.ledgerEntry),
      untrustedReconciliationLedger: exact(untrustedUsage.ledgerEntry),
      overrunReconciliationLedger: exact(usageOverrun.ledgerEntry),
      reserveReceipt: exact(reserveReceipt),
      reserveExactReplay: exact(reserveExactReplay),
      rejectedReserveReceipt: exact(rejectedReserveReceipt),
      rejectedReserveExactReplay: exact(rejectedReserveExactReplay),
      settlementReceipt: exact(settlementReceipt),
      settlementExactReplay: exact(settlementExactReplay),
      failedProviderSettlementReceipt: exact(failedProviderSettlementReceipt),
      failedProviderSettlementExactReplay: exact(failedProviderSettlementExactReplay),
      providerUnknownReceipt: exact(providerUnknownReceipt),
      providerUnknownExactReplay: exact(providerUnknownExactReplay),
      missingUsageReceipt: exact(missingUsageReceipt),
      missingUsageExactReplay: exact(missingUsageExactReplay),
      untrustedUsageReceipt: exact(untrustedUsageReceipt),
      untrustedUsageExactReplay: exact(untrustedUsageExactReplay),
      usageOverrunReceipt: exact(usageOverrunReceipt),
      usageOverrunExactReplay: exact(usageOverrunExactReplay),
      databaseReconciliationReceipt: exact(dbReconciliationReceipt),
      providerReconciliation: exact(providerUnknown.reconciliation),
      missingProviderReconciliation: exact(missingUsage.reconciliation),
      untrustedProviderReconciliation: exact(untrustedUsage.reconciliation),
      overrunProviderReconciliation: exact(usageOverrun.reconciliation),
      databaseReconciliation: exact(dbReconciliation),
      legacyApprovedNoAuthority: exact(legacyApproved),
    },
    folds: {
      reserve: {
        before: account,
        request: reserveRequest,
        decision: reserved.decision,
        reservation: reserved.reservation,
        ledgerEntry: reserved.ledgerEntry,
        reconciliation: null,
        receipt: reserveReceipt,
        exactReplay: reserveExactReplay,
        after: reserved.decision.afterAccount,
      },
      reject: {
        before: reserved.decision.afterAccount,
        request: rejectedRequest,
        decision: rejected.decision,
        reservation: null,
        ledgerEntry: rejected.ledgerEntry,
        reconciliation: null,
        receipt: rejectedReserveReceipt,
        exactReplay: rejectedReserveExactReplay,
        after: rejected.decision.afterAccount,
      },
      settle: {
        before: reserved.decision.afterAccount,
        reservation: reserved.reservation,
        request: settlementRequest,
        settlement: settled.settlement,
        ledgerEntry: settled.ledgerEntry,
        reconciliation: null,
        receipt: settlementReceipt,
        exactReplay: settlementExactReplay,
        after: settled.settlement.afterAccount,
      },
      failedProviderAttempt: {
        before: reserved.decision.afterAccount,
        reservation: reserved.reservation,
        request: failedWithUsage.settlement.request,
        settlement: failedWithUsage.settlement,
        ledgerEntry: failedWithUsage.ledgerEntry,
        reconciliation: null,
        receipt: failedProviderSettlementReceipt,
        exactReplay: failedProviderSettlementExactReplay,
        after: failedWithUsage.settlement.afterAccount,
      },
      providerOutcomeUnknown: {
        before: reserved.decision.afterAccount,
        reservation: reserved.reservation,
        request: providerUnknown.settlement.request,
        settlement: providerUnknown.settlement,
        ledgerEntry: providerUnknown.ledgerEntry,
        reconciliation: providerUnknown.reconciliation,
        receipt: providerUnknownReceipt,
        exactReplay: providerUnknownExactReplay,
        after: providerUnknown.settlement.afterAccount,
      },
      usageMissing: {
        before: reserved.decision.afterAccount,
        reservation: reserved.reservation,
        request: missingUsage.settlement.request,
        settlement: missingUsage.settlement,
        ledgerEntry: missingUsage.ledgerEntry,
        reconciliation: missingUsage.reconciliation,
        receipt: missingUsageReceipt,
        exactReplay: missingUsageExactReplay,
        after: missingUsage.settlement.afterAccount,
      },
      usageUntrusted: {
        before: reserved.decision.afterAccount,
        reservation: reserved.reservation,
        request: untrustedUsage.settlement.request,
        settlement: untrustedUsage.settlement,
        ledgerEntry: untrustedUsage.ledgerEntry,
        reconciliation: untrustedUsage.reconciliation,
        receipt: untrustedUsageReceipt,
        exactReplay: untrustedUsageExactReplay,
        after: untrustedUsage.settlement.afterAccount,
      },
      usageOverrun: {
        before: reserved.decision.afterAccount,
        reservation: reserved.reservation,
        request: usageOverrun.settlement.request,
        settlement: usageOverrun.settlement,
        ledgerEntry: usageOverrun.ledgerEntry,
        reconciliation: usageOverrun.reconciliation,
        receipt: usageOverrunReceipt,
        exactReplay: usageOverrunExactReplay,
        after: usageOverrun.settlement.afterAccount,
      },
    },
    negative: [
      negative('decimal-leading-zero', 'validate_reserve_request', leadingZero, paths[1], false),
      negative('decimal-overflow', 'validate_reserve_request', overflow, paths[1], true),
      negative(
        'account-settled-exceeds-reserved',
        'validate_account',
        invalidAccount,
        paths[0],
        true,
      ),
      negative(
        'reserve-calls-must-equal-one',
        'validate_reserve_request',
        invalidCalls,
        paths[1],
        false,
      ),
      negative(
        'reserve-rate-cost-drift',
        'validate_reserve_request',
        reserveRateCostDrift,
        paths[1],
        true,
      ),
      negative('rate-trailing-zero', 'validate_reserve_request', trailingZeroRate, paths[1], false),
      negative('route-drift', 'validate_reserve_request', routeDrift, paths[1], false),
      negative(
        'provider-receipt-hash-drift',
        'validate_provider_usage',
        invalidReceiptHash,
        paths[4],
        true,
      ),
      negative(
        'provider-attempt-drift',
        'validate_settlement_request',
        invalidAttempt,
        paths[5],
        true,
      ),
      negative(
        'provider-identity-drift',
        'validate_settlement_request',
        providerIdentityDrift,
        paths[5],
        true,
      ),
      negative(
        'missing-evidence-cannot-keep-hash',
        'validate_settlement_request',
        invalidMissing,
        paths[5],
        false,
      ),
      negative(
        'exponent-rate-forbidden',
        'validate_settlement_request',
        exponentRate,
        paths[5],
        false,
      ),
      negative('settlement-rate-drift', 'validate_settlement', settlementRateDrift, paths[6], true),
      negative(
        'settlement-reservation-drift',
        'validate_settlement',
        settlementReservationDrift,
        paths[6],
        true,
      ),
      negative(
        'settlement-reason-drift',
        'validate_settlement',
        settlementReasonDrift,
        paths[6],
        true,
      ),
      negative(
        'legacy-approval-cannot-reserve',
        'validate_legacy_approval',
        legacyAuthority,
        paths[10],
        false,
      ),
      negative(
        'provider-and-database-reconciliation-are-disjoint',
        'validate_reconciliation',
        mixedReconciliation,
        paths[9],
        false,
      ),
      negative(
        'database-unknown-cannot-claim-accepted-revision',
        'validate_receipt',
        falseDbReceipt,
        paths[8],
        false,
      ),
      negative(
        'ambiguous-reconciliation-receipt-status',
        'validate_receipt',
        ambiguousReconciliationReceipt,
        paths[8],
        false,
      ),
      negative(
        'prepared-request-fingerprint-drift',
        'validate_prepared_request',
        fingerprintDrift,
        paths[11],
        true,
      ),
      negative(
        'receipt-build-drift',
        'validate_receipt_for_prepared_request',
        { receipt: receiptBuildDrift, preparedRequest: preparedReserve },
        paths[8],
        true,
      ),
      negative(
        'reservation-decision-drift',
        'validate_reservation_for_decision',
        { reservation: reservationDecisionDrift, decision: reserved.decision },
        paths[3],
        true,
      ),
      negative(
        'reserve-decision-time-drift',
        'validate_reserve_decision',
        decisionTimeDrift,
        paths[2],
        true,
      ),
      negative(
        'settlement-request-before-reservation',
        'validate_settlement',
        settlementRequestBeforeReservation,
        paths[6],
        true,
      ),
      negative('settlement-time-drift', 'validate_settlement', settlementTimeDrift, paths[6], true),
      negative(
        'settlement-predates-reservation-revision',
        'evaluate_settlement',
        staleSettlementEvaluation,
        paths[5],
        true,
      ),
      negative(
        'settlement-overflow-precedes-stale-revision',
        'evaluate_settlement',
        overflowStaleSettlementEvaluation,
        paths[5],
        true,
      ),
      negative(
        'settlement-overflow-precedes-after-account-drift',
        'validate_settlement',
        overflowAfterAccountDrift,
        paths[6],
        true,
      ),
    ],
  };
}

async function pretty(value: unknown): Promise<Buffer> {
  return Buffer.from(
    await format(JSON.stringify(value), { parser: 'json', printWidth: 100, tabWidth: 2 }),
    'utf8',
  );
}

async function verifySourceLocks(): Promise<void> {
  const locks = [
    [
      'packages/workflows/contracts/workflow-control-authority/v2/manifest.json',
      WORKFLOW_BUDGET_AUTHORITY_V2_MANIFEST_SHA256,
    ],
    [
      'packages/workflows/contracts/workflow-control-authority/v2/golden-vectors.json',
      WORKFLOW_BUDGET_AUTHORITY_V2_GOLDEN_SHA256,
    ],
    [
      'packages/workflows/contracts/workflow-runner/v1/manifest.json',
      WORKFLOW_BUDGET_RUNNER_V1_MANIFEST_SHA256,
    ],
    [
      'packages/workflows/contracts/workflow-runner/v1/golden-vectors.json',
      WORKFLOW_BUDGET_RUNNER_V1_GOLDEN_SHA256,
    ],
  ] as const;
  for (const [path, expected] of locks) {
    const actual = sha(await readFile(resolve(root, path)));
    if (actual !== expected)
      throw new Error(`Workflow budget authority source lock drift: ${path}`);
  }
}

async function outputs(): Promise<Map<string, Buffer>> {
  await verifySourceLocks();
  const map = new Map<string, Buffer>();
  const schemas = [
    accountSchema,
    reserveRequestSchema,
    reserveDecisionSchema,
    reservationSchema,
    providerUsageSchema,
    settlementRequestSchema,
    settlementSchema,
    ledgerSchema,
    receiptSchema,
    reconciliationSchema,
    legacyApprovalSchema,
    preparedRequestSchema,
  ];
  for (const [index, schema] of schemas.entries()) map.set(paths[index]!, await pretty(schema));
  map.set(
    'golden-vectors.json',
    await pretty({
      schema: 'openslack.workflow_budget_authority_golden_vectors.v1',
      contractVersion: WORKFLOW_BUDGET_AUTHORITY_CONTRACT_VERSION,
      authority: WORKFLOW_BUDGET_AUTHORITY,
      vectors: buildVectors(),
    }),
  );
  const artifacts = Object.fromEntries(
    [...map].map(([path, bytes]) => [path, { path, byteLength: bytes.length, sha256: sha(bytes) }]),
  );
  map.set(
    'manifest.json',
    await pretty({
      schema: 'openslack.workflow_budget_authority_contract_manifest.v1',
      contractVersion: WORKFLOW_BUDGET_AUTHORITY_CONTRACT_VERSION,
      authorityBoundary: {
        writer: WORKFLOW_BUDGET_AUTHORITY_WRITER,
        typescriptRemainsSoleWriter: true,
        goRole: WORKFLOW_BUDGET_AUTHORITY_GO_ROLE,
        goAuthorityClaim: WORKFLOW_BUDGET_AUTHORITY_GO_CLAIM,
        goAuthorityEligible: false,
        postgresImplemented: false,
        httpImplemented: false,
        runtimeRoutingActivated: false,
      },
      dimensions: WORKFLOW_BUDGET_AUTHORITY_DIMENSIONS,
      invariants: {
        eachDimension: '0 <= settled <= reserved <= limit <= 9223372036854775807',
        open: 'reserved - settled',
        reservationAccounting: 'reserved = settled + sum(open reservation encumbrance)',
        oneReservationPerProviderTurn: true,
        requestedCalls: '1',
      },
      folds: {
        reserve: {
          reserved: 'reserved + requested',
          settled: 'settled',
          precondition: 'reserved + requested <= limit',
        },
        reject: {
          reason: 'structurally valid request has insufficient balance',
          counters: 'unchanged',
          revisions: 'account and run each advance once',
          authorization: { tokens: '0', nanoUsd: '0', calls: '0' },
        },
        settle: {
          precondition: 'trusted exact provider receipt and actual <= reservation',
          settled: 'settled + actual',
          reserved: 'reserved - reservation + actual',
          released: 'reservation - actual',
          failedProviderAttempt: 'settle_usage_then_rethrow_without_cache_publication',
        },
        providerUnknownOrOverrun: {
          counters: 'unchanged',
          reservation: 'remains_open',
          result: 'settlement_reconciliation_required',
          providerRetryAuthorized: false,
          cachePublishAuthorized: false,
        },
      },
      arithmetic: {
        quantityEncoding: 'canonical_nonnegative_int64_decimal_string',
        max: WORKFLOW_BUDGET_AUTHORITY_MAX_INT64,
        moneyUnit: WORKFLOW_BUDGET_AUTHORITY_MONEY_UNIT,
        moneyScale: WORKFLOW_BUDGET_AUTHORITY_MONEY_SCALE,
        rounding: WORKFLOW_BUDGET_AUTHORITY_ROUNDING,
        binaryFloatingPointAuthority: false,
        perTokenRate:
          'canonical_nonnegative_decimal_up_to_18_fraction_digits_without_fractional_trailing_zero',
      },
      providerUsage: {
        schema: WORKFLOW_BUDGET_PROVIDER_USAGE_SCHEMA,
        exactFields: [
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
        receiptHashDomain: 'openslack.provider-usage-receipt.v1',
        reservationBinds: [
          'providerHash',
          'modelHash',
          'runHash',
          'attempt',
          'calls',
          'rateNanoUsdPerToken',
        ],
        settlementBindsOnly: [
          'providerHash',
          'modelHash',
          'runHash',
          'attempt',
          'calls',
          'status',
          'totalTokens',
          'receiptHash',
        ],
        cachePublishAuthorization: {
          semantics: 'budget_gate_only_not_business_success',
          providerResponseAcceptedRequired: true,
          providerAttemptFailedAuthorized: false,
        },
        rawForbidden: [
          'provider',
          'model',
          'endpoint',
          'prompt',
          'request',
          'response',
          'credential',
          'token',
          'transcript',
        ],
      },
      reconciliations: {
        providerReasons: WORKFLOW_BUDGET_AUTHORITY_PROVIDER_RECONCILIATION_REASONS,
        databaseReasons: WORKFLOW_BUDGET_AUTHORITY_DATABASE_RECONCILIATION_REASONS,
        domainsInterchangeable: false,
      },
      ledgerKinds: WORKFLOW_BUDGET_AUTHORITY_LEDGER_KINDS,
      legacyBudgetApproval: {
        semantics: 'run_gate_only',
        limitAmendmentAuthority: false,
        reservationAuthority: false,
        settlementAuthority: false,
      },
      receipts: {
        operations: ['reserve', 'settle'],
        statuses: [
          'accepted',
          'provider_reconciliation_required',
          'database_reconciliation_required',
        ],
        idempotencyPrefix: WORKFLOW_BUDGET_AUTHORITY_IDEMPOTENCY_PREFIX,
        sameKeySameFingerprint: 'exact_original_receipt',
        sameKeyDifferentFingerprint: 'conflict_without_mutation',
      },
      cacheSemantics: {
        cacheHit: 'no_reserve_no_settle_zero_budget_mutation',
        providerBeforeDurableReserve: 'forbidden',
        cacheVisibleBeforeDurableSettlement: 'forbidden',
      },
      requestBinding: {
        method: 'POST',
        paths: {
          reserve: '/v1/authority/workflow-budgets:reserve',
          settle: '/v1/authority/workflow-budgets:settle',
        },
        body: 'canonical-json-plus-one-lf',
        requestHash: 'sha256_exact_body',
        idempotencyKey: `${WORKFLOW_BUDGET_AUTHORITY_IDEMPOTENCY_PREFIX}{requestHash}`,
        fingerprintBinds: ['callerId', 'method', 'operation', 'path', 'requestHash', 'workspaceId'],
      },
      negativeEvidence: {
        operations: NEGATIVE_OPERATIONS,
        fields: [
          'id',
          'operation',
          'input',
          'schemaArtifact',
          'expectedSchemaValid',
          'expectedError',
        ],
        replayableByPureGo: true,
      },
      canonicalization: {
        encoding: 'utf-8',
        objectKeys: 'lexicographic-ecmascript-code-unit',
        bytes: 'canonical-json-plus-one-lf-when-framed',
        hash: 'sha256',
        duplicateKeys: 'rejected',
      },
      sourceLocks: {
        authorityV2ManifestSha256: WORKFLOW_BUDGET_AUTHORITY_V2_MANIFEST_SHA256,
        authorityV2GoldenSha256: WORKFLOW_BUDGET_AUTHORITY_V2_GOLDEN_SHA256,
        runnerV1ManifestSha256: WORKFLOW_BUDGET_RUNNER_V1_MANIFEST_SHA256,
        runnerV1GoldenSha256: WORKFLOW_BUDGET_RUNNER_V1_GOLDEN_SHA256,
      },
      limits: WORKFLOW_BUDGET_AUTHORITY_LIMITS,
      errorCodes: WORKFLOW_BUDGET_AUTHORITY_ERROR_CODES,
      qualification: {
        localStatus: 'LOCAL_PASS_when_exact_byte_and_cross_language_gates_pass',
        durableGoBudgetAuthority: 'NOT_IMPLEMENTED_IN_E1',
        productionGoWorkflowBudgetAuthority: 'NOT_CLAIMED',
      },
      artifacts,
      bundleFiles: paths,
    }),
  );
  return map;
}

function inside(rootDirectory: string, candidate: string): void {
  const path = relative(rootDirectory, candidate);
  if (
    path === '..' ||
    path.startsWith(`..${sep}`) ||
    resolve(candidate) === resolve(rootDirectory)
  ) {
    throw new Error(`Workflow budget authority output escapes contract root: ${candidate}`);
  }
}

async function list(rootDirectory: string, directory = rootDirectory): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = resolve(directory, entry.name);
    inside(rootDirectory, path);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`Workflow budget authority rejects symlink ${path}`);
    if (stat.isDirectory()) output.push(...(await list(rootDirectory, path)));
    else if (stat.isFile()) output.push(relative(rootDirectory, path).split(sep).join('/'));
    else throw new Error(`Workflow budget authority rejects non-file ${path}`);
  }
  return output.sort();
}

async function writeBundle(rootDirectory: string, built: Map<string, Buffer>): Promise<void> {
  for (const [path, bytes] of built) {
    const absolute = resolve(rootDirectory, path);
    inside(rootDirectory, absolute);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
}

async function checkBundle(rootDirectory: string, built: Map<string, Buffer>): Promise<void> {
  const actual = await list(rootDirectory);
  const expected = [...built.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Workflow budget authority inventory drift at ${rootDirectory}: ${actual.join(', ')}`,
    );
  }
  for (const [path, bytes] of built) {
    if (!(await readFile(resolve(rootDirectory, path))).equals(bytes)) {
      throw new Error(`Workflow budget authority exact-byte drift at ${rootDirectory}: ${path}`);
    }
  }
}

const built = await outputs();
if (process.argv[2] === '--check') {
  await checkBundle(contractRoot, built);
  await checkBundle(serviceMirrorRoot, built);
  console.log(
    `Workflow budget authority bundle and Go mirror verified (${built.size} exact-byte files each).`,
  );
} else if (process.argv.length === 2) {
  await writeBundle(contractRoot, built);
  await writeBundle(serviceMirrorRoot, built);
  console.log(
    `Workflow budget authority bundle and Go mirror generated (${built.size} exact-byte files each).`,
  );
} else {
  throw new Error('Usage: bun scripts/workflow-budget-authority-contracts/index.ts [--check]');
}
