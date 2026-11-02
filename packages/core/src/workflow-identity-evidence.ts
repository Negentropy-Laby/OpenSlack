/** Diagnostic vocabulary only; these values do not authorize execution or recovery. */
export type WorkflowIdentityDomain =
  | 'raw-sha256'
  | 'openslack.workflow-runner.workflow-source.v2'
  | 'function-source-sha256'
  | 'unknown';

export type WorkflowIdentityProvenance = 'recorded' | 'inferred' | 'unknown';

/** Shared diagnostic evidence, not a loader handle or an execution capability. */
export interface WorkflowIdentityEvidence {
  readonly digest: string;
  readonly domain: WorkflowIdentityDomain;
  readonly provenance: WorkflowIdentityProvenance;
}
