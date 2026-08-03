import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  canonicalGovernedJson,
  createCanonicalGovernedPlan,
  hashGovernedValue,
  hashOpaqueValue,
  validateGovernedPlanRecord,
  type GovernedPlanRecord,
} from '../../packages/operator/src/governed-plan.js';

type JsonRecord = Record<string, unknown>;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const GOVERNANCE_AUTHORITY_REPOSITORY_ROOT = resolve(scriptDirectory, '../..');
export const GOVERNANCE_AUTHORITY_CONTRACT_EXPECTED_PATHS = Object.freeze([
  'schemas/governance-authority-route.v1.schema.json',
  'schemas/governance-authority-accept.v1.schema.json',
  'schemas/governance-authority-transition.v1.schema.json',
  'schemas/governance-authority-receipt.v1.schema.json',
  'schemas/governance-authority-read.v1.schema.json',
  'schemas/governance-authority-pending-audit.v1.schema.json',
  'golden-vectors.json',
  'manifest.json',
] as const);

export const GOVERNANCE_AUTHORITY_ACCEPT_SCHEMA = 'openslack.governance_authority_accept.v1';
export const GOVERNANCE_AUTHORITY_TRANSITION_SCHEMA =
  'openslack.governance_authority_transition.v1';
export const GOVERNANCE_AUTHORITY_RECEIPT_SCHEMA = 'openslack.governance_authority_receipt.v1';
export const GOVERNANCE_AUTHORITY_READ_SCHEMA = 'openslack.governance_authority_read.v1';
export const GOVERNANCE_AUTHORITY_PENDING_AUDIT_SCHEMA =
  'openslack.governance_authority_pending_audit.v1';
export const GOVERNANCE_AUTHORITY_IDEMPOTENCY_PREFIX = 'openslack.governance-authority.v1.';
export const GOVERNANCE_AUTHORITY_OPERATIONS = Object.freeze([
  'accept',
  'claim_execution',
  'complete_execution',
  'cancel',
  'expire',
  'require_reconciliation',
] as const);
export const GOVERNANCE_AUTHORITY_TRANSITIONS = Object.freeze(
  GOVERNANCE_AUTHORITY_OPERATIONS.filter((operation) => operation !== 'accept'),
);

const AUTHORITY_ACCEPT_PATH = '/v1/governance/plans:accept';
const HASH_PATTERN = '^[0-9a-f]{64}$';
const SHA256_PATTERN = '^sha256:[0-9a-f]{64}$';
const IDENTIFIER_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$';
const PLAN_ID_PATTERN =
  '^GPLAN-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const EXECUTION_ID_PATTERN =
  '^GEXEC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const TIMESTAMP_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$';
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export interface GovernanceAuthorityContractRoots {
  readonly outputRoot: string;
  readonly authorityRoot: string;
  readonly goMirrorRoot: string;
}

export function governanceAuthorityContractRoots(
  outputRoot = GOVERNANCE_AUTHORITY_REPOSITORY_ROOT,
): GovernanceAuthorityContractRoots {
  const normalized = resolve(outputRoot);
  return Object.freeze({
    outputRoot: normalized,
    authorityRoot: resolve(normalized, 'packages/operator/contracts/governed-plan-authority/v1'),
    goMirrorRoot: resolve(
      normalized,
      'services/governance-control/internal/contractmirror/generated/authority/v1',
    ),
  });
}

function strictObject(properties: JsonRecord, required: readonly string[]): JsonRecord {
  return { type: 'object', additionalProperties: false, required, properties };
}

const routeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/governance-authority-route.v1.schema.json',
  title: 'OpenSlack Governance Authority Route',
  ...strictObject(
    {
      backend: { enum: ['go', 'ts-local'] },
      routingEpoch: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
      authority: { enum: ['governance-control', 'typescript'] },
    },
    ['backend', 'routingEpoch', 'authority'],
  ),
  allOf: [
    {
      if: { properties: { backend: { const: 'go' } }, required: ['backend'] },
      then: { properties: { authority: { const: 'governance-control' } } },
      else: {
        properties: { backend: { const: 'ts-local' }, authority: { const: 'typescript' } },
      },
    },
  ],
};

