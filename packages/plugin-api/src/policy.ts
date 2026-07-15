import type {
  BundledPluginCapability,
  DeclarativePluginCapability,
  PluginCapability,
} from './capabilities.js';

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

export type BuiltInActivationEvidence = Extract<
  ActivationEvidence,
  { readonly providerKind: 'built-in' }
>;
export type BundledActivationEvidence = Extract<
  ActivationEvidence,
  { readonly providerKind: 'bundled' }
>;
export type DeclarativeActivationEvidence = Extract<
  ActivationEvidence,
  { readonly providerKind: 'workspace' | 'plugin' }
>;

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

export type ActivationAuthorizationRequest =
  | {
      readonly requestedCapabilities: readonly DeclarativePluginCapability[];
      readonly evidence: DeclarativeActivationEvidence;
    }
  | {
      readonly requestedCapabilities: readonly BundledPluginCapability[];
      readonly evidence: BuiltInActivationEvidence | BundledActivationEvidence;
    };

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

interface ActionAuthorizationRequestBase {
  readonly contributedActionId: string;
  readonly target: CanonicalActionPolicyFacts;
}

export type ActionAuthorizationRequest = ActionAuthorizationRequestBase &
  (
    | {
        readonly effectiveCapabilities: readonly DeclarativePluginCapability[];
        readonly evidence: DeclarativeActivationEvidence;
      }
    | {
        readonly effectiveCapabilities: readonly BundledPluginCapability[];
        readonly evidence: BuiltInActivationEvidence | BundledActivationEvidence;
      }
  );

export type PlanStepValidationRequest<TPlanStep = HostPlanStep> = ActionAuthorizationRequest & {
  readonly step: Readonly<TPlanStep>;
};

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
  /** Host-produced, bounded facts only. The host must redact values before persistence. */
  readonly metadata?: Readonly<Record<string, JsonPrimitive>>;
}

export interface HostPolicyPort<TPlanStep = HostPlanStep> {
  authorizeActivation(
    request: ActivationAuthorizationRequest,
  ): MaybePromise<ActivationAuthorizationDecision>;
  authorizeAction(request: ActionAuthorizationRequest): MaybePromise<HostPolicyDecision>;
  validatePlanStep(request: PlanStepValidationRequest<TPlanStep>): MaybePromise<HostPolicyDecision>;
  recordAuditEvent(event: PluginAuditEvent): MaybePromise<void>;
}
