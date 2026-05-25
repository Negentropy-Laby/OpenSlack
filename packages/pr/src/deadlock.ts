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
      recommendation: `Recreate this Red Zone change as a bot/agent-authored PR, then request human CODEOWNER approval from @${author}. Do not use bot approval.`,
    };
  }

  // Single maintainer (only one CODEOWNER total in repo, and it is the author)
  if (codeowners.length === 1 && authorIsCodeowner) {
    return {
      deadlocked: true,
      type: 'SINGLE_MAINTAINER',
      reason: `Single maintainer deadlock: @${author} is the only CODEOWNER in this repository.`,
      recommendation: 'Use a bot/agent-authored Red Zone PR with human CODEOWNER approval, or add a second human CODEOWNER. Do not use bot approval.',
    };
  }

  return { deadlocked: false, type: null, reason: '', recommendation: '' };
}
