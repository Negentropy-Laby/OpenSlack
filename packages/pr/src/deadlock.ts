export interface DeadlockResult {
  deadlocked: boolean;
  reason: string;
  recommendation: string;
  type: 'AUTHOR_IS_SOLE_CODEOWNER' | 'SINGLE_MAINTAINER' | null;
}

export function detectDeadlock(
  author: string,
  codeowners: string[],
  validApprovers: string[],
): DeadlockResult {
  const authorAsOwner = `@${author}`;
  const authorIsCodeowner = codeowners.includes(authorAsOwner);
  const otherCodeowners = codeowners.filter((o) => o !== authorAsOwner);

  // Author is sole CODEOWNER for changed paths
  if (authorIsCodeowner && otherCodeowners.length === 0 && codeowners.length > 0) {
    return {
      deadlocked: true,
      type: 'AUTHOR_IS_SOLE_CODEOWNER',
      reason: `PR author @${author} is the only CODEOWNER for changed paths. GitHub does not allow authors to satisfy their own approval requirement.`,
      recommendation: 'Recreate as bot/agent-authored PR, or add a second human CODEOWNER.',
    };
  }

  // Single maintainer (only one CODEOWNER total in repo, and it is the author)
  if (codeowners.length === 1 && authorIsCodeowner) {
    return {
      deadlocked: true,
      type: 'SINGLE_MAINTAINER',
      reason: `Single maintainer deadlock: @${author} is the only CODEOWNER in this repository.`,
      recommendation: 'Add a second human CODEOWNER to `.github/CODEOWNERS` or configure bot-authored PRs for Red Zone.',
    };
  }

  return { deadlocked: false, type: null, reason: '', recommendation: '' };
}
