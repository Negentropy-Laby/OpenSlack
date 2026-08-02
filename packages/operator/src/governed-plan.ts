import { createHash, timingSafeEqual } from 'node:crypto';
import { types as utilTypes } from 'node:util';

// This module owns generic Operator GovernedPlanRecord validation and execution.
// WorkflowStartPlan compilation is a separate domain in packages/workflows/src/governed-plan.ts.

export type GovernedJsonPrimitive = null | boolean | number | string;
export type GovernedJsonValue =
  | GovernedJsonPrimitive
  | readonly GovernedJsonValue[]
  | { readonly [key: string]: GovernedJsonValue };

export const GOVERNED_PLAN_STATES = Object.freeze([
  'pending',
  'executing',
  'succeeded',
  'blocked',
  'failed',
  'reconciliation_required',
  'cancelled',
  'expired',
] as const);

export type GovernedPlanState = (typeof GOVERNED_PLAN_STATES)[number];

export const GOVERNED_EXECUTION_STATUSES = Object.freeze([
  'succeeded',
  'blocked',
  'failed',
] as const);

export type GovernedExecutionStatus = (typeof GOVERNED_EXECUTION_STATUSES)[number];

export const GOVERNED_PLAN_CONTRACT_ERROR_CODES = Object.freeze([
  'GOVERNED_PLAN_INVALID',
  'GOVERNED_PLAN_LIMIT_EXCEEDED',
  'GOVERNED_PLAN_BINDING_MISMATCH',
] as const);

export const GOVERNED_PLAN_CONTRACT_LIMITS = Object.freeze({
  maxDepth: 12,
  maxNodes: 10_000,
  maxContainerEntries: 1_000,
  maxStringBytes: 64 * 1024,
  maxObjectKeyBytes: 256,
  maxActions: 32,
  maxEffects: 64,
  maxGoalBytes: 4_096,
  maxEffectSummaryBytes: 2_048,
  maxSummaryBytes: 4_096,
  maxEvidenceRefBytes: 2_048,
  // Existing v1 behavior is intentionally measured in ECMAScript UTF-16 code units.
  maxOpaqueBindingCharacters: 4_096,
  minOpaqueBindingCharacters: 16,
} as const);

export interface GovernedPlanAction {
  readonly actionId: string;
  readonly input: GovernedJsonValue;
}

export interface GovernedPlanEffect {
  readonly type: string;
  readonly summary: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly target?: string;
}

export interface CanonicalGovernedPlan {
  readonly schema: 'openslack.governed_action_plan.v1';
  readonly kind: string;
  readonly goal: string;
  readonly input: GovernedJsonValue;
  readonly actions: readonly GovernedPlanAction[];
  readonly effects: readonly GovernedPlanEffect[];
}

export interface GovernedPlanBindings {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly correlationId: string;
  readonly inputHash: string;
  readonly planHash: string;
  readonly sourceVersionHash: string;
  readonly permissionSnapshotHash: string;
  readonly actionCatalogHash: string;
  readonly executorBindingHash: string;
  readonly buildNonceHash: string;
  readonly processNonceHash: string;
}

export interface GovernedActionOutcome {
  readonly actionId: string;
  readonly status: GovernedExecutionStatus;
  readonly summary: string;
  readonly data?: GovernedJsonValue;
  readonly evidenceRefs: readonly string[];
}

export interface GovernedPlanExecution {
  readonly executionId: string;
  readonly ownerPid: number;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly outcomes: readonly GovernedActionOutcome[];
  readonly blocker?: string;
  readonly failure?: string;
}

export interface GovernedPlanRecord {
  readonly schema: 'openslack.governed_plan.v1';
  readonly revision: number;
  readonly planId: string;
  readonly state: GovernedPlanState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly canonicalPlan: CanonicalGovernedPlan;
  readonly bindings: GovernedPlanBindings;
  readonly confirmationTokenHash: string;
  readonly execution?: GovernedPlanExecution;
}

