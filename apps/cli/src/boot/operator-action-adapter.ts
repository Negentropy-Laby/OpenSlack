import type { ActionRegistryPort, RegisteredAction, ToolInputField } from '@openslack/operator';
import type { PluginHostBinding } from '@openslack/plugin-host';

export type OperatorHostTargetCatalogSeed = PluginHostBinding['targets'];

type OperatorHostActionTarget = NonNullable<OperatorHostTargetCatalogSeed['actions']>[number];
type OperatorHostInputField = OperatorHostActionTarget['inputSchema'][string];

const HOST_TARGET_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const HOST_TARGET_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const AUTHORITY_TARGET_SEGMENT =
  /(?:^|[._-])(?:approve|approved|approval|merge|mergeable)(?:$|[._-])/i;
const MAX_HOST_TARGET_ID_LENGTH = 128;
const MAX_HOST_INPUT_FIELDS = 64;

interface AuditedHostActionFacts {
  readonly exposesSecrets: false;
  readonly exposesCredentials: false;
  readonly exposesPaths: false;
  readonly requiredCapability: OperatorHostActionTarget['requiredCapability'];
}

// Disclosure facts cannot be inferred from risk or side-effect metadata. Each
// entry must be backed by a deliberately reviewed behavior and output contract.
// github.metrics performs a bounded GitHub Issues query and emits only the
// returned item count or fixed diagnostic prose. It does not emit issue
// content, credentials, or filesystem paths. Every other built-in remains
// fail-closed.
const DISCLOSURE_AUDITED_ACTIONS: Readonly<Record<string, AuditedHostActionFacts>> = Object.freeze({
  'github.metrics': Object.freeze({
    exposesSecrets: false,
    exposesCredentials: false,
    exposesPaths: false,
    requiredCapability: 'github.issues.read',
  }),
});

// This is the Red host's forbidden mapping-name set. The adapter is allowed to
// be stricter than the host, but never looser: an Operator field which could be
// confused with execution authority, host paths, or credentials is omitted by
// dropping the complete action target.
const FORBIDDEN_HOST_INPUT_FIELDS = new Set(
  [
    '__proto__',
    'prototype',
    'constructor',
    'tostring',
    'command',
    'argv',
    'args',
    'shell',
    'exec',
    'spawn',
    'template',
    'path',
    'file',
    'module',
    'url',
    'risk',
    'risklevel',
    'riskzone',
    'confirmationrequired',
    'secret',
    'secrets',
    'token',
    'password',
    'credential',
    'credentials',
    'privatekey',
    'apikey',
  ].map((name) => name.toLowerCase()),
);

function asciiCompare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function isHostSafeTargetId(id: string): boolean {
  return (
    id.length <= MAX_HOST_TARGET_ID_LENGTH &&
    HOST_TARGET_ID.test(id) &&
    !AUTHORITY_TARGET_SEGMENT.test(id)
  );
}

function isHostSafeFieldName(name: string): boolean {
  return HOST_TARGET_FIELD.test(name) && !FORBIDDEN_HOST_INPUT_FIELDS.has(name.toLowerCase());
}

function projectInputField(field: ToolInputField): OperatorHostInputField | undefined {
  if (
    field === null ||
    typeof field !== 'object' ||
    (field.type !== 'string' && field.type !== 'number' && field.type !== 'boolean') ||
    (field.required !== undefined && typeof field.required !== 'boolean')
  ) {
    return undefined;
  }

  return Object.freeze({
    type: field.type,
    required: field.required === true,
  });
}

function projectInputSchema(
  schema: RegisteredAction['inputSchema'],
): OperatorHostActionTarget['inputSchema'] | undefined {
  let names: string[];
  try {
    if (
      schema === null ||
      typeof schema !== 'object' ||
      Array.isArray(schema) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(schema)) ||
      Reflect.ownKeys(schema).some((key) => typeof key !== 'string')
    ) {
      return undefined;
    }
    names = Object.keys(schema).sort(asciiCompare);
  } catch {
    return undefined;
  }

  if (names.length > MAX_HOST_INPUT_FIELDS) return undefined;

  const projected: Record<string, OperatorHostInputField> = Object.create(null) as Record<
    string,
    OperatorHostInputField
  >;
  for (const name of names) {
    if (!isHostSafeFieldName(name)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(schema, name);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return undefined;
    const field = projectInputField(descriptor.value as ToolInputField);
    if (!field) return undefined;
    projected[name] = field;
  }
  return Object.freeze(projected);
}

function projectAction(action: RegisteredAction): OperatorHostActionTarget | undefined {
  const disclosure = Object.hasOwn(DISCLOSURE_AUDITED_ACTIONS, action.id)
    ? DISCLOSURE_AUDITED_ACTIONS[action.id]
    : undefined;
  if (
    !disclosure ||
    !isHostSafeTargetId(action.id) ||
    action.sideEffects !== false ||
    action.riskLevel !== 'none' ||
    action.confirmationRequired !== false
  ) {
    return undefined;
  }

  const inputSchema = projectInputSchema(action.inputSchema);
  if (!inputSchema) return undefined;

  return Object.freeze({
    kind: 'host_action',
    id: action.id,
    exists: true,
    declarativeAliasAllowed: true,
    sideEffects: false,
    risk: 'none',
    confirmationRequired: false,
    ...disclosure,
    inputSchema,
  });
}

/**
 * Builds the read-only Operator action target catalog consumed by PluginHost.
 *
 * This adapter projects metadata only. It deliberately never invokes action
 * builders, matchers, or execution methods, and it does not register aliases.
 * The Red host remains the authority which validates and binds the returned
 * catalog.
 */
export function createOperatorActionTargetCatalog(
  registry: ActionRegistryPort,
): OperatorHostTargetCatalogSeed {
  const projected = registry
    .list()
    .map(projectAction)
    .filter((action): action is OperatorHostActionTarget => action !== undefined)
    .sort((left, right) => asciiCompare(left.id, right.id));

  const seen = new Set<string>();
  const unique = projected.filter((action) => {
    if (seen.has(action.id)) return false;
    seen.add(action.id);
    return true;
  });

  return Object.freeze({ actions: Object.freeze(unique) });
}
