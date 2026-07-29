import { types as nodeTypes } from 'node:util';
import {
  CONTRACT_TO_DELIVERY_PROJECTOR_ID,
  CONTRACT_TO_DELIVERY_SCENARIO_ID,
  CONTRACT_TO_DELIVERY_SOURCE_LIMITS,
  CONTRACT_TO_DELIVERY_SOURCE_SCHEMA,
  type ContractToDeliveryAcceptanceObservation,
  type ContractToDeliveryBridgeRef,
  type ContractToDeliveryBusinessEvidence,
  type ContractToDeliveryBusinessSources,
  type ContractToDeliveryBusinessStatus,
  type ContractToDeliveryContractObservation,
  type ContractToDeliveryCustomerObservation,
  type ContractToDeliveryMilestoneObservation,
  type ContractToDeliveryOutcomeObservation,
  type ContractToDeliveryProjectObservation,
  type ContractToDeliverySourceBatch,
  type ContractToDeliverySourceSnapshot,
} from './contract-to-delivery-types.js';
import { GraphContractError } from './errors.js';
import { inertGraphJsonBytes } from './inert-json.js';
import {
  SOFTWARE_DELIVERY_PROJECTOR_ID,
  type SoftwareDeliverySourceSnapshot,
} from './software-delivery-types.js';
import { validateSoftwareDeliverySourceSnapshot } from './software-delivery-validation.js';
import {
  GRAPH_AUTHORITY_PROVIDERS,
  type AuthorityRef,
  type GraphAuthorityProvider,
} from './types.js';

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const ACTIVE_CONTENT = /(?:https?:\/\/|javascript:|data:text\/html|[<>])/i;
const SECRET_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:github_pat_|gh[opusr]_|sk-)[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{12,}|AWS_SECRET_ACCESS_KEY\s*=|OPENSLACK_[A-Z0-9_]*SECRET\s*=)/i;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const BUSINESS_STATUSES = Object.freeze([
  'active',
  'planned',
  'completed',
  'accepted',
  'realized',
  'pending',
] as const satisfies readonly ContractToDeliveryBusinessStatus[]);
const BUSINESS_SOURCE_NAMES = Object.freeze([
  'customers',
  'contracts',
  'projects',
  'milestones',
  'acceptances',
  'outcomes',
] as const satisfies readonly (keyof ContractToDeliveryBusinessSources)[]);
const COMMON_EVIDENCE_FIELDS = Object.freeze([
  'id',
  'title',
  'status',
  'authorityRef',
  'sourceEventIds',
  'evidenceRefs',
] as const);

function fail(
  code: ConstructorParameters<typeof GraphContractError>[0],
  path: string,
  message: string,
): never {
  throw new GraphContractError(code, path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return fail('GRAPH_SCHEMA_INVALID', path, 'must be an inert object.');
  }
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      fail('GRAPH_PROPERTY_UNSAFE', path, 'must not contain symbol or accessor properties.');
    }
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
): void {
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('GRAPH_SCHEMA_INVALID', `${path}.${key}`, 'is not an allowed property.');
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      fail('GRAPH_SCHEMA_INVALID', `${path}.${key}`, 'is required.');
    }
  }
}

function safeString(
  value: unknown,
  path: string,
  options: { identifier?: boolean; max?: number } = {},
): string {
  if (typeof value !== 'string' || value.length === 0) {
    return fail('GRAPH_SCHEMA_INVALID', path, 'must be a non-empty string.');
  }
  const max = options.max ?? CONTRACT_TO_DELIVERY_SOURCE_LIMITS.textBytes;
  if (Buffer.byteLength(value, 'utf8') > max) {
    fail('GRAPH_BOUND_EXCEEDED', path, `must be at most ${max} UTF-8 bytes.`);
  }
  if (
    CONTROL_CHARACTER.test(value) ||
    ACTIVE_CONTENT.test(value) ||
    SECRET_VALUE.test(value) ||
    (options.identifier && /\s/.test(value))
  ) {
    fail('GRAPH_PROPERTY_UNSAFE', path, 'contains unsafe content.');
  }
  return value;
}

