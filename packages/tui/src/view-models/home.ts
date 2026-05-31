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

export interface TaskItem {
  /** Unique key for React rendering */
  key: string
  /** Display label */
  label: string
  /** Route to push when selected */
  route: string
  /** One-line description shown below the label */
  description: string
  /** Keyboard shortcut character */
  shortcut: string
  /** Optional dynamic badge, e.g. "3" to show count overlay */
  attentionBadge?: string
}

export interface HomeViewModel {
  /** Items that need attention, ordered by urgency */
  attentionItems: AttentionItem[]
  /** True when no attention items exist */
  allClear: boolean
  /** Quick navigation items with number shortcuts */
  navItems: NavItem[]
  /** Task-oriented items for the "What do you want to do?" section */
  tasks: TaskItem[]
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

  // Build attention badge counts from shell data
  const attentionBadgeCounts: Record<string, string> = {}
  if (data?.shellData) {
    const sd = data.shellData

    // Badge for "See what needs attention" — total attention items
    const totalAttention = attentionItems.length
    if (totalAttention > 0) {
      attentionBadgeCounts['see-attention'] = String(totalAttention)
    }

    // Badge for "Review and merge PRs" — open PR count
    if (sd.prQueue && sd.prQueue.totalPRs > 0) {
      attentionBadgeCounts['review-prs'] = String(sd.prQueue.totalPRs)
    }

    // Badge for "Approve pending items" — pending approval count
    const approvalCount = sd.approvals
      ? sd.approvals.summary.plans +
        sd.approvals.summary.mergeRequests +
        sd.approvals.summary.workflowEffects +
        sd.approvals.summary.githubReviews
      : 0
    if (approvalCount > 0) {
      attentionBadgeCounts['approve-pending'] = String(approvalCount)
    }
  }

  const tasks: TaskItem[] = [
    {
      key: 'see-attention',
      label: 'See what needs attention',
      route: 'dashboard',
      description: 'View items needing immediate action',
      shortcut: '1',
      attentionBadge: attentionBadgeCounts['see-attention'],
    },
    {
      key: 'start-work',
      label: 'Start or continue work',
      route: 'workflows',
      description: 'Create tasks, claim issues, and work in isolated branches',
      shortcut: '2',
    },
    {
      key: 'run-workflow',
      label: 'Run or check a workflow',
      route: 'workflows',
      description: 'Browse, execute, and inspect workflow runs',
      shortcut: '3',
    },
    {
      key: 'review-prs',
      label: 'Review and merge PRs',
      route: 'pr-queue',
      description: 'Check open PRs, run doctor, and merge when ready',
      shortcut: '4',
      attentionBadge: attentionBadgeCounts['review-prs'],
    },
    {
      key: 'approve-pending',
      label: 'Approve pending items',
      route: 'approvals',
      description: 'Approve plans, merge requests, and workflow effects',
      shortcut: '5',
      attentionBadge: attentionBadgeCounts['approve-pending'],
    },
    {
      key: 'maintain-profile',
      label: 'Maintain organization profile',
      route: 'profile',
      description: 'Check, preview, and sync your organization profile',
      shortcut: '6',
    },
  ]

  const navItems: NavItem[] = [
    { label: 'Dashboard', key: 'dashboard', shortcut: '7' },
    { label: 'Status', key: 'status', shortcut: '8' },
    { label: 'Activity', key: 'activity', shortcut: '9' },
    { label: 'Digest', key: 'digest', shortcut: '0' },
    { label: 'Workflows', key: 'workflows', shortcut: 'p' },
    { label: 'Profile', key: 'profile', shortcut: 'r' },
  ]

  return {
    attentionItems,
    allClear: attentionItems.length === 0,
    navItems,
    tasks,
    systemStatus: s(data?.systemStatus ?? 'ready'),
  }
}
