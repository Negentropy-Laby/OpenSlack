import { types as utilTypes } from 'node:util';
import {
  canonicalizeGovernedJson,
  hashGovernedValue,
  type GovernedActionOutcome,
  type GovernedExecutionStatus,
  type GovernedJsonValue,
  type GovernedPlanAction,
} from './governed-plan.js';

export interface GovernedActionExecutionContext {
  readonly planId: string;
  readonly executionId: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly correlationId: string;
  readonly actionIndex: number;
}

export interface GovernedActionExecutorResult {
  readonly status: GovernedExecutionStatus;
  readonly summary: string;
  readonly data?: unknown;
  readonly evidenceRefs?: readonly string[];
}

export interface GovernedActionExecutorDefinition {
  readonly actionId: string;
  readonly version: string;
  readonly bindingId: string;
  readonly description: string;
  readonly execute: (
    input: GovernedJsonValue,
    context: GovernedActionExecutionContext,
  ) => Promise<GovernedActionExecutorResult>;
}

export interface GovernedActionMetadata {
  readonly actionId: string;
  readonly version: string;
  readonly bindingId: string;
  readonly description: string;
}

export interface GovernedActionExecutionRegistry {
  readonly actionCatalogHash: string;
  readonly executorBindingHash: string;
  list(): readonly GovernedActionMetadata[];
  has(actionId: string): boolean;
  execute(
    action: GovernedPlanAction,
    context: GovernedActionExecutionContext,
  ): Promise<GovernedActionOutcome>;
}

const SAFE_ACTION_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SAFE_VERSION = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/;
const SAFE_BINDING = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$/;
const SAFE_CONTEXT = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$/;
const REGISTRIES = new WeakSet<object>();

export class GovernedActionRegistryError extends Error {
  readonly code:
    | 'GOVERNED_ACTION_REGISTRY_INVALID'
    | 'GOVERNED_ACTION_UNREGISTERED'
    | 'GOVERNED_ACTION_RESULT_INVALID';

  constructor(code: GovernedActionRegistryError['code'], message: string) {
    super(message);
    this.name = 'GovernedActionRegistryError';
    this.code = code;
  }
}

function fail(code: GovernedActionRegistryError['code'], message: string): never {
  throw new GovernedActionRegistryError(code, message);
}

function descriptors(value: object, label: string): PropertyDescriptorMap {
  if (utilTypes.isProxy(value)) {
    return fail('GOVERNED_ACTION_REGISTRY_INVALID', `${label} cannot be a Proxy.`);
  }
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail(
      'GOVERNED_ACTION_REGISTRY_INVALID',
      `${label} cannot be inspected without executing code.`,
    );
  }
}

function data(values: PropertyDescriptorMap, key: string, label: string): unknown {
  const descriptor = values[key];
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    return fail(
      'GOVERNED_ACTION_REGISTRY_INVALID',
      `${label}.${key} must be an enumerable own data property.`,
    );
  }
  return descriptor.value;
}

function strictString(value: unknown, label: string, pattern: RegExp, maxBytes = 512): string {
  if (
    typeof value !== 'string' ||
    !pattern.test(value) ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    return fail('GOVERNED_ACTION_REGISTRY_INVALID', `${label} is invalid.`);
  }
  return value;
}

function inspectDefinition(
  value: GovernedActionExecutorDefinition,
): GovernedActionExecutorDefinition {
  if (!value || typeof value !== 'object') {
    return fail('GOVERNED_ACTION_REGISTRY_INVALID', 'Action definition must be an object.');
  }
  const values = descriptors(value, 'Action definition');
  const allowed = new Set(['actionId', 'version', 'bindingId', 'description', 'execute']);
  for (const key of Reflect.ownKeys(values)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      return fail(
        'GOVERNED_ACTION_REGISTRY_INVALID',
        'Action definition contains an unknown field.',
      );
    }
  }
  const execute = data(values, 'execute', 'Action definition');
  if (typeof execute !== 'function') {
    return fail(
      'GOVERNED_ACTION_REGISTRY_INVALID',
      'Action definition execute must be a function.',
    );
  }
  if (utilTypes.isProxy(execute)) {
    return fail('GOVERNED_ACTION_REGISTRY_INVALID', 'Action definition execute cannot be a Proxy.');
  }
  return Object.freeze({
    actionId: strictString(
      data(values, 'actionId', 'Action definition'),
      'actionId',
      SAFE_ACTION_ID,
    ),
    version: strictString(data(values, 'version', 'Action definition'), 'version', SAFE_VERSION),
    bindingId: strictString(
      data(values, 'bindingId', 'Action definition'),
      'bindingId',
      SAFE_BINDING,
    ),
    description: strictString(
      data(values, 'description', 'Action definition'),
      'description',
      /^[^\u0000-\u001f\u007f]+$/,
      2_048,
    ),
    execute: execute as GovernedActionExecutorDefinition['execute'],
  });
}

