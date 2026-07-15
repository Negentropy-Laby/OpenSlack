import type { PluginCapability } from './capabilities.js';

export type MaybePromise<T> = T | Promise<T>;
export type PluginProviderKind = 'built-in' | 'bundled' | 'workspace' | 'plugin';
export type PluginActorKind = 'human' | 'agent' | 'system' | 'application';
export type CanonicalRiskLevel = 'none' | 'low' | 'medium' | 'high';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface PluginIdentity {
  readonly id: string;
  readonly version: string;
}

export interface ActivationEvidenceBase {
  readonly schema: 'openslack.plugin_activation_evidence.v1';
  readonly plugin: PluginIdentity;
  readonly observedAt: string;
  readonly actor: {
    readonly id: string;
    readonly kind: PluginActorKind;
    readonly provider: string;
  };
  readonly humanApproval: {
    readonly required: boolean;
    readonly satisfied: boolean;
    readonly evidenceRefs: readonly string[];
  };
}

export type ActivationEvidence =
  | (ActivationEvidenceBase & {
      readonly providerKind: 'built-in';
      readonly source: {
        readonly kind: 'built_in';
        readonly compositionId: string;
      };
    })
  | (ActivationEvidenceBase & {
      readonly providerKind: 'bundled';
      readonly source: {
        readonly kind: 'bundled';
        readonly compositionId: string;
        readonly reviewEvidenceRefs: readonly string[];
      };
    })
  | (ActivationEvidenceBase & {
      readonly providerKind: 'workspace' | 'plugin';
      readonly source: {
        readonly kind: 'locked_manifest';
        readonly sourceRef: string;
        readonly manifestSha256: string;
        readonly lockManifestSha256: string;
        readonly integrityMatched: boolean;
      };
    });

export interface CanonicalActionPolicyFacts {
  readonly id: string;
  readonly sideEffects: boolean;
  readonly risk: CanonicalRiskLevel;
  readonly confirmationRequired: boolean;
}

export interface HostPlanStep {
  readonly id: string;
  readonly actionId: string;
  readonly input: Readonly<Record<string, JsonValue>>;
}

export interface ActivationAuthorizationRequest {
  readonly plugin: PluginIdentity;
  readonly requestedCapabilities: readonly PluginCapability[];
  readonly evidence: ActivationEvidence;
}

export type ActivationAuthorizationDecision =
  | {
      readonly outcome: 'allow';
      readonly code: 'PLUGIN_ACTIVATION_ALLOWED';
      readonly reason: string;
      readonly hostAllowedCapabilities: readonly PluginCapability[];
      readonly actorAllowedCapabilities: readonly PluginCapability[];
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly outcome: 'ask' | 'deny';
      readonly code: string;
      readonly reason: string;
      readonly evidenceRefs: readonly string[];
    };

export interface ActionAuthorizationRequest {
  readonly plugin: PluginIdentity;
  readonly providerKind: PluginProviderKind;
  readonly contributedActionId: string;
  readonly target: CanonicalActionPolicyFacts;
  readonly effectiveCapabilities: readonly PluginCapability[];
  readonly evidence: ActivationEvidence;
}

export interface PlanStepValidationRequest<
  TPlanStep = HostPlanStep,
> extends ActionAuthorizationRequest {
  readonly step: Readonly<TPlanStep>;
}

export type HostPolicyDecision =
  | {
      readonly outcome: 'allow';
      readonly code: string;
      readonly reason: string;
      readonly evidenceRefs: readonly string[];
    }
  | {
      readonly outcome: 'ask' | 'deny';
      readonly code: string;
      readonly reason: string;
      readonly evidenceRefs: readonly string[];
    };

export interface PluginAuditEvent {
  readonly schema: 'openslack.plugin_audit_event.v1';
  readonly type:
    | 'plugin.activation.requested'
    | 'plugin.activation.allowed'
    | 'plugin.activation.denied'
    | 'plugin.action.requested'
    | 'plugin.action.allowed'
    | 'plugin.action.denied'
    | 'plugin.lifecycle.changed';
  readonly plugin: PluginIdentity;
  readonly providerKind: PluginProviderKind;
  readonly occurredAt: string;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface HostPolicyPort<TPlanStep = HostPlanStep> {
  authorizeActivation(
    request: ActivationAuthorizationRequest,
  ): MaybePromise<ActivationAuthorizationDecision>;
  authorizeAction(request: ActionAuthorizationRequest): MaybePromise<HostPolicyDecision>;
  validatePlanStep(request: PlanStepValidationRequest<TPlanStep>): MaybePromise<HostPolicyDecision>;
  recordAuditEvent(event: PluginAuditEvent): MaybePromise<void>;
}
