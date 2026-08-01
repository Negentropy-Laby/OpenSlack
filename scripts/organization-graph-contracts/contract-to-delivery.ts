import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { format } from 'prettier';
import { canonicalJson } from '../../packages/organization-graph/src/canonical-json.js';
import {
  CONTRACT_TO_DELIVERY_PROJECTOR_CONTRACT,
  CONTRACT_TO_DELIVERY_PROJECTOR_ID,
  CONTRACT_TO_DELIVERY_SCENARIO_ID,
  CONTRACT_TO_DELIVERY_SOURCE_LIMITS,
  CONTRACT_TO_DELIVERY_SOURCE_SCHEMA,
} from '../../packages/organization-graph/src/contract-to-delivery-types.js';
import type { ContractToDeliverySourceSnapshot } from '../../packages/organization-graph/src/contract-to-delivery-types.js';
import { projectContractToDeliverySnapshot } from '../../packages/organization-graph/src/contract-to-delivery-projector.js';
import { validateContractToDeliverySourceSnapshot } from '../../packages/organization-graph/src/contract-to-delivery-validation.js';
import {
  GRAPH_CONTRACT_ERROR_CODES,
  GraphContractError,
} from '../../packages/organization-graph/src/errors.js';
import { serializeGraphSnapshot } from '../../packages/organization-graph/src/integrity.js';
import { STRICT_GRAPH_JSON_ERROR_CODES } from '../../packages/organization-graph/src/strict-json.js';

type JsonRecord = Record<string, unknown>;

export interface ContractToDeliveryContractArtifacts {
  readonly schemaBytes: Buffer;
  readonly vectorBytes: Buffer;
  readonly manifestBytes: Buffer;
}

interface ProjectorVector {
  readonly id: string;
  readonly family:
    | 'complete'
    | 'historical'
    | 'all_missing'
    | 'incomplete'
    | 'acceptance_boundary'
    | 'outcome_boundary'
    | 'bridge_drift'
    | 'ordering'
    | 'randomized_valid'
    | 'boundary_valid'
    | 'invalid';
  readonly operation: 'validate_and_project';
  readonly sourceSchemaValid: boolean;
  readonly input: { readonly source: unknown };
  readonly expected?: unknown;
  readonly expectedError?: JsonRecord;
}

type DeepMutable<T> = T extends readonly []
  ? []
  : T extends readonly (infer Item)[]
    ? DeepMutable<Item>[]
    : T extends object
      ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
      : T;
type MutableSource = DeepMutable<ContractToDeliverySourceSnapshot>;

const FIXTURE_URL = new URL(
  '../../packages/organization-graph/src/fixtures/contract-to-delivery-source.json',
  import.meta.url,
);
const RANDOM_SEED = 0xc7d2b11c;
const RANDOM_CASE_COUNT = 16;
const DATE_TIME_PATTERN =
  '^(?:[0-9]{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,9})?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$';

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function prettyJson(value: unknown): Promise<Buffer> {
  return Buffer.from(
    await format(JSON.stringify(value), { parser: 'json', printWidth: 100, tabWidth: 2 }),
    'utf8',
  );
}

function bytesContract(bytes: Buffer): JsonRecord {
  return {
    utf8Base64: bytes.toString('base64'),
    byteLength: bytes.length,
    sha256: sha256(bytes),
  };
}

function errorContract(run: () => unknown): JsonRecord {
  try {
    run();
  } catch (error) {
    if (error instanceof GraphContractError) {
      return { name: error.name, code: error.code, message: error.message, path: error.path };
    }
    throw error;
  }
  throw new Error('Contract-to-Delivery error vector unexpectedly succeeded.');
}

function projectionExpectation(source: ContractToDeliverySourceSnapshot): JsonRecord {
  const result = projectContractToDeliverySnapshot(source);
  const serialized = serializeGraphSnapshot(result.snapshot);
  return {
    projectorId: result.projectorId,
    snapshot: result.snapshot,
    canonicalSnapshotBytes: bytesContract(serialized),
    integrityHash: result.snapshot.integrityHash,
    nodeIds: result.snapshot.nodes.map((node) => node.id),
    edgeIds: result.snapshot.edges.map((edge) => edge.id),
    completeness: result.snapshot.completeness,
    warnings: result.snapshot.completeness.warnings,
  };
}

