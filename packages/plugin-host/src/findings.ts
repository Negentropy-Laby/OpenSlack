export const PLUGIN_HOST_PHASES = Object.freeze([
  'binding',
  'integrity',
  'validation',
  'capability',
  'registration',
  'lifecycle',
  'authorization',
  'audit',
] as const);

export type PluginHostPhase = (typeof PLUGIN_HOST_PHASES)[number];

export const PLUGIN_HOST_FINDING_CODES = Object.freeze([
  'PLUGIN_HOST_ALREADY_BOUND',
  'PLUGIN_HOST_NOT_BOUND',
  'PLUGIN_HOST_BINDING_INVALID',
  'PLUGIN_HOST_SEALED',
  'PLUGIN_HOST_NOT_SEALED',
  'PLUGIN_HOST_LOCK_ENTRY_MISSING',
  'PLUGIN_HOST_LOCK_IDENTITY_MISMATCH',
  'PLUGIN_HOST_LOCK_SOURCE_MISMATCH',
  'PLUGIN_HOST_LOCK_HASH_MISMATCH',
  'PLUGIN_HOST_LOCK_GATE_MISMATCH',
  'PLUGIN_HOST_VERSION_INCOMPATIBLE',
  'PLUGIN_HOST_ACTIVATION_EVIDENCE_MISSING',
  'PLUGIN_HOST_ACTIVATION_EVIDENCE_INVALID',
  'PLUGIN_HOST_ACTIVATION_EVIDENCE_MISMATCH',
  'PLUGIN_HOST_ACTIVATION_ASK',
  'PLUGIN_HOST_ACTIVATION_DENIED',
  'PLUGIN_HOST_POLICY_DECISION_INVALID',
  'PLUGIN_HOST_ACTIVATION_HOOK_FAILED',
  'PLUGIN_HOST_ACTION_INPUT_INVALID',
  'PLUGIN_HOST_ACTION_ASK',
  'PLUGIN_HOST_ACTION_DENIED',
  'PLUGIN_HOST_PLAN_STEP_INVALID',
  'PLUGIN_HOST_BUNDLED_DEFINITION_INVALID',
  'PLUGIN_HOST_BUNDLED_REGISTRATION_REQUIRED',
  'PLUGIN_HOST_PRMS_RESULT_INVALID',
  'PLUGIN_HOST_PRMS_BLOCKER_INVALID',
  'PLUGIN_HOST_PRMS_EVALUATOR_FAILED',
  'PLUGIN_LIFECYCLE_INVALID_TRANSITION',
  'PLUGIN_CAPABILITY_NOT_REQUESTED',
  'PLUGIN_CAPABILITY_UNKNOWN',
  'PLUGIN_CAPABILITY_DUPLICATE',
  'PLUGIN_CAPABILITY_HOST_DENIED',
  'PLUGIN_CAPABILITY_ACTOR_DENIED',
  'PLUGIN_CAPABILITY_HARD_DENIED',
  'PLUGIN_CONTRIBUTION_CAPABILITY_MISSING',
  'PLUGIN_ALIAS_TARGET_NOT_FOUND',
  'PLUGIN_ALIAS_TARGET_FORBIDDEN',
  'PLUGIN_ALIAS_TARGET_UNSAFE',
  'PLUGIN_ALIAS_MAPPING_FORBIDDEN',
  'PLUGIN_ALIAS_MAPPING_UNKNOWN_TARGET',
  'PLUGIN_ALIAS_MAPPING_UNKNOWN_INPUT',
  'PLUGIN_ALIAS_MAPPING_TYPE_MISMATCH',
  'PLUGIN_ALIAS_MAPPING_REQUIRED_TARGET_MISSING',
  'PLUGIN_REGISTRY_PLUGIN_COLLISION',
  'PLUGIN_REGISTRY_ACTION_COLLISION',
  'PLUGIN_REGISTRY_WORKFLOW_COLLISION',
  'PLUGIN_REGISTRY_PRMS_BLOCKER_COLLISION',
  'PLUGIN_REGISTRY_INVALID_ID',
  'PLUGIN_REGISTRY_PREFLIGHT_STALE',
  'PLUGIN_REGISTRY_PREFLIGHT_FOREIGN',
  'PLUGIN_REGISTRY_PREFLIGHT_REUSED',
  'PLUGIN_AUDIT_FACT_INVALID',
  'PLUGIN_AUDIT_WRITE_FAILED',
] as const);

export type PluginHostFindingCode = (typeof PLUGIN_HOST_FINDING_CODES)[number];

export interface PluginHostFinding {
  readonly code: PluginHostFindingCode;
  readonly phase: PluginHostPhase;
  readonly summary: string;
  readonly pluginId?: string;
  readonly contributionId?: string;
  readonly detail?: string;
}

/**
 * Locale-independent code-unit ordering used anywhere host decisions need a
 * canonical order. `localeCompare` is intentionally excluded because its
 * result can depend on the process locale and ICU version.
 */
export function asciiCompare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function sortFindings(findings: readonly PluginHostFinding[]): readonly PluginHostFinding[] {
  return Object.freeze(
    [...findings].sort(
      (left, right) =>
        asciiCompare(left.phase, right.phase) ||
        asciiCompare(left.pluginId ?? '', right.pluginId ?? '') ||
        asciiCompare(left.contributionId ?? '', right.contributionId ?? '') ||
        asciiCompare(left.code, right.code) ||
        asciiCompare(left.summary, right.summary) ||
        asciiCompare(left.detail ?? '', right.detail ?? ''),
    ),
  );
}

export class PluginHostError extends Error {
  readonly findings: readonly PluginHostFinding[];

  constructor(findings: readonly PluginHostFinding[]) {
    const normalized = sortFindings(findings);
    const first = normalized[0];
    super(first ? `${first.code}: ${first.summary}` : 'PLUGIN_HOST_ERROR: Host operation failed.');
    this.name = 'PluginHostError';
    this.findings = normalized;
  }
}

export function failPluginHost(finding: PluginHostFinding): never {
  throw new PluginHostError([finding]);
}
