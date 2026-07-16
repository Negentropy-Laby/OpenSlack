import { PluginHostError, asciiCompare, sortFindings, type PluginHostFinding } from './findings.js';

const LOCAL_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PLUGIN_ID_PATTERN = LOCAL_ID_PATTERN;
const RESERVED_PLUGIN_IDS = new Set([
  'openslack',
  'built-in',
  'plugin',
  'workspace',
  'external',
  'negentropy',
]);

export type RegistryProviderKind = 'bundled' | 'workspace' | 'plugin';
export type RegisteredActionKind = 'action_alias' | 'bundled_action';
export type RegisteredWorkflowKind = 'workflow_alias' | 'bundled_workflow';

export interface RegistryPluginInput<TPlugin = unknown> {
  readonly id: string;
  readonly version: string;
  readonly providerKind: RegistryProviderKind;
  readonly sourceRef: string;
  readonly value: TPlugin;
}

export interface RegistryContributionInput<TValue = unknown> {
  readonly localId: string;
  readonly value: TValue;
}

export interface PluginRegistryBatch<
  TPlugin = unknown,
  TActionAlias = unknown,
  TWorkflowAlias = unknown,
  TBundledAction = unknown,
  TBundledWorkflow = unknown,
  TPrmsBlocker = unknown,
> {
  readonly plugin: RegistryPluginInput<TPlugin>;
  readonly actionAliases?: readonly RegistryContributionInput<TActionAlias>[];
  readonly workflowAliases?: readonly RegistryContributionInput<TWorkflowAlias>[];
  readonly bundledActions?: readonly RegistryContributionInput<TBundledAction>[];
  readonly bundledWorkflows?: readonly RegistryContributionInput<TBundledWorkflow>[];
  readonly prmsBlockers?: readonly RegistryContributionInput<TPrmsBlocker>[];
}

export type RegisteredPlugin<TPlugin = unknown> = RegistryPluginInput<TPlugin>;

export interface RegisteredAction<TValue = unknown> {
  readonly id: PluginContributionId;
  readonly pluginId: string;
  readonly localId: string;
  readonly kind: RegisteredActionKind;
  readonly sourceRef: string;
  readonly value: TValue;
}

export interface RegisteredWorkflow<TValue = unknown> {
  readonly id: PluginContributionId;
  readonly pluginId: string;
  readonly localId: string;
  readonly kind: RegisteredWorkflowKind;
  readonly sourceRef: string;
  readonly value: TValue;
}

export interface RegisteredPrmsBlocker<TValue = unknown> {
  readonly id: PluginContributionId;
  readonly pluginId: string;
  readonly localId: string;
  readonly kind: 'prms_blocker';
  readonly sourceRef: string;
  readonly value: TValue;
}

declare const PLUGIN_CONTRIBUTION_ID_BRAND: unique symbol;
export type PluginContributionId = `plugin:${string}:${string}` & {
  readonly [PLUGIN_CONTRIBUTION_ID_BRAND]: true;
};

export interface RegistryPreflight {
  readonly revision: number;
  readonly pluginIds: readonly string[];
  readonly contributionIds: readonly PluginContributionId[];
}

export interface RegistryCommitSummary {
  readonly revision: number;
  readonly pluginIds: readonly string[];
  readonly contributionIds: readonly PluginContributionId[];
}

interface NormalizedBatch {
  readonly plugin: RegisteredPlugin;
  readonly actions: readonly RegisteredAction[];
  readonly workflows: readonly RegisteredWorkflow[];
  readonly prmsBlockers: readonly RegisteredPrmsBlocker[];
}

interface PreparedRegistration {
  readonly revision: number;
  readonly batches: readonly NormalizedBatch[];
  consumed: boolean;
}

export function canonicalPluginContributionId(
  pluginId: string,
  localId: string,
): PluginContributionId {
  return `plugin:${pluginId}:${localId}` as PluginContributionId;
}

