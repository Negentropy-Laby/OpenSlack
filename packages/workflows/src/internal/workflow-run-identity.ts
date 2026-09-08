export const WORKFLOW_RUN_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$';
export const WORKFLOW_RUN_ID_REGEX = new RegExp(WORKFLOW_RUN_ID_PATTERN, 'u');

/** Wire identity is platform-independent; historical path reads follow the host. */
export function isWorkflowRunId(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_RUN_ID_REGEX.test(value);
}
export function isWorkflowRunPathId(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): value is string {
  if (!isWorkflowRunId(value)) return false;
  if (platform !== 'win32') return true;
  return (
    !value.includes(':') &&
    !value.endsWith('.') &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  );
}
/** Prevent new runs from stranding their evidence on another supported platform. */
export function isPortableWorkflowRunId(value: unknown): value is string {
  return isWorkflowRunPathId(value, 'win32');
}
