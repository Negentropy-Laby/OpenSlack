import { GraphContractError } from './errors.js';
import { deriveGraphEdgeId, deriveGraphNodeId } from './identity.js';
import {
  GRAPH_AUTHORITY_PROVIDERS,
  GRAPH_DELTA_SCHEMA,
  GRAPH_HARD_LIMITS,
  GRAPH_SNAPSHOT_SCHEMA,
  GRAPH_VALUE_LIMITS,
} from './types.js';
import type {
  ActorRef,
  AuthorityRef,
  GraphCompleteness,
  GraphDelta,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
} from './types.js';

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const INTEGRITY_HASH = /^sha256:[0-9a-f]{64}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const URL_OR_ACTIVE_CONTENT =
  /(?:https?:\/\/|javascript:|data:text\/html|<\s*script\b|<\s*iframe\b)/i;
const SECRET_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:github_pat_|gh[opusr]_|sk-)[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{12,}|AWS_SECRET_ACCESS_KEY\s*=|OPENSLACK_[A-Z0-9_]*SECRET\s*=)/i;
const SECRET_KEY =
  /(?:^|[_-])(?:password|passwd|secret|token|credential|private[_-]?key|api[_-]?key|authorization|cookie)(?:$|[_-])/i;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(
  code: ConstructorParameters<typeof GraphContractError>[0],
  path: string,
  message: string,
): never {
  throw new GraphContractError(code, path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('GRAPH_SCHEMA_INVALID', path, 'must be an object.');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value).sort()) {
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

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function string(
  value: unknown,
  path: string,
  options: { max?: number; identifier?: boolean; allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    return fail('GRAPH_SCHEMA_INVALID', path, 'must be a string.');
  }
  const max = options.max ?? GRAPH_VALUE_LIMITS.boundedStringCharacters;
  if ((!options.allowEmpty && value.length === 0) || value.length > max) {
    fail('GRAPH_BOUND_EXCEEDED', path, `must contain between 1 and ${max} characters.`);
  }
  if (CONTROL_CHARACTER.test(value) || hasUnpairedSurrogate(value)) {
    fail('GRAPH_SCHEMA_INVALID', path, 'contains an unsafe control or Unicode character.');
  }
  if (options.identifier && URL_OR_ACTIVE_CONTENT.test(value)) {
    fail('GRAPH_REFERENCE_INVALID', path, 'must be a bounded identifier, not active content.');
  }
  return value;
}

function dateTime(value: unknown, path: string): string {
  const result = string(value, path, { max: GRAPH_VALUE_LIMITS.dateTimeCharacters });
  const match = DATE_TIME.exec(result);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  const hour = Number(match?.[4]);
  const minute = Number(match?.[5]);
  const second = Number(match?.[6]);
  const offsetHour = match?.[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match?.[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (
    !match ||
    month < 1 ||
    month > 12 ||
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(result))
  ) {
    fail('GRAPH_SCHEMA_INVALID', path, 'must be an RFC 3339 date-time with an explicit zone.');
  }
  return result;
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail('GRAPH_SCHEMA_INVALID', path, 'must be an array.');
  if (value.length > max) {
    fail('GRAPH_BOUND_EXCEEDED', path, `must contain at most ${max} items.`);
  }
  return value;
}

function stringRefs(value: unknown, path: string, max: number): string[] {
  return array(value, path, max).map((item, index) => {
    const reference = string(item, `${path}[${index}]`, {
      max: GRAPH_VALUE_LIMITS.boundedStringCharacters,
      identifier: true,
    });
    if (SECRET_VALUE.test(reference)) {
      fail('GRAPH_PROPERTY_UNSAFE', `${path}[${index}]`, 'must not contain credential material.');
    }
    return reference;
  });
}

function authority(value: unknown, path: string): AuthorityRef {
  const object = record(value, path);
  exactKeys(object, path, ['provider', 'objectType', 'objectId', 'version', 'observedAt']);
  if (
    typeof object.provider !== 'string' ||
    !GRAPH_AUTHORITY_PROVIDERS.includes(
      object.provider as (typeof GRAPH_AUTHORITY_PROVIDERS)[number],
    )
  ) {
    fail('GRAPH_SCHEMA_INVALID', `${path}.provider`, 'is not a recognized authority provider.');
  }
  const result: AuthorityRef = {
    provider: object.provider as AuthorityRef['provider'],
    objectType: string(object.objectType, `${path}.objectType`, {
      max: GRAPH_VALUE_LIMITS.authorityObjectTypeCharacters,
      identifier: true,
    }),
    objectId: string(object.objectId, `${path}.objectId`, {
      max: GRAPH_VALUE_LIMITS.boundedStringCharacters,
      identifier: true,
    }),
    version: string(object.version, `${path}.version`, {
      max: GRAPH_VALUE_LIMITS.boundedStringCharacters,
      identifier: true,
    }),
    observedAt: dateTime(object.observedAt, `${path}.observedAt`),
  };
  for (const [key, candidate] of Object.entries(result)) {
    if (typeof candidate === 'string' && SECRET_VALUE.test(candidate)) {
      fail('GRAPH_PROPERTY_UNSAFE', `${path}.${key}`, 'must not contain credential material.');
    }
  }
  return result;
}

function actor(value: unknown, path: string): ActorRef {
  const object = record(value, path);
  exactKeys(object, path, ['id', 'kind'], ['displayName']);
  if (object.kind !== 'human' && object.kind !== 'agent' && object.kind !== 'system') {
    fail('GRAPH_SCHEMA_INVALID', `${path}.kind`, 'must be human, agent, or system.');
  }
  return {
    id: string(object.id, `${path}.id`, {
      max: GRAPH_VALUE_LIMITS.identifierCharacters,
      identifier: true,
    }),
    kind: object.kind,
    ...(object.displayName === undefined
      ? {}
      : { displayName: string(object.displayName, `${path}.displayName`) }),
  };
}

function propertyValue(value: unknown, path: string, depth: number): void {
  if (depth > GRAPH_HARD_LIMITS.propertyDepth) {
    fail(
      'GRAPH_BOUND_EXCEEDED',
      path,
      `property nesting exceeds depth ${GRAPH_HARD_LIMITS.propertyDepth}.`,
    );
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      fail('GRAPH_SCHEMA_INVALID', path, 'property numbers must be finite.');
    }
    return;
  }
  if (typeof value === 'string') {
    string(value, path, {
      max: GRAPH_VALUE_LIMITS.propertyStringCharacters,
      allowEmpty: true,
    });
    if (SECRET_VALUE.test(value) || URL_OR_ACTIVE_CONTENT.test(value)) {
      fail(
        'GRAPH_PROPERTY_UNSAFE',
        path,
        'properties must not contain credentials, URLs, or active content.',
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > GRAPH_HARD_LIMITS.propertyItems) {
      fail(
        'GRAPH_BOUND_EXCEEDED',
        path,
        `property arrays contain at most ${GRAPH_HARD_LIMITS.propertyItems} items.`,
      );
    }
    value.forEach((item, index) => propertyValue(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    if (keys.length > GRAPH_HARD_LIMITS.propertyKeys) {
      fail(
        'GRAPH_BOUND_EXCEEDED',
        path,
        `property objects contain at most ${GRAPH_HARD_LIMITS.propertyKeys} keys.`,
      );
    }
    for (const key of keys) {
      if (FORBIDDEN_OBJECT_KEYS.has(key) || SECRET_KEY.test(key)) {
        fail('GRAPH_PROPERTY_UNSAFE', `${path}.${key}`, 'property key is not permitted.');
      }
      string(key, `${path}.${key}`, {
        max: GRAPH_VALUE_LIMITS.authorityObjectTypeCharacters,
      });
      propertyValue(object[key], `${path}.${key}`, depth + 1);
    }
    return;
  }
  fail('GRAPH_SCHEMA_INVALID', path, 'properties must contain only JSON values.');
}

function node(value: unknown, path: string, scenarioInstanceId: string): GraphNode {
  const object = record(value, path);
  exactKeys(
    object,
    path,
    [
      'id',
      'type',
      'scenarioDefinitionId',
      'scenarioInstanceId',
      'title',
      'authorityRef',
      'owners',
      'properties',
      'sourceEventIds',
      'evidenceRefs',
      'projectorVersion',
      'validFrom',
    ],
    ['status', 'validTo'],
  );
  const scope = string(object.scenarioInstanceId, `${path}.scenarioInstanceId`, {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  if (scope !== scenarioInstanceId) {
    fail('GRAPH_SCOPE_INVALID', `${path}.scenarioInstanceId`, 'does not match graph scope.');
  }
  const validFrom = dateTime(object.validFrom, `${path}.validFrom`);
  const validTo =
    object.validTo === undefined ? undefined : dateTime(object.validTo, `${path}.validTo`);
  if (validTo !== undefined && Date.parse(validTo) < Date.parse(validFrom)) {
    fail('GRAPH_SCHEMA_INVALID', `${path}.validTo`, 'must not precede validFrom.');
  }
  const owners = array(object.owners, `${path}.owners`, GRAPH_HARD_LIMITS.owners).map(
    (item, index) => actor(item, `${path}.owners[${index}]`),
  );
  const properties = record(object.properties, `${path}.properties`);
  propertyValue(properties, `${path}.properties`, 1);
  const id = string(object.id, `${path}.id`, {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  const type = string(object.type, `${path}.type`, {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  const authorityRef = authority(object.authorityRef, `${path}.authorityRef`);
  const projectorVersion = string(object.projectorVersion, `${path}.projectorVersion`, {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  if (SECRET_VALUE.test(projectorVersion)) {
    fail(
      'GRAPH_PROPERTY_UNSAFE',
      `${path}.projectorVersion`,
      'must not contain credential material.',
    );
  }
  const expectedId = deriveGraphNodeId({ scenarioInstanceId: scope, type, authorityRef });
  if (id !== expectedId) {
    fail(
      'GRAPH_REFERENCE_INVALID',
      `${path}.id`,
      `must equal the derived stable ID ${expectedId}.`,
    );
  }
  return {
    id,
    type,
    scenarioDefinitionId: string(object.scenarioDefinitionId, `${path}.scenarioDefinitionId`, {
      max: GRAPH_VALUE_LIMITS.identifierCharacters,
      identifier: true,
    }),
    scenarioInstanceId: scope,
    title: string(object.title, `${path}.title`),
    ...(object.status === undefined
      ? {}
      : {
          status: string(object.status, `${path}.status`, {
            max: GRAPH_VALUE_LIMITS.identifierCharacters,
          }),
        }),
    authorityRef,
    owners,
    properties,
    sourceEventIds: stringRefs(
      object.sourceEventIds,
      `${path}.sourceEventIds`,
      GRAPH_HARD_LIMITS.sourceEventIds,
    ),
    evidenceRefs: stringRefs(
      object.evidenceRefs,
      `${path}.evidenceRefs`,
      GRAPH_HARD_LIMITS.evidenceRefs,
    ),
    projectorVersion,
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
  };
}

function edge(value: unknown, path: string, scenarioInstanceId: string): GraphEdge {
  const object = record(value, path);
  exactKeys(
    object,
    path,
    [
      'id',
      'type',
      'from',
      'to',
      'scenarioInstanceId',
      'sourceEventIds',
      'evidenceRefs',
      'projectorVersion',
      'validFrom',
    ],
    ['authorityRef', 'validTo'],
  );
  const scope = string(object.scenarioInstanceId, `${path}.scenarioInstanceId`, {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  if (scope !== scenarioInstanceId) {
    fail('GRAPH_SCOPE_INVALID', `${path}.scenarioInstanceId`, 'does not match graph scope.');
  }
  const validFrom = dateTime(object.validFrom, `${path}.validFrom`);
  const validTo =
    object.validTo === undefined ? undefined : dateTime(object.validTo, `${path}.validTo`);
  if (validTo !== undefined && Date.parse(validTo) < Date.parse(validFrom)) {
    fail('GRAPH_SCHEMA_INVALID', `${path}.validTo`, 'must not precede validFrom.');
  }
  const id = string(object.id, `${path}.id`, {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  const type = string(object.type, `${path}.type`, {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  const from = string(object.from, `${path}.from`, {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  const to = string(object.to, `${path}.to`, {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  const authorityRef =
    object.authorityRef === undefined
      ? undefined
      : authority(object.authorityRef, `${path}.authorityRef`);
  const projectorVersion = string(object.projectorVersion, `${path}.projectorVersion`, {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  if (SECRET_VALUE.test(projectorVersion)) {
    fail(
      'GRAPH_PROPERTY_UNSAFE',
      `${path}.projectorVersion`,
      'must not contain credential material.',
    );
  }
  const expectedId = deriveGraphEdgeId({
    scenarioInstanceId: scope,
    type,
    from,
    to,
    ...(authorityRef === undefined ? {} : { authorityRef }),
  });
  if (id !== expectedId) {
    fail(
      'GRAPH_REFERENCE_INVALID',
      `${path}.id`,
      `must equal the derived stable ID ${expectedId}.`,
    );
  }
  return {
    id,
    type,
    from,
    to,
    scenarioInstanceId: scope,
    ...(authorityRef === undefined ? {} : { authorityRef }),
    sourceEventIds: stringRefs(
      object.sourceEventIds,
      `${path}.sourceEventIds`,
      GRAPH_HARD_LIMITS.sourceEventIds,
    ),
    evidenceRefs: stringRefs(
      object.evidenceRefs,
      `${path}.evidenceRefs`,
      GRAPH_HARD_LIMITS.evidenceRefs,
    ),
    projectorVersion,
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
  };
}

function completeness(value: unknown, path: string): GraphCompleteness {
  const object = record(value, path);
  exactKeys(object, path, ['sourcesRequested', 'sourcesObserved', 'missingSources', 'warnings']);
  return {
    sourcesRequested: stringRefs(
      object.sourcesRequested,
      `${path}.sourcesRequested`,
      GRAPH_VALUE_LIMITS.completenessItems,
    ),
    sourcesObserved: stringRefs(
      object.sourcesObserved,
      `${path}.sourcesObserved`,
      GRAPH_VALUE_LIMITS.completenessItems,
    ),
    missingSources: stringRefs(
      object.missingSources,
      `${path}.missingSources`,
      GRAPH_VALUE_LIMITS.completenessItems,
    ),
    warnings: stringRefs(object.warnings, `${path}.warnings`, GRAPH_VALUE_LIMITS.completenessItems),
  };
}

function assertUnique(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) fail('GRAPH_REFERENCE_INVALID', path, `contains duplicate ID ${value}.`);
    seen.add(value);
  }
}

function integrity(value: unknown, path: string): string {
  if (typeof value !== 'string' || !INTEGRITY_HASH.test(value)) {
    fail('GRAPH_SCHEMA_INVALID', path, 'must be sha256 followed by 64 lowercase hex digits.');
  }
  return value;
}

export function validateGraphSnapshot(value: unknown): GraphSnapshot {
  const object = record(value, '$');
  exactKeys(object, '$', [
    'schema',
    'cursor',
    'scenarioInstanceId',
    'generatedAt',
    'projectorVersion',
    'nodes',
    'edges',
    'completeness',
    'integrityHash',
  ]);
  if (object.schema !== GRAPH_SNAPSHOT_SCHEMA) {
    fail('GRAPH_SCHEMA_INVALID', '$.schema', `must equal ${GRAPH_SNAPSHOT_SCHEMA}.`);
  }
  const scenarioInstanceId = string(object.scenarioInstanceId, '$.scenarioInstanceId', {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  const nodes = array(object.nodes, '$.nodes', GRAPH_HARD_LIMITS.snapshotNodes).map((item, index) =>
    node(item, `$.nodes[${index}]`, scenarioInstanceId),
  );
  const edges = array(object.edges, '$.edges', GRAPH_HARD_LIMITS.snapshotEdges).map((item, index) =>
    edge(item, `$.edges[${index}]`, scenarioInstanceId),
  );
  assertUnique(
    nodes.map((item) => item.id),
    '$.nodes',
  );
  assertUnique(
    edges.map((item) => item.id),
    '$.edges',
  );
  const nodeIds = new Set(nodes.map((item) => item.id));
  edges.forEach((item, index) => {
    if (!nodeIds.has(item.from)) {
      fail('GRAPH_REFERENCE_INVALID', `$.edges[${index}].from`, 'does not identify a graph node.');
    }
    if (!nodeIds.has(item.to)) {
      fail('GRAPH_REFERENCE_INVALID', `$.edges[${index}].to`, 'does not identify a graph node.');
    }
  });
  return {
    schema: GRAPH_SNAPSHOT_SCHEMA,
    cursor: string(object.cursor, '$.cursor', {
      max: GRAPH_VALUE_LIMITS.identifierCharacters,
      identifier: true,
    }),
    scenarioInstanceId,
    generatedAt: dateTime(object.generatedAt, '$.generatedAt'),
    projectorVersion: string(object.projectorVersion, '$.projectorVersion', {
      max: GRAPH_VALUE_LIMITS.identifierCharacters,
      identifier: true,
    }),
    nodes,
    edges,
    completeness: completeness(object.completeness, '$.completeness'),
    integrityHash: integrity(object.integrityHash, '$.integrityHash'),
  };
}

export function validateGraphDelta(value: unknown): GraphDelta {
  const object = record(value, '$');
  exactKeys(object, '$', [
    'schema',
    'scenarioInstanceId',
    'fromCursor',
    'toCursor',
    'generatedAt',
    'upsertNodes',
    'closeNodeIds',
    'upsertEdges',
    'closeEdgeIds',
    'evidenceRefs',
    'integrityHash',
  ]);
  if (object.schema !== GRAPH_DELTA_SCHEMA) {
    fail('GRAPH_SCHEMA_INVALID', '$.schema', `must equal ${GRAPH_DELTA_SCHEMA}.`);
  }
  const scenarioInstanceId = string(object.scenarioInstanceId, '$.scenarioInstanceId', {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  const fromCursor = string(object.fromCursor, '$.fromCursor', {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  const toCursor = string(object.toCursor, '$.toCursor', {
    max: GRAPH_VALUE_LIMITS.identifierCharacters,
    identifier: true,
  });
  if (fromCursor === toCursor) {
    fail('GRAPH_REFERENCE_INVALID', '$.toCursor', 'must differ from fromCursor.');
  }
  const upsertNodes = array(
    object.upsertNodes,
    '$.upsertNodes',
    GRAPH_HARD_LIMITS.snapshotNodes,
  ).map((item, index) => node(item, `$.upsertNodes[${index}]`, scenarioInstanceId));
  const upsertEdges = array(
    object.upsertEdges,
    '$.upsertEdges',
    GRAPH_HARD_LIMITS.snapshotEdges,
  ).map((item, index) => edge(item, `$.upsertEdges[${index}]`, scenarioInstanceId));
  const closeNodeIds = stringRefs(
    object.closeNodeIds,
    '$.closeNodeIds',
    GRAPH_HARD_LIMITS.snapshotNodes,
  );
  const closeEdgeIds = stringRefs(
    object.closeEdgeIds,
    '$.closeEdgeIds',
    GRAPH_HARD_LIMITS.snapshotEdges,
  );
  assertUnique(
    upsertNodes.map((item) => item.id),
    '$.upsertNodes',
  );
  assertUnique(
    upsertEdges.map((item) => item.id),
    '$.upsertEdges',
  );
  assertUnique(closeNodeIds, '$.closeNodeIds');
  assertUnique(closeEdgeIds, '$.closeEdgeIds');
  const upsertNodeIds = new Set(upsertNodes.map((item) => item.id));
  closeNodeIds.forEach((id, index) => {
    if (upsertNodeIds.has(id)) {
      fail(
        'GRAPH_REFERENCE_INVALID',
        `$.closeNodeIds[${index}]`,
        'cannot close and upsert the same node.',
      );
    }
  });
  const upsertEdgeIds = new Set(upsertEdges.map((item) => item.id));
  closeEdgeIds.forEach((id, index) => {
    if (upsertEdgeIds.has(id)) {
      fail(
        'GRAPH_REFERENCE_INVALID',
        `$.closeEdgeIds[${index}]`,
        'cannot close and upsert the same edge.',
      );
    }
  });
  return {
    schema: GRAPH_DELTA_SCHEMA,
    scenarioInstanceId,
    fromCursor,
    toCursor,
    generatedAt: dateTime(object.generatedAt, '$.generatedAt'),
    upsertNodes,
    closeNodeIds,
    upsertEdges,
    closeEdgeIds,
    evidenceRefs: stringRefs(
      object.evidenceRefs,
      '$.evidenceRefs',
      GRAPH_HARD_LIMITS.deltaEvidenceRefs,
    ),
    integrityHash: integrity(object.integrityHash, '$.integrityHash'),
  };
}