const requestProperties: JsonRecord = {
  workspaceId: { type: 'string', pattern: IDENTIFIER_PATTERN },
  planId: { type: 'string', pattern: PLAN_ID_PATTERN },
  route: { $ref: 'https://openslack.dev/contracts/governance-authority-route.v1.schema.json' },
  record: {
    $ref: 'https://openslack.dev/contracts/governed-plan/v1/governed-plan.v1.schema.json',
  },
};

const acceptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/governance-authority-accept.v1.schema.json',
  title: 'OpenSlack Governance Authority Accept Request',
  $comment:
    'Structural prefilter. Runtime validation requires a revision-1 pending record whose identifiers, tenant binding, correlation, hashes, and immutable route all match the request and trusted headers.',
  ...strictObject(
    {
      schema: { const: GOVERNANCE_AUTHORITY_ACCEPT_SCHEMA },
      operation: { const: 'accept' },
      ...requestProperties,
      expectedRevision: { const: 0 },
    },
    ['schema', 'operation', 'workspaceId', 'planId', 'expectedRevision', 'route', 'record'],
  ),
};

const transitionSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/governance-authority-transition.v1.schema.json',
  title: 'OpenSlack Governance Authority Transition Request',
  $comment:
    'Structural prefilter. Runtime validation requires record.revision=expectedRevision+1, an immutable route, and the exact operation/state transition permitted by governed-plan v1.',
  ...strictObject(
    {
      schema: { const: GOVERNANCE_AUTHORITY_TRANSITION_SCHEMA },
      operation: { enum: GOVERNANCE_AUTHORITY_TRANSITIONS },
      ...requestProperties,
      expectedRevision: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER - 1 },
    },
    ['schema', 'operation', 'workspaceId', 'planId', 'expectedRevision', 'route', 'record'],
  ),
  allOf: [
    {
      if: { properties: { operation: { const: 'claim_execution' } } },
      then: { properties: { record: { properties: { state: { const: 'executing' } } } } },
    },
    {
      if: { properties: { operation: { const: 'complete_execution' } } },
      then: {
        properties: {
          record: { properties: { state: { enum: ['succeeded', 'blocked', 'failed'] } } },
        },
      },
    },
    {
      if: { properties: { operation: { const: 'cancel' } } },
      then: { properties: { record: { properties: { state: { const: 'cancelled' } } } } },
    },
    {
      if: { properties: { operation: { const: 'expire' } } },
      then: { properties: { record: { properties: { state: { const: 'expired' } } } } },
    },
    {
      if: { properties: { operation: { const: 'require_reconciliation' } } },
      then: {
        properties: {
          record: { properties: { state: { const: 'reconciliation_required' } } },
        },
      },
    },
  ],
};

const receiptCommon: JsonRecord = {
  schema: { const: GOVERNANCE_AUTHORITY_RECEIPT_SCHEMA },
  operation: { enum: GOVERNANCE_AUTHORITY_OPERATIONS },
  workspaceId: { type: 'string', pattern: IDENTIFIER_PATTERN },
  planId: { type: 'string', pattern: PLAN_ID_PATTERN },
  expectedRevision: { type: 'integer', minimum: 0, maximum: MAX_SAFE_INTEGER - 1 },
  route: { $ref: 'https://openslack.dev/contracts/governance-authority-route.v1.schema.json' },
  idempotencyKey: {
    type: 'string',
    pattern: '^openslack\\.governance-authority\\.v1\\.[0-9a-f]{64}$',
  },
  requestFingerprint: { type: 'string', pattern: SHA256_PATTERN },
  recordHash: { type: 'string', pattern: HASH_PATTERN },
  correlationId: { type: 'string', pattern: IDENTIFIER_PATTERN },
  callerId: { type: 'string', pattern: IDENTIFIER_PATTERN },
  serviceBuildSha: { type: 'string', pattern: HASH_PATTERN },
  executionId: { type: 'string', pattern: EXECUTION_ID_PATTERN },
};

