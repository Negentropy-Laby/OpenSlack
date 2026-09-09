import { SAFE_IDENTIFIER_PATTERN, SAFE_IDENTIFIER_REGEX } from './workflow-binding-field-rules.js';
export const WORKFLOW_RUN_ID_PATTERN = SAFE_IDENTIFIER_PATTERN;
export const WORKFLOW_RUN_ID_REGEX = SAFE_IDENTIFIER_REGEX;

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
export const PORTABLE_RUN_ID_PLATFORMS = Object.freeze(['linux', 'darwin', 'win32'] as const);

/** Prevent new runs from stranding their evidence on another supported platform. */
export function isPortableWorkflowRunId(value: unknown): value is string {
  return PORTABLE_RUN_ID_PLATFORMS.every((platform) => isWorkflowRunPathId(value, platform));
}
