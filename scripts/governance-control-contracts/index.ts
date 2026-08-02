import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  canonicalGovernedJson,
  createCanonicalGovernedPlan,
  GOVERNED_EXECUTION_STATUSES,
  GOVERNED_PLAN_CONTRACT_ERROR_CODES,
  GOVERNED_PLAN_CONTRACT_LIMITS,
  GOVERNED_PLAN_STATES,
  GovernedPlanContractError,
  hashGovernedValue,
  hashOpaqueValue,
  opaqueHashesEqual,
  validateGovernedPlanRecord,
  type GovernedPlanRecord,
} from '../../packages/operator/src/governed-plan.js';
import {
  GOVERNED_PLAN_STATE_TRANSITIONS,
  GOVERNED_PLAN_STORE_ALGORITHMS,
  GOVERNED_PLAN_STORE_ERROR_CODES,
  GOVERNED_PLAN_STORE_LIMITS,
} from '../../packages/operator/src/governed-plan-store.js';
import {
  GOVERNED_PLAN_AUDIT_EVENT_TYPES,
  GOVERNED_PLAN_SERVICE_ERROR_CODES,
  GOVERNED_PLAN_SERVICE_LIMITS,
} from '../../packages/operator/src/governed-plan-service.js';
import { projectGovernedPlanReadModel } from '../../packages/operator/src/governed-plan-read-model.js';
import {
  buildGovernanceShadowContractOutputs,
  governanceShadowContractRoots,
  GOVERNANCE_SHADOW_CONTRACT_EXPECTED_PATHS,
} from './shadow.js';

type JsonRecord = Record<string, unknown>;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '../..');
const generatedOutputRoot =
  process.env.OPENSLACK_GOVERNANCE_CONTRACTS_OUTPUT_ROOT === undefined
    ? repositoryRoot
    : resolve(process.env.OPENSLACK_GOVERNANCE_CONTRACTS_OUTPUT_ROOT);
const contractRoot = resolve(generatedOutputRoot, 'packages/operator/contracts/governed-plan/v1');
const serviceMirrorRoot = resolve(
  generatedOutputRoot,
  'services/governance-control/internal/contractmirror/generated/v1',
);
const governanceShadowRoots = governanceShadowContractRoots(generatedOutputRoot);

const HASH_PATTERN = '^[0-9a-f]{64}$';
const IDENTIFIER_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$';
const KIND_PATTERN = '^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$';
const PLAN_ID_PATTERN =
  '^GPLAN-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const EXECUTION_ID_PATTERN =
  '^GEXEC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const TIMESTAMP_PATTERN = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';

const strictObject = (properties: JsonRecord, required: readonly string[]): JsonRecord => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});

const governedJsonSchema: JsonRecord = {
  anyOf: [
    { type: 'null' },
    { type: 'boolean' },
    { type: 'number' },
    { type: 'string', maxLength: GOVERNED_PLAN_CONTRACT_LIMITS.maxStringBytes },
    {
      type: 'array',
      maxItems: GOVERNED_PLAN_CONTRACT_LIMITS.maxContainerEntries,
      items: { $ref: '#/$defs/governedJson' },
    },
    {
      type: 'object',
      maxProperties: GOVERNED_PLAN_CONTRACT_LIMITS.maxContainerEntries,
      propertyNames: {
        maxLength: GOVERNED_PLAN_CONTRACT_LIMITS.maxObjectKeyBytes,
        not: { enum: ['__proto__', 'prototype', 'constructor'] },
      },
      additionalProperties: { $ref: '#/$defs/governedJson' },
    },
  ],
};