function clone(source: ContractToDeliverySourceSnapshot): MutableSource {
  return structuredClone(source) as MutableSource;
}

function validVector(
  id: string,
  family: Exclude<ProjectorVector['family'], 'invalid'>,
  source: ContractToDeliverySourceSnapshot,
): ProjectorVector {
  return {
    id,
    family,
    operation: 'validate_and_project',
    sourceSchemaValid: true,
    input: { source },
    expected: projectionExpectation(source),
  };
}

function invalidVector(id: string, source: unknown, sourceSchemaValid = false): ProjectorVector {
  return {
    id,
    family: 'invalid',
    operation: 'validate_and_project',
    sourceSchemaValid,
    input: { source },
    expectedError: errorContract(() => projectContractToDeliverySnapshot(source)),
  };
}

function allBusinessMissing(source: ContractToDeliverySourceSnapshot): MutableSource {
  const result = clone(source);
  for (const name of Object.keys(result.business) as (keyof typeof result.business)[]) {
    result.business[name] = {
      status: 'missing',
      items: [],
      reasonCode: `missing-${name}`,
    } as never;
  }
  return result;
}

function incompleteBusiness(source: ContractToDeliverySourceSnapshot): MutableSource {
  const result = clone(source);
  result.business.contracts = {
    ...result.business.contracts,
    status: 'incomplete',
    warningCodes: ['contract-source-truncated'],
  } as typeof result.business.contracts;
  result.business.outcomes = {
    ...result.business.outcomes,
    status: 'incomplete',
    warningCodes: ['outcome-source-stale'],
  } as typeof result.business.outcomes;
  return result;
}

function acceptanceVariant(
  source: ContractToDeliverySourceSnapshot,
  variant: number,
): MutableSource {
  const result = clone(source);
  switch (variant) {
    case 0:
      result.softwareDelivery.sources.reviews.items = [];
      break;
    case 1:
      result.softwareDelivery.sources.merges.items = [];
      break;
    case 2:
      result.softwareDelivery.sources.pullRequests.items[0]!.observationKind = 'synthetic';
      break;
    case 3:
      result.softwareDelivery.sources.reviews.items[0]!.actorKind = 'agent';
      break;
    default:
      result.softwareDelivery.sources.reviews.items[0]!.state = 'CHANGES_REQUESTED';
  }
  return result;
}

function outcomeVariant(source: ContractToDeliverySourceSnapshot, variant: number): MutableSource {
  const result = clone(source);
  switch (variant) {
    case 0:
      result.business.outcomes.items[0]!.acceptanceId = 'missing-acceptance';
      break;
    case 1:
      result.softwareDelivery.sources.issues.items[0]!.closureComplete = false;
      delete result.softwareDelivery.sources.issues.items[0]!.closedAt;
      break;
    case 2:
      result.softwareDelivery.sources.issues.items[0]!.observationKind = 'cache';
      break;
    default:
      result.softwareDelivery.sources.issues.items[0]!.state = 'open';
      result.softwareDelivery.sources.issues.items[0]!.closureComplete = false;
      delete result.softwareDelivery.sources.issues.items[0]!.closedAt;
  }
  return result;
}

function bridgeDrift(source: ContractToDeliverySourceSnapshot): MutableSource {
  const result = clone(source);
  result.business.milestones.items[0]!.workItem.authorityRef.version += '-drift';
  return result;
}

