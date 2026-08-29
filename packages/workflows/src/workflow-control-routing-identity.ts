export const WORKFLOW_CONTROL_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export function isWorkflowControlBearerToken(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const bytes = Buffer.byteLength(value, 'utf8');
  return bytes >= 32 && bytes <= 4096 && /^[\x21-\x7e]+$/u.test(value);
}

export function parseWorkflowControlRoutingEpoch(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^[1-9][0-9]*$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TypeError('Workflow Control routing epoch is invalid.');
  }
  return parsed;
}