const actionSchema = strictObject(
  {
    actionId: { type: 'string', pattern: KIND_PATTERN },
    input: { $ref: '#/$defs/governedJson' },
  },
  ['actionId', 'input'],
);
const effectSchema = strictObject(
  {
    type: { type: 'string', pattern: KIND_PATTERN },
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: GOVERNED_PLAN_CONTRACT_LIMITS.maxEffectSummaryBytes,
    },
    risk: { enum: ['low', 'medium', 'high'] },
    target: { type: 'string', pattern: IDENTIFIER_PATTERN },
  },
  ['type', 'summary', 'risk'],
);
const actionPlanSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/governed-plan/v1/governed-action-plan.v1.schema.json',
  title: 'OpenSlack governed action plan v1',
  $comment:
    'Structural prefilter only. Runtime validators enforce UTF-8 bytes, depth, nodes, inert values, and ECMAScript string semantics.',
  ...strictObject(
    {
      schema: { const: 'openslack.governed_action_plan.v1' },
      kind: { type: 'string', pattern: KIND_PATTERN },
      goal: { type: 'string', minLength: 1, maxLength: GOVERNED_PLAN_CONTRACT_LIMITS.maxGoalBytes },
      input: { $ref: '#/$defs/governedJson' },
      actions: {
        type: 'array',
        minItems: 1,
        maxItems: GOVERNED_PLAN_CONTRACT_LIMITS.maxActions,
        items: actionSchema,
      },
      effects: {
        type: 'array',
        maxItems: GOVERNED_PLAN_CONTRACT_LIMITS.maxEffects,
        items: effectSchema,
      },
    },
    ['schema', 'kind', 'goal', 'input', 'actions', 'effects'],
  ),
  $defs: { governedJson: governedJsonSchema },
};

const bindingsSchema = strictObject(
  {
    actorId: { type: 'string', pattern: IDENTIFIER_PATTERN },
    workspaceId: { type: 'string', pattern: IDENTIFIER_PATTERN },
    correlationId: { type: 'string', pattern: IDENTIFIER_PATTERN },
    inputHash: { type: 'string', pattern: HASH_PATTERN },
    planHash: { type: 'string', pattern: HASH_PATTERN },
    sourceVersionHash: { type: 'string', pattern: HASH_PATTERN },
    permissionSnapshotHash: { type: 'string', pattern: HASH_PATTERN },
    actionCatalogHash: { type: 'string', pattern: HASH_PATTERN },
    executorBindingHash: { type: 'string', pattern: HASH_PATTERN },
    buildNonceHash: { type: 'string', pattern: HASH_PATTERN },
    processNonceHash: { type: 'string', pattern: HASH_PATTERN },
  },
  [
    'actorId',
    'workspaceId',
    'correlationId',
    'inputHash',
    'planHash',
    'sourceVersionHash',
    'permissionSnapshotHash',
    'actionCatalogHash',
    'executorBindingHash',
    'buildNonceHash',
    'processNonceHash',
  ],
);
const outcomeSchema = strictObject(
  {
    actionId: { type: 'string', pattern: KIND_PATTERN },
    status: { enum: GOVERNED_EXECUTION_STATUSES },
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: GOVERNED_PLAN_CONTRACT_LIMITS.maxSummaryBytes,
    },
    data: { $ref: '#/$defs/governedJson' },
    evidenceRefs: {
      type: 'array',
      maxItems: GOVERNED_PLAN_CONTRACT_LIMITS.maxContainerEntries,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: GOVERNED_PLAN_CONTRACT_LIMITS.maxEvidenceRefBytes,
      },
    },
  },
  ['actionId', 'status', 'summary', 'evidenceRefs'],
);
const executionSchema = strictObject(
  {
    executionId: { type: 'string', pattern: EXECUTION_ID_PATTERN },
    ownerPid: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
    startedAt: { type: 'string', pattern: TIMESTAMP_PATTERN },
    completedAt: { type: 'string', pattern: TIMESTAMP_PATTERN },
    outcomes: {
      type: 'array',
      maxItems: GOVERNED_PLAN_CONTRACT_LIMITS.maxContainerEntries,
      items: outcomeSchema,
    },
    blocker: {
      type: 'string',
      minLength: 1,
      maxLength: GOVERNED_PLAN_CONTRACT_LIMITS.maxSummaryBytes,
    },
    failure: {
      type: 'string',
      minLength: 1,
      maxLength: GOVERNED_PLAN_CONTRACT_LIMITS.maxSummaryBytes,
    },
  },
  ['executionId', 'ownerPid', 'startedAt', 'outcomes'],
);
const governedPlanSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/governed-plan/v1/governed-plan.v1.schema.json',
  title: 'OpenSlack governed plan record v1',
  $comment:
    'Structural prefilter only. Canonical bytes, UTF-8 bytes, timestamps, hashes, and state semantics require runtime validation.',
  ...strictObject(
    {
      schema: { const: 'openslack.governed_plan.v1' },
      revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      planId: { type: 'string', pattern: PLAN_ID_PATTERN },
      state: { enum: GOVERNED_PLAN_STATES },
      createdAt: { type: 'string', pattern: TIMESTAMP_PATTERN },
      updatedAt: { type: 'string', pattern: TIMESTAMP_PATTERN },
      expiresAt: { type: 'string', pattern: TIMESTAMP_PATTERN },
      canonicalPlan: { $ref: '#/$defs/actionPlan' },
      bindings: bindingsSchema,
      confirmationTokenHash: { type: 'string', pattern: HASH_PATTERN },
      execution: executionSchema,
    },
    [
      'schema',
      'revision',
      'planId',
      'state',
      'createdAt',
      'updatedAt',
      'expiresAt',
      'canonicalPlan',
      'bindings',
      'confirmationTokenHash',
    ],
  ),
  allOf: [
    {
      if: { properties: { state: { const: 'pending' } }, required: ['state'] },
      then: { not: { properties: { execution: {} }, required: ['execution'] } },
    },
    {
      if: { properties: { state: { const: 'executing' } }, required: ['state'] },
      then: {
        required: ['execution'],
        properties: {
          execution: {
            not: {
              type: 'object',
              properties: { completedAt: {} },
              required: ['completedAt'],
            },
          },
        },
      },
    },
    {
      if: {
        properties: {
          state: { enum: ['succeeded', 'blocked', 'failed', 'reconciliation_required'] },
        },
        required: ['state'],
      },
      then: {
        required: ['execution'],
        properties: {
          execution: {
            type: 'object',
            properties: { completedAt: {} },
            required: ['completedAt'],
          },
        },
      },
    },
    {
      if: { properties: { state: { enum: ['cancelled', 'expired'] } }, required: ['state'] },
      then: { not: { properties: { execution: {} }, required: ['execution'] } },
    },
  ],
  $defs: {
    governedJson: governedJsonSchema,
    actionPlan: {
      ...strictObject(
        {
          schema: { const: 'openslack.governed_action_plan.v1' },
          kind: { type: 'string', pattern: KIND_PATTERN },
          goal: {
            type: 'string',
            minLength: 1,
            maxLength: GOVERNED_PLAN_CONTRACT_LIMITS.maxGoalBytes,
          },
          input: { $ref: '#/$defs/governedJson' },
          actions: {
            type: 'array',
            minItems: 1,
            maxItems: GOVERNED_PLAN_CONTRACT_LIMITS.maxActions,
            items: actionSchema,
          },
          effects: {
            type: 'array',
            maxItems: GOVERNED_PLAN_CONTRACT_LIMITS.maxEffects,
            items: effectSchema,
          },
        },
        ['schema', 'kind', 'goal', 'input', 'actions', 'effects'],
      ),
    },
  },
};

const auditSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/governed-plan/v1/governed-plan-audit.v1.schema.json',
  title: 'OpenSlack governed plan audit event v1',
  $comment:
    'Structural prefilter only. UTF-8 bytes, depth, nodes, timestamps, and inert values require runtime validation.',
  ...strictObject(
    {
      schema: { const: 'openslack.governed_plan_audit.v1' },
      eventId: { type: 'string', pattern: IDENTIFIER_PATTERN },
      type: { enum: GOVERNED_PLAN_AUDIT_EVENT_TYPES },
      occurredAt: { type: 'string', pattern: TIMESTAMP_PATTERN },
      planId: { type: 'string', pattern: PLAN_ID_PATTERN },
      kind: { type: 'string', pattern: KIND_PATTERN },
      actorId: { type: 'string', pattern: IDENTIFIER_PATTERN },
      workspaceId: { type: 'string', pattern: IDENTIFIER_PATTERN },
      correlationId: { type: 'string', pattern: IDENTIFIER_PATTERN },
      state: { enum: GOVERNED_PLAN_STATES },
      revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      evidenceRefs: {
        type: 'array',
        maxItems: GOVERNED_PLAN_CONTRACT_LIMITS.maxContainerEntries,
        items: {
          type: 'string',
          minLength: 1,
          maxLength: GOVERNED_PLAN_CONTRACT_LIMITS.maxEvidenceRefBytes,
        },
      },
      details: { $ref: '#/$defs/governedJson' },
    },
    [
      'schema',
      'eventId',
      'type',
      'occurredAt',
      'planId',
      'kind',
      'actorId',
      'workspaceId',
      'correlationId',
      'state',
      'revision',
      'evidenceRefs',
    ],
  ),
  $defs: { governedJson: governedJsonSchema },
};