const receiptCommonRequired = [
  'schema',
  'operation',
  'status',
  'workspaceId',
  'planId',
  'expectedRevision',
  'route',
  'idempotencyKey',
  'requestFingerprint',
  'recordHash',
  'correlationId',
  'callerId',
  'serviceBuildSha',
] as const;

const executionIdScope = {
  if: { properties: { operation: { enum: ['accept', 'cancel', 'expire'] } } },
  then: { not: { properties: { executionId: {} }, required: ['executionId'] } },
};

const receiptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/governance-authority-receipt.v1.schema.json',
  title: 'OpenSlack Governance Authority Durable Receipt',
  oneOf: [
    {
      ...strictObject(
        {
          ...receiptCommon,
          status: { enum: ['accepted', 'duplicate'] },
          acceptedRevision: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
          state: {
            enum: [
              'pending',
              'executing',
              'succeeded',
              'blocked',
              'failed',
              'reconciliation_required',
              'cancelled',
              'expired',
            ],
          },
          record: {
            $ref: 'https://openslack.dev/contracts/governed-plan/v1/governed-plan.v1.schema.json',
          },
          committedAt: { type: 'string', pattern: TIMESTAMP_PATTERN },
        },
        [...receiptCommonRequired, 'acceptedRevision', 'state', 'record', 'committedAt'],
      ),
      allOf: [executionIdScope],
    },
    {
      ...strictObject(
        {
          ...receiptCommon,
          status: { const: 'reconciliation_required' },
          targetRevision: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
          targetState: {
            enum: [
              'pending',
              'executing',
              'succeeded',
              'blocked',
              'failed',
              'reconciliation_required',
              'cancelled',
              'expired',
            ],
          },
          reconciliationToken: {
            type: 'string',
            minLength: 16,
            maxLength: 256,
            pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$',
          },
        },
        [...receiptCommonRequired, 'targetRevision', 'targetState', 'reconciliationToken'],
      ),
      allOf: [executionIdScope],
    },
  ],
};

const readSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/governance-authority-read.v1.schema.json',
  title: 'OpenSlack Governance Authority Read Response',
  ...strictObject(
    {
      schema: { const: GOVERNANCE_AUTHORITY_READ_SCHEMA },
      workspaceId: { type: 'string', pattern: IDENTIFIER_PATTERN },
      planId: { type: 'string', pattern: PLAN_ID_PATTERN },
      route: { $ref: 'https://openslack.dev/contracts/governance-authority-route.v1.schema.json' },
      recordHash: { type: 'string', pattern: HASH_PATTERN },
      record: {
        $ref: 'https://openslack.dev/contracts/governed-plan/v1/governed-plan.v1.schema.json',
      },
      serviceBuildSha: { type: 'string', pattern: HASH_PATTERN },
    },
    ['schema', 'workspaceId', 'planId', 'route', 'recordHash', 'record', 'serviceBuildSha'],
  ),
};

const pendingAuditSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/governance-authority-pending-audit.v1.schema.json',
  title: 'OpenSlack Governance Authority Pending Audit Point Read',
  $comment:
    'A bounded recovery sidecar only. Runtime validation requires the exact workspace, plan, revision, persisted Go route, active-or-drain epoch, and expected service build. The authoritative plan record is loaded separately.',
  ...strictObject(
    {
      schema: { const: GOVERNANCE_AUTHORITY_PENDING_AUDIT_SCHEMA },
      status: { const: 'pending' },
      operation: { enum: GOVERNANCE_AUTHORITY_OPERATIONS },
      workspaceId: { type: 'string', pattern: IDENTIFIER_PATTERN },
      planId: { type: 'string', pattern: PLAN_ID_PATTERN },
      revision: { type: 'integer', minimum: 1, maximum: MAX_SAFE_INTEGER },
      route: { $ref: 'https://openslack.dev/contracts/governance-authority-route.v1.schema.json' },
      recordHash: { type: 'string', pattern: HASH_PATTERN },
      serviceBuildSha: { type: 'string', pattern: HASH_PATTERN },
    },
    [
      'schema',
      'status',
      'operation',
      'workspaceId',
      'planId',
      'revision',
      'route',
      'recordHash',
      'serviceBuildSha',
    ],
  ),
};

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function authorityRecordHash(record: GovernedPlanRecord): string {
  return sha256(
    Buffer.from(`${canonicalGovernedJson(validateGovernedPlanRecord(record))}\n`, 'utf8'),
  );
}

