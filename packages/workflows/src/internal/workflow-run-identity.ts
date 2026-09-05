/** Wire identity is platform-independent; filesystem identity also excludes Windows ADS. */
export function isWorkflowRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(value);
}

export function isWorkflowRunPathId(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
): value is string {
  return isWorkflowRunId(value) && (platform !== 'win32' || !value.includes(':'));
}
