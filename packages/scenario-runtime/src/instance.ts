import { createHash } from 'node:crypto';
import { canonicalJson, type AuthorityRef } from '@openslack/organization-graph';

export const SCENARIO_INSTANCE_SCHEMA = 'openslack.scenario_instance.v1' as const;
export const SCENARIO_INSTANCE_STATES = Object.freeze([
  'previewed',
  'instantiating',
  'active',
  'blocked',
  'completed',
  'failed',
  'cancelled',
] as const);
export type ScenarioInstanceState = (typeof SCENARIO_INSTANCE_STATES)[number];

export interface ScenarioInstance {
  readonly schema: typeof SCENARIO_INSTANCE_SCHEMA;
  readonly id: string;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly definitionHash: string;
  readonly correlationId: string;
  readonly state: ScenarioInstanceState;
  readonly targetRefs: readonly AuthorityRef[];
  readonly workflowRunIds: readonly string[];
  readonly planId: string;
  readonly planHash: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly evidenceRefs: readonly string[];
}

const TRUSTED_SCENARIO_INSTANCES = new WeakSet<object>();

export class ScenarioInstanceError extends Error {
  readonly code:
    | 'SCENARIO_INSTANCE_INVALID'
    | 'SCENARIO_INSTANCE_TRANSITION_DENIED'
    | 'SCENARIO_INSTANCE_SCOPE_MISMATCH';

  constructor(code: ScenarioInstanceError['code'], message: string) {
    super(message);
    this.name = 'ScenarioInstanceError';
    this.code = code;
  }
}

const SAFE_IDENTIFIER = /^[^\u0000-\u001f\u007f/\\]+$/;
const DEFINITION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HASH = /^[0-9a-f]{64}$/;
const OBJECT_TYPE = /^[a-z][A-Za-z0-9_.-]*$/;
const PROVIDERS = new Set(['github', 'openslack', 'demo_fixture', 'dingtalk', 'crm', 'erp', 'hr']);
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const URL_OR_ACTIVE_CONTENT =
  /(?:https?:\/\/|javascript:|data:text\/html|<\s*script\b|<\s*iframe\b)/i;
const SECRET =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:github_pat_|gh[opusr]_|sk-)[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{12,}|AWS_SECRET_ACCESS_KEY\s*=|OPENSLACK_[A-Z0-9_]*SECRET\s*=)/i;

type DataRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new ScenarioInstanceError('SCENARIO_INSTANCE_INVALID', message);
}

