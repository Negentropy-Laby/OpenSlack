export const SCENARIO_RISK_LEVELS = Object.freeze(['none', 'low', 'medium', 'high'] as const);
export type ScenarioRisk = (typeof SCENARIO_RISK_LEVELS)[number];

export const NON_OVERRIDABLE_FORBIDDEN_CAPABILITY_IDS = Object.freeze([
  'github.pr.approve',
  'github.pr.merge',
  'ruleset.bypass',
  'secrets.read',
  'kernel.constitution.write',
  'agent.registry.write',
  'workflow.trust.upgrade',
] as const);
const NON_OVERRIDABLE_FORBIDDEN_CAPABILITIES = new Set<string>(
  NON_OVERRIDABLE_FORBIDDEN_CAPABILITY_IDS,
);

export const CAPABILITY_ID_PATTERN =
  /^[a-z][A-Za-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][A-Za-z0-9]*(?:-[a-z0-9]+)*)+$/;

export interface CapabilityCatalogEntry {
  readonly id: string;
  readonly adapterId: string;
  readonly risk: ScenarioRisk;
  readonly readOnly: boolean;
  readonly approvalRequired: boolean;
}

export interface EffectiveCapabilityResolution {
  readonly requested: readonly string[];
  readonly actorGranted: readonly string[];
  readonly effective: readonly string[];
  readonly denied: readonly string[];
}

export function isNonOverridableForbiddenCapability(value: string): boolean {
  return NON_OVERRIDABLE_FORBIDDEN_CAPABILITIES.has(value);
}

export class ScenarioCapabilityError extends Error {
  readonly code:
    | 'SCENARIO_CAPABILITY_INVALID'
    | 'SCENARIO_CAPABILITY_UNKNOWN'
    | 'SCENARIO_CAPABILITY_FORBIDDEN'
    | 'SCENARIO_CAPABILITY_DENIED';

  constructor(code: ScenarioCapabilityError['code'], message: string) {
    super(message);
    this.name = 'ScenarioCapabilityError';
    this.code = code;
  }
}

export function assertCanonicalCapabilityId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 128 ||
    value.includes('*') ||
    !CAPABILITY_ID_PATTERN.test(value)
  ) {
    throw new ScenarioCapabilityError(
      'SCENARIO_CAPABILITY_INVALID',
      'Capability IDs must be bounded canonical dotted identifiers and cannot contain wildcards.',
    );
  }
  if (NON_OVERRIDABLE_FORBIDDEN_CAPABILITIES.has(value)) {
    throw new ScenarioCapabilityError(
      'SCENARIO_CAPABILITY_FORBIDDEN',
      `Capability ${value} is non-overridable and forbidden.`,
    );
  }
}

export function resolveEffectiveCapabilities(input: {
  readonly requested: readonly string[];
  readonly actorGranted: readonly string[];
  readonly knownCapabilityIds: ReadonlySet<string>;
}): EffectiveCapabilityResolution {
  const requested = [...new Set(input.requested)].sort();
  const actorGranted = [...new Set(input.actorGranted)].sort();

  for (const capability of [...requested, ...actorGranted]) {
    assertCanonicalCapabilityId(capability);
    if (!input.knownCapabilityIds.has(capability)) {
      throw new ScenarioCapabilityError(
        'SCENARIO_CAPABILITY_UNKNOWN',
        `Capability ${capability} is not present in the sealed host catalog.`,
      );
    }
  }

  const actorSet = new Set(actorGranted);
  const effective = requested.filter((capability) => actorSet.has(capability));
  const denied = requested.filter((capability) => !actorSet.has(capability));
  return Object.freeze({
    requested: Object.freeze(requested),
    actorGranted: Object.freeze(actorGranted),
    effective: Object.freeze(effective),
    denied: Object.freeze(denied),
  });
}

export function assertCapabilitiesGranted(resolution: EffectiveCapabilityResolution): void {
  if (resolution.denied.length > 0) {
    throw new ScenarioCapabilityError(
      'SCENARIO_CAPABILITY_DENIED',
      `Actor grant does not include requested capabilities: ${resolution.denied.join(', ')}.`,
    );
  }
}
