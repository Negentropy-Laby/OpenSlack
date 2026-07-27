import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalJson, type AuthorityRef } from '@openslack/organization-graph';
import {
  assertCapabilitiesGranted,
  resolveEffectiveCapabilities,
  SCENARIO_RISK_LEVELS,
  type ScenarioRisk,
} from './capabilities.js';
import { ScenarioHostCatalog } from './catalog.js';
import { assertLoadedScenarioDefinition, type LoadedScenarioDefinition } from './pack-loader.js';
import {
  deriveScenarioInstanceId,
  trustValidatedScenarioInstance,
  SCENARIO_INSTANCE_SCHEMA,
  validateScenarioInstance,
  type ScenarioInstance,
} from './instance.js';
import {
  normalizeWorkflowPermissions,
  type ScenarioWorkflowPermissions,
} from './permission-normalizer.js';

export interface ScenarioPlanCapability {
  readonly id: string;
  readonly adapterId: string;
  readonly risk: ScenarioRisk;
  readonly readOnly: boolean;
  readonly approvalRequired: boolean;
}

export interface ScenarioPlanWorkflow {
  readonly id: string;
  readonly version: string;
  readonly adapterId: string;
  readonly capabilityIds: readonly string[];
}

export interface ScenarioInstantiateEffect {
  readonly kind: 'scenario.instantiate';
  readonly effectId: string;
  readonly risk: ScenarioRisk;
  readonly summary: string;
  readonly payload: {
    readonly schema: 'openslack.scenario_instantiate.v1';
    readonly scenarioInstanceId: string;
    readonly definitionId: string;
    readonly definitionVersion: string;
    readonly definitionHash: string;
    readonly correlationId: string;
    readonly inputHash: string;
    readonly targetScopeHash: string;
    readonly normalizedInput: unknown;
    readonly targetRefs: readonly AuthorityRef[];
  };
}

export interface ScenarioWorkflowStartEffect {
  readonly kind: 'workflow.start';
  readonly effectId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly adapterId: string;
  readonly capabilityIds: readonly string[];
  readonly risk: ScenarioRisk;
  readonly summary: string;
  readonly payload: {
    readonly schema: 'openslack.scenario_workflow_start.v1';
    readonly scenarioInstanceId: string;
    readonly definitionId: string;
    readonly definitionVersion: string;
    readonly definitionHash: string;
    readonly workflowId: string;
    readonly workflowVersion: string;
    readonly adapterId: string;
    readonly correlationId: string;
    readonly inputHash: string;
    readonly targetScopeHash: string;
    readonly normalizedInput: unknown;
    readonly targetRefs: readonly AuthorityRef[];
    readonly capabilityIds: readonly string[];
  };
}

export type ScenarioPlanEffect = ScenarioInstantiateEffect | ScenarioWorkflowStartEffect;

