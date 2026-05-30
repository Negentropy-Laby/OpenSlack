import { sanitizeTerminalText } from '../sanitize.js'

export interface AttentionItem {
  /** Display label like "3 Pending Approvals" */
  label: string
  /** One-line preview detail */
  detail: string
  /** Route to push when selected */
  route: string
  /** Theme color hint: 'warning' for items needing action */
  colorTheme: 'warning' | 'info'
}

export interface NavItem {
  label: string
  key: string
  shortcut: string
}

export interface GoalItem {
  label: string
  route: string
  description: string
}

export interface WorkflowQuickActionItem {
  label: string
  route: string
  description: string
  shortcut: string
}

export interface HomeViewModel {
  /** Items that need attention, ordered by urgency */
  attentionItems: AttentionItem[]
  /** True when no attention items exist */
  allClear: boolean
  /** Quick navigation items with number shortcuts */
  navItems: NavItem[]
  /** Goal-oriented items for the "What do you want to do?" section */
  goalItems: GoalItem[]
  /** Workflow lifecycle quick actions */
  workflowQuickActions: WorkflowQuickActionItem[]
  systemStatus: string
}

export function mapHomeToViewModel(data?: {
  systemStatus?: string
  /** Optional shell data to extract attention items from */
  shellData?: {
    dashboard?: {
      summary: { blockers: number; handoffs: number; decisions: number }
      blockers: Array<{ object: string; summary: string }>
      handoffs: Array<{ id: string; from: string; to: string; status: string; context: string }>
    }
    prQueue?: {
      totalPRs: number
      blockedCount: number
      readyCount: number
      items: Array<{ prNumber: number; title: string; blockerCategory: string; canMerge: boolean }>
    }
    approvals?: {
      pendingApprovals: Array<{ id: string; category: string; title: string; risk: string }>
      summary: { plans: number; mergeRequests: number; workflowEffects: number; githubReviews: number }
    }
    workflowGallery?: {
      workflows: Array<{ name: string; lastRunStatus?: string }>
      summary: { total: number }
    }
    status?: {
      gitHub: {
        tasksBlocked: number
        prsOpen: number
        prsBlocked: number
      }
    }
    digest?: {
      recommendedNext: Array<{ objectKind: string; objectId: string; action: string }>
    }
    decisions?: {
      activeCount: number
      items: Array<{ id: string; topic: string }>
    }
  }
}): HomeViewModel {
  const s = sanitizeTerminalText
  const attentionItems: AttentionItem[] = []

  if (data?.shellData) {
    const sd = data.shellData

    // Pending approvals
    const approvalCount = sd.approvals
      ? sd.approvals.summary.plans +
        sd.approvals.summary.mergeRequests +
        sd.approvals.summary.workflowEffects +
        sd.approvals.summary.githubReviews
      : 0
    if (approvalCount > 0 && sd.approvals) {
      const first = sd.approvals.pendingApprovals[0]
      attentionItems.push({
        label: `${approvalCount} Pending Approval${approvalCount !== 1 ? 's' : ''}`,
        detail: first ? s(first.title) : '',
        route: 'approvals',
        colorTheme: 'warning',
      })
    }

    // Open PRs with blockers
    if (sd.prQueue && sd.prQueue.totalPRs > 0) {
      const blockedPrs = sd.prQueue.items.filter(
        i => i.blockerCategory !== 'none' && !i.canMerge,
      )
      const blockedPr = blockedPrs[0]
      const detailParts: string[] = []
      if (sd.prQueue.blockedCount > 0) {
        detailParts.push(`${sd.prQueue.blockedCount} blocked`)
      }
      if (sd.prQueue.readyCount > 0) {
        detailParts.push(`${sd.prQueue.readyCount} ready`)
      }
      attentionItems.push({
        label: `${sd.prQueue.totalPRs} Open PR${sd.prQueue.totalPRs !== 1 ? 's' : ''}`,
        detail: blockedPr
          ? `#${blockedPr.prNumber} ${s(blockedPr.title)}`
          : detailParts.join(', '),
        route: 'pr-queue',
        colorTheme: sd.prQueue.blockedCount > 0 ? 'warning' : 'info',
      })
    }

    // Blocked tasks
    if (sd.status && sd.status.gitHub.tasksBlocked > 0) {
      attentionItems.push({
        label: `${sd.status.gitHub.tasksBlocked} Blocked Task${sd.status.gitHub.tasksBlocked !== 1 ? 's' : ''}`,
        detail: 'Tasks unable to proceed',
        route: 'status',
        colorTheme: 'warning',
      })
    }

    // Workflow runs awaiting confirmation
    if (sd.workflowGallery) {
      const awaiting = sd.workflowGallery.workflows.filter(
        w => w.lastRunStatus === 'awaiting-confirmation',
      )
      if (awaiting.length > 0) {
        attentionItems.push({
          label: `${awaiting.length} Workflow${awaiting.length !== 1 ? 's' : ''} Awaiting Confirmation`,
          detail: s(awaiting[0].name),
          route: 'workflows',
          colorTheme: 'warning',
        })
      }
    }

    // Open handoffs
    if (sd.dashboard && sd.dashboard.summary.handoffs > 0) {
      const firstHandoff = sd.dashboard.handoffs[0]
      attentionItems.push({
        label: `${sd.dashboard.summary.handoffs} Open Handoff${sd.dashboard.summary.handoffs !== 1 ? 's' : ''}`,
        detail: firstHandoff
          ? `${s(firstHandoff.from)} -> ${s(firstHandoff.to)}`
          : '',
        route: 'handoffs',
        colorTheme: 'warning',
      })
    }

    // Digest recommended next actions
    if (sd.digest && sd.digest.recommendedNext.length > 0) {
      const first = sd.digest.recommendedNext[0]
      attentionItems.push({
        label: `${sd.digest.recommendedNext.length} Recommended Action${sd.digest.recommendedNext.length !== 1 ? 's' : ''}`,
        detail: `${s(first.objectKind)}:${s(first.objectId)} — ${s(first.action)}`,
        route: 'digest',
        colorTheme: 'warning',
      })
    }

    // Active decisions
    if (sd.decisions && sd.decisions.activeCount > 0) {
      const first = sd.decisions.items[0]
      attentionItems.push({
        label: `${sd.decisions.activeCount} Active Decision${sd.decisions.activeCount !== 1 ? 's' : ''}`,
        detail: first ? s(first.topic) : '',
        route: 'decisions',
        colorTheme: 'info',
      })
    }
  }

  const navItems: NavItem[] = [
    { label: 'Dashboard', key: 'dashboard', shortcut: '1' },
    { label: 'PR Queue', key: 'pr-queue', shortcut: '2' },
    { label: 'Workflows', key: 'workflows', shortcut: '3' },
    { label: 'Approvals', key: 'approvals', shortcut: '4' },
    { label: 'Status', key: 'status', shortcut: '5' },
    { label: 'Activity', key: 'activity', shortcut: '6' },
    { label: 'Digest', key: 'digest', shortcut: '7' },
    { label: 'Handoffs', key: 'handoffs', shortcut: '8' },
    { label: 'Decisions', key: 'decisions', shortcut: '9' },
  ]

  const goalItems: GoalItem[] = [
    { label: 'Run a workflow', route: 'workflows', description: 'Browse, preview, and execute workflows' },
    { label: 'Review pull requests', route: 'pr-queue', description: 'Check open PRs and merge readiness' },
    { label: 'Approve pending items', route: 'approvals', description: 'Resolve plans, merge requests, and effects' },
    { label: 'Manage workflows', route: 'workflows', description: 'Trust, dry-run, and lifecycle controls' },
    { label: 'View recent activity', route: 'activity', description: 'See what happened across the system' },
  ]

  const workflowQuickActions: WorkflowQuickActionItem[] = [
    { label: 'Start a workflow', route: 'workflows', description: 'Browse and execute a workflow', shortcut: 'w' },
    { label: 'Publish workflow to GitHub Issues', route: 'workflows', description: 'Open the issues menu from workflows', shortcut: 'p' },
    { label: 'Review workflow lifecycle', route: 'workflows', description: 'Inspect workflow runs and status', shortcut: 'r' },
    { label: 'Resolve paused workflow', route: 'approvals', description: 'Resume workflows awaiting approval', shortcut: 'a' },
  ]

  return {
    attentionItems,
    allClear: attentionItems.length === 0,
    navItems,
    goalItems,
    workflowQuickActions,
    systemStatus: s(data?.systemStatus ?? 'ready'),
  }
}