function requestFingerprint(input: {
  readonly path: string;
  readonly callerId: string;
  readonly workspaceId: string;
  readonly routingEpoch: number;
  readonly expectedBuildSha: string;
  readonly exactBody: Buffer;
}): string {
  const prefix = Buffer.from(
    `POST\n${input.path}\n${input.callerId}\n${input.workspaceId}\n${String(input.routingEpoch)}\n${input.expectedBuildSha}\n`,
    'utf8',
  );
  return `sha256:${createHash('sha256').update(prefix).update(input.exactBody).digest('hex')}`;
}

async function prettyJson(value: unknown): Promise<Buffer> {
  return Buffer.from(
    await format(`${JSON.stringify(value)}\n`, { parser: 'json', endOfLine: 'lf' }),
    'utf8',
  );
}

function pendingRecord(): GovernedPlanRecord {
  const canonicalPlan = createCanonicalGovernedPlan({
    kind: 'scenario.instantiate',
    goal: 'Instantiate governed contract-to-delivery scenario',
    input: { scenarioId: 'contract-to-delivery-lite' },
    actions: [
      {
        actionId: 'scenario.instantiate',
        input: { scenarioId: 'contract-to-delivery-lite' },
      },
    ],
    effects: [
      {
        type: 'scenario.instance',
        summary: 'Create one governed scenario instance',
        risk: 'medium',
      },
    ],
  });
  const hash = 'a'.repeat(64);
  return validateGovernedPlanRecord({
    schema: 'openslack.governed_plan.v1',
    revision: 1,
    planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174000',
    state: 'pending',
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:00.000Z',
    expiresAt: '2026-08-03T00:15:00.000Z',
    canonicalPlan,
    bindings: {
      actorId: 'agent.demo',
      workspaceId: 'workspace.demo',
      correlationId: 'CORR-123e4567-e89b-42d3-a456-426614174000',
      inputHash: hashGovernedValue(canonicalPlan.input),
      planHash: hashGovernedValue(canonicalPlan),
      sourceVersionHash: hash,
      permissionSnapshotHash: hash,
      actionCatalogHash: hash,
      executorBindingHash: hash,
      buildNonceHash: hashOpaqueValue('build-nonce-authority-vector'),
      processNonceHash: hashOpaqueValue('process-nonce-authority-vector'),
    },
    confirmationTokenHash: hashOpaqueValue('confirmation-token-authority-vector'),
  });
}

function executingRecord(pending: GovernedPlanRecord): GovernedPlanRecord {
  return validateGovernedPlanRecord({
    ...pending,
    revision: 2,
    state: 'executing',
    updatedAt: '2026-08-03T00:01:00.000Z',
    execution: {
      executionId: 'GEXEC-123e4567-e89b-42d3-a456-426614174000',
      ownerPid: 42,
      startedAt: '2026-08-03T00:01:00.000Z',
      outcomes: [],
    },
  });
}