function asDataRecord(value: unknown, fields: readonly string[], label: string): DataRecord {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return invalid(`${label} must be a plain data object.`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) {
    return invalid(`${label} has missing or unknown fields.`);
  }
  for (const key of keys) {
    if (typeof key !== 'string') return invalid(`${label} has symbol fields.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return invalid(`${label} has accessor fields.`);
    }
  }
  return value as DataRecord;
}

function data(record: DataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function text(
  value: unknown,
  label: string,
  max: number,
  pattern?: RegExp,
  allowSecret = false,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > max ||
    (pattern !== undefined && !pattern.test(value)) ||
    (!allowSecret && SECRET.test(value))
  ) {
    return invalid(`${label} is invalid.`);
  }
  return value;
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

function authorityReference(value: unknown, label: string, max: number): string {
  const result = text(value, label, max);
  if (
    CONTROL_CHARACTER.test(result) ||
    hasUnpairedSurrogate(result) ||
    URL_OR_ACTIVE_CONTENT.test(result)
  ) {
    return invalid(`${label} contains unsafe reference content.`);
  }
  return result;
}

function date(value: unknown, label: string): string {
  const result = text(value, label, 64);
  const millis = Date.parse(result);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== result) {
    return invalid(`${label} must be a canonical RFC3339 timestamp.`);
  }
  return result;
}

function denseArray(value: unknown, label: string, max: number): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max
  ) {
    return invalid(`${label} must be a bounded dense array.`);
  }
  const expected = new Set(['length']);
  for (let index = 0; index < value.length; index += 1) {
    expected.add(String(index));
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return invalid(`${label} must contain only data values.`);
    }
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !expected.has(key))) {
    return invalid(`${label} contains named or symbol fields.`);
  }
  return value;
}

function authorityRef(value: unknown, index: number): AuthorityRef {
  const record = asDataRecord(
    value,
    ['provider', 'objectType', 'objectId', 'version', 'observedAt'],
    `targetRefs/${index}`,
  );
  const provider = text(data(record, 'provider'), 'target provider', 32);
  if (!PROVIDERS.has(provider)) return invalid('Target authority provider is invalid.');
  return Object.freeze({
    provider: provider as AuthorityRef['provider'],
    objectType: text(data(record, 'objectType'), 'target objectType', 128, OBJECT_TYPE),
    objectId: authorityReference(data(record, 'objectId'), 'target objectId', 512),
    version: authorityReference(data(record, 'version'), 'target version', 512),
    observedAt: date(data(record, 'observedAt'), 'target observedAt'),
  });
}

function stringList(
  value: unknown,
  label: string,
  maxItems: number,
  maxBytes: number,
  pattern?: RegExp,
): readonly string[] {
  const result = denseArray(value, label, maxItems).map((item, index) =>
    text(item, `${label}/${index}`, maxBytes, pattern),
  );
  if (new Set(result).size !== result.length) return invalid(`${label} contains duplicates.`);
  return Object.freeze(result);
}

function cloneInstance(value: unknown): ScenarioInstance {
  const record = asDataRecord(
    value,
    [
      'schema',
      'id',
      'definitionId',
      'definitionVersion',
      'definitionHash',
      'correlationId',
      'state',
      'targetRefs',
      'workflowRunIds',
      'planId',
      'planHash',
      'createdAt',
      'updatedAt',
      'evidenceRefs',
    ],
    'scenario instance',
  );
  if (data(record, 'schema') !== SCENARIO_INSTANCE_SCHEMA) {
    return invalid('Scenario instance schema is unsupported.');
  }
  const state = data(record, 'state');
  if (
    typeof state !== 'string' ||
    !SCENARIO_INSTANCE_STATES.includes(state as ScenarioInstanceState)
  ) {
    return invalid('Scenario instance state is invalid.');
  }
  const targets = denseArray(data(record, 'targetRefs'), 'targetRefs', 50).map(authorityRef);
  const targetKeys = targets.map((target) => canonicalJson(target));
  if (new Set(targetKeys).size !== targetKeys.length)
    return invalid('targetRefs contains duplicates.');
  const createdAt = date(data(record, 'createdAt'), 'createdAt');
  const updatedAt = date(data(record, 'updatedAt'), 'updatedAt');
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    return invalid('updatedAt cannot precede createdAt.');
  }
  return Object.freeze({
    schema: SCENARIO_INSTANCE_SCHEMA,
    id: text(data(record, 'id'), 'id', 512, SAFE_IDENTIFIER),
    definitionId: text(data(record, 'definitionId'), 'definitionId', 64, DEFINITION_ID),
    definitionVersion: text(data(record, 'definitionVersion'), 'definitionVersion', 128),
    definitionHash: text(data(record, 'definitionHash'), 'definitionHash', 64, HASH),
    correlationId: text(data(record, 'correlationId'), 'correlationId', 512, SAFE_IDENTIFIER),
    state: state as ScenarioInstanceState,
    targetRefs: Object.freeze(targets),
    workflowRunIds: stringList(
      data(record, 'workflowRunIds'),
      'workflowRunIds',
      100,
      512,
      SAFE_IDENTIFIER,
    ),
    planId: text(data(record, 'planId'), 'planId', 512, SAFE_IDENTIFIER),
    planHash: text(data(record, 'planHash'), 'planHash', 64, HASH),
    createdAt,
    updatedAt,
    evidenceRefs: stringList(data(record, 'evidenceRefs'), 'evidenceRefs', 100, 2_048),
  });
}

export function validateScenarioInstance(value: unknown): ScenarioInstance {
  return cloneInstance(value);
}

/** @internal package-only nominal brand; intentionally absent from the package root. */
export function trustValidatedScenarioInstance(instance: ScenarioInstance): ScenarioInstance {
  TRUSTED_SCENARIO_INSTANCES.add(instance);
  return instance;
}

/** @internal package-only nominal query; intentionally absent from the package root. */
export function isTrustedScenarioInstance(value: unknown): value is ScenarioInstance {
  return typeof value === 'object' && value !== null && TRUSTED_SCENARIO_INSTANCES.has(value);
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<ScenarioInstanceState, readonly ScenarioInstanceState[]>
> = Object.freeze({
  previewed: Object.freeze(['instantiating', 'cancelled'] as const),
  instantiating: Object.freeze(['active', 'blocked', 'failed', 'cancelled'] as const),
  active: Object.freeze(['blocked', 'completed', 'failed', 'cancelled'] as const),
  blocked: Object.freeze(['active', 'failed', 'cancelled'] as const),
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export function transitionScenarioInstance(
  instanceValue: ScenarioInstance,
  input: {
    readonly state: ScenarioInstanceState;
    readonly updatedAt: string;
    readonly workflowRunIds?: readonly string[];
    readonly evidenceRefs: readonly string[];
  },
): ScenarioInstance {
  if (!isTrustedScenarioInstance(instanceValue)) {
    return invalid('Scenario instance must come from a trusted planner, store, or transition.');
  }
  const instance = validateScenarioInstance(instanceValue);
  if (!ALLOWED_TRANSITIONS[instance.state].includes(input.state)) {
    throw new ScenarioInstanceError(
      'SCENARIO_INSTANCE_TRANSITION_DENIED',
      `Scenario instance cannot transition from ${instance.state} to ${input.state}.`,
    );
  }
  return trustValidatedScenarioInstance(
    validateScenarioInstance({
      ...instance,
      state: input.state,
      updatedAt: input.updatedAt,
      workflowRunIds: input.workflowRunIds ?? instance.workflowRunIds,
      evidenceRefs: [...new Set([...instance.evidenceRefs, ...input.evidenceRefs])].sort(),
    }),
  );
}

export function deriveScenarioInstanceId(input: {
  readonly definitionHash: string;
  readonly inputHash: string;
  readonly targetScopeHash: string;
}): string {
  return `scenario:sha256:${createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex')}`;
}
