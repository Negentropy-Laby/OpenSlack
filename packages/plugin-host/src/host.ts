import type {
  ActionAuthorizationRequest,
  ActivationAuthorizationRequest,
  ActivationEvidence,
  BlockingFinding,
  BundledActivationEvidence,
  BundledPluginContext,
  CanonicalActionPolicyFacts,
  DeclarativeActivationEvidence,
  DeclarativePluginCapability,
  HostPlanStep,
  HostPolicyPort,
  JsonPrimitive,
  JsonValue,
  PluginCapability,
  PluginGateMode,
  PluginLifecycleSnapshot,
  PluginManifestV1,
  PlanStepValidationRequest,
} from '@openslack/plugin-api';

import { HostAuditWriter } from './audit.js';
import {
  BundledPluginValidationError,
  normalizeBundledPluginDefinition,
  normalizePrmsBlockerResult,
  prmsEvaluatorFailureBlocker,
  type NormalizedBundledAction,
  type NormalizedBundledPlugin,
  type NormalizedBundledPrmsBlocker,
  type NormalizedBundledWorkflow,
} from './bundled-policy.js';
import {
  assertDeclarativeAlias,
  assertEffectiveCapabilities,
  createHostTargetCatalog,
  validateContributionCapabilities,
  type HostActionTargetFacts,
  type HostTargetCatalog,
  type HostTargetCatalogSeed,
  type ResolvedDeclarativeAlias,
} from './capability-policy.js';
import { normalizePluginOperationTimeout, runPluginOperationWithDeadline } from './deadline.js';
import {
  PluginHostError,
  asciiCompare,
  failPluginHost,
  type PluginHostFindingCode,
  type PluginHostPhase,
} from './findings.js';
import {
  HostInputValidationError,
  assertCompatibleOpenSlackVersion,
  normalizeActivationDecision,
  normalizeActivationEvidence,
  normalizeHostPolicyDecision,
} from './host-validation.js';
import { PluginLifecycleController, SealedHostBinding } from './lifecycle.js';
import { loadPluginManifest, type LoadedPluginManifest } from './loader.js';
import { readPluginLock, type PluginLockEntry, type PluginLockV1 } from './lock.js';
import { validateManifestForHost } from './manifest-policy.js';
import { projectPrmsReportForEvaluator } from './prms-projection.js';
import {
  PluginRegistrySet,
  canonicalPluginContributionId,
  type PluginContributionId,
  type PluginRegistryBatch,
} from './registries.js';

const HOST_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PLAIN_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
const SAFE_FIELD = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]+$/u;
const ACTION_FORBIDDEN_FIELDS = new Set([
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
  'path',
  'file',
  'url',
  'risk',
  'risklevel',
  'riskzone',
  'confirmationrequired',
  'secret',
  'token',
  'password',
  'credential',
  'privatekey',
]);

export interface PluginHostBinding {
  readonly compositionId: string;
  readonly openslackVersion: string;
  readonly gateIds: readonly string[];
  readonly targets: HostTargetCatalogSeed;
}

interface NormalizedPluginHostBinding {
  readonly compositionId: string;
  readonly openslackVersion: string;
  readonly gateIds: ReadonlySet<string>;
  readonly targets: HostTargetCatalog;
}

export interface PluginHostOptions {
  readonly policy: HostPolicyPort<HostPlanStep>;
  readonly binding: PluginHostBinding;
  readonly bundledPlugins?: readonly ReviewedBundledPluginRegistration[];
  /** Host-owned operation deadline, clamped to the Red host's fixed ceiling. */
  readonly operationTimeoutMs?: number;
}

export interface ReviewedBundledPluginRegistration {
  readonly definition: unknown;
  readonly evidence: unknown;
}

interface HostPluginRecordBase {
  readonly id: string;
  readonly version: string;
  readonly providerKind: 'bundled' | 'workspace' | 'plugin';
  readonly sourceRef: string;
  readonly gate: { readonly mode: PluginGateMode; readonly gateId: string };
  readonly lifecycle: PluginLifecycleController;
  readonly requestedCapabilities: readonly PluginCapability[];
  effectiveCapabilities?: readonly PluginCapability[];
  activationEvidence?: ActivationEvidence;
}

interface DeclarativeHostPluginRecord extends HostPluginRecordBase {
  readonly kind: 'declarative';
  readonly providerKind: 'workspace' | 'plugin';
  readonly manifest: PluginManifestV1;
  readonly manifestSha256: string;
  readonly lockManifestSha256: string;
  readonly aliases: readonly ResolvedDeclarativeAlias[];
}

interface BundledHostPluginRecord extends HostPluginRecordBase {
  readonly kind: 'bundled';
  readonly providerKind: 'bundled';
  readonly definition: NormalizedBundledPlugin;
  readonly registrationEvidence: BundledActivationEvidence;
}

type HostPluginRecord = DeclarativeHostPluginRecord | BundledHostPluginRecord;
interface ResolvedBundledAction extends NormalizedBundledAction {
  readonly targetFacts: HostActionTargetFacts;
}
type HostRegisteredAction = ResolvedDeclarativeAlias | ResolvedBundledAction;
type HostRegisteredWorkflow = ResolvedDeclarativeAlias | NormalizedBundledWorkflow;

export interface PluginHostPluginSnapshot {
  readonly id: string;
  readonly version: string;
  readonly providerKind: 'bundled' | 'workspace' | 'plugin';
  readonly sourceRef: string;
  readonly gate: { readonly mode: PluginGateMode; readonly gateId: string };
  readonly lifecycle: PluginLifecycleSnapshot;
  readonly effectiveCapabilities: readonly PluginCapability[];
}

export interface PluginHostSnapshot {
  readonly bound: boolean;
  readonly sealed: boolean;
  readonly registryRevision: number;
  readonly plugins: readonly PluginHostPluginSnapshot[];
  readonly actionIds: readonly PluginContributionId[];
  readonly workflowIds: readonly PluginContributionId[];
  readonly prmsBlockerIds: readonly PluginContributionId[];
}

export interface PluginLoadReport {
  readonly registered: readonly PluginHostPluginSnapshot[];
  readonly registryRevision: number;
}

export interface InstalledPluginLoadRequest {
  readonly workspaceRoot: string;
  readonly installedRoot: string;
  readonly pluginId: string;
}

interface PluginActionPlanResultBase {
  readonly contributedActionId: PluginContributionId;
  readonly targetActionId: string;
}

export type PluginActionPlanResult =
  | (PluginActionPlanResultBase & {
      readonly outcome: 'planned';
      readonly step: Readonly<HostPlanStep>;
      readonly executable: true;
    })
  | (PluginActionPlanResultBase & {
      readonly outcome: 'shadowed';
      readonly step?: Readonly<HostPlanStep>;
      readonly executable: false;
    });

