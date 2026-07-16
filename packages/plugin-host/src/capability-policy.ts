import type {
  CanonicalRiskLevel,
  DeclarativeActionAliasV1,
  DeclarativeContributionV1,
  DeclarativeInputBindingV1,
  DeclarativePluginCapability,
  DeclarativeWorkflowAliasV1,
  PluginCapability,
  PluginInputDefinitionV1,
  PluginInputType,
} from '@openslack/plugin-api';
import { PluginHostError, asciiCompare, sortFindings, type PluginHostFinding } from './findings.js';

const DECLARATIVE_HARD_CAPABILITY_ALLOWLIST = Object.freeze([
  'host.actions.read',
  'host.workflows.read',
  'workspace.read',
  'github.issues.read',
  'github.pull_requests.read',
  'github.checks.read',
  'collaboration.read',
] as const satisfies readonly DeclarativePluginCapability[]);

const BUNDLED_HARD_CAPABILITY_ALLOWLIST = Object.freeze([
  ...DECLARATIVE_HARD_CAPABILITY_ALLOWLIST,
  'host.actions.plan',
  'host.workflows.contribute',
  'prms.blockers.append',
  'github.issues.write',
  'github.pull_requests.comment',
  'collaboration.write',
  'workflow.execute',
] as const satisfies readonly PluginCapability[]);

const DECLARATIVE_HARD_CAPABILITY_SET = new Set<string>(DECLARATIVE_HARD_CAPABILITY_ALLOWLIST);
const BUNDLED_HARD_CAPABILITY_SET = new Set<string>(BUNDLED_HARD_CAPABILITY_ALLOWLIST);
const KNOWN_PLUGIN_CAPABILITY_SET = new Set<string>([
  ...BUNDLED_HARD_CAPABILITY_ALLOWLIST,
  // Known to the Yellow authoring contract but deliberately outside the Red
  // v1 execution ceiling.
  'github.pull_requests.merge.request',
]);

