/** Shared names only: recognizing a domain never authenticates its evidence. */
export const WORKFLOW_IDENTITY = Object.freeze({
  RAW_SHA256: 'raw-sha256',
  SOURCE_V2: 'openslack.workflow-runner.workflow-source.v2',
  FUNCTION_SOURCE: 'function-source-sha256',
  UNKNOWN: 'unknown',
} as const);

/** Diagnostic vocabulary only; these values do not authorize execution or recovery. */
export const WORKFLOW_IDENTITY_DOMAINS = Object.freeze(Object.values(WORKFLOW_IDENTITY));
export type WorkflowIdentityDomain = (typeof WORKFLOW_IDENTITY_DOMAINS)[number];

export const WORKFLOW_IDENTITY_PROVENANCES = Object.freeze([
  'recorded',
  'inferred',
  'unknown',
] as const);
export type WorkflowIdentityProvenance = (typeof WORKFLOW_IDENTITY_PROVENANCES)[number];

/** Full lowercase digest syntax, independent of domain and execution authority. */
export function isWorkflowIdentityDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

/** Recognize the closed diagnostic vocabulary without coercing caller data. */
export function isWorkflowIdentityDomain(value: unknown): value is WorkflowIdentityDomain {
  return WORKFLOW_IDENTITY_DOMAINS.some((domain) => domain === value);
}

/** Only raw file bytes and runner-v2 source identities can label new executable runs. */
export function isExecutableWorkflowIdentityDomain(
  value: unknown,
): value is typeof WORKFLOW_IDENTITY.RAW_SHA256 | typeof WORKFLOW_IDENTITY.SOURCE_V2 {
  return value === WORKFLOW_IDENTITY.RAW_SHA256 || value === WORKFLOW_IDENTITY.SOURCE_V2;
}

/** Recognize a provenance label; it does not prove the claimed origin. */
export function isWorkflowIdentityProvenance(value: unknown): value is WorkflowIdentityProvenance {
  return WORKFLOW_IDENTITY_PROVENANCES.some((provenance) => provenance === value);
}

/** Shared diagnostic evidence, not a loader handle or an execution capability. */
export interface WorkflowIdentityEvidence {
  readonly digest: string;
  readonly domain: WorkflowIdentityDomain;
  readonly provenance: WorkflowIdentityProvenance;
}