const executionReadModelSchema = strictObject(
  {
    executionId: { type: 'string', pattern: EXECUTION_ID_PATTERN },
    startedAt: { type: 'string', pattern: TIMESTAMP_PATTERN },
    completedAt: { type: 'string', pattern: TIMESTAMP_PATTERN },
    outcomeCount: { type: 'integer', minimum: 0 },
    evidenceRefCount: { type: 'integer', minimum: 0 },
    blocker: { type: 'string' },
    failure: { type: 'string' },
  },
  ['executionId', 'startedAt', 'outcomeCount', 'evidenceRefCount'],
);
const readModelSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/governed-plan/v1/governed-plan-read-model.v1.schema.json',
  title: 'OpenSlack governed plan credential-free read model v1',
  $comment:
    'Structural prefilter for runtime-projected data; UTF-8 bytes and timestamps still require runtime validation.',
  ...strictObject(
    {
      schema: { const: 'openslack.governed_plan_read_model.v1' },
      planId: { type: 'string', pattern: PLAN_ID_PATTERN },
      revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      state: { enum: GOVERNED_PLAN_STATES },
      kind: { type: 'string', pattern: KIND_PATTERN },
      goal: { type: 'string' },
      actorId: { type: 'string', pattern: IDENTIFIER_PATTERN },
      workspaceId: { type: 'string', pattern: IDENTIFIER_PATTERN },
      correlationId: { type: 'string', pattern: IDENTIFIER_PATTERN },
      createdAt: { type: 'string', pattern: TIMESTAMP_PATTERN },
      updatedAt: { type: 'string', pattern: TIMESTAMP_PATTERN },
      expiresAt: { type: 'string', pattern: TIMESTAMP_PATTERN },
      actionCount: {
        type: 'integer',
        minimum: 1,
        maximum: GOVERNED_PLAN_CONTRACT_LIMITS.maxActions,
      },
      effectCount: {
        type: 'integer',
        minimum: 0,
        maximum: GOVERNED_PLAN_CONTRACT_LIMITS.maxEffects,
      },
      inputHash: { type: 'string', pattern: HASH_PATTERN },
      planHash: { type: 'string', pattern: HASH_PATTERN },
      confirmationBound: { const: true },
      executionTerminal: { type: 'boolean' },
      final: { type: 'boolean' },
      reconciliationRequired: { type: 'boolean' },
      execution: executionReadModelSchema,
    },
    [
      'schema',
      'planId',
      'revision',
      'state',
      'kind',
      'goal',
      'actorId',
      'workspaceId',
      'correlationId',
      'createdAt',
      'updatedAt',
      'expiresAt',
      'actionCount',
      'effectCount',
      'inputHash',
      'planHash',
      'confirmationBound',
      'executionTerminal',
      'final',
      'reconciliationRequired',
    ],
  ),
  allOf: [
    {
      if: { properties: { state: { const: 'pending' } }, required: ['state'] },
      then: {
        properties: {
          final: { const: false },
          executionTerminal: { const: false },
          reconciliationRequired: { const: false },
        },
        not: { properties: { execution: {} }, required: ['execution'] },
      },
    },
    {
      if: { properties: { state: { const: 'executing' } }, required: ['state'] },
      then: {
        properties: {
          final: { const: false },
          executionTerminal: { const: false },
          reconciliationRequired: { const: false },
          execution: {
            type: 'object',
            not: { properties: { completedAt: {} }, required: ['completedAt'] },
          },
        },
        required: ['execution'],
      },
    },
    {
      if: {
        properties: { state: { enum: ['succeeded', 'blocked', 'failed'] } },
        required: ['state'],
      },
      then: {
        properties: {
          final: { const: true },
          executionTerminal: { const: true },
          reconciliationRequired: { const: false },
          execution: {
            type: 'object',
            properties: { completedAt: {} },
            required: ['completedAt'],
          },
        },
        required: ['execution'],
      },
    },
    {
      if: {
        properties: { state: { const: 'reconciliation_required' } },
        required: ['state'],
      },
      then: {
        properties: {
          final: { const: true },
          executionTerminal: { const: true },
          reconciliationRequired: { const: true },
          execution: {
            type: 'object',
            properties: { completedAt: {} },
            required: ['completedAt'],
          },
        },
        required: ['execution'],
      },
    },
    {
      if: {
        properties: { state: { enum: ['cancelled', 'expired'] } },
        required: ['state'],
      },
      then: {
        properties: {
          final: { const: true },
          executionTerminal: { const: false },
          reconciliationRequired: { const: false },
        },
        not: { properties: { execution: {} }, required: ['execution'] },
      },
    },
  ],
};

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function prettyJson(value: unknown): Promise<Buffer> {
  return Buffer.from(
    await format(JSON.stringify(value), { parser: 'json', printWidth: 100, tabWidth: 2 }),
    'utf8',
  );
}