function preparedRequest(
  request: JsonRecord & {
    workspaceId: string;
    route: { routingEpoch: number };
  },
  callerId: string,
  expectedBuildSha: string,
): JsonRecord {
  const exactBody = Buffer.from(`${canonicalGovernedJson(request)}\n`, 'utf8');
  const path =
    request.operation === 'accept'
      ? AUTHORITY_ACCEPT_PATH
      : `/v1/governance/plans/${request.planId}:${String(request.operation).replaceAll('_', '-')}`;
  return {
    method: 'POST',
    path,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': `${GOVERNANCE_AUTHORITY_IDEMPOTENCY_PREFIX}${sha256(exactBody)}`,
      'X-OpenSlack-Governance-Caller-ID': callerId,
      'X-OpenSlack-Governance-Workspace-ID': request.workspaceId,
      'X-OpenSlack-Governance-Routing-Epoch': request.route.routingEpoch.toString(10),
      'X-OpenSlack-Governance-Expected-Build-SHA': expectedBuildSha,
    },
    exactBody: exactBody.toString('utf8'),
    requestFingerprint: requestFingerprint({
      path,
      callerId,
      workspaceId: request.workspaceId,
      routingEpoch: request.route.routingEpoch,
      expectedBuildSha,
      exactBody,
    }),
  };
}

function preparedPendingAuditRead(input: {
  readonly record: GovernedPlanRecord;
  readonly route: { readonly routingEpoch: number };
  readonly callerId: string;
  readonly expectedBuildSha: string;
}): JsonRecord {
  return {
    method: 'GET',
    path: `/v1/governance/plans/${input.record.planId}/authority-events/${String(input.record.revision)}:pending`,
    headers: {
      'X-OpenSlack-Governance-Caller-ID': input.callerId,
      'X-OpenSlack-Governance-Workspace-ID': input.record.bindings.workspaceId,
      'X-OpenSlack-Governance-Routing-Epoch': input.route.routingEpoch.toString(10),
      'X-OpenSlack-Governance-Expected-Build-SHA': input.expectedBuildSha,
    },
  };
}

