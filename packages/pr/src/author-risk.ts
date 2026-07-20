import { classifyPaths } from '@openslack/kernel';

export type PRAuthorRiskStatus =
  | 'safe'
  | 'red_zone_sole_codeowner_deadlock'
  | 'needs_human_codeowner';

export interface PRAuthorRiskInput {
  author?: string | null;
  changedPaths: string[];
  codeowners: string[];
  authorIsBot?: boolean;
}

export interface PRAuthorRiskPreflight {
  status: PRAuthorRiskStatus;
  riskZone: string;
  author?: string;
  codeowners: string[];
  reason: string;
  recommendation: string;
}

function normalizeLogin(login: string): string {
  return login.startsWith('@') ? login.slice(1).toLowerCase() : login.toLowerCase();
}

function uniqueOwners(codeowners: string[]): string[] {
  return [...new Set(codeowners)].sort();
}

export function assessPRAuthorRisk(input: PRAuthorRiskInput): PRAuthorRiskPreflight {
  const riskZone = classifyPaths(input.changedPaths);
  const codeowners = uniqueOwners(input.codeowners);
  const author = input.author ? normalizeLogin(input.author) : undefined;

  if (riskZone !== 'red') {
    return {
      status: 'safe',
      riskZone,
      author,
      codeowners,
      reason: `${riskZone.toUpperCase()} Zone changes do not trigger CODEOWNER author deadlock preflight.`,
      recommendation: 'Proceed through normal PRMS gates.',
    };
  }

  if (codeowners.length === 0) {
    return {
      status: 'needs_human_codeowner',
      riskZone,
      author,
      codeowners,
      reason:
        'Red Zone paths require human CODEOWNER approval, but no CODEOWNER matched the changed paths.',
      recommendation:
        'Add a human CODEOWNER for the touched Red Zone paths before creating the PR.',
    };
  }

  if (input.authorIsBot) {
    return {
      status: 'safe',
      riskZone,
      author,
      codeowners,
      reason:
        'Red Zone PR is bot/agent-authored; a separate human CODEOWNER can approve on GitHub.',
      recommendation: `Request GitHub approval from human CODEOWNER(s): ${codeowners.join(', ')}.`,
    };
  }

  if (!author) {
    return {
      status: 'safe',
      riskZone,
      codeowners,
      reason: 'Author identity is unknown; PRMS will re-check deadlock after the PR exists.',
      recommendation: 'Create the PR with bot/agent credentials when touching Red Zone paths.',
    };
  }

  const authorAsOwner = `@${author}`;
  const otherOwners = codeowners.filter((owner) => normalizeLogin(owner) !== author);
  if (
    codeowners.some((owner) => owner.toLowerCase() === authorAsOwner) &&
    otherOwners.length === 0
  ) {
    return {
      status: 'red_zone_sole_codeowner_deadlock',
      riskZone,
      author,
      codeowners,
      reason: `PR author @${author} is the only CODEOWNER for touched Red Zone paths.`,
      recommendation:
        'Recreate as a bot/agent-authored PR, then request human CODEOWNER approval from @' +
        author +
        '.',
    };
  }

  return {
    status: 'safe',
    riskZone,
    author,
    codeowners,
    reason: 'Red Zone PR has a non-author human CODEOWNER path available.',
    recommendation: `Request GitHub approval from human CODEOWNER(s): ${otherOwners.join(', ')}.`,
  };
}