function contractError(run: () => unknown): JsonRecord {
  try {
    run();
  } catch (error) {
    if (error instanceof GovernedPlanContractError) {
      return { name: error.name, code: error.code, path: error.path, message: error.message };
    }
    throw error;
  }
  throw new Error('Golden error vector unexpectedly succeeded.');
}

function pendingRecord(): GovernedPlanRecord {
  const plan = createCanonicalGovernedPlan({
    kind: 'scenario.instantiate',
    goal: 'Instantiate 合同 delivery scenario',
    input: { z: 1e-7, a: ['evidence', { '\u{10000}': 'supplementary', '\uE000': 'bmp' }] },
    actions: [
      { actionId: 'scenario.instantiate', input: { scenarioId: 'contract-to-delivery-lite' } },
    ],
    effects: [
      { type: 'scenario.instance', summary: 'Create one governed instance', risk: 'medium' },
    ],
  });
  const timestamp = '2026-08-02T06:00:00.000Z';
  return validateGovernedPlanRecord({
    schema: 'openslack.governed_plan.v1',
    revision: 1,
    planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174000',
    state: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: '2026-08-02T06:15:00.000Z',
    canonicalPlan: plan,
    bindings: {
      actorId: 'qoder.local',
      workspaceId: 'workspace.demo',
      correlationId: 'CORR-123e4567-e89b-42d3-a456-426614174000',
      inputHash: hashGovernedValue(plan.input),
      planHash: hashGovernedValue(plan),
      sourceVersionHash: hashGovernedValue({ github: 'abc123' }),
      permissionSnapshotHash: hashGovernedValue({ allowed: ['scenario.instantiate'] }),
      actionCatalogHash: hashGovernedValue(['scenario.instantiate']),
      executorBindingHash: hashGovernedValue(['scenario.instantiate@v1']),
      buildNonceHash: hashOpaqueValue('build-nonce-0123456789'),
      processNonceHash: hashOpaqueValue('process-nonce-0123456789'),
    },
    confirmationTokenHash: hashOpaqueValue('confirmation-token-0123456789'),
  });
}

function succeededRecord(): GovernedPlanRecord {
  const pending = pendingRecord();
  return validateGovernedPlanRecord({
    ...pending,
    revision: 3,
    state: 'succeeded',
    updatedAt: '2026-08-02T06:02:00.000Z',
    execution: {
      executionId: 'GEXEC-123e4567-e89b-42d3-a456-426614174000',
      ownerPid: 42,
      startedAt: '2026-08-02T06:01:00.000Z',
      completedAt: '2026-08-02T06:02:00.000Z',
      outcomes: [
        {
          actionId: 'scenario.instantiate',
          status: 'succeeded',
          summary: 'Scenario created',
          evidenceRefs: ['audit:event:001', 'graph:instance:001'],
        },
      ],
    },
  });
}

function recordForState(state: GovernedPlanRecord['state']): GovernedPlanRecord {
  const pending = pendingRecord();
  if (state === 'pending') return pending;
  if (state === 'cancelled' || state === 'expired') {
    return validateGovernedPlanRecord({
      ...pending,
      revision: 2,
      state,
      updatedAt: '2026-08-02T06:02:00.000Z',
    });
  }
  const execution = {
    executionId: 'GEXEC-123e4567-e89b-42d3-a456-426614174000',
    ownerPid: 42,
    startedAt: '2026-08-02T06:01:00.000Z',
    outcomes: [],
  } as const;
  if (state === 'executing') {
    return validateGovernedPlanRecord({
      ...pending,
      revision: 2,
      state,
      updatedAt: execution.startedAt,
      execution,
    });
  }
  return validateGovernedPlanRecord({
    ...pending,
    revision: 3,
    state,
    updatedAt: '2026-08-02T06:02:00.000Z',
    execution: {
      ...execution,
      completedAt: '2026-08-02T06:02:00.000Z',
      ...(state === 'blocked' ? { blocker: 'Awaiting external evidence' } : {}),
      ...(state === 'failed' || state === 'reconciliation_required'
        ? { failure: 'External outcome is uncertain' }
        : {}),
    },
  });
}