function validPluginId(id: string): boolean {
  return (
    id.length <= 64 &&
    PLUGIN_ID_PATTERN.test(id) &&
    !id.startsWith('openslack-') &&
    !RESERVED_PLUGIN_IDS.has(id)
  );
}

function validLocalId(id: string): boolean {
  return id.length <= 64 && LOCAL_ID_PATTERN.test(id);
}

function canonicalSource(batch: PluginRegistryBatch): string {
  return `${batch.plugin.providerKind}\u0000${batch.plugin.sourceRef}\u0000${batch.plugin.id}`;
}

function freezePlugin(plugin: RegistryPluginInput): RegisteredPlugin {
  return Object.freeze({ ...plugin });
}

function normalizeContribution<T>(
  plugin: RegistryPluginInput,
  input: RegistryContributionInput<T>,
  kind: RegisteredActionKind,
): RegisteredAction<T>;
function normalizeContribution<T>(
  plugin: RegistryPluginInput,
  input: RegistryContributionInput<T>,
  kind: RegisteredWorkflowKind,
): RegisteredWorkflow<T>;
function normalizeContribution<T>(
  plugin: RegistryPluginInput,
  input: RegistryContributionInput<T>,
  kind: 'prms_blocker',
): RegisteredPrmsBlocker<T>;
function normalizeContribution<T>(
  plugin: RegistryPluginInput,
  input: RegistryContributionInput<T>,
  kind: RegisteredActionKind | RegisteredWorkflowKind | 'prms_blocker',
): RegisteredAction<T> | RegisteredWorkflow<T> | RegisteredPrmsBlocker<T> {
  return Object.freeze({
    id: canonicalPluginContributionId(plugin.id, input.localId),
    pluginId: plugin.id,
    localId: input.localId,
    kind,
    sourceRef: plugin.sourceRef,
    value: input.value,
  });
}

function normalizeBatch(batch: PluginRegistryBatch): NormalizedBatch {
  const actions = [
    ...(batch.actionAliases ?? []).map((input) =>
      normalizeContribution(batch.plugin, input, 'action_alias'),
    ),
    ...(batch.bundledActions ?? []).map((input) =>
      normalizeContribution(batch.plugin, input, 'bundled_action'),
    ),
  ].sort((left, right) => asciiCompare(left.id, right.id));
  const workflows = [
    ...(batch.workflowAliases ?? []).map((input) =>
      normalizeContribution(batch.plugin, input, 'workflow_alias'),
    ),
    ...(batch.bundledWorkflows ?? []).map((input) =>
      normalizeContribution(batch.plugin, input, 'bundled_workflow'),
    ),
  ].sort((left, right) => asciiCompare(left.id, right.id));
  const prmsBlockers = (batch.prmsBlockers ?? [])
    .map((input) => normalizeContribution(batch.plugin, input, 'prms_blocker'))
    .sort((left, right) => asciiCompare(left.id, right.id));
  return Object.freeze({
    plugin: freezePlugin(batch.plugin),
    actions: Object.freeze(actions),
    workflows: Object.freeze(workflows),
    prmsBlockers: Object.freeze(prmsBlockers),
  });
}

function collisionFinding(
  code:
    | 'PLUGIN_REGISTRY_PLUGIN_COLLISION'
    | 'PLUGIN_REGISTRY_ACTION_COLLISION'
    | 'PLUGIN_REGISTRY_WORKFLOW_COLLISION'
    | 'PLUGIN_REGISTRY_PRMS_BLOCKER_COLLISION',
  pluginId: string,
  contributionId: string | undefined,
  noun: string,
): PluginHostFinding {
  return {
    phase: 'registration',
    code,
    pluginId,
    contributionId,
    summary: `${noun} ${contributionId ?? pluginId} collides with an existing or staged registration.`,
  };
}

export class PluginRegistrySet<
  TPlugin = unknown,
  TAction = unknown,
  TWorkflow = unknown,
  TPrmsBlocker = unknown,