const FORBIDDEN_MAPPING_NAMES = new Set(
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

const INPUT_TYPES = new Set<string>(['string', 'number', 'boolean']);
const RISK_LEVELS = new Set<string>(['none', 'low', 'medium', 'high']);
const TARGET_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const TARGET_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const KNOWN_TARGET_CAPABILITIES = new Set<string>(KNOWN_PLUGIN_CAPABILITY_SET);
const TARGET_BASE_FIELDS = Object.freeze([
  'kind',
  'id',
  'exists',
  'declarativeAliasAllowed',
  'sideEffects',
  'risk',
  'confirmationRequired',
  'exposesSecrets',
  'exposesCredentials',
  'exposesPaths',
  'inputSchema',
]);
const ACTION_TARGET_FIELDS = Object.freeze([...TARGET_BASE_FIELDS, 'requiredCapability']);

export interface CapabilityIntersectionRequest {
  readonly providerKind: 'declarative' | 'bundled';
  readonly requestedCapabilities: readonly string[];
  readonly hostAllowedCapabilities: readonly string[];
  readonly actorAllowedCapabilities: readonly string[];
  readonly pluginId?: string;
}

export interface EffectiveCapabilityResult {
  readonly effectiveCapabilities: readonly PluginCapability[];
  readonly deniedFindings: readonly PluginHostFinding[];
}

export interface HostTargetInputField {
  readonly type: PluginInputType;
  readonly required: boolean;
}

interface HostAliasTargetFactsBase {
  readonly id: string;
  readonly exists: boolean;
  readonly declarativeAliasAllowed: boolean;
  readonly sideEffects: boolean;
  readonly risk: CanonicalRiskLevel;
  readonly confirmationRequired: boolean;
  readonly exposesSecrets: boolean;
  readonly exposesCredentials: boolean;
  readonly exposesPaths: boolean;
  readonly inputSchema: Readonly<Record<string, HostTargetInputField>>;
}

export interface HostActionTargetFacts extends HostAliasTargetFactsBase {
  readonly kind: 'host_action';
  readonly requiredCapability: PluginCapability;
}

export interface HostWorkflowTargetFacts extends HostAliasTargetFactsBase {
  readonly kind: 'host_workflow';
}

export interface HostTargetCatalogSeed {
  readonly actions?: readonly HostActionTargetFacts[];
  readonly workflows?: readonly HostWorkflowTargetFacts[];
}

export type HostAliasTargetFacts = HostActionTargetFacts | HostWorkflowTargetFacts;

export type ResolvedDeclarativeAlias =
  | {
      readonly kind: 'action_alias';
      readonly contribution: DeclarativeActionAliasV1;
      readonly target: HostActionTargetFacts;
    }
  | {
      readonly kind: 'workflow_alias';
      readonly contribution: DeclarativeWorkflowAliasV1;
      readonly target: HostWorkflowTargetFacts;
    };

export type DeclarativeAliasValidationResult =
  | { readonly valid: true; readonly resolved: ResolvedDeclarativeAlias }
  | { readonly valid: false; readonly findings: readonly PluginHostFinding[] };

function hardCapabilitySet(
  providerKind: CapabilityIntersectionRequest['providerKind'],
): Set<string> {
  return providerKind === 'declarative'
    ? DECLARATIVE_HARD_CAPABILITY_SET
    : BUNDLED_HARD_CAPABILITY_SET;
}

export function computeEffectiveCapabilities(
  request: CapabilityIntersectionRequest,
): EffectiveCapabilityResult {
  const hostAllowed = new Set(request.hostAllowedCapabilities);
  const actorAllowed = new Set(request.actorAllowedCapabilities);
  const hardAllowed = hardCapabilitySet(request.providerKind);
  const findings: PluginHostFinding[] = [];
  const seen = new Set<string>();
  const effective: PluginCapability[] = [];

  for (const capability of [...request.requestedCapabilities].sort(asciiCompare)) {
    if (seen.has(capability)) {
      findings.push({
        phase: 'capability',
        code: 'PLUGIN_CAPABILITY_DUPLICATE',
        pluginId: request.pluginId,
        summary: `Capability ${capability} was requested more than once.`,
      });
      continue;
    }
    seen.add(capability);
    if (!hardAllowed.has(capability)) {
      findings.push({
        phase: 'capability',
        code: KNOWN_PLUGIN_CAPABILITY_SET.has(capability)
          ? 'PLUGIN_CAPABILITY_HARD_DENIED'
          : 'PLUGIN_CAPABILITY_UNKNOWN',
        pluginId: request.pluginId,
        summary: `Capability ${capability} is outside the Red host allowlist.`,
      });
      continue;
    }
    if (!hostAllowed.has(capability)) {
      findings.push({
        phase: 'capability',
        code: 'PLUGIN_CAPABILITY_HOST_DENIED',
        pluginId: request.pluginId,
        summary: `Capability ${capability} is not allowed by the host.`,
      });
      continue;
    }
    if (!actorAllowed.has(capability)) {
      findings.push({
        phase: 'capability',
        code: 'PLUGIN_CAPABILITY_ACTOR_DENIED',
        pluginId: request.pluginId,
        summary: `Capability ${capability} is not allowed for the actor.`,
      });
      continue;
    }
    effective.push(capability as PluginCapability);
  }

  return Object.freeze({
    effectiveCapabilities: Object.freeze(effective),
    deniedFindings: sortFindings(findings),
  });
}

export function assertEffectiveCapabilities(
  request: CapabilityIntersectionRequest,
): readonly PluginCapability[] {
  const result = computeEffectiveCapabilities(request);
  if (result.deniedFindings.length > 0) throw new PluginHostError(result.deniedFindings);
  return result.effectiveCapabilities;
}

function requiredCapability(kind: string): DeclarativePluginCapability | undefined {
  if (kind === 'action_alias') return 'host.actions.read';
  if (kind === 'workflow_alias') return 'host.workflows.read';
  return undefined;
}

export function validateContributionCapabilities(
  contributions: readonly unknown[],
  effectiveCapabilities: readonly string[],
  pluginId?: string,
): readonly PluginHostFinding[] {
  const effective = new Set(effectiveCapabilities);
  const findings: PluginHostFinding[] = [];
  for (const contribution of contributions) {
    const record = dataRecord(contribution);
    const kind = typeof record?.kind === 'string' ? record.kind : '<unknown>';
    const id = typeof record?.id === 'string' ? record.id : undefined;
    const required = requiredCapability(kind);
    if (required === undefined) {
      findings.push({
        phase: 'capability',
        code: 'PLUGIN_ALIAS_TARGET_FORBIDDEN',
        pluginId,
        contributionId: id,
        summary: `Declarative contribution kind ${kind} is not allowed by the Red host.`,
      });
    } else if (!effective.has(required)) {
      findings.push({
        phase: 'capability',
        code: 'PLUGIN_CONTRIBUTION_CAPABILITY_MISSING',
        pluginId,
        contributionId: id,
        summary: `Contribution ${id ?? '<unknown>'} requires effective capability ${required}.`,
      });
    }
  }
  return sortFindings(findings);
}

function cloneInputSchema(schemaValue: unknown): Readonly<Record<string, HostTargetInputField>> {
  const schema = dataRecord(schemaValue);
  if (!schema || Object.keys(schema).length > 64) bindingInvalid('Target input schema is invalid.');
  const copy: Record<string, HostTargetInputField> = Object.create(null) as Record<
    string,
    HostTargetInputField
  >;
  for (const key of Object.keys(schema).sort(asciiCompare)) {
    const value = dataRecord(schema[key]);
    if (
      !TARGET_FIELD.test(key) ||
      forbiddenName(key) ||
      !value ||
      !exactKeys(value, ['type', 'required']) ||
      !INPUT_TYPES.has(value.type as string) ||
      typeof value.required !== 'boolean'
    ) {
      bindingInvalid(`Target input schema field ${key} is invalid.`);
    }
    copy[key] = Object.freeze({
      type: value.type as PluginInputType,
      required: value.required as boolean,
    });
  }
  return Object.freeze(copy);
}

function bindingInvalid(summary: string, contributionId?: string): never {
  throw new PluginHostError([
    {
      phase: 'binding',
      code: 'PLUGIN_HOST_BINDING_INVALID',
      ...(contributionId === undefined ? {} : { contributionId }),
      summary,
    },
  ]);
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(record).sort(asciiCompare);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function forbiddenAuthorityTarget(id: string): boolean {
  return /(?:^|[._-])(?:approve|approved|approval|merge|mergeable)(?:$|[._-])/i.test(id);
}

function cloneTarget(
  targetValue: unknown,
  expectedKind: HostAliasTargetFacts['kind'],
): HostAliasTargetFacts {
  const target = dataRecord(targetValue);
  const expectedFields = expectedKind === 'host_action' ? ACTION_TARGET_FIELDS : TARGET_BASE_FIELDS;
  if (!target || !exactKeys(target, expectedFields)) {
    return bindingInvalid('Host target facts must use the exact Red host schema.');
  }
  if (
    target.kind !== expectedKind ||
    typeof target.id !== 'string' ||
    target.id.length > 128 ||
    !TARGET_ID.test(target.id) ||
    forbiddenAuthorityTarget(target.id)
  ) {
    return bindingInvalid('Host target identity is invalid or authority-bearing.');
  }
  for (const field of [
    'exists',
    'declarativeAliasAllowed',
    'sideEffects',
    'confirmationRequired',
    'exposesSecrets',
    'exposesCredentials',
    'exposesPaths',
  ]) {
    if (typeof target[field] !== 'boolean') {
      return bindingInvalid(`Host target ${target.id} field ${field} must be boolean.`, target.id);
    }
  }
  if (typeof target.risk !== 'string' || !RISK_LEVELS.has(target.risk)) {
    return bindingInvalid(`Host target ${target.id} risk is invalid.`, target.id);
  }
  if (
    expectedKind === 'host_action' &&
    (typeof target.requiredCapability !== 'string' ||
      !KNOWN_TARGET_CAPABILITIES.has(target.requiredCapability))
  ) {
    return bindingInvalid(`Host target ${target.id} required capability is invalid.`, target.id);
  }
  const normalized = {
    kind: expectedKind,
    id: target.id,
    exists: target.exists,
    declarativeAliasAllowed: target.declarativeAliasAllowed,
    sideEffects: target.sideEffects,
    risk: target.risk as CanonicalRiskLevel,
    confirmationRequired: target.confirmationRequired,
    exposesSecrets: target.exposesSecrets,
    exposesCredentials: target.exposesCredentials,
    exposesPaths: target.exposesPaths,
    inputSchema: cloneInputSchema(target.inputSchema),
    ...(expectedKind === 'host_action'
      ? { requiredCapability: target.requiredCapability as PluginCapability }
      : {}),
  };
  return Object.freeze(normalized) as HostAliasTargetFacts;
}

function denseBoundedArray(value: unknown, label: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 256
  ) {
    return bindingInvalid(`${label} must be a bounded dense data array.`);
  }
  const allowed = new Set<string>(['length']);
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    allowed.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return bindingInvalid(`${label} must be a bounded dense data array.`);
    }
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))) {
    return bindingInvalid(`${label} cannot contain named or symbol fields.`);
  }
  return value;
}