async function buildGoldenVectors(): Promise<Buffer> {
  const record = pendingRecord();
  const claimed = executingRecord(record);
  const route = {
    backend: 'go',
    routingEpoch: 7,
    authority: 'governance-control',
  } as const;
  const callerId = 'openslack.mcp.local';
  const expectedBuildSha = 'b'.repeat(64);
  const acceptRequest = {
    schema: GOVERNANCE_AUTHORITY_ACCEPT_SCHEMA,
    operation: 'accept',
    workspaceId: record.bindings.workspaceId,
    planId: record.planId,
    expectedRevision: 0,
    route,
    record,
  };
  const transitionRequest = {
    schema: GOVERNANCE_AUTHORITY_TRANSITION_SCHEMA,
    operation: 'claim_execution',
    workspaceId: claimed.bindings.workspaceId,
    planId: claimed.planId,
    expectedRevision: 1,
    route,
    record: claimed,
  };
  const acceptPrepared = preparedRequest(acceptRequest, callerId, expectedBuildSha);
  const transitionPrepared = preparedRequest(transitionRequest, callerId, expectedBuildSha);
  const acceptIdempotencyKey = (acceptPrepared.headers as JsonRecord)['Idempotency-Key'];
  const transitionIdempotencyKey = (transitionPrepared.headers as JsonRecord)['Idempotency-Key'];
  const pendingAuditRecoveries = [
    { name: 'recover-pending-accept-audit-at-revision-1', operation: 'accept', record },
    {
      name: 'recover-pending-claim-execution-audit-at-revision-2',
      operation: 'claim_execution',
      record: claimed,
    },
  ].map((vector) => ({
    name: vector.name,
    request: preparedPendingAuditRead({
      record: vector.record,
      route,
      callerId,
      expectedBuildSha,
    }),
    response: {
      schema: GOVERNANCE_AUTHORITY_PENDING_AUDIT_SCHEMA,
      status: 'pending',
      operation: vector.operation,
      workspaceId: vector.record.bindings.workspaceId,
      planId: vector.record.planId,
      revision: vector.record.revision,
      route,
      recordHash: authorityRecordHash(vector.record),
      serviceBuildSha: expectedBuildSha,
    },
  }));
  return prettyJson({
    schema: 'openslack.governance_authority_golden_vectors.v1',
    authority: 'governance-control',
    generator: '@openslack/operator-typescript',
    vectors: [
      {
        name: 'accept-revision-1-at-routing-epoch-7',
        request: acceptRequest,
        prepared: acceptPrepared,
        successReceipt: {
          schema: GOVERNANCE_AUTHORITY_RECEIPT_SCHEMA,
          operation: 'accept',
          status: 'accepted',
          workspaceId: record.bindings.workspaceId,
          planId: record.planId,
          expectedRevision: 0,
          acceptedRevision: 1,
          state: 'pending',
          route,
          idempotencyKey: acceptIdempotencyKey,
          requestFingerprint: acceptPrepared.requestFingerprint,
          recordHash: authorityRecordHash(record),
          correlationId: record.bindings.correlationId,
          callerId,
          serviceBuildSha: expectedBuildSha,
          record,
          committedAt: '2026-08-03T00:00:00.100Z',
        },
      },
      {
        name: 'claim-execution-from-revision-1-at-routing-epoch-7',
        request: transitionRequest,
        prepared: transitionPrepared,
        successReceipt: {
          schema: GOVERNANCE_AUTHORITY_RECEIPT_SCHEMA,
          operation: 'claim_execution',
          status: 'accepted',
          workspaceId: claimed.bindings.workspaceId,
          planId: claimed.planId,
          expectedRevision: 1,
          acceptedRevision: 2,
          state: 'executing',
          route,
          idempotencyKey: transitionIdempotencyKey,
          requestFingerprint: transitionPrepared.requestFingerprint,
          recordHash: authorityRecordHash(claimed),
          correlationId: claimed.bindings.correlationId,
          callerId,
          serviceBuildSha: expectedBuildSha,
          executionId: claimed.execution?.executionId,
          record: claimed,
          committedAt: '2026-08-03T00:01:00.100Z',
        },
        responseLostReceipt: {
          schema: GOVERNANCE_AUTHORITY_RECEIPT_SCHEMA,
          operation: 'claim_execution',
          status: 'reconciliation_required',
          workspaceId: claimed.bindings.workspaceId,
          planId: claimed.planId,
          expectedRevision: 1,
          targetRevision: 2,
          targetState: 'executing',
          route,
          idempotencyKey: transitionIdempotencyKey,
          requestFingerprint: transitionPrepared.requestFingerprint,
          recordHash: authorityRecordHash(claimed),
          correlationId: claimed.bindings.correlationId,
          callerId,
          serviceBuildSha: expectedBuildSha,
          executionId: claimed.execution?.executionId,
          reconciliationToken: 'GREC-authority-vector-0001',
        },
      },
    ],
    pendingAuditRecoveries,
    pendingAuditRecoverySemantics: {
      lookup: ['workspaceId', 'planId', 'revision'],
      atMostOnePendingPerPlan: true,
      pendingRevisionEqualsCurrentHead: true,
      nextTransitionBlockedWhilePending: true,
      authoritativeRecordLoadedSeparately: true,
      responseHasRecord: false,
      responseHasState: false,
      query: 'forbidden',
      body: 'forbidden',
      absent: 404,
      alreadyRecorded: 404,
      routeEpochMismatch: 409,
      invalidBindingOrIdentity: 422,
      internalFailure: 500,
      unavailable: 503,
    },
    boundaries: {
      reconciliationToken: {
        minimumAccepted: 'GREC-12345678901',
        maximumAccepted: 'r'.repeat(256),
        minimumLength: 16,
        maximumLength: 256,
      },
    },
  });
}

