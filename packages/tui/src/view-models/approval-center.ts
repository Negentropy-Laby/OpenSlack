import { sanitizeTerminalText } from '../sanitize.js'

export type ApprovalCategory = 'plan' | 'merge-request' | 'workflow-effect' | 'github-review'

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
}

export interface ApprovalCenterViewModel {
  pendingApprovals: ApprovalItem[]
  summary: {
    plans: number
    mergeRequests: number
    workflowEffects: number
    githubReviews: number
  }
}

const CATEGORY_LABELS: Record<ApprovalCategory, string> = {
  plan: 'Approve Plan',
  'merge-request': 'Confirm Merge',
  'workflow-effect': 'Confirm Effect',
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
  }))

  const summary = {
    plans: pendingApprovals.filter(a => a.category === 'plan').length,
    mergeRequests: pendingApprovals.filter(a => a.category === 'merge-request').length,
    workflowEffects: pendingApprovals.filter(a => a.category === 'workflow-effect').length,
    githubReviews: pendingApprovals.filter(a => a.category === 'github-review').length,
  }

  return { pendingApprovals, summary }
}
