/** Same accepted timestamp spelling for administrator evidence, not runtime identity. */
export function cleanupEvidenceTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value))
    return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
export function cleanupEvidenceWindow(start: number, end: number, now: number): boolean {
  return start < end && start <= now && now < end;
}