export async function buildGovernanceAuthorityContractOutputs(
  outputRoot = GOVERNANCE_AUTHORITY_REPOSITORY_ROOT,
): Promise<ReadonlyMap<string, Buffer>> {
  const roots = governanceAuthorityContractRoots(outputRoot);
  const schemas = new Map<string, Buffer>([
    ['schemas/governance-authority-route.v1.schema.json', await prettyJson(routeSchema)],
    ['schemas/governance-authority-accept.v1.schema.json', await prettyJson(acceptSchema)],
    ['schemas/governance-authority-transition.v1.schema.json', await prettyJson(transitionSchema)],
    ['schemas/governance-authority-receipt.v1.schema.json', await prettyJson(receiptSchema)],
    ['schemas/governance-authority-read.v1.schema.json', await prettyJson(readSchema)],
    [
      'schemas/governance-authority-pending-audit.v1.schema.json',
      await prettyJson(pendingAuditSchema),
    ],
  ]);
  const vectorBytes = await buildGoldenVectors();
  const artifacts: JsonRecord = {};
  for (const [path, value] of [...schemas, ['golden-vectors.json', vectorBytes] as const]) {
    artifacts[path] = { path, byteLength: value.length, sha256: sha256(value) };
  }
  const manifestBytes = await prettyJson({
    schema: 'openslack.governance_authority_contract_manifest.v1',
    authority: 'governance-control',
    generator: '@openslack/operator-typescript',
    authorityBoundary: {
      durableWriter: 'services/governance-control',
      typescriptRoles: [
        'plan-compiler',
        'confirmation-token-and-binding-validator',
        'action-dispatcher',
        'audit-projection',
      ],
      goApiAcceptedRoute: { backend: 'go', authority: 'governance-control' },
      legacyMissingRoute: {
        backend: 'ts-local',
        routingEpoch: 1,
        authority: 'typescript',
      },
      routeImmutablePerRecord: true,
      higherEpochAffectsNewRecordsOnly: true,
      perRequestFallback: false,
      doubleWrite: false,
      hostActivation: {
        acceptNewRecordsDefault: false,
        acceptRequiresActiveEpoch: true,
        drainEpochOperations: [
          'authority_read',
          'receipt_read',
          'pending_audit_read',
          'transition',
          'audit_projection',
        ],
        drainEpochAccept: false,
      },
    },
    schemas: {
      accept: GOVERNANCE_AUTHORITY_ACCEPT_SCHEMA,
      transition: GOVERNANCE_AUTHORITY_TRANSITION_SCHEMA,
      receipt: GOVERNANCE_AUTHORITY_RECEIPT_SCHEMA,
      read: GOVERNANCE_AUTHORITY_READ_SCHEMA,
      pendingAudit: GOVERNANCE_AUTHORITY_PENDING_AUDIT_SCHEMA,
      record: 'openslack.governed_plan.v1',
    },
    operations: GOVERNANCE_AUTHORITY_OPERATIONS,
    transport: {
      accept: { method: 'POST', path: AUTHORITY_ACCEPT_PATH },
      transitions: {
        method: 'POST',
        paths: {
          claim_execution: '/v1/governance/plans/{planId}:claim-execution',
          complete_execution: '/v1/governance/plans/{planId}:complete-execution',
          cancel: '/v1/governance/plans/{planId}:cancel',
          expire: '/v1/governance/plans/{planId}:expire',
          require_reconciliation: '/v1/governance/plans/{planId}:require-reconciliation',
        },
      },
      authorityRead: { method: 'GET', path: '/v1/governance/plans/{planId}' },
      receiptRead: {
        method: 'GET',
        path: '/v1/governance/receipts/{idempotencyKey}',
      },
      pendingAuditRead: {
        method: 'GET',
        path: '/v1/governance/plans/{planId}/authority-events/{revision}:pending',
        headers: [
          'X-OpenSlack-Governance-Caller-ID',
          'X-OpenSlack-Governance-Workspace-ID',
          'X-OpenSlack-Governance-Routing-Epoch',
          'X-OpenSlack-Governance-Expected-Build-SHA',
        ],
        query: 'forbidden',
        body: 'forbidden',
      },
      headers: [
        'Content-Type',
        'Idempotency-Key',
        'X-OpenSlack-Governance-Caller-ID',
        'X-OpenSlack-Governance-Workspace-ID',
        'X-OpenSlack-Governance-Routing-Epoch',
        'X-OpenSlack-Governance-Expected-Build-SHA',
      ],
      redirect: 'forbidden',
      dns: 'forbidden',
    },
    algorithms: {
      body: 'openslack.ecmascript_canonical_json.v1 UTF-8 plus LF',
      idempotencyKey: `${GOVERNANCE_AUTHORITY_IDEMPOTENCY_PREFIX} + hex(SHA256(exactBodyBytes))`,
      requestFingerprint:
        "sha256:hex(SHA256(UTF8(method+'\\n'+path+'\\n'+callerId+'\\n'+workspaceId+'\\n'+canonicalEpoch+'\\n'+expectedBuildSha+'\\n') + exactBodyBytes))",
      canonicalEpoch: 'base-10 positive safe integer without leading zeroes',
      recordHash: 'sha256(openslack.ecmascript_canonical_json.v1(record) UTF-8 plus LF)',
    },
    receiptSemantics: {
      acceptedOrDuplicate: ['acceptedRevision', 'state', 'record', 'committedAt'],
      reconciliationRequired: [
        'targetRevision',
        'targetState',
        'recordHash',
        'reconciliationToken',
      ],
      reconciliationForbids: ['acceptedRevision', 'state', 'record', 'committedAt'],
      responseLossNeverInventsCommit: true,
    },
    pendingAuditRecoverySemantics: {
      lookup: ['workspaceId', 'planId', 'revision'],
      status: 'pending',
      operations: GOVERNANCE_AUTHORITY_OPERATIONS,
      atMostOnePendingPerPlan: true,
      pendingRevisionEqualsCurrentHead: true,
      nextTransitionBlockedWhilePending: true,
      exactResponseKeys: [
        'schema',
        'status',
        'workspaceId',
        'planId',
        'revision',
        'operation',
        'route',
        'recordHash',
        'serviceBuildSha',
      ],
      authoritativeRecordLoadedSeparately: true,
      responseIncludesRecord: false,
      responseIncludesState: false,
      absentOrAlreadyRecorded: 404,
      routeEpochMismatch: 409,
      invalidBindingOrIdentity: 422,
      internalFailure: 500,
      unavailable: 503,
      restartRecovery: 'bounded-local-sidecar-enumeration-plus-point-read',
    },
    limits: {
      requestBytes: 2 * 1024 * 1024,
      identifierBytes: 256,
      reconciliationTokenCharacters: { minimum: 16, maximum: 256 },
      routingEpoch: { minimum: 1, maximum: MAX_SAFE_INTEGER },
    },
    semanticValidationRequired: true,
    semanticConstraints: [
      'request-header-and-body-scope-equality',
      'go-api-requires-go-governance-control-route',
      'record-workspace-plan-correlation-equality',
      'accept-requires-expected-revision-zero-and-pending-revision-one',
      'transition-requires-record-revision-equals-expected-revision-plus-one',
      'operation-state-transition-match',
      'immutable-record-route',
      'strict-idempotency-fingerprint-conflict',
      'receipt-record-and-record-hash-equality',
      'receipt-committed-at-canonical-millisecond-utc',
      'pending-audit-workspace-plan-revision-route-and-record-hash-equality',
      'pending-audit-operation-is-original-authority-mutation-operation',
      'at-most-one-pending-audit-delivery-per-plan',
      'pending-audit-revision-equals-current-authority-head',
      'next-transition-requires-current-revision-audit-delivery-recorded',
      'pending-audit-record-is-loaded-through-authority-read-before-reconstruction',
      'pending-audit-recorded-or-absent-is-not-found',
      'exact-expected-service-build',
      'no-fallback-or-double-write',
    ],
    artifacts,
  });
  const outputs = new Map<string, Buffer>();
  for (const root of [roots.authorityRoot, roots.goMirrorRoot]) {
    for (const [path, value] of schemas) outputs.set(resolve(root, path), value);
    outputs.set(resolve(root, 'golden-vectors.json'), vectorBytes);
    outputs.set(resolve(root, 'manifest.json'), manifestBytes);
  }
  return outputs;
}

export async function writeGovernanceAuthorityContractOutputs(
  outputRoot = GOVERNANCE_AUTHORITY_REPOSITORY_ROOT,
): Promise<ReadonlyMap<string, Buffer>> {
  const outputs = await buildGovernanceAuthorityContractOutputs(outputRoot);
  for (const [path, value] of outputs) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  }
  return outputs;
}