function permuted(source: ContractToDeliverySourceSnapshot): MutableSource {
  const result = clone(source);
  result.softwareDelivery.sources.actors.items.reverse();
  result.softwareDelivery.sources.reviews.items.reverse();
  for (const batch of Object.values(result.business)) batch.items.reverse();
  return result;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomizedSources(source: ContractToDeliverySourceSnapshot): MutableSource[] {
  const random = mulberry32(RANDOM_SEED);
  return Array.from({ length: RANDOM_CASE_COUNT }, (_, index) => {
    const result = clone(source);
    result.scenarioInstanceId = `scenario-contract-random-${String(index).padStart(2, '0')}`;
    result.cursor = `contract-random-cursor-${String(index).padStart(2, '0')}`;
    result.softwareDelivery.scenarioInstanceId = result.scenarioInstanceId;
    result.softwareDelivery.cursor = result.cursor;
    if (random() < 0.5) {
      result.business.acceptances = {
        ...result.business.acceptances,
        status: 'incomplete',
        warningCodes: [`random-acceptance-${index}`],
      } as typeof result.business.acceptances;
    }
    if (random() < 0.5)
      result.softwareDelivery.sources.pullRequests.items[0]!.observationKind = 'cache';
    if (random() < 0.5)
      result.business.projects.items[0]!.workItem.authorityRef.version += `-r${index}`;
    if (random() < 0.5) result.softwareDelivery.sources.actors.items.reverse();
    return result;
  });
}

function boundarySource(source: ContractToDeliverySourceSnapshot): MutableSource {
  const result = allBusinessMissing(source);
  const template = source.business.customers.items[0]!;
  result.business.customers = {
    status: 'observed',
    batchVersion: 'customers-boundary-v1',
    observedAt: template.authorityRef.observedAt,
    warningCodes: [],
    items: Array.from(
      { length: CONTRACT_TO_DELIVERY_SOURCE_LIMITS.observationsPerKind },
      (_, index) => {
        const id = `customer-boundary-${index}`;
        return {
          ...structuredClone(template),
          id,
          title:
            index === 0
              ? '界'.repeat(CONTRACT_TO_DELIVERY_SOURCE_LIMITS.textBytes / 3)
              : `Customer ${index}`,
          authorityRef: {
            ...template.authorityRef,
            objectId: id,
            version: `fixture-${id}-v1`,
          },
          sourceEventIds: [`event:${id}`],
          evidenceRefs: [`fixture:${id}`],
        };
      },
    ),
  };
  return result;
}

function buildVectors(source: ContractToDeliverySourceSnapshot): readonly ProjectorVector[] {
  const allMissing = allBusinessMissing(source);
  const incomplete = incompleteBusiness(source);
  const drifted = bridgeDrift(source);
  const reordered = permuted(source);
  if (
    canonicalJson(projectionExpectation(source)) !== canonicalJson(projectionExpectation(reordered))
  ) {
    throw new Error('Contract-to-Delivery ordering fixtures must project to identical bytes.');
  }

  const unexpected = { ...clone(source), command: 'run' };
  const wrongScenario = clone(source);
  wrongScenario.scenarioDefinitionId = 'other-scenario' as never;
  const scopeDrift = clone(source);
  scopeDrift.softwareDelivery.cursor = 'other-cursor';
  const wrongBridge = clone(source);
  wrongBridge.business.projects.items[0]!.workItem.targetType = 'reviewable_deliverable';
  const duplicateObservation = clone(source);
  duplicateObservation.business.contracts.items[0]!.id =
    duplicateObservation.business.customers.items[0]!.id;
  duplicateObservation.business.contracts.items[0]!.authorityRef.objectId =
    duplicateObservation.business.contracts.items[0]!.id;
  const duplicateAuthority = clone(source);
  duplicateAuthority.business.contracts.items[0]!.authorityRef = {
    ...duplicateAuthority.business.customers.items[0]!.authorityRef,
  };
  const futureObservation = clone(source);
  futureObservation.business.customers.items[0]!.authorityRef.observedAt =
    '2026-07-27T02:00:01.000Z';
  const unsafeTitle = clone(source);
  unsafeTitle.business.customers.items[0]!.title = 'https://unsafe.example';
  const missingWithItem = clone(source);
  missingWithItem.business.customers = {
    status: 'missing',
    items: missingWithItem.business.customers.items,
    reasonCode: 'unavailable',
  } as never;
  const overKind = clone(source);
  const customerTemplate = overKind.business.customers.items[0]!;
  overKind.business.customers.items = Array.from(
    { length: CONTRACT_TO_DELIVERY_SOURCE_LIMITS.observationsPerKind + 1 },
    (_, index) => {
      const id = `customer-over-${index}`;
      return {
        ...structuredClone(customerTemplate),
        id,
        authorityRef: { ...customerTemplate.authorityRef, objectId: id, version: `v-${id}` },
      };
    },
  );
  const nestedInvalid = clone(source);
  nestedInvalid.softwareDelivery.sources.reviews.items[0]!.actorKind = 'robot' as never;

  const vectors: ProjectorVector[] = [
    validVector('projector-complete-business-chain', 'complete', source),
    validVector('projector-historical-repository-fixture', 'historical', clone(source)),
    validVector('projector-all-business-sources-missing', 'all_missing', allMissing),
    validVector('projector-incomplete-business-warnings', 'incomplete', incomplete),
    ...Array.from({ length: 5 }, (_, index) =>
      validVector(
        `projector-acceptance-informational-${index}`,
        'acceptance_boundary',
        acceptanceVariant(source, index),
      ),
    ),
    ...Array.from({ length: 4 }, (_, index) =>
      validVector(
        `projector-outcome-informational-${index}`,
        'outcome_boundary',
        outcomeVariant(source, index),
      ),
    ),
    validVector('projector-version-drifted-bridge', 'bridge_drift', drifted),
    validVector('projector-business-and-software-ordering', 'ordering', reordered),
    validVector(
      'projector-observations-per-kind-exact-limit',
      'boundary_valid',
      boundarySource(source),
    ),
    ...randomizedSources(source).map((candidate, index) =>
      validVector(
        `projector-randomized-valid-${String(index).padStart(2, '0')}`,
        'randomized_valid',
        candidate,
      ),
    ),
    invalidVector('projector-invalid-unexpected-root-property', unexpected),
    invalidVector('projector-invalid-scenario-definition', wrongScenario),
    invalidVector('projector-invalid-nested-scope-drift', scopeDrift, true),
    invalidVector('projector-invalid-bridge-target-type', wrongBridge),
    invalidVector('projector-invalid-duplicate-observation-id', duplicateObservation, true),
    invalidVector('projector-invalid-duplicate-authority', duplicateAuthority, true),
    invalidVector('projector-invalid-future-business-authority', futureObservation, true),
    invalidVector('projector-invalid-active-content', unsafeTitle, true),
    invalidVector('projector-invalid-missing-batch-with-item', missingWithItem),
    invalidVector('projector-invalid-observations-per-kind-over-limit', overKind),
    invalidVector('projector-invalid-nested-software-delivery', nestedInvalid),
  ];

  const ids = new Set<string>();
  for (const vector of vectors) {
    if (ids.has(vector.id))
      throw new Error(`Contract-to-Delivery vector ID ${vector.id} is duplicated.`);
    ids.add(vector.id);
    const actual =
      vector.family === 'invalid'
        ? errorContract(() => projectContractToDeliverySnapshot(vector.input.source))
        : projectionExpectation(vector.input.source as ContractToDeliverySourceSnapshot);
    const expected = vector.expected ?? vector.expectedError;
    if (expected === undefined || canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error(`Contract-to-Delivery vector ${vector.id} is not replayable.`);
    }
  }
  return vectors;
}

function objectSchema(
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[],
): JsonRecord {
  return { type: 'object', additionalProperties: false, required, properties };
}

function rewriteSoftwareSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteSoftwareSchema);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .filter(([key]) => key !== '$schema' && key !== '$id')
      .map(([key, item]) => [
        key,
        typeof item === 'string' && item.startsWith('#/$defs/')
          ? item.replace('#/$defs/', '#/$defs/softwareDelivery/$defs/')
          : rewriteSoftwareSchema(item),
      ]),
  );
}

