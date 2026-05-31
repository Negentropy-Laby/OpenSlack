import { sanitizeTerminalText } from '../sanitize.js'

export type ApprovalCategory = 'plan' | 'merge-request' | 'workflow-effect' | 'profile-sync' | 'github-review'

export interface ApprovalExplanation {
  why: string
  ifApproved: string
  ifRejected: string
  source: string
}

export interface ApprovalItem {
  id: string
  category: ApprovalCategory
  title: string
  detail: string
  risk: string
  requestedBy: string
  requestedAt: string
  planId?: string
  prNumber?: number
  workflowName?: string
  profileSyncAction?: string
  explanation?: ApprovalExplanation
}

export interface ApprovalGroup {
  category: ApprovalCategory
  label: string
  items: ApprovalItem[]
}

export interface ApprovalCenterViewModel {
  pendingApprovals: ApprovalItem[]
  groups: ApprovalGroup[]
  summary: {
    plans: number
    mergeRequests: number
    workflowEffects: number
    profileSyncs: number
    githubReviews: number
  }
}

const CATEGORY_LABELS: Record<ApprovalCategory, string> = {
  plan: 'Approve Plan',
  'merge-request': 'Confirm Merge',
  'workflow-effect': 'Confirm Effect',
  'profile-sync': 'Sync Profile',
  'github-review': 'GitHub Review',
}

export function getCategoryLabel(category: ApprovalCategory): string {
  return CATEGORY_LABELS[category]
}

export function mapApprovalCenterToViewModel(data?: {
  pendingApprovals?: Array<{
    id: string
    category: ApprovalCategory
    title: string
    detail?: string
    risk?: string
    requestedBy?: string
    requestedAt?: string
    planId?: string
    prNumber?: number
    workflowName?: string
    profileSyncAction?: string
    explanation?: {
      why?: string
      ifApproved?: string
      ifRejected?: string
      source?: string
    }
  }>
}): ApprovalCenterViewModel {
  const s = sanitizeTerminalText

  const pendingApprovals: ApprovalItem[] = (data?.pendingApprovals ?? []).map(item => ({
    id: s(item.id),
    category: item.category,
    title: s(item.title),
    detail: s(item.detail ?? ''),
    risk: s(item.risk ?? 'unknown'),
    requestedBy: s(item.requestedBy ?? 'system'),
    requestedAt: s(item.requestedAt ?? ''),
    planId: item.planId,
    prNumber: item.prNumber,
    workflowName: item.workflowName,
    profileSyncAction: item.profileSyncAction,
    explanation: item.explanation
      ? {
          why: s(item.explanation.why ?? ''),
          ifApproved: s(item.explanation.ifApproved ?? ''),
          ifRejected: s(item.explanation.ifRejected ?? ''),
          source: s(item.explanation.source ?? ''),
        }
      : undefined,
  }))

  const summary = {
    plans: pendingApprovals.filter(a => a.category === 'plan').length,
    mergeRequests: pendingApprovals.filter(a => a.category === 'merge-request').length,
    workflowEffects: pendingApprovals.filter(a => a.category === 'workflow-effect').length,
    profileSyncs: pendingApprovals.filter(a => a.category === 'profile-sync').length,
    githubReviews: pendingApprovals.filter(a => a.category === 'github-review').length,
  }

  const categories: ApprovalCategory[] = ['merge-request', 'workflow-effect', 'profile-sync', 'plan', 'github-review']
  const groups: ApprovalGroup[] = categories
    .map(cat => ({
      category: cat,
      label: CATEGORY_LABELS[cat],
      items: pendingApprovals.filter(a => a.category === cat),
    }))
    .filter(g => g.items.length > 0)

  return { pendingApprovals, groups, summary }
}