export function isGovernedActionExecutionRegistry(
  value: unknown,
): value is GovernedActionExecutionRegistry {
  return Boolean(
    value && typeof value === 'object' && !utilTypes.isProxy(value) && REGISTRIES.has(value),
  );
}

function validateContext(value: GovernedActionExecutionContext): GovernedActionExecutionContext {
  const sanitized = canonicalizeGovernedJson(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return fail('GOVERNED_ACTION_REGISTRY_INVALID', 'Execution context must be an object.');
  }
  const object = sanitized as { readonly [key: string]: GovernedJsonValue };
  const keys = Object.keys(object);
  const expected = [
    'actionIndex',
    'actorId',
    'correlationId',
    'executionId',
    'planId',
    'workspaceId',
  ];
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    return fail('GOVERNED_ACTION_REGISTRY_INVALID', 'Execution context is not closed.');
  }
  if (
    typeof object.actionIndex !== 'number' ||
    !Number.isSafeInteger(object.actionIndex) ||
    object.actionIndex < 0 ||
    object.actionIndex > 31
  ) {
    return fail('GOVERNED_ACTION_REGISTRY_INVALID', 'Execution action index is invalid.');
  }
  return Object.freeze({
    planId: strictString(object.planId, 'planId', SAFE_CONTEXT),
    executionId: strictString(object.executionId, 'executionId', SAFE_CONTEXT),
    actorId: strictString(object.actorId, 'actorId', SAFE_CONTEXT),
    workspaceId: strictString(object.workspaceId, 'workspaceId', SAFE_CONTEXT),
    correlationId: strictString(object.correlationId, 'correlationId', SAFE_CONTEXT),
    actionIndex: object.actionIndex,
  });
}

function validateResult(
  actionId: string,
  value: GovernedActionExecutorResult,
): GovernedActionOutcome {
  const sanitized = canonicalizeGovernedJson(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return fail('GOVERNED_ACTION_RESULT_INVALID', 'Action result must be an object.');
  }
  const object = sanitized as { readonly [key: string]: GovernedJsonValue };
  const allowed = new Set(['status', 'summary', 'data', 'evidenceRefs']);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      return fail('GOVERNED_ACTION_RESULT_INVALID', `Action result contains unknown field ${key}.`);
    }
  }
  if (!Object.hasOwn(object, 'status') || !Object.hasOwn(object, 'summary')) {
    return fail('GOVERNED_ACTION_RESULT_INVALID', 'Action result is missing status or summary.');
  }
  if (object.status !== 'succeeded' && object.status !== 'blocked' && object.status !== 'failed') {
    return fail('GOVERNED_ACTION_RESULT_INVALID', 'Action result status is invalid.');
  }
  if (
    typeof object.summary !== 'string' ||
    object.summary.length === 0 ||
    Buffer.byteLength(object.summary, 'utf8') > 4_096
  ) {
    return fail('GOVERNED_ACTION_RESULT_INVALID', 'Action result summary is invalid.');
  }
  const evidenceRefs =
    object.evidenceRefs === undefined
      ? []
      : (() => {
          if (!Array.isArray(object.evidenceRefs)) {
            return fail('GOVERNED_ACTION_RESULT_INVALID', 'Action evidenceRefs must be an array.');
          }
          return object.evidenceRefs.map((item: GovernedJsonValue) => {
            if (
              typeof item !== 'string' ||
              item.length === 0 ||
              Buffer.byteLength(item, 'utf8') > 2_048
            ) {
              return fail(
                'GOVERNED_ACTION_RESULT_INVALID',
                'Action evidence reference is invalid.',
              );
            }
            return item;
          });
        })();
  return Object.freeze({
    actionId,
    status: object.status,
    summary: object.summary,
    ...(object.data === undefined ? {} : { data: object.data }),
    evidenceRefs: Object.freeze(evidenceRefs),
  });
}