export interface CreateCanonicalGovernedPlanInput {
  readonly kind: string;
  readonly goal: string;
  readonly input: unknown;
  readonly actions: readonly {
    readonly actionId: string;
    readonly input: unknown;
  }[];
  readonly effects: readonly {
    readonly type: string;
    readonly summary: string;
    readonly risk: 'low' | 'medium' | 'high';
    readonly target?: string;
  }[];
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$/;
const SAFE_KIND = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PLAN_ID = /^GPLAN-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EXECUTION_ID = /^GEXEC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_DEPTH = GOVERNED_PLAN_CONTRACT_LIMITS.maxDepth;
const MAX_NODES = GOVERNED_PLAN_CONTRACT_LIMITS.maxNodes;
const MAX_CONTAINER_ENTRIES = GOVERNED_PLAN_CONTRACT_LIMITS.maxContainerEntries;
const MAX_STRING_BYTES = GOVERNED_PLAN_CONTRACT_LIMITS.maxStringBytes;

export class GovernedPlanContractError extends Error {
  readonly code: (typeof GOVERNED_PLAN_CONTRACT_ERROR_CODES)[number];
  readonly path: string;

  constructor(code: GovernedPlanContractError['code'], message: string, path = '$') {
    super(message);
    this.name = 'GovernedPlanContractError';
    this.code = code;
    this.path = path;
  }
}

function fail(code: GovernedPlanContractError['code'], message: string, path = '$'): never {
  throw new GovernedPlanContractError(code, message, path);
}

function pointer(path: string, segment: string | number): string {
  const escaped = String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
  return `${path}/${escaped}`;
}

function inspectDescriptors(value: object, path: string): PropertyDescriptorMap {
  // Why: descriptor-only inspection rejects accessors without invoking attacker-controlled code.
  if (utilTypes.isProxy(value)) {
    return fail('GOVERNED_PLAN_INVALID', 'Proxy objects are forbidden.', path);
  }
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail('GOVERNED_PLAN_INVALID', 'Value cannot be inspected without executing code.', path);
  }
}

function dataValue(
  descriptors: PropertyDescriptorMap,
  key: string,
  path: string,
  enumerable = true,
): unknown {
  // Why: governed JSON accepts only inert own data; inherited and accessor fields are authority leaks.
  const descriptor = descriptors[key];
  if (!descriptor || descriptor.enumerable !== enumerable || !Object.hasOwn(descriptor, 'value')) {
    return fail(
      'GOVERNED_PLAN_INVALID',
      'Fields must be own data properties with expected enumerability.',
      path,
    );
  }
  return descriptor.value;
}