function dateTime(value: unknown, path: string): string {
  const result = safeString(value, path, { identifier: true, max: 64 });
  const match = DATE_TIME.exec(result);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const hour = Number(match?.[4]);
  const minute = Number(match?.[5]);
  const second = Number(match?.[6]);
  const offsetHour = match?.[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match?.[9] === undefined ? 0 : Number(match[9]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    match === null ||
    month < 1 ||
    month > 12 ||
    days === undefined ||
    day < 1 ||
    day > days ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(result))
  ) {
    fail('GRAPH_SCHEMA_INVALID', path, 'must be a valid RFC 3339 date-time.');
  }
  return result;
}

function denseArray(value: unknown, path: string, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    nodeTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    fail('GRAPH_SCHEMA_INVALID', path, 'must be an inert array.');
  }
  if (value.length > max) {
    fail('GRAPH_BOUND_EXCEEDED', path, `must contain at most ${max} items.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail('GRAPH_PROPERTY_UNSAFE', `${path}[${index}]`, 'must be a dense data entry.');
    }
  }
  return value;
}

function references(value: unknown, path: string, minimum = 0): string[] {
  const result = denseArray(value, path, 50).map((item, index) =>
    safeString(item, `${path}[${index}]`, { identifier: true }),
  );
  if (result.length < minimum) {
    fail('GRAPH_SCHEMA_INVALID', path, `must contain at least ${minimum} item.`);
  }
  if (new Set(result).size !== result.length) {
    fail('GRAPH_REFERENCE_INVALID', path, 'contains duplicate references.');
  }
  return result;
}

function status(value: unknown, path: string): ContractToDeliveryBusinessStatus {
  if (typeof value !== 'string' || !BUSINESS_STATUSES.includes(value as never)) {
    fail('GRAPH_SCHEMA_INVALID', path, `must be one of ${BUSINESS_STATUSES.join(', ')}.`);
  }
  return value as ContractToDeliveryBusinessStatus;
}

function authorityRef(
  value: unknown,
  path: string,
  providers: readonly GraphAuthorityProvider[],
): AuthorityRef {
  const object = record(value, path);
  exactKeys(object, path, ['provider', 'objectType', 'objectId', 'version', 'observedAt']);
  const provider = safeString(object.provider, `${path}.provider`, {
    identifier: true,
    max: 64,
  });
  if (
    !GRAPH_AUTHORITY_PROVIDERS.includes(provider as GraphAuthorityProvider) ||
    !providers.includes(provider as GraphAuthorityProvider)
  ) {
    fail('GRAPH_SCHEMA_INVALID', `${path}.provider`, 'is not allowed for this authority.');
  }
  return {
    provider: provider as GraphAuthorityProvider,
    objectType: safeString(object.objectType, `${path}.objectType`, {
      identifier: true,
      max: 128,
    }),
    objectId: safeString(object.objectId, `${path}.objectId`, {
      identifier: true,
      max: 512,
    }),
    version: safeString(object.version, `${path}.version`, {
      identifier: true,
      max: 512,
    }),
    observedAt: dateTime(object.observedAt, `${path}.observedAt`),
  };
}

function bridge(
  value: unknown,
  path: string,
  expectedTargetType: string,
): ContractToDeliveryBridgeRef {
  const object = record(value, path);
  exactKeys(object, path, ['targetType', 'authorityRef']);
  const targetType = safeString(object.targetType, `${path}.targetType`, {
    identifier: true,
    max: 128,
  });
  if (targetType !== expectedTargetType) {
    fail('GRAPH_REFERENCE_INVALID', `${path}.targetType`, `must equal ${expectedTargetType}.`);
  }
  return {
    targetType,
    authorityRef: authorityRef(object.authorityRef, `${path}.authorityRef`, [
      'github',
      'openslack',
      'demo_fixture',
    ]),
  };
}

function evidence(
  value: unknown,
  path: string,
  objectType: string,
  extraFields: readonly string[],
): { object: Record<string, unknown>; evidence: ContractToDeliveryBusinessEvidence } {
  const object = record(value, path);
  exactKeys(object, path, [...COMMON_EVIDENCE_FIELDS, ...extraFields]);
  const id = safeString(object.id, `${path}.id`, { identifier: true, max: 512 });
  const authority = authorityRef(object.authorityRef, `${path}.authorityRef`, ['demo_fixture']);
  if (authority.objectType !== objectType || authority.objectId !== id) {
    fail(
      'GRAPH_REFERENCE_INVALID',
      `${path}.authorityRef`,
      `must bind ${objectType} authority to observation ${id}.`,
    );
  }
  return {
    object,
    evidence: {
      id,
      title: safeString(object.title, `${path}.title`),
      status: status(object.status, `${path}.status`),
      authorityRef: authority,
      sourceEventIds: references(object.sourceEventIds, `${path}.sourceEventIds`, 1),
      evidenceRefs: references(object.evidenceRefs, `${path}.evidenceRefs`, 1),
    },
  };
}

function customer(value: unknown, path: string): ContractToDeliveryCustomerObservation {
  return evidence(value, path, 'customer', []).evidence;
}

function contract(value: unknown, path: string): ContractToDeliveryContractObservation {
  const parsed = evidence(value, path, 'contract', ['customerId', 'deliverable']);
  return {
    ...parsed.evidence,
    customerId: safeString(parsed.object.customerId, `${path}.customerId`, {
      identifier: true,
      max: 512,
    }),
    deliverable: bridge(parsed.object.deliverable, `${path}.deliverable`, 'reviewable_deliverable'),
  };
}

function project(value: unknown, path: string): ContractToDeliveryProjectObservation {
  const parsed = evidence(value, path, 'project', ['contractId', 'workItem']);
  return {
    ...parsed.evidence,
    contractId: safeString(parsed.object.contractId, `${path}.contractId`, {
      identifier: true,
      max: 512,
    }),
    workItem: bridge(parsed.object.workItem, `${path}.workItem`, 'core.work_item'),
  };
}

function milestone(value: unknown, path: string): ContractToDeliveryMilestoneObservation {
  const parsed = evidence(value, path, 'milestone', ['projectId', 'workItem']);
  return {
    ...parsed.evidence,
    projectId: safeString(parsed.object.projectId, `${path}.projectId`, {
      identifier: true,
      max: 512,
    }),
    workItem: bridge(parsed.object.workItem, `${path}.workItem`, 'core.work_item'),
  };
}

function acceptance(value: unknown, path: string): ContractToDeliveryAcceptanceObservation {
  const parsed = evidence(value, path, 'acceptance', [
    'deliverable',
    'humanDecision',
    'acceptedTransition',
  ]);
  return {
    ...parsed.evidence,
    deliverable: bridge(parsed.object.deliverable, `${path}.deliverable`, 'reviewable_deliverable'),
    humanDecision: bridge(parsed.object.humanDecision, `${path}.humanDecision`, 'human_decision'),
    acceptedTransition: bridge(
      parsed.object.acceptedTransition,
      `${path}.acceptedTransition`,
      'accepted_transition',
    ),
  };
}

function outcome(value: unknown, path: string): ContractToDeliveryOutcomeObservation {
  const parsed = evidence(value, path, 'outcome', ['acceptanceId', 'workItem', 'softwareOutcome']);
  return {
    ...parsed.evidence,
    acceptanceId: safeString(parsed.object.acceptanceId, `${path}.acceptanceId`, {
      identifier: true,
      max: 512,
    }),
    workItem: bridge(parsed.object.workItem, `${path}.workItem`, 'core.work_item'),
    softwareOutcome: bridge(parsed.object.softwareOutcome, `${path}.softwareOutcome`, 'outcome'),
  };
}

function batch<T>(
  value: unknown,
  path: string,
  parse: (item: unknown, path: string) => T,
): ContractToDeliverySourceBatch<T> {
  const object = record(value, path);
  if (object.status === 'missing') {
    exactKeys(object, path, ['status', 'items', 'reasonCode']);
    if (denseArray(object.items, `${path}.items`, 0).length !== 0) {
      fail('GRAPH_SCHEMA_INVALID', `${path}.items`, 'must be empty when the source is missing.');
    }
    return {
      status: 'missing',
      items: [],
      reasonCode: safeString(object.reasonCode, `${path}.reasonCode`, {
        identifier: true,
        max: 256,
      }),
    };
  }
  if (object.status !== 'observed' && object.status !== 'incomplete') {
    fail('GRAPH_SCHEMA_INVALID', `${path}.status`, 'must be observed, incomplete, or missing.');
  }
  exactKeys(object, path, ['status', 'batchVersion', 'observedAt', 'items', 'warningCodes']);
  const items = denseArray(
    object.items,
    `${path}.items`,
    CONTRACT_TO_DELIVERY_SOURCE_LIMITS.observationsPerKind,
  ).map((item, index) => parse(item, `${path}.items[${index}]`));
  const ids = items.map((item) => (item as { id: string }).id);
  if (new Set(ids).size !== ids.length) {
    fail('GRAPH_REFERENCE_INVALID', `${path}.items`, 'contains duplicate observation IDs.');
  }
  return {
    status: object.status,
    batchVersion: safeString(object.batchVersion, `${path}.batchVersion`, {
      identifier: true,
      max: 512,
    }),
    observedAt: dateTime(object.observedAt, `${path}.observedAt`),
    items,
    warningCodes: references(object.warningCodes, `${path}.warningCodes`),
  };
}

function assertScope(
  source: {
    scenarioDefinitionId: string;
    scenarioInstanceId: string;
    cursor: string;
    generatedAt: string;
    projectorVersion: string;
  },
  softwareDelivery: SoftwareDeliverySourceSnapshot,
): void {
  if (source.scenarioDefinitionId !== CONTRACT_TO_DELIVERY_SCENARIO_ID) {
    fail(
      'GRAPH_SCOPE_INVALID',
      '$.scenarioDefinitionId',
      `must equal ${CONTRACT_TO_DELIVERY_SCENARIO_ID}.`,
    );
  }
  if (source.projectorVersion !== CONTRACT_TO_DELIVERY_PROJECTOR_ID) {
    fail(
      'GRAPH_SCHEMA_INVALID',
      '$.projectorVersion',
      `must equal ${CONTRACT_TO_DELIVERY_PROJECTOR_ID}.`,
    );
  }
  if (
    softwareDelivery.scenarioDefinitionId !== source.scenarioDefinitionId ||
    softwareDelivery.scenarioInstanceId !== source.scenarioInstanceId ||
    softwareDelivery.cursor !== source.cursor ||
    softwareDelivery.generatedAt !== source.generatedAt
  ) {
    fail(
      'GRAPH_SCOPE_INVALID',
      '$.softwareDelivery',
      'must share the outer scenario definition, instance, cursor, and generated time.',
    );
  }
  // Each layer carries its own sealed projector ID. Alignment means exact scope and exact
  // registered versions, not equality between two intentionally different projector IDs.
  if (softwareDelivery.projectorVersion !== SOFTWARE_DELIVERY_PROJECTOR_ID) {
    fail(
      'GRAPH_SCHEMA_INVALID',
      '$.softwareDelivery.projectorVersion',
      `must equal ${SOFTWARE_DELIVERY_PROJECTOR_ID}.`,
    );
  }
}

export function validateContractToDeliverySourceSnapshot(
  value: unknown,
): ContractToDeliverySourceSnapshot {
  const bytes = inertGraphJsonBytes(value, CONTRACT_TO_DELIVERY_SOURCE_LIMITS);
  if (bytes > CONTRACT_TO_DELIVERY_SOURCE_LIMITS.sourceBytes) {
    fail(
      'GRAPH_BOUND_EXCEEDED',
      '$',
      `contains ${bytes} bytes; maximum is ${CONTRACT_TO_DELIVERY_SOURCE_LIMITS.sourceBytes}.`,
    );
  }
  const object = record(value, '$');
  exactKeys(object, '$', [
    'schema',
    'scenarioDefinitionId',
    'scenarioInstanceId',
    'cursor',
    'generatedAt',
    'projectorVersion',
    'softwareDelivery',
    'business',
  ]);
  if (object.schema !== CONTRACT_TO_DELIVERY_SOURCE_SCHEMA) {
    fail('GRAPH_SCHEMA_INVALID', '$.schema', `must equal ${CONTRACT_TO_DELIVERY_SOURCE_SCHEMA}.`);
  }
  const sourceScope = {
    scenarioDefinitionId: safeString(object.scenarioDefinitionId, '$.scenarioDefinitionId', {
      identifier: true,
      max: 128,
    }),
    scenarioInstanceId: safeString(object.scenarioInstanceId, '$.scenarioInstanceId', {
      identifier: true,
      max: 512,
    }),
    cursor: safeString(object.cursor, '$.cursor', { identifier: true, max: 512 }),
    generatedAt: dateTime(object.generatedAt, '$.generatedAt'),
    projectorVersion: safeString(object.projectorVersion, '$.projectorVersion', {
      identifier: true,
      max: 128,
    }),
  };
  const softwareDelivery = validateSoftwareDeliverySourceSnapshot(object.softwareDelivery);
  assertScope(sourceScope, softwareDelivery);

  const businessObject = record(object.business, '$.business');
  exactKeys(businessObject, '$.business', BUSINESS_SOURCE_NAMES);
  const business: ContractToDeliveryBusinessSources = {
    customers: batch(businessObject.customers, '$.business.customers', customer),
    contracts: batch(businessObject.contracts, '$.business.contracts', contract),
    projects: batch(businessObject.projects, '$.business.projects', project),
    milestones: batch(businessObject.milestones, '$.business.milestones', milestone),
    acceptances: batch(businessObject.acceptances, '$.business.acceptances', acceptance),
    outcomes: batch(businessObject.outcomes, '$.business.outcomes', outcome),
  };
  const observations = BUSINESS_SOURCE_NAMES.flatMap((name) => business[name].items);
  if (observations.length > CONTRACT_TO_DELIVERY_SOURCE_LIMITS.totalObservations) {
    fail(
      'GRAPH_BOUND_EXCEEDED',
      '$.business',
      `contains ${observations.length} observations; maximum is ${CONTRACT_TO_DELIVERY_SOURCE_LIMITS.totalObservations}.`,
    );
  }
  const ids = observations.map((item) => item.id);
  if (new Set(ids).size !== ids.length) {
    fail('GRAPH_REFERENCE_INVALID', '$.business', 'contains duplicate observation IDs.');
  }
  const authorityIdentities = observations.map(
    (item) =>
      `${item.authorityRef.provider}:${item.authorityRef.objectType}:${item.authorityRef.objectId}`,
  );
  if (new Set(authorityIdentities).size !== authorityIdentities.length) {
    fail('GRAPH_REFERENCE_INVALID', '$.business', 'contains duplicate authority identities.');
  }
  const relations =
    business.contracts.items.length * 2 +
    business.projects.items.length * 2 +
    business.milestones.items.length * 2 +
    business.acceptances.items.length * 3 +
    business.outcomes.items.length * 3;
  if (relations > CONTRACT_TO_DELIVERY_SOURCE_LIMITS.totalRelations) {
    fail(
      'GRAPH_BOUND_EXCEEDED',
      '$.business',
      `contains ${relations} relationship references; maximum is ${CONTRACT_TO_DELIVERY_SOURCE_LIMITS.totalRelations}.`,
    );
  }
  for (const [index, item] of observations.entries()) {
    if (Date.parse(item.authorityRef.observedAt) > Date.parse(sourceScope.generatedAt)) {
      fail(
        'GRAPH_SCHEMA_INVALID',
        `$.business.observations[${index}].authorityRef.observedAt`,
        'must not be later than the source generated time.',
      );
    }
  }

  return {
    schema: CONTRACT_TO_DELIVERY_SOURCE_SCHEMA,
    scenarioDefinitionId: CONTRACT_TO_DELIVERY_SCENARIO_ID,
    scenarioInstanceId: sourceScope.scenarioInstanceId,
    cursor: sourceScope.cursor,
    generatedAt: sourceScope.generatedAt,
    projectorVersion: CONTRACT_TO_DELIVERY_PROJECTOR_ID,
    softwareDelivery,
    business,
  };
}