function hostFail(
  code: PluginHostFindingCode,
  phase: PluginHostPhase,
  summary: string,
  pluginId?: string,
  contributionId?: string,
): never {
  return failPluginHost({
    code,
    phase,
    summary,
    ...(pluginId === undefined ? {} : { pluginId }),
    ...(contributionId === undefined ? {} : { contributionId }),
  });
}

function safeHostString(value: unknown, field: string, max: number, pattern = HOST_ID): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Array.from(value).length > max ||
    !SAFE_TEXT.test(value) ||
    !pattern.test(value)
  ) {
    return hostFail(
      'PLUGIN_HOST_BINDING_INVALID',
      'binding',
      `${field} is outside the closed host grammar.`,
    );
  }
  return value;
}

function exactHostDataRecord(
  value: unknown,
  fields: readonly string[],
  summary: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return hostFail('PLUGIN_HOST_BINDING_INVALID', 'binding', summary);
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return hostFail('PLUGIN_HOST_BINDING_INVALID', 'binding', summary);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== 'string' || !fields.includes(key))
    ) {
      return hostFail('PLUGIN_HOST_BINDING_INVALID', 'binding', summary);
    }
    const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        return hostFail('PLUGIN_HOST_BINDING_INVALID', 'binding', summary);
      }
      output[field] = descriptor.value;
    }
    return output;
  } catch (error) {
    if (error instanceof PluginHostError) throw error;
    return hostFail('PLUGIN_HOST_BINDING_INVALID', 'binding', summary);
  }
}

function exactHostDataArray(
  value: unknown,
  maxLength: number,
  code: PluginHostFindingCode,
  phase: PluginHostPhase,
  summary: string,
): readonly unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return hostFail(code, phase, summary);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const allowed = new Set<string>(['length']);
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > maxLength) {
      return hostFail(code, phase, summary);
    }
    const output: unknown[] = [];
    for (let index = 0; index < (length as number); index += 1) {
      const key = String(index);
      allowed.add(key);
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        return hostFail(code, phase, summary);
      }
      output.push(descriptor.value);
    }
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== 'string' || !allowed.has(key))) {
      return hostFail(code, phase, summary);
    }
    return Object.freeze(output);
  } catch (error) {
    if (error instanceof PluginHostError) throw error;
    return hostFail(code, phase, summary);
  }
}

function normalizeBinding(value: PluginHostBinding): NormalizedPluginHostBinding {
  const binding = exactHostDataRecord(
    value,
    ['compositionId', 'openslackVersion', 'gateIds', 'targets'],
    'Host binding must use the exact plain-data schema.',
  );
  if (!binding) {
    return hostFail('PLUGIN_HOST_BINDING_INVALID', 'binding', 'Host binding must be an object.');
  }
  const compositionId = safeHostString(binding.compositionId, 'compositionId', 128);
  const openslackVersion = safeHostString(
    binding.openslackVersion,
    'openslackVersion',
    32,
    PLAIN_VERSION,
  );
  const gateIdValues = exactHostDataArray(
    binding.gateIds,
    128,
    'PLUGIN_HOST_BINDING_INVALID',
    'binding',
    'Host gate IDs must be a bounded dense data array.',
  );
  const gateIds = new Set<string>();
  for (const gateIdValue of gateIdValues) {
    const gateId = safeHostString(gateIdValue, 'gateId', 128);
    if (gateIds.has(gateId)) {
      return hostFail(
        'PLUGIN_HOST_BINDING_INVALID',
        'binding',
        `Host gate ${gateId} is duplicated.`,
      );
    }
    gateIds.add(gateId);
  }
  return Object.freeze({
    compositionId,
    openslackVersion,
    gateIds: Object.freeze(gateIds),
    targets: createHostTargetCatalog(binding.targets as HostTargetCatalogSeed),
  });
}

function lockEntryFor(
  lock: PluginLockV1,
  pluginId: string,
  providerKind: 'workspace' | 'plugin',
): PluginLockEntry {
  const entry = lock.plugins.find(
    (candidate) => candidate.id === pluginId && candidate.providerKind === providerKind,
  );
  if (!entry) {
    return hostFail(
      'PLUGIN_HOST_LOCK_ENTRY_MISSING',
      'integrity',
      `No ${providerKind} lock entry exists for plugin ${pluginId}.`,
      pluginId,
    );
  }
  return entry;
}

function assertLockMatches(entry: PluginLockEntry, loaded: LoadedPluginManifest): void {
  if (entry.id !== loaded.pluginId || entry.version !== loaded.manifest.version) {
    hostFail(
      'PLUGIN_HOST_LOCK_IDENTITY_MISMATCH',
      'integrity',
      'Lock identity does not match the loaded manifest.',
      loaded.pluginId,
    );
  }
  if (entry.providerKind !== loaded.providerKind || entry.sourceRef !== loaded.sourceRef) {
    hostFail(
      'PLUGIN_HOST_LOCK_SOURCE_MISMATCH',
      'integrity',
      'Lock provider/source does not match the host-owned source entrypoint.',
      loaded.pluginId,
    );
  }
  if (entry.manifestSha256 !== loaded.manifestSha256) {
    hostFail(
      'PLUGIN_HOST_LOCK_HASH_MISMATCH',
      'integrity',
      'Lock hash does not match the exact validated manifest bytes.',
      loaded.pluginId,
    );
  }
  if (entry.requestedGateMode !== loaded.gateMode) {
    hostFail(
      'PLUGIN_HOST_LOCK_GATE_MISMATCH',
      'integrity',
      'Lock gate mode does not match the loaded manifest.',
      loaded.pluginId,
    );
  }
}

function pluginSnapshot(record: HostPluginRecord): PluginHostPluginSnapshot {
  return Object.freeze({
    id: record.id,
    version: record.version,
    providerKind: record.providerKind,
    sourceRef: record.sourceRef,
    gate: record.gate,
    lifecycle: record.lifecycle.snapshot,
    effectiveCapabilities: Object.freeze([...(record.effectiveCapabilities ?? [])]),
  });
}

function exactInputRecord(value: unknown, code: PluginHostFindingCode): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return hostFail(code, 'authorization', 'Action input must be a plain data object.');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return hostFail(code, 'authorization', 'Action input cannot have a custom prototype.');
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      !SAFE_FIELD.test(key) ||
      ACTION_FORBIDDEN_FIELDS.has(key.toLowerCase())
    ) {
      return hostFail(code, 'authorization', 'Action input contains a forbidden field name.');
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      return hostFail(
        code,
        'authorization',
        'Action input fields must be enumerable data properties.',
      );
    }
    output[key] = descriptor.value;
  }
  return output;
}