function buildVectors(): readonly JsonRecord[] {
  const pending = pendingRecord();
  const succeeded = succeededRecord();
  const canonicalInput = {
    z: 1e-7,
    a: { '\u{10000}': 'supplementary', '\uE000': 'bmp' },
    numbers: [-0, 1e-7, 0.000001, 100000000000000000000, 1e21, 1.2345678901234567],
  };
  return [
    {
      id: 'canonical-json-utf16-number-and-hash',
      operation: 'canonicalize_hash',
      input: { value: canonicalInput },
      expected: {
        canonicalJson: canonicalGovernedJson(canonicalInput),
        sha256: hashGovernedValue(canonicalInput),
      },
    },
    {
      id: 'opaque-confirmation-hash-and-constant-time-match',
      operation: 'hash_opaque',
      input: { value: 'confirmation-token-0123456789', other: 'different-token-012345678901' },
      expected: {
        hash: hashOpaqueValue('confirmation-token-0123456789'),
        equal: opaqueHashesEqual(
          hashOpaqueValue('confirmation-token-0123456789'),
          hashOpaqueValue('confirmation-token-0123456789'),
        ),
        different: opaqueHashesEqual(
          hashOpaqueValue('confirmation-token-0123456789'),
          hashOpaqueValue('different-token-012345678901'),
        ),
      },
    },
    {
      id: 'legacy-unpaired-unicode-surrogate-preserved',
      operation: 'canonicalize_hash',
      input: { value: '\ud800' },
      expected: {
        canonicalJson: canonicalGovernedJson('\ud800'),
        sha256: hashGovernedValue('\ud800'),
      },
    },
    {
      id: 'pending-record-validation-and-read-model',
      operation: 'validate_project_record',
      input: { record: pending },
      expected: {
        canonicalRecord: `${canonicalGovernedJson(pending)}\n`,
        readModel: projectGovernedPlanReadModel(pending),
      },
    },
    {
      id: 'succeeded-record-validation-and-read-model',
      operation: 'validate_project_record',
      input: { record: succeeded },
      expected: {
        canonicalRecord: `${canonicalGovernedJson(succeeded)}\n`,
        readModel: projectGovernedPlanReadModel(succeeded),
      },
    },
    ...(
      ['executing', 'blocked', 'failed', 'reconciliation_required', 'cancelled', 'expired'] as const
    ).map((state) => {
      const record = recordForState(state);
      return {
        id: `${state}-record-validation-and-read-model`,
        operation: 'validate_project_record',
        input: { record },
        expected: {
          canonicalRecord: `${canonicalGovernedJson(record)}\n`,
          readModel: projectGovernedPlanReadModel(record),
        },
      };
    }),
    {
      id: 'calendar-overflow-timestamp-v1-accepted',
      operation: 'validate_project_record',
      input: {
        record: validateGovernedPlanRecord({
          ...pending,
          createdAt: '2026-02-30T06:00:00.000Z',
          updatedAt: '2026-02-30T06:00:00.000Z',
        }),
      },
      expected: (() => {
        const record = validateGovernedPlanRecord({
          ...pending,
          createdAt: '2026-02-30T06:00:00.000Z',
          updatedAt: '2026-02-30T06:00:00.000Z',
        });
        return {
          canonicalRecord: `${canonicalGovernedJson(record)}\n`,
          readModel: projectGovernedPlanReadModel(record),
        };
      })(),
    },
    {
      id: 'record-input-hash-drift-rejected',
      operation: 'validate_record_error',
      input: {
        record: {
          ...pending,
          canonicalPlan: { ...pending.canonicalPlan, input: { changed: true } },
        },
      },
      expectedError: contractError(() =>
        validateGovernedPlanRecord({
          ...pending,
          canonicalPlan: { ...pending.canonicalPlan, input: { changed: true } },
        }),
      ),
    },
    {
      id: 'executing-record-without-execution-rejected',
      operation: 'validate_record_error',
      input: { record: { ...pending, state: 'executing' } },
      expectedError: contractError(() =>
        validateGovernedPlanRecord({ ...pending, state: 'executing' }),
      ),
    },
    {
      id: 'record-plan-hash-drift-rejected',
      operation: 'validate_record_error',
      input: {
        record: { ...pending, bindings: { ...pending.bindings, planHash: '0'.repeat(64) } },
      },
      expectedError: contractError(() =>
        validateGovernedPlanRecord({
          ...pending,
          bindings: { ...pending.bindings, planHash: '0'.repeat(64) },
        }),
      ),
    },
  ];
}