export function createGovernedActionExecutionRegistry(
  definitions: readonly GovernedActionExecutorDefinition[],
): GovernedActionExecutionRegistry {
  if (utilTypes.isProxy(definitions)) {
    return fail('GOVERNED_ACTION_REGISTRY_INVALID', 'Action definitions cannot be a Proxy.');
  }
  const arrayDescriptors = descriptors(definitions, 'Action definitions');
  const lengthDescriptor = arrayDescriptors.length;
  if (
    !Array.isArray(definitions) ||
    !lengthDescriptor ||
    Object.hasOwn(lengthDescriptor, 'get') ||
    lengthDescriptor.value !== definitions.length ||
    definitions.length === 0 ||
    definitions.length > 32
  ) {
    return fail(
      'GOVERNED_ACTION_REGISTRY_INVALID',
      'Action definitions must be a bounded dense array.',
    );
  }
  const captured: GovernedActionExecutorDefinition[] = [];
  for (let index = 0; index < definitions.length; index += 1) {
    const descriptor = arrayDescriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      return fail(
        'GOVERNED_ACTION_REGISTRY_INVALID',
        'Action definitions must not contain holes or accessors.',
      );
    }
    captured.push(inspectDefinition(descriptor.value));
  }
  const allowedArrayKeys = new Set([
    'length',
    ...captured.map((_definition, index) => String(index)),
  ]);
  if (
    Reflect.ownKeys(arrayDescriptors).some(
      (key) => typeof key !== 'string' || !allowedArrayKeys.has(key),
    )
  ) {
    return fail(
      'GOVERNED_ACTION_REGISTRY_INVALID',
      'Action definitions array contains an unknown property.',
    );
  }
  captured.sort((left, right) => left.actionId.localeCompare(right.actionId));
  const byId = new Map<string, GovernedActionExecutorDefinition>();
  for (const definition of captured) {
    if (byId.has(definition.actionId)) {
      return fail(
        'GOVERNED_ACTION_REGISTRY_INVALID',
        `Duplicate governed action ${definition.actionId}.`,
      );
    }
    byId.set(definition.actionId, definition);
  }
  const metadata = Object.freeze(
    captured.map((definition) =>
      Object.freeze({
        actionId: definition.actionId,
        version: definition.version,
        bindingId: definition.bindingId,
        description: definition.description,
      }),
    ),
  );
  const actionCatalogHash = hashGovernedValue(
    metadata.map(({ actionId, version, description }) => ({
      actionId,
      version,
      description,
    })),
  );
  const executorBindingHash = hashGovernedValue(
    metadata.map(({ actionId, version, bindingId }) => ({
      actionId,
      version,
      bindingId,
    })),
  );

  const registry: GovernedActionExecutionRegistry = Object.freeze({
    actionCatalogHash,
    executorBindingHash,
    list: () => metadata,
    has: (actionId: string) => byId.has(actionId),
    execute: async (
      action: GovernedPlanAction,
      context: GovernedActionExecutionContext,
    ): Promise<GovernedActionOutcome> => {
      const canonicalAction = canonicalizeGovernedJson(action);
      if (
        !canonicalAction ||
        typeof canonicalAction !== 'object' ||
        Array.isArray(canonicalAction)
      ) {
        return fail('GOVERNED_ACTION_REGISTRY_INVALID', 'Governed action is invalid.');
      }
      const object = canonicalAction as { readonly [key: string]: GovernedJsonValue };
      if (
        Object.keys(object).length !== 2 ||
        !Object.hasOwn(object, 'actionId') ||
        !Object.hasOwn(object, 'input') ||
        typeof object.actionId !== 'string'
      ) {
        return fail('GOVERNED_ACTION_REGISTRY_INVALID', 'Governed action is invalid.');
      }
      const definition = byId.get(object.actionId as string);
      if (!definition) {
        return fail(
          'GOVERNED_ACTION_UNREGISTERED',
          `Governed action ${object.actionId} is not registered.`,
        );
      }
      const result = await definition.execute(object.input!, validateContext(context));
      return validateResult(definition.actionId, result);
    },
  });
  REGISTRIES.add(registry);
  return registry;
}