export class HostTargetCatalog {
  readonly #actions: ReadonlyMap<string, HostActionTargetFacts>;
  readonly #workflows: ReadonlyMap<string, HostWorkflowTargetFacts>;

  constructor(seedValue: HostTargetCatalogSeed) {
    const seed = dataRecord(seedValue);
    if (!seed || !Object.keys(seed).every((key) => key === 'actions' || key === 'workflows')) {
      bindingInvalid('Host target catalog seed is not exact plain data.');
    }
    const actionValues = denseBoundedArray(seed.actions ?? [], 'Host action targets');
    const workflowValues = denseBoundedArray(seed.workflows ?? [], 'Host workflow targets');
    const actions = new Map<string, HostActionTargetFacts>();
    const workflows = new Map<string, HostWorkflowTargetFacts>();
    const normalizedActions = actionValues.map((target) =>
      cloneTarget(target, 'host_action'),
    ) as HostActionTargetFacts[];
    const normalizedWorkflows = workflowValues.map((target) =>
      cloneTarget(target, 'host_workflow'),
    ) as HostWorkflowTargetFacts[];
    for (const target of normalizedActions.sort((a, b) => asciiCompare(a.id, b.id))) {
      if (actions.has(target.id)) {
        throw new PluginHostError([
          {
            phase: 'binding',
            code: 'PLUGIN_HOST_BINDING_INVALID',
            contributionId: target.id,
            summary: `Host action target ${target.id} is duplicated.`,
          },
        ]);
      }
      actions.set(target.id, target);
    }
    for (const target of normalizedWorkflows.sort((a, b) => asciiCompare(a.id, b.id))) {
      if (workflows.has(target.id)) {
        throw new PluginHostError([
          {
            phase: 'binding',
            code: 'PLUGIN_HOST_BINDING_INVALID',
            contributionId: target.id,
            summary: `Host workflow target ${target.id} is duplicated.`,
          },
        ]);
      }
      workflows.set(target.id, target);
    }
    this.#actions = actions;
    this.#workflows = workflows;
    Object.freeze(this);
  }

