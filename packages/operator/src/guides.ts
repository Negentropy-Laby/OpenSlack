/**
 * Role-based quick guides for OpenSlack.
 *
 * Each role gets a focused quick-start guide with relevant commands,
 * workflows, and tips organized into themed sections.
 */

export interface RoleGuideSection {
  heading: string;
  items: string[];
}

export interface RoleGuide {
  title: string;
  description: string;
  sections: RoleGuideSection[];
}

const ROLE_GUIDES: Record<string, RoleGuide> = {
  operator: {
    title: 'Operator Quick Guide',
    description: 'Running setup, checking status, and managing agents day-to-day.',
    sections: [
      {
        heading: 'Initial Setup',
        items: [
          'Run `openslack setup init` to bootstrap a new workspace.',
          'Use `openslack doctor` to verify all services and modules are healthy.',
          'Run `openslack status` to see the current system state.',
        ],
      },
      {
        heading: 'Day-to-Day Operations',
        items: [
          'Use `openslack ask "<query>"` to run natural-language commands.',
          'Run `openslack status verify` to confirm the system matches generated state.',
          'Check pending plans with `openslack ask plan list`.',
          'Review the dashboard with `openslack collaboration dashboard`.',
        ],
      },
      {
        heading: 'Agent Management',
        items: [
          'List agents: `openslack agent list`.',
          'Check agent health: `openslack agent doctor <agent-id>`.',
          'View agent task assignments with `openslack task list --agent <id>`.',
          'Use `openslack ask plan resume <planId> --set key=value` to clarify pending plans.',
        ],
      },
    ],
  },

  reviewer: {
    title: 'Reviewer Quick Guide',
    description: 'PR review workflow, using pr doctor, and governance best practices.',
    sections: [
      {
        heading: 'PR Review Workflow',
        items: [
          'Run `openslack pr doctor <PR_NUMBER>` for an automated PR health check.',
          'Use `openslack pr status <PR_NUMBER>` to see merge-readiness at a glance.',
          'Check the PR queue: `openslack pr queue`.',
          'View PR review status with `openslack pr reviews <PR_NUMBER>`.',
        ],
      },
      {
        heading: 'Governance',
        items: [
          'Run `openslack governance audit` to check compliance and rules.',
          'Record decisions: `openslack collaboration decision record --topic "..." --decision "..." --rationale "..." --by <you>`.',
          'Review active decisions: `openslack collaboration decision list`.',
          'Supersede outdated decisions: `openslack collaboration decision supersede <id> --by <new-id>`.',
        ],
      },
      {
        heading: 'Collaboration',
        items: [
          'View activity feed: `openslack collaboration activity`.',
          'Check room context: `openslack collaboration room show pr:<number>`.',
          'Use handoffs to coordinate: `openslack collaboration handoff create --from <you> --to <agent> --context "..."`.',
        ],
      },
    ],
  },

  'agent-maintainer': {
    title: 'Agent Maintainer Quick Guide',
    description: 'Module boundaries, testing patterns, and PR contribution rules.',
    sections: [
      {
        heading: 'Module Boundaries',
        items: [
          'Each package lives under `packages/<name>/` with its own `src/index.ts` barrel export.',
          'Use `workspace:*` for monorepo-internal dependencies.',
          'Follow the tsconfig pattern from `packages/collaboration/tsconfig.json`.',
          'Keep module APIs narrow: export only what consumers need.',
        ],
      },
      {
        heading: 'Testing',
        items: [
          'Tests use vitest with the root-level vitest config.',
          'Place tests in `packages/<name>/src/__tests__/<module>.test.ts`.',
          'Run all tests: `pnpm test`. Run type checks: `pnpm typecheck`.',
          'Import source files with `.js` extension: `import { foo } from "../bar.js";`.',
        ],
      },
      {
        heading: 'PR Contribution Rules',
        items: [
          'Never push directly to `main`. Use feature branches and PRs.',
          'Run `pnpm typecheck && pnpm test` before pushing.',
          'Use `openslack pr doctor <PR_NUMBER>` to validate your PR.',
          'Follow the commit message conventions in the repository.',
          'Keep PRs focused: one concern per PR.',
        ],
      },
    ],
  },

  lead: {
    title: 'Lead Quick Guide',
    description: 'Dashboard overview, digest review, decision tracking, and handoff management.',
    sections: [
      {
        heading: 'Dashboard Overview',
        items: [
          'Run `openslack collaboration dashboard` for the projection-only team dashboard.',
          'Filter by time window: `openslack collaboration dashboard --since 48`.',
          'Filter by module: `--module operator` or `--module governance`.',
          'Show only blockers: `--blocker`.',
          'Use `--format plain` for script-friendly output or `--format json` for piping.',
        ],
      },
      {
        heading: 'Digest Review',
        items: [
          'Get a grouped summary: `openslack collaboration digest`.',
          'Use `--since 168` for a weekly digest.',
          'The digest groups events into categories: Needs Human, Blocked, Completed, Agent Activity, Governance.',
          'Recommended next actions are listed at the bottom of the digest.',
        ],
      },
      {
        heading: 'Decision Tracking',
        items: [
          'Record decisions: `openslack collaboration decision record --topic "..." --decision "..." --rationale "..." --by <you>`.',
          'List all decisions: `openslack collaboration decision list`.',
          'Show a specific decision: `openslack collaboration decision show <id>`.',
          'Supersede decisions when they change: `openslack collaboration decision supersede <id> --by <new-id>`.',
        ],
      },
      {
        heading: 'Handoffs',
        items: [
          'Create handoffs for context transfer: `openslack collaboration handoff create --from <source> --to <target> --context "..."`.',
          'List open handoffs: `openslack collaboration handoff list`.',
          'Accept a handoff: `openslack collaboration handoff accept <id>`.',
          'Close completed handoffs: `openslack collaboration handoff close <id>`.',
        ],
      },
    ],
  },
};

/**
 * Retrieve the quick-start guide for a given role.
 * Returns undefined if the role is not recognized.
 */
export function getRoleGuide(role: string): RoleGuide | undefined {
  return ROLE_GUIDES[role];
}

/**
 * List all available role names.
 */
export function listRoles(): string[] {
  return Object.keys(ROLE_GUIDES);
}

/**
 * Render a role guide as a formatted plain-text string.
 */
export function renderGuide(guide: RoleGuide): string {
  const lines: string[] = [];

  lines.push(guide.title);
  lines.push('='.repeat(guide.title.length));
  lines.push('');
  lines.push(guide.description);
  lines.push('');

  for (const section of guide.sections) {
    lines.push(section.heading);
    lines.push('-'.repeat(section.heading.length));
    for (const item of section.items) {
      lines.push(`  - ${item}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