export interface ScenarioInstantiationPlan {
  readonly schema: 'openslack.scenario_plan.v1';
  readonly planId: string;
  readonly planHash: string;
  readonly scenarioInstanceId: string;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly definitionHash: string;
  readonly correlationId: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly normalizedInput: unknown;
  readonly inputHash: string;
  readonly targetScopeHash: string;
  readonly targetRefs: readonly AuthorityRef[];
  readonly workflows: readonly ScenarioPlanWorkflow[];
  readonly capabilities: readonly ScenarioPlanCapability[];
  readonly effects: readonly ScenarioPlanEffect[];
  readonly risk: ScenarioRisk;
  readonly approvalPoints: readonly {
    readonly kind: 'openslack_workflow_effect';
    readonly capabilityId: string;
  }[];
  readonly expectedOutcomes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PreviewScenarioInput {
  readonly definition: LoadedScenarioDefinition;
  readonly catalog: ScenarioHostCatalog;
  readonly input: unknown;
  readonly targetRefs: readonly AuthorityRef[];
  readonly actor: {
    readonly id: string;
    readonly permissions: ScenarioWorkflowPermissions;
  };
  readonly workspaceId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PersistedScenarioPlanBinding {
  readonly planHash: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly correlationId: string;
  readonly definitionHash: string;
  readonly now: string;
}

const SEALED_PLANS = new WeakSet<object>();

export function assertScenarioInstantiationPlan(
  value: unknown,
): asserts value is ScenarioInstantiationPlan {
  if (typeof value !== 'object' || value === null || !SEALED_PLANS.has(value)) {
    return previewFail(
      'SCENARIO_PREVIEW_INPUT_INVALID',
      'A planner-produced immutable Scenario Plan is required.',
    );
  }
}

export class ScenarioPlannerError extends Error {
  readonly code:
    | 'SCENARIO_PREVIEW_INPUT_INVALID'
    | 'SCENARIO_PREVIEW_SCOPE_INVALID'
    | 'SCENARIO_PREVIEW_EXPIRED'
    | 'SCENARIO_PREVIEW_CATALOG_MISMATCH'
    | 'SCENARIO_PERSISTED_PLAN_INVALID'
    | 'SCENARIO_PERSISTED_PLAN_BINDING_MISMATCH';

  constructor(code: ScenarioPlannerError['code'], message: string) {
    super(message);
    this.name = 'ScenarioPlannerError';
    this.code = code;
  }
}

const SAFE_IDENTIFIER = /^[^\u0000-\u001f\u007f/\\]+$/;
const SECRET_KEY =
  /(?:password|credential|privatekey|accesstoken|refreshtoken|githubtoken|apikey|secret)$/i;
// All call sites check their UTF-8 byte limit before applying the credential pattern.
const SECRET_VALUE = /-----BEGIN|\b(?:gh[pousr]_|github_pat_|xox[a-z]-|sk-|AKIA[A-Z0-9]{16})/i;
const HOST_OWNED_INPUT_KEY =
  /(?:allowunattended|confirmstep|path|module|entrypoint|command|shell|credential|token|authentication|(?:repo|repository)$|^owner$|^auth$)/i;

function previewFail(code: ScenarioPlannerError['code'], message: string): never {
  throw new ScenarioPlannerError(code, message);
}

function requireCatalogCapability(catalog: ScenarioHostCatalog, id: string) {
  const capability = catalog.capability(id);
  if (!capability) {
    return previewFail(
      'SCENARIO_PREVIEW_CATALOG_MISMATCH',
      `The sealed host catalog does not contain capability ${id}.`,
    );
  }
  return capability;
}

function requireCatalogWorkflow(catalog: ScenarioHostCatalog, id: string) {
  const workflow = catalog.workflow(id);
  if (!workflow) {
    return previewFail(
      'SCENARIO_PREVIEW_CATALOG_MISMATCH',
      `The sealed host catalog does not contain workflow ${id}.`,
    );
  }
  return workflow;
}

function cloneInput(
  value: unknown,
  path: string,
  depth: number,
  state: { nodes: number },
): unknown {
  if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
    if (nodeTypes.isProxy(value)) {
      return previewFail('SCENARIO_PREVIEW_INPUT_INVALID', 'Preview input proxies are forbidden.');
    }
  }
  state.nodes += 1;
  if (depth > 8 || state.nodes > 5_000) {
    return previewFail(
      'SCENARIO_PREVIEW_INPUT_INVALID',
      'Preview input exceeds structural limits.',
    );
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return previewFail(
        'SCENARIO_PREVIEW_INPUT_INVALID',
        'Preview input has a non-finite number.',
      );
    }
    return value;
  }
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 8_192 || SECRET_VALUE.test(value)) {
      return previewFail(
        'SCENARIO_PREVIEW_INPUT_INVALID',
        'Preview input has an oversized or credential-like value.',
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 200) {
      return previewFail('SCENARIO_PREVIEW_INPUT_INVALID', 'Preview input array is invalid.');
    }
    const result: unknown[] = [];
    const expected = new Set(['length']);
    for (let index = 0; index < value.length; index += 1) {
      expected.add(String(index));
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        return previewFail('SCENARIO_PREVIEW_INPUT_INVALID', 'Preview input arrays must be inert.');
      }
      result.push(cloneInput(descriptor.value, `${path}/${index}`, depth + 1, state));
    }
    if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !expected.has(key))) {
      return previewFail(
        'SCENARIO_PREVIEW_INPUT_INVALID',
        'Preview input arrays cannot have named fields.',
      );
    }
    return result;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return previewFail('SCENARIO_PREVIEW_INPUT_INVALID', 'Preview input must be inert plain data.');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64) {
    return previewFail('SCENARIO_PREVIEW_INPUT_INVALID', 'Preview input object is too large.');
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const normalizedKey =
      typeof key === 'string' ? key.replaceAll('-', '').replaceAll('_', '') : '';
    if (
      typeof key !== 'string' ||
      SECRET_KEY.test(normalizedKey) ||
      HOST_OWNED_INPUT_KEY.test(normalizedKey)
    ) {
      return previewFail('SCENARIO_PREVIEW_INPUT_INVALID', 'Preview input has a forbidden field.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return previewFail(
        'SCENARIO_PREVIEW_INPUT_INVALID',
        'Preview input accessors are forbidden.',
      );
    }
    Object.defineProperty(result, key, {
      value: cloneInput(descriptor.value, `${path}/${key}`, depth + 1, state),
      enumerable: true,
    });
  }
  return result;
}

/**
 * Convert untrusted Scenario input into the canonical inert data carried by the persisted plan.
 *
 * This is deliberately narrower than structuredClone: accessors, proxies, credential-like
 * fields/values, sparse arrays, exotic prototypes, non-finite numbers, and oversized graphs fail
 * closed. The returned value is detached and deeply immutable.
 */
export function normalizeScenarioPlanInput(value: unknown): unknown {
  const normalized = cloneInput(value, '/input', 1, { nodes: 0 });
  const serialized = canonicalJson(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > 256 * 1024) {
    return previewFail('SCENARIO_PREVIEW_INPUT_INVALID', 'Preview input exceeds byte limits.');
  }
  return freeze(normalized);
}

function timestamp(value: string, field: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    return previewFail('SCENARIO_PREVIEW_INPUT_INVALID', `${field} must be canonical RFC3339.`);
  }
  return value;
}

function identifier(value: string, field: string): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 512 ||
    !SAFE_IDENTIFIER.test(value)
  ) {
    return previewFail('SCENARIO_PREVIEW_INPUT_INVALID', `${field} is invalid.`);
  }
  return value;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function freeze<T>(value: T): T {
  if (Array.isArray(value)) value.forEach(freeze);
  else if (typeof value === 'object' && value !== null) Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

type DataRecord = Record<string, unknown>;

function persistedFail(
  code:
    | 'SCENARIO_PERSISTED_PLAN_INVALID'
    | 'SCENARIO_PERSISTED_PLAN_BINDING_MISMATCH'
    | 'SCENARIO_PREVIEW_EXPIRED',
  message: string,
): never {
  throw new ScenarioPlannerError(code, message);
}

function closedRecord(value: unknown, fields: readonly string[], label: string): DataRecord {
  if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
    if (nodeTypes.isProxy(value)) {
      return persistedFail('SCENARIO_PERSISTED_PLAN_INVALID', `${label} cannot be a Proxy.`);
    }
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      `${label} must be an inert data object.`,
    );
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      `${label} has missing or unknown fields.`,
    );
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== 'string' ||
      !descriptor ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return persistedFail(
        'SCENARIO_PERSISTED_PLAN_INVALID',
        `${label} must contain only enumerable data fields.`,
      );
    }
  }
  return value as DataRecord;
}