  getAction(id: string): HostActionTargetFacts | undefined {
    return this.#actions.get(id);
  }

  getWorkflow(id: string): HostWorkflowTargetFacts | undefined {
    return this.#workflows.get(id);
  }

  listActions(): readonly HostActionTargetFacts[] {
    return Object.freeze([...this.#actions.values()]);
  }

  listWorkflows(): readonly HostWorkflowTargetFacts[] {
    return Object.freeze([...this.#workflows.values()]);
  }
}

export function createHostTargetCatalog(seed: HostTargetCatalogSeed): HostTargetCatalog {
  return new HostTargetCatalog(seed);
}

function dataRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key === 'symbol')) return undefined;
    const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !('value' in descriptor)) return undefined;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return undefined;
  }
}

function forbiddenName(name: string): boolean {
  return FORBIDDEN_MAPPING_NAMES.has(name.toLowerCase());
}

function primitiveMatchesType(value: unknown, type: PluginInputType): boolean {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function targetSafetyFindings(
  target: HostAliasTargetFacts | undefined,
  expectedKind: HostAliasTargetFacts['kind'],
  pluginId: string | undefined,
  contributionId: string | undefined,
): PluginHostFinding[] {
  if (!target || !target.exists) {
    return [
      {
        phase: 'validation',
        code: 'PLUGIN_ALIAS_TARGET_NOT_FOUND',
        pluginId,
        contributionId,
        summary: 'The referenced host target does not exist.',
      },
    ];
  }
  const unsafe =
    target.kind !== expectedKind ||
    !target.declarativeAliasAllowed ||
    target.sideEffects ||
    target.risk !== 'none' ||
    target.confirmationRequired ||
    target.exposesSecrets ||
    target.exposesCredentials ||
    target.exposesPaths;
  if (unsafe) {
    return [
      {
        phase: 'validation',
        code: 'PLUGIN_ALIAS_TARGET_UNSAFE',
        pluginId,
        contributionId,
        summary: `Host target ${target.id} is outside the declarative read-only ceiling.`,
      },
    ];
  }
  return [];
}

function validateMappings(
  contributionRecord: Record<string, unknown>,
  target: HostAliasTargetFacts,
  pluginId: string | undefined,
  contributionId: string | undefined,
): PluginHostFinding[] {
  const findings: PluginHostFinding[] = [];
  const inputsValue = contributionRecord.inputs ?? {};
  const mappingValue = contributionRecord.inputMapping ?? {};
  const inputs = dataRecord(inputsValue);
  const mappings = dataRecord(mappingValue);
  if (!inputs || !mappings) {
    return [
      {
        phase: 'validation',
        code: 'PLUGIN_ALIAS_MAPPING_TYPE_MISMATCH',
        pluginId,
        contributionId,
        summary: 'Alias inputs and inputMapping must be plain data objects.',
      },
    ];
  }

  const normalizedInputs = new Map<string, PluginInputDefinitionV1>();
  for (const inputName of Object.keys(inputs).sort(asciiCompare)) {
    const definition = dataRecord(inputs[inputName]);
    if (forbiddenName(inputName)) {
      findings.push({
        phase: 'validation',
        code: 'PLUGIN_ALIAS_MAPPING_FORBIDDEN',
        pluginId,
        contributionId,
        summary: `Input name ${inputName} is forbidden.`,
      });
      continue;
    }
    if (
      !definition ||
      typeof definition.type !== 'string' ||
      !INPUT_TYPES.has(definition.type) ||
      (definition.required !== undefined && typeof definition.required !== 'boolean')
    ) {
      findings.push({
        phase: 'validation',
        code: 'PLUGIN_ALIAS_MAPPING_TYPE_MISMATCH',
        pluginId,
        contributionId,
        summary: `Input definition ${inputName} is invalid.`,
      });
      continue;
    }
    normalizedInputs.set(inputName, {
      type: definition.type as PluginInputType,
      ...(definition.required === undefined ? {} : { required: definition.required }),
    });
  }

  for (const targetName of Object.keys(mappings).sort(asciiCompare)) {
    const binding = dataRecord(mappings[targetName]);
    const targetField = target.inputSchema[targetName];
    if (forbiddenName(targetName)) {
      findings.push({
        phase: 'validation',
        code: 'PLUGIN_ALIAS_MAPPING_FORBIDDEN',
        pluginId,
        contributionId,
        summary: `Target mapping name ${targetName} is forbidden.`,
      });
      continue;
    }
    if (!targetField) {
      findings.push({
        phase: 'validation',
        code: 'PLUGIN_ALIAS_MAPPING_UNKNOWN_TARGET',
        pluginId,
        contributionId,
        summary: `Target input ${targetName} is not in the host schema.`,
      });
      continue;
    }
    if (!binding || (binding.kind !== 'constant' && binding.kind !== 'input')) {
      findings.push({
        phase: 'validation',
        code: 'PLUGIN_ALIAS_MAPPING_TYPE_MISMATCH',
        pluginId,
        contributionId,
        summary: `Mapping for ${targetName} is not a supported scalar binding.`,
      });
      continue;
    }
    if (binding.kind === 'constant') {
      if (!primitiveMatchesType(binding.value, targetField.type)) {
        findings.push({
          phase: 'validation',
          code: 'PLUGIN_ALIAS_MAPPING_TYPE_MISMATCH',
          pluginId,
          contributionId,
          summary: `Constant mapping for ${targetName} does not match ${targetField.type}.`,
        });
      }
      continue;
    }
    if (typeof binding.name !== 'string' || forbiddenName(binding.name)) {
      findings.push({
        phase: 'validation',
        code: 'PLUGIN_ALIAS_MAPPING_FORBIDDEN',
        pluginId,
        contributionId,
        summary: `Input mapping for ${targetName} references a forbidden name.`,
      });
      continue;
    }
    const input = normalizedInputs.get(binding.name);
    if (!input) {
      findings.push({
        phase: 'validation',
        code: 'PLUGIN_ALIAS_MAPPING_UNKNOWN_INPUT',
        pluginId,
        contributionId,
        summary: `Input mapping for ${targetName} references unknown input ${binding.name}.`,
      });
    } else if (
      input.type !== targetField.type ||
      (targetField.required && input.required !== true)
    ) {
      findings.push({
        phase: 'validation',
        code: 'PLUGIN_ALIAS_MAPPING_TYPE_MISMATCH',
        pluginId,
        contributionId,
        summary: `Input ${binding.name} is incompatible with target input ${targetName}.`,
      });
    }
  }

  for (const [targetName, field] of Object.entries(target.inputSchema).sort(([a], [b]) =>
    asciiCompare(a, b),
  )) {
    if (forbiddenName(targetName)) {
      findings.push({
        phase: 'validation',
        code: 'PLUGIN_ALIAS_TARGET_UNSAFE',
        pluginId,
        contributionId,
        summary: `Host target schema exposes forbidden input ${targetName}.`,
      });
    } else if (field.required && !Object.hasOwn(mappings, targetName)) {
      findings.push({
        phase: 'validation',
        code: 'PLUGIN_ALIAS_MAPPING_REQUIRED_TARGET_MISSING',
        pluginId,
        contributionId,
        summary: `Required target input ${targetName} is not mapped.`,
      });
    }
  }
  return findings;
}

export function validateDeclarativeAlias(
  contribution: unknown,
  catalog: HostTargetCatalog,
  pluginId?: string,
): DeclarativeAliasValidationResult {
  const record = dataRecord(contribution);
  const contributionId = typeof record?.id === 'string' ? record.id : undefined;
  if (!record || (record.kind !== 'action_alias' && record.kind !== 'workflow_alias')) {
    return {
      valid: false,
      findings: sortFindings([
        {
          phase: 'validation',
          code: 'PLUGIN_ALIAS_TARGET_FORBIDDEN',
          pluginId,
          contributionId,
          summary: 'Only declarative action_alias and workflow_alias contributions are allowed.',
        },
      ]),
    };
  }

  const targetReference = dataRecord(record.target);
  if (
    !targetReference ||
    typeof targetReference.id !== 'string' ||
    (targetReference.kind !== 'host_action' && targetReference.kind !== 'host_workflow')
  ) {
    return {
      valid: false,
      findings: sortFindings([
        {
          phase: 'validation',
          code: 'PLUGIN_ALIAS_TARGET_FORBIDDEN',
          pluginId,
          contributionId,
          summary: 'Alias target must be a host-owned action or workflow reference.',
        },
      ]),
    };
  }

  const isAction = record.kind === 'action_alias';
  const target = isAction
    ? catalog.getAction(targetReference.id)
    : catalog.getWorkflow(targetReference.id);
  const expectedKind = isAction ? 'host_action' : 'host_workflow';
  const findings = targetSafetyFindings(target, expectedKind, pluginId, contributionId);
  if (target) findings.push(...validateMappings(record, target, pluginId, contributionId));
  if (findings.length > 0) return { valid: false, findings: sortFindings(findings) };

  return isAction
    ? {
        valid: true,
        resolved: {
          kind: 'action_alias',
          contribution: contribution as DeclarativeActionAliasV1,
          target: target as HostActionTargetFacts,
        },
      }
    : {
        valid: true,
        resolved: {
          kind: 'workflow_alias',
          contribution: contribution as DeclarativeWorkflowAliasV1,
          target: target as HostWorkflowTargetFacts,
        },
      };
}

export function assertDeclarativeAlias(
  contribution: DeclarativeContributionV1,
  catalog: HostTargetCatalog,
  pluginId?: string,
): ResolvedDeclarativeAlias {
  const result = validateDeclarativeAlias(contribution, catalog, pluginId);
  if (!result.valid) throw new PluginHostError(result.findings);
  return result.resolved;
}

export function isForbiddenMappingName(name: string): boolean {
  return forbiddenName(name);
}

export type { DeclarativeInputBindingV1 };