function primitiveMatches(value: unknown, type: 'string' | 'number' | 'boolean'): boolean {
  return type === 'number'
    ? typeof value === 'number' && Number.isFinite(value)
    : typeof value === type;
}

function mapDeclarativeInput(
  alias: ResolvedDeclarativeAlias,
  inputValue: unknown,
): Readonly<Record<string, JsonValue>> {
  const input = exactInputRecord(inputValue, 'PLUGIN_HOST_ACTION_INPUT_INVALID');
  const definitions = alias.contribution.inputs ?? {};
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(definitions, key)) {
      return hostFail(
        'PLUGIN_HOST_ACTION_INPUT_INVALID',
        'authorization',
        `Action input ${key} is not declared.`,
        undefined,
        alias.contribution.id,
      );
    }
  }
  for (const [name, definition] of Object.entries(definitions)) {
    if (definition.required && !Object.hasOwn(input, name)) {
      return hostFail(
        'PLUGIN_HOST_ACTION_INPUT_INVALID',
        'authorization',
        `Required action input ${name} is missing.`,
      );
    }
    if (Object.hasOwn(input, name) && !primitiveMatches(input[name], definition.type)) {
      return hostFail(
        'PLUGIN_HOST_ACTION_INPUT_INVALID',
        'authorization',
        `Action input ${name} does not match ${definition.type}.`,
      );
    }
  }
  const mapped: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [targetName, binding] of Object.entries(alias.contribution.inputMapping ?? {})) {
    if (binding.kind === 'constant') {
      mapped[targetName] = binding.value;
    } else {
      const value = input[binding.name];
      if (value === undefined) continue;
      mapped[targetName] = value as Exclude<JsonPrimitive, null>;
    }
  }
  return Object.freeze(mapped);
}

function normalizeBundledInput(
  value: unknown,
): Readonly<Record<string, Exclude<JsonPrimitive, null>>> {
  const input = exactInputRecord(value, 'PLUGIN_HOST_ACTION_INPUT_INVALID');
  if (Object.keys(input).length > 32) {
    return hostFail(
      'PLUGIN_HOST_ACTION_INPUT_INVALID',
      'authorization',
      'Bundled action input exceeds the field limit.',
    );
  }
  const output: Record<string, Exclude<JsonPrimitive, null>> = Object.create(null) as Record<
    string,
    Exclude<JsonPrimitive, null>
  >;
  for (const [key, item] of Object.entries(input)) {
    if (
      (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') ||
      (typeof item === 'number' && !Number.isFinite(item))
    ) {
      return hostFail(
        'PLUGIN_HOST_ACTION_INPUT_INVALID',
        'authorization',
        'Bundled action input must be finite scalar JSON.',
      );
    }
    output[key] = item;
  }
  return Object.freeze(output);
}

function normalizePlanStep(
  value: unknown,
  targets: HostTargetCatalog,
): { readonly step: Readonly<HostPlanStep>; readonly target: HostActionTargetFacts } {
  const record = exactInputRecord(value, 'PLUGIN_HOST_PLAN_STEP_INVALID');
  const keys = Object.keys(record).sort(asciiCompare);
  if (keys.length !== 3 || keys[0] !== 'actionId' || keys[1] !== 'id' || keys[2] !== 'input') {
    return hostFail(
      'PLUGIN_HOST_PLAN_STEP_INVALID',
      'authorization',
      'Plan step must contain exactly id, actionId, and input.',
    );
  }
  if (
    typeof record.id !== 'string' ||
    record.id.length > 128 ||
    !HOST_ID.test(record.id) ||
    typeof record.actionId !== 'string'
  ) {
    return hostFail(
      'PLUGIN_HOST_PLAN_STEP_INVALID',
      'authorization',
      'Plan step identity is invalid.',
    );
  }
  const target = targets.getAction(record.actionId);
  if (!target || !target.exists) {
    return hostFail(
      'PLUGIN_HOST_PLAN_STEP_INVALID',
      'authorization',
      'Plan step target is not in the sealed host catalog.',
    );
  }
  const input = exactInputRecord(record.input, 'PLUGIN_HOST_PLAN_STEP_INVALID');
  const normalized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, item] of Object.entries(input)) {
    const field = target.inputSchema[key];
    if (!field || !primitiveMatches(item, field.type)) {
      return hostFail(
        'PLUGIN_HOST_PLAN_STEP_INVALID',
        'authorization',
        `Plan step input ${key} is unknown or mistyped.`,
      );
    }
    normalized[key] = item as Exclude<JsonPrimitive, null>;
  }
  for (const [key, field] of Object.entries(target.inputSchema)) {
    if (field.required && !Object.hasOwn(normalized, key)) {
      return hostFail(
        'PLUGIN_HOST_PLAN_STEP_INVALID',
        'authorization',
        `Required plan step input ${key} is missing.`,
      );
    }
  }
  return {
    step: Object.freeze({
      id: record.id,
      actionId: record.actionId,
      input: Object.freeze(normalized),
    }),
    target,
  };
}

function actionPolicyFacts(target: HostActionTargetFacts): CanonicalActionPolicyFacts {
  return Object.freeze({
    id: target.id,
    sideEffects: target.sideEffects,
    risk: target.risk,
    confirmationRequired: target.confirmationRequired,
  });
}

function evidenceRefs(evidence: ActivationEvidence): readonly string[] {
  return evidence.humanApproval.evidenceRefs;
}

function bundledCapabilitiesValid(
  definition: NormalizedBundledPlugin,
  effective: readonly PluginCapability[],
): boolean {
  const values = new Set(effective);
  return definition.contributions.every((contribution) => {
    if (contribution.kind === 'bundled_action') return values.has('host.actions.plan');
    if (contribution.kind === 'bundled_workflow') return values.has('host.workflows.contribute');
    return values.has('prms.blockers.append');
  });
}

export class PluginHost {
  readonly #binding = new SealedHostBinding<NormalizedPluginHostBinding>();
  readonly #policy: HostPolicyPort<HostPlanStep>;
  readonly #audit: HostAuditWriter;
  readonly #registry = new PluginRegistrySet<
    HostPluginRecord,
    HostRegisteredAction,
    HostRegisteredWorkflow,
    NormalizedBundledPrmsBlocker
  >();
  readonly #operationTimeoutMs: number;
  readonly #lifecycleOperations = new Set<string>();
  readonly #executionOperations = new Map<string, number>();
  #sealed = false;