function sanitizeJson(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number },
): GovernedJsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH) {
    return fail(
      'GOVERNED_PLAN_LIMIT_EXCEEDED',
      'Governed JSON exceeds the host-owned structural limit.',
      path,
    );
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return fail('GOVERNED_PLAN_INVALID', 'Numbers must be finite.', path);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_STRING_BYTES) {
      return fail(
        'GOVERNED_PLAN_LIMIT_EXCEEDED',
        'String exceeds the host-owned byte limit.',
        path,
      );
    }
    return value;
  }
  if (typeof value !== 'object' || value === undefined) {
    return fail('GOVERNED_PLAN_INVALID', `Unsupported governed JSON value: ${typeof value}.`, path);
  }

  const descriptors = inspectDescriptors(value, path);
  if (Array.isArray(value)) {
    const length = dataValue(descriptors, 'length', pointer(path, 'length'), false);
    if (!Number.isSafeInteger(length) || length !== value.length || value.length < 0) {
      return fail('GOVERNED_PLAN_INVALID', 'Array length is invalid.', path);
    }
    if (value.length > MAX_CONTAINER_ENTRIES) {
      return fail(
        'GOVERNED_PLAN_LIMIT_EXCEEDED',
        'Array exceeds the host-owned entry limit.',
        path,
      );
    }
    const expected = new Set<PropertyKey>(['length']);
    const output: GovernedJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const key = String(index);
      expected.add(key);
      output.push(
        sanitizeJson(
          dataValue(descriptors, key, pointer(path, index)),
          pointer(path, index),
          depth + 1,
          state,
        ),
      );
    }
    for (const key of Reflect.ownKeys(descriptors)) {
      if (!expected.has(key)) {
        return fail('GOVERNED_PLAN_INVALID', 'Array has an unexpected property.', path);
      }
    }
    return Object.freeze(output);
  }

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return fail('GOVERNED_PLAN_INVALID', 'Object prototype cannot be inspected.', path);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    return fail('GOVERNED_PLAN_INVALID', 'Only plain JSON objects are allowed.', path);
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > MAX_CONTAINER_ENTRIES) {
    return fail('GOVERNED_PLAN_LIMIT_EXCEEDED', 'Object exceeds the host-owned entry limit.', path);
  }
  const output: Record<string, GovernedJsonValue> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) {
      return fail('GOVERNED_PLAN_INVALID', 'Object contains a forbidden key.', path);
    }
    if (Buffer.byteLength(key, 'utf8') > GOVERNED_PLAN_CONTRACT_LIMITS.maxObjectKeyBytes) {
      return fail('GOVERNED_PLAN_LIMIT_EXCEEDED', 'Object key is too long.', pointer(path, key));
    }
    output[key] = sanitizeJson(
      dataValue(descriptors, key, pointer(path, key)),
      pointer(path, key),
      depth + 1,
      state,
    );
  }
  return Object.freeze(output);
}

export function canonicalizeGovernedJson(value: unknown): GovernedJsonValue {
  return sanitizeJson(value, '$', 0, { nodes: 0 });
}

