import { createHash } from 'node:crypto';
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

export interface ScenarioPlanEffect {
  readonly kind: 'workflow.start';
  readonly workflowId: string;
  readonly adapterId: string;
  readonly risk: ScenarioRisk;
  readonly summary: string;
}

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
    | 'SCENARIO_PREVIEW_CATALOG_MISMATCH';

  constructor(code: ScenarioPlannerError['code'], message: string) {
    super(message);
    this.name = 'ScenarioPlannerError';
    this.code = code;
  }
}

const SAFE_IDENTIFIER = /^[^\u0000-\u001f\u007f/\\]+$/;
const SECRET_KEY =
  /(?:password|credential|privatekey|accesstoken|refreshtoken|githubtoken|apikey|secret)$/i;
const SECRET_VALUE = /-----BEGIN|\b(?:gh[pousr]_|github_pat_|xox[a-z]-|sk-|AKIA[A-Z0-9]{16})/i;

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
    if (typeof key !== 'string' || SECRET_KEY.test(key.replaceAll('-', '').replaceAll('_', ''))) {
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
  const normalizedInput = cloneInput(input.input, '/input', 1, { nodes: 0 });
  const serializedInput = canonicalJson(normalizedInput);
  if (Buffer.byteLength(serializedInput, 'utf8') > 256 * 1024) {
    return previewFail('SCENARIO_PREVIEW_INPUT_INVALID', 'Preview input exceeds byte limits.');
  }
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
  const effects = workflows.map((workflow) => {
    const workflowCapabilities = workflow.capabilityIds.map((capability) =>
      requireCatalogCapability(input.catalog, capability),
    );
    return Object.freeze({
      kind: 'workflow.start' as const,
      workflowId: workflow.id,
      adapterId: workflow.adapterId,
      risk: maxRisk(workflowCapabilities),
      summary: `Start registered workflow ${workflow.id}.`,
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
  const unsigned = {
    schema: 'openslack.scenario_plan.v1' as const,
    scenarioInstanceId,
    definitionId: input.definition.manifest.id,
    definitionVersion: input.definition.manifest.version,
    definitionHash: input.definition.definitionHash,
    correlationId,
    actorId,
    workspaceId,
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
