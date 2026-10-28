/** One path-safe run identifier grammar, including historical persisted identifiers. */
export const RUN_ID_RE = /^RUN-[A-Z0-9-]+$/;

export function validateRunId(id: string): void {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) {
    throw new Error(`Invalid run ID: "${id}". Must match /^RUN-[A-Z0-9-]+$/ (historical lengths are preserved).`);
  }
}
