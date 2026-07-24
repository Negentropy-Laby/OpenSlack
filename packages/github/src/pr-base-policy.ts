export const CANONICAL_PR_BASE_REF = 'main' as const;

export class PRBasePolicyError extends Error {
  readonly code = 'PR_BASE_FORBIDDEN';

  constructor(readonly actualBaseRef: string) {
    super(
      `PR_BASE_FORBIDDEN: pull requests must target "${CANONICAL_PR_BASE_REF}"; received "${actualBaseRef}".`,
    );
    this.name = 'PRBasePolicyError';
  }
}

export function assertCanonicalPRBase(baseRef: string): void {
  if (baseRef !== CANONICAL_PR_BASE_REF) {
    throw new PRBasePolicyError(baseRef);
  }
}