function buildSourceSchema(softwareDeliverySchema: unknown): JsonRecord {
  const identifier = { type: 'string', minLength: 1, maxLength: 2_048, pattern: '^\\S+$' };
  const text = {
    type: 'string',
    minLength: 1,
    maxLength: CONTRACT_TO_DELIVERY_SOURCE_LIMITS.textBytes,
  };
  const dateTime = { type: 'string', minLength: 1, maxLength: 64, pattern: DATE_TIME_PATTERN };
  const references = (minimum = 0): JsonRecord => ({
    type: 'array',
    minItems: minimum,
    maxItems: 50,
    uniqueItems: true,
    items: identifier,
  });
  const authority = objectSchema(
    {
      provider: { enum: ['github', 'openslack', 'demo_fixture', 'dingtalk', 'crm', 'erp', 'hr'] },
      objectType: { ...identifier, maxLength: 128 },
      objectId: { ...identifier, maxLength: 512 },
      version: { ...identifier, maxLength: 512 },
      observedAt: dateTime,
    },
    ['provider', 'objectType', 'objectId', 'version', 'observedAt'],
  );
  const bridge = (targetType: string): JsonRecord =>
    objectSchema({ targetType: { const: targetType }, authorityRef: authority }, [
      'targetType',
      'authorityRef',
    ]);
  const evidenceProperties = {
    id: { ...identifier, maxLength: 512 },
    title: text,
    status: { enum: ['active', 'planned', 'completed', 'accepted', 'realized', 'pending'] },
    authorityRef: authority,
    sourceEventIds: references(1),
    evidenceRefs: references(1),
  };
  const evidenceRequired = [
    'id',
    'title',
    'status',
    'authorityRef',
    'sourceEventIds',
    'evidenceRefs',
  ];
  const observation = (
    extras: Readonly<Record<string, unknown>>,
    extraRequired: readonly string[],
  ): JsonRecord =>
    objectSchema({ ...evidenceProperties, ...extras }, [...evidenceRequired, ...extraRequired]);
  const definitions: Record<string, unknown> = {
    softwareDelivery: rewriteSoftwareSchema(softwareDeliverySchema),
    customerObservation: observation({}, []),
    contractObservation: observation(
      { customerId: identifier, deliverable: bridge('reviewable_deliverable') },
      ['customerId', 'deliverable'],
    ),
    projectObservation: observation(
      { contractId: identifier, workItem: bridge('core.work_item') },
      ['contractId', 'workItem'],
    ),
    milestoneObservation: observation(
      { projectId: identifier, workItem: bridge('core.work_item') },
      ['projectId', 'workItem'],
    ),
    acceptanceObservation: observation(
      {
        deliverable: bridge('reviewable_deliverable'),
        humanDecision: bridge('human_decision'),
        acceptedTransition: bridge('accepted_transition'),
      },
      ['deliverable', 'humanDecision', 'acceptedTransition'],
    ),
    outcomeObservation: observation(
      {
        acceptanceId: identifier,
        workItem: bridge('core.work_item'),
        softwareOutcome: bridge('outcome'),
      },
      ['acceptanceId', 'workItem', 'softwareOutcome'],
    ),
  };
  const batch = (definition: string): JsonRecord => {
    const items = {
      type: 'array',
      maxItems: CONTRACT_TO_DELIVERY_SOURCE_LIMITS.observationsPerKind,
      items: { $ref: `#/$defs/${definition}` },
    };
    return {
      oneOf: [
        objectSchema(
          {
            status: { const: 'observed' },
            batchVersion: identifier,
            observedAt: dateTime,
            items,
            warningCodes: references(),
          },
          ['status', 'batchVersion', 'observedAt', 'items', 'warningCodes'],
        ),
        objectSchema(
          {
            status: { const: 'incomplete' },
            batchVersion: identifier,
            observedAt: dateTime,
            items,
            warningCodes: references(1),
          },
          ['status', 'batchVersion', 'observedAt', 'items', 'warningCodes'],
        ),
        objectSchema(
          {
            status: { const: 'missing' },
            items: { type: 'array', maxItems: 0 },
            reasonCode: identifier,
          },
          ['status', 'items', 'reasonCode'],
        ),
      ],
    };
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://openslack.dev/schemas/contract-to-delivery-source-snapshot.v1.schema.json',
    title: 'OpenSlack Contract-to-Delivery Source Snapshot v1',
    description:
      'Closed structural schema for the bounded, injected composite projector source. TypeScript semantic validation remains authoritative.',
    type: 'object',
    additionalProperties: false,
    required: [
      'schema',
      'scenarioDefinitionId',
      'scenarioInstanceId',
      'cursor',
      'generatedAt',
      'projectorVersion',
      'softwareDelivery',
      'business',
    ],
    properties: {
      schema: { const: CONTRACT_TO_DELIVERY_SOURCE_SCHEMA },
      scenarioDefinitionId: { const: CONTRACT_TO_DELIVERY_SCENARIO_ID },
      scenarioInstanceId: identifier,
      cursor: identifier,
      generatedAt: dateTime,
      projectorVersion: { const: CONTRACT_TO_DELIVERY_PROJECTOR_ID },
      softwareDelivery: { $ref: '#/$defs/softwareDelivery' },
      business: objectSchema(
        {
          customers: batch('customerObservation'),
          contracts: batch('contractObservation'),
          projects: batch('projectObservation'),
          milestones: batch('milestoneObservation'),
          acceptances: batch('acceptanceObservation'),
          outcomes: batch('outcomeObservation'),
        },
        ['customers', 'contracts', 'projects', 'milestones', 'acceptances', 'outcomes'],
      ),
    },
    $defs: definitions,
  };
}

