import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  GOVERNANCE_SHADOW_AUDIT_EVENT_TYPES,
  GOVERNANCE_SHADOW_CONFIRMATION_OUTCOMES,
  GOVERNANCE_SHADOW_OBSERVATION_KINDS,
  GOVERNANCE_SHADOW_OBSERVATION_SCHEMA,
  GOVERNANCE_SHADOW_POLICY,
  GOVERNANCE_SHADOW_RECEIPT_SCHEMA,
  prepareGovernanceShadowRequest,
  type GovernanceShadowEnvelope,
} from '../../packages/operator/src/governed-plan-shadow.js';

type JsonRecord = Record<string, unknown>;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const GOVERNANCE_SHADOW_REPOSITORY_ROOT = resolve(scriptDirectory, '../..');
export const GOVERNANCE_SHADOW_CONTRACT_EXPECTED_PATHS = Object.freeze([
  'schemas/governance-shadow-observation.v1.schema.json',
  'schemas/governance-shadow-receipt.v1.schema.json',
  'golden-vectors.json',
  'manifest.json',
] as const);

export interface GovernanceShadowContractRoots {
  readonly outputRoot: string;
  readonly authorityRoot: string;
  readonly goMirrorRoot: string;
}

export function governanceShadowContractRoots(
  outputRoot = GOVERNANCE_SHADOW_REPOSITORY_ROOT,
): GovernanceShadowContractRoots {
  const normalized = resolve(outputRoot);
  return Object.freeze({
    outputRoot: normalized,
    authorityRoot: resolve(normalized, 'packages/operator/contracts/governed-plan-shadow/v1'),
    goMirrorRoot: resolve(
      normalized,
      'services/governance-control/internal/contractmirror/generated/shadow/v1',
    ),
  });
}

const HASH_PATTERN = '^[0-9a-f]{64}$';
const IDENTIFIER_PATTERN = '^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$';
const PLAN_ID_PATTERN =
  '^GPLAN-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const ATTEMPT_ID_PATTERN =
  '^GCONF-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const TIMESTAMP_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$';

function strictObject(properties: JsonRecord, required: readonly string[]): JsonRecord {
  return { type: 'object', additionalProperties: false, required, properties };
}

const currentBindingsSchema = strictObject(
  {
    sourceVersionHash: { $ref: '#/$defs/hash' },
    permissionSnapshotHash: { $ref: '#/$defs/hash' },
    actionCatalogHash: { $ref: '#/$defs/hash' },
    executorBindingHash: { $ref: '#/$defs/hash' },
    buildNonceHash: { $ref: '#/$defs/hash' },
    processNonceHash: { $ref: '#/$defs/hash' },
  },
  [
    'sourceVersionHash',
    'permissionSnapshotHash',
    'actionCatalogHash',
    'executorBindingHash',
    'buildNonceHash',
    'processNonceHash',
  ],
);

const observationSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/governance-shadow-observation.v1.schema.json',
  title: 'OpenSlack Governance Shadow Observation',
  ...strictObject(
    {
      schema: { const: GOVERNANCE_SHADOW_OBSERVATION_SCHEMA },
      authority: { const: 'typescript' },
      source: { $ref: '#/$defs/source' },
      observation: {
        oneOf: [
          { $ref: '#/$defs/recordObservation' },
          { $ref: '#/$defs/confirmationObservation' },
          { $ref: '#/$defs/auditObservation' },
        ],
      },
    },
    ['schema', 'authority', 'source', 'observation'],
  ),
  $defs: {
    identifier: { type: 'string', pattern: IDENTIFIER_PATTERN },
    hash: { type: 'string', pattern: HASH_PATTERN },
    planId: { type: 'string', pattern: PLAN_ID_PATTERN },
    attemptId: { type: 'string', pattern: ATTEMPT_ID_PATTERN },
    timestamp: { type: 'string', pattern: TIMESTAMP_PATTERN },
    source: strictObject(
      {
        workspaceId: { $ref: '#/$defs/identifier' },
        planId: { $ref: '#/$defs/planId' },
        sourceSequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
      ['workspaceId', 'planId', 'sourceSequence'],
    ),
    currentBindings: currentBindingsSchema,
    recordObservation: strictObject(
      {
        kind: { const: 'record' },
        expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        record: {
          $ref: 'https://openslack.dev/contracts/governed-plan/v1/governed-plan.v1.schema.json',
        },
      },
      ['kind', 'expectedRevision', 'record'],
    ),
    confirmationObservation: {
      ...strictObject(
        {
          kind: { const: 'confirmation' },
          attemptId: { $ref: '#/$defs/attemptId' },
          recordRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          attemptedAt: { $ref: '#/$defs/timestamp' },
          actorId: { $ref: '#/$defs/identifier' },
          workspaceId: { $ref: '#/$defs/identifier' },
          presentedTokenHash: { $ref: '#/$defs/hash' },
          currentBindings: { $ref: '#/$defs/currentBindings' },
          authorityOutcome: { enum: GOVERNANCE_SHADOW_CONFIRMATION_OUTCOMES },
        },
        [
          'kind',
          'attemptId',
          'recordRevision',
          'attemptedAt',
          'actorId',
          'workspaceId',
          'presentedTokenHash',
          'authorityOutcome',
        ],
      ),
      allOf: [
        {
          if: {
            properties: {
              authorityOutcome: {
                enum: ['claim_eligible', 'binding_changed', 'aborted_before_claim'],
              },
            },
            required: ['authorityOutcome'],
          },
          then: {
            properties: { currentBindings: {} },
            required: ['currentBindings'],
          },
          else: {
            not: {
              properties: { currentBindings: {} },
              required: ['currentBindings'],
            },
          },
        },
      ],
    },
    auditObservation: strictObject(
      {
        kind: { const: 'audit' },
        recordRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        recordHash: { $ref: '#/$defs/hash' },
        event: {
          $ref: 'https://openslack.dev/contracts/governed-plan/v1/governed-plan-audit.v1.schema.json',
        },
      },
      ['kind', 'recordRevision', 'recordHash', 'event'],
    ),
  },
};

const receiptProperties = {
  schema: { const: GOVERNANCE_SHADOW_RECEIPT_SCHEMA },
  operation: { const: 'observation_ingest' },
  status: { enum: ['accepted', 'duplicate', 'reconciliation_required'] },
  parity: { enum: ['matched', 'mismatched', 'unknown'] },
  idempotencyKey: {
    type: 'string',
    pattern: '^openslack\\.governance-shadow\\.v1\\.[0-9a-f]{64}$',
  },
  requestFingerprint: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
  workspaceId: { type: 'string', pattern: IDENTIFIER_PATTERN },
  planId: { type: 'string', pattern: PLAN_ID_PATTERN },
  sourceSequence: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  observationKind: { enum: GOVERNANCE_SHADOW_OBSERVATION_KINDS },
  observationDigest: { type: 'string', pattern: HASH_PATTERN },
  mismatchCode: { type: 'string', pattern: '^[a-z0-9][a-z0-9._:-]{0,255}$' },
  committedAt: {
    type: 'string',
    pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z$',
  },
  reconciliationToken: { type: 'string' },
};

const receiptSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://openslack.dev/contracts/governance-shadow-receipt.v1.schema.json',
  title: 'OpenSlack Governance Shadow Receipt',
  ...strictObject(receiptProperties, [
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
  ]),
  allOf: [
    {
      if: { properties: { status: { const: 'reconciliation_required' } } },
      then: {
        properties: { reconciliationToken: {}, parity: { const: 'unknown' } },
        required: ['reconciliationToken'],
        allOf: [
          { not: { properties: { committedAt: {} }, required: ['committedAt'] } },
          { not: { properties: { mismatchCode: {} }, required: ['mismatchCode'] } },
        ],
      },
      else: {
        properties: { committedAt: {}, parity: { enum: ['matched', 'mismatched'] } },
        required: ['committedAt'],
        not: { properties: { reconciliationToken: {} }, required: ['reconciliationToken'] },
      },
    },
    {
      if: { properties: { parity: { const: 'mismatched' } }, required: ['parity'] },
      then: {
        properties: {
          mismatchCode: {},
          status: { enum: ['accepted', 'duplicate'] },
        },
        required: ['mismatchCode'],
      },
      else: {
        not: { properties: { mismatchCode: {} }, required: ['mismatchCode'] },
      },
    },
  ],
};

