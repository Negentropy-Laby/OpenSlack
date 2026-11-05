import {
  isCanonicalUtcTimestamp,
  WORKFLOW_BINDING_HASH_REGEX,
} from '../../packages/workflows/src/internal/workflow-binding-field-rules.js';
import { closedDataRecord } from '../../packages/workflows/src/internal/contract-validation.js';
export { hashWorkflowSource as digest } from '../../packages/workflows/src/internal/workflow-identity.js';

export type QualificationStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';
export const CANDIDATE_SHA = /^[0-9a-f]{40}$/u;
export const SHA256 = WORKFLOW_BINDING_HASH_REGEX;
/** Campaign correlation IDs are deliberately narrower than neutral wire IDs. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;

export function timestamp(value: unknown): string {
  if (!isCanonicalUtcTimestamp(value)) {
    throw new Error('Expected an exact canonical UTC timestamp.');
  }
  return value;
}

export function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  const invalid = (): never => {
    throw new Error('Unexpected or missing qualification evidence fields.');
  };
  closedDataRecord(
    value,
    required,
    'Qualification evidence',
    { inert: invalid, missing: invalid, unknown: invalid, dataField: invalid },
    { optionalFields: optional },
  );
}

/** Preparation status is deliberately not an execution or qualification grant. */
export function preparationStatus() {
  return Object.freeze({
    fullSealedResume: 'BLOCKED' as const,
    blocker: '#433' as const,
    realProvider: 'NOT_RUN' as const,
    humanApproval: 'NOT_RUN' as const,
    databaseRestart: 'NOT_RUN' as const,
    drainObservation: 'NOT_RUN' as const,
    hostedCI: 'NOT_RUN' as const,
    qualification: 'NOT_RUN' as const,
    liveExecutionEnabled: false as const,
  });
}
