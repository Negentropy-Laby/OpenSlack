/** Stable historical receipt identity; independent of the current lease or cache. */
export function resumeCorrelationId(stageHash: string): string {
  return `resume.${stageHash}`;
}
