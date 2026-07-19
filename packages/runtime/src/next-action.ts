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

export interface AttentionItem {
  type: string;
  description: string;
  action: string;
  priority: 'high' | 'medium' | 'low';
}

const RUNNABLE_PREFIXES = [
  'openslack ',
  'bun run openslack ',
  'bun run ',
  'gh ',
  'git ',
  'bash ',
  'wsl ',
];

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
    const humanOwned = ctx.blockers.filter((b) => b.owner && b.owner.startsWith('human'));
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

/**
 * Map a numeric priority (from recommendNextActions) to a categorical label.
 */
function toPriorityLabel(numeric: number): AttentionItem['priority'] {
  if (numeric <= 1) return 'high';
  if (numeric <= 3) return 'medium';
  return 'low';
}

/**
 * Aggregate attention items across all modules: setup findings, blockers,
 * GitHub ops, and recommendations from the existing context.
 *
 * Each item carries a categorical priority (high / medium / low) derived
 * from the underlying numeric priority so consumers never need to reason
 * about the numeric scale.
 */
export async function getAttentionItems(ctx: NextActionContext): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];

  // Doctor failure is always high priority.
  if (ctx.doctorFailed) {
    items.push({
      type: 'health',
      description: 'Health check failed',
      action: 'Run doctor to see what needs fixing.',
      priority: 'high',
    });
  }

  // Setup findings that are fixable.
  if (ctx.setupFindings) {
    const fixable = ctx.setupFindings.filter(
      (f) => f.status === 'fixable_by_command' && f.nextAction,
    );
    for (const f of fixable) {
      items.push({
        type: 'setup',
        description: f.title,
        action: f.nextAction!,
        priority: 'high',
      });
    }
  }

  // Human-owned blockers.
  if (ctx.blockers && ctx.blockers.length > 0) {
    const humanOwned = ctx.blockers.filter((b) => b.owner && b.owner.startsWith('human'));
    for (const b of humanOwned) {
      items.push({
        type: 'blocker',
        description: `${b.object}: ${b.summary}`,
        action: b.nextAction || b.summary,
        priority: 'medium',
      });
    }
  }

  // Blocked PRs.
  if (ctx.gitHubOps?.available && ctx.gitHubOps.blockedPRs > 0) {
    items.push({
      type: 'pr',
      description: `${ctx.gitHubOps.blockedPRs} PR${ctx.gitHubOps.blockedPRs > 1 ? 's' : ''} blocked`,
      action: 'Check what is blocking the PR.',
      priority: 'medium',
    });
  }

  // Ready tasks with no agent claimed.
  if (ctx.gitHubOps?.available && ctx.gitHubOps.ready > 0 && ctx.gitHubOps.claimed === 0) {
    items.push({
      type: 'task',
      description: `${ctx.gitHubOps.ready} task${ctx.gitHubOps.ready > 1 ? 's' : ''} ready to claim`,
      action: 'An agent can pick up a ready task.',
      priority: 'low',
    });
  }

  // PRs ready to merge.
  if (ctx.gitHubOps?.available && ctx.gitHubOps.readyPRs > 0) {
    items.push({
      type: 'pr',
      description: `${ctx.gitHubOps.readyPRs} PR${ctx.gitHubOps.readyPRs > 1 ? 's' : ''} ready to merge`,
      action: 'Review and merge the ready PR.',
      priority: 'low',
    });
  }

  return items;
}

/** Priority ranking for sorting. */
const PRIORITY_ORDER: Record<AttentionItem['priority'], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Pick the single highest-priority recommended next action from a list of
 * attention items.  Returns an "All clear" message when the list is empty.
 */
export function getNextAction(items: AttentionItem[]): string {
  if (items.length === 0) {
    return 'All clear — no immediate actions needed.';
  }

  const sorted = [...items].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  const top = sorted[0];
  return `${top.description}: ${top.action}`;
}