function goldenEnvelope(): GovernanceShadowEnvelope {
  const hash = 'a'.repeat(64);
  return {
    schema: GOVERNANCE_SHADOW_OBSERVATION_SCHEMA,
    authority: 'typescript',
    source: {
      workspaceId: 'workspace.demo',
      planId: 'GPLAN-123e4567-e89b-42d3-a456-426614174000',
      sourceSequence: 7,
    },
    observation: {
      kind: 'confirmation',
      attemptId: 'GCONF-123e4567-e89b-42d3-a456-426614174001',
      recordRevision: 1,
      attemptedAt: '2026-08-02T00:00:00.000Z',
      actorId: 'agent.demo',
      workspaceId: 'workspace.demo',
      presentedTokenHash: hash,
      currentBindings: {
        sourceVersionHash: hash,
        permissionSnapshotHash: hash,
        actionCatalogHash: hash,
        executorBindingHash: hash,
        buildNonceHash: hash,
        processNonceHash: hash,
      },
      authorityOutcome: 'claim_eligible',
    },
  };
}

async function prettyJson(value: unknown): Promise<Buffer> {
  return Buffer.from(
    await format(`${JSON.stringify(value)}\n`, { parser: 'json', endOfLine: 'lf' }),
    'utf8',
  );
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function buildGovernanceShadowContractOutputs(
  outputRoot = GOVERNANCE_SHADOW_REPOSITORY_ROOT,
): Promise<ReadonlyMap<string, Buffer>> {
  const roots = governanceShadowContractRoots(outputRoot);
  const schemas = new Map<string, Buffer>([
    ['schemas/governance-shadow-observation.v1.schema.json', await prettyJson(observationSchema)],
    ['schemas/governance-shadow-receipt.v1.schema.json', await prettyJson(receiptSchema)],
  ]);
  const envelope = goldenEnvelope();
  const vectorBytes = await prettyJson({
    schema: 'openslack.governance_shadow_golden_vectors.v1',
    authority: 'typescript',
    vectors: [
      {
        name: 'confirmation-claim-eligible-sequence-7',
        envelope,
        expected: prepareGovernanceShadowRequest(envelope),
      },
    ],
  });
  const artifacts: JsonRecord = {};
  for (const [path, value] of [...schemas, ['golden-vectors.json', vectorBytes] as const]) {
    artifacts[path] = { path, byteLength: value.length, sha256: sha256(value) };
  }
  const { maxDiagnosticMessageBytes: _diagnosticLimit, ...publishedLimits } =
    GOVERNANCE_SHADOW_POLICY;
  const manifestBytes = await prettyJson({
    schema: 'openslack.governance_shadow_contract_manifest.v1',
    authority: 'typescript',
    authorityBoundary: {
      writer: '@openslack/operator',
      goRole: 'credential-free-observer-only',
      typescriptRemainsAuthoritative: true,
      shadowDefault: 'disabled',
      journalIndependentFromGovernedPlanStore: true,
    },
    schemas: {
      observation: GOVERNANCE_SHADOW_OBSERVATION_SCHEMA,
      receipt: GOVERNANCE_SHADOW_RECEIPT_SCHEMA,
    },
    observationKinds: GOVERNANCE_SHADOW_OBSERVATION_KINDS,
    confirmationOutcomes: GOVERNANCE_SHADOW_CONFIRMATION_OUTCOMES,
    auditEventTypes: GOVERNANCE_SHADOW_AUDIT_EVENT_TYPES,
    transport: {
      method: 'POST',
      path: '/v1/shadow/governance/observations',
      redirect: 'forbidden',
      dns: 'forbidden',
      defaultNetworkMode: 'loopback-ip-literal',
      optionalNetworkMode: 'private-link-local-ip-literal',
    },
    algorithms: {
      body: 'ecmascript_canonical_json_utf8_plus_lf',
      idempotencyKey: 'openslack.governance-shadow.v1.sha256(body)',
      requestBinding: 'typescript/{workspaceId}/{planId}/{sourceSequence}',
      requestFingerprint: 'sha256:sha256(POST\\n/path\\n/requestBinding\\n/body)',
      sourceSequence: 'monotonic_per_workspace_plan',
    },
    limits: publishedLimits,
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

export async function writeGovernanceShadowContractOutputs(
  outputRoot = GOVERNANCE_SHADOW_REPOSITORY_ROOT,
): Promise<ReadonlyMap<string, Buffer>> {
  const outputs = await buildGovernanceShadowContractOutputs(outputRoot);
  for (const [path, value] of outputs) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  }
  return outputs;
}