  constructor(options: PluginHostOptions) {
    if (
      !options?.policy ||
      typeof options.policy.authorizeActivation !== 'function' ||
      typeof options.policy.authorizeAction !== 'function' ||
      typeof options.policy.validatePlanStep !== 'function' ||
      typeof options.policy.recordAuditEvent !== 'function'
    ) {
      hostFail('PLUGIN_HOST_BINDING_INVALID', 'binding', 'Host policy port is incomplete.');
    }
    this.#policy = options.policy;
    this.#audit = new HostAuditWriter(options.policy);
    this.#operationTimeoutMs = normalizePluginOperationTimeout(options.operationTimeoutMs);
    this.#binding.bind(normalizeBinding(options.binding));

    const bundledRegistrations = exactHostDataArray(
      options.bundledPlugins ?? [],
      64,
      'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
      'validation',
      'Constructor bundled registrations must be a bounded dense data array.',
    );
    const prepared = bundledRegistrations.map((registration) =>
      this.#prepareBundledRegistration(registration),
    );
    if (prepared.length > 0) {
      this.#registry.registerBatches(prepared.map((item) => item.batch));
    }
  }

  seal(): void {
    this.#binding.get();
    this.#sealed = true;
  }

  async loadWorkspacePlugins(request: {
    readonly workspaceRoot: string;
  }): Promise<PluginLoadReport> {
    this.#assertRegistrationOpen();
    const lock = await readPluginLock(request.workspaceRoot);
    const entries = lock.plugins
      .filter((entry) => entry.providerKind === 'workspace')
      .sort((left, right) => asciiCompare(left.id, right.id));
    const records: DeclarativeHostPluginRecord[] = [];
    const batches: PluginRegistryBatch<
      HostPluginRecord,
      HostRegisteredAction,
      HostRegisteredWorkflow,
      HostRegisteredAction,
      HostRegisteredWorkflow,
      NormalizedBundledPrmsBlocker
    >[] = [];
    for (const entry of entries) {
      const loaded = await loadPluginManifest(
        { providerKind: 'workspace', workspaceRoot: request.workspaceRoot, pluginId: entry.id },
        { validateManifest: validateManifestForHost },
      );
      assertLockMatches(entry, loaded);
      const prepared = this.#prepareDeclarative(loaded, entry);
      records.push(prepared.record);
      batches.push(prepared.batch);
    }
    if (batches.length > 0) {
      // No await is permitted between this final seal check and registry commit.
      this.#assertRegistrationOpen();
      this.#registry.registerBatches(batches);
    }
    return Object.freeze({
      registered: Object.freeze(records.map(pluginSnapshot)),
      registryRevision: this.#registry.revision,
    });
  }

  async loadInstalledPlugin(request: InstalledPluginLoadRequest): Promise<PluginLoadReport> {
    this.#assertRegistrationOpen();
    const lock = await readPluginLock(request.workspaceRoot);
    const entry = lockEntryFor(lock, request.pluginId, 'plugin');
    const loaded = await loadPluginManifest(
      {
        providerKind: 'plugin',
        installedRoot: request.installedRoot,
        sourceRef: entry.sourceRef,
        expectedPluginId: request.pluginId,
      },
      { validateManifest: validateManifestForHost },
    );
    assertLockMatches(entry, loaded);
    const prepared = this.#prepareDeclarative(loaded, entry);
    // No await is permitted between this final seal check and registry commit.
    this.#assertRegistrationOpen();
    this.#registry.registerBatches([prepared.batch]);
    return Object.freeze({
      registered: Object.freeze([pluginSnapshot(prepared.record)]),
      registryRevision: this.#registry.revision,
    });
  }

  async activate(pluginId: string, evidenceValue: unknown): Promise<PluginHostPluginSnapshot> {
    this.#assertExecutionReady();
    const record = this.#record(pluginId);
    this.#beginLifecycleOperation(pluginId);
    try {
      if (record.lifecycle.state !== 'registered' && record.lifecycle.state !== 'degraded') {
        return hostFail(
          'PLUGIN_LIFECYCLE_INVALID_TRANSITION',
          'lifecycle',
          `Plugin ${pluginId} cannot activate from ${record.lifecycle.state}.`,
          pluginId,
        );
      }
      const lifecycleFrom = record.lifecycle.state;
      if (evidenceValue === undefined || evidenceValue === null) {
        return hostFail(
          'PLUGIN_HOST_ACTIVATION_EVIDENCE_MISSING',
          'authorization',
          'Activation evidence is required.',
          pluginId,
        );
      }
      const binding = this.#binding.get();
      let evidence: ActivationEvidence;
      try {
        evidence =
          record.kind === 'declarative'
            ? normalizeActivationEvidence(evidenceValue, {
                id: record.id,
                version: record.version,
                providerKind: record.providerKind,
                sourceRef: record.sourceRef,
                manifestSha256: record.manifestSha256,
                lockManifestSha256: record.lockManifestSha256,
              })
            : normalizeActivationEvidence(evidenceValue, {
                id: record.id,
                version: record.version,
                providerKind: 'bundled',
                compositionId: binding.compositionId,
              });
      } catch (error) {
        this.#rethrowValidation(error, pluginId);
      }
      if (record.kind === 'bundled') {
        const current = evidence as BundledActivationEvidence;
        if (
          current.source.reviewEvidenceRefs.length === 0 ||
          current.source.reviewEvidenceRefs.join('\u0000') !==
            record.registrationEvidence.source.reviewEvidenceRefs.join('\u0000')
        ) {
          return hostFail(
            'PLUGIN_HOST_ACTIVATION_EVIDENCE_MISMATCH',
            'authorization',
            'Bundled activation review evidence differs from registration.',
            pluginId,
          );
        }
      }

      await this.#audit.recordRequired({
        type: 'plugin.activation.requested',
        plugin: { id: record.id, version: record.version },
        providerKind: record.providerKind,
        evidenceRefs: evidenceRefs(evidence!),
        facts: [
          { key: 'gateId', value: record.gate.gateId },
          { key: 'sourceKind', value: record.providerKind },
        ],
      });