async function buildOutputs(): Promise<Map<string, Buffer>> {
  const schemas = new Map<string, Buffer>([
    ['schemas/governed-action-plan.v1.schema.json', await prettyJson(actionPlanSchema)],
    ['schemas/governed-plan.v1.schema.json', await prettyJson(governedPlanSchema)],
    ['schemas/governed-plan-audit.v1.schema.json', await prettyJson(auditSchema)],
    ['schemas/governed-plan-read-model.v1.schema.json', await prettyJson(readModelSchema)],
  ]);
  const vectorBytes = await prettyJson({
    schema: 'openslack.governed_plan_golden_vectors.v1',
    authority: 'typescript',
    cases: buildVectors(),
  });
  const artifacts: JsonRecord = {};
  for (const [path, bytes] of [...schemas, ['golden-vectors.json', vectorBytes] as const]) {
    artifacts[path] = { path, byteLength: bytes.length, sha256: sha256(bytes) };
  }
  const manifestBytes = await prettyJson({
    schema: 'openslack.governed_plan_contract_manifest.v1',
    authority: 'typescript',
    authorityBoundary: {
      writer: '@openslack/operator',
      goRole: 'credential-free-read-model-only',
      runtimeStore: '.openslack.local/operator/governed-plans',
      memoryBankIsRuntimeStore: false,
    },
    schemas: {
      actionPlan: 'openslack.governed_action_plan.v1',
      record: 'openslack.governed_plan.v1',
      audit: 'openslack.governed_plan_audit.v1',
      readModel: 'openslack.governed_plan_read_model.v1',
    },
    schemaScope: 'structural-prefilter',
    semanticValidationRequired: true,
    semanticConstraints: [
      'canonical-json-exact-bytes',
      'utf8-byte-limits',
      'depth-and-node-limits',
      'inert-value-validation',
      'ecmascript-utf16-string-semantics',
      'timestamp-acceptance',
      'binding-hash-recomputation',
      'state-and-execution-invariants',
    ],
    states: GOVERNED_PLAN_STATES,
    executionStatuses: GOVERNED_EXECUTION_STATUSES,
    stateTransitions: GOVERNED_PLAN_STATE_TRANSITIONS,
    auditEventTypes: GOVERNED_PLAN_AUDIT_EVENT_TYPES,
    limits: {
      contract: GOVERNED_PLAN_CONTRACT_LIMITS,
      store: GOVERNED_PLAN_STORE_LIMITS,
      service: GOVERNED_PLAN_SERVICE_LIMITS,
    },
    algorithms: {
      canonicalJson: 'openslack.ecmascript_canonical_json.v1',
      governedValueHash: 'sha256(canonical_json_utf8)',
      opaqueValueHash: 'sha256(ecmascript_string_utf8)',
      opaqueHashComparison: 'constant_time_sha256_bytes',
      ...GOVERNED_PLAN_STORE_ALGORITHMS,
    },
    errorCodes: {
      contract: GOVERNED_PLAN_CONTRACT_ERROR_CODES,
      store: GOVERNED_PLAN_STORE_ERROR_CODES,
      service: GOVERNED_PLAN_SERVICE_ERROR_CODES,
    },
    artifacts,
  });
  const outputs = new Map<string, Buffer>();
  for (const root of [contractRoot, serviceMirrorRoot]) {
    for (const [path, bytes] of schemas) outputs.set(resolve(root, path), bytes);
    outputs.set(resolve(root, 'golden-vectors.json'), vectorBytes);
    outputs.set(resolve(root, 'manifest.json'), manifestBytes);
  }
  return outputs;
}

