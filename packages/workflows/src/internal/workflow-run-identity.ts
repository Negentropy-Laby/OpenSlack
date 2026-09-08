/** Wire identity is platform-independent; filesystem identity respects platform path semantics. */
export function isWorkflowRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(value);
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