function encodeCanonical(value: GovernedJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(',')}]`;
  const object = value as { readonly [key: string]: GovernedJsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${encodeCanonical(object[key]!)}`)
    .join(',')}}`;
}

export function canonicalGovernedJson(value: unknown): string {
  return encodeCanonical(canonicalizeGovernedJson(value));
}

export function hashGovernedValue(value: unknown): string {
  return createHash('sha256').update(canonicalGovernedJson(value), 'utf8').digest('hex');
}

export function hashOpaqueValue(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < GOVERNED_PLAN_CONTRACT_LIMITS.minOpaqueBindingCharacters ||
    value.length > GOVERNED_PLAN_CONTRACT_LIMITS.maxOpaqueBindingCharacters
  ) {
    return fail('GOVERNED_PLAN_INVALID', 'Opaque binding value is outside allowed bounds.');
  }
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function opaqueHashesEqual(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function requireString(
  value: unknown,
  label: string,
  options: { pattern?: RegExp; maxBytes?: number } = {},
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > (options.maxBytes ?? 512) ||
    (options.pattern && !options.pattern.test(value))
  ) {
    return fail('GOVERNED_PLAN_INVALID', `${label} is invalid.`, `$.${label}`);
  }
  return value;
}

function requireOneOf<const Values extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: Values,
): Values[number] {
  const text = requireString(value, label);
  if (!(allowed as readonly string[]).includes(text)) {
    return fail('GOVERNED_PLAN_INVALID', `${label} is invalid.`, `$.${label}`);
  }
  return text as Values[number];
}

function requireTimestamp(value: unknown, label: string): string {
  const timestamp = requireString(value, label, {
    pattern: CANONICAL_TIMESTAMP,
    maxBytes: 24,
  });
  if (!Number.isFinite(Date.parse(timestamp))) {
    return fail('GOVERNED_PLAN_INVALID', `${label} is not a valid timestamp.`, `$.${label}`);
  }
  return timestamp;
}

function exactKeys(
  value: { readonly [key: string]: GovernedJsonValue },
  allowed: readonly string[],
  label: string,
): void {
  const expected = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      return fail('GOVERNED_PLAN_INVALID', `${label} contains unknown field ${key}.`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key) && !key.endsWith('?')) {
      return fail('GOVERNED_PLAN_INVALID', `${label} is missing field ${key}.`);
    }
  }
}

function cleanAllowed(allowed: readonly string[]): string[] {
  return allowed.map((key) => (key.endsWith('?') ? key.slice(0, -1) : key));
}

function assertClosedKeys(
  value: { readonly [key: string]: GovernedJsonValue },
  requiredAndOptional: readonly string[],
  label: string,
): void {
  const cleaned = cleanAllowed(requiredAndOptional);
  for (const key of Object.keys(value)) {
    if (!cleaned.includes(key)) {
      return fail('GOVERNED_PLAN_INVALID', `${label} contains unknown field ${key}.`);
    }
  }
  for (const key of requiredAndOptional) {
    if (!key.endsWith('?') && !Object.hasOwn(value, key)) {
      return fail('GOVERNED_PLAN_INVALID', `${label} is missing field ${key}.`);
    }
  }
}

function objectValue(
  value: GovernedJsonValue,
  label: string,
): { readonly [key: string]: GovernedJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail('GOVERNED_PLAN_INVALID', `${label} must be an object.`);
  }
  return value as { readonly [key: string]: GovernedJsonValue };
}

function arrayValue(value: GovernedJsonValue, label: string): readonly GovernedJsonValue[] {
  if (!Array.isArray(value)) {
    return fail('GOVERNED_PLAN_INVALID', `${label} must be an array.`);
  }
  return value;
}

function validateEffect(value: GovernedJsonValue): GovernedPlanEffect {
  const effect = objectValue(value, 'effect');
  assertClosedKeys(effect, ['type', 'summary', 'risk', 'target?'], 'effect');
  const risk = requireString(effect.risk, 'risk', {
    pattern: /^(?:low|medium|high)$/,
  }) as GovernedPlanEffect['risk'];
  const result: GovernedPlanEffect = {
    type: requireString(effect.type, 'type', { pattern: SAFE_KIND }),
    summary: requireString(effect.summary, 'summary', {
      maxBytes: GOVERNED_PLAN_CONTRACT_LIMITS.maxEffectSummaryBytes,
    }),
    risk,
    ...(effect.target === undefined
      ? {}
      : {
          target: requireString(effect.target, 'target', {
            pattern: SAFE_IDENTIFIER,
          }),
        }),
  };
  return Object.freeze(result);
}

function validateAction(value: GovernedJsonValue): GovernedPlanAction {
  const action = objectValue(value, 'action');
  exactKeys(action, ['actionId', 'input'], 'action');
  return Object.freeze({
    actionId: requireString(action.actionId, 'actionId', { pattern: SAFE_KIND }),
    input: action.input!,
  });
}

export function createCanonicalGovernedPlan(
  value: CreateCanonicalGovernedPlanInput,
): CanonicalGovernedPlan {
  const sanitized = objectValue(canonicalizeGovernedJson(value), 'plan');
  exactKeys(sanitized, ['kind', 'goal', 'input', 'actions', 'effects'], 'plan');
  const actions = arrayValue(sanitized.actions!, 'actions').map(validateAction);
  const effects = arrayValue(sanitized.effects!, 'effects').map(validateEffect);
  if (actions.length === 0 || actions.length > GOVERNED_PLAN_CONTRACT_LIMITS.maxActions) {
    return fail(
      'GOVERNED_PLAN_LIMIT_EXCEEDED',
      'Governed plan must contain between 1 and 32 actions.',
    );
  }
  if (effects.length > GOVERNED_PLAN_CONTRACT_LIMITS.maxEffects) {
    return fail('GOVERNED_PLAN_LIMIT_EXCEEDED', 'Governed plan has too many effects.');
  }
  return Object.freeze({
    schema: 'openslack.governed_action_plan.v1',
    kind: requireString(sanitized.kind, 'kind', { pattern: SAFE_KIND }),
    goal: requireString(sanitized.goal, 'goal', {
      maxBytes: GOVERNED_PLAN_CONTRACT_LIMITS.maxGoalBytes,
    }),
    input: sanitized.input!,
    actions: Object.freeze(actions),
    effects: Object.freeze(effects),
  });
}

function validateCanonicalPlan(value: GovernedJsonValue): CanonicalGovernedPlan {
  const plan = objectValue(value, 'canonicalPlan');
  exactKeys(plan, ['schema', 'kind', 'goal', 'input', 'actions', 'effects'], 'canonicalPlan');
  if (plan.schema !== 'openslack.governed_action_plan.v1') {
    return fail('GOVERNED_PLAN_INVALID', 'Canonical plan schema is invalid.');
  }
  return createCanonicalGovernedPlan({
    kind: plan.kind as string,
    goal: plan.goal as string,
    input: plan.input,
    actions: arrayValue(plan.actions!, 'actions').map((item) => {
      const action = objectValue(item, 'action');
      return {
        actionId: action.actionId as string,
        input: action.input,
      };
    }),
    effects: arrayValue(plan.effects!, 'effects').map((item) => {
      const effect = objectValue(item, 'effect');
      return {
        type: effect.type as string,
        summary: effect.summary as string,
        risk: effect.risk as GovernedPlanEffect['risk'],
        ...(effect.target === undefined ? {} : { target: effect.target as string }),
      };
    }),
  });
}

function validateBindings(value: GovernedJsonValue): GovernedPlanBindings {
  const bindings = objectValue(value, 'bindings');
  exactKeys(
    bindings,
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
    'bindings',
  );
  const hash = (key: string) =>
    requireString(bindings[key], key, { pattern: SHA256, maxBytes: 64 });
  return Object.freeze({
    actorId: requireString(bindings.actorId, 'actorId', { pattern: SAFE_IDENTIFIER }),
    workspaceId: requireString(bindings.workspaceId, 'workspaceId', {
      pattern: SAFE_IDENTIFIER,
    }),
    correlationId: requireString(bindings.correlationId, 'correlationId', {
      pattern: SAFE_IDENTIFIER,
    }),
    inputHash: hash('inputHash'),
    planHash: hash('planHash'),
    sourceVersionHash: hash('sourceVersionHash'),
    permissionSnapshotHash: hash('permissionSnapshotHash'),
    actionCatalogHash: hash('actionCatalogHash'),
    executorBindingHash: hash('executorBindingHash'),
    buildNonceHash: hash('buildNonceHash'),
    processNonceHash: hash('processNonceHash'),
  });
}

function validateOutcome(value: GovernedJsonValue): GovernedActionOutcome {
  const outcome = objectValue(value, 'outcome');
  assertClosedKeys(outcome, ['actionId', 'status', 'summary', 'data?', 'evidenceRefs'], 'outcome');
  const status = requireOneOf(outcome.status, 'status', GOVERNED_EXECUTION_STATUSES);
  const evidenceRefs = arrayValue(outcome.evidenceRefs!, 'evidenceRefs').map((item) =>
    requireString(item, 'evidenceRef', {
      maxBytes: GOVERNED_PLAN_CONTRACT_LIMITS.maxEvidenceRefBytes,
    }),
  );
  return Object.freeze({
    actionId: requireString(outcome.actionId, 'actionId', { pattern: SAFE_KIND }),
    status,
    summary: requireString(outcome.summary, 'summary', {
      maxBytes: GOVERNED_PLAN_CONTRACT_LIMITS.maxSummaryBytes,
    }),
    ...(outcome.data === undefined ? {} : { data: outcome.data }),
    evidenceRefs: Object.freeze(evidenceRefs),
  });
}

function validateExecution(value: GovernedJsonValue): GovernedPlanExecution {
  const execution = objectValue(value, 'execution');
  assertClosedKeys(
    execution,
    ['executionId', 'ownerPid', 'startedAt', 'completedAt?', 'outcomes', 'blocker?', 'failure?'],
    'execution',
  );
  return Object.freeze({
    executionId: requireString(execution.executionId, 'executionId', {
      pattern: EXECUTION_ID,
    }),
    ownerPid:
      typeof execution.ownerPid === 'number' &&
      Number.isSafeInteger(execution.ownerPid) &&
      execution.ownerPid >= 1 &&
      execution.ownerPid <= 2_147_483_647
        ? execution.ownerPid
        : fail('GOVERNED_PLAN_INVALID', 'Execution ownerPid is invalid.'),
    startedAt: requireTimestamp(execution.startedAt, 'startedAt'),
    ...(execution.completedAt === undefined
      ? {}
      : { completedAt: requireTimestamp(execution.completedAt, 'completedAt') }),
    outcomes: Object.freeze(arrayValue(execution.outcomes!, 'outcomes').map(validateOutcome)),
    ...(execution.blocker === undefined
      ? {}
      : {
          blocker: requireString(execution.blocker, 'blocker', {
            maxBytes: GOVERNED_PLAN_CONTRACT_LIMITS.maxSummaryBytes,
          }),
        }),
    ...(execution.failure === undefined
      ? {}
      : {
          failure: requireString(execution.failure, 'failure', {
            maxBytes: GOVERNED_PLAN_CONTRACT_LIMITS.maxSummaryBytes,
          }),
        }),
  });
}

export function validateGovernedPlanRecord(value: unknown): GovernedPlanRecord {
  const record = objectValue(canonicalizeGovernedJson(value), 'record');
  assertClosedKeys(
    record,
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
      'execution?',
    ],
    'record',
  );
  if (record.schema !== 'openslack.governed_plan.v1') {
    return fail('GOVERNED_PLAN_INVALID', 'Governed plan record schema is invalid.');
  }
  if (
    typeof record.revision !== 'number' ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1
  ) {
    return fail('GOVERNED_PLAN_INVALID', 'Record revision is invalid.');
  }
  const state = requireOneOf(record.state, 'state', GOVERNED_PLAN_STATES);
  const canonicalPlan = validateCanonicalPlan(record.canonicalPlan!);
  const bindings = validateBindings(record.bindings!);
  if (!opaqueHashesEqual(bindings.inputHash, hashGovernedValue(canonicalPlan.input))) {
    return fail('GOVERNED_PLAN_BINDING_MISMATCH', 'Input hash does not match canonical input.');
  }
  if (!opaqueHashesEqual(bindings.planHash, hashGovernedValue(canonicalPlan))) {
    return fail('GOVERNED_PLAN_BINDING_MISMATCH', 'Plan hash does not match canonical plan.');
  }
  const execution =
    record.execution === undefined ? undefined : validateExecution(record.execution);
  switch (state) {
    case 'pending':
      if (execution !== undefined) {
        return fail('GOVERNED_PLAN_INVALID', 'Pending plan cannot have execution state.');
      }
      break;
    case 'executing':
      if (!execution || execution.completedAt !== undefined) {
        return fail('GOVERNED_PLAN_INVALID', 'Executing plan must have an open execution.');
      }
      break;
    case 'succeeded':
    case 'blocked':
    case 'failed':
    case 'reconciliation_required':
      if (!execution || execution.completedAt === undefined) {
        return fail('GOVERNED_PLAN_INVALID', 'Terminal execution state is incomplete.');
      }
      break;
    case 'cancelled':
    case 'expired':
      if (execution !== undefined) {
        return fail('GOVERNED_PLAN_INVALID', 'Non-executed terminal plan cannot have execution.');
      }
      break;
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
  return Object.freeze({
    schema: 'openslack.governed_plan.v1',
    revision: record.revision,
    planId: requireString(record.planId, 'planId', { pattern: PLAN_ID }),
    state,
    createdAt: requireTimestamp(record.createdAt, 'createdAt'),
    updatedAt: requireTimestamp(record.updatedAt, 'updatedAt'),
    expiresAt: requireTimestamp(record.expiresAt, 'expiresAt'),
    canonicalPlan,
    bindings,
    confirmationTokenHash: requireString(record.confirmationTokenHash, 'confirmationTokenHash', {
      pattern: SHA256,
      maxBytes: 64,
    }),
    ...(execution === undefined ? {} : { execution }),
  });
}