      const request: ActivationAuthorizationRequest =
        record.kind === 'declarative'
          ? {
              requestedCapabilities:
                record.requestedCapabilities as readonly DeclarativePluginCapability[],
              evidence: evidence! as DeclarativeActivationEvidence,
            }
          : {
              requestedCapabilities: record.definition.requestedCapabilities,
              evidence: evidence! as BundledActivationEvidence,
            };
      let decision;
      try {
        decision = normalizeActivationDecision(await this.#policy.authorizeActivation(request));
      } catch (error) {
        this.#rethrowPolicy(error, pluginId);
      }
      if (decision!.outcome !== 'allow') {
        await this.#audit.recordRequired({
          type: 'plugin.activation.denied',
          plugin: { id: record.id, version: record.version },
          providerKind: record.providerKind,
          evidenceRefs: decision!.evidenceRefs,
          facts: [{ key: 'decisionCode', value: decision!.code }],
        });
        return hostFail(
          decision!.outcome === 'ask'
            ? 'PLUGIN_HOST_ACTIVATION_ASK'
            : 'PLUGIN_HOST_ACTIVATION_DENIED',
          'authorization',
          `Activation policy returned ${decision!.outcome}.`,
          pluginId,
        );
      }
      const effective = assertEffectiveCapabilities({
        providerKind: record.kind === 'declarative' ? 'declarative' : 'bundled',
        requestedCapabilities: record.requestedCapabilities,
        hostAllowedCapabilities: decision!.hostAllowedCapabilities,
        actorAllowedCapabilities: decision!.actorAllowedCapabilities,
        pluginId,
      });
      if (record.kind === 'declarative') {
        const findings = validateContributionCapabilities(
          record.manifest.contributes,
          effective,
          pluginId,
        );
        if (findings.length > 0) throw new PluginHostError(findings);
      } else if (!bundledCapabilitiesValid(record.definition, effective)) {
        return hostFail(
          'PLUGIN_CONTRIBUTION_CAPABILITY_MISSING',
          'capability',
          'Bundled contribution lacks an effective capability.',
          pluginId,
        );
      }
      await this.#audit.recordRequired({
        type: 'plugin.activation.allowed',
        plugin: { id: record.id, version: record.version },
        providerKind: record.providerKind,
        evidenceRefs: decision!.evidenceRefs,
        facts: [
          { key: 'decisionCode', value: decision!.code },
          { key: 'capabilityCount', value: effective.length },
        ],
      });
      if (
        record.kind === 'bundled' &&
        record.gate.mode === 'ENFORCE' &&
        record.definition.activate
      ) {
        try {
          await runPluginOperationWithDeadline(
            () =>
              record.definition.activate!({
                effectiveCapabilities: effective,
                activationEvidence: evidence! as BundledActivationEvidence,
              }),
            this.#operationTimeoutMs,
          );
        } catch {
          record.lifecycle.transition('disabled', {
            reason: 'Bundled activation hook failed after authorization.',
          });
          delete record.effectiveCapabilities;
          delete record.activationEvidence;
          await this.#audit.recordRequired({
            type: 'plugin.lifecycle.changed',
            plugin: { id: record.id, version: record.version },
            providerKind: record.providerKind,
            evidenceRefs: evidenceRefs(evidence!),
            facts: [
              { key: 'lifecycleFrom', value: lifecycleFrom },
              { key: 'lifecycleTo', value: 'disabled' },
              { key: 'reasonCode', value: 'activation_hook_failed' },
            ],
          });
          return hostFail(
            'PLUGIN_HOST_ACTIVATION_HOOK_FAILED',
            'lifecycle',
            'Bundled activation hook failed closed.',
            pluginId,
          );
        }
      }
      record.effectiveCapabilities = effective;
      record.activationEvidence = evidence!;
      record.lifecycle.transition('activated', { reason: 'Policy and audit gates passed.' });
      return pluginSnapshot(record);
    } finally {
      this.#endLifecycleOperation(pluginId);
    }
  }

  async deactivate(pluginId: string): Promise<PluginHostPluginSnapshot> {
    this.#assertExecutionReady();
    const record = this.#record(pluginId);
    this.#beginLifecycleOperation(pluginId);
    try {
      if (record.lifecycle.state !== 'activated' && record.lifecycle.state !== 'degraded') {
        return hostFail(
          'PLUGIN_LIFECYCLE_INVALID_TRANSITION',
          'lifecycle',
          'Only active or degraded plugins can be disabled.',
          pluginId,
        );
      }
      const lifecycleFrom = record.lifecycle.state;
      const activationEvidence = record.activationEvidence;
      if (
        record.kind === 'bundled' &&
        record.gate.mode === 'ENFORCE' &&
        record.definition.deactivate &&
        activationEvidence
      ) {
        try {
          await runPluginOperationWithDeadline(
            () =>
              record.definition.deactivate!({
                effectiveCapabilities: record.effectiveCapabilities ?? [],
                activationEvidence: activationEvidence as BundledActivationEvidence,
              }),
            this.#operationTimeoutMs,
          );
        } catch {
          record.lifecycle.transition('disabled', {
            reason: 'Bundled deactivation hook failed after possible side effects.',
          });
          delete record.effectiveCapabilities;
          delete record.activationEvidence;
          await this.#audit.recordRequired({
            type: 'plugin.lifecycle.changed',
            plugin: { id: record.id, version: record.version },
            providerKind: record.providerKind,
            evidenceRefs: evidenceRefs(activationEvidence),
            facts: [
              { key: 'lifecycleFrom', value: lifecycleFrom },
              { key: 'lifecycleTo', value: 'disabled' },
              { key: 'reasonCode', value: 'deactivation_hook_failed' },
            ],
          });
          return hostFail(
            'PLUGIN_HOST_ACTIVATION_HOOK_FAILED',
            'lifecycle',
            'Bundled deactivation hook failed closed.',
            pluginId,
          );
        }
      }
      record.lifecycle.transition('disabled', { reason: 'Host deactivated plugin.' });
      delete record.effectiveCapabilities;
      delete record.activationEvidence;
      await this.#audit.recordRequired({
        type: 'plugin.lifecycle.changed',
        plugin: { id: record.id, version: record.version },
        providerKind: record.providerKind,
        evidenceRefs: activationEvidence ? evidenceRefs(activationEvidence) : [],
        facts: [
          { key: 'lifecycleFrom', value: lifecycleFrom },
          { key: 'lifecycleTo', value: 'disabled' },
        ],
      });
      return pluginSnapshot(record);
    } finally {
      this.#endLifecycleOperation(pluginId);
    }
  }

  async planAction(actionId: string, inputValue: unknown): Promise<PluginActionPlanResult> {
    this.#assertExecutionReady();
    const registered = this.#registry.getAction(actionId);
    if (!registered) {
      return hostFail(
        'PLUGIN_ALIAS_TARGET_NOT_FOUND',
        'authorization',
        `Plugin action ${actionId} is not registered.`,
        undefined,
        actionId,
      );
    }
    const record = this.#record(registered.pluginId);
    this.#beginExecutionOperation(record.id, actionId);
    try {
      if (
        record.lifecycle.state !== 'activated' ||
        !record.activationEvidence ||
        !record.effectiveCapabilities
      ) {
        return hostFail(
          'PLUGIN_LIFECYCLE_INVALID_TRANSITION',
          'lifecycle',
          'Plugin action cannot run before activation.',
          record.id,
          actionId,
        );
      }
      await this.#audit.recordRequired({
        type: 'plugin.action.requested',
        plugin: { id: record.id, version: record.version },
        providerKind: record.providerKind,
        evidenceRefs: evidenceRefs(record.activationEvidence),
        facts: [{ key: 'contributionId', value: actionId }],
      });

      let target: HostActionTargetFacts;
      if (registered.kind === 'action_alias') {
        const alias = registered.value as ResolvedDeclarativeAlias;
        if (alias.kind !== 'action_alias') {
          await this.#auditActionDenied(record, actionId, 'registry_kind_mismatch');
          return hostFail(
            'PLUGIN_HOST_PLAN_STEP_INVALID',
            'authorization',
            'Action registry kind/value mismatch.',
            record.id,
            actionId,
          );
        }
        target = alias.target;
      } else {
        target = (registered.value as ResolvedBundledAction).targetFacts;
      }

      if (!record.effectiveCapabilities.includes(target.requiredCapability)) {
        await this.#auditActionDenied(record, actionId, 'required_capability_missing');
        return hostFail(
          'PLUGIN_CONTRIBUTION_CAPABILITY_MISSING',
          'capability',
          `Action target ${target.id} requires effective capability ${target.requiredCapability}.`,
          record.id,
          actionId,
        );
      }

      const authorizationRequest: ActionAuthorizationRequest =
        record.kind === 'declarative'
          ? {
              contributedActionId: actionId,
              target: actionPolicyFacts(target),
              effectiveCapabilities:
                record.effectiveCapabilities as readonly DeclarativePluginCapability[],
              evidence: record.activationEvidence as DeclarativeActivationEvidence,
            }
          : {
              contributedActionId: actionId,
              target: actionPolicyFacts(target),
              effectiveCapabilities: record.effectiveCapabilities,
              evidence: record.activationEvidence as BundledActivationEvidence,
            };
      let decision;
      try {
        decision = normalizeHostPolicyDecision(
          await this.#policy.authorizeAction(authorizationRequest),
        );
      } catch (error) {
        await this.#auditActionDenied(record, actionId, 'action_policy_failed');
        this.#rethrowPolicy(error, record.id);
      }
      if (decision!.outcome !== 'allow') {
        await this.#auditActionDenied(record, actionId, decision!.code, decision!.evidenceRefs);
        return hostFail(
          decision!.outcome === 'ask' ? 'PLUGIN_HOST_ACTION_ASK' : 'PLUGIN_HOST_ACTION_DENIED',
          'authorization',
          `Action policy returned ${decision!.outcome}.`,
          record.id,
          actionId,
        );
      }

      if (record.gate.mode === 'SHADOW') {
        await this.#audit.recordRequired({
          type: 'plugin.action.allowed',
          plugin: { id: record.id, version: record.version },
          providerKind: record.providerKind,
          evidenceRefs: decision!.evidenceRefs,
          facts: [
            { key: 'contributionId', value: actionId },
            { key: 'targetId', value: target.id },
            { key: 'outcome', value: 'shadowed' },
          ],
        });
        return Object.freeze({
          outcome: 'shadowed',
          contributedActionId: actionId as PluginContributionId,
          targetActionId: target.id,
          executable: false,
        });
      }

      let step: Readonly<HostPlanStep>;
      if (registered.kind === 'action_alias') {
        const alias = registered.value as Extract<
          ResolvedDeclarativeAlias,
          { kind: 'action_alias' }
        >;
        try {
          step = Object.freeze({
            id: `${record.id}.${alias.contribution.id}`,
            actionId: target.id,
            input: mapDeclarativeInput(alias, inputValue),
          });
        } catch (error) {
          await this.#auditActionDenied(record, actionId, 'action_input_invalid');
          throw error;
        }
      } else {
        const contribution = registered.value as ResolvedBundledAction;
        let normalizedInput: Readonly<Record<string, Exclude<JsonPrimitive, null>>>;
        try {
          normalizedInput = normalizeBundledInput(inputValue);
        } catch (error) {
          await this.#auditActionDenied(record, actionId, 'action_input_invalid');
          throw error;
        }
        let rawStep: unknown;
        try {
          rawStep = await runPluginOperationWithDeadline(
            () =>
              contribution.buildPlanStep(normalizedInput, {
                effectiveCapabilities: record.effectiveCapabilities!,
                activationEvidence: record.activationEvidence as BundledActivationEvidence,
              }),
            this.#operationTimeoutMs,
          );
        } catch {
          await this.#auditActionDenied(record, actionId, 'plan_builder_failed');
          return hostFail(
            'PLUGIN_HOST_PLAN_STEP_INVALID',
            'authorization',
            'Bundled plan builder failed closed.',
            record.id,
            actionId,
          );
        }
        let normalized;
        try {
          normalized = normalizePlanStep(rawStep, this.#binding.get().targets);
        } catch (error) {
          await this.#auditActionDenied(record, actionId, 'plan_step_invalid');
          throw error;
        }
        if (normalized.target.id !== contribution.targetFacts.id) {
          await this.#auditActionDenied(record, actionId, 'fixed_target_mismatch');
          return hostFail(
            'PLUGIN_HOST_PLAN_STEP_INVALID',
            'authorization',
            'Bundled plan builder changed its constructor-resolved fixed target.',
            record.id,
            actionId,
          );
        }
        step = normalized.step;
        target = normalized.target;
      }

      let planDecision;
      try {
        planDecision = normalizeHostPolicyDecision(
          await this.#policy.validatePlanStep({
            ...authorizationRequest,
            step,
          } as PlanStepValidationRequest<HostPlanStep>),
        );
      } catch (error) {
        await this.#auditActionDenied(record, actionId, 'plan_policy_failed');
        this.#rethrowPolicy(error, record.id);
      }
      if (planDecision!.outcome !== 'allow') {
        await this.#auditActionDenied(
          record,
          actionId,
          planDecision!.code,
          planDecision!.evidenceRefs,
        );
        return hostFail(
          planDecision!.outcome === 'ask' ? 'PLUGIN_HOST_ACTION_ASK' : 'PLUGIN_HOST_ACTION_DENIED',
          'authorization',
          `Plan-step policy returned ${planDecision!.outcome}.`,
          record.id,
          actionId,
        );
      }
      await this.#audit.recordRequired({
        type: 'plugin.action.allowed',
        plugin: { id: record.id, version: record.version },
        providerKind: record.providerKind,
        evidenceRefs: [...decision!.evidenceRefs, ...planDecision!.evidenceRefs],
        facts: [
          { key: 'contributionId', value: actionId },
          { key: 'targetId', value: target.id },
          { key: 'outcome', value: 'planned' },
        ],
      });
      return Object.freeze({
        outcome: 'planned',
        contributedActionId: actionId as PluginContributionId,
        targetActionId: target.id,
        step,
        executable: true,
      });
    } finally {
      this.#endExecutionOperation(record.id);
    }
  }

  async evaluatePrmsBlockers(
    report: Readonly<unknown>,
  ): Promise<{ readonly blockers: readonly BlockingFinding[] }> {
    this.#assertExecutionReady();
    const blockers: BlockingFinding[] = [];
    for (const registered of this.#registry.listPrmsBlockers()) {
      const record = this.#record(registered.pluginId);
      if (this.#lifecycleOperations.has(record.id)) {
        if (record.kind === 'bundled' && record.gate.mode === 'ENFORCE') {
          blockers.push(prmsEvaluatorFailureBlocker(record.id, registered.localId, false));
        }
        continue;
      }
      if (
        record.kind !== 'bundled' ||
        record.lifecycle.state !== 'activated' ||
        record.gate.mode !== 'ENFORCE' ||
        !record.activationEvidence ||
        !record.effectiveCapabilities?.includes('prms.blockers.append')
      ) {
        continue;
      }
      this.#beginExecutionOperation(record.id, registered.id);
      try {
        const context: BundledPluginContext = {
          effectiveCapabilities: record.effectiveCapabilities,
          activationEvidence: record.activationEvidence as BundledActivationEvidence,
        };
        try {
          const projectedReport = projectPrmsReportForEvaluator(report);
          const raw = await runPluginOperationWithDeadline(
            () =>
              registered.value.evaluate(projectedReport as unknown as Readonly<unknown>, context),
            this.#operationTimeoutMs,
          );
          blockers.push(...normalizePrmsBlockerResult(raw).blockers);
        } catch (error) {
          blockers.push(
            prmsEvaluatorFailureBlocker(
              record.id,
              registered.localId,
              error instanceof BundledPluginValidationError,
            ),
          );
        }
      } finally {
        this.#endExecutionOperation(record.id);
      }
    }
    blockers.sort(
      (left, right) =>
        asciiCompare(left.code, right.code) ||
        asciiCompare(left.summary, right.summary) ||
        asciiCompare(left.detail ?? '', right.detail ?? ''),
    );
    return Object.freeze({ blockers: Object.freeze(blockers) });
  }

  snapshot(): PluginHostSnapshot {
    return Object.freeze({
      bound: this.#binding.isBound,
      sealed: this.#sealed,
      registryRevision: this.#registry.revision,
      plugins: Object.freeze(
        this.#registry.listPlugins().map((item) => pluginSnapshot(item.value)),
      ),
      actionIds: Object.freeze(this.#registry.listActions().map((item) => item.id)),
      workflowIds: Object.freeze(this.#registry.listWorkflows().map((item) => item.id)),
      prmsBlockerIds: Object.freeze(this.#registry.listPrmsBlockers().map((item) => item.id)),
    });
  }

  async #auditActionDenied(
    record: HostPluginRecord,
    actionId: string,
    decisionCode: string,
    decisionEvidenceRefs: readonly string[] = [],
  ): Promise<void> {
    await this.#audit.recordRequired({
      type: 'plugin.action.denied',
      plugin: { id: record.id, version: record.version },
      providerKind: record.providerKind,
      evidenceRefs:
        decisionEvidenceRefs.length > 0
          ? decisionEvidenceRefs
          : record.activationEvidence
            ? evidenceRefs(record.activationEvidence)
            : [],
      facts: [
        { key: 'contributionId', value: actionId },
        { key: 'decisionCode', value: decisionCode },
      ],
    });
  }

  #prepareBundledRegistration(registrationValue: unknown): {
    readonly record: BundledHostPluginRecord;
    readonly batch: PluginRegistryBatch<
      HostPluginRecord,
      HostRegisteredAction,
      HostRegisteredWorkflow,
      HostRegisteredAction,
      HostRegisteredWorkflow,
      NormalizedBundledPrmsBlocker
    >;
  } {
    const registration = exactHostDataRecord(
      registrationValue,
      ['definition', 'evidence'],
      'Reviewed bundled registration must contain only definition and evidence.',
    );
    const definition = normalizeBundledPluginDefinition(registration.definition);
    const binding = this.#binding.get();
    assertCompatibleOpenSlackVersion(binding.openslackVersion, definition.requires.openslack);
    if (!binding.gateIds.has(definition.gate.gateId)) {
      return hostFail(
        'PLUGIN_HOST_BINDING_INVALID',
        'binding',
        `Gate ${definition.gate.gateId} is not in the constructor binding.`,
        definition.id,
      );
    }
    if (registration.evidence === undefined || registration.evidence === null) {
      return hostFail(
        'PLUGIN_HOST_ACTIVATION_EVIDENCE_MISSING',
        'authorization',
        'Bundled constructor registration requires activation evidence.',
        definition.id,
      );
    }
    const registrationEvidence = normalizeActivationEvidence(registration.evidence, {
      id: definition.id,
      version: definition.version,
      providerKind: 'bundled',
      compositionId: binding.compositionId,
    }) as BundledActivationEvidence;
    if (registrationEvidence.source.reviewEvidenceRefs.length === 0) {
      return hostFail(
        'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
        'authorization',
        'Bundled constructor registration requires review evidence.',
        definition.id,
      );
    }
    const actions = definition.contributions
      .filter((item): item is NormalizedBundledAction => item.kind === 'bundled_action')
      .map((item): ResolvedBundledAction => {
        const target = binding.targets.getAction(item.target.id);
        if (!target || !target.exists) {
          return hostFail(
            'PLUGIN_ALIAS_TARGET_NOT_FOUND',
            'validation',
            `Bundled action target ${item.target.id} is not in the constructor catalog.`,
            definition.id,
            item.id,
          );
        }
        if (!definition.requestedCapabilities.includes(target.requiredCapability)) {
          return hostFail(
            'PLUGIN_CONTRIBUTION_CAPABILITY_MISSING',
            'capability',
            `Bundled action ${item.id} must request ${target.requiredCapability}.`,
            definition.id,
            item.id,
          );
        }
        return Object.freeze({
          kind: item.kind,
          id: item.id,
          target: item.target,
          targetFacts: target,
          buildPlanStep: item.buildPlanStep,
        });
      });
    const lifecycle = new PluginLifecycleController(definition.id);
    lifecycle.transition('integrity_verified', {
      reason: 'Reviewed constructor composition evidence matched.',
    });
    lifecycle.transition('validated', { reason: 'Bundled definition passed Red host validation.' });
    lifecycle.transition('registered', {
      reason: 'Bundled contributions passed registry preflight.',
    });
    const record: BundledHostPluginRecord = {
      kind: 'bundled',
      id: definition.id,
      version: definition.version,
      providerKind: 'bundled',
      sourceRef: `bundled:${binding.compositionId}/${definition.id}`,
      gate: definition.gate,
      lifecycle,
      requestedCapabilities: definition.requestedCapabilities,
      definition,
      registrationEvidence,
    };
    return {
      record,
      batch: {
        plugin: {
          id: record.id,
          version: record.version,
          providerKind: 'bundled',
          sourceRef: record.sourceRef,
          value: record,
        },
        bundledActions: actions.map((item) => ({ localId: item.id, value: item })),
        bundledWorkflows: definition.contributions
          .filter((item): item is NormalizedBundledWorkflow => item.kind === 'bundled_workflow')
          .map((item) => ({ localId: item.id, value: item })),
        prmsBlockers: definition.contributions
          .filter((item): item is NormalizedBundledPrmsBlocker => item.kind === 'prms_blocker')
          .map((item) => ({ localId: item.id, value: item })),
      },
    };
  }

  #prepareDeclarative(
    loaded: LoadedPluginManifest,
    entry: PluginLockEntry,
  ): {
    readonly record: DeclarativeHostPluginRecord;
    readonly batch: PluginRegistryBatch<
      HostPluginRecord,
      HostRegisteredAction,
      HostRegisteredWorkflow,
      HostRegisteredAction,
      HostRegisteredWorkflow,
      NormalizedBundledPrmsBlocker
    >;
  } {
    const binding = this.#binding.get();
    assertCompatibleOpenSlackVersion(binding.openslackVersion, loaded.manifest.requires.openslack);
    if (!binding.gateIds.has(loaded.manifest.gate.gateId)) {
      return hostFail(
        'PLUGIN_HOST_BINDING_INVALID',
        'binding',
        `Gate ${loaded.manifest.gate.gateId} is not in the sealed host binding.`,
        loaded.pluginId,
      );
    }
    const aliases = loaded.manifest.contributes.map((contribution) =>
      assertDeclarativeAlias(contribution, binding.targets, loaded.pluginId),
    );
    const lifecycle = new PluginLifecycleController(loaded.pluginId);
    lifecycle.transition('integrity_verified', { reason: 'Exact bytes matched the plugin lock.' });
    lifecycle.transition('validated', { reason: 'Manifest and host target policies passed.' });
    lifecycle.transition('registered', { reason: 'Contribution batch passed registry preflight.' });
    const record: DeclarativeHostPluginRecord = {
      kind: 'declarative',
      id: loaded.pluginId,
      version: loaded.manifest.version,
      providerKind: loaded.providerKind,
      sourceRef: loaded.sourceRef,
      gate: loaded.manifest.gate,
      lifecycle,
      requestedCapabilities: loaded.manifest.capabilities,
      manifest: loaded.manifest,
      manifestSha256: loaded.manifestSha256,
      lockManifestSha256: entry.manifestSha256,
      aliases: Object.freeze(aliases),
    };
    return {
      record,
      batch: {
        plugin: {
          id: record.id,
          version: record.version,
          providerKind: record.providerKind,
          sourceRef: record.sourceRef,
          value: record,
        },
        actionAliases: aliases
          .filter((alias) => alias.kind === 'action_alias')
          .map((alias) => ({ localId: alias.contribution.id, value: alias })),
        workflowAliases: aliases
          .filter((alias) => alias.kind === 'workflow_alias')
          .map((alias) => ({ localId: alias.contribution.id, value: alias })),
      },
    };
  }

  #assertRegistrationOpen(): void {
    this.#binding.get();
    if (this.#sealed)
      hostFail('PLUGIN_HOST_SEALED', 'registration', 'A sealed host cannot register plugins.');
  }

  #assertExecutionReady(): void {
    this.#binding.get();
    if (!this.#sealed)
      hostFail(
        'PLUGIN_HOST_NOT_SEALED',
        'binding',
        'Host must be sealed before activation or execution.',
      );
  }

  #beginLifecycleOperation(pluginId: string): void {
    if (
      this.#lifecycleOperations.has(pluginId) ||
      (this.#executionOperations.get(pluginId) ?? 0) > 0
    ) {
      hostFail(
        'PLUGIN_LIFECYCLE_INVALID_TRANSITION',
        'lifecycle',
        `Plugin ${pluginId} already has a lifecycle operation in flight.`,
        pluginId,
      );
    }
    this.#lifecycleOperations.add(pluginId);
  }

  #endLifecycleOperation(pluginId: string): void {
    this.#lifecycleOperations.delete(pluginId);
  }

  #assertLifecycleIdle(pluginId: string, contributionId?: string): void {
    if (this.#lifecycleOperations.has(pluginId)) {
      hostFail(
        'PLUGIN_LIFECYCLE_INVALID_TRANSITION',
        'lifecycle',
        `Plugin ${pluginId} cannot execute while a lifecycle operation is in flight.`,
        pluginId,
        contributionId,
      );
    }
  }

  #beginExecutionOperation(pluginId: string, contributionId?: string): void {
    this.#assertLifecycleIdle(pluginId, contributionId);
    this.#executionOperations.set(pluginId, (this.#executionOperations.get(pluginId) ?? 0) + 1);
  }

  #endExecutionOperation(pluginId: string): void {
    const remaining = (this.#executionOperations.get(pluginId) ?? 1) - 1;
    if (remaining <= 0) this.#executionOperations.delete(pluginId);
    else this.#executionOperations.set(pluginId, remaining);
  }

  #record(pluginId: string): HostPluginRecord {
    const record = this.#registry.getPlugin(pluginId)?.value;
    if (!record) {
      return hostFail(
        'PLUGIN_HOST_BUNDLED_REGISTRATION_REQUIRED',
        'registration',
        `Plugin ${pluginId} is not registered.`,
        pluginId,
      );
    }
    return record;
  }

  #rethrowValidation(error: unknown, pluginId: string): never {
    if (error instanceof PluginHostError) throw error;
    if (error instanceof HostInputValidationError) {
      return hostFail(error.code, 'authorization', error.message, pluginId);
    }
    if (error instanceof BundledPluginValidationError) {
      return hostFail(error.code, 'validation', error.message, pluginId);
    }
    return hostFail(
      'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
      'authorization',
      'Activation evidence validation failed closed.',
      pluginId,
    );
  }

  #rethrowPolicy(error: unknown, pluginId: string): never {
    if (error instanceof PluginHostError) throw error;
    if (error instanceof HostInputValidationError) {
      return hostFail(
        'PLUGIN_HOST_POLICY_DECISION_INVALID',
        'authorization',
        error.message,
        pluginId,
      );
    }
    return hostFail(
      'PLUGIN_HOST_POLICY_DECISION_INVALID',
      'authorization',
      'Host policy failed or returned malformed data.',
      pluginId,
    );
  }
}

export function pluginActionId(pluginId: string, localId: string): PluginContributionId {
  return canonicalPluginContributionId(pluginId, localId);
}
