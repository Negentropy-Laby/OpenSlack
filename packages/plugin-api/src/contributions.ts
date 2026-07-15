import type { BundledPluginCapability } from './capabilities.js';
import type {
  ActivationEvidence,
  HostPlanStep,
  JsonPrimitive,
  MaybePromise,
  PluginIdentity,
} from './policy.js';

export const DECLARATIVE_CONTRIBUTION_KINDS = ['action_alias', 'workflow_alias'] as const;
export type DeclarativeContributionKind = (typeof DECLARATIVE_CONTRIBUTION_KINDS)[number];

export const INPUT_DEFINITION_TYPES = ['string', 'number', 'boolean'] as const;
export type PluginInputType = (typeof INPUT_DEFINITION_TYPES)[number];

export interface PluginInputDefinitionV1 {
  readonly type: PluginInputType;
  readonly required?: boolean;
  readonly description?: string;
}

export type DeclarativeInputBindingV1 =
  | {
      readonly kind: 'constant';
      readonly value: Exclude<JsonPrimitive, null>;
    }
  | {
      readonly kind: 'input';
      readonly name: string;
    };

interface DeclarativeContributionBaseV1 {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputs?: Readonly<Record<string, PluginInputDefinitionV1>>;
  readonly inputMapping?: Readonly<Record<string, DeclarativeInputBindingV1>>;
}

export interface DeclarativeActionAliasV1 extends DeclarativeContributionBaseV1 {
  readonly kind: 'action_alias';
  readonly target: {
    readonly kind: 'host_action';
    readonly id: string;
  };
}

export interface DeclarativeWorkflowAliasV1 extends DeclarativeContributionBaseV1 {
  readonly kind: 'workflow_alias';
  readonly target: {
    readonly kind: 'host_workflow';
    readonly id: string;
  };
}

export type DeclarativeContributionV1 = DeclarativeActionAliasV1 | DeclarativeWorkflowAliasV1;

export interface BundledPluginContext {
  readonly plugin: PluginIdentity;
  readonly effectiveCapabilities: readonly BundledPluginCapability[];
  readonly activationEvidence: ActivationEvidence;
}

export interface BundledActionContribution<TPlanStep = HostPlanStep> {
  readonly kind: 'bundled_action';
  readonly id: string;
  buildPlanStep(
    input: Readonly<Record<string, Exclude<JsonPrimitive, null>>>,
    context: BundledPluginContext,
  ): MaybePromise<TPlanStep>;
}

export interface BundledWorkflowContribution<TWorkflow = unknown> {
  readonly kind: 'bundled_workflow';
  readonly id: string;
  readonly catalogItem: TWorkflow;
}

export interface BlockingFinding {
  readonly kind: 'blocker';
  readonly code: string;
  readonly summary: string;
  readonly detail?: string;
}

export interface BundledPrmsBlockerContribution<TPrmsReport = unknown> {
  readonly kind: 'prms_blocker';
  readonly id: string;
  evaluate(
    report: Readonly<TPrmsReport>,
    context: BundledPluginContext,
  ): MaybePromise<{ readonly blockers: readonly BlockingFinding[] }>;
}

export type BundledContribution<
  TPlanStep = HostPlanStep,
  TWorkflow = unknown,
  TPrmsReport = unknown,
> =
  | BundledActionContribution<TPlanStep>
  | BundledWorkflowContribution<TWorkflow>
  | BundledPrmsBlockerContribution<TPrmsReport>;

export interface BundledPluginDefinition<
  TPlanStep = HostPlanStep,
  TWorkflow = unknown,
  TPrmsReport = unknown,
> extends PluginIdentity {
  readonly providerKind: 'bundled';
  readonly name: string;
  readonly description?: string;
  readonly requires: {
    readonly openslack: string;
  };
  readonly gate: {
    readonly mode: 'SHADOW' | 'ENFORCE';
    readonly gateId: string;
  };
  readonly requestedCapabilities: readonly BundledPluginCapability[];
  readonly contributions: readonly BundledContribution<TPlanStep, TWorkflow, TPrmsReport>[];
  activate?(context: BundledPluginContext): MaybePromise<void>;
  deactivate?(context: BundledPluginContext): MaybePromise<void>;
}