function own(record: DataRecord, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function inertDiscriminator(value: unknown, label: string): string {
  if ((typeof value === 'object' || typeof value === 'function') && value !== null) {
    if (nodeTypes.isProxy(value)) {
      return persistedFail('SCENARIO_PERSISTED_PLAN_INVALID', `${label} cannot be a Proxy.`);
    }
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value) as never)
  ) {
    return persistedFail('SCENARIO_PERSISTED_PLAN_INVALID', `${label} must be inert data.`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      `${label}/kind must be an enumerable data field.`,
    );
  }
  return persistedText(descriptor.value, `${label}/kind`, 64);
}

function persistedText(value: unknown, label: string, maxBytes: number, pattern?: RegExp): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > maxBytes ||
    (pattern !== undefined && !pattern.test(value)) ||
    SECRET_VALUE.test(value)
  ) {
    return persistedFail('SCENARIO_PERSISTED_PLAN_INVALID', `${label} is invalid.`);
  }
  return value;
}

function denseArray(value: unknown, label: string, maxItems: number): readonly unknown[] {
  if (nodeTypes.isProxy(value)) {
    return persistedFail('SCENARIO_PERSISTED_PLAN_INVALID', `${label} cannot be a Proxy.`);
  }
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maxItems
  ) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      `${label} must be a bounded dense array.`,
    );
  }
  const expected = new Set(['length']);
  for (let index = 0; index < value.length; index += 1) {
    expected.add(String(index));
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return persistedFail(
        'SCENARIO_PERSISTED_PLAN_INVALID',
        `${label} must contain only data values.`,
      );
    }
  }
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !expected.has(key))) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      `${label} cannot contain named or symbol fields.`,
    );
  }
  return value;
}

function persistedStrings(
  value: unknown,
  label: string,
  maxItems: number,
  pattern?: RegExp,
): readonly string[] {
  const result = denseArray(value, label, maxItems).map((item, index) =>
    persistedText(item, `${label}/${index}`, 512, pattern),
  );
  if (new Set(result).size !== result.length) {
    return persistedFail('SCENARIO_PERSISTED_PLAN_INVALID', `${label} contains duplicates.`);
  }
  return Object.freeze(result);
}

const HASH = /^[0-9a-f]{64}$/;
const CATALOG_ID = /^[a-z][A-Za-z0-9_-]*(?:\.[a-z][A-Za-z0-9_-]*)*$/;
const DEFINITION_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function persistedRisk(value: unknown, label: string): ScenarioRisk {
  if (typeof value !== 'string' || !SCENARIO_RISK_LEVELS.includes(value as ScenarioRisk)) {
    return persistedFail('SCENARIO_PERSISTED_PLAN_INVALID', `${label} is invalid.`);
  }
  return value as ScenarioRisk;
}

function persistedBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    return persistedFail('SCENARIO_PERSISTED_PLAN_INVALID', `${label} is invalid.`);
  }
  return value;
}

function normalizePersistedTargets(
  value: unknown,
  plan: {
    readonly definitionId: string;
    readonly definitionVersion: string;
    readonly definitionHash: string;
    readonly correlationId: string;
    readonly createdAt: string;
  },
): readonly AuthorityRef[] {
  const values = denseArray(value, 'targetRefs', 50);
  return validateScenarioInstance({
    schema: SCENARIO_INSTANCE_SCHEMA,
    id: 'persisted-target-validator',
    definitionId: plan.definitionId,
    definitionVersion: plan.definitionVersion,
    definitionHash: plan.definitionHash,
    correlationId: plan.correlationId,
    state: 'previewed',
    targetRefs: values,
    workflowRunIds: [],
    planId: 'persisted-plan-validator',
    planHash: '0'.repeat(64),
    createdAt: plan.createdAt,
    updatedAt: plan.createdAt,
    evidenceRefs: [`scenario-definition:sha256:${plan.definitionHash}`],
  }).targetRefs;
}

function maxRisk(values: readonly ScenarioPlanCapability[]): ScenarioRisk {
  return values.reduce<ScenarioRisk>(
    (current, value) =>
      SCENARIO_RISK_LEVELS.indexOf(value.risk) > SCENARIO_RISK_LEVELS.indexOf(current)
        ? value.risk
        : current,
    'none',
  );
}

