import type { ActivationEvidence, HostPlanStep, JsonValue } from '@openslack/plugin-api';
import { pluginActionId, type PluginHost } from '@openslack/plugin-host';
import {
  executePlan,
  type ActionPlan,
  type ActionRegistryPort,
  type ExecutionResult,
  type ToolInput,
} from '@openslack/operator';

export const PLUGIN_ACTION_WORKSPACE_LOAD_FAILED = 'PLUGIN_ACTION_WORKSPACE_LOAD_FAILED' as const;

export const PLUGIN_ACTION_ROUTING_ERROR_CODES = Object.freeze([
  'PLUGIN_ACTION_PLUGIN_NOT_REGISTERED',
  'PLUGIN_ACTION_ACTION_NOT_REGISTERED',
  'PLUGIN_ACTION_ACTIVATION_EVIDENCE_UNAVAILABLE',
  'PLUGIN_ACTION_LIFECYCLE_UNAVAILABLE',
  'PLUGIN_ACTION_BRIDGE_INVALID',
  PLUGIN_ACTION_WORKSPACE_LOAD_FAILED,
] as const);

export type PluginActionRoutingErrorCode = (typeof PLUGIN_ACTION_ROUTING_ERROR_CODES)[number];

export class PluginActionRoutingError extends Error {
  readonly code: PluginActionRoutingErrorCode;

  constructor(code: PluginActionRoutingErrorCode) {
    super(code);
    this.name = 'PluginActionRoutingError';
    this.code = code;
  }
}

export type ActivationEvidenceResolver = (
  pluginId: string,
) => ActivationEvidence | undefined | Promise<ActivationEvidence | undefined>;

export type PluginPlanExecutor = (
  plan: ActionPlan,
  registry: ActionRegistryPort,
) => Promise<ExecutionResult>;

export type PluginActionRunResult =
  | {
      readonly outcome: 'shadowed';
      readonly contributedActionId: string;
      readonly targetActionId: string;
      readonly executable: false;
    }
  | {
      readonly outcome: 'executed';
      readonly contributedActionId: string;
      readonly targetActionId: string;
      readonly executable: true;
      readonly execution: ExecutionResult;
    };

export interface PluginActionRunnerPort {
  run(pluginId: string, localActionId: string): Promise<PluginActionRunResult>;
}

export interface PluginActionRunnerOptions {
  readonly host: PluginHost;
  readonly actionRegistry: ActionRegistryPort;
  readonly resolveActivationEvidence?: ActivationEvidenceResolver;
  readonly execute?: PluginPlanExecutor;
}

function routingFail(code: PluginActionRoutingErrorCode): never {
  throw new PluginActionRoutingError(code);
}

function toToolInput(input: Readonly<Record<string, JsonValue>>): ToolInput {
  let prototype: object | null;
  let descriptors: Record<string, PropertyDescriptor>;
  let symbols: symbol[];
  try {
    prototype = Object.getPrototypeOf(input) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(input) as Record<string, PropertyDescriptor>;
    symbols = Object.getOwnPropertySymbols(input);
  } catch {
    return routingFail('PLUGIN_ACTION_BRIDGE_INVALID');
  }
  if ((prototype !== Object.prototype && prototype !== null) || symbols.length > 0) {
    return routingFail('PLUGIN_ACTION_BRIDGE_INVALID');
  }

  const output = Object.create(null) as ToolInput;
  for (const [name, descriptor] of Object.entries(descriptors)) {
    const value = descriptor.value as unknown;
    if (
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      (typeof value !== 'string' &&
        typeof value !== 'boolean' &&
        (typeof value !== 'number' || !Number.isFinite(value)))
    ) {
      return routingFail('PLUGIN_ACTION_BRIDGE_INVALID');
    }
    output[name] = value;
  }
  return Object.freeze(output);
}

function buildCanonicalPlan(
  hostStep: Readonly<HostPlanStep>,
  targetActionId: string,
  registry: ActionRegistryPort,
): ActionPlan {
  if (hostStep.actionId !== targetActionId) {
    return routingFail('PLUGIN_ACTION_BRIDGE_INVALID');
  }
  const action = registry.get(targetActionId);
  if (!action) return routingFail('PLUGIN_ACTION_BRIDGE_INVALID');
  if (action.sideEffects || action.confirmationRequired || action.riskLevel !== 'none') {
    return routingFail('PLUGIN_ACTION_BRIDGE_INVALID');
  }

  let step;
  try {
    step = registry.createStep(targetActionId, toToolInput(hostStep.input), hostStep.id);
  } catch {
    return routingFail('PLUGIN_ACTION_BRIDGE_INVALID');
  }

  return {
    goal: `Run governed plugin action ${targetActionId}`,
    intent: { kind: 'unknown', slots: {}, confidence: 1 },
    steps: [step],
    riskLevel: action.riskLevel,
    riskExplanation: 'The sealed plugin host authorized an existing canonical OpenSlack action.',
    missingParams: [],
    requiresConfirmation: action.confirmationRequired,
    sideEffects: action.sideEffects,
  };
}

async function defaultExecute(
  plan: ActionPlan,
  registry: ActionRegistryPort,
): Promise<ExecutionResult> {
  return executePlan(plan, {}, registry);
}

export function createPluginActionRunner(
  options: PluginActionRunnerOptions,
): PluginActionRunnerPort {
  const execute = options.execute ?? defaultExecute;
  const resolveActivationEvidence = options.resolveActivationEvidence ?? (() => undefined);

  return Object.freeze({
    async run(pluginId: string, localActionId: string): Promise<PluginActionRunResult> {
      const snapshot = options.host.snapshot();
      const plugin = snapshot.plugins.find((item) => item.id === pluginId);
      if (!plugin) return routingFail('PLUGIN_ACTION_PLUGIN_NOT_REGISTERED');
      const contributedActionId = pluginActionId(pluginId, localActionId);
      if (!snapshot.actionIds.includes(contributedActionId)) {
        return routingFail('PLUGIN_ACTION_ACTION_NOT_REGISTERED');
      }

      if (plugin.lifecycle.state === 'registered' || plugin.lifecycle.state === 'degraded') {
        const evidence = await resolveActivationEvidence(pluginId);
        if (!evidence) return routingFail('PLUGIN_ACTION_ACTIVATION_EVIDENCE_UNAVAILABLE');
        await options.host.activate(pluginId, evidence);
      } else if (plugin.lifecycle.state !== 'activated') {
        return routingFail('PLUGIN_ACTION_LIFECYCLE_UNAVAILABLE');
      }

      const routed = await options.host.planAction(contributedActionId, {});
      if (routed.outcome === 'shadowed') {
        return Object.freeze({
          outcome: 'shadowed',
          contributedActionId: routed.contributedActionId,
          targetActionId: routed.targetActionId,
          executable: false,
        });
      }

      const plan = buildCanonicalPlan(routed.step, routed.targetActionId, options.actionRegistry);
      const execution = await execute(plan, options.actionRegistry);
      return Object.freeze({
        outcome: 'executed',
        contributedActionId: routed.contributedActionId,
        targetActionId: routed.targetActionId,
        executable: true,
        execution,
      });
    },
  });
}
