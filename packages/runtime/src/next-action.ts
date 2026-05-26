export interface NextActionRecommendation {
  priority: number;
  title: string;
  action: string;
  command?: string;
}

export interface NextActionContext {
  setupFindings?: { status: string; title: string; nextAction?: string; command?: string }[];
  gitHubOps?: {
    ready: number;
    claimed: number;
    blocked: number;
    openPRs: number;
    blockedPRs: number;
    readyPRs: number;
    available: boolean;
  };
  blockers?: { object: string; summary: string; owner?: string; nextAction?: string }[];
  doctorFailed?: boolean;
}

const RUNNABLE_PREFIXES = ['openslack ', 'pnpm openslack ', 'pnpm ', 'gh ', 'git ', 'bash ', 'wsl '];

function isRunnableCommand(text: string | undefined): text is string {
  if (!text) return false;
  return RUNNABLE_PREFIXES.some((p) => text.startsWith(p));
}

export function recommendNextActions(ctx: NextActionContext): NextActionRecommendation[] {
  const recs: NextActionRecommendation[] = [];

  if (ctx.doctorFailed) {
    recs.push({
      priority: 0,
      title: 'Health check failed',
      action: 'Run doctor to see what needs fixing.',
      command: 'openslack doctor',
    });
  }

  if (ctx.setupFindings) {
    // Only promote findings with an explicit nextAction — these indicate a real
    // detected problem, not an evergreen repair capability (e.g. github-labels).
    const fixable = ctx.setupFindings.filter(
      (f) => f.status === 'fixable_by_command' && f.nextAction,
    );
    for (const f of fixable.slice(0, 2)) {
      recs.push({
        priority: 1,
        title: f.title,
        action: f.nextAction!,
        command: isRunnableCommand(f.command) ? f.command : undefined,
      });
    }
  }

  if (ctx.blockers && ctx.blockers.length > 0) {
    const humanOwned = ctx.blockers.filter(
      (b) => b.owner && b.owner.startsWith('human'),
    );
    if (humanOwned.length > 0) {
      const first = humanOwned[0];
      recs.push({
        priority: 2,
        title: `${humanOwned.length} blocker${humanOwned.length > 1 ? 's need' : ' needs'} human action`,
        action: first.nextAction || first.summary,
        // nextAction is natural language ("Review on GitHub"), never a command
      });
    }
  }

  if (ctx.gitHubOps?.available) {
    if (ctx.gitHubOps.blockedPRs > 0) {
      recs.push({
        priority: 3,
        title: `${ctx.gitHubOps.blockedPRs} PR${ctx.gitHubOps.blockedPRs > 1 ? 's' : ''} blocked`,
        action: 'Check what is blocking the PR.',
        command: 'openslack pr doctor <number>',
      });
    }

    if (ctx.gitHubOps.ready > 0 && ctx.gitHubOps.claimed === 0) {
      recs.push({
        priority: 4,
        title: `${ctx.gitHubOps.ready} task${ctx.gitHubOps.ready > 1 ? 's' : ''} ready to claim`,
        action: 'An agent can pick up a ready task.',
        command: 'openslack agent tick --agent-id <id> --source github-issues',
      });
    }

    if (ctx.gitHubOps.readyPRs > 0) {
      recs.push({
        priority: 5,
        title: `${ctx.gitHubOps.readyPRs} PR${ctx.gitHubOps.readyPRs > 1 ? 's' : ''} ready to merge`,
        action: 'Review and merge the ready PR.',
        command: 'openslack pr merge <number>',
      });
    }
  }

  if (recs.length === 0) {
    recs.push({
      priority: 6,
      title: 'All clear',
      action: 'No immediate actions needed. Try creating a task or asking a question.',
      command: 'openslack ask "what should I do next?"',
    });
  }

  return recs.slice(0, 5);
}