const expectedPaths = [
  'schemas/governed-action-plan.v1.schema.json',
  'schemas/governed-plan.v1.schema.json',
  'schemas/governed-plan-audit.v1.schema.json',
  'schemas/governed-plan-read-model.v1.schema.json',
  'golden-vectors.json',
  'manifest.json',
] as const;

async function exactTreeIssues(root: string, paths: readonly string[]): Promise<string[]> {
  const issues: string[] = [];
  const expectedFiles = new Set(paths.map((path) => path.split('/').join(sep)));
  const expectedDirectories = new Set([`schemas`]);
  try {
    const rootStat = await lstat(root);
    if (rootStat.isSymbolicLink())
      return [`${relative(generatedOutputRoot, root)} (symlink forbidden)`];
    if (!rootStat.isDirectory())
      return [`${relative(generatedOutputRoot, root)} (not a directory)`];
  } catch {
    return [];
  }
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      const relativePath = relative(root, path);
      const display = relative(generatedOutputRoot, path).split(sep).join('/');
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) issues.push(`${display} (symlink forbidden)`);
      else if (stat.isDirectory()) {
        if (!expectedDirectories.has(relativePath))
          issues.push(`${display} (unexpected directory)`);
        else await visit(path);
      } else if (!stat.isFile() || !expectedFiles.has(relativePath)) {
        issues.push(`${display} (unexpected file)`);
      }
    }
  };
  await visit(root);
  return issues;
}

async function writeOutputs(outputs: ReadonlyMap<string, Buffer>): Promise<void> {
  const issues = [
    ...(await exactTreeIssues(contractRoot, expectedPaths)),
    ...(await exactTreeIssues(serviceMirrorRoot, expectedPaths)),
    ...(await exactTreeIssues(
      governanceShadowRoots.authorityRoot,
      GOVERNANCE_SHADOW_CONTRACT_EXPECTED_PATHS,
    )),
    ...(await exactTreeIssues(
      governanceShadowRoots.goMirrorRoot,
      GOVERNANCE_SHADOW_CONTRACT_EXPECTED_PATHS,
    )),
  ];
  if (issues.length > 0)
    throw new Error(`Refusing to write unsafe generated trees:\n${issues.join('\n')}`);
  for (const [path, bytes] of outputs) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    console.log(`generated ${relative(generatedOutputRoot, path).split(sep).join('/')}`);
  }
}

async function checkOutputs(outputs: ReadonlyMap<string, Buffer>): Promise<void> {
  const stale = [
    ...(await exactTreeIssues(contractRoot, expectedPaths)),
    ...(await exactTreeIssues(serviceMirrorRoot, expectedPaths)),
    ...(await exactTreeIssues(
      governanceShadowRoots.authorityRoot,
      GOVERNANCE_SHADOW_CONTRACT_EXPECTED_PATHS,
    )),
    ...(await exactTreeIssues(
      governanceShadowRoots.goMirrorRoot,
      GOVERNANCE_SHADOW_CONTRACT_EXPECTED_PATHS,
    )),
  ];
  for (const [path, expected] of outputs) {
    try {
      if (!(await readFile(path)).equals(expected))
        stale.push(`${relative(generatedOutputRoot, path)} (stale)`);
    } catch {
      stale.push(`${relative(generatedOutputRoot, path)} (missing)`);
    }
  }
  if (stale.length > 0) {
    throw new Error(
      `Governance contracts are not current:\n${stale.join('\n')}\nRun: bun run governance:golden generate`,
    );
  }
  console.log(`governance-control contracts current (${outputs.size} generated files)`);
}

async function main(): Promise<void> {
  const argumentsFromCli = process.argv.slice(2).filter((argument) => argument !== '--');
  const mode = argumentsFromCli[0] ?? 'check';
  if (!['check', '--check', 'generate', '--write'].includes(mode) || argumentsFromCli.length > 1) {
    throw new Error('Usage: bun run governance:golden [check|generate]');
  }
  const outputs = await buildOutputs();
  for (const [path, bytes] of await buildGovernanceShadowContractOutputs(generatedOutputRoot)) {
    outputs.set(path, bytes);
  }
  if (mode === 'generate' || mode === '--write') await writeOutputs(outputs);
  else await checkOutputs(outputs);
}

await main();
