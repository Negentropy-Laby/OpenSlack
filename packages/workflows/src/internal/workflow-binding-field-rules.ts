export const WORKFLOW_BINDING_HASH_PATTERN = '^[0-9a-f]{64}$';
export const WORKFLOW_BINDING_REFERENCE_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$';
export const WORKFLOW_BINDING_TIME_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
export const WORKFLOW_BINDING_ERROR_MESSAGE_MAX_BYTES = 512;

/** Neutral wire alphabet; run creation and host paths impose separate policies. */
export const SAFE_IDENTIFIER_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$';
export const SAFE_IDENTIFIER_REGEX = new RegExp(SAFE_IDENTIFIER_PATTERN, 'u');
export const WORKFLOW_BINDING_HASH_REGEX = new RegExp(WORKFLOW_BINDING_HASH_PATTERN, 'u');
export const WORKFLOW_BINDING_REFERENCE_REGEX = new RegExp(WORKFLOW_BINDING_REFERENCE_PATTERN, 'u');
export const WORKFLOW_BINDING_TIME_REGEX = new RegExp(WORKFLOW_BINDING_TIME_PATTERN, 'u');

/** Preserve the wider canonical ISO predicate for callers without a four-digit wire bound. */
export function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
export function isCanonicalUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    WORKFLOW_BINDING_TIME_REGEX.test(value) &&
    isCanonicalIsoTimestamp(value)
  );
}