function vectorInventory(vectors: readonly ProjectorVector[]): JsonRecord {
  const families: Record<string, number> = {};
  for (const family of [...new Set(vectors.map((vector) => vector.family))].sort()) {
    families[family] = vectors.filter((vector) => vector.family === family).length;
  }
  return {
    total: vectors.length,
    success: vectors.filter((vector) => vector.expected !== undefined).length,
    error: vectors.filter((vector) => vector.expectedError !== undefined).length,
    schemaValid: vectors.filter((vector) => vector.sourceSchemaValid).length,
    schemaInvalid: vectors.filter((vector) => !vector.sourceSchemaValid).length,
    families,
    random: RANDOM_CASE_COUNT,
  };
}

export async function buildContractToDeliveryContractArtifacts(
  softwareDeliverySchemaBytes: Buffer,
): Promise<ContractToDeliveryContractArtifacts> {
  const source = validateContractToDeliverySourceSnapshot(
    JSON.parse(await readFile(FIXTURE_URL, 'utf8')),
  );
  const schemaBytes = await prettyJson(
    buildSourceSchema(JSON.parse(softwareDeliverySchemaBytes.toString('utf8'))),
  );
  const cases = buildVectors(source);
  const vectorBytes = await prettyJson({
    schema: 'openslack.contract_to_delivery_projector_golden_vectors.v1',
    authority: 'typescript',
    projectorId: CONTRACT_TO_DELIVERY_PROJECTOR_ID,
    sourceSchema: CONTRACT_TO_DELIVERY_SOURCE_SCHEMA,
    randomized: {
      algorithm: 'mulberry32.v1',
      seed: `0x${RANDOM_SEED.toString(16).padStart(8, '0')}`,
      cases: RANDOM_CASE_COUNT,
    },
    cases,
  });
  const manifestBytes = await prettyJson({
    schema: 'openslack.contract_to_delivery_projector_contract_manifest.v1',
    authority: 'typescript',
    sourceSchema: CONTRACT_TO_DELIVERY_SOURCE_SCHEMA,
    projectorId: CONTRACT_TO_DELIVERY_PROJECTOR_ID,
    graphSnapshotSchema: 'openslack.graph_snapshot.v1',
    sourceLimits: CONTRACT_TO_DELIVERY_SOURCE_LIMITS,
    projectorContract: CONTRACT_TO_DELIVERY_PROJECTOR_CONTRACT,
    algorithms: {
      validation: 'openslack.contract_to_delivery_source_validation.v1',
      projection: CONTRACT_TO_DELIVERY_PROJECTOR_ID,
      nestedProjection: 'openslack.software_delivery.v1',
      canonicalSnapshot: 'openslack.ecmascript_canonical_json.v1+lf',
      nodeIdentity: 'openslack.graph_node_identity.sha256.v1',
      edgeIdentity: 'openslack.graph_edge_identity.sha256.v1',
      snapshotIntegrity: 'openslack.graph_snapshot_integrity.sha256.v1',
      randomizedCases: 'mulberry32.v1',
    },
    randomized: {
      seed: `0x${RANDOM_SEED.toString(16).padStart(8, '0')}`,
      cases: RANDOM_CASE_COUNT,
    },
    errorCodes: {
      graphContract: GRAPH_CONTRACT_ERROR_CODES,
      strictJson: STRICT_GRAPH_JSON_ERROR_CODES,
    },
    vectorInventory: vectorInventory(cases),
    artifacts: {
      sourceSchema: {
        path: 'schemas/contract-to-delivery-source-snapshot.v1.schema.json',
        sha256: sha256(schemaBytes),
      },
      projectorGoldenVectors: {
        path: 'projector-golden-vectors.json',
        sha256: sha256(vectorBytes),
      },
    },
  });
  return { schemaBytes, vectorBytes, manifestBytes };
}