export function previewScenario(input: PreviewScenarioInput): ScenarioInstantiationPlan {
  assertLoadedScenarioDefinition(input.definition);
  ScenarioHostCatalog.assertSealed(input.catalog);
  const normalizedInput = normalizeScenarioPlanInput(input.input);
  const serializedInput = canonicalJson(normalizedInput);
  const actorId = identifier(input.actor.id, 'actor.id');
  const workspaceId = identifier(input.workspaceId, 'workspaceId');
  const correlationId = identifier(input.correlationId, 'correlationId');
  const createdAt = timestamp(input.createdAt, 'createdAt');
  const expiresAt = timestamp(input.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    return previewFail('SCENARIO_PREVIEW_EXPIRED', 'Preview expiry must follow creation time.');
  }

  const requested = input.definition.capabilities.requested;
  const actorCapabilities = normalizeWorkflowPermissions(
    input.actor.permissions,
    input.catalog.capabilityIds(),
  );
  const resolution = resolveEffectiveCapabilities({
    requested,
    actorGranted: actorCapabilities,
    knownCapabilityIds: input.catalog.capabilityIds(),
  });
  assertCapabilitiesGranted(resolution);

  // Reuse the closed instance validator only to canonicalize targetRefs. The synthetic identifiers
  // satisfy its structural contract; the temporary instance is discarded and never trusted.
  const validatedTargets = validateScenarioInstance({
    schema: SCENARIO_INSTANCE_SCHEMA,
    id: 'preview-target-validator',
    definitionId: input.definition.manifest.id,
    definitionVersion: input.definition.manifest.version,
    definitionHash: input.definition.definitionHash,
    correlationId,
    state: 'previewed',
    targetRefs: input.targetRefs,
    workflowRunIds: [],
    planId: 'preview-plan-validator',
    planHash: '0'.repeat(64),
    createdAt,
    updatedAt: createdAt,
    evidenceRefs: [`scenario-definition:sha256:${input.definition.definitionHash}`],
  }).targetRefs;
  const identityVersions = new Map<string, string>();
  for (const target of validatedTargets) {
    const identity = canonicalJson({
      provider: target.provider,
      objectType: target.objectType,
      objectId: target.objectId,
    });
    const prior = identityVersions.get(identity);
    if (prior !== undefined) {
      return previewFail(
        'SCENARIO_PREVIEW_SCOPE_INVALID',
        prior === target.version
          ? 'Target scope contains a duplicate authority identity.'
          : 'Target scope contains conflicting authority versions.',
      );
    }
    identityVersions.set(identity, target.version);
  }
  const targetClone = Object.freeze(
    [...validatedTargets].sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right), 'en'),
    ),
  );
  if (
    !input.definition.policies.constraints.allowExternalTargets &&
    targetClone.some((target) => !['github', 'openslack', 'demo_fixture'].includes(target.provider))
  ) {
    return previewFail(
      'SCENARIO_PREVIEW_SCOPE_INVALID',
      'Target scope exceeds the narrowed Scenario Pack policy.',
    );
  }

  const capabilities = resolution.effective.map((id) => {
    const capability = requireCatalogCapability(input.catalog, id);
    return Object.freeze({ ...capability });
  });
  const workflows = input.definition.workflows.workflows.map((reference) => {
    const workflow = requireCatalogWorkflow(input.catalog, reference.id);
    return Object.freeze({
      id: workflow.id,
      version: workflow.version,
      adapterId: workflow.adapterId,
      capabilityIds: Object.freeze([...reference.capabilityIds]),
    });
  });
  const inputHash = createHash('sha256').update(serializedInput, 'utf8').digest('hex');
  const targetScopeHash = hash(
    targetClone.map((target) => ({
      provider: target.provider,
      objectType: target.objectType,
      objectId: target.objectId,
      version: target.version,
    })),
  );
  const scenarioInstanceId = deriveScenarioInstanceId({
    definitionHash: input.definition.definitionHash,
    inputHash,
    targetScopeHash,
  });
  const instantiatePayload = Object.freeze({
    schema: 'openslack.scenario_instantiate.v1' as const,
    scenarioInstanceId,
    definitionId: input.definition.manifest.id,
    definitionVersion: input.definition.manifest.version,
    definitionHash: input.definition.definitionHash,
    correlationId,
    inputHash,
    targetScopeHash,
    normalizedInput,
    targetRefs: targetClone,
  });
  const instantiateEffect = Object.freeze({
    kind: 'scenario.instantiate' as const,
    effectId: `scenario-effect:sha256:${hash(instantiatePayload)}`,
    risk: maxRisk(capabilities),
    summary: `Instantiate registered scenario ${input.definition.manifest.id}.`,
    payload: instantiatePayload,
  });
  const workflowEffects = workflows.map((workflow) => {
    const workflowCapabilities = workflow.capabilityIds.map(
      (capability) => input.catalog.capability(capability)!,
    );
    const payload = Object.freeze({
      schema: 'openslack.scenario_workflow_start.v1' as const,
      scenarioInstanceId,
      definitionId: input.definition.manifest.id,
      definitionVersion: input.definition.manifest.version,
      definitionHash: input.definition.definitionHash,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      adapterId: workflow.adapterId,
      correlationId,
      inputHash,
      targetScopeHash,
      normalizedInput,
      targetRefs: targetClone,
      capabilityIds: workflow.capabilityIds,
    });
    const effectHash = hash(payload);
    return Object.freeze({
      kind: 'workflow.start' as const,
      effectId: `scenario-effect:sha256:${effectHash}`,
      workflowId: workflow.id,
      workflowVersion: workflow.version,
      adapterId: workflow.adapterId,
      capabilityIds: workflow.capabilityIds,
      risk: maxRisk(workflowCapabilities),
      summary: `Start registered workflow ${workflow.id}.`,
      payload,
    });
  });
  const effects = Object.freeze([instantiateEffect, ...workflowEffects]);
  const unsigned = {
    schema: 'openslack.scenario_plan.v1' as const,
    scenarioInstanceId,
    definitionId: input.definition.manifest.id,
    definitionVersion: input.definition.manifest.version,
    definitionHash: input.definition.definitionHash,
    correlationId,
    actorId,
    workspaceId,
    normalizedInput,
    inputHash,
    targetScopeHash,
    targetRefs: targetClone,
    workflows,
    capabilities,
    effects,
    risk: maxRisk(capabilities),
    approvalPoints: capabilities
      .filter((capability) => capability.approvalRequired)
      .map((capability) =>
        Object.freeze({
          kind: 'openslack_workflow_effect' as const,
          capabilityId: capability.id,
        }),
      ),
    expectedOutcomes: Object.freeze(input.definition.ontology.types.map((type) => type.id).sort()),
    evidenceRefs: Object.freeze([
      `scenario-definition:sha256:${input.definition.definitionHash}`,
      ...input.definition.files.map((file) => `scenario-file:${file.path}@sha256:${file.sha256}`),
    ]),
    createdAt,
    expiresAt,
  };
  const planHash = hash(unsigned);
  const plan = freeze({
    ...unsigned,
    planId: `scenario-plan:sha256:${planHash}`,
    planHash,
  });
  SEALED_PLANS.add(plan);
  return plan;
}

/**
 * Rehydrate an immutable Scenario plan from JSON data after proving it still matches the
 * host-owned persistence binding.
 *
 * The SHA-256 value is an integrity identifier, not an authorization token. Callers must supply
 * the binding captured by their governed plan store; accepting fields from the same untrusted
 * request as `expected` would defeat this boundary.
 */