> {
  readonly #plugins = new Map<string, RegisteredPlugin<TPlugin>>();
  readonly #actions = new Map<string, RegisteredAction<TAction>>();
  readonly #workflows = new Map<string, RegisteredWorkflow<TWorkflow>>();
  readonly #prmsBlockers = new Map<string, RegisteredPrmsBlocker<TPrmsBlocker>>();
  readonly #prepared = new WeakMap<RegistryPreflight, PreparedRegistration>();
  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

  preflight(
    batches: readonly PluginRegistryBatch<
      TPlugin,
      TAction,
      TWorkflow,
      TAction,
      TWorkflow,
      TPrmsBlocker
    >[],
  ): RegistryPreflight {
    const normalized = [...batches]
      .sort((left, right) => asciiCompare(canonicalSource(left), canonicalSource(right)))
      .map(normalizeBatch);
    const findings: PluginHostFinding[] = [];
    const stagedPlugins = new Set<string>();
    const stagedActions = new Set<string>();
    const stagedWorkflows = new Set<string>();
    const stagedPrmsBlockers = new Set<string>();

    for (const batch of normalized) {
      const pluginId = batch.plugin.id;
      if (!validPluginId(pluginId) || batch.plugin.sourceRef.length === 0) {
        findings.push({
          phase: 'registration',
          code: 'PLUGIN_REGISTRY_INVALID_ID',
          pluginId,
          summary: `Plugin identity or source for ${pluginId} is invalid.`,
        });
      }
      if (this.#plugins.has(pluginId) || stagedPlugins.has(pluginId)) {
        findings.push(
          collisionFinding('PLUGIN_REGISTRY_PLUGIN_COLLISION', pluginId, undefined, 'Plugin'),
        );
      }
      stagedPlugins.add(pluginId);

      for (const action of batch.actions) {
        if (!validLocalId(action.localId)) {
          findings.push({
            phase: 'registration',
            code: 'PLUGIN_REGISTRY_INVALID_ID',
            pluginId,
            contributionId: action.id,
            summary: `Action local ID ${action.localId} is invalid.`,
          });
        }
        if (this.#actions.has(action.id) || stagedActions.has(action.id)) {
          findings.push(
            collisionFinding('PLUGIN_REGISTRY_ACTION_COLLISION', pluginId, action.id, 'Action'),
          );
        }
        stagedActions.add(action.id);
      }

      for (const workflow of batch.workflows) {
        if (!validLocalId(workflow.localId)) {
          findings.push({
            phase: 'registration',
            code: 'PLUGIN_REGISTRY_INVALID_ID',
            pluginId,
            contributionId: workflow.id,
            summary: `Workflow local ID ${workflow.localId} is invalid.`,
          });
        }
        if (this.#workflows.has(workflow.id) || stagedWorkflows.has(workflow.id)) {
          findings.push(
            collisionFinding(
              'PLUGIN_REGISTRY_WORKFLOW_COLLISION',
              pluginId,
              workflow.id,
              'Workflow',
            ),
          );
        }
        stagedWorkflows.add(workflow.id);
      }

      for (const blocker of batch.prmsBlockers) {
        if (!validLocalId(blocker.localId)) {
          findings.push({
            phase: 'registration',
            code: 'PLUGIN_REGISTRY_INVALID_ID',
            pluginId,
            contributionId: blocker.id,
            summary: `PRMS blocker local ID ${blocker.localId} is invalid.`,
          });
        }
        if (this.#prmsBlockers.has(blocker.id) || stagedPrmsBlockers.has(blocker.id)) {
          findings.push(
            collisionFinding(
              'PLUGIN_REGISTRY_PRMS_BLOCKER_COLLISION',
              pluginId,
              blocker.id,
              'PRMS blocker',
            ),
          );
        }
        stagedPrmsBlockers.add(blocker.id);
      }
    }

    if (findings.length > 0) throw new PluginHostError(sortFindings(findings));

    const contributionIds = [...stagedActions, ...stagedWorkflows, ...stagedPrmsBlockers].sort(
      asciiCompare,
    ) as PluginContributionId[];
    const preflight = Object.freeze({
      revision: this.#revision,
      pluginIds: Object.freeze([...stagedPlugins].sort(asciiCompare)),
      contributionIds: Object.freeze(contributionIds),
    });
    this.#prepared.set(preflight, {
      revision: this.#revision,
      batches: Object.freeze(normalized),
      consumed: false,
    });
    return preflight;
  }

  commit(preflight: RegistryPreflight): RegistryCommitSummary {
    const prepared = this.#prepared.get(preflight);
    if (!prepared) {
      throw new PluginHostError([
        {
          phase: 'registration',
          code: 'PLUGIN_REGISTRY_PREFLIGHT_FOREIGN',
          summary: 'Registry preflight was not created by this registry instance.',
        },
      ]);
    }
    if (prepared.consumed) {
      throw new PluginHostError([
        {
          phase: 'registration',
          code: 'PLUGIN_REGISTRY_PREFLIGHT_REUSED',
          summary: 'Registry preflight has already been committed.',
        },
      ]);
    }
    if (prepared.revision !== this.#revision) {
      throw new PluginHostError([
        {
          phase: 'registration',
          code: 'PLUGIN_REGISTRY_PREFLIGHT_STALE',
          summary: 'Registry state changed after preflight.',
        },
      ]);
    }

    for (const batch of prepared.batches) {
      this.#plugins.set(batch.plugin.id, batch.plugin as RegisteredPlugin<TPlugin>);
      for (const action of batch.actions) {
        this.#actions.set(action.id, action as RegisteredAction<TAction>);
      }
      for (const workflow of batch.workflows) {
        this.#workflows.set(workflow.id, workflow as RegisteredWorkflow<TWorkflow>);
      }
      for (const blocker of batch.prmsBlockers) {
        this.#prmsBlockers.set(blocker.id, blocker as RegisteredPrmsBlocker<TPrmsBlocker>);
      }
    }
    prepared.consumed = true;
    this.#revision += 1;
    return Object.freeze({
      revision: this.#revision,
      pluginIds: preflight.pluginIds,
      contributionIds: preflight.contributionIds,
    });
  }

  registerBatches(
    batches: readonly PluginRegistryBatch<
      TPlugin,
      TAction,
      TWorkflow,
      TAction,
      TWorkflow,
      TPrmsBlocker
    >[],
  ): RegistryCommitSummary {
    return this.commit(this.preflight(batches));
  }

  getPlugin(id: string): RegisteredPlugin<TPlugin> | undefined {
    return this.#plugins.get(id);
  }

  getAction(id: string): RegisteredAction<TAction> | undefined {
    return this.#actions.get(id);
  }

  getWorkflow(id: string): RegisteredWorkflow<TWorkflow> | undefined {
    return this.#workflows.get(id);
  }

  getPrmsBlocker(id: string): RegisteredPrmsBlocker<TPrmsBlocker> | undefined {
    return this.#prmsBlockers.get(id);
  }

  listPlugins(): readonly RegisteredPlugin<TPlugin>[] {
    return Object.freeze([...this.#plugins.values()].sort((a, b) => asciiCompare(a.id, b.id)));
  }

  listActions(): readonly RegisteredAction<TAction>[] {
    return Object.freeze([...this.#actions.values()].sort((a, b) => asciiCompare(a.id, b.id)));
  }

  listWorkflows(): readonly RegisteredWorkflow<TWorkflow>[] {
    return Object.freeze([...this.#workflows.values()].sort((a, b) => asciiCompare(a.id, b.id)));
  }

  listPrmsBlockers(): readonly RegisteredPrmsBlocker<TPrmsBlocker>[] {
    return Object.freeze([...this.#prmsBlockers.values()].sort((a, b) => asciiCompare(a.id, b.id)));
  }
}