export function rehydrateScenarioInstantiationPlan(
  value: unknown,
  expectedValue: PersistedScenarioPlanBinding,
): ScenarioInstantiationPlan {
  const expected = closedRecord(
    expectedValue,
    ['planHash', 'actorId', 'workspaceId', 'correlationId', 'definitionHash', 'now'],
    'persisted Scenario plan binding',
  );
  const expectedPlanHash = persistedText(own(expected, 'planHash'), 'binding.planHash', 64, HASH);
  const expectedActorId = identifier(
    persistedText(own(expected, 'actorId'), 'binding.actorId', 512),
    'binding.actorId',
  );
  const expectedWorkspaceId = identifier(
    persistedText(own(expected, 'workspaceId'), 'binding.workspaceId', 512),
    'binding.workspaceId',
  );
  const expectedCorrelationId = identifier(
    persistedText(own(expected, 'correlationId'), 'binding.correlationId', 512),
    'binding.correlationId',
  );
  const expectedDefinitionHash = persistedText(
    own(expected, 'definitionHash'),
    'binding.definitionHash',
    64,
    HASH,
  );
  const now = timestamp(persistedText(own(expected, 'now'), 'binding.now', 64), 'binding.now');

  const record = closedRecord(
    value,
    [
      'schema',
      'planId',
      'planHash',
      'scenarioInstanceId',
      'definitionId',
      'definitionVersion',
      'definitionHash',
      'correlationId',
      'actorId',
      'workspaceId',
      'normalizedInput',
      'inputHash',
      'targetScopeHash',
      'targetRefs',
      'workflows',
      'capabilities',
      'effects',
      'risk',
      'approvalPoints',
      'expectedOutcomes',
      'evidenceRefs',
      'createdAt',
      'expiresAt',
    ],
    'persisted Scenario plan',
  );
  if (own(record, 'schema') !== 'openslack.scenario_plan.v1') {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      'Persisted Scenario plan schema is unsupported.',
    );
  }
  const definitionId = persistedText(
    own(record, 'definitionId'),
    'definitionId',
    64,
    DEFINITION_ID,
  );
  const definitionVersion = persistedText(
    own(record, 'definitionVersion'),
    'definitionVersion',
    128,
  );
  const definitionHash = persistedText(own(record, 'definitionHash'), 'definitionHash', 64, HASH);
  const correlationId = identifier(
    persistedText(own(record, 'correlationId'), 'correlationId', 512),
    'correlationId',
  );
  const actorId = identifier(persistedText(own(record, 'actorId'), 'actorId', 512), 'actorId');
  const workspaceId = identifier(
    persistedText(own(record, 'workspaceId'), 'workspaceId', 512),
    'workspaceId',
  );
  const createdAt = timestamp(
    persistedText(own(record, 'createdAt'), 'createdAt', 64),
    'createdAt',
  );
  const expiresAt = timestamp(
    persistedText(own(record, 'expiresAt'), 'expiresAt', 64),
    'expiresAt',
  );
  if (Date.parse(expiresAt) <= Date.parse(createdAt) || Date.parse(now) >= Date.parse(expiresAt)) {
    return persistedFail('SCENARIO_PREVIEW_EXPIRED', 'Persisted Scenario plan has expired.');
  }
  const normalizedInput = normalizeScenarioPlanInput(own(record, 'normalizedInput'));
  const inputHash = persistedText(own(record, 'inputHash'), 'inputHash', 64, HASH);
  if (hash(normalizedInput) !== inputHash) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      'Persisted Scenario input hash does not match normalized input.',
    );
  }
  const targetRefs = normalizePersistedTargets(own(record, 'targetRefs'), {
    definitionId,
    definitionVersion,
    definitionHash,
    correlationId,
    createdAt,
  });
  const identityVersions = new Set<string>();
  for (const target of targetRefs) {
    const identity = canonicalJson({
      provider: target.provider,
      objectType: target.objectType,
      objectId: target.objectId,
    });
    if (identityVersions.has(identity)) {
      return persistedFail(
        'SCENARIO_PERSISTED_PLAN_INVALID',
        'Persisted Scenario target scope contains duplicate authority identities.',
      );
    }
    identityVersions.add(identity);
  }
  const targetScopeHash = persistedText(
    own(record, 'targetScopeHash'),
    'targetScopeHash',
    64,
    HASH,
  );
  const computedTargetScopeHash = hash(
    targetRefs.map((target) => ({
      provider: target.provider,
      objectType: target.objectType,
      objectId: target.objectId,
      version: target.version,
    })),
  );
  if (computedTargetScopeHash !== targetScopeHash) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      'Persisted Scenario target scope hash does not match its references.',
    );
  }
  const scenarioInstanceId = persistedText(
    own(record, 'scenarioInstanceId'),
    'scenarioInstanceId',
    512,
  );
  if (
    deriveScenarioInstanceId({ definitionHash, inputHash, targetScopeHash }) !== scenarioInstanceId
  ) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      'Persisted Scenario instance identity is inconsistent.',
    );
  }

  const workflows = Object.freeze(
    denseArray(own(record, 'workflows'), 'workflows', 100).map((item, index) => {
      const workflow = closedRecord(
        item,
        ['id', 'version', 'adapterId', 'capabilityIds'],
        `workflows/${index}`,
      );
      return Object.freeze({
        id: persistedText(own(workflow, 'id'), `workflows/${index}/id`, 128, CATALOG_ID),
        version: persistedText(own(workflow, 'version'), `workflows/${index}/version`, 128),
        adapterId: persistedText(
          own(workflow, 'adapterId'),
          `workflows/${index}/adapterId`,
          128,
          CATALOG_ID,
        ),
        capabilityIds: persistedStrings(
          own(workflow, 'capabilityIds'),
          `workflows/${index}/capabilityIds`,
          128,
          CATALOG_ID,
        ),
      });
    }),
  );
  if (new Set(workflows.map((workflow) => workflow.id)).size !== workflows.length) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      'Persisted Scenario workflows contain duplicate IDs.',
    );
  }
  const capabilities = Object.freeze(
    denseArray(own(record, 'capabilities'), 'capabilities', 256).map((item, index) => {
      const capability = closedRecord(
        item,
        ['id', 'adapterId', 'risk', 'readOnly', 'approvalRequired'],
        `capabilities/${index}`,
      );
      const readOnly = persistedBoolean(
        own(capability, 'readOnly'),
        `capabilities/${index}/readOnly`,
      );
      const approvalRequired = persistedBoolean(
        own(capability, 'approvalRequired'),
        `capabilities/${index}/approvalRequired`,
      );
      if (readOnly && approvalRequired) {
        return persistedFail(
          'SCENARIO_PERSISTED_PLAN_INVALID',
          'Read-only Scenario capabilities cannot require approval.',
        );
      }
      return Object.freeze({
        id: persistedText(own(capability, 'id'), `capabilities/${index}/id`, 128, CATALOG_ID),
        adapterId: persistedText(
          own(capability, 'adapterId'),
          `capabilities/${index}/adapterId`,
          128,
          CATALOG_ID,
        ),
        risk: persistedRisk(own(capability, 'risk'), `capabilities/${index}/risk`),
        readOnly,
        approvalRequired,
      });
    }),
  );
  const capabilityById = new Map(capabilities.map((capability) => [capability.id, capability]));
  if (capabilityById.size !== capabilities.length) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      'Persisted Scenario capabilities contain duplicate IDs.',
    );
  }
  for (const workflow of workflows) {
    for (const capabilityId of workflow.capabilityIds) {
      if (!capabilityById.has(capabilityId)) {
        return persistedFail(
          'SCENARIO_PERSISTED_PLAN_INVALID',
          `Persisted workflow ${workflow.id} references an unavailable capability.`,
        );
      }
    }
  }

  const effects = Object.freeze(
    denseArray(own(record, 'effects'), 'effects', 100).map((item, index) => {
      const kind = inertDiscriminator(item, `effects/${index}`);
      if (kind === 'scenario.instantiate') {
        const effect = closedRecord(
          item,
          ['kind', 'effectId', 'risk', 'summary', 'payload'],
          `effects/${index}`,
        );
        const payloadRecord = closedRecord(
          own(effect, 'payload'),
          [
            'schema',
            'scenarioInstanceId',
            'definitionId',
            'definitionVersion',
            'definitionHash',
            'correlationId',
            'inputHash',
            'targetScopeHash',
            'normalizedInput',
            'targetRefs',
          ],
          `effects/${index}/payload`,
        );
        if (own(payloadRecord, 'schema') !== 'openslack.scenario_instantiate.v1') {
          return persistedFail(
            'SCENARIO_PERSISTED_PLAN_INVALID',
            `effects/${index}/payload schema is unsupported.`,
          );
        }
        const payload = Object.freeze({
          schema: 'openslack.scenario_instantiate.v1' as const,
          scenarioInstanceId: persistedText(
            own(payloadRecord, 'scenarioInstanceId'),
            `effects/${index}/payload/scenarioInstanceId`,
            512,
          ),
          definitionId: persistedText(
            own(payloadRecord, 'definitionId'),
            `effects/${index}/payload/definitionId`,
            64,
            DEFINITION_ID,
          ),
          definitionVersion: persistedText(
            own(payloadRecord, 'definitionVersion'),
            `effects/${index}/payload/definitionVersion`,
            128,
          ),
          definitionHash: persistedText(
            own(payloadRecord, 'definitionHash'),
            `effects/${index}/payload/definitionHash`,
            64,
            HASH,
          ),
          correlationId: identifier(
            persistedText(
              own(payloadRecord, 'correlationId'),
              `effects/${index}/payload/correlationId`,
              512,
            ),
            `effects/${index}/payload/correlationId`,
          ),
          inputHash: persistedText(
            own(payloadRecord, 'inputHash'),
            `effects/${index}/payload/inputHash`,
            64,
            HASH,
          ),
          targetScopeHash: persistedText(
            own(payloadRecord, 'targetScopeHash'),
            `effects/${index}/payload/targetScopeHash`,
            64,
            HASH,
          ),
          normalizedInput: normalizeScenarioPlanInput(own(payloadRecord, 'normalizedInput')),
          targetRefs: Object.freeze(
            normalizePersistedTargets(own(payloadRecord, 'targetRefs'), {
              definitionId,
              definitionVersion,
              definitionHash,
              correlationId,
              createdAt,
            }),
          ),
        });
        if (
          payload.scenarioInstanceId !== scenarioInstanceId ||
          payload.definitionId !== definitionId ||
          payload.definitionVersion !== definitionVersion ||
          payload.definitionHash !== definitionHash ||
          payload.correlationId !== correlationId ||
          payload.inputHash !== inputHash ||
          payload.targetScopeHash !== targetScopeHash ||
          canonicalJson(payload.normalizedInput) !== canonicalJson(normalizedInput) ||
          canonicalJson(payload.targetRefs) !== canonicalJson(targetRefs)
        ) {
          return persistedFail(
            'SCENARIO_PERSISTED_PLAN_INVALID',
            `effects/${index} is not bound to the persisted Scenario plan.`,
          );
        }
        const effectId = persistedText(own(effect, 'effectId'), `effects/${index}/effectId`, 96);
        if (effectId !== `scenario-effect:sha256:${hash(payload)}`) {
          return persistedFail(
            'SCENARIO_PERSISTED_PLAN_INVALID',
            `effects/${index}/effectId is inconsistent.`,
          );
        }
        const effectRisk = persistedRisk(own(effect, 'risk'), `effects/${index}/risk`);
        if (effectRisk !== maxRisk(capabilities)) {
          return persistedFail(
            'SCENARIO_PERSISTED_PLAN_INVALID',
            `effects/${index}/risk is inconsistent.`,
          );
        }
        return Object.freeze({
          kind: 'scenario.instantiate' as const,
          effectId,
          risk: effectRisk,
          summary: persistedText(own(effect, 'summary'), `effects/${index}/summary`, 1_024),
          payload,
        });
      }
      const effect = closedRecord(
        item,
        [
          'kind',
          'effectId',
          'workflowId',
          'workflowVersion',
          'adapterId',
          'capabilityIds',
          'risk',
          'summary',
          'payload',
        ],
        `effects/${index}`,
      );
      if (kind !== 'workflow.start') {
        return persistedFail(
          'SCENARIO_PERSISTED_PLAN_INVALID',
          `effects/${index}/kind is unsupported.`,
        );
      }
      const workflowId = persistedText(
        own(effect, 'workflowId'),
        `effects/${index}/workflowId`,
        128,
        CATALOG_ID,
      );
      const workflowVersion = persistedText(
        own(effect, 'workflowVersion'),
        `effects/${index}/workflowVersion`,
        128,
      );
      const adapterId = persistedText(
        own(effect, 'adapterId'),
        `effects/${index}/adapterId`,
        128,
        CATALOG_ID,
      );
      const capabilityIds = persistedStrings(
        own(effect, 'capabilityIds'),
        `effects/${index}/capabilityIds`,
        128,
        CATALOG_ID,
      );
      const payloadRecord = closedRecord(
        own(effect, 'payload'),
        [
          'schema',
          'scenarioInstanceId',
          'definitionId',
          'definitionVersion',
          'definitionHash',
          'workflowId',
          'workflowVersion',
          'adapterId',
          'correlationId',
          'inputHash',
          'targetScopeHash',
          'normalizedInput',
          'targetRefs',
          'capabilityIds',
        ],
        `effects/${index}/payload`,
      );
      if (own(payloadRecord, 'schema') !== 'openslack.scenario_workflow_start.v1') {
        return persistedFail(
          'SCENARIO_PERSISTED_PLAN_INVALID',
          `effects/${index}/payload schema is unsupported.`,
        );
      }
      const payloadInput = normalizeScenarioPlanInput(own(payloadRecord, 'normalizedInput'));
      const payloadTargets = normalizePersistedTargets(own(payloadRecord, 'targetRefs'), {
        definitionId,
        definitionVersion,
        definitionHash,
        correlationId,
        createdAt,
      });
      const payloadCapabilities = persistedStrings(
        own(payloadRecord, 'capabilityIds'),
        `effects/${index}/payload/capabilityIds`,
        128,
        CATALOG_ID,
      );
      const payload = Object.freeze({
        schema: 'openslack.scenario_workflow_start.v1' as const,
        scenarioInstanceId: persistedText(
          own(payloadRecord, 'scenarioInstanceId'),
          `effects/${index}/payload/scenarioInstanceId`,
          512,
        ),
        definitionId: persistedText(
          own(payloadRecord, 'definitionId'),
          `effects/${index}/payload/definitionId`,
          64,
          DEFINITION_ID,
        ),
        definitionVersion: persistedText(
          own(payloadRecord, 'definitionVersion'),
          `effects/${index}/payload/definitionVersion`,
          128,
        ),
        definitionHash: persistedText(
          own(payloadRecord, 'definitionHash'),
          `effects/${index}/payload/definitionHash`,
          64,
          HASH,
        ),
        workflowId: persistedText(
          own(payloadRecord, 'workflowId'),
          `effects/${index}/payload/workflowId`,
          128,
          CATALOG_ID,
        ),
        workflowVersion: persistedText(
          own(payloadRecord, 'workflowVersion'),
          `effects/${index}/payload/workflowVersion`,
          128,
        ),
        adapterId: persistedText(
          own(payloadRecord, 'adapterId'),
          `effects/${index}/payload/adapterId`,
          128,
          CATALOG_ID,
        ),
        correlationId: identifier(
          persistedText(
            own(payloadRecord, 'correlationId'),
            `effects/${index}/payload/correlationId`,
            512,
          ),
          `effects/${index}/payload/correlationId`,
        ),
        inputHash: persistedText(
          own(payloadRecord, 'inputHash'),
          `effects/${index}/payload/inputHash`,
          64,
          HASH,
        ),
        targetScopeHash: persistedText(
          own(payloadRecord, 'targetScopeHash'),
          `effects/${index}/payload/targetScopeHash`,
          64,
          HASH,
        ),
        normalizedInput: payloadInput,
        targetRefs: Object.freeze(payloadTargets),
        capabilityIds: payloadCapabilities,
      });
      const matchingWorkflow = workflows.find((workflow) => workflow.id === workflowId);
      if (
        matchingWorkflow === undefined ||
        workflowVersion !== matchingWorkflow.version ||
        adapterId !== matchingWorkflow.adapterId ||
        canonicalJson(capabilityIds) !== canonicalJson(matchingWorkflow.capabilityIds) ||
        payload.scenarioInstanceId !== scenarioInstanceId ||
        payload.definitionId !== definitionId ||
        payload.definitionVersion !== definitionVersion ||
        payload.definitionHash !== definitionHash ||
        payload.workflowId !== workflowId ||
        payload.workflowVersion !== workflowVersion ||
        payload.adapterId !== adapterId ||
        payload.correlationId !== correlationId ||
        payload.inputHash !== inputHash ||
        payload.targetScopeHash !== targetScopeHash ||
        canonicalJson(payload.normalizedInput) !== canonicalJson(normalizedInput) ||
        canonicalJson(payload.targetRefs) !== canonicalJson(targetRefs) ||
        canonicalJson(payload.capabilityIds) !== canonicalJson(capabilityIds)
      ) {
        return persistedFail(
          'SCENARIO_PERSISTED_PLAN_INVALID',
          `effects/${index} is not bound to the persisted Scenario plan.`,
        );
      }
      const expectedEffectId = `scenario-effect:sha256:${hash(payload)}`;
      const effectId = persistedText(own(effect, 'effectId'), `effects/${index}/effectId`, 96);
      if (effectId !== expectedEffectId) {
        return persistedFail(
          'SCENARIO_PERSISTED_PLAN_INVALID',
          `effects/${index}/effectId is inconsistent.`,
        );
      }
      const risk = persistedRisk(own(effect, 'risk'), `effects/${index}/risk`);
      if (risk !== maxRisk(capabilityIds.map((id) => capabilityById.get(id)!))) {
        return persistedFail(
          'SCENARIO_PERSISTED_PLAN_INVALID',
          `effects/${index}/risk is inconsistent.`,
        );
      }
      return Object.freeze({
        kind: 'workflow.start' as const,
        effectId,
        workflowId,
        workflowVersion,
        adapterId,
        capabilityIds,
        risk,
        summary: persistedText(own(effect, 'summary'), `effects/${index}/summary`, 1_024),
        payload,
      });
    }),
  );
  const instantiateEffects = effects.filter((effect) => effect.kind === 'scenario.instantiate');
  const workflowEffects = effects.filter((effect) => effect.kind === 'workflow.start');
  if (
    effects[0]?.kind !== 'scenario.instantiate' ||
    instantiateEffects.length !== 1 ||
    workflowEffects.length !== workflows.length ||
    new Set(workflowEffects.map((effect) => effect.workflowId)).size !== workflows.length
  ) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      'Persisted Scenario effects require one leading instantiation and one start per workflow.',
    );
  }
  const risk = persistedRisk(own(record, 'risk'), 'risk');
  if (risk !== maxRisk(capabilities)) {
    return persistedFail('SCENARIO_PERSISTED_PLAN_INVALID', 'Scenario plan risk is inconsistent.');
  }
  const approvalPoints = Object.freeze(
    denseArray(own(record, 'approvalPoints'), 'approvalPoints', 256).map((item, index) => {
      const point = closedRecord(item, ['kind', 'capabilityId'], `approvalPoints/${index}`);
      if (own(point, 'kind') !== 'openslack_workflow_effect') {
        return persistedFail(
          'SCENARIO_PERSISTED_PLAN_INVALID',
          `approvalPoints/${index}/kind is unsupported.`,
        );
      }
      return Object.freeze({
        kind: 'openslack_workflow_effect' as const,
        capabilityId: persistedText(
          own(point, 'capabilityId'),
          `approvalPoints/${index}/capabilityId`,
          128,
          CATALOG_ID,
        ),
      });
    }),
  );
  const expectedApprovals = capabilities
    .filter((capability) => capability.approvalRequired)
    .map((capability) => capability.id);
  if (
    canonicalJson(approvalPoints.map((point) => point.capabilityId)) !==
    canonicalJson(expectedApprovals)
  ) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      'Persisted Scenario approval points are inconsistent.',
    );
  }
  const expectedOutcomes = persistedStrings(
    own(record, 'expectedOutcomes'),
    'expectedOutcomes',
    256,
    CATALOG_ID,
  );
  const evidenceRefs = persistedStrings(own(record, 'evidenceRefs'), 'evidenceRefs', 256);
  const unsigned = {
    schema: 'openslack.scenario_plan.v1' as const,
    scenarioInstanceId,
    definitionId,
    definitionVersion,
    definitionHash,
    correlationId,
    actorId,
    workspaceId,
    normalizedInput,
    inputHash,
    targetScopeHash,
    targetRefs: Object.freeze([...targetRefs]),
    workflows,
    capabilities,
    effects,
    risk,
    approvalPoints,
    expectedOutcomes,
    evidenceRefs,
    createdAt,
    expiresAt,
  };
  const computedPlanHash = hash(unsigned);
  const planHash = persistedText(own(record, 'planHash'), 'planHash', 64, HASH);
  const planId = persistedText(own(record, 'planId'), 'planId', 96);
  if (computedPlanHash !== planHash || planId !== `scenario-plan:sha256:${planHash}`) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_INVALID',
      'Persisted Scenario plan identity or hash is inconsistent.',
    );
  }
  if (
    planHash !== expectedPlanHash ||
    actorId !== expectedActorId ||
    workspaceId !== expectedWorkspaceId ||
    correlationId !== expectedCorrelationId ||
    definitionHash !== expectedDefinitionHash
  ) {
    return persistedFail(
      'SCENARIO_PERSISTED_PLAN_BINDING_MISMATCH',
      'Persisted Scenario plan does not match its host-owned binding.',
    );
  }
  const plan = freeze({ ...unsigned, planId, planHash });
  SEALED_PLANS.add(plan);
  return plan;
}

export function createPreviewedScenarioInstance(plan: ScenarioInstantiationPlan): ScenarioInstance {
  assertScenarioInstantiationPlan(plan);
  return trustValidatedScenarioInstance(
    validateScenarioInstance({
      schema: SCENARIO_INSTANCE_SCHEMA,
      id: plan.scenarioInstanceId,
      definitionId: plan.definitionId,
      definitionVersion: plan.definitionVersion,
      definitionHash: plan.definitionHash,
      correlationId: plan.correlationId,
      state: 'previewed',
      targetRefs: plan.targetRefs,
      workflowRunIds: [],
      planId: plan.planId,
      planHash: plan.planHash,
      createdAt: plan.createdAt,
      updatedAt: plan.createdAt,
      evidenceRefs: plan.evidenceRefs,
    }),
  );
}
